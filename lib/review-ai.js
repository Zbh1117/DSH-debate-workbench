/**
 * 复盘 AI 层：提示词构建与模型输出清洗。
 *
 * 三个动作：
 *  1. 判比赛（三票制）：印象票 / 环节票 / 决胜票 → judge 结构
 *  2. 环节复盘：phaseReview 数组
 *  3. 证据候选：evidenceCandidates（pending，必须人工/检索核验后才入库）
 *
 * 所有输出都经过清洗与校验，模型不给理由 / 票不完整 / 环节缺失时直接报错，
 * 不把半成品写进复盘记录。
 *
 * @module dsh-debate-workbench/review-ai
 */
import { filled } from './model.js'
import { JUDGE_SKILL_CONTENT } from './judge-skill.js'
import { formatSeconds } from './transcript.js'

/** 视角中文名。 */
export const PERSPECTIVE_LABELS = {
  'white-paper': '白纸评委',
  argument: '论点裁',
  technical: '技术裁',
  value: '价值裁',
  situational: '情境裁',
}

/** 允许的评委视角。 */
export const PERSPECTIVES = Object.keys(PERSPECTIVE_LABELS)

/** 转写内容进 prompt 的字符上限（超出时保留开头+结尾，避免丢关键交锋）。 */
const MAX_TRANSCRIPT_CHARS = 40000

/** 简单截断。 */
function clip(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}…（已截断 ${text.length - limit} 字）`
}

/** 字符串数组清洗。 */
function stringList(value, limit = 30) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(item => item !== '')
    .slice(0, limit)
}

/** 对象数组清洗。 */
function objectList(value, limit = 100) {
  if (!Array.isArray(value)) return []
  return value.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item)).slice(0, limit)
}

/** 侧别校验。 */
function sideOf(value) {
  return value === 'pro' || value === 'con' ? value : undefined
}

/**
 * 把复盘转写拼成带时间戳/环节的文本（供 prompt 使用）。
 *
 * @param {any} review 复盘记录
 * @returns {string} 文本
 */
export function transcriptForPrompt(review) {
  const segments = Array.isArray(review?.transcript?.segments) ? review.transcript.segments : []
  if (segments.length === 0) {
    const text = String(review?.transcript?.text ?? '').trim()
    return clip(text, MAX_TRANSCRIPT_CHARS)
  }
  const lines = []
  let lastPhase
  for (const segment of segments) {
    if (filled(segment.phase) && segment.phase !== lastPhase) {
      lines.push(`\n【${segment.phase}】`)
      lastPhase = segment.phase
    }
    const stamp = Number.isFinite(Number(segment.start)) ? `[${formatSeconds(segment.start)}] ` : ''
    lines.push(`${stamp}${String(segment.text ?? '').trim()}`)
  }
  const joined = lines.filter(line => line !== '').join('\n')
  return clip(joined, MAX_TRANSCRIPT_CHARS)
}

/** 复盘基础信息（题目、持方、赛制、日期）。 */
function reviewHeader(review) {
  const lines = [
    `复盘：${review.title}`,
    `日期：${review.date}`,
    review.opponent === '' ? '' : `对手：${review.opponent}`,
    `我方持方：${review.ourSide === 'con' ? '反方' : '正方'}`,
    `赛制：${review.format}`,
  ]
  return lines.filter(line => line !== '').join('\n')
}

/** 判比赛 JSON schema 文本（给模型看）。 */
const JUDGE_SCHEMA = `{
  "votes": { "impression": "pro|con", "phase": "pro|con", "decision": "pro|con" },
  "reasons": {
    "impression": "印象票理由（整体架构比较）",
    "phase": "环节票理由（各环节谁占优）",
    "decision": "决胜票理由（论证留存度）"
  },
  "architecture": { "pro": "我方架构简述", "con": "对方架构简述", "compared": "架构比较结论" },
  "argumentSurvival": [
    { "argument": "核心论证", "side": "pro|con", "survived": true, "afterClash": "交锋后状态" }
  ],
  "decisiveClashes": [
    { "clash": "关键交锋", "judgedFor": "pro|con", "why": "为什么这么判" }
  ],
  "minimalMargin": "如果比赛接近，说明决定性的那一票/一分在哪里（不接近可写空字符串）",
  "scores": { "pro": 0, "con": 0 }
}
要求：三票必须全部给出；每票理由至少 60 字且引用转写内容；argumentSurvival 双方合计至少 4 条；decisiveClashes 至少 2 条。scores 仅在要求分数模式时填写，否则可为空。`

/**
 * 构建「判比赛」提示词。
 *
 * @param {any} review 复盘记录
 * @param {{ perspective: string, mode?: 'votes'|'score' }} options 选项
 * @returns {{ system: string, prompt: string }} 提示词
 */
export function buildJudgePrompt(review, options) {
  const perspective = options?.perspective
  const label = PERSPECTIVE_LABELS[perspective] ?? perspective
  const mode = options?.mode === 'score' ? 'score' : 'votes'
  const system = [
    JUDGE_SKILL_CONTENT,
    '',
    '## 本次任务的输出格式',
    '只输出一个 JSON 对象，不要任何解释文字。字段如下：',
    JUDGE_SCHEMA,
    '',
    `本次评委视角：${label}（${perspective}）。请按该视角的偏好投票。`,
  ].join('\n')
  const prompt = [
    reviewHeader(review),
    '',
    '## 比赛转写',
    transcriptForPrompt(review),
    '',
    `## 任务`,
    `请以「${label}」视角判这场比赛，输出 JSON。`,
    mode === 'score' ? '同时给出双方分数（scores），但胜负仍以三票为准。' : '不需要给分数，胜负以三票为准。',
  ].join('\n')
  return { system, prompt, mode }
}

/**
 * 清洗「判比赛」候选。返回 judge 结构与错误列表。
 *
 * @param {any} candidate 模型 JSON
 * @param {{ perspective: string, mode?: 'votes'|'score' }} options 选项
 * @returns {{ judge: any, errors: string[] }} 结果
 */
export function normalizeJudgeCandidate(candidate, options) {
  const input = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
  const errors = []
  const perspective = options?.perspective
  if (!PERSPECTIVES.includes(perspective)) errors.push(`评委视角非法：${perspective}`)
  const mode = options?.mode === 'score' ? 'score' : 'votes'
  const votesInput = input.votes !== null && typeof input.votes === 'object' ? input.votes : {}
  const votes = {
    impression: sideOf(votesInput.impression),
    phase: sideOf(votesInput.phase),
    decision: sideOf(votesInput.decision),
  }
  const missingVotes = Object.entries(votes).filter(([, side]) => side === undefined).map(([key]) => key)
  if (missingVotes.length > 0) errors.push(`三票必须全部给出，缺少：${missingVotes.join(' / ')}`)
  const reasonsInput = input.reasons !== null && typeof input.reasons === 'object' ? input.reasons : {}
  const reasons = {
    impression: filled(reasonsInput.impression) ? String(reasonsInput.impression).trim() : '',
    phase: filled(reasonsInput.phase) ? String(reasonsInput.phase).trim() : '',
    decision: filled(reasonsInput.decision) ? String(reasonsInput.decision).trim() : '',
  }
  for (const key of ['impression', 'phase', 'decision']) {
    if (reasons[key].length < 20) errors.push(`${key} 票理由过短或缺失（至少 20 字）`)
  }
  const voteList = [votes.impression, votes.phase, votes.decision].filter(side => side !== undefined)
  const proCount = voteList.filter(side => side === 'pro').length
  const conCount = voteList.filter(side => side === 'con').length
  const winner = proCount === conCount ? undefined : proCount > conCount ? 'pro' : 'con'
  if (winner === undefined && voteList.length === 3) errors.push('三票出现 1:1:1 或平票，需按规则重新判定')
  const voteCount = voteList.length === 3 ? `${Math.max(proCount, conCount)}:${Math.min(proCount, conCount)}` : undefined
  const architectureInput = input.architecture !== null && typeof input.architecture === 'object' ? input.architecture : {}
  const survival = objectList(input.argumentSurvival, 20)
    .map(item => ({
      argument: filled(item.argument) ? String(item.argument).trim() : '',
      side: sideOf(item.side) ?? 'pro',
      survived: item.survived === true,
      afterClash: filled(item.afterClash) ? String(item.afterClash).trim() : '',
    }))
    .filter(item => item.argument !== '')
  if (survival.length < 4) errors.push(`论证留存度条目过少（${survival.length} 条，至少 4 条）`)
  const clashes = objectList(input.decisiveClashes, 10)
    .map(item => ({
      clash: filled(item.clash) ? String(item.clash).trim() : '',
      judgedFor: sideOf(item.judgedFor) ?? 'pro',
      why: filled(item.why) ? String(item.why).trim() : '',
    }))
    .filter(item => item.clash !== '')
  if (clashes.length < 2) errors.push(`关键交锋裁决过少（${clashes.length} 条，至少 2 条）`)
  const scoresInput = input.scores !== null && typeof input.scores === 'object' ? input.scores : undefined
  const scores =
    mode === 'score' && scoresInput !== undefined && Number.isFinite(Number(scoresInput.pro)) && Number.isFinite(Number(scoresInput.con))
      ? { pro: Number(scoresInput.pro), con: Number(scoresInput.con) }
      : undefined
  const judge = {
    perspective,
    mode,
    winner,
    votes,
    voteCount,
    reasons,
    architecture: {
      pro: filled(architectureInput.pro) ? String(architectureInput.pro).trim() : '',
      con: filled(architectureInput.con) ? String(architectureInput.con).trim() : '',
      compared: filled(architectureInput.compared) ? String(architectureInput.compared).trim() : '',
    },
    argumentSurvival: survival,
    decisiveClashes: clashes,
    minimalMargin: filled(input.minimalMargin) ? String(input.minimalMargin).trim() : '',
    scores,
    disclaimer: '模拟评委意见，非真实裁判结论',
  }
  return { judge, errors }
}

/** 环节复盘 JSON schema 文本。 */
const PHASE_SCHEMA = `{
  "phaseReview": [
    {
      "phase": "环节名（立论/质询/自由辩论/结辩）",
      "summary": "该环节发生了什么、胜负手（80 字以上）",
      "findings": [
        { "at": "03:12 或 环节内位置", "issue": "具体问题", "advice": "可执行建议" }
      ],
      "strengths": ["亮点"],
      "weaknesses": ["短板"],
      "drill": "该环节的针对性训练建议"
    }
  ]
}
要求：覆盖输入中给出的所有环节；每个环节至少 2 条 findings；findings 必须具体到能复述/演练。`

/**
 * 构建「环节复盘」提示词。
 *
 * @param {any} review 复盘记录
 * @param {{ phases?: string[] }} [options] 选项
 * @returns {{ system: string, prompt: string }} 提示词
 */
export function buildPhaseReviewPrompt(review, options = {}) {
  const phases = Array.isArray(options.phases) && options.phases.length > 0 ? options.phases : review.phases
  const system = [JUDGE_SKILL_CONTENT, '', '## 本次任务的输出格式', '只输出一个 JSON 对象，不要解释文字：', PHASE_SCHEMA].join('\n')
  const judgeText = review.judge === undefined
    ? '（还没有判比赛结果，请以环节实际表现独立复盘，不预设胜负）'
    : [
        `判比赛结论：${review.judge.winner === 'con' ? '反方' : '正方'}胜（${review.judge.voteCount ?? '三票'}）`,
        `印象票理由：${review.judge.reasons?.impression ?? ''}`,
        `环节票理由：${review.judge.reasons?.phase ?? ''}`,
        `决胜票理由：${review.judge.reasons?.decision ?? ''}`,
      ].join('\n')
  const prompt = [
    reviewHeader(review),
    `需要复盘的环节：${phases.join(' / ')}`,
    '',
    '## 判比赛参考',
    judgeText,
    '',
    '## 比赛转写',
    transcriptForPrompt(review),
    '',
    '## 任务',
    '请按上面列出的环节逐个复盘，输出 JSON。环节复盘必须与判比赛结论一致。',
  ].join('\n')
  return { system, prompt }
}

/**
 * 清洗环节复盘候选。
 *
 * @param {any} candidate 模型 JSON
 * @param {{ phases?: string[] }} [options] 选项
 * @returns {{ phaseReview: Array<any>, errors: string[] }} 结果
 */
export function normalizePhaseReviewCandidate(candidate, options = {}) {
  const input = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
  const errors = []
  const expected = Array.isArray(options.phases) && options.phases.length > 0 ? options.phases : undefined
  const phaseReview = objectList(input.phaseReview, 20)
    .map(item => {
      const phase = filled(item.phase) ? String(item.phase).trim() : ''
      if (phase === '') return undefined
      const findings = objectList(item.findings, 20)
        .map(finding => ({
          at: filled(finding.at) ? String(finding.at).trim() : undefined,
          issue: filled(finding.issue) ? String(finding.issue).trim() : '',
          advice: filled(finding.advice) ? String(finding.advice).trim() : '',
        }))
        .filter(finding => finding.issue !== '')
      return {
        phase,
        summary: filled(item.summary) ? String(item.summary).trim() : '',
        findings,
        strengths: stringList(item.strengths, 10),
        weaknesses: stringList(item.weaknesses, 10),
        drill: filled(item.drill) ? String(item.drill).trim() : '',
      }
    })
    .filter(item => item !== undefined)
  if (phaseReview.length === 0) errors.push('没有可用的环节复盘')
  for (const phase of phaseReview) {
    if (phase.summary.length < 20) errors.push(`环节「${phase.phase}」summary 过短`)
    if (phase.findings.length < 2) errors.push(`环节「${phase.phase}」findings 少于 2 条`)
  }
  if (expected !== undefined) {
    const got = new Set(phaseReview.map(item => item.phase))
    const missing = expected.filter(name => !got.has(name))
    if (missing.length > 0) errors.push(`缺少环节：${missing.join(' / ')}`)
  }
  return { phaseReview, errors }
}

/** 证据候选 JSON schema 文本。 */
const EVIDENCE_SCHEMA = `{
  "evidenceCandidates": [
    {
      "type": "data|case|theory",
      "claim": "比赛中的具体陈述或需要补的证据点（引用原话）",
      "need": "缺失/待核验/可入库（理论）",
      "searchKeywords": ["检索关键词"]
    }
  ]
}
要求：只提取转写中真实出现的内容或复盘发现的缺口；不得编造数据、年份、机构、论文标题；最多 12 条。`

/**
 * 构建「证据候选」提示词。
 *
 * @param {any} review 复盘记录
 * @returns {{ system: string, prompt: string }} 提示词
 */
export function buildEvidencePrompt(review) {
  const system = [
    JUDGE_SKILL_CONTENT,
    '',
    '## 本次任务：提取证据候选（不是写证据）',
    '你只负责从比赛/复盘里找出「需要核验或补充的数据、案例、机理」，并给出检索关键词。',
    '硬规则：不得编造任何数据、年份、机构、论文标题、法条；没有把握的内容只写"需要核验"。',
    '只输出一个 JSON 对象：',
    EVIDENCE_SCHEMA,
  ].join('\n')
  const judgeText = review.judge === undefined ? '（无判比赛结果）' : `判比赛：${review.judge.winner === 'con' ? '反方' : '正方'}胜；决胜票理由：${review.judge.reasons?.decision ?? ''}`
  const phaseText = (Array.isArray(review.phaseReview) ? review.phaseReview : [])
    .map(phase => `- ${phase.phase}：${(phase.findings ?? []).map(finding => finding.issue).join('；')}`)
    .join('\n')
  const prompt = [
    reviewHeader(review),
    '',
    '## 判比赛',
    judgeText,
    '',
    '## 环节复盘要点',
    phaseText === '' ? '（无）' : phaseText,
    '',
    '## 比赛转写',
    transcriptForPrompt(review),
    '',
    '## 任务',
    '提取证据候选（data/case/theory）与需要补充的证据点，输出 JSON。',
  ].join('\n')
  return { system, prompt }
}

/**
 * 清洗证据候选。
 *
 * @param {any} candidate 模型 JSON
 * @returns {{ evidenceCandidates: Array<any>, errors: string[] }} 结果
 */
export function normalizeEvidenceCandidates(candidate) {
  const input = candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
  const errors = []
  const evidenceCandidates = objectList(input.evidenceCandidates, 12)
    .map(item => {
      const claim = filled(item.claim) ? String(item.claim).trim() : ''
      if (claim === '') return undefined
      const type = ['data', 'case', 'theory'].includes(item.type) ? item.type : 'data'
      return {
        id: `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        claim,
        need: filled(item.need) ? String(item.need).trim() : '待核验',
        searchKeywords: stringList(item.searchKeywords, 8),
        status: 'pending',
        verification: { url: '', source: '', note: '' },
        createdAt: new Date().toISOString(),
      }
    })
    .filter(item => item !== undefined)
  if (evidenceCandidates.length === 0) errors.push('模型没有返回可用的证据候选')
  return { evidenceCandidates, errors }
}
