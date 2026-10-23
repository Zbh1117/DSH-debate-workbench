/**
 * 辩论备赛工作台 —— 渲染层（Markdown）。
 *
 * 所有面向人的文本都在这里生成：论证树大纲、整案归档、一辩/结辩/驳论稿。
 * 保持纯函数（bundle → 字符串），面板、工具与导出共用同一套输出，
 * 避免「面板看到的内容」和「导出的内容」不一致。
 *
 * @module dsh-debate-workbench/markdown
 */
import { EVALUATION_DIMENSIONS, NODE_TYPE_CONFIGS, filled } from './model.js'
import { treeIndex } from './checks.js'

/** 立场中文名。 */
export function sideLabel(side) {
  return side === 'pro' ? '正方' : side === 'con' ? '反方' : '立场未定'
}

/** 节点类型中文名。 */
export function nodeTypeLabel(type) {
  return NODE_TYPE_CONFIGS.find(item => item.type === type)?.label ?? type
}

/** 证据类型中文名。 */
function evidenceTypeLabel(type) {
  return { data: '数据', case: '案例', theory: '机理' }[type] ?? type
}

/** 攻击类型中文名。 */
function attackTypeLabel(type) {
  return { factual: '事实', logical: '逻辑', value: '价值' }[type] ?? type
}

/** 占位符。 */
function or(value, placeholder = '〔待补〕') {
  return filled(value) ? value.trim() : placeholder
}

/** 证据规范引用行。 */
export function citationOf(card) {
  const title = or(card.title, '未命名证据')
  const quote = filled(card.originalText) ? `「${card.originalText.trim()}」` : filled(card.content) ? card.content.trim() : ''
  const meta = [card.source, card.year].filter(filled).join('，')
  const url = filled(card.url) ? ` · ${card.url.trim()}` : ''
  return `[${card.id}] ${quote === '' ? title : `${quote}——${title}`}${meta === '' ? '' : `（${meta}）`}${url}`
}

/**
 * 按 BFS 输出论证树大纲（缩进 + 节点详情 + 证据 + 攻防摘要）。
 *
 * @param {any} bundle 归一后的 bundle
 * @returns {string} Markdown
 */
export function renderTreeMarkdown(bundle) {
  const index = treeIndex(bundle)
  if (index.nodes.length === 0) return '_论证树为空。_'
  const lines = []
  const seen = new Set()
  const walk = (node, depth) => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    const indent = '  '.repeat(depth)
    const badge = nodeTypeLabel(node.type)
    lines.push(`${indent}- **${badge}**：${or(node.data?.label)}`)
    if (filled(node.data?.description)) lines.push(`${indent}  - 说明：${node.data.description.trim()}`)
    if (node.data?.details !== null && typeof node.data?.details === 'object') {
      for (const [key, value] of Object.entries(node.data.details)) {
        if (filled(value)) lines.push(`${indent}  - ${key}：${value}`)
      }
    }
    for (const link of index.linksByNode.get(node.id) ?? []) {
      const card = index.cardsById.get(link.evidenceCardId)
      if (card !== undefined) lines.push(`${indent}  - 证据 ${citationOf(card)}${filled(link.note) ? `（${link.note}）` : ''}`)
    }
    const box = index.boxesByNode.get(node.id)
    if (box !== undefined && (box.attacks ?? []).length > 0) {
      lines.push(`${indent}  - 攻防（${box.attacks.length} 条）：`)
      for (const attack of box.attacks) {
        lines.push(`${indent}    - [${attackTypeLabel(attack.type)}｜威胁 ${attack.threatLevel}/5] ${or(attack.content)} → ${or(attack.defenseStrategy, '〔未写防守〕')}`)
      }
    }
    for (const childId of index.children.get(node.id) ?? []) {
      const child = index.byId.get(childId)
      if (child !== undefined) walk(child, depth + 1)
    }
  }
  const roots = index.roots.length > 0 ? index.roots : [index.nodes[0]]
  for (const root of roots) walk(root, 0)
  for (const node of index.nodes) {
    if (!seen.has(node.id)) walk(node, 0)
  }
  return lines.join('\n')
}

/** 渲染拆题结果。 */
export function renderDecompositionMarkdown(decomposition) {
  if (decomposition === undefined || decomposition === null) return '_尚未拆题。_'
  const lines = []
  if (filled(decomposition.judgeQuestion)) lines.push(`**裁判问题**：${decomposition.judgeQuestion}`, '')
  if (filled(decomposition.motionType)) lines.push(`**题目类型**：${decomposition.motionType}`, '')
  const concepts = Array.isArray(decomposition.coreConcepts) ? decomposition.coreConcepts : []
  if (concepts.length > 0) {
    lines.push('## 核心概念')
    for (const concept of concepts) {
      lines.push(`- **${or(concept?.term)}**：字面 ${or(concept?.literalDefinition, '—')}；建议界定：${or(concept?.suggestedDefinition)}`)
      const alternatives = Array.isArray(concept?.possibleInterpretations) ? concept.possibleInterpretations.filter(filled) : []
      if (alternatives.length > 0) lines.push(`  - 其它解释：${alternatives.join(' / ')}`)
      if (filled(concept?.counterDefinition)) lines.push(`  - 对方可能界定：${concept.counterDefinition}`)
    }
    lines.push('')
  }
  const points = Array.isArray(decomposition.controversialPoints) ? decomposition.controversialPoints : []
  if (points.length > 0) {
    lines.push('## 争议焦点')
    for (const point of points) {
      lines.push(`- **${or(point?.issue)}**：正 ${or(point?.proView, '—')}｜反 ${or(point?.conView, '—')}${filled(point?.keyBattle) ? `｜关键交锋：${point.keyBattle}` : ''}`)
    }
    lines.push('')
  }
  const battlefields = Array.isArray(decomposition.battlefields) ? decomposition.battlefields : []
  if (battlefields.length > 0) {
    lines.push('## 战场')
    for (const battlefield of battlefields) {
      lines.push(`- [${battlefield?.priority ?? '-'}] **${or(battlefield?.battlefield)}**：${or(battlefield?.whyItMatters, '—')}｜我方推进：${or(battlefield?.ourPush, '—')}｜对方推进：${or(battlefield?.opponentPush, '—')}`)
    }
    lines.push('')
  }
  const framework = decomposition.comparisonFramework
  if (framework !== undefined && Array.isArray(framework?.criteria) && framework.criteria.length > 0) {
    lines.push('## 比较框架')
    if (filled(framework.overallPlatform)) lines.push(`平台：${framework.overallPlatform}`)
    for (const criterion of framework.criteria) {
      lines.push(`- **${or(criterion?.dimension)}**：我方 ${or(criterion?.ourStandard, '—')}｜对方 ${or(criterion?.opponentStandard, '—')}｜裁判捷径：${or(criterion?.judgeShortcut, '—')}`)
    }
    lines.push('')
  }
  const premises = Array.isArray(decomposition.hiddenPremises) ? decomposition.hiddenPremises : []
  if (premises.length > 0) {
    lines.push('## 隐藏前提')
    for (const premise of premises) {
      lines.push(`- **${or(premise?.premise)}**：${or(premise?.explanation, '—')}${filled(premise?.howToUse) ? `｜怎么用：${premise.howToUse}` : ''}`)
    }
    lines.push('')
  }
  const paths = Array.isArray(decomposition.argumentPaths) ? decomposition.argumentPaths : []
  if (paths.length > 0) {
    lines.push('## 双方论证路径')
    for (const path of paths) {
      lines.push(`- **${sideLabel(path?.side)}**：${or(path?.mainClaim)}`)
      for (const support of Array.isArray(path?.supportingPoints) ? path.supportingPoints : []) {
        if (filled(support)) lines.push(`  - ${support}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 整案归档 Markdown。
 *
 * @param {any} bundle 归一后的 bundle
 * @param {any} analysis analyze() 的结果
 * @returns {string} Markdown
 */
export function renderBundleMarkdown(bundle, analysis) {
  const project = bundle.project
  const lines = [
    `# 辩论备赛档案 · ${or(project?.title, '〔未命名辩题〕')}`,
    '',
    `- 持方：${sideLabel(project?.side)}`,
    `- 赛制：${project?.format ?? '—'}`,
    `- 就绪度：${analysis?.readiness ?? 0}/100（阻塞缺口 ${analysis?.blocking ?? 0} 项）`,
    `- 更新时间：${project?.updatedAt ?? '—'}`,
    '',
    '## 五维评估',
    '',
    '| 维度 | 分数 | 说明 |',
    '| --- | --- | --- |',
    ...EVALUATION_DIMENSIONS.map(dimension => `| ${dimension.label}（${Math.round(dimension.weight * 100)}%） | ${analysis?.scores?.[dimension.key] ?? 0} | ${analysis?.notes?.[dimension.key] ?? ''} |`),
    `| **综合** | **${analysis?.scores?.overall ?? 0}** | readiness ${analysis?.readiness ?? 0} |`,
    '',
    '## 拆题',
    '',
    renderDecompositionMarkdown(Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined),
    '## 论证树',
    '',
    renderTreeMarkdown(bundle),
    '',
    '## 证据卡库',
    '',
  ]
  const cards = bundle.evidenceCards ?? []
  if (cards.length === 0) lines.push('_证据库为空。_')
  for (const card of cards) {
    lines.push(`- [${evidenceTypeLabel(card.type)}｜可信度 ${card.credibility}/5｜${card.applicableSide}] ${citationOf(card)}${filled(card.counterWarning) ? `\n  - 反驳预警：${card.counterWarning}` : ''}`)
  }
  lines.push('', '## 待补缺口', '')
  const gaps = (analysis?.gaps ?? []).filter(item => item.level !== 'info')
  if (gaps.length === 0) lines.push('_没有必须补或建议补的缺口。_')
  for (const item of gaps) lines.push(`- ${item.level === 'error' ? '**必须补**' : '建议补'}：${item.message}`)
  lines.push('')
  const manuscripts = bundle.manuscripts ?? []
  if (manuscripts.length > 0) {
    lines.push('## 稿件')
    for (const manuscript of manuscripts) lines.push(`- ${manuscript.title}（${manuscript.fileName}，${manuscript.fileSize} bytes）`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 取第一个拆题结果里的我方路径。 */
function ourRoute(bundle) {
  const decomposition = Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined
  const detail = decomposition?.ourSideDetailedRoute
  if (detail === undefined || detail === null) return undefined
  return detail
}

/**
 * 组装一辩稿：立场 → 定义 → 标准 → 论点（证据/机制/预判）→ 价值。
 *
 * @param {any} bundle 归一后的 bundle
 * @returns {string} Markdown
 */
export function composeOpening(bundle) {
  const index = treeIndex(bundle)
  const project = bundle.project
  const decomposition = Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined
  const route = ourRoute(bundle)
  const stance = index.nodes.find(node => node.type === 'stance')
  const claims = index.nodes.filter(node => node.type === 'claim')
  const values = index.nodes.filter(node => node.type === 'attitude')
  const lines = [
    `# 一辩稿 · ${or(project?.title)}（${sideLabel(project?.side)}）`,
    '',
    '> 由论证树、证据卡与拆题结果自动组装；〔待补〕处需要补写。',
    '',
    '## 问候与立场声明',
    '',
    or(stance?.data?.description ?? stance?.data?.label ?? route?.thesis, `谢谢主席，我方立场是：${or(project?.title)}。`),
    '',
    '## 定义',
    '',
  ]
  const concepts = Array.isArray(decomposition?.coreConcepts) ? decomposition.coreConcepts : []
  if (concepts.length === 0) lines.push('- 〔待补〕核心术语定义')
  for (const concept of concepts) {
    lines.push(`- **${or(concept?.term)}**：${or(concept?.suggestedDefinition)}`)
  }
  lines.push('', '## 裁判标准', '')
  const criteria = Array.isArray(decomposition?.comparisonFramework?.criteria) ? decomposition.comparisonFramework.criteria : []
  if (criteria.length === 0) lines.push('〔待补〕裁判标准')
  for (const criterion of criteria) {
    lines.push(`- ${or(criterion?.dimension)}：我方主张 ${or(criterion?.ourStandard, '—')}`)
  }
  lines.push('')
  if (claims.length === 0) lines.push('## 主体论证', '', '〔待补〕论点', '')
  for (const [position, claim] of claims.entries()) {
    lines.push(`## 论点${position + 1}：${or(claim.data?.label)}`, '')
    lines.push(`**机制**：${or(claim.data?.description)}`, '')
    const links = index.linksByNode.get(claim.id) ?? []
    if (links.length === 0) {
      lines.push('**证据**：〔待补〕', '')
    } else {
      lines.push('**证据**：', '')
      for (const link of links) {
        const card = index.cardsById.get(link.evidenceCardId)
        if (card !== undefined) lines.push(`- ${citationOf(card)}${filled(link.note) ? `（${link.note}）` : ''}`)
      }
      lines.push('')
    }
    const box = index.boxesByNode.get(claim.id)
    const attacks = box?.attacks ?? []
    if (attacks.length === 0) {
      lines.push('**预判并回应**：〔待补〕', '')
    } else {
      lines.push('**预判并回应**：', '')
      for (const attack of attacks) {
        lines.push(`- 对方可能说：${or(attack.content)}。我方回应：${or(attack.defenseStrategy, '〔待补〕')}`)
      }
      lines.push('')
    }
    const compare = (index.children.get(claim.id) ?? []).find(id => index.byId.get(id)?.type === 'compare')
    if (compare !== undefined) {
      const node = index.byId.get(compare)
      lines.push(`**比较**：${or(node?.data?.description ?? node?.data?.label)}`, '')
    }
  }
  lines.push('## 价值升华', '')
  if (values.length === 0) lines.push('〔待补〕价值收束：回到裁判问题，明确这一票为什么给我方。')
  for (const value of values) lines.push(or(value.data?.description ?? value.data?.label), '')
  return lines.join('\n')
}

/**
 * 组装结辩稿：战场收束 → 逐点裁决 → 价值升华。
 *
 * @param {any} bundle 归一后的 bundle
 * @returns {string} Markdown
 */
export function composeClosing(bundle) {
  const index = treeIndex(bundle)
  const project = bundle.project
  const decomposition = Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined
  const claims = index.nodes.filter(node => node.type === 'claim')
  const values = index.nodes.filter(node => node.type === 'attitude')
  const lines = [
    `# 结辩稿 · ${or(project?.title)}（${sideLabel(project?.side)}）`,
    '',
    '## 战场收束',
    '',
  ]
  const points = Array.isArray(decomposition?.controversialPoints) ? decomposition.controversialPoints : []
  if (points.length === 0) lines.push('这场比赛真正的争议是：〔待补〕')
  for (const point of points) lines.push(`- ${or(point?.issue)}：关键交锋在 ${or(point?.keyBattle, '〔待补〕')}`)
  lines.push('', '## 逐点裁决', '')
  if (claims.length === 0) lines.push('〔待补〕逐点列出交锋结果')
  for (const claim of claims) {
    const box = index.boxesByNode.get(claim.id)
    const attacks = box?.attacks ?? []
    const defended = attacks.filter(attack => filled(attack.defenseStrategy)).length
    lines.push(`- **${or(claim.data?.label)}**：机制${filled(claim.data?.description) ? '已交代' : '〔待补〕'}；证据 ${(index.linksByNode.get(claim.id) ?? []).length} 条；攻防 ${defended}/${attacks.length} 条已备答案`)
  }
  lines.push('', '## 价值升华', '')
  if (values.length === 0) lines.push('〔待补〕综合事实与逻辑后的价值判断。')
  for (const value of values) lines.push(or(value.data?.description ?? value.data?.label), '')
  return lines.join('\n')
}

/**
 * 组装驳论清单：对方路径 + 我方每个论点的预判攻防。
 *
 * @param {any} bundle 归一后的 bundle
 * @returns {string} Markdown
 */
export function composeRebuttal(bundle) {
  const index = treeIndex(bundle)
  const project = bundle.project
  const decomposition = Array.isArray(bundle.decompositionResults) ? bundle.decompositionResults[0] : undefined
  const opposite = project?.side === 'pro' ? 'con' : 'pro'
  const paths = (Array.isArray(decomposition?.argumentPaths) ? decomposition.argumentPaths : []).filter(path => path?.side === opposite)
  const lines = [`# 驳论清单 · ${or(project?.title)}（${sideLabel(project?.side)}）`, '', '## 对方可能立论', '']
  if (paths.length === 0) lines.push('〔待补〕对方最可能的立论路径')
  for (const path of paths) {
    lines.push(`- **${or(path?.mainClaim)}**`)
    for (const support of Array.isArray(path?.supportingPoints) ? path.supportingPoints : []) {
      if (filled(support)) lines.push(`  - ${support}`)
    }
  }
  lines.push('', '## 预先准备的反驳', '')
  let count = 0
  for (const claim of index.nodes.filter(node => node.type === 'claim')) {
    const box = index.boxesByNode.get(claim.id)
    for (const attack of box?.attacks ?? []) {
      count += 1
      lines.push(`- 针对「${or(claim.data?.label)}」：对方说「${or(attack.content)}」→ ${or(attack.defenseStrategy, '〔待补〕')}`)
    }
  }
  if (count === 0) lines.push('〔待补〕先在攻防框里写预判，再回来生成驳论清单。')
  const targets = Array.isArray(decomposition?.rebuttalTargets) ? decomposition.rebuttalTargets : []
  if (targets.length > 0) {
    lines.push('', '## 拆题给出的反驳靶点', '')
    for (const target of targets) {
      lines.push(`- 靶点：${or(target?.target)}｜攻击路径：${or(target?.attackPath, '—')}｜注意：${or(target?.watchout, '—')}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** 按稿件类型分派。 */
export function composeManuscript(kind, bundle) {
  switch (kind) {
    case 'opening':
      return composeOpening(bundle)
    case 'closing':
      return composeClosing(bundle)
    case 'rebuttal':
      return composeRebuttal(bundle)
    default:
      throw new Error(`未知稿件类型 ${JSON.stringify(kind)}，可用 opening / closing / rebuttal`)
  }
}
