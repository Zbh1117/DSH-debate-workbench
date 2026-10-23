/**
 * 辩论备赛工作台 —— Host HTTP API（供客户端工作台使用）。
 *
 * 设计取舍：**不在 HTTP 层重写一遍业务逻辑**，而是把 REST 请求转成插件自己的
 * 工具调用（`debate_*` 的 `execute`）。这样「模型能做的操作」和「界面能做的操作」
 * 永远是同一套语义、同一套校验、同一套错误信息。
 *
 * 路由（前缀 /debate-api）：
 *   GET  /ui            轮询用的轻量状态（是否展开、分屏方向/比例、标签页）
 *   GET  /state         状态 + 项目摘要 + 五维/缺口分析
 *   GET  /bundle        完整 ProjectExportBundle
 *   POST /tool          { name, args } → 执行某个 debate_* 工具
 *   GET  /export        下载 bundle JSON
 *
 * 另有一个只读调试页 /debate-workbench/（真正的界面由客户端插件提供）。
 *
 * 安全边界：只监听宿主已绑定的回环地址；`workspace` 必须指向一个**已存在辩论项目**
 * 的工作区（没有项目的工作区一律拒绝），避免被当成任意文件读取器。
 *
 * @module dsh-debate-workbench/api
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { filled } from './model.js'
import { analyze } from './checks.js'
import {
  archiveProject,
  bundlePath,
  createProject,
  deleteProject,
  getProjectIndex,
  listKnownProjects,
  listProjects,
  loadBundle,
  loadSharedLibrary,
  loadTasks,
  loadUiState,
  projectExists,
  readPointer,
  renameProject,
  resolveProjectEntry,
  resolveWorkspace,
  saveSharedLibrary,
  saveTasks,
  saveUiState,
  switchProject,
  uiSnapshot,
} from './store.js'

/** API 路由前缀。 */
export const API_PREFIX = '/debate-api'
/** 调试页前缀。 */
export const PAGE_PREFIX = '/debate-workbench'

const ASSET_DIR = fileURLToPath(new URL('../assets/', import.meta.url))

/** JSON 响应。 */
function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 错误响应。 */
function sendError(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}

/** 读取 JSON 请求体（上限 4 MiB，bundle 可能较大）。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 4 * 1024 * 1024) throw new Error('请求体过大（上限 4 MiB）')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 校验工作区：必须已存在辩论项目，否则 400。 */
function requireProjectWorkspace(workspace) {
  const resolved = path.resolve(String(workspace))
  if (!projectExists(resolved)) {
    throw new Error(`工作区 ${resolved} 里没有辩论项目（缺少 .debate/project.bundle.json）`)
  }
  return resolved
}

/**
 * 解析请求里的工作区：显式参数优先，否则用全局指针里的激活工作区。
 *
 * @param {unknown} requested 请求给出的工作区
 * @param {{ requireProject?: boolean }} [options] 是否要求工作区已有项目，默认 true
 * @returns {string} 工作区绝对路径
 */
function pickWorkspace(requested, options = {}) {
  const requireProject = options.requireProject !== false
  const pointer = readPointer()
  const activeWorkspace = pointer.active?.workspace
  const workspace = filled(requested) ? String(requested) : typeof activeWorkspace === 'string' ? activeWorkspace : undefined
  if (workspace === undefined) throw new Error('没有激活的辩论项目：先在对话里 debate_project(action=create) 或 provide workspace')
  if (requireProject) return requireProjectWorkspace(workspace)
  const resolved = path.resolve(workspace)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`工作区路径不存在：${resolved}`)
  return resolved
}

/** 服务一个静态资源（调试页）。 */
function serveAsset(res, name) {
  const safe = path.basename(name)
  const target = path.join(ASSET_DIR, safe)
  let content
  try {
    content = fs.readFileSync(target)
  } catch {
    sendError(res, 404, `资源不存在：${safe}`)
    return
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(safe)] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
    'content-length': content.length,
  })
  res.end(content)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** 最近 N 条客户端上报（桌面壳看不到 DevTools 时，用它回读客户端故障）。 */
const clientReports = []

/** 记录一条客户端上报。 */
function rememberClientReport(stage, message) {
  clientReports.unshift({ at: new Date().toISOString(), stage, message })
  if (clientReports.length > 60) clientReports.length = 60
}

/**
 * 处理一次 API 请求。
 *
 * @param {{ req: any, res: any, tools: Map<string, any>, refs?: any }} params 请求、工具表与可选服务引用
 */
async function handleApi({ req, res, tools, refs }) {
  const url = new URL(req.url ?? '/', 'http://x')
  const sub = url.pathname.slice(API_PREFIX.length) || '/'

  // 诊断：客户端模块图里有没有我们的包，以及整张图的形状。
  if (req.method === 'GET' && sub === '/client-graph') {
    const service = refs?.clientModules?.()
    if (service === undefined || typeof service.graph !== 'function') {
      sendJson(res, 200, { ok: true, available: false, reason: 'clientModules 服务不可用' })
      return
    }
    try {
      const graph = service.graph()
      const entries = Array.isArray(graph?.entries) ? graph.entries : []
      const batches = Array.isArray(graph?.batches) ? graph.batches : []
      const mine = entries.filter(entry => JSON.stringify(entry).includes('debate-workbench'))
      sendJson(res, 200, {
        ok: true,
        available: true,
        rev: graph?.rev,
        count: entries.length,
        included: mine.length > 0,
        mine,
        entries,
        batches,
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, available: true, error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  // 客户端错误上报：桌面壳里看不到 DevTools 时，靠它把失败原因带回宿主日志。
  if (req.method === 'POST' && sub === '/client-report') {
    const body = await readJsonBody(req)
    const stage = typeof body?.stage === 'string' ? body.stage.slice(0, 100) : 'unknown'
    const message = typeof body?.message === 'string' ? body.message.slice(0, 2000) : '(empty)'
    rememberClientReport(stage, message)
    refs?.logger?.()?.info?.(`[debate-workbench][client] ${stage}: ${message}`)
    sendJson(res, 200, { ok: true, stage, message })
    return
  }

  // 回读最近客户端上报，用于排查桌面壳里的客户端故障。
  if (req.method === 'GET' && sub === '/client-reports') {
    sendJson(res, 200, { ok: true, reports: clientReports })
    return
  }

  if (req.method === 'GET' && sub === '/ui') {
    sendJson(res, 200, { ok: true, snapshot: uiSnapshot() })
    return
  }

  if (req.method === 'GET' && sub === '/state') {
    const snapshot = uiSnapshot()
    const projectSelector = url.searchParams.get('project') ?? undefined
    if (snapshot.active !== true) {
      sendJson(res, 200, { ok: true, snapshot, projects: snapshot.projects ?? [], activeProjectId: null })
      return
    }
    const bundle = loadBundle(snapshot.workspace, projectSelector)
    if (bundle === undefined) {
      sendJson(res, 200, { ok: true, snapshot: { ...snapshot, active: false }, projects: snapshot.projects ?? [], activeProjectId: snapshot.activeProjectId ?? null })
      return
    }
    const report = analyze(bundle)
    sendJson(res, 200, {
      ok: true,
      snapshot,
      projects: snapshot.projects ?? [],
      activeProjectId: snapshot.activeProjectId ?? null,
      project: bundle.project,
      analysis: {
        readiness: report.readiness,
        blocking: report.blocking,
        warnings: report.warnings,
        scores: report.scores,
        notes: report.notes,
        suggestions: report.suggestions,
        stats: report.stats,
        gaps: report.gaps,
      },
    })
    return
  }

  if (req.method === 'GET' && sub === '/bundle') {
    const workspace = pickWorkspace(url.searchParams.get('workspace'))
    const projectSelector = url.searchParams.get('project') ?? undefined
    const bundle = loadBundle(workspace, projectSelector)
    const entry = resolveProjectEntry(workspace, projectSelector)
    sendJson(res, 200, { ok: true, workspace, projectId: entry?.id ?? null, bundle })
    return
  }

  // 题目列表：含每个题目的就绪度与待办统计，供顶栏切换器 / 项目页使用。
  if (req.method === 'GET' && sub === '/projects') {
    const workspace = pickWorkspace(url.searchParams.get('workspace'), { requireProject: false })
    const items = listProjects(workspace, { includeArchived: url.searchParams.get('archived') === '1' }).map(item => {
      const bundle = loadBundle(workspace, item.id)
      const report = bundle === undefined ? undefined : analyze(bundle)
      const tasks = loadTasks(workspace, item.id).tasks
      return {
        ...item,
        readiness: report?.readiness ?? 0,
        scores: report?.scores,
        taskCounts: {
          total: tasks.length,
          open: tasks.filter(task => task.status !== 'done').length,
          nextDeadline: tasks.filter(task => task.status !== 'done' && typeof task.deadline === 'string').map(task => task.deadline).sort()[0] ?? null,
        },
      }
    })
    const index = getProjectIndex(workspace)
    sendJson(res, 200, { ok: true, workspace, activeProjectId: index.activeProjectId, projects: items })
    return
  }

  // 题目管理：切换 / 新建 / 重命名 / 归档 / 删除。
  if (req.method === 'POST' && sub === '/project') {
    const body = await readJsonBody(req)
    const action = typeof body.action === 'string' ? body.action : ''
    const workspace = pickWorkspace(body.workspace, { requireProject: action !== 'create' })
    const project = typeof body.project === 'string' ? body.project : undefined
    if (action === 'switch') {
      const { entry, bundle } = switchProject(workspace, project)
      const report = analyze(bundle)
      sendJson(res, 200, { ok: true, action, projectId: entry.id, project: bundle.project, readiness: report.readiness, snapshot: uiSnapshot() })
      return
    }
    if (action === 'create') {
      const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
      if (topic === '') {
        sendError(res, 400, '新建题目需要 topic')
        return
      }
      const { entry, bundle } = createProject(workspace, { topic, side: body.side, format: body.format })
      sendJson(res, 200, { ok: true, action, projectId: entry.id, project: bundle.project, snapshot: uiSnapshot() })
      return
    }
    if (action === 'rename') {
      const { bundle } = renameProject(workspace, project, body.topic)
      sendJson(res, 200, { ok: true, action, project: bundle.project, snapshot: uiSnapshot() })
      return
    }
    if (action === 'archive') {
      const entry = archiveProject(workspace, project, body.archived !== false)
      sendJson(res, 200, { ok: true, action, project: entry, snapshot: uiSnapshot() })
      return
    }
    if (action === 'delete') {
      const result = deleteProject(workspace, project, { purge: body.purge === true })
      sendJson(res, 200, { ok: true, action, removed: result.removed, purged: result.purged, snapshot: uiSnapshot() })
      return
    }
    sendError(res, 400, `未知的题目操作：${action}`)
    return
  }

  // 备赛待办
  if (req.method === 'GET' && sub === '/tasks') {
    const workspace = pickWorkspace(url.searchParams.get('workspace'))
    const project = url.searchParams.get('project') ?? undefined
    const entry = resolveProjectEntry(workspace, project)
    if (entry === undefined) {
      sendError(res, 400, '没有可用的题目')
      return
    }
    sendJson(res, 200, { ok: true, projectId: entry.id, topic: entry.topic, ...loadTasks(workspace, entry.id) })
    return
  }
  if (req.method === 'POST' && sub === '/task') {
    const body = await readJsonBody(req)
    const workspace = pickWorkspace(body.workspace)
    const action = typeof body.action === 'string' ? body.action : ''
    const entry = resolveProjectEntry(workspace, typeof body.project === 'string' ? body.project : undefined)
    if (entry === undefined) {
      sendError(res, 400, '没有可用的题目')
      return
    }
    const document = loadTasks(workspace, entry.id)
    const tasks = [...document.tasks]
    const stamp = () => new Date().toISOString()
    if (action === 'add') {
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (title === '') {
        sendError(res, 400, '添加待办需要 title')
        return
      }
      tasks.push({
        id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        title,
        status: 'todo',
        deadline: typeof body.deadline === 'string' && body.deadline !== '' ? body.deadline : undefined,
        nodeId: typeof body.nodeId === 'string' && body.nodeId !== '' ? body.nodeId : undefined,
        createdAt: stamp(),
        updatedAt: stamp(),
      })
    } else {
      const target = tasks.find(item => item.id === body.taskId)
      if (target === undefined) {
        sendError(res, 400, `找不到任务 ${body.taskId}`)
        return
      }
      if (action === 'update') {
        if (typeof body.title === 'string' && body.title.trim() !== '') target.title = body.title.trim()
        if (body.status === 'todo' || body.status === 'doing' || body.status === 'done') target.status = body.status
        if (typeof body.deadline === 'string') target.deadline = body.deadline
        target.updatedAt = stamp()
      } else if (action === 'complete') {
        target.status = 'done'
        target.doneAt = stamp()
        target.updatedAt = stamp()
      } else if (action === 'delete') {
        const kept = tasks.filter(item => item.id !== body.taskId)
        saveTasks(workspace, entry.id, kept)
        sendJson(res, 200, { ok: true, projectId: entry.id, tasks: kept })
        return
      } else {
        sendError(res, 400, `未知的待办操作：${action}`)
        return
      }
    }
    const saved = saveTasks(workspace, entry.id, tasks)
    sendJson(res, 200, { ok: true, projectId: entry.id, tasks: saved.tasks })
    return
  }

  // 公共证据库
  if (req.method === 'GET' && sub === '/library') {
    const workspace = pickWorkspace(url.searchParams.get('workspace'), { requireProject: false })
    const library = loadSharedLibrary(workspace)
    sendJson(res, 200, { ok: true, total: library.cards.length, cards: library.cards })
    return
  }
  if (req.method === 'POST' && sub === '/library') {
    const body = await readJsonBody(req)
    const workspace = pickWorkspace(body.workspace, { requireProject: false })
    const action = typeof body.action === 'string' ? body.action : ''
    const library = loadSharedLibrary(workspace)
    const stamp = () => new Date().toISOString()
    if (action === 'delete') {
      library.cards = library.cards.filter(card => card.id !== body.cardId)
      const saved = saveSharedLibrary(workspace, library)
      sendJson(res, 200, { ok: true, total: saved.cards.length, cards: saved.cards })
      return
    }
    if (action === 'update') {
      const card = library.cards.find(item => item.id === body.cardId)
      if (card === undefined) {
        sendError(res, 400, `找不到共享证据 ${body.cardId}`)
        return
      }
      Object.assign(card, body.patch !== null && typeof body.patch === 'object' ? body.patch : {}, { updatedAt: stamp() })
      const saved = saveSharedLibrary(workspace, library)
      sendJson(res, 200, { ok: true, card, total: saved.cards.length, cards: saved.cards })
      return
    }
    if (action === 'add') {
      const cards = Array.isArray(body.cards) ? body.cards : []
      const created = cards.map(input => ({
        ...input,
        id: typeof input?.id === 'string' && input.id !== '' ? input.id : `shared-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        createdAt: typeof input?.createdAt === 'string' ? input.createdAt : stamp(),
        updatedAt: stamp(),
      }))
      library.cards.push(...created.map(card => ({ ...card, sharedId: card.id })))
      const saved = saveSharedLibrary(workspace, library)
      sendJson(res, 200, { ok: true, cards: created, total: saved.cards.length })
      return
    }
    sendError(res, 400, `未知的证据库操作：${action}`)
    return
  }

  if (req.method === 'GET' && sub === '/export') {
    const workspace = pickWorkspace(url.searchParams.get('workspace'))
    const projectSelector = url.searchParams.get('project') ?? undefined
    const target = bundlePath(workspace, projectSelector)
    const content = fs.readFileSync(target)
    const bundle = loadBundle(workspace, projectSelector)
    const fileName = `debateweaver-${bundle?.project?.id ?? 'project'}.json`
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}"`,
      'cache-control': 'no-store',
      'content-length': content.length,
    })
    res.end(content)
    return
  }

  if (req.method === 'POST' && sub === '/ui') {
    const body = await readJsonBody(req)
    const workspace = pickWorkspace(body.workspace)
    const patch = {}
    if (body.open === true || body.open === false) patch.open = body.open
    if (body.orientation === 'vertical' || body.orientation === 'horizontal') patch.orientation = body.orientation
    if (Number.isFinite(Number(body.ratio))) patch.ratio = Number(body.ratio)
    if (['tree', 'topic', 'evidence', 'attack', 'evaluate', 'manuscript', 'projects'].includes(body.tab)) patch.tab = body.tab
    if (typeof body.selectedNodeId === 'string') patch.selectedNodeId = body.selectedNodeId
    const ui = saveUiState(workspace, patch)
    sendJson(res, 200, { ok: true, ui })
    return
  }

  if (req.method === 'POST' && sub === '/tool') {
    const body = await readJsonBody(req)
    const name = typeof body.name === 'string' ? body.name : ''
    const definition = tools.get(name)
    if (definition === undefined) {
      sendError(res, 404, `未知工具：${name}`)
      return
    }
    const args = body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {}
    // 建项目、导入 bundle、题目管理都发生在「项目可能还不存在」时，不能强制要求已有项目。
    const creating = name === 'debate_project' && args.action === 'create'
    const importing = name === 'debate_bundle' && args.action === 'import'
    // 题目管理类动作（新建/列表/切换/重命名/归档/删除）允许工作区还没有项目；
    // status/read/open 仍然要求已有题目，否则给出 400。
    const projectManaging = name === 'debate_project' && ['create', 'list', 'switch', 'rename', 'archive', 'delete'].includes(args.action)
    const workspace = pickWorkspace(args.workspace, { requireProject: !(creating || importing || projectManaging) })
    // 工具用 agent 的 cwd 解析工作区；HTTP 场景下显式传入 workspace，agent 留空即可。
    const result = await definition.execute({ ...args, workspace }, {})
    const snapshot = uiSnapshot()
    const bundle = loadBundle(workspace, args.project)
    const report = bundle === undefined ? undefined : analyze(bundle)
    sendJson(res, 200, {
      ok: true,
      result,
      snapshot,
      analysis: report === undefined ? undefined : {
        readiness: report.readiness,
        blocking: report.blocking,
        warnings: report.warnings,
        scores: report.scores,
        notes: report.notes,
        suggestions: report.suggestions,
        stats: report.stats,
        gaps: report.gaps,
      },
    })
    return
  }

  sendError(res, 404, `未知 API：${sub}`)
}

/**
 * 挂载 API 路由与调试页。
 *
 * @param {any} ctx 已 inject webServer 的上下文
 * @param {{ host: string, port: number | undefined }} webServer webServer 服务
 * @param {Map<string, any>} tools 工具定义表
 * @param {{ clientModules?: () => any, logger?: () => any }} [refs] 可选服务引用（诊断用）
 * @returns {{ url: () => string }} 调试页地址
 */
export function mountDebateApi(ctx, webServer, tools, refs = {}) {
  const currentBase = () => {
    const port = typeof webServer.port === 'number' ? webServer.port : 0
    const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : webServer.host ?? '127.0.0.1'
    return `http://${host}:${port}`
  }

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          await handleApi({ req, res, tools, refs })
        } catch (error) {
          if (res.headersSent) {
            res.destroy()
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          const status = /没有辩论项目|没有激活|缺少|未知|找不到|不存在|不是合法|无法展开/.test(message) ? 400 : 500
          sendError(res, status, message)
        }
      },
    }),
  )

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: PAGE_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const sub = url.pathname.slice(PAGE_PREFIX.length)
        if (req.method !== 'GET') {
          sendError(res, 405, '调试页只支持 GET')
          return
        }
        if (sub === '' || sub === '/' || sub === '/index.html') {
          serveAsset(res, 'debug.html')
          return
        }
        // 客户端加载器用它判断 UI 代码是否更新（内容哈希），从而实现 UI 热插拔。
        if (sub === '/version.json') {
          try {
            const stat = fs.statSync(path.join(ASSET_DIR, 'ui.js'))
            const content = fs.readFileSync(path.join(ASSET_DIR, 'ui.js'))
            const version = `${content.length.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}`
            sendJson(res, 200, { ok: true, version, ui: true })
          } catch (error) {
            sendJson(res, 200, { ok: true, version: 'missing', ui: false, error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        serveAsset(res, sub.replace(/^\/+/, ''))
      },
    }),
  )

  const url = () => `${currentBase()}${PAGE_PREFIX}/`
  ctx.logger?.info?.(`[debate-workbench] API 已挂载：${currentBase()}${API_PREFIX}/，调试页 ${url()}`)
  return { url }
}
