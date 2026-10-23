/**
 * 辩论备赛工作台 —— 数据模型层。
 *
 * **唯一事实来源是 DebateWeaver 的 `ProjectExportBundle`**
 * （见 `app/src/types/index.ts`：`format: 'debateweaver-project'`, `version: 1`）。
 * 本插件不发明第二套模型：所有写入都产出可被 app 直接导入的 bundle，
 * 导入时保留未知字段，避免往返一次丢数据。
 *
 * bundle 根结构：
 *   { format, version, exportedAt, project, argumentTree,
 *     attackDefenseBoxes[], nodeEvidenceLinks[], evidenceCards[],
 *     manuscripts[], aiQuestions[], aiEvaluations[], decompositionResults[] }
 *
 * @module dsh-debate-workbench/model
 */
import { randomUUID } from 'node:crypto'

/** bundle 格式标记，必须与 app 的导出格式一致。 */
export const BUNDLE_FORMAT = 'debateweaver-project'
/** bundle 版本。 */
export const BUNDLE_VERSION = 1
/** 工作区内承载工作台数据的目录名。 */
export const DATA_DIR = '.debate'
/** 主数据文件名（完整 bundle）。 */
export const BUNDLE_FILE = 'project.bundle.json'
/** UI 状态文件名（激活项目、分屏设置）。 */
export const UI_FILE = 'ui.json'

/** 9 种论证节点类型及其展示配置（与 app 的 NODE_TYPE_CONFIGS 对齐）。 */
export const NODE_TYPE_CONFIGS = [
  { type: 'stance', label: '立场', icon: 'P', color: '#FFD60A', shape: 'rect', description: '论证树根节点：辩题持方与立场声明。' },
  { type: 'status', label: '现状', icon: 'S', color: '#34C759', shape: 'pill', description: '现状、背景事实或问题起点。' },
  { type: 'crowd', label: '主体', icon: 'C', color: '#8A80FF', shape: 'pill', description: '利益相关方或受影响群体。' },
  { type: 'premise', label: '前提', icon: 'A', color: '#FF9500', shape: 'diamond', description: '隐含假设、逻辑前提或必要条件。' },
  { type: 'claim', label: '论点', icon: 'L', color: '#0A84FF', shape: 'pill', description: '主张、分论点或论证结论。' },
  { type: 'evidence', label: '证据', icon: 'E', color: '#34C759', shape: 'rect', description: '挂载证据卡、来源摘录或引用材料。' },
  { type: 'compare', label: '比较', icon: 'V', color: '#FF453A', shape: 'diamond', description: '权衡、比较或优先级判断。' },
  { type: 'attitude', label: '价值', icon: 'T', color: '#BF5AF2', shape: 'circle', description: '价值判断、原则或立场取向。' },
  { type: 'image', label: '图片', icon: 'I', color: '#FF9500', shape: 'rect', description: '展示图片资料。' },
]

/** 节点类型取值集合。 */
export const NODE_TYPES = NODE_TYPE_CONFIGS.map(item => item.type)

/** 五维评估维度与权重（与 app 的 EVALUATION_DIMENSIONS 对齐）。 */
export const EVALUATION_DIMENSIONS = [
  { key: 'logic', label: '逻辑性', weight: 0.25 },
  { key: 'evidence', label: '证据力', weight: 0.25 },
  { key: 'persuasiveness', label: '说服力', weight: 0.2 },
  { key: 'innovation', label: '创新性', weight: 0.15 },
  { key: 'counterResilience', label: '抗反驳性', weight: 0.15 },
]

/** 攻击类型。 */
export const ATTACK_TYPES = ['factual', 'logical', 'value']
/** 证据类型。 */
export const EVIDENCE_TYPES = ['data', 'case', 'theory']
/** 证据状态。 */
export const EVIDENCE_STATUSES = ['draft', 'pending', 'approved', 'rejected']
/** 适用方向。 */
export const APPLICABLE_SIDES = ['pro', 'con', 'both']
/** 赛制。 */
export const DEBATE_FORMATS = ['chinese', 'british', 'australian']
/** 稿件文件类型。 */
export const MANUSCRIPT_TYPES = ['md', 'docx', 'csv', 'txt', 'image', 'generated']
/** 苏格拉底追问触发类型。 */
export const QUESTION_TRIGGERS = ['missing_child', 'missing_evidence', 'logic_conflict', 'manual']

/** 当前时间 ISO 串。 */
export function now() {
  return new Date().toISOString()
}

/** 新 ID（与 app 的 uuid 习惯一致，带类型前缀方便人类阅读）。 */
export function newId(prefix) {
  return `${prefix}-${randomUUID()}`
}

/** 深拷贝纯 JSON。 */
export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** 非空字符串。 */
export function filled(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 去空白；空串归一为 undefined。 */
export function trimmed(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/** 数字裁剪。 */
export function clampNumber(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/** 取整并裁剪（威胁度/可信度这类 1–5 整数）。 */
export function clampInt(value, min, max, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(num)))
}

/** 字符串数组归一（去空白、去重）。 */
export function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = trimmed(item)
    if (text !== undefined && !out.includes(text)) out.push(text)
  }
  return out
}

/** 归一立场。 */
export function normalizeSide(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['pro', '正', '正方', 'affirmative', 'aff'].includes(text)) return 'pro'
  if (['con', '反', '反方', 'negative', 'neg'].includes(text)) return 'con'
  return undefined
}

/** 归一赛制。 */
export function normalizeFormat(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (['chinese', '华语', '中文', 'cda'].includes(text)) return 'chinese'
  if (['british', 'bp', '英式'].includes(text)) return 'british'
  if (['australian', '澳式'].includes(text)) return 'australian'
  return undefined
}

/**
 * 新建一个空 bundle。
 *
 * @param {{ title: string, side: string, format?: string }} input 项目元信息
 * @returns {any} 可直接写盘的 ProjectExportBundle
 */
export function makeBundle(input) {
  const timestamp = now()
  const projectId = newId('project')
  const treeId = newId('tree')
  const side = normalizeSide(input.side) ?? 'pro'
  const project = {
    id: projectId,
    title: input.title.trim(),
    side,
    format: normalizeFormat(input.format) ?? 'chinese',
    status: 'active',
    createdAt: timestamp,
    updatedAt: timestamp,
    argumentTreeId: treeId,
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: timestamp,
    project,
    argumentTree: { id: treeId, projectId, nodes: [], edges: [], createdAt: timestamp, updatedAt: timestamp },
    attackDefenseBoxes: [],
    nodeEvidenceLinks: [],
    evidenceCards: [],
    manuscripts: [],
    aiQuestions: [],
    aiEvaluations: [],
    decompositionResults: [],
  }
}

/**
 * 归一任意来源的 bundle：补默认值、丢弃类型错误的集合，但**保留未知字段**，
 * 保证「导入 → 编辑 → 导出」不丢 app 侧新增数据。
 *
 * @param {unknown} raw 解析后的 JSON
 * @returns {any} 归一后的 bundle
 */
export function normalizeBundle(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('bundle 必须是对象')
  }
  const input = raw
  if (input.format !== BUNDLE_FORMAT) {
    throw new Error(`不是 DebateWeaver 项目包：format 应为 "${BUNDLE_FORMAT}"，实际是 ${JSON.stringify(input.format)}`)
  }
  const version = Number(input.version)
  if (!Number.isFinite(version) || version < 1) throw new Error('bundle 缺少合法的 version')
  const project = input.project
  if (project === null || typeof project !== 'object' || !filled(project.id) || !filled(project.title)) {
    throw new Error('bundle 缺少 project.id 或 project.title')
  }
  const timestamp = now()
  const tree = input.argumentTree !== null && typeof input.argumentTree === 'object' ? input.argumentTree : undefined
  const normalizedTree = tree === undefined
    ? { id: newId('tree'), projectId: project.id, nodes: [], edges: [], createdAt: timestamp, updatedAt: timestamp }
    : {
        ...tree,
        id: filled(tree.id) ? tree.id : newId('tree'),
        projectId: filled(tree.projectId) ? tree.projectId : project.id,
        nodes: Array.isArray(tree.nodes) ? tree.nodes.filter(node => node !== null && typeof node === 'object' && filled(node.id)) : [],
        edges: Array.isArray(tree.edges) ? tree.edges.filter(edge => edge !== null && typeof edge === 'object' && filled(edge.source) && filled(edge.target)) : [],
      }
  const bundle = {
    ...input,
    format: BUNDLE_FORMAT,
    version,
    exportedAt: typeof input.exportedAt === 'string' ? input.exportedAt : timestamp,
    project: {
      ...project,
      side: normalizeSide(project.side) ?? 'pro',
      format: normalizeFormat(project.format) ?? 'chinese',
      status: ['active', 'archived', 'deleted'].includes(project.status) ? project.status : 'active',
      createdAt: typeof project.createdAt === 'string' ? project.createdAt : timestamp,
      updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : timestamp,
      argumentTreeId: normalizedTree.id,
    },
    argumentTree: normalizedTree,
    attackDefenseBoxes: arrayOf(input.attackDefenseBoxes),
    nodeEvidenceLinks: arrayOf(input.nodeEvidenceLinks),
    evidenceCards: arrayOf(input.evidenceCards),
    manuscripts: arrayOf(input.manuscripts),
    aiQuestions: arrayOf(input.aiQuestions),
    aiEvaluations: arrayOf(input.aiEvaluations),
    decompositionResults: arrayOf(input.decompositionResults),
  }
  return bundle
}

/** 只接受对象数组，其它一律空数组。 */
function arrayOf(value) {
  return Array.isArray(value) ? value.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)) : []
}

/**
 * 校验 bundle 的完整性/一致性，返回结构化错误与提醒。
 *
 * @param {any} bundle 归一后的 bundle
 * @returns {{ ok: boolean, errors: any[], warnings: any[] }}
 */
export function validateBundle(bundle) {
  const errors = []
  const warnings = []
  const nodes = bundle.argumentTree?.nodes ?? []
  const edges = bundle.argumentTree?.edges ?? []
  const nodeIds = new Set(nodes.map(node => node.id))
  const cardIds = new Set((bundle.evidenceCards ?? []).map(card => card.id))

  for (const node of nodes) {
    if (!NODE_TYPES.includes(node.type)) {
      errors.push({ code: 'B_NODE_TYPE', message: `节点 ${node.id} 的类型 ${JSON.stringify(node.type)} 不在 9 种类型内`, target: node.id })
    }
    if (!filled(node.data?.label)) {
      errors.push({ code: 'B_NODE_LABEL', message: `节点 ${node.id} 缺少标题`, target: node.id })
    }
    if (node.position === undefined || typeof node.position.x !== 'number' || typeof node.position.y !== 'number') {
      warnings.push({ code: 'B_NODE_POSITION', message: `节点 ${node.id} 缺少坐标，UI 会自动排布`, target: node.id })
    }
  }
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) errors.push({ code: 'B_EDGE_SOURCE', message: `连线 ${edge.id} 的起点 ${edge.source} 不存在` })
    if (!nodeIds.has(edge.target)) errors.push({ code: 'B_EDGE_TARGET', message: `连线 ${edge.id} 的终点 ${edge.target} 不存在` })
  }
  if (hasCycle(nodes, edges)) errors.push({ code: 'B_CYCLE', message: '论证树存在环：父子关系必须是 DAG' })

  for (const link of bundle.nodeEvidenceLinks ?? []) {
    if (!nodeIds.has(link.nodeId)) errors.push({ code: 'B_LINK_NODE', message: `证据关联的节点 ${link.nodeId} 不存在` })
    if (!cardIds.has(link.evidenceCardId)) errors.push({ code: 'B_LINK_CARD', message: `证据关联引用的卡片 ${link.evidenceCardId} 不存在` })
  }
  for (const box of bundle.attackDefenseBoxes ?? []) {
    if (!nodeIds.has(box.nodeId)) errors.push({ code: 'B_BOX_NODE', message: `攻防框所属节点 ${box.nodeId} 不存在` })
    for (const attack of box.attacks ?? []) {
      if (!ATTACK_TYPES.includes(attack.type)) errors.push({ code: 'B_ATTACK_TYPE', message: `攻击 ${attack.id} 的类型 ${JSON.stringify(attack.type)} 非法` })
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** 判断树是否存在环（父子关系必须无环）。 */
export function hasCycle(nodes, edges) {
  const children = new Map()
  for (const edge of edges) {
    if (!children.has(edge.source)) children.set(edge.source, [])
    children.get(edge.source).push(edge.target)
  }
  const state = new Map()
  const visit = (id) => {
    const status = state.get(id)
    if (status === 'visiting') return true
    if (status === 'done') return false
    state.set(id, 'visiting')
    for (const next of children.get(id) ?? []) {
      if (visit(next)) return true
    }
    state.set(id, 'done')
    return false
  }
  for (const node of nodes) {
    if (visit(node.id)) return true
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 工厂函数
 * ------------------------------------------------------------------ */

/** 新建论证节点。 */
export function makeNode(input) {
  const type = NODE_TYPES.includes(input.type) ? input.type : 'claim'
  const position = input.position ?? {}
  return {
    id: filled(input.id) ? input.id : newId('node'),
    type,
    position: {
      x: Number.isFinite(Number(position.x)) ? Number(position.x) : 0,
      y: Number.isFinite(Number(position.y)) ? Number(position.y) : 0,
    },
    data: {
      label: filled(input.data?.label) ? input.data.label.trim() : NODE_TYPE_CONFIGS.find(item => item.type === type).label,
      ...(filled(input.data?.description) ? { description: input.data.description.trim() } : {}),
      ...(input.data?.details !== null && typeof input.data?.details === 'object' ? { details: cloneJson(input.data.details) } : {}),
      ...(filled(input.data?.imageSrc) ? { imageSrc: input.data.imageSrc.trim() } : {}),
    },
  }
}

/** 新建连线。 */
export function makeEdge(source, target, id) {
  return { id: filled(id) ? id : newId('edge'), source, target }
}

/** 新建证据卡。 */
export function makeEvidenceCard(input, existing) {
  const timestamp = now()
  return {
    id: filled(input.id) ? input.id : `card-${randomUUID()}`,
    title: filled(input.title) ? input.title.trim() : '未命名证据',
    content: typeof input.content === 'string' ? input.content : '',
    originalText: typeof input.originalText === 'string' ? input.originalText : '',
    type: EVIDENCE_TYPES.includes(input.type) ? input.type : 'data',
    credibility: clampInt(input.credibility, 1, 5, 3),
    timeliness: filled(input.timeliness) ? input.timeliness.trim() : '',
    tags: stringList(input.tags),
    applicableSide: APPLICABLE_SIDES.includes(input.applicableSide) ? input.applicableSide : 'both',
    ...(filled(input.counterWarning) ? { counterWarning: input.counterWarning.trim() } : {}),
    status: EVIDENCE_STATUSES.includes(input.status) ? input.status : 'draft',
    useCount: clampInt(input.useCount, 0, 1_000_000, existing?.useCount ?? 0),
    ...(filled(input.source) ? { source: input.source.trim() } : {}),
    ...(filled(input.year) ? { year: input.year.trim() } : {}),
    ...(filled(input.purpose) ? { purpose: input.purpose.trim() } : {}),
    ...(filled(input.url) ? { url: input.url.trim() } : {}),
    createdAt: filled(input.createdAt) ? input.createdAt : timestamp,
    updatedAt: timestamp,
  }
}

/** 新建节点—证据关联。 */
export function makeNodeEvidenceLink(input) {
  return {
    id: filled(input.id) ? input.id : newId('link'),
    nodeId: input.nodeId,
    projectId: input.projectId,
    evidenceCardId: input.evidenceCardId,
    ...(filled(input.note) ? { note: input.note.trim() } : {}),
    createdAt: now(),
  }
}

/** 新建攻击路径。 */
export function makeAttackPath(input) {
  return {
    id: filled(input.id) ? input.id : newId('attack'),
    type: ATTACK_TYPES.includes(input.type) ? input.type : 'logical',
    content: filled(input.content) ? input.content.trim() : '',
    threatLevel: clampInt(input.threatLevel, 1, 5, 3),
    ...(filled(input.defenseStrategy) ? { defenseStrategy: input.defenseStrategy.trim() } : {}),
  }
}

/** 新建攻防框。 */
export function makeAttackDefenseBox(input) {
  const timestamp = now()
  return {
    id: filled(input.id) ? input.id : newId('box'),
    nodeId: input.nodeId,
    projectId: input.projectId,
    attacks: Array.isArray(input.attacks) ? input.attacks.map(item => makeAttackPath(item)) : [],
    ...(filled(input.mockNotes) ? { mockNotes: input.mockNotes.trim() } : {}),
    linkedEvidenceIds: stringList(input.linkedEvidenceIds),
    ...(filled(input.summary) ? { summary: input.summary.trim() } : {}),
    createdAt: filled(input.createdAt) ? input.createdAt : timestamp,
    updatedAt: timestamp,
  }
}

/** 新建稿件记录。 */
export function makeManuscript(input) {
  const timestamp = now()
  const content = typeof input.content === 'string' ? input.content : ''
  return {
    id: filled(input.id) ? input.id : newId('manuscript'),
    projectId: input.projectId,
    title: filled(input.title) ? input.title.trim() : '未命名稿件',
    fileName: filled(input.fileName) ? input.fileName.trim() : 'manuscript.md',
    fileType: MANUSCRIPT_TYPES.includes(input.fileType) ? input.fileType : 'md',
    content,
    fileSize: Buffer.byteLength(content, 'utf8'),
    ...(filled(input.author) ? { author: input.author.trim() } : {}),
    ...(filled(input.notes) ? { notes: input.notes.trim() } : {}),
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

/** 新建苏格拉底追问记录。 */
export function makeAiQuestion(input) {
  return {
    id: filled(input.id) ? input.id : newId('question'),
    projectId: input.projectId,
    ...(filled(input.nodeId) ? { nodeId: input.nodeId } : {}),
    triggerType: QUESTION_TRIGGERS.includes(input.triggerType) ? input.triggerType : 'manual',
    question: filled(input.question) ? input.question.trim() : '',
    ...(filled(input.answer) ? { answer: input.answer.trim() } : {}),
    ...(input.helpful === true || input.helpful === false ? { helpful: input.helpful } : {}),
    createdAt: now(),
  }
}

/** 新建五维评估记录。 */
export function makeAiEvaluation(input) {
  const dimensions = {}
  for (const dimension of EVALUATION_DIMENSIONS) {
    dimensions[dimension.key] = clampInt(input[dimension.key], 0, 100, 0)
  }
  const overall = Number.isFinite(Number(input.overall))
    ? clampInt(input.overall, 0, 100, 0)
    : Math.round(EVALUATION_DIMENSIONS.reduce((sum, dimension) => sum + dimensions[dimension.key] * dimension.weight, 0))
  return {
    id: filled(input.id) ? input.id : newId('evaluation'),
    projectId: input.projectId,
    ...dimensions,
    overall,
    suggestions: stringList(input.suggestions),
    ...(Array.isArray(input.strengths) ? { strengths: stringList(input.strengths) } : {}),
    ...(filled(input.verdictSummary) ? { verdictSummary: input.verdictSummary.trim() } : {}),
    ...(Array.isArray(input.priorityFixes)
      ? {
          priorityFixes: input.priorityFixes
            .filter(item => item !== null && typeof item === 'object')
            .map(item => ({ problem: String(item.problem ?? ''), whyItLoses: String(item.whyItLoses ?? ''), fixNow: String(item.fixNow ?? '') })),
        }
      : {}),
    ...(Array.isArray(input.judgeQuestions) ? { judgeQuestions: stringList(input.judgeQuestions) } : {}),
    ...(Array.isArray(input.nextStepPlan) ? { nextStepPlan: stringList(input.nextStepPlan) } : {}),
    createdAt: now(),
  }
}
