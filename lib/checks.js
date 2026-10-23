/**
 * 辩论备赛工作台 —— 分析层（确定性）。
 *
 * 这一层不调用模型，只根据 bundle 的结构给出：
 *   1. 缺口清单（error / warn / info），驱动「下一步该补什么」
 *   2. 五维评估分数（逻辑性 / 证据力 / 说服力 / 创新性 / 抗反驳性）
 *   3. 可直接执行的改进建议
 *
 * 分数是启发式但**可复现**的：同样的树一定得到同样的分。
 * 模型可以在此基础上用 `debate_evaluate(action=save)` 写入自己的判断（AIEvaluation），
 * 但结构性问题由这里兜底，避免「看起来写完了」。
 *
 * @module dsh-debate-workbench/checks
 */
import { ATTACK_TYPES, EVALUATION_DIMENSIONS, NODE_TYPE_CONFIGS, filled } from './model.js'

/** 缺口等级权重。 */
const LEVEL_COST = { error: 12, warn: 5, info: 1 }

/** 一条缺口。 */
function gap(level, code, message, target) {
  return target === undefined ? { level, code, message } : { level, code, message, target }
}

/** 限幅。 */
function clamp01to100(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * 建立树的索引结构。
 *
 * @param {any} bundle 归一后的 bundle
 * @returns {any} 索引
 */
export function treeIndex(bundle) {
  const nodes = bundle.argumentTree?.nodes ?? []
  const edges = bundle.argumentTree?.edges ?? []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const children = new Map()
  const parents = new Map()
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    if (!children.has(edge.source)) children.set(edge.source, [])
    children.get(edge.source).push(edge.target)
    if (!parents.has(edge.target)) parents.set(edge.target, [])
    parents.get(edge.target).push(edge.source)
  }
  const roots = nodes.filter(node => !parents.has(node.id) || parents.get(node.id).length === 0)
  const linksByNode = new Map()
  for (const link of bundle.nodeEvidenceLinks ?? []) {
    if (!linksByNode.has(link.nodeId)) linksByNode.set(link.nodeId, [])
    linksByNode.get(link.nodeId).push(link)
  }
  const boxesByNode = new Map()
  for (const box of bundle.attackDefenseBoxes ?? []) {
    boxesByNode.set(box.nodeId, box)
  }
  const cardsById = new Map((bundle.evidenceCards ?? []).map(card => [card.id, card]))
  const nodeDepth = new Map()
  const walk = (id, depth) => {
    if (nodeDepth.has(id) && nodeDepth.get(id) <= depth) return
    nodeDepth.set(id, depth)
    for (const child of children.get(id) ?? []) walk(child, depth + 1)
  }
  for (const root of roots) walk(root.id, 0)
  return { nodes, edges, byId, children, parents, roots, linksByNode, boxesByNode, cardsById, nodeDepth }
}

/** 节点的展示名（用于缺口信息）。 */
function nodeLabel(node) {
  return filled(node?.data?.label) ? node.data.label : `节点 ${node?.id ?? '?'}`
}

/**
 * 结构缺口：论证树是否成立。
 *
 * @param {any} bundle 归一后的 bundle
 * @param {any} index treeIndex 结果
 * @returns {any[]} 缺口
 */
function treeGaps(bundle, index) {
  const gaps = []
  const stanceNodes = index.nodes.filter(node => node.type === 'stance')
  if (index.nodes.length === 0) {
    gaps.push(gap('error', 'T_EMPTY', '论证树是空的：先建立场节点，再从论点往下展开。'))
    return gaps
  }
  if (stanceNodes.length === 0) {
    gaps.push(gap('error', 'T_NO_STANCE', '没有立场节点（type=stance）：整棵树缺少根，评委看不到你要证明什么。'))
  } else if (stanceNodes.length > 1) {
    gaps.push(gap('warn', 'T_MULTI_STANCE', `有 ${stanceNodes.length} 个立场节点，建议只保留一个根，其余改成论点。`))
  }
  for (const node of index.nodes) {
    const children = index.children.get(node.id) ?? []
    const parents = index.parents.get(node.id) ?? []
    const isStance = node.type === 'stance'
    if (!isStance && parents.length === 0) {
      gaps.push(gap('warn', 'T_ORPHAN', `${nodeLabel(node)} 没有父节点：悬空的论证不会被评委当成论证链。`, node.id))
    }
    if (node.type === 'claim' && children.length === 0) {
      gaps.push(gap('warn', 'T_CLAIM_LEAF', `${nodeLabel(node)} 是叶子论点：需要子论点/证据/比较来支撑。`, node.id))
    }
    if (node.type === 'claim' && !filled(node.data?.description)) {
      gaps.push(gap('info', 'T_CLAIM_NO_DESC', `${nodeLabel(node)} 没写推理过程（description），场上容易被问「所以呢」。`, node.id))
    }
    if (node.type === 'evidence' && (index.linksByNode.get(node.id) ?? []).length === 0) {
      gaps.push(gap('error', 'T_EVIDENCE_UNLINKED', `证据节点「${nodeLabel(node)}」没有挂任何证据卡，等于没有证据。`, node.id))
    }
    if (node.type === 'premise' && !filled(node.data?.details?.attackable)) {
      gaps.push(gap('info', 'T_PREMISE_ATTACKABLE', `前提「${nodeLabel(node)}」没有标注可攻击性（details.attackable），备赛时容易漏防。`, node.id))
    }
    if (node.type === 'compare' && (children.length === 0 || index.parents.get(node.id) === undefined)) {
      gaps.push(gap('info', 'T_COMPARE_THIN', `比较节点「${nodeLabel(node)}」缺少对比对象或挂载位置。`, node.id))
    }
  }
  return gaps
}

/** 证据缺口。 */
function evidenceGaps(bundle, index) {
  const gaps = []
  const cards = bundle.evidenceCards ?? []
  const projectSide = bundle.project?.side
  if (cards.length === 0) {
    gaps.push(gap('warn', 'E_EMPTY', '证据库是空的：至少准备 3–5 张可引用的证据卡。'))
    return gaps
  }
  let used = 0
  for (const link of bundle.nodeEvidenceLinks ?? []) {
    if (index.cardsById.has(link.evidenceCardId)) used += 1
  }
  if (used === 0) gaps.push(gap('error', 'E_NO_LINK', '没有任何证据卡被挂到论证树上：等于备赛时用不上。'))
  for (const card of cards) {
    if (!filled(card.originalText) && !filled(card.content)) {
      gaps.push(gap('error', 'E_NO_TEXT', `证据卡「${card.title}」既没有原文也没有内容。`, card.id))
    }
    if (!filled(card.source) && !filled(card.url)) {
      gaps.push(gap('warn', 'E_NO_SOURCE', `证据卡「${card.title}」没有来源或链接，场上无法被核验。`, card.id))
    }
    if (Number(card.credibility) < 3) {
      gaps.push(gap('warn', 'E_WEAK', `证据卡「${card.title}」可信度只有 ${card.credibility}/5，建议换更强的来源或降级为辅助。`, card.id))
    }
    if (!filled(card.counterWarning)) {
      gaps.push(gap('info', 'E_NO_WARNING', `证据卡「${card.title}」没写反驳预警：对方最可能怎么打这张证据？`, card.id))
    }
    if (card.applicableSide === (projectSide === 'pro' ? 'con' : 'pro')) {
      gaps.push(gap('info', 'E_SIDE_MISMATCH', `证据卡「${card.title}」标注的适用方向与我方持方相反，确认是否作为对方证据使用。`, card.id))
    }
  }
  return gaps
}

/** 攻防缺口。 */
function attackGaps(bundle, index) {
  const gaps = []
  const claims = index.nodes.filter(node => node.type === 'claim')
  if (claims.length === 0) return gaps
  let boxes = 0
  for (const claim of claims) {
    const box = index.boxesByNode.get(claim.id)
    if (box === undefined || (box.attacks ?? []).length === 0) {
      gaps.push(gap('warn', 'A_NO_BOX', `论点「${nodeLabel(claim)}」没有任何攻击路径：赛前没预判，场上必被打穿。`, claim.id))
      continue
    }
    boxes += 1
    const attacks = box.attacks ?? []
    const missingDefense = attacks.filter(attack => !filled(attack.defenseStrategy))
    if (missingDefense.length > 0) {
      gaps.push(gap('warn', 'A_NO_DEFENSE', `论点「${nodeLabel(claim)}」有 ${missingDefense.length} 条攻击没有防守策略。`, claim.id))
    }
    const critical = attacks.filter(attack => Number(attack.threatLevel) >= 4 && !filled(attack.defenseStrategy))
    if (critical.length > 0) {
      gaps.push(gap('error', 'A_CRITICAL_UNDEFENDED', `论点「${nodeLabel(claim)}」有高威胁攻击（≥4）没有防守，这是比赛中的致命点。`, claim.id))
    }
    const types = new Set(attacks.map(attack => attack.type))
    const missingTypes = ATTACK_TYPES.filter(type => !types.has(type))
    if (missingTypes.length > 0) {
      gaps.push(gap('info', 'A_TYPE_COVERAGE', `论点「${nodeLabel(claim)}」只覆盖了 ${[...types].join('/')} 攻击，还缺 ${missingTypes.join('/')} 维度的预判。`, claim.id))
    }
  }
  if (boxes === 0 && claims.length > 0) {
    gaps.push(gap('error', 'A_EMPTY', '所有论点都没有攻防框：备赛只做了一半。'))
  }
  return gaps
}

/** 拆题缺口（DecompositionResult）。 */
export function topicGaps(decomposition) {
  const gaps = []
  if (decomposition === undefined || decomposition === null) {
    gaps.push(gap('error', 'D_MISSING', '还没有拆题结果：先产出核心概念、争议焦点、论证路径与隐藏前提。'))
    return gaps
  }
  const concepts = Array.isArray(decomposition.coreConcepts) ? decomposition.coreConcepts : []
  const points = Array.isArray(decomposition.controversialPoints) ? decomposition.controversialPoints : []
  const paths = Array.isArray(decomposition.argumentPaths) ? decomposition.argumentPaths : []
  const premises = Array.isArray(decomposition.hiddenPremises) ? decomposition.hiddenPremises : []
  if (concepts.length < 2) gaps.push(gap('warn', 'D_CONCEPTS', `只分析了 ${concepts.length} 个核心概念，建议至少 2 个。`))
  for (const concept of concepts) {
    if (!filled(concept?.suggestedDefinition)) {
      gaps.push(gap('warn', 'D_CONCEPT_DEF', `概念「${concept?.term ?? '?'}」没有建议界定，场上无法主张定义权。`))
    }
  }
  if (points.length === 0) gaps.push(gap('error', 'D_POINTS', '没有争议焦点：整场不知道在争什么。'))
  if (paths.length === 0) gaps.push(gap('warn', 'D_PATHS', '没有论证路径建议。'))
  if (premises.length === 0) gaps.push(gap('warn', 'D_PREMISES', '没有识别隐藏前提：辩题的隐含假设往往是最大战场。'))
  if (!filled(decomposition.judgeQuestion)) gaps.push(gap('info', 'D_JUDGE', '没写「裁判凭什么判这一票」的核心问题。'))
  const framework = decomposition.comparisonFramework
  if (framework === undefined || !Array.isArray(framework?.criteria) || framework.criteria.length === 0) {
    gaps.push(gap('warn', 'D_CRITERIA', '没有比较框架（comparisonFramework.criteria）：没有标准就无法比较。'))
  }
  if (!Array.isArray(decomposition.prepChecklist) || decomposition.prepChecklist.length === 0) {
    gaps.push(gap('info', 'D_CHECKLIST', '没有备赛清单（prepChecklist）。'))
  }
  return gaps
}

/** 按节点类型统计。 */
export function nodeStats(index) {
  const counts = {}
  for (const config of NODE_TYPE_CONFIGS) counts[config.type] = 0
  for (const node of index.nodes) counts[node.type] = (counts[node.type] ?? 0) + 1
  const maxDepth = Math.max(0, ...index.nodes.map(node => index.nodeDepth.get(node.id) ?? 0))
  return { total: index.nodes.length, counts, maxDepth, edges: index.edges.length }
}

/**
 * 五维评分（0–100，启发式、可复现）。
 *
 * @param {any} bundle 归一后的 bundle
 * @param {any} index treeIndex 结果
 * @param {any[]} gaps 已收集的缺口
 * @returns {any} 五维分数与说明
 */
export function evaluateDimensions(bundle, index, gaps) {
  const claims = index.nodes.filter(node => node.type === 'claim')
  const cards = bundle.evidenceCards ?? []
  const links = bundle.nodeEvidenceLinks ?? []
  const boxes = bundle.attackDefenseBoxes ?? []
  const counts = nodeStats(index).counts

  /* 逻辑性：结构完整性 */
  let logic = 100
  const stance = index.nodes.find(node => node.type === 'stance')
  if (stance === undefined) logic -= 30
  const claimsWithoutChild = claims.filter(claim => (index.children.get(claim.id) ?? []).length === 0).length
  logic -= Math.min(30, claimsWithoutChild * 8)
  const orphans = index.nodes.filter(node => node.type !== 'stance' && (index.parents.get(node.id) ?? []).length === 0).length
  logic -= Math.min(20, orphans * 6)
  if (counts.premise === 0) logic -= 8
  if (counts.compare === 0) logic -= 8
  if (claims.length === 0) logic = 0

  /* 证据力：覆盖 + 质量 */
  const claimIds = new Set(claims.map(claim => claim.id))
  const coveredClaims = new Set(
    links.filter(link => claimIds.has(link.nodeId)).map(link => link.nodeId),
  )
  const coverage = claims.length === 0 ? 0 : coveredClaims.size / claims.length
  const linkedCards = links.map(link => index.cardsById.get(link.evidenceCardId)).filter(card => card !== undefined)
  const avgCredibility = linkedCards.length === 0 ? 0 : linkedCards.reduce((sum, card) => sum + Number(card.credibility ?? 0), 0) / linkedCards.length
  const withSource = linkedCards.filter(card => filled(card.source) || filled(card.url)).length
  const sourceRatio = linkedCards.length === 0 ? 0 : withSource / linkedCards.length
  const evidenceScore = claims.length === 0
    ? 0
    : coverage * 55 + (avgCredibility / 5) * 30 + sourceRatio * 15

  /* 说服力：价值/人群/比较 + 表达完整度 */
  let persuasion = 40
  if (counts.attitude > 0) persuasion += 15
  if (counts.crowd > 0) persuasion += 15
  if (counts.compare > 0) persuasion += 10
  if (claims.some(claim => filled(claim.data?.description))) persuasion += 10
  persuasion += Math.min(10, cards.length * 2)
  if (claims.length === 0) persuasion = 0

  /* 创新性：论证维度多样性 */
  const typesUsed = new Set(index.nodes.map(node => node.type))
  const evidenceTypes = new Set(cards.map(card => card.type))
  let innovation = 30 + typesUsed.size * 6 + evidenceTypes.size * 5
  if (counts.compare > 0) innovation += 6
  if (counts.premise > 0) innovation += 4
  innovation = Math.min(100, innovation)
  if (claims.length === 0) innovation = 0

  /* 抗反驳性：攻防覆盖 + 防守质量 */
  const defendedClaims = claims.filter(claim => {
    const box = boxes.find(item => item.nodeId === claim.id)
    return box !== undefined && (box.attacks ?? []).some(attack => filled(attack.defenseStrategy))
  }).length
  const defenseCoverage = claims.length === 0 ? 0 : defendedClaims / claims.length
  const attacksTotal = boxes.reduce((sum, box) => sum + (box.attacks ?? []).length, 0)
  const undefendedCritical = boxes.reduce(
    (sum, box) => sum + (box.attacks ?? []).filter(attack => Number(attack.threatLevel) >= 4 && !filled(attack.defenseStrategy)).length,
    0,
  )
  const counterScore = claims.length === 0
    ? 0
    : defenseCoverage * 55 + Math.min(25, attacksTotal * 4) + Math.min(20, cards.filter(card => filled(card.counterWarning)).length * 5) - Math.min(30, undefendedCritical * 12)

  const scores = {
    logic: clamp01to100(logic),
    evidence: clamp01to100(evidenceScore),
    persuasiveness: clamp01to100(persuasion),
    innovation: clamp01to100(innovation),
    counterResilience: clamp01to100(counterScore),
  }
  const overall = Math.round(EVALUATION_DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension.key] * dimension.weight, 0))
  const notes = {
    logic: `论点 ${claims.length} 个，叶子论点 ${claimsWithoutChild} 个，悬空节点 ${orphans} 个`,
    evidence: `论点证据覆盖 ${Math.round(coverage * 100)}%，已挂卡片 ${linkedCards.length} 张，均可信度 ${avgCredibility.toFixed(1)}`,
    persuasiveness: `价值节点 ${counts.attitude}、主体节点 ${counts.crowd}、比较节点 ${counts.compare}`,
    innovation: `使用 ${typesUsed.size}/9 类论证节点，证据类型 ${evidenceTypes.size}/3 类`,
    counterResilience: `论点防守覆盖 ${Math.round(defenseCoverage * 100)}%，攻击路径 ${attacksTotal} 条，无防守的高威胁攻击 ${undefendedCritical} 条`,
  }
  return { scores, overall, notes }
}

/**
 * 完整分析：缺口 + 五维 + 建议。
 *
 * @param {any} bundle 归一后的 bundle
 * @returns {any} 分析报告
 */
export function analyze(bundle) {
  const index = treeIndex(bundle)
  const gaps = [
    ...topicGaps(Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined),
    ...treeGaps(bundle, index),
    ...evidenceGaps(bundle, index),
    ...attackGaps(bundle, index),
  ]
  const evaluation = evaluateDimensions(bundle, index, gaps)
  const errors = gaps.filter(item => item.level === 'error').length
  const warnings = gaps.filter(item => item.level === 'warn').length
  const penalty = gaps.reduce((sum, item) => sum + (LEVEL_COST[item.level] ?? 0), 0)
  const readiness = clamp01to100(evaluation.overall - Math.min(45, penalty))
  const suggestions = buildSuggestions(gaps, evaluation)
  return {
    readiness,
    blocking: errors,
    warnings,
    gaps,
    scores: { ...evaluation.scores, overall: evaluation.overall },
    notes: evaluation.notes,
    stats: {
      tree: nodeStats(index),
      evidence: {
        cards: (bundle.evidenceCards ?? []).length,
        links: (bundle.nodeEvidenceLinks ?? []).length,
        used: new Set((bundle.nodeEvidenceLinks ?? []).map(link => link.evidenceCardId)).size,
      },
      attack: {
        boxes: (bundle.attackDefenseBoxes ?? []).length,
        attacks: (bundle.attackDefenseBoxes ?? []).reduce((sum, box) => sum + (box.attacks ?? []).length, 0),
      },
      manuscripts: (bundle.manuscripts ?? []).length,
      evaluations: (bundle.aiEvaluations ?? []).length,
    },
    suggestions,
  }
}

/** 从缺口推导可执行建议（去重、按优先级）。 */
function buildSuggestions(gaps, evaluation) {
  const suggestions = []
  const order = { error: 0, warn: 1, info: 2 }
  const sorted = [...gaps].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3))
  const seen = new Set()
  for (const item of sorted) {
    const key = item.code
    if (seen.has(key)) continue
    seen.add(key)
    suggestions.push(`[${item.level}] ${item.message}`)
    if (suggestions.length >= 8) break
  }
  const weakest = Object.entries(evaluation.scores).sort((a, b) => a[1] - b[1])[0]
  if (weakest !== undefined && weakest[1] < 60) {
    const label = EVALUATION_DIMENSIONS.find(dimension => dimension.key === weakest[0])?.label ?? weakest[0]
    suggestions.push(`最弱维度是「${label}」（${weakest[1]} 分），优先补这一维收益最大。`)
  }
  return suggestions
}

/** 苏格拉底追问：扫描薄弱点，产出候选问题（由模型挑一个问用户）。 */
export function socraticQuestions(bundle) {
  const index = treeIndex(bundle)
  const questions = []
  for (const node of index.nodes) {
    if (node.type !== 'claim') continue
    const children = index.children.get(node.id) ?? []
    if (children.length === 0) {
      questions.push({
        nodeId: node.id,
        triggerType: 'missing_child',
        question: `「${nodeLabel(node)}」这个论点，靠哪些子论点来支撑？如果评委只问一句「凭什么」，你会怎么答？`,
      })
    }
    const linked = index.linksByNode.get(node.id) ?? []
    if (linked.length === 0) {
      questions.push({
        nodeId: node.id,
        triggerType: 'missing_evidence',
        question: `「${nodeLabel(node)}」最有力的一条证据是什么？来源是什么、样本和口径是什么？`,
      })
    }
  }
  const claims = index.nodes.filter(node => node.type === 'claim' && filled(node.data?.label))
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const a = claims[left]
      const b = claims[right]
      if (a.data.label === b.data.label) {
        questions.push({
          nodeId: b.id,
          triggerType: 'logic_conflict',
          question: `「${nodeLabel(a)}」与「${nodeLabel(b)}」看起来是同一个论点，它们是否重复？能不能合并？`,
        })
      }
    }
  }
  return questions.slice(0, 10)
}
