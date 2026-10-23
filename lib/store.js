/**
 * 辩论备赛工作台 —— 存储层（多题目版本）。
 *
 * 一个 DSH 工作区（仓库目录）下可以同时准备多个题目，每个题目一个独立子目录：
 *
 *   <workspace>/.debate/
 *     projects.index.json              题目索引 + 当前激活题目
 *     projects/
 *       <projectId>/
 *         project.bundle.json          该题完整 ProjectExportBundle（唯一事实来源）
 *         tasks.json                   该题备赛待办
 *     shared/
 *       evidence.json                  公共证据库（跨题共享，供证据检索调用）
 *     ui.json                          工作台 UI 状态（展开、标签页、选中节点）
 *     export/                          导出/备份
 *
 * 旧版单项目布局（`.debate/project.bundle.json`）会在首次访问时**自动迁移**到
 * `projects/<id>/` 并写入索引，不会丢数据。
 *
 * 跨工作区的「当前激活项目」指针仍放在 `$DSH_HOME/debate-workbench.json`，
 * 供客户端 UI 判断该不该显示工作台（不写进任何工作区）。
 *
 * @module dsh-debate-workbench/store
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BUNDLE_FILE,
  DATA_DIR,
  UI_FILE,
  cloneJson,
  filled,
  makeBundle,
  normalizeBundle,
  now,
} from './model.js'

/** 题目子目录名。 */
export const PROJECTS_DIR = 'projects'
/** 题目索引文件。 */
export const INDEX_FILE = 'projects.index.json'
/** 公共证据库目录。 */
export const SHARED_DIR = 'shared'
/** 公共证据库文件。 */
export const SHARED_FILE = 'evidence.json'
/** 每个题目的待办文件。 */
export const TASKS_FILE = 'tasks.json'
/** 索引格式版本。 */
export const INDEX_VERSION = 1
/** 公共证据库格式版本。 */
export const LIBRARY_VERSION = 1

/** DSH 用户目录。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/** 跨工作区的全局指针文件。 */
export function pointerPath() {
  return path.join(dshHome(), 'debate-workbench.json')
}

/** 展开 `~` 前缀。 */
export function expandHome(input) {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(os.homedir(), input.slice(2))
  return input
}

/**
 * 解析一次调用对应的工作区目录。
 *
 * 优先级：显式 `workspace` 参数 → 全局指针里的**当前激活工作区** → 调用方 Agent 的工作目录 → 进程 cwd。
 *
 * 为什么激活工作区优先：右栏工作台（HTTP API）读的是指针里的工作区，如果工具默认用
 * Agent cwd，就会出现「工具把数据写到了 A 工作区、界面却在 B 工作区读取」的错位
 * （公共证据库/项目列表不一致就是这么来的）。没有激活工作区时才回退到 Agent cwd。
 * 如果传入的已经以 `.debate` 结尾，则取其父目录。
 *
 * @param {{ agent?: { session?: { header?: { cwd?: unknown } } } } | undefined} exec 工具执行上下文
 * @param {string | undefined} requested 模型显式给出的工作区路径
 * @returns {string} 工作区绝对路径
 */
export function resolveWorkspace(exec, requested) {
  const explicit = typeof requested === 'string' ? requested.trim() : ''
  if (explicit !== '') {
    const abs = path.resolve(expandHome(explicit))
    return path.basename(abs) === DATA_DIR ? path.dirname(abs) : abs
  }
  const active = readPointer().active
  if (active !== null && typeof active === 'object' && typeof active.workspace === 'string' && active.workspace.trim() !== '') {
    return path.resolve(active.workspace)
  }
  const raw = exec?.agent?.session?.header?.cwd
  const cwd = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : process.cwd()
  return path.resolve(cwd)
}

/** 工作区的数据目录。 */
export function dataDir(workspace) {
  return path.join(workspace, DATA_DIR)
}

/** 题目子目录根。 */
export function projectsDir(workspace) {
  return path.join(dataDir(workspace), PROJECTS_DIR)
}

/** 旧版单项目 bundle 路径（仅用于迁移与兜底）。 */
export function legacyBundlePath(workspace) {
  return path.join(dataDir(workspace), BUNDLE_FILE)
}

/** 题目索引文件路径。 */
export function projectIndexPath(workspace) {
  return path.join(dataDir(workspace), INDEX_FILE)
}

/** UI 状态文件路径。 */
export function uiPath(workspace) {
  return path.join(dataDir(workspace), UI_FILE)
}

/** 公共证据库文件路径。 */
export function sharedLibraryPath(workspace) {
  return path.join(dataDir(workspace), SHARED_DIR, SHARED_FILE)
}

/** 题目目录绝对路径（entry.dir 是相对 .debate/ 的路径）。 */
export function projectDirPath(workspace, entry) {
  return path.join(dataDir(workspace), entry.dir)
}

/** 题目 bundle 绝对路径。 */
export function projectBundlePath(workspace, entry) {
  return path.join(dataDir(workspace), entry.dir, BUNDLE_FILE)
}

/** 题目待办文件绝对路径。 */
export function tasksPath(workspace, entry) {
  return path.join(dataDir(workspace), entry.dir, TASKS_FILE)
}

/**
 * 兼容旧签名：返回「当前激活题目」的 bundle 路径；没有索引时返回旧路径。
 *
 * @param {string} workspace 工作区
 * @param {string} [selector] 题目 id / 题目关键词
 * @returns {string} bundle 路径
 */
export function bundlePath(workspace, selector) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) return legacyBundlePath(workspace)
  return projectBundlePath(workspace, entry)
}

/**
 * 原子写 JSON（临时文件 + rename）。
 *
 * @param {string} target 目标文件绝对路径
 * @param {unknown} value 要写入的值
 * @returns {string} 目标路径
 */
export function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, target)
  return target
}

/**
 * 读取 JSON 文件；不存在返回 fallback，损坏抛带路径的错误。
 *
 * @param {string} target 文件路径
 * @param {unknown} fallback 缺省值
 * @returns {any} 解析结果
 */
export function readJson(target, fallback) {
  let raw
  try {
    raw = fs.readFileSync(target, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return cloneJson(fallback)
    throw new Error(`读取 ${target} 失败：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${target} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}），请先修复再继续`)
  }
}

/* ------------------------------------------------------------------ *
 * 题目索引
 * ------------------------------------------------------------------ */

/** 生成一个题目标识（同时用作目录名，安全字符）。 */
export function makeProjectId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 校验目录字段是否安全（不允许跳出 .debate/projects）。 */
function safeProjectDir(dir) {
  const raw = typeof dir === 'string' ? dir.replace(/\\/g, '/') : ''
  const match = /^projects\/[A-Za-z0-9._-]+$/.exec(raw)
  if (match === null) return undefined
  return raw
}

/** 从 bundle 里挑出索引需要的字段。 */
function entryFromBundle(bundle, fallbackId) {
  const project = bundle?.project ?? {}
  const id = filled(project.id) ? String(project.id) : fallbackId
  return {
    id,
    dir: `${PROJECTS_DIR}/${id}`,
    topic: filled(project.title) ? String(project.title) : id,
    side: filled(project.side) ? String(project.side) : 'pro',
    format: filled(project.format) ? String(project.format) : 'chinese',
    createdAt: filled(project.createdAt) ? String(project.createdAt) : now(),
    updatedAt: filled(project.updatedAt) ? String(project.updatedAt) : now(),
    archived: false,
  }
}

/** 读取 bundle 文件（损坏时返回 undefined，不阻断索引）。 */
function tryReadBundle(target) {
  try {
    if (!fs.existsSync(target)) return undefined
    return normalizeBundle(readJson(target, null))
  } catch {
    return undefined
  }
}

/** 把旧版单项目迁移到 projects/<id>/（幂等）。 */
function migrateLegacy(workspace, projects) {
  const legacy = legacyBundlePath(workspace)
  if (!fs.existsSync(legacy)) return projects
  const bundle = tryReadBundle(legacy)
  if (bundle === undefined) return projects
  const entry = entryFromBundle(bundle, makeProjectId())
  if (projects.some(item => item.id === entry.id)) return projects
  const targetDir = projectDirPath(workspace, entry)
  fs.mkdirSync(targetDir, { recursive: true })
  const target = projectBundlePath(workspace, entry)
  if (!fs.existsSync(target)) fs.renameSync(legacy, target)
  else fs.rmSync(legacy, { force: true })
  projects.push(entry)
  return projects
}

/** 认领 projects/ 下已存在但索引里没有的题目目录（幂等）。 */
function adoptOrphanDirs(workspace, projects) {
  let names = []
  try {
    names = fs.readdirSync(projectsDir(workspace), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name)
  } catch {
    return projects
  }
  for (const name of names) {
    if (projects.some(item => item.id === name)) continue
    const dir = `${PROJECTS_DIR}/${name}`
    const bundle = tryReadBundle(path.join(workspace, dir, BUNDLE_FILE))
    if (bundle === undefined) continue
    projects.push({ ...entryFromBundle(bundle, name), id: name, dir })
  }
  return projects
}

/**
 * 读取（必要时初始化/迁移）题目索引。
 *
 * @param {string} workspace 工作区
 * @returns {{ version: number, activeProjectId: string | null, projects: Array<any>, updatedAt: string }}
 */
export function getProjectIndex(workspace) {
  const target = projectIndexPath(workspace)
  const exists = fs.existsSync(target)
  let projects = []
  let activeProjectId = null
  if (exists) {
    const raw = readJson(target, {})
    projects = Array.isArray(raw?.projects) ? raw.projects.filter(item => safeProjectDir(item?.dir) !== undefined) : []
    activeProjectId = filled(raw?.activeProjectId) ? String(raw.activeProjectId) : null
  }
  const before = projects.length
  projects = migrateLegacy(workspace, projects)
  projects = adoptOrphanDirs(workspace, projects)
  if (!exists || projects.length !== before) {
    const index = {
      version: INDEX_VERSION,
      activeProjectId: activeProjectId ?? projects[0]?.id ?? null,
      projects,
      updatedAt: now(),
    }
    writeJsonAtomic(target, index)
    return index
  }
  return {
    version: INDEX_VERSION,
    activeProjectId: activeProjectId ?? projects[0]?.id ?? null,
    projects,
    updatedAt: typeof readJson(target, {})?.updatedAt === 'string' ? readJson(target, {}).updatedAt : now(),
  }
}

/**
 * 写题目索引。
 *
 * @param {string} workspace 工作区
 * @param {any} index 索引对象
 * @returns {any} 写入后的索引
 */
export function saveProjectIndex(workspace, index) {
  const next = {
    version: INDEX_VERSION,
    activeProjectId: filled(index?.activeProjectId) ? String(index.activeProjectId) : null,
    projects: (Array.isArray(index?.projects) ? index.projects : []).filter(item => safeProjectDir(item?.dir) !== undefined),
    updatedAt: now(),
  }
  writeJsonAtomic(projectIndexPath(workspace), next)
  return next
}

/** 更新索引里的单个题目条目。 */
function upsertEntry(workspace, index, entry) {
  const position = index.projects.findIndex(item => item.id === entry.id)
  if (position >= 0) index.projects[position] = { ...index.projects[position], ...entry }
  else index.projects.push(entry)
  return index
}

/**
 * 列出题目（按更新时间倒序），附基本统计。
 *
 * @param {string} workspace 工作区
 * @param {{ includeArchived?: boolean }} [options] 是否含归档题目
 * @returns {Array<any>} 题目条目（含 stats / active）
 */
export function listProjects(workspace, options = {}) {
  const index = getProjectIndex(workspace)
  const includeArchived = options.includeArchived === true
  const activeId = index.activeProjectId
  return index.projects
    .filter(entry => includeArchived || entry.archived !== true)
    .map(entry => {
      const target = projectBundlePath(workspace, entry)
      const exists = fs.existsSync(target)
      const bundle = exists ? tryReadBundle(target) : undefined
      return {
        ...entry,
        active: entry.id === activeId,
        exists,
        bundlePath: target,
        stats: bundle === undefined
          ? { nodes: 0, edges: 0, evidence: 0, attacks: 0, manuscripts: 0 }
          : {
              nodes: bundle.argumentTree?.nodes?.length ?? 0,
              edges: bundle.argumentTree?.edges?.length ?? 0,
              evidence: bundle.evidenceCards?.length ?? 0,
              attacks: (bundle.attackDefenseBoxes ?? []).reduce((sum, box) => sum + (box.attacks?.length ?? 0), 0),
              manuscripts: bundle.manuscripts?.length ?? 0,
            },
      }
    })
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

/**
 * 解析题目：id、目录名、题目原文/关键词都能匹配；省略时取当前激活题目。
 *
 * @param {string} workspace 工作区
 * @param {string | undefined} selector 题目 id / 题目关键词
 * @returns {any | undefined} 题目条目
 */
export function resolveProjectEntry(workspace, selector) {
  const index = getProjectIndex(workspace)
  const raw = typeof selector === 'string' ? selector.trim() : ''
  if (raw === '') {
    const active = index.projects.find(item => item.id === index.activeProjectId)
    return active ?? index.projects.find(item => item.archived !== true) ?? index.projects[0]
  }
  const needle = raw.toLowerCase()
  const byExact = index.projects.find(
    item => item.id === raw || item.dir === raw || String(item.dir).replace(/\\/g, '/').split('/').pop() === raw,
  )
  if (byExact !== undefined) return byExact
  const byTopic = index.projects.find(item => String(item.topic ?? '').toLowerCase() === needle)
  if (byTopic !== undefined) return byTopic
  return index.projects.find(item => String(item.topic ?? '').toLowerCase().includes(needle))
}

/** 当前激活题目条目。 */
export function activeProjectEntry(workspace) {
  return resolveProjectEntry(workspace, undefined)
}

/**
 * 创建题目：建目录、写初始 bundle、登记索引并设为激活。
 *
 * @param {string} workspace 工作区
 * @param {{ topic: string, side?: string, format?: string, projectId?: string }} input 题目信息
 * @returns {{ entry: any, bundle: any }} 题目条目与 bundle
 */
export function createProject(workspace, input) {
  const topic = filled(input?.topic) ? String(input.topic).trim() : ''
  if (topic === '') throw new Error('创建题目需要 topic（辩题原文）')
  const index = getProjectIndex(workspace)
  const id = filled(input?.projectId) ? String(input.projectId).replace(/[^A-Za-z0-9._-]/g, '-') : makeProjectId()
  const bundle = makeBundle({ title: topic, side: input?.side, format: input?.format })
  // makeBundle 会自己生成 project id；这里统一成本题的目录 id，保证索引/目录/数据一致。
  bundle.project.id = id
  bundle.argumentTree.projectId = id
  const entry = entryFromBundle(bundle, id)
  upsertEntry(workspace, index, entry)
  index.activeProjectId = entry.id
  saveProjectIndex(workspace, index)
  writeJsonAtomic(projectBundlePath(workspace, entry), bundle)
  rememberWorkspace(workspace, bundle)
  return { entry, bundle }
}

/**
 * 切换激活题目。
 *
 * @param {string} workspace 工作区
 * @param {string} selector 题目 id / 关键词
 * @returns {{ entry: any, bundle: any }} 切换后的题目
 */
export function switchProject(workspace, selector) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) throw new Error(`找不到题目「${selector}」；用 debate_project(action=list) 查看已有题目`)
  const target = projectBundlePath(workspace, entry)
  if (!fs.existsSync(target)) throw new Error(`题目 ${entry.topic} 的数据文件缺失：${target}`)
  const index = getProjectIndex(workspace)
  index.activeProjectId = entry.id
  saveProjectIndex(workspace, index)
  const bundle = normalizeBundle(readJson(target, null))
  rememberWorkspace(workspace, bundle)
  // 切换题目后清掉上一个题目的节点选中状态，避免 UI 指向不存在的节点。
  saveUiState(workspace, { selectedNodeId: undefined })
  return { entry, bundle }
}

/**
 * 重命名题目（改 bundle 的 title 与索引 topic）。
 *
 * @param {string} workspace 工作区
 * @param {string} selector 题目 id / 关键词
 * @param {string} topic 新辩题
 * @returns {{ entry: any, bundle: any }} 更新后的题目
 */
export function renameProject(workspace, selector, topic) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) throw new Error(`找不到题目「${selector}」`)
  if (!filled(topic)) throw new Error('重命名需要 topic（新的辩题原文）')
  const bundle = loadBundle(workspace, entry.id)
  if (bundle === undefined) throw new Error(`题目 ${entry.topic} 的数据文件缺失`)
  bundle.project.title = String(topic).trim()
  bundle.project.updatedAt = now()
  const nextEntry = { ...entry, topic: bundle.project.title }
  saveBundle(workspace, bundle, { project: entry.id })
  return { entry: { ...nextEntry, ...getProjectIndex(workspace).projects.find(item => item.id === entry.id) }, bundle }
}

/**
 * 归档 / 取消归档题目（不删数据）。
 *
 * @param {string} workspace 工作区
 * @param {string} selector 题目 id / 关键词
 * @param {boolean} archived 是否归档
 * @returns {any} 更新后的条目
 */
export function archiveProject(workspace, selector, archived) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) throw new Error(`找不到题目「${selector}」`)
  const index = getProjectIndex(workspace)
  const position = index.projects.findIndex(item => item.id === entry.id)
  if (position >= 0) index.projects[position] = { ...index.projects[position], archived: archived === true, updatedAt: now() }
  if (archived === true && index.activeProjectId === entry.id) {
    const next = index.projects.find(item => item.archived !== true)
    index.activeProjectId = next?.id ?? null
  }
  saveProjectIndex(workspace, index)
  return index.projects.find(item => item.id === entry.id)
}

/**
 * 删除题目：默认只移出索引（数据目录保留，可手动找回）；purge=true 时连目录一起删。
 *
 * @param {string} workspace 工作区
 * @param {string} selector 题目 id / 关键词
 * @param {{ purge?: boolean }} [options] 是否物理删除
 * @returns {{ removed: any, purged: boolean }} 删除结果
 */
export function deleteProject(workspace, selector, options = {}) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) throw new Error(`找不到题目「${selector}」`)
  const index = getProjectIndex(workspace)
  index.projects = index.projects.filter(item => item.id !== entry.id)
  if (index.activeProjectId === entry.id) index.activeProjectId = index.projects.find(item => item.archived !== true)?.id ?? null
  saveProjectIndex(workspace, index)
  let purged = false
  if (options.purge === true) {
    try {
      fs.rmSync(projectDirPath(workspace, entry), { recursive: true, force: true })
      purged = true
    } catch {
      purged = false
    }
  }
  return { removed: entry, purged }
}

/* ------------------------------------------------------------------ *
 * bundle 读写
 * ------------------------------------------------------------------ */

/** 题目是否存在。 */
export function projectExists(workspace, selector) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry !== undefined) return fs.existsSync(projectBundlePath(workspace, entry))
  return fs.existsSync(legacyBundlePath(workspace))
}

/**
 * 读取题目 bundle。
 *
 * @param {string} workspace 工作区
 * @param {string} [selector] 题目 id / 关键词；省略时用激活题目
 * @returns {any | undefined} 归一后的 bundle；不存在返回 undefined
 */
export function loadBundle(workspace, selector) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) {
    const legacy = legacyBundlePath(workspace)
    if (!fs.existsSync(legacy)) return undefined
    return normalizeBundle(readJson(legacy, null))
  }
  const target = projectBundlePath(workspace, entry)
  if (!fs.existsSync(target)) return undefined
  return normalizeBundle(readJson(target, null))
}

/**
 * 保存 bundle。
 *
 * 目标题目解析顺序：显式 `project` 选择器 → bundle.project.id 对应的题目 → 激活题目 →
 * 新建题目条目（导入/首次创建时）。保存后刷新索引与全局指针。
 *
 * @param {string} workspace 工作区
 * @param {any} bundle bundle
 * @param {{ project?: string, touchPointer?: boolean }} [options] 目标题目与指针选项
 * @returns {string} 写入的 bundle 路径
 */
export function saveBundle(workspace, bundle, options = {}) {
  bundle.project.updatedAt = now()
  if (bundle.argumentTree !== undefined) bundle.argumentTree.updatedAt = now()
  bundle.exportedAt = now()

  const index = getProjectIndex(workspace)
  let entry
  if (filled(options.project)) entry = resolveProjectEntry(workspace, options.project)
  if (entry === undefined) entry = index.projects.find(item => item.id === bundle.project.id)
  if (entry === undefined) entry = index.projects.find(item => item.id === index.activeProjectId)
  if (entry === undefined) {
    // 首次创建 / 导入：自动登记
    const candidate = entryFromBundle(bundle, makeProjectId())
    fs.mkdirSync(projectDirPath(workspace, candidate), { recursive: true })
    entry = candidate
    upsertEntry(workspace, index, entry)
  }
  const target = writeJsonAtomic(projectBundlePath(workspace, entry), bundle)
  const updatedEntry = { ...entry, topic: bundle.project.title, side: bundle.project.side, format: bundle.project.format, updatedAt: bundle.project.updatedAt, archived: false }
  const position = index.projects.findIndex(item => item.id === entry.id)
  if (position >= 0) index.projects[position] = updatedEntry
  else index.projects.push(updatedEntry)
  if (index.activeProjectId === entry.id || index.activeProjectId === null) index.activeProjectId = entry.id
  saveProjectIndex(workspace, index)
  if (options.touchPointer !== false) rememberWorkspace(workspace, bundle)
  return target
}

/* ------------------------------------------------------------------ *
 * 公共证据库 / 待办
 * ------------------------------------------------------------------ */

/**
 * 读取公共证据库（不存在时返回空库）。
 *
 * @param {string} workspace 工作区
 * @returns {{ version: number, cards: Array<any>, updatedAt: string }} 证据库
 */
export function loadSharedLibrary(workspace) {
  const raw = readJson(sharedLibraryPath(workspace), null)
  if (raw === null || typeof raw !== 'object') {
    return { version: LIBRARY_VERSION, cards: [], updatedAt: now() }
  }
  return {
    version: LIBRARY_VERSION,
    cards: Array.isArray(raw.cards) ? raw.cards : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now(),
  }
}

/**
 * 保存公共证据库。
 *
 * @param {string} workspace 工作区
 * @param {any} library 证据库
 * @returns {any} 写入后的证据库
 */
export function saveSharedLibrary(workspace, library) {
  const next = {
    version: LIBRARY_VERSION,
    cards: Array.isArray(library?.cards) ? library.cards : [],
    updatedAt: now(),
  }
  writeJsonAtomic(sharedLibraryPath(workspace), next)
  return next
}

/**
 * 读取题目待办（不存在时返回空列表）。
 *
 * @param {string} workspace 工作区
 * @param {string} [selector] 题目 id / 关键词
 * @returns {{ version: number, projectId: string | null, tasks: Array<any>, updatedAt: string }} 待办
 */
export function loadTasks(workspace, selector) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) return { version: 1, projectId: null, tasks: [], updatedAt: now() }
  const raw = readJson(tasksPath(workspace, entry), null)
  return {
    version: 1,
    projectId: entry.id,
    tasks: Array.isArray(raw?.tasks) ? raw.tasks : [],
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : now(),
  }
}

/**
 * 保存题目待办。
 *
 * @param {string} workspace 工作区
 * @param {string} [selector] 题目 id / 关键词
 * @param {Array<any>} tasks 待办数组
 * @returns {any} 写入后的待办文档
 */
export function saveTasks(workspace, selector, tasks) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) throw new Error('没有可用的题目：先 debate_project(action=create) 或指定 project')
  const next = { version: 1, projectId: entry.id, tasks: Array.isArray(tasks) ? tasks : [], updatedAt: now() }
  writeJsonAtomic(tasksPath(workspace, entry), next)
  return next
}

/* ------------------------------------------------------------------ *
 * UI 状态 / 全局指针
 * ------------------------------------------------------------------ */

/** 默认 UI 状态。 */
export function defaultUiState() {
  return {
    open: false,
    // 每次 action=open 自增：客户端据此「即使标签页被手动关掉也能重新打开」。
    openNonce: 0,
    orientation: 'vertical',
    ratio: 0.5,
    tab: 'tree',
    selectedNodeId: undefined,
    updatedAt: now(),
  }
}

/**
 * 读取工作区的 UI 状态（缺失时返回默认值）。
 *
 * @param {string} workspace 工作区绝对路径
 * @returns {any} UI 状态
 */
export function loadUiState(workspace) {
  const stored = readJson(uiPath(workspace), {})
  const base = defaultUiState()
  const orientation = stored.orientation === 'horizontal' ? 'horizontal' : 'vertical'
  const tabs = ['tree', 'topic', 'evidence', 'attack', 'evaluate', 'manuscript', 'projects']
  return {
    ...base,
    ...stored,
    orientation,
    ratio: Math.min(0.85, Math.max(0.15, Number.isFinite(Number(stored.ratio)) ? Number(stored.ratio) : base.ratio)),
    tab: tabs.includes(stored.tab) ? stored.tab : base.tab,
    open: stored.open === true,
  }
}

/**
 * 更新工作区 UI 状态（浅合并）。
 *
 * @param {string} workspace 工作区绝对路径
 * @param {any} patch 补丁
 * @returns {any} 更新后的状态
 */
export function saveUiState(workspace, patch) {
  const merged = { ...loadUiState(workspace), ...patch, updatedAt: now() }
  writeJsonAtomic(uiPath(workspace), merged)
  const pointer = readPointer()
  writeJsonAtomic(pointerPath(), { ...pointer, ui: merged })
  return merged
}

/** 读取全局指针文件。 */
export function readPointer() {
  const raw = readJson(pointerPath(), {})
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/**
 * 客户端 UI 用的合并状态：没有激活题目时 `active` 为 false。
 *
 * @returns {any} UI 快照
 */
export function uiSnapshot() {
  const pointer = readPointer()
  const active = pointer.active
  const ui = pointer.ui ?? defaultUiState()
  if (active === null || typeof active !== 'object' || typeof active.workspace !== 'string') {
    return { active: false, ui, projects: [], activeProjectId: null }
  }
  const workspace = active.workspace
  const entry = resolveProjectEntry(workspace, active.projectId)
  const exists = entry !== undefined && projectExists(workspace, entry.id)
  const projects = entry === undefined
    ? []
    : listProjects(workspace).map(item => ({
        id: item.id,
        topic: item.topic,
        side: item.side,
        format: item.format,
        archived: item.archived === true,
        active: item.id === entry.id,
        updatedAt: item.updatedAt,
        stats: item.stats,
      }))
  return {
    active: exists,
    workspace,
    project: entry === undefined ? undefined : { id: entry.id, title: entry.topic, side: entry.side, format: entry.format },
    projects,
    activeProjectId: entry?.id ?? null,
    ui,
    updatedAt: pointer.ui?.updatedAt ?? active.updatedAt,
  }
}

/**
 * 关闭工作台（保留激活题目，只收起界面）。
 *
 * @param {string} [workspace] 工作区路径；省略时用指针里的工作区
 * @returns {any} 更新后的 UI 状态
 */
export function closeWorkbench(workspace) {
  const pointer = readPointer()
  const target = workspace ?? pointer.active?.workspace
  if (typeof target !== 'string' || target === '') {
    const ui = { ...defaultUiState(), open: false }
    writeJsonAtomic(pointerPath(), { ...pointer, ui })
    return ui
  }
  return saveUiState(target, { open: false })
}

/**
 * 打开工作台：要求该工作区已有题目；给了 selector 时顺便切换激活题目。
 *
 * @param {string} workspace 工作区路径
 * @param {string} [selector] 题目 id / 关键词
 * @returns {any} 更新后的 UI 状态
 */
export function openWorkbench(workspace, selector) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined || !projectExists(workspace, entry.id)) {
    throw new Error(`${workspace} 里还没有辩论项目（缺少 .debate/projects/<id>/project.bundle.json），请先 debate_project(action=create)`)
  }
  const bundle = loadBundle(workspace, entry.id)
  const index = getProjectIndex(workspace)
  if (index.activeProjectId !== entry.id) {
    index.activeProjectId = entry.id
    saveProjectIndex(workspace, index)
  }
  rememberWorkspace(workspace, bundle)
  // openNonce 自增：即使标签页已被用户手动关闭，客户端也会因为 nonce 变化而重新打开。
  const current = loadUiState(workspace)
  return saveUiState(workspace, { open: true, openNonce: Number(current.openNonce ?? 0) + 1 })
}

/**
 * 列出所有已知工作区项目（跨工作区，来自全局指针），供调试/兼容用。
 *
 * @returns {Array<{ workspace: string, projectId: string, title: string, side: string, updatedAt: string, exists: boolean }>}
 */
export function listKnownProjects() {
  const pointer = readPointer()
  const known = Array.isArray(pointer.known) ? pointer.known : []
  const entries = []
  const seen = new Set()
  const push = (workspace) => {
    if (typeof workspace !== 'string' || workspace === '' || seen.has(workspace)) return
    seen.add(workspace)
    const entry = resolveProjectEntry(workspace, undefined)
    entries.push({
      workspace,
      projectId: entry?.id ?? '',
      title: entry?.topic ?? path.basename(workspace),
      side: entry?.side ?? 'pro',
      updatedAt: entry?.updatedAt ?? '',
      exists: entry !== undefined && projectExists(workspace, entry.id),
    })
  }
  if (pointer.active !== null && typeof pointer.active === 'object') push(pointer.active.workspace)
  for (const entry of known) push(entry?.workspace)
  return entries
}

/**
 * 把一个工作区记进全局已知列表，并把当前题目设为激活指针。
 *
 * @param {string} workspace 工作区路径
 * @param {any} bundle 题目 bundle
 */
export function rememberWorkspace(workspace, bundle) {
  const pointer = readPointer()
  const known = (Array.isArray(pointer.known) ? pointer.known : []).filter(entry => entry?.workspace !== workspace)
  const entry = resolveProjectEntry(workspace, bundle?.project?.id)
  known.unshift({ workspace, projectId: entry?.id ?? bundle?.project?.id ?? '', title: bundle?.project?.title ?? '', updatedAt: now() })
  writeJsonAtomic(pointerPath(), {
    ...pointer,
    active: {
      workspace,
      projectId: entry?.id ?? bundle?.project?.id,
      title: bundle?.project?.title,
      side: bundle?.project?.side,
      updatedAt: now(),
    },
    known: known.slice(0, 50),
  })
}

/** 清空全局指针（调试/重置用）。 */
export function clearPointer() {
  writeJsonAtomic(pointerPath(), {})
}
