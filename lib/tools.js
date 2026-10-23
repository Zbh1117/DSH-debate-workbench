/**
 * 辩论备赛工作台 —— 模型可调用的工具集（Host 半）。
 *
 * 数据一律落在「当前会话工作区」的 `.debate/project.bundle.json`，
 * 格式与 DebateWeaver 的 `ProjectExportBundle` 完全一致，可直接互相导入导出。
 *
 * 工具分工：
 *   debate_project    建/开/读/列项目，看整体状态
 *   debate_topic      拆题结果（DecompositionResult）的保存与校验
 *   debate_tree       论证树节点与连线的增删改、自动布局
 *   debate_evidence   证据卡增删改查 + 挂到节点
 *   debate_attack     攻防框：攻击路径 / 威胁度 / 防守策略
 *   debate_evaluate   五维评估（确定性计算）与苏格拉底追问
 *   debate_manuscript 一辩/结辩/驳论稿组装
 *   debate_bundle     导入导出/校验 ProjectExportBundle
 *   debate_workbench  工作台界面开关与分屏状态（供客户端 UI 读取）
 *
 * @module dsh-debate-workbench/tools
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ATTACK_TYPES,
  DEBATE_FORMATS,
  EVIDENCE_TYPES,
  NODE_TYPES,
  clampInt,
  filled,
  makeAiEvaluation,
  makeAttackDefenseBox,
  makeAttackPath,
  makeBundle,
  makeEdge,
  makeEvidenceCard,
  makeManuscript,
  makeNode,
  makeNodeEvidenceLink,
  newId,
  normalizeBundle,
  now,
  trimmed,
  validateBundle,
} from './model.js'
import { analyze, socraticQuestions, treeIndex } from './checks.js'
import {
  aiStatus,
  buildAttacksPrompt,
  buildDecomposePrompt,
  generateJson,
  normalizeAttackCandidate,
  normalizeDecomposeCandidate,
  resolveAiRoute,
} from './ai.js'
import { composeManuscript, nodeTypeLabel, renderBundleMarkdown, renderDecompositionMarkdown, renderTreeMarkdown } from './markdown.js'
import {
  activeProjectEntry,
  archiveProject,
  bundlePath,
  closeWorkbench,
  createProject,
  dataDir,
  deleteProject,
  getProjectIndex,
  listProjects,
  loadBundle,
  loadSharedLibrary,
  loadTasks,
  loadUiState,
  openWorkbench,
  projectBundlePath,
  projectExists,
  rememberWorkspace,
  renameProject,
  resolveProjectEntry,
  resolveWorkspace,
  saveBundle,
  saveSharedLibrary,
  saveTasks,
  saveUiState,
  sharedLibraryPath,
  switchProject,
  tasksPath,
  uiSnapshot,
  writeJsonAtomic,
} from './store.js'

/** 复杂输出的宽松 schema：模型可见文本由 render 负责。 */
const LOOSE = { type: 'object', additionalProperties: true }
/** 一个文本 ContentBlock。 */
const textBlock = text => [{ type: 'text', text }]

/**
 * 递归剔除 `undefined`（以及函数/符号这类非 JSON 值），保证工具返回值是
 * lossless JSON —— 宿主工具注册表会拒绝含 undefined 的输出，之前
 * `debate_workbench(open)` 就因此报过 "value is not lossless JSON"。
 */
function lossless(value) {
  if (value === undefined) return undefined
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : 0
  if (type === 'function' || type === 'symbol' || type === 'bigint') return undefined
  if (Array.isArray(value)) return value.map(item => lossless(item)).filter(item => item !== undefined)
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    const cleaned = lossless(item)
    if (cleaned !== undefined) output[key] = cleaned
  }
  return output
}

/** 工作区 / 题目参数（所有工具共用）。 */
const WORKSPACE_PARAM = {
  workspace: { type: 'string', description: '辩论工作区路径；省略时用当前会话工作目录。插件在其下读写 .debate/。' },
  project: {
    type: 'string',
    description: '题目 id 或题目关键词（省略时用当前激活题目）。多题目可并行操作：传 project 即可读写指定题目而不切换激活题。',
  },
}

/** 拆题候选 → 可读文本（给模型/界面预览用）。 */
function formatDecomposeCandidate(candidate) {
  const lines = ['# 拆题候选（未落库）']
  if (candidate.judgeQuestion !== '') lines.push(`评委问题：${candidate.judgeQuestion}`)
  if (candidate.motionType !== '') lines.push(`辩题类型：${candidate.motionType}`)
  if (candidate.coreConcepts.length > 0) {
    lines.push('', '核心概念：')
    for (const item of candidate.coreConcepts) lines.push(`- ${item.term}：${item.suggestedDefinition || item.literalDefinition || '（待补定义）'}`)
  }
  if (candidate.controversialPoints.length > 0) {
    lines.push('', '争议点：')
    for (const item of candidate.controversialPoints) lines.push(`- ${item.issue}｜我方：${item.proView || '待补'}｜对方：${item.conView || '待补'}`)
  }
  if (candidate.battlefields.length > 0) {
    lines.push('', '战场：')
    for (const item of candidate.battlefields) lines.push(`- [${item.priority}] ${item.battlefield}：${item.whyItMatters || ''}`)
  }
  const criteria = candidate.comparisonFramework?.criteria ?? []
  if (criteria.length > 0) {
    lines.push('', '比较框架：')
    lines.push(`- 平台：${candidate.comparisonFramework.overallPlatform || '待补'}`)
    for (const item of criteria) lines.push(`- ${item.dimension}：我方标准 ${item.ourStandard || '待补'}｜对方标准 ${item.opponentStandard || '待补'}`)
  }
  if (candidate.hiddenPremises.length > 0) {
    lines.push('', '隐藏前提：')
    for (const item of candidate.hiddenPremises) lines.push(`- ${item.premise}`)
  }
  if (candidate.argumentPaths.length > 0) {
    lines.push('', '论证路径：')
    for (const item of candidate.argumentPaths) lines.push(`- [${item.side}] ${item.mainClaim}（支撑 ${item.supportingPoints.length} 点）`)
  }
  if (candidate.rebuttalTargets.length > 0) {
    lines.push('', '反驳目标：')
    for (const item of candidate.rebuttalTargets) lines.push(`- ${item.target}`)
  }
  if (candidate.prepChecklist.length > 0) {
    lines.push('', '备赛清单：')
    for (const item of candidate.prepChecklist) lines.push(`- ${item}`)
  }
  lines.push('', '（这是候选结果，确认后再写入拆题数据）')
  return lines.join('\n')
}

/** 缺口列表转文本。 */
function formatGaps(gaps, limit = 12) {
  if (!Array.isArray(gaps) || gaps.length === 0) return '无缺口。'
  const badge = { error: '必须补', warn: '建议补', info: '可选' }
  const order = { error: 0, warn: 1, info: 2 }
  return [...gaps]
    .sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
    .slice(0, limit)
    .map((item, index) => `${index + 1}. [${badge[item.level] ?? item.level}] ${item.message}`)
    .join('\n')
}

/** 读取 bundle，缺失时抛可执行错误（提示已有题目列表）。 */
function requireBundle(workspace, selector) {
  const bundle = loadBundle(workspace, selector)
  if (bundle === undefined) {
    const projects = listProjects(workspace, { includeArchived: true })
    const hint = projects.length === 0
      ? '当前工作区还没有任何题目'
      : `当前工作区已有题目：${projects.map(item => item.topic).join(' / ')}`
    throw new Error(`${workspace} 里找不到目标题目（${hint}）。先调用 debate_project(action=create, topic=...) 或用 project 指定已有题目`)
  }
  return bundle
}

/** 保存并返回分析摘要（保存到指定题目，缺省为激活题目）。 */
function commit(workspace, bundle, selector) {
  saveBundle(workspace, bundle, { project: selector })
  return analyze(bundle)
}

/** 题目待办转文本。 */
function formatTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return '（暂无待办）'
  const badge = { todo: '待办', doing: '进行中', done: '已完成' }
  const order = { doing: 0, todo: 1, done: 2 }
  return [...tasks]
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3))
    .map((item, index) => {
      const deadline = filled(item.deadline) ? `　截止 ${item.deadline}` : ''
      const node = filled(item.nodeId) ? `　节点 ${item.nodeId}` : ''
      return `${index + 1}. [${badge[item.status] ?? item.status}] ${item.title}${deadline}${node}`
    })
    .join('\n')
}

/** 找节点，找不到抛错。 */
function requireNode(bundle, nodeId) {
  const node = (bundle.argumentTree?.nodes ?? []).find(item => item.id === nodeId)
  if (node === undefined) throw new Error(`找不到节点 ${nodeId}`)
  return node
}

/** 自动布局：按深度分层，层内按顺序纵向排布。 */
function autoLayout(bundle, options = {}) {
  const index = treeIndex(bundle)
  const columnGap = clampInt(options.columnGap, 120, 1200, 300)
  const rowGap = clampInt(options.rowGap, 60, 600, 140)
  const depthBuckets = new Map()
  const placed = new Set()
  const order = []
  for (const root of index.roots) order.push([root.id, 0])
  while (order.length > 0) {
    const [id, depth] = order.shift()
    if (placed.has(id)) continue
    placed.add(id)
    if (!depthBuckets.has(depth)) depthBuckets.set(depth, [])
    depthBuckets.get(depth).push(id)
    for (const childId of index.children.get(id) ?? []) order.push([childId, depth + 1])
  }
  for (const node of index.nodes) {
    if (placed.has(node.id)) continue
    if (!depthBuckets.has(0)) depthBuckets.set(0, [])
    depthBuckets.get(0).push(node.id)
  }
  for (const [depth, ids] of [...depthBuckets.entries()].sort((a, b) => a[0] - b[0])) {
    ids.forEach((id, row) => {
      const node = index.byId.get(id)
      if (node === undefined) return
      node.position = { x: depth * columnGap, y: row * rowGap }
    })
  }
  bundle.argumentTree.updatedAt = now()
  return { nodes: index.nodes.length, columns: depthBuckets.size }
}

/**
 * 注册全部工具。
 *
 * @param {any} ctx cordis 上下文（已 inject tools）
 * @param {{ panel?: { url: () => string | undefined } }} options 面板信息
 * @returns {Map<string, any>} 工具定义表（HTTP API 复用同一套 execute）
 */
export function registerDebateTools(ctx, options = {}) {
  const pluginConfig = options.config !== null && typeof options.config === 'object' ? options.config : {}
  const definitions = new Map()
  const registry = {
    register(definition) {
      const rawExecute = definition.execute
      const safeDefinition = {
        ...definition,
        execute: async (args, exec) => lossless(await rawExecute(args, exec)),
      }
      definitions.set(definition.name, safeDefinition)
      ctx.tools.register(safeDefinition)
      return () => definitions.delete(definition.name)
    },
  }

  /* ------------------------------------------------------------------ *
   * debate_project
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_project',
    description:
      '辩论项目入口（支持多题目）。action=create 新建题目（独立子目录 .debate/projects/<id>/，自带稿件/证据/攻防）；action=list 列出本工作区所有题目与当前激活题；action=switch 切换激活题目（project 传 id 或题目关键词）；action=rename 改题；action=archive 归档；action=delete 移出列表（purge=true 连数据一起删）；action=open 打开工作台并切换到该题；action=status 看就绪度/五维/缺口（默认激活题，可传 project）；action=read 读原始 bundle。开始任何备赛工作前先 list/create/switch。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'switch', 'rename', 'archive', 'delete', 'open', 'status', 'read'], description: '要执行的操作。' },
        topic: { type: 'string', description: 'action=create/rename：辩题原文。' },
        side: { type: 'string', description: 'action=create：持方，正/反/pro/con。' },
        format: { type: 'string', enum: DEBATE_FORMATS, description: 'action=create：赛制，默认 chinese。' },
        purge: { type: 'boolean', description: 'action=delete：是否连同题目数据目录一起删除（默认 false，只移出列表）。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)

      if (args.action === 'list') {
        const projects = listProjects(workspace, { includeArchived: true })
        const active = resolveProjectEntry(workspace, undefined)
        const lines = [`辩论题目（${projects.length} 个，工作区 ${workspace}）：`]
        if (projects.length === 0) lines.push('- 暂无题目：debate_project(action=create, topic=...) 新建')
        for (const item of projects) {
          const mark = item.id === active?.id ? '▶ ' : '  '
          const archived = item.archived === true ? '（已归档）' : ''
          lines.push(
            `${mark}${item.topic}${archived}　[${item.side === 'pro' ? '正方' : '反方'} · ${item.format}]　节点 ${item.stats.nodes} · 证据 ${item.stats.evidence}　id=${item.id}`,
          )
        }
        lines.push('', '切换题目：debate_project(action=switch, project=id或题目关键词)')
        return { action: 'list', workspace, activeProjectId: active?.id ?? null, projects, text: lines.join('\n') }
      }

      if (args.action === 'create') {
        if (!filled(args.topic)) throw new Error('action=create 需要提供辩题（topic）')
        const { entry, bundle } = createProject(workspace, { topic: args.topic, side: args.side, format: args.format })
        const report = analyze(bundle)
        return {
          action: 'create',
          workspace,
          project: bundle.project,
          bundlePath: projectBundlePath(workspace, entry),
          readiness: report.readiness,
          text: [
            `题目已创建：${bundle.project.title}（${bundle.project.side === 'pro' ? '正方' : '反方'} · ${bundle.project.format}）`,
            `题目目录：${projectBundlePath(workspace, entry)}`,
            '同一工作区可以建多个题目，用 debate_project(action=switch, project=...) 切换。',
            '',
            '建议下一步：',
            '1. debate_topic(action=save) 落盘拆题结果',
            '2. debate_tree(action=add_node) 从立场节点开始搭论证树（可用 action=auto_layout 排版）',
            '3. debate_evidence(action=add) 建证据卡，再用 action=link 挂到节点',
            '4. debate_workbench(action=open) 打开右栏工作台，边看树边对话',
          ].join('\n'),
        }
      }

      if (args.action === 'switch') {
        if (!filled(args.project)) throw new Error('action=switch 需要 project（题目 id 或题目关键词）')
        const { entry, bundle } = switchProject(workspace, args.project)
        const report = analyze(bundle)
        return {
          action: 'switch',
          workspace,
          project: bundle.project,
          projectId: entry.id,
          readiness: report.readiness,
          text: `已切换到题目：${bundle.project.title}（就绪度 ${report.readiness}/100，节点 ${bundle.argumentTree?.nodes?.length ?? 0}）`,
        }
      }

      if (args.action === 'rename') {
        const { entry, bundle } = renameProject(workspace, args.project, args.topic)
        return {
          action: 'rename',
          project: bundle.project,
          text: `题目已重命名为：${bundle.project.title}（id=${entry.id}）`,
        }
      }

      if (args.action === 'archive') {
        const entry = archiveProject(workspace, args.project, true)
        return { action: 'archive', project: entry, text: `已归档题目：${entry.topic}` }
      }

      if (args.action === 'delete') {
        const result = deleteProject(workspace, args.project, { purge: args.purge === true })
        return {
          action: 'delete',
          removed: result.removed,
          purged: result.purged,
          text: `已删除题目：${result.removed.topic}${result.purged ? '（数据目录已删除）' : '（数据目录保留，可找回）'}`,
        }
      }

      const bundle = requireBundle(workspace, args.project)

      if (args.action === 'read') {
        const entry = resolveProjectEntry(workspace, args.project)
        const target = entry === undefined ? bundlePath(workspace) : projectBundlePath(workspace, entry)
        return { action: 'read', workspace, projectId: entry?.id, bundle, text: `题目 bundle（${bundle.argumentTree?.nodes?.length ?? 0} 节点）：\n${target}` }
      }

      if (args.action === 'open') {
        rememberWorkspace(workspace, bundle)
        const ui = openWorkbench(workspace, args.project)
        const url = options.panel?.url?.()
        return {
          action: 'open',
          workspace,
          project: bundle.project,
          ui,
          url,
          text: [
            `工作台已打开：${bundle.project.title}`,
            '界面：DSH 右侧栏会打开「辩论工作台」标签页，顶栏可切换题目。',
            url === undefined ? '（本次运行没有 Web 服务，只能使用工具与 Markdown 导出）' : `调试页：${url}#tree`,
          ].join('\n'),
        }
      }

      const report = analyze(bundle)
      const stats = report.stats
      const text = [
        `# ${bundle.project.title}（${bundle.project.side === 'pro' ? '正方' : '反方'}）`,
        `工作区：${workspace}`,
        `就绪度 ${report.readiness}/100　阻塞缺口 ${report.blocking} 项 / 提醒 ${report.warnings} 项`,
        `五维：逻辑 ${report.scores.logic} · 证据 ${report.scores.evidence} · 说服 ${report.scores.persuasiveness} · 创新 ${report.scores.innovation} · 抗反驳 ${report.scores.counterResilience}（综合 ${report.scores.overall}）`,
        `规模：树 ${stats.tree.total} 节点 / ${stats.tree.edges} 连线（最大深度 ${stats.tree.maxDepth}）· 证据 ${stats.evidence.cards} 张（已用 ${stats.evidence.used}）· 攻防框 ${stats.attack.boxes} 个（攻击 ${stats.attack.attacks} 条）· 稿件 ${stats.manuscripts} 份`,
        '',
        '最该补的缺口：',
        formatGaps(report.gaps, 10),
        '',
        '建议：',
        ...report.suggestions.slice(0, 5).map((item, index) => `${index + 1}. ${item}`),
      ].join('\n')
      return { action: 'status', workspace, readiness: report.readiness, scores: report.scores, analysis: report, text }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_topic
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_topic',
    description:
      '辩题拆解结果（DecompositionResult）。字段对齐 DebateWeaver：coreConcepts[]（term/literalDefinition/possibleInterpretations/suggestedDefinition/counterDefinition）、judgeQuestion、controversialPoints[]（issue/proView/conView/keyBattle）、battlefields[]（battlefield/whyItMatters/ourPush/opponentPush/priority）、comparisonFramework{overallPlatform,criteria[]}、hiddenPremises[]、argumentPaths[]（side/mainClaim/supportingPoints）、ourSideDetailedRoute、rebuttalTargets[]、prepChecklist[]。action=save 保存并返回缺口、action=read 读取、action=render 输出 Markdown。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'read', 'render'], description: '要执行的操作。' },
        decomposition: { type: 'object', additionalProperties: true, description: 'action=save：完整拆题对象。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const bundle = requireBundle(workspace, args.project)
      const current = Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined

      if (args.action === 'read') {
        const report = analyze(bundle)
        const topicGapList = report.gaps.filter(item => item.code.startsWith('D_'))
        return { action: 'read', decomposition: current, text: `# 拆题结果\n\n${renderDecompositionMarkdown(current)}\n\n${formatGaps(topicGapList)}` }
      }
      if (args.action === 'render') {
        return { action: 'render', markdown: renderDecompositionMarkdown(current), text: renderDecompositionMarkdown(current) }
      }
      if (args.decomposition === null || typeof args.decomposition !== 'object' || Array.isArray(args.decomposition)) {
        throw new Error('action=save 需要提供 decomposition 对象')
      }
      const decomposition = {
        ...args.decomposition,
        id: filled(args.decomposition.id) ? args.decomposition.id : newId('decomposition'),
        projectId: bundle.project.id,
        createdAt: filled(args.decomposition.createdAt) ? args.decomposition.createdAt : now(),
      }
      bundle.decompositionResults = [decomposition]
      const report = commit(workspace, bundle, args.project)
      const topicGaps = report.gaps.filter(item => item.code.startsWith('D_'))
      return {
        action: 'save',
        decomposition,
        gaps: topicGaps,
        text: `拆题已保存（${bundlePath(workspace)}）。\n\n拆题缺口：\n${formatGaps(topicGaps)}\n\n整案就绪度：${report.readiness}/100`,
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_tree
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_tree',
    description:
      '论证树操作。9 种节点类型：stance 立场 / status 现状 / crowd 主体 / premise 前提 / claim 论点 / evidence 证据 / compare 比较 / attitude 价值 / image 图片。action=add_node（node={type,label,description,details}）、update_node（nodeId + patch）、move_node（nodeId+position）、remove_node（连同其子树与连线）、connect（source→target，可先 add_node 再连）、disconnect（edgeId）、auto_layout（按深度重排坐标）、read（输出树大纲 Markdown）。节点 id 会自动生成，返回值里给出。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add_node', 'update_node', 'move_node', 'remove_node', 'connect', 'disconnect', 'auto_layout', 'read'],
          description: '要执行的操作。',
        },
        node: { type: 'object', additionalProperties: true, description: 'action=add_node：节点对象 {type, label, description, details}。' },
        nodeId: { type: 'string', description: 'action=update_node/move_node/remove_node：目标节点 id。' },
        patch: { type: 'object', additionalProperties: true, description: 'action=update_node：{label, description, details, type}。' },
        position: { type: 'object', additionalProperties: true, description: 'action=move_node：{x, y}。' },
        source: { type: 'string', description: 'action=connect：父节点 id。' },
        target: { type: 'string', description: 'action=connect：子节点 id。' },
        edgeId: { type: 'string', description: 'action=disconnect：连线 id。' },
        options: { type: 'object', additionalProperties: true, description: 'action=auto_layout：{columnGap, rowGap}。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const bundle = requireBundle(workspace, args.project)
      if (bundle.argumentTree === undefined) throw new Error('bundle 缺少 argumentTree')

      switch (args.action) {
        case 'read': {
          return { action: 'read', markdown: renderTreeMarkdown(bundle), text: renderTreeMarkdown(bundle) }
        }
        case 'add_node': {
          const input = args.node ?? {}
          if (!NODE_TYPES.includes(input.type)) throw new Error(`node.type 必须是 ${NODE_TYPES.join(' / ')} 之一`)
          if (!filled(input.label)) throw new Error('node.label 必须是非空标题')
          const node = makeNode({ type: input.type, data: { label: input.label, description: input.description, details: input.details } })
          bundle.argumentTree.nodes.push(node)
          if (filled(args.source)) {
            const parent = requireNode(bundle, args.source)
            bundle.argumentTree.edges.push(makeEdge(parent.id, node.id))
          }
          const report = commit(workspace, bundle, args.project)
          return {
            action: 'add_node',
            node,
            readiness: report.readiness,
            text: `已添加节点 ${nodeTypeLabel(node.type)}「${node.data.label}」（id=${node.id}）${filled(args.source) ? `，父节点 ${args.source}` : ''}。\n节点总数 ${bundle.argumentTree.nodes.length}，就绪度 ${report.readiness}/100。\n下一步可用 debate_evidence(action=link) 挂证据，或 debate_attack(action=add_attack) 写预判。`,
          }
        }
        case 'update_node': {
          const node = requireNode(bundle, args.nodeId)
          const patch = args.patch ?? {}
          if (filled(patch.type)) {
            if (!NODE_TYPES.includes(patch.type)) throw new Error(`patch.type 必须是 ${NODE_TYPES.join(' / ')} 之一`)
            node.type = patch.type
          }
          if (filled(patch.label)) node.data.label = patch.label.trim()
          if (patch.description !== undefined) {
            const text = trimmed(patch.description)
            if (text === undefined) delete node.data.description
            else node.data.description = text
          }
          if (patch.details !== null && typeof patch.details === 'object') node.data.details = { ...(node.data.details ?? {}), ...patch.details }
          const report = commit(workspace, bundle, args.project)
          return { action: 'update_node', node, readiness: report.readiness, text: `已更新「${node.data.label}」。就绪度 ${report.readiness}/100。` }
        }
        case 'move_node': {
          const node = requireNode(bundle, args.nodeId)
          const position = args.position ?? {}
          node.position = { x: Number(position.x) || 0, y: Number(position.y) || 0 }
          commit(workspace, bundle, args.project)
          return { action: 'move_node', node, text: `已把「${node.data.label}」移到 (${node.position.x}, ${node.position.y})。` }
        }
        case 'remove_node': {
          const target = requireNode(bundle, args.nodeId)
          const index = treeIndex(bundle)
          const subtree = new Set()
          const collect = id => {
            if (subtree.has(id)) return
            subtree.add(id)
            for (const childId of index.children.get(id) ?? []) collect(childId)
          }
          collect(target.id)
          bundle.argumentTree.nodes = bundle.argumentTree.nodes.filter(node => !subtree.has(node.id))
          bundle.argumentTree.edges = bundle.argumentTree.edges.filter(edge => !subtree.has(edge.source) && !subtree.has(edge.target))
          bundle.nodeEvidenceLinks = bundle.nodeEvidenceLinks.filter(link => !subtree.has(link.nodeId))
          bundle.attackDefenseBoxes = bundle.attackDefenseBoxes.filter(box => !subtree.has(box.nodeId))
          const report = commit(workspace, bundle, args.project)
          return { action: 'remove_node', removed: subtree.size, readiness: report.readiness, text: `已删除节点「${target.data.label}」及其 ${subtree.size - 1} 个子节点（相关证据关联与攻防框一并移除）。就绪度 ${report.readiness}/100。` }
        }
        case 'connect': {
          const parent = requireNode(bundle, args.source)
          const child = requireNode(bundle, args.target)
          if (parent.id === child.id) throw new Error('不能把节点连到自己')
          const index = treeIndex(bundle)
          const reachable = new Set()
          const collect = id => {
            if (reachable.has(id)) return
            reachable.add(id)
            for (const next of index.children.get(id) ?? []) collect(next)
          }
          collect(child.id)
          if (reachable.has(parent.id)) throw new Error('这条连线会形成环：目标的子树里包含了父节点')
          const existing = bundle.argumentTree.edges.find(edge => edge.source === parent.id && edge.target === child.id)
          if (existing !== undefined) {
            return { action: 'connect', edge: existing, text: `连线已存在：${parent.data.label} → ${child.data.label}` }
          }
          const edge = makeEdge(parent.id, child.id)
          bundle.argumentTree.edges.push(edge)
          commit(workspace, bundle, args.project)
          return { action: 'connect', edge, text: `已连线：${parent.data.label} → ${child.data.label}（edge=${edge.id}）` }
        }
        case 'disconnect': {
          const before = bundle.argumentTree.edges.length
          bundle.argumentTree.edges = bundle.argumentTree.edges.filter(edge => edge.id !== args.edgeId)
          if (bundle.argumentTree.edges.length === before) throw new Error(`找不到连线 ${args.edgeId}`)
          commit(workspace, bundle, args.project)
          return { action: 'disconnect', removed: 1, text: `已删除连线 ${args.edgeId}。` }
        }
        case 'auto_layout': {
          const result = autoLayout(bundle, args.options)
          commit(workspace, bundle, args.project)
          return { action: 'auto_layout', ...result, text: `已按深度重排 ${result.nodes} 个节点（${result.columns} 列）。` }
        }
        default:
          throw new Error(`未知 action：${args.action}`)
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_evidence
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_evidence',
    description:
      '证据卡库（EvidenceCard，字段对齐 DebateWeaver）：title/content/originalText/type(data 数据|case 案例|theory 机理)/credibility(1–5)/timeliness/tags[]/applicableSide(pro|con|both)/counterWarning/source/year/url。action=add 批量新建、import 批量入库+挂载（默认 dryRun：来源必填、标题+url 去重，卡片可带 nodeIds 直接挂节点）、search 检索、update 打补丁、delete 删除、read 单条、link 挂到论证节点（nodeId+cardId）、unlink 取消挂载、list_linked 看某节点挂了什么。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'import', 'search', 'update', 'delete', 'read', 'link', 'unlink', 'list_linked'], description: '要执行的操作。' },
        apply: { type: 'boolean', description: 'action=import：是否真正写入（默认 false，只返回 dryRun 计划）。' },
        cards: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'action=add：证据卡数组。' },
        id: { type: 'string', description: 'action=update/read：卡片 id。' },
        patch: { type: 'object', additionalProperties: true, description: 'action=update：补丁对象。' },
        ids: { type: 'array', items: { type: 'string' }, description: 'action=delete：要删除的卡片 id。' },
        query: { type: 'string', description: 'action=search：关键词（空格分隔，命中标题/原文/内容/来源/标签）。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'action=search：标签过滤（任一命中）。' },
        type: { type: 'string', enum: EVIDENCE_TYPES, description: 'action=search：按证据类型过滤。' },
        minCredibility: { type: 'integer', description: 'action=search：可信度下限 1–5。' },
        nodeId: { type: 'string', description: 'action=link/unlink/list_linked：论证节点 id。' },
        cardId: { type: 'string', description: 'action=link/unlink：证据卡 id。' },
        note: { type: 'string', description: 'action=link：挂载说明。' },
        linkId: { type: 'string', description: 'action=unlink：直接指定关联 id（与 nodeId+cardId 二选一）。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const bundle = requireBundle(workspace, args.project)
      const cards = bundle.evidenceCards

      switch (args.action) {
        case 'import': {
          const input = Array.isArray(args.cards) ? args.cards : []
          if (input.length === 0) throw new Error('action=import 需要至少一张 cards')
          const dryRun = args.apply !== true
          const linkTo = typeof args.nodeId === 'string' ? args.nodeId : undefined
          const roundKey = value => String(value ?? '').trim().toLowerCase()
          const keyOf = item => `${roundKey(item?.title)}|${roundKey(item?.url)}`
          const existing = new Set(cards.map(item => keyOf(item)))
          const accepted = []
          const skipped = []
          for (const item of input) {
            if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
            const title = String(item.title ?? '').trim()
            if (title === '') {
              skipped.push({ reason: '缺少标题', title: '' })
              continue
            }
            const source = String(item.source ?? '').trim()
            const url = String(item.url ?? '').trim()
            if (source === '' && url === '') {
              skipped.push({ reason: '缺少来源（source 或 url），按硬约束不入库', title })
              continue
            }
            if (existing.has(keyOf(item))) {
              skipped.push({ reason: '重复（标题+url 已存在）', title })
              continue
            }
            existing.add(keyOf(item))
            const nodeIds = [
              ...(Array.isArray(item.nodeIds) ? item.nodeIds : []),
              ...(linkTo !== undefined ? [linkTo] : []),
            ].filter(id => typeof id === 'string' && id !== '')
            accepted.push({ item, title, nodeIds })
          }
          if (dryRun) {
            return {
              action: 'import',
              apply: false,
              wouldCreate: accepted.length,
              plan: accepted.map(entry => ({ title: entry.title, type: entry.item.type ?? 'data', source: entry.item.source ?? entry.item.url, nodeIds: entry.nodeIds })),
              skipped,
              text: [
                `导入计划（dryRun，尚未写入）：将入库 ${accepted.length} 张，跳过 ${skipped.length} 张。`,
                ...accepted.slice(0, 12).map(entry => `- [${entry.item.type ?? 'data'}] ${entry.title}（挂载 ${entry.nodeIds.length} 个节点）`),
                ...(skipped.length > 0 ? ['', '跳过：', ...skipped.slice(0, 8).map(entry => `- ${entry.title || '(无标题)'}：${entry.reason}`)] : []),
                '',
                '确认无误后调用 action=import, apply=true 写入。',
              ].join('\n'),
            }
          }
          const created = accepted.map(entry => {
            const card = makeEvidenceCard({ ...entry.item, id: undefined, nodeIds: undefined })
            cards.push(card)
            return { card, nodeIds: entry.nodeIds }
          })
          let linkCount = 0
          for (const { card, nodeIds } of created) {
            for (const nodeId of nodeIds) {
              if (!bundle.argumentTree.nodes.some(node => node.id === nodeId)) continue
              if ((bundle.nodeEvidenceLinks ?? []).some(link => link.nodeId === nodeId && link.evidenceCardId === card.id)) continue
              bundle.nodeEvidenceLinks.push(makeNodeEvidenceLink({ nodeId, evidenceCardId: card.id, projectId: bundle.project.id }))
              linkCount += 1
            }
          }
          const report = commit(workspace, bundle, args.project)
          return {
            action: 'import',
            apply: true,
            created: created.length,
            linked: linkCount,
            skipped,
            cards: created.map(entry => entry.card),
            readiness: report.readiness,
            text: `已入库 ${created.length} 张证据、建立 ${linkCount} 条挂载（共 ${cards.length} 张）。就绪度 ${report.readiness}/100。`,
          }
        }
        case 'add': {
          const input = Array.isArray(args.cards) ? args.cards : []
          if (input.length === 0) throw new Error('action=add 需要至少一张 cards')
          const added = input.map(item => makeEvidenceCard(item))
          cards.push(...added)
          const report = commit(workspace, bundle, args.project)
          return {
            action: 'add',
            cards: added,
            total: cards.length,
            readiness: report.readiness,
            text: `已入库 ${added.length} 张证据卡（共 ${cards.length} 张）：\n${added.map(card => `- [${card.id}] ${card.title}（${card.type}，可信度 ${card.credibility}/5）`).join('\n')}\n\n下一步：action=link 挂到论证节点，否则证据是用不上的。`,
          }
        }
        case 'search': {
          const terms = typeof args.query === 'string' ? args.query.toLowerCase().split(/[\s,，、;；/]+/).filter(Boolean) : []
          const tags = Array.isArray(args.tags) ? args.tags.map(tag => String(tag).toLowerCase()) : []
          const minCredibility = clampInt(args.minCredibility, 0, 5, 0)
          const matched = cards.filter(card => {
            if (typeof args.type === 'string' && card.type !== args.type) return false
            if (minCredibility > 0 && Number(card.credibility) < minCredibility) return false
            if (tags.length > 0) {
              const cardTags = (card.tags ?? []).map(tag => String(tag).toLowerCase())
              if (!tags.some(tag => cardTags.includes(tag))) return false
            }
            if (terms.length === 0) return true
            const haystack = [card.title, card.content, card.originalText, card.source, card.url, ...(card.tags ?? [])].filter(filled).join(' ').toLowerCase()
            return terms.some(term => haystack.includes(term))
          })
          const text = matched.length === 0
            ? `没有命中的证据卡（共 ${cards.length} 张）。可以放宽条件或 action=add 新建。`
            : `命中 ${matched.length} 张：\n${matched.map(card => `- [${card.id}] ${card.title}｜${card.type}｜可信度 ${card.credibility}/5｜${card.applicableSide}`).join('\n')}`
          return { action: 'search', matched: matched.length, cards: matched, text }
        }
        case 'read': {
          const card = cards.find(item => item.id === args.id)
          if (card === undefined) throw new Error(`找不到证据卡 ${args.id}`)
          return { action: 'read', card, text: JSON.stringify(card, null, 2) }
        }
        case 'update': {
          const index = cards.findIndex(item => item.id === args.id)
          if (index === -1) throw new Error(`找不到证据卡 ${args.id}`)
          if (args.patch === null || typeof args.patch !== 'object' || Array.isArray(args.patch)) throw new Error('action=update 需要 patch 对象')
          cards[index] = makeEvidenceCard({ ...cards[index], ...args.patch, id: cards[index].id, createdAt: cards[index].createdAt }, cards[index])
          commit(workspace, bundle, args.project)
          return { action: 'update', card: cards[index], text: `已更新证据卡「${cards[index].title}」。` }
        }
        case 'delete': {
          const ids = Array.isArray(args.ids) ? args.ids.filter(item => typeof item === 'string') : []
          if (ids.length === 0) throw new Error('action=delete 需要 ids')
          bundle.evidenceCards = cards.filter(card => !ids.includes(card.id))
          bundle.nodeEvidenceLinks = bundle.nodeEvidenceLinks.filter(link => !ids.includes(link.evidenceCardId))
          commit(workspace, bundle, args.project)
          return { action: 'delete', removed: cards.length - bundle.evidenceCards.length, text: `已删除 ${cards.length - bundle.evidenceCards.length} 张证据卡及其挂载关系。` }
        }
        case 'link': {
          if (!filled(args.nodeId) || !filled(args.cardId)) throw new Error('action=link 需要 nodeId 与 cardId')
          const node = requireNode(bundle, args.nodeId)
          const card = cards.find(item => item.id === args.cardId)
          if (card === undefined) throw new Error(`找不到证据卡 ${args.cardId}`)
          const existing = bundle.nodeEvidenceLinks.find(link => link.nodeId === node.id && link.evidenceCardId === card.id)
          if (existing !== undefined) {
            return { action: 'link', link: existing, text: `已经挂过了：${card.title} → ${node.data.label}` }
          }
          const link = makeNodeEvidenceLink({ nodeId: node.id, evidenceCardId: card.id, projectId: bundle.project.id, note: args.note })
          bundle.nodeEvidenceLinks.push(link)
          card.useCount = Number(card.useCount ?? 0) + 1
          const report = commit(workspace, bundle, args.project)
          return { action: 'link', link, readiness: report.readiness, text: `已把证据「${card.title}」挂到节点「${node.data.label}」。就绪度 ${report.readiness}/100。` }
        }
        case 'unlink': {
          const before = bundle.nodeEvidenceLinks.length
          if (filled(args.linkId)) {
            bundle.nodeEvidenceLinks = bundle.nodeEvidenceLinks.filter(link => link.id !== args.linkId)
          } else if (filled(args.nodeId) && filled(args.cardId)) {
            bundle.nodeEvidenceLinks = bundle.nodeEvidenceLinks.filter(link => !(link.nodeId === args.nodeId && link.evidenceCardId === args.cardId))
          } else {
            throw new Error('action=unlink 需要 linkId，或 nodeId + cardId')
          }
          if (bundle.nodeEvidenceLinks.length === before) throw new Error('没有找到要取消的挂载关系')
          commit(workspace, bundle, args.project)
          return { action: 'unlink', removed: before - bundle.nodeEvidenceLinks.length, text: `已取消 ${before - bundle.nodeEvidenceLinks.length} 条挂载关系。` }
        }
        case 'list_linked': {
          if (!filled(args.nodeId)) throw new Error('action=list_linked 需要 nodeId')
          const node = requireNode(bundle, args.nodeId)
          const links = bundle.nodeEvidenceLinks.filter(link => link.nodeId === node.id)
          const text = links.length === 0
            ? `节点「${node.data.label}」还没有挂证据。`
            : `节点「${node.data.label}」挂了 ${links.length} 张：\n${links.map(link => {
                const card = cards.find(item => item.id === link.evidenceCardId)
                return `- [${link.evidenceCardId}] ${card?.title ?? '（卡片已删除）'}${filled(link.note) ? `（${link.note}）` : ''}`
              }).join('\n')}`
          return { action: 'list_linked', links, text }
        }
        default:
          throw new Error(`未知 action：${args.action}`)
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_attack
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_attack',
    description:
      '攻防框（AttackDefenseBox）。每个论证节点一个框，含 attacks[]（type=factual 事实攻击 / logical 逻辑攻击 / value 价值攻击；content 攻击内容；threatLevel 威胁度 1–5；defenseStrategy 防守策略）、mockNotes 模辩笔记、summary 攻防摘要。action=read 读取、set_box 覆盖整框、add_attack 追加一条、update_attack 修改一条、remove_attack 删除一条、set_notes 写模辩笔记/摘要。高威胁（≥4）攻击没有防守策略会被判为 error。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'set_box', 'add_attack', 'update_attack', 'remove_attack', 'set_notes'], description: '要执行的操作。' },
        nodeId: { type: 'string', description: '论证节点 id（除 read 外必填）。' },
        box: { type: 'object', additionalProperties: true, description: 'action=set_box：完整攻防框。' },
        attack: { type: 'object', additionalProperties: true, description: 'action=add_attack/update_attack：攻击对象 {type, content, threatLevel, defenseStrategy}。' },
        attackId: { type: 'string', description: 'action=update_attack/remove_attack：攻击 id。' },
        mockNotes: { type: 'string', description: 'action=set_notes：模辩笔记。' },
        summary: { type: 'string', description: 'action=set_notes：攻防摘要。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const bundle = requireBundle(workspace, args.project)
      const boxes = bundle.attackDefenseBoxes
      const findBox = nodeId => boxes.find(box => box.nodeId === nodeId)
      const attackTypeLabel = type => ({ factual: '事实', logical: '逻辑', value: '价值' }[type] ?? type)
      const formatBox = box => {
        if (box === undefined) return '（还没有攻防框）'
        const lines = [`- 攻击路径 ${box.attacks.length} 条：`]
        for (const attack of box.attacks) {
          lines.push(`  - [${attack.id}] ${attackTypeLabel(attack.type)}｜威胁 ${attack.threatLevel}/5：${attack.content} → ${filled(attack.defenseStrategy) ? attack.defenseStrategy : '〔未写防守〕'}`)
        }
        if (filled(box.summary)) lines.push(`- 摘要：${box.summary}`)
        if (filled(box.mockNotes)) lines.push(`- 模辩笔记：${box.mockNotes}`)
        return lines.join('\n')
      }

      if (args.action === 'read') {
        if (filled(args.nodeId)) {
          const node = requireNode(bundle, args.nodeId)
          const box = findBox(node.id)
          return { action: 'read', box, text: `节点「${node.data.label}」的攻防框：\n${formatBox(box)}` }
        }
        const text = boxes.length === 0 ? '还没有任何攻防框。' : boxes.map(box => {
          const node = (bundle.argumentTree?.nodes ?? []).find(item => item.id === box.nodeId)
          return `- ${node?.data?.label ?? box.nodeId}：${box.attacks.length} 条攻击`
        }).join('\n')
        return { action: 'read', boxes, text }
      }

      if (!filled(args.nodeId)) throw new Error(`action=${args.action} 需要 nodeId`)
      const node = requireNode(bundle, args.nodeId)

      switch (args.action) {
        case 'set_box': {
          if (args.box === null || typeof args.box !== 'object' || Array.isArray(args.box)) throw new Error('action=set_box 需要 box 对象')
          const box = makeAttackDefenseBox({
            ...args.box,
            id: findBox(node.id)?.id,
            nodeId: node.id,
            projectId: bundle.project.id,
            createdAt: findBox(node.id)?.createdAt,
          })
          const index = boxes.findIndex(item => item.nodeId === node.id)
          if (index === -1) boxes.push(box)
          else boxes[index] = box
          const report = commit(workspace, bundle, args.project)
          return { action: 'set_box', box, readiness: report.readiness, text: `已写入「${node.data.label}」的攻防框（${box.attacks.length} 条攻击）。就绪度 ${report.readiness}/100。\n${formatBox(box)}` }
        }
        case 'add_attack': {
          if (args.attack === null || typeof args.attack !== 'object' || Array.isArray(args.attack)) throw new Error('action=add_attack 需要 attack 对象')
          if (!ATTACK_TYPES.includes(args.attack.type)) throw new Error(`attack.type 必须是 ${ATTACK_TYPES.join(' / ')} 之一`)
          if (!filled(args.attack.content)) throw new Error('attack.content 不能为空')
          let box = findBox(node.id)
          if (box === undefined) {
            box = makeAttackDefenseBox({ nodeId: node.id, projectId: bundle.project.id, attacks: [] })
            boxes.push(box)
          }
          const attack = makeAttackPath(args.attack)
          box.attacks.push(attack)
          box.updatedAt = now()
          const report = commit(workspace, bundle, args.project)
          return {
            action: 'add_attack',
            attack,
            readiness: report.readiness,
            text: `已为「${node.data.label}」添加攻击路径 [${attack.id}]（${attackTypeLabel(attack.type)}，威胁 ${attack.threatLevel}/5）。${filled(attack.defenseStrategy) ? '已有防守策略。' : '⚠ 还没写防守策略。'}\n注意：高威胁攻击必须有防守，否则算阻塞缺口。`,
          }
        }
        case 'update_attack': {
          const box = findBox(node.id)
          if (box === undefined) throw new Error(`节点 ${node.id} 还没有攻防框`)
          const index = box.attacks.findIndex(item => item.id === args.attackId)
          if (index === -1) throw new Error(`找不到攻击 ${args.attackId}`)
          box.attacks[index] = makeAttackPath({ ...box.attacks[index], ...(args.attack ?? {}), id: box.attacks[index].id })
          box.updatedAt = now()
          const report = commit(workspace, bundle, args.project)
          return { action: 'update_attack', attack: box.attacks[index], readiness: report.readiness, text: `已更新攻击 ${args.attackId}。就绪度 ${report.readiness}/100。` }
        }
        case 'remove_attack': {
          const box = findBox(node.id)
          if (box === undefined) throw new Error(`节点 ${node.id} 还没有攻防框`)
          const before = box.attacks.length
          box.attacks = box.attacks.filter(item => item.id !== args.attackId)
          if (box.attacks.length === before) throw new Error(`找不到攻击 ${args.attackId}`)
          box.updatedAt = now()
          commit(workspace, bundle, args.project)
          return { action: 'remove_attack', removed: 1, text: `已删除攻击 ${args.attackId}。` }
        }
        case 'set_notes': {
          let box = findBox(node.id)
          if (box === undefined) {
            box = makeAttackDefenseBox({ nodeId: node.id, projectId: bundle.project.id, attacks: [] })
            boxes.push(box)
          }
          if (args.mockNotes !== undefined) {
            const text = trimmed(args.mockNotes)
            if (text === undefined) delete box.mockNotes
            else box.mockNotes = text
          }
          if (args.summary !== undefined) {
            const text = trimmed(args.summary)
            if (text === undefined) delete box.summary
            else box.summary = text
          }
          box.updatedAt = now()
          commit(workspace, bundle, args.project)
          return { action: 'set_notes', box, text: `已更新「${node.data.label}」的攻防笔记。` }
        }
        default:
          throw new Error(`未知 action：${args.action}`)
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_evaluate
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_evaluate',
    description:
      '五维评估与苏格拉底追问。action=analyze 用确定性算法算五维（逻辑性 25% / 证据力 25% / 说服力 20% / 创新性 15% / 抗反驳性 15%）并给出缺口与建议；action=save 把模型自己的判断写成 AIEvaluation 记录（字段 logic/evidence/persuasiveness/innovation/counterResilience/overall/suggestions/priorityFixes/judgeQuestions/nextStepPlan，0–100）；action=read 读最近一次评估；action=questions 扫描薄弱点生成追问候选（missing_child / missing_evidence / logic_conflict）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['analyze', 'save', 'read', 'questions'], description: '要执行的操作。' },
        evaluation: { type: 'object', additionalProperties: true, description: 'action=save：AIEvaluation 主体。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const bundle = requireBundle(workspace, args.project)
      const report = analyze(bundle)

      if (args.action === 'analyze' || args.action === 'read') {
        const text = [
          `五维评估（确定性）：`,
          `- 逻辑性 ${report.scores.logic}/100：${report.notes.logic}`,
          `- 证据力 ${report.scores.evidence}/100：${report.notes.evidence}`,
          `- 说服力 ${report.scores.persuasiveness}/100：${report.notes.persuasiveness}`,
          `- 创新性 ${report.scores.innovation}/100：${report.notes.innovation}`,
          `- 抗反驳性 ${report.scores.counterResilience}/100：${report.notes.counterResilience}`,
          `综合 ${report.scores.overall}/100，就绪度 ${report.readiness}/100，阻塞缺口 ${report.blocking} 项`,
          '',
          '改进建议：',
          ...report.suggestions.map((item, index) => `${index + 1}. ${item}`),
        ].join('\n')
        const saved = Array.isArray(bundle.aiEvaluations) ? bundle.aiEvaluations[0] : undefined
        return { action: args.action, scores: report.scores, readiness: report.readiness, gaps: report.gaps, savedEvaluation: saved, text }
      }

      if (args.action === 'questions') {
        const questions = socraticQuestions(bundle)
        const text = questions.length === 0
          ? '没有发现明显的薄弱点（可能是树还很空，先建树）。'
          : `发现 ${questions.length} 个可追问点：\n${questions.map((item, index) => `${index + 1}. [${item.triggerType}] ${item.question}`).join('\n')}\n\n挑最有价值的一个问用户，不要一次全问。`
        return { action: 'questions', questions, text }
      }

      if (args.evaluation === null || typeof args.evaluation !== 'object' || Array.isArray(args.evaluation)) {
        throw new Error('action=save 需要 evaluation 对象')
      }
      const evaluation = makeAiEvaluation({ ...args.evaluation, projectId: bundle.project.id })
      bundle.aiEvaluations = [evaluation, ...(Array.isArray(bundle.aiEvaluations) ? bundle.aiEvaluations : [])].slice(0, 20)
      commit(workspace, bundle, args.project)
      return {
        action: 'save',
        evaluation,
        text: `已保存评估：综合 ${evaluation.overall}/100（逻辑 ${evaluation.logic} · 证据 ${evaluation.evidence} · 说服 ${evaluation.persuasiveness} · 创新 ${evaluation.innovation} · 抗反驳 ${evaluation.counterResilience}）。\n结构性问题（确定性算法）：${report.blocking} 项阻塞 / ${report.warnings} 项提醒。`,
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_manuscript
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_manuscript',
    description:
      '稿件工具。action=compose 按论证树 + 证据卡 + 拆题结果组装稿件（kind=opening 一辩稿 / closing 结辩稿 / rebuttal 驳论清单），默认保存到 bundle.manuscripts；action=list 列出已有稿件；action=read 读取；action=delete 删除；action=markdown 输出整案归档 Markdown。稿件里的〔待补〕需要继续补写，不要当终稿。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['compose', 'list', 'read', 'delete', 'markdown'], description: '要执行的操作。' },
        kind: { type: 'string', enum: ['opening', 'closing', 'rebuttal'], description: 'action=compose：稿件类型，默认 opening。' },
        title: { type: 'string', description: 'action=compose：稿件标题。' },
        manuscriptId: { type: 'string', description: 'action=read/delete：稿件 id。' },
        save: { type: 'boolean', description: 'action=compose：是否保存进 bundle，默认 true。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const bundle = requireBundle(workspace, args.project)

      if (args.action === 'list') {
        const manuscripts = bundle.manuscripts ?? []
        return {
          action: 'list',
          manuscripts,
          text: manuscripts.length === 0 ? '还没有稿件。' : manuscripts.map(item => `- [${item.id}] ${item.title}（${item.fileName}，${item.fileSize} bytes）`).join('\n'),
        }
      }
      if (args.action === 'read') {
        const manuscript = (bundle.manuscripts ?? []).find(item => item.id === args.manuscriptId)
        if (manuscript === undefined) throw new Error(`找不到稿件 ${args.manuscriptId}`)
        return { action: 'read', manuscript, text: manuscript.content }
      }
      if (args.action === 'delete') {
        const before = (bundle.manuscripts ?? []).length
        bundle.manuscripts = (bundle.manuscripts ?? []).filter(item => item.id !== args.manuscriptId)
        if (bundle.manuscripts.length === before) throw new Error(`找不到稿件 ${args.manuscriptId}`)
        commit(workspace, bundle, args.project)
        return { action: 'delete', removed: 1, text: `已删除稿件 ${args.manuscriptId}。` }
      }
      if (args.action === 'markdown') {
        const report = analyze(bundle)
        const markdown = renderBundleMarkdown(bundle, report)
        const target = path.join(dataDir(workspace), 'export', `case-${Date.now()}.md`)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, markdown, 'utf8')
        return { action: 'markdown', path: target, markdown, text: `整案归档已写入 ${target}\n\n${markdown}` }
      }

      const kind = ['opening', 'closing', 'rebuttal'].includes(args.kind) ? args.kind : 'opening'
      const content = composeManuscript(kind, bundle)
      const pending = (content.match(/〔待补/g) ?? []).length
      if (args.save === false) {
        return { action: 'compose', kind, pending, content, text: `稿件（未保存，待补 ${pending} 处）：\n\n${content}` }
      }
      const manuscript = makeManuscript({
        projectId: bundle.project.id,
        title: filled(args.title) ? args.title : `${kind === 'opening' ? '一辩稿' : kind === 'closing' ? '结辩稿' : '驳论清单'}·${bundle.project.title}`,
        fileName: `${kind}.md`,
        fileType: 'generated',
        content,
      })
      bundle.manuscripts = [manuscript, ...(bundle.manuscripts ?? [])]
      commit(workspace, bundle, args.project)
      return {
        action: 'compose',
        kind,
        pending,
        content,
        manuscript,
        text: `已生成并保存稿件「${manuscript.title}」（待补 ${pending} 处）。\n\n${content}`,
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_bundle
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_bundle',
    description:
      '与 DebateWeaver 的 ProjectExportBundle（format=debateweaver-project, version=1）互通。action=export 把当前项目导出成 bundle JSON（默认 .debate/export/），可直接在 DebateWeaver 里导入；action=import 读入 app 导出的 bundle 文件（path 必填），覆盖当前项目数据；action=validate 校验数据一致性（节点/连线/引用/环）；action=json 直接输出 bundle JSON 文本。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['export', 'import', 'validate', 'json'], description: '要执行的操作。' },
        path: { type: 'string', description: 'action=export：导出目标路径（默认 .debate/export/…）；action=import：要导入的 bundle 文件路径。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)

      if (args.action === 'import') {
        if (!filled(args.path)) throw new Error('action=import 需要 path（app 导出的 .json 文件）')
        const source = path.resolve(workspace, args.path)
        const raw = JSON.parse(fs.readFileSync(source, 'utf8'))
        const bundle = normalizeBundle(raw)
        rememberWorkspace(workspace, bundle)
        saveBundle(workspace, bundle, { project: args.project })
        const report = analyze(bundle)
        return {
          action: 'import',
          workspace,
          project: bundle.project,
          readiness: report.readiness,
          text: `已导入 ${source}\n项目：${bundle.project.title}（${bundle.project.side}）\n节点 ${bundle.argumentTree.nodes.length} · 证据 ${bundle.evidenceCards.length} 张 · 攻防框 ${bundle.attackDefenseBoxes.length} 个 · 稿件 ${bundle.manuscripts.length} 份\n就绪度 ${report.readiness}/100，阻塞缺口 ${report.blocking} 项。`,
        }
      }

      const bundle = requireBundle(workspace, args.project)

      if (args.action === 'validate') {
        const result = validateBundle(bundle)
        const report = analyze(bundle)
        return {
          action: 'validate',
          ok: result.ok,
          errors: result.errors,
          warnings: result.warnings,
          readiness: report.readiness,
          text: `${result.ok ? '数据一致性校验通过。' : `发现 ${result.errors.length} 个错误：`}${result.errors.length === 0 ? '' : `\n${result.errors.map(item => `- ${item.message}`).join('\n')}`}${result.warnings.length === 0 ? '' : `\n提醒 ${result.warnings.length} 项：\n${result.warnings.map(item => `- ${item.message}`).join('\n')}`}`,
        }
      }

      if (args.action === 'json') {
        return { action: 'json', json: JSON.stringify(bundle, null, 2), text: JSON.stringify(bundle, null, 2) }
      }

      const report = analyze(bundle)
      const exportBundle = { ...bundle, exportedAt: now() }
      const target = filled(args.path)
        ? path.resolve(workspace, args.path)
        : path.join(dataDir(workspace), 'export', `debateweaver-${bundle.project.id}-${Date.now()}.json`)
      writeJsonAtomic(target, exportBundle)
      return {
        action: 'export',
        path: target,
        readiness: report.readiness,
        text: `已导出 bundle：${target}\n大小 ${(fs.statSync(target).size / 1024).toFixed(1)} KB，可直接在 DebateWeaver 里导入（format=${exportBundle.format} v${exportBundle.version}）。`,
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_workbench
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_workbench',
    description:
      '工作台界面控制。action=open 在 DSH 右侧栏打开「辩论工作台」标签页（与对话左右并排、列宽可直接拖拽）、action=close 记录收起状态、action=toggle 切换、action=state 读取当前状态、action=set 调整默认标签页。界面由客户端插件读取状态后打开，宿主侧只负责记录。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'close', 'toggle', 'state', 'set'], description: '要执行的操作。' },
        orientation: { type: 'string', enum: ['vertical', 'horizontal'], description: '兼容保留：原生右栏是左右并排，该参数当前不影响界面。' },
        ratio: { type: 'number', description: '兼容保留：列宽请直接在右栏边缘拖拽。' },
        tab: { type: 'string', enum: ['tree', 'evidence', 'attack', 'evaluate', 'manuscript', 'projects'], description: 'action=set：默认标签页。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      if (args.action === 'state') {
        const snapshot = uiSnapshot()
        return {
          action: 'state',
          snapshot,
          text: snapshot.active === true
            ? `工作台${snapshot.ui.open ? '已展开' : '已收起'}：${snapshot.project.title}\n工作区：${snapshot.workspace}\n分屏：${snapshot.ui.orientation === 'vertical' ? '上下' : '左右'} ${Math.round(snapshot.ui.ratio * 100)}%｜标签页：${snapshot.ui.tab}`
            : '当前没有激活的辩论项目。',
        }
      }
      if (args.action === 'open') {
        const bundle = requireBundle(workspace, args.project)
        rememberWorkspace(workspace, bundle)
        const ui = openWorkbench(workspace, args.project)
        const url = options.panel?.url?.()
        return {
          action: 'open',
          ui,
          url,
          text: `工作台已展开：${bundle.project.title}\nDSH 右侧栏会打开「辩论工作台」标签页，与对话左右并排；列宽直接拖拽右栏边缘即可。${url === undefined ? '' : `\n只读调试页：${url}`}`,
        }
      }
      if (args.action === 'close') {
        const ui = closeWorkbench(workspace)
        return { action: 'close', ui, text: '工作台已收起，对话恢复全屏。' }
      }
      if (args.action === 'toggle') {
        if (!projectExists(workspace, args.project)) throw new Error(`${workspace} 里没有辩论项目，无法展开工作台`)
        const current = loadUiState(workspace)
        const ui = current.open ? closeWorkbench(workspace) : openWorkbench(workspace, args.project)
        return { action: 'toggle', ui, text: ui.open ? '工作台已展开。' : '工作台已收起。' }
      }
      // action=set
      if (!projectExists(workspace, args.project)) throw new Error(`${workspace} 里没有辩论项目`)
      const patch = {}
      if (args.orientation === 'vertical' || args.orientation === 'horizontal') patch.orientation = args.orientation
      if (Number.isFinite(Number(args.ratio))) patch.ratio = Number(args.ratio)
      if (filled(args.tab)) patch.tab = args.tab
      const ui = saveUiState(workspace, patch)
      return {
        action: 'set',
        ui,
        text: `工作台界面已更新：${ui.orientation === 'vertical' ? '上下' : '左右'}分栏 ${Math.round(ui.ratio * 100)}%｜标签页 ${ui.tab}${ui.open ? '' : '（当前是收起状态）'}`,
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_task —— 每题备赛待办 + 跨题总览
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_task',
    description:
      '备赛待办。action=add 添加待办（title 必填，可带 deadline=YYYY-MM-DD / nodeId=关联论证节点 / note）；action=list 看当前题目待办；action=update 修改；action=complete 完成；action=delete 删除；action=overview 跨题目总览（每个题目的就绪度 + 未完成待办 + 截止日）。待办保存在题目目录的 tasks.json。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'update', 'complete', 'delete', 'overview'], description: '要执行的操作。' },
        taskId: { type: 'string', description: '任务 id（update/complete/delete 必填）。' },
        title: { type: 'string', description: 'action=add/update：待办标题。' },
        status: { type: 'string', enum: ['todo', 'doing', 'done'], description: 'action=update：状态。' },
        deadline: { type: 'string', description: '截止日期 YYYY-MM-DD（可选）。' },
        nodeId: { type: 'string', description: '关联的论证节点 id（可选）。' },
        note: { type: 'string', description: '备注（可选）。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)

      if (args.action === 'overview') {
        const projects = listProjects(workspace)
        const lines = [`# 跨题目备赛总览（${projects.length} 个题目）`, '']
        const rows = []
        for (const item of projects) {
          const bundle = loadBundle(workspace, item.id)
          const report = bundle === undefined ? undefined : analyze(bundle)
          const tasks = loadTasks(workspace, item.id).tasks
          const open = tasks.filter(task => task.status !== 'done')
          const nextDeadline = open
            .filter(task => filled(task.deadline))
            .map(task => String(task.deadline))
            .sort()[0]
          rows.push({
            projectId: item.id,
            topic: item.topic,
            active: item.active === true,
            readiness: report?.readiness ?? 0,
            nodes: item.stats.nodes,
            evidence: item.stats.evidence,
            openTasks: open.length,
            nextDeadline: nextDeadline ?? null,
          })
          lines.push(
            `- ${item.active === true ? '▶ ' : ''}${item.topic}：就绪度 ${report?.readiness ?? 0}/100 · 节点 ${item.stats.nodes} · 证据 ${item.stats.evidence} · 未完成待办 ${open.length}${nextDeadline === undefined ? '' : `（最近截止 ${nextDeadline}）`}`,
          )
        }
        if (projects.length === 0) lines.push('（暂无题目）')
        return { action: 'overview', workspace, rows, text: lines.join('\n') }
      }

      const entry = resolveProjectEntry(workspace, args.project)
      if (entry === undefined) throw new Error('没有可用的题目：先 debate_project(action=create) 或指定 project')
      const document = loadTasks(workspace, entry.id)
      const tasks = [...document.tasks]

      if (args.action === 'list') {
        return {
          action: 'list',
          projectId: entry.id,
          project: entry.topic,
          tasks,
          text: [`# ${entry.topic} 备赛待办（${tasks.filter(item => item.status !== 'done').length}/${tasks.length} 未完成）`, '', formatTasks(tasks)].join('\n'),
        }
      }
      if (args.action === 'add') {
        if (!filled(args.title)) throw new Error('action=add 需要 title')
        const task = {
          id: newId('task'),
          title: String(args.title).trim(),
          status: 'todo',
          deadline: filled(args.deadline) ? String(args.deadline) : undefined,
          nodeId: filled(args.nodeId) ? String(args.nodeId) : undefined,
          note: filled(args.note) ? String(args.note) : undefined,
          createdAt: now(),
          updatedAt: now(),
        }
        tasks.push(task)
        const saved = saveTasks(workspace, entry.id, tasks)
        return { action: 'add', task, tasks: saved.tasks, text: `已添加待办：${task.title}` }
      }
      const target = tasks.find(item => item.id === args.taskId)
      if (target === undefined) throw new Error(`找不到任务 ${args.taskId}（先 action=list）`)
      if (args.action === 'update') {
        if (filled(args.title)) target.title = String(args.title).trim()
        if (args.status === 'todo' || args.status === 'doing' || args.status === 'done') target.status = args.status
        if (filled(args.deadline)) target.deadline = String(args.deadline)
        if (filled(args.nodeId)) target.nodeId = String(args.nodeId)
        if (filled(args.note)) target.note = String(args.note)
        target.updatedAt = now()
        const saved = saveTasks(workspace, entry.id, tasks)
        return { action: 'update', task: target, tasks: saved.tasks, text: `待办已更新：${target.title}（${target.status}）` }
      }
      if (args.action === 'complete') {
        target.status = 'done'
        target.doneAt = now()
        target.updatedAt = now()
        const saved = saveTasks(workspace, entry.id, tasks)
        return { action: 'complete', task: target, tasks: saved.tasks, text: `已完成：${target.title}` }
      }
      // delete
      const kept = tasks.filter(item => item.id !== args.taskId)
      saveTasks(workspace, entry.id, kept)
      return { action: 'delete', taskId: args.taskId, tasks: kept, text: `已删除待办：${target.title}` }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_library —— 公共证据库（跨题共享）
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_library',
    description:
      '公共证据库（.debate/shared/evidence.json），跨题目共享，供未来证据检索调用。action=add 入库（cards[]，字段同 evidenceCards）；action=list/search 检索（query/tags/type/minCredibility）；action=update 修改；action=delete 删除；action=attach 把共享卡引用到指定题目（复制进该题 evidenceCards 并标记 sharedId，可选 nodeId 直接挂到节点）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'search', 'update', 'delete', 'attach'], description: '要执行的操作。' },
        cards: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'action=add：证据卡数组。' },
        cardId: { type: 'string', description: 'action=update/delete/attach：共享卡 id。' },
        patch: { type: 'object', additionalProperties: true, description: 'action=update：补丁。' },
        query: { type: 'string', description: 'action=search：关键词。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'action=search：标签过滤。' },
        type: { type: 'string', enum: EVIDENCE_TYPES, description: 'action=search：证据类型。' },
        minCredibility: { type: 'integer', description: 'action=search：可信度下限 1-5。' },
        nodeId: { type: 'string', description: 'action=attach：同时挂到该题的这个论证节点。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const libraryPath = sharedLibraryPath(workspace)
      const library = loadSharedLibrary(workspace)

      if (args.action === 'add') {
        if (!Array.isArray(args.cards) || args.cards.length === 0) throw new Error('action=add 需要 cards 数组')
        const created = args.cards.map(input => {
          const card = makeEvidenceCard(input)
          card.sharedId = card.id
          card.projectId = undefined
          return card
        })
        library.cards.push(...created)
        saveSharedLibrary(workspace, library)
        return {
          action: 'add',
          workspace,
          libraryPath,
          cards: created,
          total: library.cards.length,
          text: `已入库 ${created.length} 张共享证据（共 ${library.cards.length} 张）。\n公共库路径：${libraryPath}\n（右栏工作台显示的是当前激活工作区的公共库，确保 workspace 与激活工作区一致）`,
        }
      }

      const matcher = card => {
        const query = filled(args.query) ? String(args.query).trim() : ''
        if (query !== '') {
          const haystack = [card.title, card.content, card.originalText, card.source, ...(card.tags ?? [])].filter(value => typeof value === 'string').join(' ').toLowerCase()
          if (!haystack.includes(query.toLowerCase())) return false
        }
        if (Array.isArray(args.tags) && args.tags.length > 0) {
          const tags = (card.tags ?? []).map(tag => String(tag).toLowerCase())
          if (!args.tags.some(tag => tags.includes(String(tag).toLowerCase()))) return false
        }
        if (filled(args.type) && card.type !== args.type) return false
        if (Number.isFinite(Number(args.minCredibility)) && Number(card.credibility ?? 0) < Number(args.minCredibility)) return false
        return true
      }

      if (args.action === 'list' || args.action === 'search') {
        const cards = library.cards.filter(matcher)
        return {
          action: args.action,
          workspace,
          libraryPath,
          total: cards.length,
          cards,
          text: [`# 公共证据库（命中 ${cards.length}/${library.cards.length}）`, '', ...cards.slice(0, 20).map((card, index) => `${index + 1}. [${card.type}] ${card.title}（可信度 ${card.credibility ?? '-'}）`)].join('\n'),
        }
      }

      if (args.action === 'update') {
        const card = library.cards.find(item => item.id === args.cardId)
        if (card === undefined) throw new Error(`找不到共享证据 ${args.cardId}`)
        const patch = args.patch !== null && typeof args.patch === 'object' ? args.patch : {}
        Object.assign(card, patch, { updatedAt: now() })
        saveSharedLibrary(workspace, library)
        return { action: 'update', workspace, libraryPath, card, text: `共享证据已更新：${card.title}` }
      }

      if (args.action === 'delete') {
        const before = library.cards.length
        library.cards = library.cards.filter(item => item.id !== args.cardId)
        if (library.cards.length === before) throw new Error(`找不到共享证据 ${args.cardId}`)
        saveSharedLibrary(workspace, library)
        return { action: 'delete', workspace, libraryPath, cardId: args.cardId, total: library.cards.length, text: `已删除共享证据（剩余 ${library.cards.length} 张）` }
      }

      // attach
      const shared = library.cards.find(item => item.id === args.cardId)
      if (shared === undefined) throw new Error(`找不到共享证据 ${args.cardId}`)
      const entry = resolveProjectEntry(workspace, args.project)
      if (entry === undefined) throw new Error('action=attach 需要一个目标题目（先 create 或指定 project）')
      const bundle = requireBundle(workspace, entry.id)
      const copy = makeEvidenceCard({ ...shared })
      copy.id = newId('card')
      copy.projectId = entry.id
      copy.sharedId = shared.id
      bundle.evidenceCards = [...(bundle.evidenceCards ?? []), copy]
      if (filled(args.nodeId)) {
        bundle.nodeEvidenceLinks = [
          ...(bundle.nodeEvidenceLinks ?? []),
          makeNodeEvidenceLink({ nodeId: args.nodeId, evidenceCardId: copy.id, projectId: entry.id }),
        ]
      }
      const report = commit(workspace, bundle, entry.id)
      return {
        action: 'attach',
        workspace,
        libraryPath,
        projectId: entry.id,
        card: copy,
        readiness: report.readiness,
        text: `已把共享证据「${shared.title}」引用到题目「${entry.topic}」${filled(args.nodeId) ? `并挂到节点 ${args.nodeId}` : ''}`,
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_ai —— 模型辅助生成（内置模型优先，结果默认只出候选）
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_ai',
    description:
      '模型辅助生成。默认使用 DSH 内置模型（跟随 agentDefaultModel，如 deepseek-account/deepseek-flash），也可由插件配置 ai.provider=openai-compatible 外接。action=status 查看当前路由与可用性；action=decompose 生成拆题候选（只返回候选，不落库）；action=attacks 对指定节点生成三类攻防候选（同样只返回候选，写库交给 debate_plan(action=fill_attacks)）；action=apply 把拆题候选写入拆题结果。硬约束：模型不得编造证据/数据/年份/机构，未确认前一律以候选形式呈现。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'decompose', 'apply', 'attacks'], description: '要执行的操作。' },
        nodeIds: { type: 'array', items: { type: 'string' }, description: 'action=attacks：要生成攻防预判的节点 id（省略时自动挑选还没有攻防框的论点类节点）。' },
        hint: { type: 'string', description: 'action=decompose：补充要求（如「重点做价值比较」「注意政策辩可行性」）。' },
        candidate: { type: 'object', additionalProperties: true, description: 'action=apply：要写入的拆题候选对象。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)

      if (args.action === 'status') {
        const status = aiStatus(ctx, pluginConfig)
        const text = status.available
          ? `模型路由可用：${status.mode} · ${status.provider} / ${status.model}${status.reasoningEffort === undefined ? '' : `（reasoning ${status.reasoningEffort}）`}\n${status.hint}`
          : `模型暂不可用：${status.reason}\n${status.hint}`
        return { action: 'status', workspace, status, text }
      }

      if (args.action === 'attacks') {
        const route = resolveAiRoute(ctx, pluginConfig)
        if (!route.available) throw new Error(`模型不可用：${route.reason}`)
        const bundle = requireBundle(workspace, args.project)
        const boxes = bundle.attackDefenseBoxes ?? []
        const explicitIds = Array.isArray(args.nodeIds) ? args.nodeIds.filter(id => typeof id === 'string' && id !== '') : []
        const candidates = bundle.argumentTree.nodes.filter(node => {
          if (explicitIds.length > 0) return explicitIds.includes(node.id)
          if (!['claim', 'premise', 'compare', 'attitude'].includes(node.type)) return false
          return !boxes.some(box => box.nodeId === node.id && (box.attacks ?? []).length > 0)
        })
        const targets = candidates.slice(0, 8).map(node => ({ id: node.id, type: node.type, label: String(node.data?.label ?? '') }))
        if (targets.length === 0) throw new Error('没有需要生成攻防预判的节点（可用 nodeIds 指定；或先建好论点节点）')
        const { system, prompt } = buildAttacksPrompt(bundle, targets)
        let generated
        try {
          generated = await generateJson(ctx, pluginConfig, { system, prompt, signal: exec?.signal, sessionId: exec?.agent?.id })
        } catch (error) {
          throw new Error(`AI 生成失败：${error instanceof Error ? error.message : String(error)}`)
        }
        const validIds = new Set(bundle.argumentTree.nodes.map(node => node.id))
        const normalized = normalizeAttackCandidate(generated.json, validIds)
        if (normalized.attacks.length === 0) throw new Error(`AI 没有返回可用的攻防候选（丢弃 ${normalized.dropped.length} 条）`)
        return {
          action: 'attacks',
          applied: false,
          project: bundle.project,
          route: generated.raw.route,
          usage: generated.raw.usage,
          targets,
          attacks: normalized.attacks,
          dropped: normalized.dropped,
          text: [
            `攻防候选（未落库）：${normalized.attacks.length} 条，覆盖 ${targets.length} 个节点${normalized.dropped.length > 0 ? `，丢弃 ${normalized.dropped.length} 条` : ''}。`,
            '',
            ...normalized.attacks.map(item => {
              const node = targets.find(target => target.id === item.nodeId)
              return `- [${item.type}] ${node?.label ?? item.nodeId}｜威胁 ${item.threatLevel}/5：${item.content}${item.defenseStrategy ? `｜防守：${item.defenseStrategy}` : ''}`
            }),
            '',
            '确认后调用 debate_plan(action=fill_attacks, attacks=这条返回的 attacks, apply=true) 写入。',
          ].join('\n'),
        }
      }

      if (args.action === 'decompose') {
        const route = resolveAiRoute(ctx, pluginConfig)
        if (!route.available) throw new Error(`模型不可用：${route.reason}`)
        const bundle = requireBundle(workspace, args.project)
        const { system, prompt } = buildDecomposePrompt(bundle, { hint: args.hint })
        let generated
        try {
          generated = await generateJson(ctx, pluginConfig, {
            system,
            prompt,
            signal: exec?.signal,
            sessionId: exec?.agent?.id,
          })
        } catch (error) {
          throw new Error(`AI 生成失败：${error instanceof Error ? error.message : String(error)}`)
        }
        const candidate = normalizeDecomposeCandidate(generated.json)
        const hasContent =
          candidate.judgeQuestion !== '' ||
          candidate.coreConcepts.length > 0 ||
          candidate.controversialPoints.length > 0 ||
          candidate.battlefields.length > 0
        if (!hasContent) throw new Error('AI 返回的拆题结果为空或结构不符（缺少 judgeQuestion/核心概念/争议点/战场）')
        return {
          action: 'decompose',
          applied: false,
          project: bundle.project,
          route: generated.raw.route,
          usage: generated.raw.usage,
          candidate,
          text: [`模型：${generated.raw.route.provider} / ${generated.raw.route.model}`, '', formatDecomposeCandidate(candidate)].join('\n'),
        }
      }

      // action=apply
      const candidateInput = args.candidate !== null && typeof args.candidate === 'object' && !Array.isArray(args.candidate) ? args.candidate : undefined
      if (candidateInput === undefined) throw new Error('action=apply 需要 candidate（action=decompose 的返回对象）')
      const candidate = normalizeDecomposeCandidate(candidateInput)
      const usable =
        candidate.judgeQuestion !== '' ||
        candidate.coreConcepts.length > 0 ||
        candidate.controversialPoints.length > 0 ||
        candidate.battlefields.length > 0 ||
        candidate.argumentPaths.length > 0
      if (!usable) throw new Error('候选内容为空，未写入。请先 action=decompose 生成候选，或检查候选字段')
      const bundle = requireBundle(workspace, args.project)
      const decomposition = {
        ...candidate,
        id: newId('decomposition'),
        projectId: bundle.project.id,
        createdAt: now(),
        source: 'debate_ai',
        promptVersion: 'decompose-v1',
      }
      bundle.decompositionResults = [decomposition]
      const report = commit(workspace, bundle, args.project)
      const topicGaps = report.gaps.filter(item => item.code.startsWith('D_'))
      return {
        action: 'apply',
        applied: true,
        projectId: bundle.project.id,
        decomposition,
        readiness: report.readiness,
        gaps: topicGaps,
        text: [`已写入拆题结果（${decomposition.coreConcepts.length} 个概念 / ${decomposition.controversialPoints.length} 个争议点 / ${decomposition.battlefields.length} 个战场）。`, '', '拆题缺口：', formatGaps(topicGaps, 8), '', `整案就绪度：${report.readiness}/100`].join('\n'),
      }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_context —— 只读上下文（摘要 / 大纲 / 跨库证据检索）
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_context',
    description:
      '只读上下文工具（不写任何数据）。action=digest 返回紧凑摘要：题目、就绪度/五维、拆题要点、论证树大纲、证据索引、攻防统计、未完成待办、最该补的缺口；action=outline 只返回论证树大纲；action=search_evidence 跨「本题证据 + 公共证据库」检索可用证据（query/tags/type/minCredibility）。用它代替整包读取，能显著减少上下文膨胀。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['digest', 'outline', 'search_evidence'], description: '要执行的操作。' },
        query: { type: 'string', description: 'action=search_evidence：关键词（空格/逗号分隔）。' },
        tags: { type: 'array', items: { type: 'string' }, description: 'action=search_evidence：标签过滤。' },
        type: { type: 'string', enum: EVIDENCE_TYPES, description: 'action=search_evidence：证据类型过滤。' },
        minCredibility: { type: 'integer', description: 'action=search_evidence：可信度下限 1–5。' },
        limit: { type: 'integer', description: '最多返回条数（默认 12）。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const bundle = requireBundle(workspace, args.project)
      const limit = clampInt(args.limit, 1, 50, 12)
      const nodes = bundle.argumentTree.nodes

      const buildOutline = () => {
        const index = treeIndex(bundle)
        const rows = []
        const walk = (id, depth) => {
          if (rows.length >= 40) return
          const node = index.byId.get(id)
          if (node === undefined) return
          rows.push({ id: node.id, type: node.type, label: String(node.data?.label ?? ''), depth })
          for (const childId of index.children.get(id) ?? []) walk(childId, depth + 1)
        }
        for (const root of index.roots) walk(root.id, 0)
        const lines = rows.map(row => `${'  '.repeat(row.depth)}- [${row.type}] ${row.label.length > 30 ? `${row.label.slice(0, 30)}…` : row.label}（${row.id}）`)
        return { rows, lines, maxDepth: rows.reduce((max, row) => Math.max(max, row.depth), 0) }
      }

      if (args.action === 'outline') {
        const outline = buildOutline()
        return {
          action: 'outline',
          project: bundle.project,
          outline: outline.rows,
          text: [`# ${bundle.project.title} 论证树大纲（${nodes.length} 节点 / 深度 ${outline.maxDepth}）`, '', ...(outline.lines.length === 0 ? ['（空树）'] : outline.lines)].join('\n'),
        }
      }

      if (args.action === 'search_evidence') {
        const terms = typeof args.query === 'string' ? args.query.toLowerCase().split(/[\s,，、;；/]+/).filter(Boolean) : []
        const tags = Array.isArray(args.tags) ? args.tags.map(tag => String(tag).toLowerCase()) : []
        const minCredibility = clampInt(args.minCredibility, 0, 5, 0)
        const match = card => {
          if (typeof args.type === 'string' && card.type !== args.type) return false
          if (minCredibility > 0 && Number(card.credibility) < minCredibility) return false
          if (tags.length > 0) {
            const cardTags = (card.tags ?? []).map(tag => String(tag).toLowerCase())
            if (!tags.some(tag => cardTags.includes(tag))) return false
          }
          if (terms.length === 0) return true
          const haystack = [card.title, card.content, card.originalText, card.source, card.url, ...(card.tags ?? [])].filter(filled).join(' ').toLowerCase()
          return terms.some(term => haystack.includes(term))
        }
        const linkCount = cardId => (bundle.nodeEvidenceLinks ?? []).filter(link => link.evidenceCardId === cardId).length
        const projectHits = (bundle.evidenceCards ?? []).filter(match).slice(0, limit).map(card => ({
          id: card.id,
          title: card.title,
          type: card.type,
          credibility: card.credibility,
          source: card.source ?? card.url ?? '',
          linked: linkCount(card.id),
          sharedId: card.sharedId,
        }))
        const sharedHits = loadSharedLibrary(workspace).cards.filter(match).slice(0, limit).map(card => ({
          id: card.id,
          title: card.title,
          type: card.type,
          credibility: card.credibility,
          source: card.source ?? card.url ?? '',
          tags: card.tags ?? [],
        }))
        return {
          action: 'search_evidence',
          project: bundle.project,
          projectHits,
          sharedHits,
          text: [
            `# 证据检索（本题命中 ${projectHits.length} / 公共库命中 ${sharedHits.length}）`,
            '',
            '本题证据：',
            ...(projectHits.length === 0 ? ['（无）'] : projectHits.map(card => `- [${card.id}] ${card.title}｜${card.type}｜可信度 ${card.credibility}/5｜已挂载 ${card.linked}${card.sharedId ? '｜来自公共库' : ''}`)),
            '',
            '公共证据库：',
            ...(sharedHits.length === 0 ? ['（无）'] : sharedHits.map(card => `- [${card.id}] ${card.title}｜${card.type}｜可信度 ${card.credibility}/5（用 debate_library action=attach 引用）`)),
          ].join('\n'),
        }
      }

      // digest
      const report = analyze(bundle)
      const outline = buildOutline()
      const decomposition = Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined
      const tasks = loadTasks(workspace, bundle.project.id).tasks
      const openTasks = tasks.filter(item => item.status !== 'done')
      const boxes = bundle.attackDefenseBoxes ?? []
      const attackCounts = { factual: 0, logical: 0, value: 0 }
      for (const box of boxes) for (const attack of box.attacks ?? []) if (attack.type in attackCounts) attackCounts[attack.type] += 1
      const linkedCardIds = new Set((bundle.nodeEvidenceLinks ?? []).map(link => link.evidenceCardId))
      const digest = {
        project: { id: bundle.project.id, title: bundle.project.title, side: bundle.project.side, format: bundle.project.format },
        readiness: report.readiness,
        scores: report.scores,
        blocking: report.blocking,
        warnings: report.warnings,
        decomposition:
          decomposition === undefined
            ? undefined
            : {
                judgeQuestion: decomposition.judgeQuestion ?? '',
                concepts: (decomposition.coreConcepts ?? []).map(item => item.term),
                issues: (decomposition.controversialPoints ?? []).map(item => item.issue),
                battlefields: (decomposition.battlefields ?? []).map(item => ({ battlefield: item.battlefield, priority: item.priority })),
                criteria: (decomposition.comparisonFramework?.criteria ?? []).map(item => item.dimension),
              },
        tree: { nodes: nodes.length, edges: bundle.argumentTree.edges.length, maxDepth: outline.maxDepth, outline: outline.rows },
        evidence: {
          total: (bundle.evidenceCards ?? []).length,
          linkedCards: linkedCardIds.size,
          cards: (bundle.evidenceCards ?? []).slice(0, 10).map(card => ({ id: card.id, title: card.title, type: card.type, credibility: card.credibility, linked: linkedCardIds.has(card.id) })),
        },
        attacks: { boxes: boxes.length, byType: attackCounts, nodesWithoutBox: nodes.filter(node => ['claim', 'premise', 'compare'].includes(node.type) && !boxes.some(box => box.nodeId === node.id)).length },
        tasks: { total: tasks.length, open: openTasks.length, nextDeadline: openTasks.filter(item => filled(item.deadline)).map(item => item.deadline).sort()[0] ?? null },
        gaps: report.gaps.slice(0, 8),
      }
      const text = [
        `# ${digest.project.title}（${digest.project.side === 'pro' ? '正方' : '反方'} · ${digest.project.format}）`,
        `就绪度 ${report.readiness}/100　阻塞 ${report.blocking} / 提醒 ${report.warnings}`,
        `五维：逻辑 ${report.scores.logic} · 证据 ${report.scores.evidence} · 说服 ${report.scores.persuasiveness} · 创新 ${report.scores.innovation} · 抗反驳 ${report.scores.counterResilience}`,
        decomposition === undefined ? '拆题：尚未保存（可用 debate_ai action=decompose 生成候选）' : `拆题：${(decomposition.coreConcepts ?? []).length} 概念 / ${(decomposition.controversialPoints ?? []).length} 争议点 / ${(decomposition.battlefields ?? []).length} 战场`,
        `论证树：${nodes.length} 节点 / ${bundle.argumentTree.edges.length} 连线（深度 ${outline.maxDepth}）`,
        `证据：${digest.evidence.total} 张（已挂载 ${digest.evidence.linkedCards}）　攻防框：${boxes.length} 个（${nodes.filter(node => ['claim', 'premise', 'compare'].includes(node.type) && !boxes.some(box => box.nodeId === node.id)).length} 个论点还没攻防）`,
        `待办：未完成 ${openTasks.length}/${tasks.length}${digest.tasks.nextDeadline === null ? '' : `（最近截止 ${digest.tasks.nextDeadline}）`}`,
        '',
        '最该补的缺口：',
        formatGaps(report.gaps, 6),
        '',
        '树大纲：',
        ...(outline.lines.length === 0 ? ['（空树）'] : outline.lines.slice(0, 20)),
      ].join('\n')
      return { action: 'digest', project: bundle.project, digest, text }
    },
  })

  /* ------------------------------------------------------------------ *
   * debate_plan —— 批量编排（默认 dryRun）
   * ------------------------------------------------------------------ */
  registry.register({
    name: 'debate_plan',
    description:
      '批量编排工具（默认 dryRun，只返回计划；apply=true 才写入）。action=build_tree 依据拆题结果批量建论证树（立场→论点→前提，自动连线与排版）；action=fill_attacks 批量写攻防框（威胁度 ≥4 必须给防守策略，否则拒绝）。配合 debate_ai(action=decompose/attacks) 的候选结果使用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['build_tree', 'fill_attacks'], description: '要执行的操作。' },
        apply: { type: 'boolean', description: '是否真正写入（默认 false，只返回计划）。' },
        mode: { type: 'string', enum: ['merge', 'replace'], description: 'action=build_tree：merge 合并到现有树（默认，跳过重名节点）；replace 先清空现有节点再重建。' },
        claims: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'action=build_tree：可选的论点列表 [{mainClaim, supportingPoints[]}]，省略时用拆题结果的 argumentPaths。' },
        attacks: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'action=fill_attacks：攻击列表 [{nodeId, type, content, threatLevel, defenseStrategy}]。' },
        ...WORKSPACE_PARAM,
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: LOOSE, render: (_args, value) => textBlock(value?.text ?? '') },
    async execute(args, exec) {
      const workspace = resolveWorkspace(exec, args.workspace)
      const bundle = requireBundle(workspace, args.project)
      const applyChanges = args.apply === true
      const normalizeLabel = value => String(value ?? '').replace(/\s+/g, '').toLowerCase()

      if (args.action === 'build_tree') {
        const mode = args.mode === 'replace' ? 'replace' : 'merge'
        const decomposition = Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined
        let claims = []
        if (Array.isArray(args.claims) && args.claims.length > 0) {
          claims = args.claims
            .filter(item => item !== null && typeof item === 'object')
            .map(item => ({
              mainClaim: String(item.mainClaim ?? item.label ?? '').trim(),
              supportingPoints: Array.isArray(item.supportingPoints) ? item.supportingPoints.map(point => String(point).trim()).filter(Boolean) : [],
            }))
        } else if (decomposition?.argumentPaths?.length) {
          const ours = decomposition.argumentPaths.filter(item => (item.side === 'con' ? 'con' : 'pro') === bundle.project.side)
          const source = ours.length > 0 ? ours : decomposition.argumentPaths
          claims = source.map(item => ({
            mainClaim: String(item.mainClaim ?? '').trim(),
            supportingPoints: (item.supportingPoints ?? []).map(point => String(point).trim()).filter(Boolean),
          }))
        } else if (decomposition?.controversialPoints?.length) {
          claims = decomposition.controversialPoints.map(item => ({ mainClaim: String(item.issue ?? '').trim(), supportingPoints: [] }))
        }
        claims = claims.filter(item => item.mainClaim !== '').slice(0, 6)
        if (claims.length === 0) throw new Error('build_tree 需要拆题结果（argumentPaths/controversialPoints）或显式 claims；可先 debate_ai(action=decompose) 生成拆题')

        const existing = bundle.argumentTree.nodes
        const existingLabels = new Set(existing.map(node => normalizeLabel(node.data?.label)))
        const stance = existing.find(node => node.type === 'stance')
        const planNodes = []
        const skipped = []
        const claimPlans = []
        for (const claim of claims) {
          const claimLabel = claim.mainClaim
          const claimExists = existingLabels.has(normalizeLabel(claimLabel))
          if (claimExists && mode === 'merge') skipped.push(`论点已存在，跳过：${claimLabel}`)
          else {
            existingLabels.add(normalizeLabel(claimLabel))
            planNodes.push({ type: 'claim', label: claimLabel, parent: 'stance' })
          }
          const supportPlans = []
          for (const support of claim.supportingPoints.slice(0, 5)) {
            if (existingLabels.has(normalizeLabel(support))) {
              skipped.push(`支撑点已存在，跳过：${support}`)
              continue
            }
            existingLabels.add(normalizeLabel(support))
            planNodes.push({ type: 'premise', label: support, parent: 'claim:' + claimLabel })
            supportPlans.push(support)
          }
          claimPlans.push({ claim: claimLabel, supports: supportPlans })
        }
        const plan = {
          mode,
          apply: applyChanges,
          removed: mode === 'replace' ? existing.length : 0,
          stance: stance === undefined ? `我方立场：${bundle.project.title}` : stance.data?.label,
          nodes: planNodes,
          claims: claimPlans,
          skipped,
        }
        if (!applyChanges) {
          return {
            action: 'build_tree',
            ...plan,
            text: [
              `搭树计划（dryRun，尚未写入）：${mode === 'replace' ? `先清空现有 ${existing.length} 个节点，然后` : ''}新增 ${planNodes.length} 个节点${plan.stance === undefined ? '' : `（立场：${plan.stance}）`}。`,
              ...planNodes.map(item => `- [${item.type}] ${item.label}${item.parent === 'stance' ? '' : `（挂在 ${item.parent.replace('claim:', '')} 下）`}`),
              ...(skipped.length > 0 ? ['', '跳过：', ...skipped.slice(0, 8).map(line => `- ${line}`)] : []),
              '',
              '确认无误后调用 action=build_tree, apply=true 写入。',
            ].join('\n'),
          }
        }
        if (mode === 'replace') {
          bundle.argumentTree.nodes = []
          bundle.argumentTree.edges = []
          bundle.attackDefenseBoxes = []
          bundle.nodeEvidenceLinks = []
        }
        const findByName = label => bundle.argumentTree.nodes.find(node => normalizeLabel(node.data?.label) === normalizeLabel(label))
        let stanceNode = bundle.argumentTree.nodes.find(node => node.type === 'stance')
        if (stanceNode === undefined) {
          stanceNode = makeNode({ type: 'stance', data: { label: `我方立场：${bundle.project.title}` }, position: { x: 0, y: 0 } })
          bundle.argumentTree.nodes.push(stanceNode)
        }
        let created = 0
        let edges = 0
        const rowIndex = bundle.argumentTree.nodes.length
        let cursor = rowIndex
        for (const claim of claims) {
          let claimNode = findByName(claim.mainClaim)
          if (claimNode === undefined) {
            claimNode = makeNode({ type: 'claim', data: { label: claim.mainClaim }, position: { x: 300, y: cursor * 140 } })
            bundle.argumentTree.nodes.push(claimNode)
            created += 1
          }
          if (!bundle.argumentTree.edges.some(edge => edge.source === stanceNode.id && edge.target === claimNode.id)) {
            bundle.argumentTree.edges.push(makeEdge(stanceNode.id, claimNode.id))
            edges += 1
          }
          for (const support of claim.supportingPoints.slice(0, 5)) {
            let supportNode = findByName(support)
            if (supportNode === undefined) {
              supportNode = makeNode({ type: 'premise', data: { label: support }, position: { x: 600, y: cursor * 140 } })
              bundle.argumentTree.nodes.push(supportNode)
              created += 1
            }
            if (!bundle.argumentTree.edges.some(edge => edge.source === claimNode.id && edge.target === supportNode.id)) {
              bundle.argumentTree.edges.push(makeEdge(claimNode.id, supportNode.id))
              edges += 1
            }
            cursor += 1
          }
        }
        autoLayout(bundle, {})
        const report = commit(workspace, bundle, args.project)
        return {
          action: 'build_tree',
          apply: true,
          created,
          edges,
          nodes: bundle.argumentTree.nodes.length,
          readiness: report.readiness,
          text: `已搭树：新增 ${created} 个节点、${edges} 条连线（现有 ${bundle.argumentTree.nodes.length} 节点），并已自动排版。就绪度 ${report.readiness}/100。`,
        }
      }

      // fill_attacks
      const attacks = Array.isArray(args.attacks) ? args.attacks : []
      if (attacks.length === 0) throw new Error('fill_attacks 需要 attacks 数组（可用 debate_ai action=attacks 生成候选）')
      const nodes = bundle.argumentTree.nodes
      const valid = []
      const errors = []
      for (const item of attacks) {
        if (item === null || typeof item !== 'object') continue
        const nodeId = String(item.nodeId ?? '')
        const node = nodes.find(entry => entry.id === nodeId)
        if (node === undefined) {
          errors.push({ nodeId, reason: '节点不存在' })
          continue
        }
        const type = ATTACK_TYPES.includes(item.type) ? item.type : undefined
        if (type === undefined) {
          errors.push({ nodeId, reason: '攻击类型非法（factual/logical/value）' })
          continue
        }
        const content = String(item.content ?? '').trim()
        if (content === '') {
          errors.push({ nodeId, reason: '攻击内容为空' })
          continue
        }
        const threatLevel = clampInt(item.threatLevel, 1, 5, 3)
        const defenseStrategy = String(item.defenseStrategy ?? '').trim()
        if (threatLevel >= 4 && defenseStrategy === '') {
          errors.push({ nodeId, reason: '威胁度 ≥4 缺少防守策略（硬规则）' })
          continue
        }
        valid.push({ nodeId, nodeLabel: String(node.data?.label ?? ''), type, content, threatLevel, defenseStrategy })
      }
      const plan = valid.map(item => ({ ...item, hasBox: (bundle.attackDefenseBoxes ?? []).some(box => box.nodeId === item.nodeId) }))
      if (!applyChanges) {
        return {
          action: 'fill_attacks',
          apply: false,
          wouldAppend: plan.length,
          plan,
          errors,
          text: [
            `攻防写入计划（dryRun）：将追加 ${plan.length} 条攻击${errors.length > 0 ? `，另有 ${errors.length} 条无效被拒绝` : ''}。`,
            ...plan.map(item => `- [${item.type}] ${item.nodeLabel}｜威胁 ${item.threatLevel}/5${item.defenseStrategy ? '｜有防守' : ''}`),
            ...(errors.length > 0 ? ['', '被拒绝：', ...errors.map(item => `- ${item.reason}`)] : []),
            '',
            '确认无误后调用 action=fill_attacks, apply=true 写入。',
          ].join('\n'),
        }
      }
      if (errors.length > 0) throw new Error(`有 ${errors.length} 条攻击无效，未写入：${errors.map(item => item.reason).join('；')}`)
      let appended = 0
      let createdBoxes = 0
      for (const item of valid) {
        let box = (bundle.attackDefenseBoxes ?? []).find(entry => entry.nodeId === item.nodeId)
        if (box === undefined) {
          box = makeAttackDefenseBox({ nodeId: item.nodeId, projectId: bundle.project.id, attacks: [] })
          bundle.attackDefenseBoxes = [...(bundle.attackDefenseBoxes ?? []), box]
          createdBoxes += 1
        }
        box.attacks = [...(box.attacks ?? []), makeAttackPath(item)]
        appended += 1
      }
      const report = commit(workspace, bundle, args.project)
      return {
        action: 'fill_attacks',
        apply: true,
        appended,
        createdBoxes,
        readiness: report.readiness,
        text: `已写入 ${appended} 条攻击（新建攻防框 ${createdBoxes} 个）。就绪度 ${report.readiness}/100。`,
      }
    },
  })

  return definitions
}
