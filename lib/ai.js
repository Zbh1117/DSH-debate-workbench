/**
 * 模型能力层：给辩论插件提供「辅助模型调用」能力。
 *
 * 默认走宿主内置模型（`llm` 服务 + `agentDefaultModel` 当前选择，例如
 * provider=deepseek-account / model=deepseek-flash），不额外需要 API key；
 * 也预留 OpenAI 兼容外接模式（插件配置 ai.provider=openai-compatible）。
 *
 * 设计要点：
 *  - 没有 llm 服务时优雅降级（available:false + 明确原因），不阻塞其余功能；
 *  - 只做「辅助生成」：结果返回给上层做候选预览，默认不直接写结构化数据；
 *  - 调用有超时、有 abort 传递、记录 token 用量，便于以后做成本控制。
 *
 * @module dsh-debate-workbench/ai
 */
import { randomUUID } from 'node:crypto'
import { filled } from './model.js'

/** 默认单次输出上限。 */
const DEFAULT_MAX_TOKENS = 1800
/** 默认调用超时。 */
const DEFAULT_TIMEOUT_MS = 90_000
/** 拆题候选的提示词版本（写进结果里便于回溯）。 */
export const DECOMPOSE_PROMPT_VERSION = 'decompose-v1'

/**
 * 安全取 Cordis 服务（可选依赖语义）。
 *
 * @param {any} ctx 插件上下文
 * @param {string} name 服务名
 * @returns {any | undefined} 服务实例
 */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 解析当前 AI 路由（内置 / 外接 / 关闭）。
 *
 * @param {any} ctx 插件上下文
 * @param {any} [config] 插件配置
 * @returns {any} 路由描述 `{ available, mode, provider, model, reason?, llm?, baseUrl?, apiKey? }`
 */
export function resolveAiRoute(ctx, config) {
  const ai = config?.ai !== null && typeof config?.ai === 'object' ? config.ai : {}
  const mode = ai.provider === 'openai-compatible' ? 'openai-compatible' : ai.provider === 'off' ? 'off' : 'builtin'

  if (mode === 'off') {
    return { available: false, mode, reason: '插件配置 ai.provider=off，已关闭 AI 能力' }
  }

  if (mode === 'openai-compatible') {
    const baseUrl = filled(ai.baseUrl) ? String(ai.baseUrl).replace(/\/+$/, '') : ''
    const model = filled(ai.model) ? String(ai.model) : ''
    if (baseUrl === '' || model === '') {
      return { available: false, mode, reason: '外接模式需要同时配置 ai.baseUrl 与 ai.model' }
    }
    return {
      available: true,
      mode,
      provider: filled(ai.providerName) ? String(ai.providerName) : 'openai-compatible',
      model,
      baseUrl,
      apiKey: filled(ai.apiKey) ? String(ai.apiKey) : undefined,
    }
  }

  // 内置模式：宿主 llm 服务 + 默认模型选择
  const llm = serviceOf(ctx, 'llm')
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { available: false, mode, reason: '当前宿主没有可用的 llm 服务（headless/无模型组合下无法调用内置模型）' }
  }
  let selection
  try {
    selection = serviceOf(ctx, 'agentDefaultModel')?.currentSelection?.()
  } catch {
    selection = undefined
  }
  const provider = filled(ai.provider) ? String(ai.provider) : filled(selection?.provider) ? String(selection.provider) : 'deepseek-account'
  const model = filled(ai.model) ? String(ai.model) : filled(selection?.model) ? String(selection.model) : 'deepseek-flash'
  const reasoningEffort = filled(ai.reasoningEffort)
    ? String(ai.reasoningEffort)
    : filled(selection?.reasoningEffort)
      ? String(selection.reasoningEffort)
      : undefined
  return {
    available: true,
    mode,
    provider,
    model,
    reasoningEffort,
    llm,
    timeoutMs: Number.isFinite(Number(ai.timeoutMs)) ? Math.max(5000, Number(ai.timeoutMs)) : DEFAULT_TIMEOUT_MS,
    maxTokens: Number.isFinite(Number(ai.maxTokens)) ? Math.max(256, Number(ai.maxTokens)) : DEFAULT_MAX_TOKENS,
  }
}

/**
 * 给 UI / 模型看的路由摘要（不含密钥）。
 *
 * @param {any} ctx 插件上下文
 * @param {any} [config] 插件配置
 * @returns {any} 摘要
 */
export function aiStatus(ctx, config) {
  const route = resolveAiRoute(ctx, config)
  if (!route.available) {
    return {
      available: false,
      mode: route.mode,
      reason: route.reason,
      hint: '内置模式需要宿主注入 llm 服务；外接模式在插件配置里设置 ai.provider=openai-compatible + ai.baseUrl + ai.model',
    }
  }
  return {
    available: true,
    mode: route.mode,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    timeoutMs: route.timeoutMs,
    maxTokens: route.maxTokens,
    hint:
      route.mode === 'builtin'
        ? '使用宿主内置模型（跟随 agentDefaultModel，也可在插件配置里覆盖 ai.provider/ai.model）'
        : '使用外接 OpenAI 兼容接口（ai.baseUrl / ai.model 由插件配置提供）',
  }
}

/** 把外部 signal 与本层超时合并成一个可中断信号。 */
function withDeadline(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`模型调用超时（${timeoutMs}ms）`)), timeoutMs)
  const forward = () => controller.abort(signal?.reason)
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) forward()
    else signal.addEventListener('abort', forward, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (signal !== undefined && signal !== null) signal.removeEventListener('abort', forward)
    },
  }
}

/** 从模型文本里抽出 JSON 对象（容忍 ```json 包裹与前后说明文字）。 */
export function parseJsonCandidate(text) {
  const source = String(text ?? '').trim()
  if (source === '') return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  const body = fenced === null ? source : fenced[1]
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body
  try {
    const parsed = JSON.parse(slice)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 生成一段文本（非流式聚合）。
 *
 * @param {any} ctx 插件上下文
 * @param {any} config 插件配置
 * @param {{ system?: string, prompt: string, maxTokens?: number, temperature?: number, signal?: AbortSignal, sessionId?: string }} request 请求
 * @returns {Promise<any>} `{ text, usage, route }`
 */
export async function generateText(ctx, config, request) {
  const route = resolveAiRoute(ctx, config)
  if (!route.available) throw new Error(`模型不可用：${route.reason}`)
  const prompt = String(request?.prompt ?? '').trim()
  if (prompt === '') throw new Error('模型调用需要 prompt')
  const maxTokens = Math.min(route.maxTokens ?? DEFAULT_MAX_TOKENS, Number.isFinite(Number(request?.maxTokens)) ? Number(request.maxTokens) : DEFAULT_MAX_TOKENS)
  const deadline = withDeadline(request?.signal, route.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    if (route.mode === 'openai-compatible') {
      return await generateOpenAiCompatible(route, { ...request, prompt, maxTokens, signal: deadline.signal })
    }
    return await generateBuiltin(route, { ...request, prompt, maxTokens, signal: deadline.signal })
  } finally {
    deadline.dispose()
  }
}

/** 内置模型：宿主 llm 服务的流式调用。 */
async function generateBuiltin(route, request) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: request.prompt }],
    source: { kind: 'dsh-debate-workbench' },
  }
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [message],
    ...(filled(request.system) ? { system: String(request.system) } : {}),
    maxTokens: request.maxTokens,
    ...(Number.isFinite(Number(request.temperature)) ? { temperature: Number(request.temperature) } : {}),
    ...(filled(route.reasoningEffort) ? { reasoningEffort: route.reasoningEffort } : {}),
    ...(filled(request.sessionId) ? { sessionId: request.sessionId } : {}),
    signal: request.signal,
  }
  let text = ''
  let usage
  let finish
  for await (const chunk of route.llm.stream(options)) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish !== undefined && finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const failure = finish.failure ?? {}
    const error = new Error(`模型调用失败：${failure.message ?? finish.kind}`)
    error.code = failure.code
    error.status = failure.status
    throw error
  }
  return {
    text: text.trim(),
    usage,
    finish: finish?.kind ?? 'stop',
    route: { mode: route.mode, provider: route.provider, model: route.model },
  }
}

/** 外接模式：OpenAI 兼容 /chat/completions。 */
async function generateOpenAiCompatible(route, request) {
  const path = filled(request.path) ? String(request.path) : '/v1/chat/completions'
  const endpoint = `${route.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  const messages = []
  if (filled(request.system)) messages.push({ role: 'system', content: String(request.system) })
  messages.push({ role: 'user', content: request.prompt })
  let response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(filled(route.apiKey) ? { authorization: `Bearer ${route.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: route.model,
        messages,
        max_tokens: request.maxTokens,
        ...(Number.isFinite(Number(request.temperature)) ? { temperature: Number(request.temperature) } : {}),
      }),
      signal: request.signal,
    })
  } catch (error) {
    throw new Error(`外接模型请求失败（${endpoint}）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`外接模型返回 HTTP ${response.status}${detail === '' ? '' : `：${detail.slice(0, 300)}`}`)
  }
  const payload = await response.json().catch(() => undefined)
  const text = payload?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('外接模型返回结构不符合 OpenAI 兼容格式（缺少 choices[0].message.content）')
  return {
    text: text.trim(),
    usage: payload?.usage,
    finish: payload?.choices?.[0]?.finish_reason ?? 'stop',
    route: { mode: route.mode, provider: route.provider, model: route.model },
  }
}

/**
 * 生成并解析 JSON（失败时抛可读错误，附带模型原文片段便于排查）。
 *
 * @param {any} ctx 插件上下文
 * @param {any} config 插件配置
 * @param {any} request 请求
 * @returns {Promise<{ json: any, raw: any }>} 解析结果
 */
export async function generateJson(ctx, config, request) {
  const result = await generateText(ctx, config, { temperature: 0.3, ...request })
  const json = parseJsonCandidate(result.text)
  if (json === undefined) {
    throw new Error(`模型没有返回可解析的 JSON（前 200 字：${result.text.slice(0, 200)}）`)
  }
  return { json, raw: result }
}

/* ------------------------------------------------------------------ *
 * 拆题候选：提示词与结果清洗
 * ------------------------------------------------------------------ */

/** 拆题生成时允许的字段上限（防止模型输出过长）。 */
const LIMITS = {
  coreConcepts: 5,
  controversialPoints: 5,
  battlefields: 6,
  criteria: 5,
  hiddenPremises: 5,
  rebuttalTargets: 5,
  prepChecklist: 10,
  supportingPoints: 5,
  interpretations: 4,
}

/** 取第一个非空字符串。 */
function pickString(value) {
  return filled(value) ? String(value).trim() : ''
}

/** 取字符串数组（去空、去重、限量）。 */
function pickStrings(value, limit) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const output = []
  for (const item of value) {
    const text = pickString(item)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    output.push(text)
    if (output.length >= limit) break
  }
  return output
}

/** 对象数组清洗：只保留对象元素，逐个映射。 */
function pickObjects(value, limit, mapper) {
  if (!Array.isArray(value)) return []
  const output = []
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const mapped = mapper(item)
    if (mapped !== undefined) output.push(mapped)
    if (output.length >= limit) break
  }
  return output
}

/**
 * 清洗拆题候选：只保留 DebateWeaver `DecompositionResult` 认识的字段，
 * 去掉模型可能多给的废话字段，限制长度，缺失字段补空。
 *
 * @param {any} candidate 模型返回对象
 * @returns {any} 可写入 bundle 的拆题对象
 */
export function normalizeDecomposeCandidate(candidate) {
  const source = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
  const framework = source.comparisonFramework !== null && typeof source.comparisonFramework === 'object' ? source.comparisonFramework : {}
  return {
    judgeQuestion: pickString(source.judgeQuestion),
    motionType: pickString(source.motionType),
    coreConcepts: pickObjects(source.coreConcepts, LIMITS.coreConcepts, item => {
      const term = pickString(item.term)
      if (term === '') return undefined
      return {
        term,
        literalDefinition: pickString(item.literalDefinition),
        possibleInterpretations: pickStrings(item.possibleInterpretations, LIMITS.interpretations),
        suggestedDefinition: pickString(item.suggestedDefinition),
        counterDefinition: pickString(item.counterDefinition),
      }
    }),
    controversialPoints: pickObjects(source.controversialPoints, LIMITS.controversialPoints, item => {
      const issue = pickString(item.issue)
      if (issue === '') return undefined
      return {
        issue,
        proView: pickString(item.proView),
        conView: pickString(item.conView),
        keyBattle: pickString(item.keyBattle),
      }
    }),
    battlefields: pickObjects(source.battlefields, LIMITS.battlefields, item => {
      const battlefield = pickString(item.battlefield)
      if (battlefield === '') return undefined
      const priority = ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium'
      return {
        battlefield,
        whyItMatters: pickString(item.whyItMatters),
        ourPush: pickString(item.ourPush),
        opponentPush: pickString(item.opponentPush),
        priority,
      }
    }),
    comparisonFramework: {
      overallPlatform: pickString(framework.overallPlatform),
      criteria: pickObjects(framework.criteria, LIMITS.criteria, item => {
        const dimension = pickString(item.dimension)
        if (dimension === '') return undefined
        return {
          dimension,
          ourStandard: pickString(item.ourStandard),
          opponentStandard: pickString(item.opponentStandard),
          judgeShortcut: pickString(item.judgeShortcut),
        }
      }),
    },
    hiddenPremises: pickObjects(source.hiddenPremises, LIMITS.hiddenPremises, item => {
      const premise = pickString(item.premise)
      if (premise === '') return undefined
      return { premise, explanation: pickString(item.explanation), howToUse: pickString(item.howToUse) }
    }),
    argumentPaths: pickObjects(source.argumentPaths, 2, item => {
      const mainClaim = pickString(item.mainClaim)
      if (mainClaim === '') return undefined
      return {
        side: item.side === 'con' ? 'con' : 'pro',
        mainClaim,
        supportingPoints: pickStrings(item.supportingPoints, LIMITS.supportingPoints),
      }
    }),
    ourSideDetailedRoute: pickString(source.ourSideDetailedRoute),
    rebuttalTargets: pickObjects(source.rebuttalTargets, LIMITS.rebuttalTargets, item => {
      const target = pickString(item.target)
      if (target === '') return undefined
      return { target, attackPath: pickString(item.attackPath), watchout: pickString(item.watchout) }
    }),
    prepChecklist: pickStrings(source.prepChecklist, LIMITS.prepChecklist),
  }
}

/** 拆题生成的系统提示词。 */
export const DECOMPOSE_SYSTEM_PROMPT = [
  '你是一名资深华语辩论教练与赛事评委。你的任务是把辩题拆成可直接用于备赛的结构化拆解结果。',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，不要任何 markdown 代码块之外的解释文字。',
  '2. 不得编造数据、年份、机构、论文标题或法条；无法确定的内容用空字符串或空数组，绝不虚构。',
  '3. 一切结论要能落到「双方可争、评委可判」的比较层面：说清争议点、战场、比较标准。',
  '4. 语言用简体中文，术语精确，避免口号化。',
  '5. 字段与数量限制必须遵守（见用户消息中的 schema）。',
  'JSON schema（严格按此结构，字段名不可改）：',
  '{',
  '  "judgeQuestion": "评委真正要回答的问题，一句话",',
  '  "motionType": "辩题类型，如：事实判断 / 价值比较 / 政策辩",',
  '  "coreConcepts": [{"term":"核心概念","literalDefinition":"字面定义","possibleInterpretations":["可能的解释1","解释2"],"suggestedDefinition":"我方建议定义","counterDefinition":"对方可能主张的定义"}],',
  '  "controversialPoints": [{"issue":"争议点","proView":"正方立场","conView":"反方立场","keyBattle":"关键交锋"}],',
  '  "battlefields": [{"battlefield":"战场","whyItMatters":"为什么重要","ourPush":"我方打法","opponentPush":"对方打法","priority":"high|medium|low"}],',
  '  "comparisonFramework": {"overallPlatform":"整体比较平台","criteria":[{"dimension":"比较维度","ourStandard":"我方标准","opponentStandard":"对方标准","judgeShortcut":"评委最可能的判准"}]},',
  '  "hiddenPremises": [{"premise":"隐藏前提","explanation":"为什么是前提","howToUse":"怎么用"}],',
  '  "argumentPaths": [{"side":"pro|con","mainClaim":"主线主张","supportingPoints":["支撑点1","支撑点2"]}],',
  '  "ourSideDetailedRoute": "我方（{我方持方}）的详细论证路线，200-400 字",',
  '  "rebuttalTargets": [{"target":"对方最可能的论点","attackPath":"攻击路径","watchout":"注意别踩的坑"}],',
  '  "prepChecklist": ["备赛要准备的具体事项1","事项2"]',
  '}',
  '数量限制：coreConcepts ≤5、controversialPoints ≤5、battlefields ≤6、criteria ≤5、hiddenPremises ≤5、rebuttalTargets ≤5、prepChecklist ≤10、每条 supportingPoints ≤5。',
].join('\n')

/**
 * 构造拆题生成的用户提示词。
 *
 * @param {any} bundle 当前题目 bundle
 * @param {{ hint?: string }} [options] 可选补充要求
 * @returns {{ system: string, prompt: string }} 提示词
 */
export function buildDecomposePrompt(bundle, options = {}) {
  const project = bundle?.project ?? {}
  const sideLabel = project.side === 'con' ? '反方' : '正方'
  const formatLabel = project.format === 'british' ? '英式议会制' : project.format === 'australian' ? '澳式' : '华语辩论'
  const existing = Array.isArray(bundle?.decompositionResults) ? bundle.decompositionResults[0] : undefined
  const lines = [
    `辩题：${project.title ?? ''}`,
    `我方持方：${sideLabel}`,
    `赛制：${formatLabel}`,
  ]
  if (existing !== undefined) {
    lines.push(
      '',
      '已有拆题结果（可在此基础上修正，不要照抄）：',
      JSON.stringify({
        judgeQuestion: existing.judgeQuestion,
        coreConcepts: existing.coreConcepts,
        controversialPoints: existing.controversialPoints,
      }).slice(0, 2500),
    )
  }
  if (filled(options?.hint)) lines.push('', `补充要求：${String(options.hint).trim()}`)
  lines.push('', '请输出拆题 JSON。')
  return { system: DECOMPOSE_SYSTEM_PROMPT.replace('{我方持方}', sideLabel), prompt: lines.join('\n') }
}

/* ------------------------------------------------------------------ *
 * 攻防候选：批量生成三类攻击（候选模式，写库由 debate_plan 负责）
 * ------------------------------------------------------------------ */

/** 攻防生成的系统提示词。 */
export const ATTACK_SYSTEM_PROMPT = [
  '你是一名资深辩论陪练与反方教练。你的任务是对指定论点节点做「攻防预判」。',
  '硬性要求：',
  '1. 只输出一个 JSON 对象，不要解释文字。',
  '2. 每个节点至少覆盖 事实攻击（数据/案例不成立）、逻辑攻击（因果/定义/前提断裂）、价值攻击（价值排序/标准不合理）三类。',
  '3. threatLevel 用 1–5 整数表示威胁度；威胁度 ≥4 的攻击**必须**给出 defenseStrategy（具体怎么防、用什么材料或话术）。',
  '4. 不得编造数据、年份、机构、论文标题或法条；攻击里可以指出对方「缺少可核验来源」，但不能自己伪造来源。',
  '5. 内容要具体到能直接念出来，避免「对方数据不准」这类空话。',
  'JSON schema：',
  '{',
  '  "attacks": [',
  '    {"nodeId":"节点id","type":"factual|logical|value","content":"攻击内容","threatLevel":4,"defenseStrategy":"防守策略"}',
  '  ]',
  '}',
].join('\n')

/**
 * 构造攻防生成的用户提示词。
 *
 * @param {any} bundle 当前题目 bundle
 * @param {Array<{id: string, type: string, label: string}>} targets 目标节点
 * @returns {{ system: string, prompt: string }} 提示词
 */
export function buildAttacksPrompt(bundle, targets) {
  const project = bundle?.project ?? {}
  const sideLabel = project.side === 'con' ? '反方' : '正方'
  const list = (Array.isArray(targets) ? targets : []).map((item, index) => `${index + 1}. nodeId=${item.id}｜${item.type}｜${item.label}`)
  return {
    system: ATTACK_SYSTEM_PROMPT,
    prompt: [
      `辩题：${project.title ?? ''}`,
      `我方持方：${sideLabel}（攻击是「对方会怎么打我们」的预判）`,
      '',
      '需要做攻防预判的节点：',
      ...list,
      '',
      '请对每个节点输出攻击与防守 JSON。',
    ].join('\n'),
  }
}

/**
 * 清洗攻防候选：校验节点存在、类型合法、威胁度 ≥4 必须有防守策略。
 *
 * @param {any} candidate 模型返回对象
 * @param {Set<string>} validNodeIds 可用节点 id 集合
 * @returns {{ attacks: Array<any>, dropped: Array<{ reason: string, raw: any }> }} 结果
 */
export function normalizeAttackCandidate(candidate, validNodeIds) {
  const source = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
  const input = Array.isArray(source.attacks) ? source.attacks : []
  const attacks = []
  const dropped = []
  for (const item of input) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const nodeId = pickString(item.nodeId)
    const type = ['factual', 'logical', 'value'].includes(item.type) ? item.type : undefined
    const content = pickString(item.content)
    const threat = Math.round(Number(item.threatLevel))
    const defenseStrategy = pickString(item.defenseStrategy)
    if (nodeId === '' || !validNodeIds.has(nodeId)) {
      dropped.push({ reason: `节点不存在：${nodeId || '(空)'}`, raw: item })
      continue
    }
    if (type === undefined) {
      dropped.push({ reason: '攻击类型非法（需 factual/logical/value）', raw: item })
      continue
    }
    if (content === '') {
      dropped.push({ reason: '攻击内容为空', raw: item })
      continue
    }
    if (!Number.isFinite(threat) || threat < 1 || threat > 5) {
      dropped.push({ reason: '威胁度需为 1–5 的整数', raw: item })
      continue
    }
    if (threat >= 4 && defenseStrategy === '') {
      dropped.push({ reason: '威胁度 ≥4 但缺少 defenseStrategy（硬规则：必须给防守策略）', raw: item })
      continue
    }
    attacks.push({ nodeId, type, content, threatLevel: threat, defenseStrategy })
  }
  return { attacks, dropped }
}

