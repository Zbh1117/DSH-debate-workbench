/**
 * 比赛复盘（Review）存储层。
 *
 * 复盘数据是 **sidecar 文件**，不写入 ProjectExportBundle，保证与 DebateWeaver 的
 * 导入导出完全兼容：
 *
 *   .debate/projects/<题目id>/
 *     reviews/<reviewId>.json        复盘记录（判比赛 + 环节复盘 + 证据候选）
 *     recordings/<reviewId>.<ext>    录音副本（体积大、隐私敏感，默认 gitignore）
 *     .debate/exports/reviews/<id>.md  导出的 Markdown（写在工作区 .debate 下）
 *
 * 判比赛采用**三票制**：印象票（整体架构比较）、环节票（环节表现）、决胜票（论证留存度），
 * 三票各自独立判并给出理由；分数制作为可选辅助。
 *
 * @module dsh-debate-workbench/review
 */
import fs from 'node:fs'
import path from 'node:path'
import { cloneJson, filled, now } from './model.js'
import { dataDir, projectDirPath, resolveProjectEntry } from './store.js'

/** 复盘记录子目录。 */
export const REVIEWS_DIR = 'reviews'
/** 录音子目录。 */
export const RECORDINGS_DIR = 'recordings'
/** 复盘格式版本。 */
export const REVIEW_VERSION = 1
/** 允许的评委视角（每次生成前必选）。 */
export const JUDGE_PERSPECTIVES = ['white-paper', 'argument', 'technical', 'value', 'situational']
/** 三票制的票类型。 */
export const VOTE_TYPES = ['impression', 'phase', 'decision']
/** 默认华语赛制环节。 */
export const DEFAULT_PHASES = ['立论', '质询', '自由辩论', '结辩']
/** 默认环节权重（仅作「环节票」内的比较依据，不用于直接判总分）。 */
export const DEFAULT_PHASE_WEIGHTS = { 立论: 25, 质询: 20, 自由辩论: 25, 结辩: 15, 整体: 15 }
/** 允许归档的音频扩展名。 */
export const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'ogg', 'webm', 'flac', 'aac']
/** 单个录音文件大小上限（500 MiB）。 */
export const MAX_AUDIO_BYTES = 500 * 1024 * 1024

/** 复盘目录（相对题目目录）。 */
export function reviewsDir(workspace, entry) {
  return path.join(projectDirPath(workspace, entry), REVIEWS_DIR)
}

/** 录音目录。 */
export function recordingsDir(workspace, entry) {
  return path.join(projectDirPath(workspace, entry), RECORDINGS_DIR)
}

/** 单条复盘文件路径。 */
export function reviewPath(workspace, entry, reviewId) {
  return path.join(reviewsDir(workspace, entry), `${reviewId}.json`)
}

/** 录音文件路径。 */
export function recordingPath(workspace, entry, reviewId, ext) {
  return path.join(recordingsDir(workspace, entry), `${reviewId}.${String(ext).replace(/^\./, '')}`)
}

/** 导出目录（工作区级）。 */
export function reviewExportDir(workspace) {
  return path.join(dataDir(workspace), 'exports', 'reviews')
}

/** 生成复盘 id。 */
export function newReviewId() {
  return `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 校验 reviewId 只含安全字符。 */
export function safeReviewId(reviewId) {
  const raw = typeof reviewId === 'string' ? reviewId.trim() : ''
  return /^[A-Za-z0-9._-]+$/.test(raw) ? raw : undefined
}

/** 取音频扩展名（小写，不带点）。 */
export function audioExtension(filePath) {
  const ext = path.extname(String(filePath ?? '')).replace(/^\./, '').toLowerCase()
  return AUDIO_EXTENSIONS.includes(ext) ? ext : undefined
}

/** 生成一个空的三票制判比赛结构（占位，M4 由模型填充）。 */
export function emptyJudge() {
  return {
    perspective: undefined,
    mode: 'votes',
    winner: undefined,
    votes: { impression: undefined, phase: undefined, decision: undefined },
    voteCount: undefined,
    reasons: { impression: '', phase: '', decision: '' },
    architecture: undefined,
    argumentSurvival: [],
    decisiveClashes: [],
    scores: undefined,
    disclaimer: '模拟评委意见，非真实裁判结论',
  }
}

/** 空复盘记录。 */
export function makeReview(input = {}) {
  const timestamp = now()
  const date = filled(input.date) ? String(input.date).trim() : timestamp.slice(0, 10)
  return {
    version: REVIEW_VERSION,
    id: safeReviewId(input.id) ?? newReviewId(),
    projectId: filled(input.projectId) ? String(input.projectId) : '',
    title: filled(input.title) ? String(input.title).trim() : '未命名复盘',
    date,
    opponent: filled(input.opponent) ? String(input.opponent).trim() : '',
    format: filled(input.format) ? String(input.format) : 'chinese',
    ourSide: input.ourSide === 'con' ? 'con' : 'pro',
    source: {
      kind: 'manual',
      audio: undefined,
      transcriptOrigin: 'manual',
    },
    rubric: {
      preset: 'chinese-default',
      weights: cloneJson(DEFAULT_PHASE_WEIGHTS),
    },
    phases: DEFAULT_PHASES.slice(),
    transcript: {
      text: filled(input.transcriptText) ? String(input.transcriptText) : '',
      segments: [],
      provider: undefined,
      audioSeconds: undefined,
      inferenceSeconds: undefined,
    },
    judge: undefined,
    phaseReview: [],
    overall: { verdict: '', strengths: [], weaknesses: [], actionItems: [] },
    evidenceCandidates: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
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

/**
 * 归一复盘记录：保留未知字段（向前兼容），补齐默认值并做类型清洗。
 *
 * @param {any} raw 原始 JSON
 * @returns {any} 归一后的复盘
 */
export function normalizeReview(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const base = makeReview(input)
  const transcriptInput = input.transcript !== null && typeof input.transcript === 'object' ? input.transcript : {}
  const judgeInput = input.judge !== null && typeof input.judge === 'object' && !Array.isArray(input.judge) ? input.judge : undefined
  const overallInput = input.overall !== null && typeof input.overall === 'object' ? input.overall : {}
  const normalized = {
    ...base,
    ...input,
    version: REVIEW_VERSION,
    id: safeReviewId(input.id) ?? base.id,
    projectId: filled(input.projectId) ? String(input.projectId) : base.projectId,
    title: filled(input.title) ? String(input.title).trim() : base.title,
    date: filled(input.date) ? String(input.date).trim() : base.date,
    opponent: filled(input.opponent) ? String(input.opponent).trim() : '',
    ourSide: input.ourSide === 'con' ? 'con' : 'pro',
    source: {
      ...(input.source !== null && typeof input.source === 'object' ? input.source : {}),
      kind: ['audio', 'transcript', 'audio+transcript', 'manual'].includes(input.source?.kind) ? input.source.kind : 'manual',
    },
    rubric: {
      ...base.rubric,
      ...(input.rubric !== null && typeof input.rubric === 'object' ? input.rubric : {}),
    },
    phases: stringList(input.phases, 12).length > 0 ? stringList(input.phases, 12) : base.phases,
    transcript: {
      ...transcriptInput,
      text: typeof transcriptInput.text === 'string' ? transcriptInput.text : '',
      segments: objectList(transcriptInput.segments, 5000).map(segment => ({
        start: Number.isFinite(Number(segment.start)) ? Number(segment.start) : undefined,
        end: Number.isFinite(Number(segment.end)) ? Number(segment.end) : undefined,
        phase: filled(segment.phase) ? String(segment.phase) : undefined,
        speaker: filled(segment.speaker) ? String(segment.speaker) : undefined,
        text: typeof segment.text === 'string' ? segment.text : '',
      })),
    },
    judge: judgeInput === undefined ? undefined : { ...emptyJudge(), ...judgeInput },
    phaseReview: objectList(input.phaseReview, 20),
    overall: {
      ...base.overall,
      ...overallInput,
      verdict: typeof overallInput.verdict === 'string' ? overallInput.verdict : '',
      strengths: stringList(overallInput.strengths),
      weaknesses: stringList(overallInput.weaknesses),
      actionItems: stringList(overallInput.actionItems),
    },
    evidenceCandidates: objectList(input.evidenceCandidates, 100),
    createdAt: filled(input.createdAt) ? String(input.createdAt) : base.createdAt,
    updatedAt: now(),
  }
  return normalized
}

/* ------------------------------------------------------------------ *
 * 存储读写
 * ------------------------------------------------------------------ */

/** 原子写 JSON。 */
function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, target)
}

/** 解析题目条目；找不到抛错。 */
function requireEntry(workspace, selector) {
  const entry = resolveProjectEntry(workspace, selector)
  if (entry === undefined) throw new Error('没有可用的题目：先 debate_project(action=create) 或指定 project')
  return entry
}

/** 读取单条复盘；不存在返回 undefined，损坏抛可读错误。 */
export function loadReview(workspace, selector, reviewId) {
  const id = safeReviewId(reviewId)
  if (id === undefined) throw new Error(`复盘 id 非法：${reviewId}`)
  const entry = requireEntry(workspace, selector)
  const target = reviewPath(workspace, entry, id)
  if (!fs.existsSync(target)) return undefined
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch (error) {
    throw new Error(`复盘文件损坏：${target}（${error instanceof Error ? error.message : String(error)}）`)
  }
  return normalizeReview(raw)
}

/** 保存复盘（覆盖写）。 */
export function saveReview(workspace, selector, review) {
  const entry = requireEntry(workspace, selector)
  const normalized = normalizeReview(review)
  normalized.projectId = entry.id
  normalized.updatedAt = now()
  const target = reviewPath(workspace, entry, normalized.id)
  writeJsonAtomic(target, normalized)
  return { review: normalized, path: target, projectId: entry.id }
}

/** 列出某个题目的复盘摘要（按更新时间倒序）。 */
export function listReviews(workspace, selector, options = {}) {
  const entry = requireEntry(workspace, selector)
  const dir = reviewsDir(workspace, entry)
  let names = []
  try {
    names = fs.readdirSync(dir).filter(name => name.endsWith('.json'))
  } catch {
    names = []
  }
  const includeAudio = options.includeAudio !== false
  const summaries = []
  for (const name of names) {
    const target = path.join(dir, name)
    try {
      const review = normalizeReview(JSON.parse(fs.readFileSync(target, 'utf8')))
      summaries.push({
        id: review.id,
        title: review.title,
        date: review.date,
        opponent: review.opponent,
        ourSide: review.ourSide,
        winner: review.judge?.winner,
        voteCount: review.judge?.voteCount,
        perspective: review.judge?.perspective,
        hasTranscript: review.transcript.text !== '',
        segmentCount: review.transcript.segments.length,
        phaseCount: review.phaseReview.length,
        evidenceCandidates: review.evidenceCandidates.length,
        hasAudio: includeAudio ? isRecordingPresent(workspace, entry, review) : false,
        updatedAt: review.updatedAt,
      })
    } catch {
      summaries.push({ id: name.replace(/\.json$/, ''), title: '（无法读取）', corrupt: true })
    }
  }
  return {
    projectId: entry.id,
    topic: entry.topic,
    reviews: summaries.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))),
  }
}

/** 判断录音是否还在。 */
export function isRecordingPresent(workspace, entry, review) {
  const audio = review?.source?.audio
  if (audio === undefined || audio === null || !filled(audio.file)) return false
  const target = path.join(projectDirPath(workspace, entry), String(audio.file))
  return fs.existsSync(target)
}

/**
 * 把外部音频复制进 recordings/（M2 用本地路径复制；M3 增加 HTTP 流式上传）。
 *
 * @returns {{ file: string, ext: string, bytes: number, absPath: string }} 录音元数据
 */
export function archiveRecordingFromFile(workspace, selector, reviewId, sourcePath) {
  const entry = requireEntry(workspace, selector)
  const id = safeReviewId(reviewId)
  if (id === undefined) throw new Error(`复盘 id 非法：${reviewId}`)
  const absolute = path.resolve(String(sourcePath ?? ''))
  if (!fs.existsSync(absolute)) throw new Error(`找不到音频文件：${absolute}`)
  const stat = fs.statSync(absolute)
  if (!stat.isFile()) throw new Error(`不是文件：${absolute}`)
  if (stat.size > MAX_AUDIO_BYTES) throw new Error(`音频超过 ${MAX_AUDIO_BYTES / 1024 / 1024} MiB 上限`)
  const ext = audioExtension(absolute)
  if (ext === undefined) throw new Error(`不支持的音频格式：${path.extname(absolute)}（支持 ${AUDIO_EXTENSIONS.join('/')}）`)
  const target = recordingPath(workspace, entry, id, ext)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(absolute, target)
  const relative = path.relative(projectDirPath(workspace, entry), target).replace(/\\/g, '/')
  return { file: relative, ext, bytes: stat.size, absPath: target, projectId: entry.id }
}

/** 删除复盘；默认同时删除录音。 */
export function deleteReview(workspace, selector, reviewId, options = {}) {
  const entry = requireEntry(workspace, selector)
  const id = safeReviewId(reviewId)
  if (id === undefined) throw new Error(`复盘 id 非法：${reviewId}`)
  const target = reviewPath(workspace, entry, id)
  const existed = fs.existsSync(target)
  if (existed) fs.rmSync(target, { force: true })
  let audioRemoved = false
  if (options.purgeAudio !== false) {
    const dir = recordingsDir(workspace, entry)
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${id}.`)) {
          fs.rmSync(path.join(dir, name), { force: true })
          audioRemoved = true
        }
      }
    } catch {
      audioRemoved = false
    }
  }
  return { existed, audioRemoved, projectId: entry.id }
}

/* ------------------------------------------------------------------ *
 * Markdown 渲染
 * ------------------------------------------------------------------ */

/** 视角中文名。 */
const PERSPECTIVE_LABELS = {
  'white-paper': '白纸评委',
  argument: '论点裁',
  technical: '技术裁',
  value: '价值裁',
  situational: '情境裁',
}

/** 票型中文名。 */
const VOTE_LABELS = { impression: '印象票', phase: '环节票', decision: '决胜票' }

/** 题目持方文本。 */
function sideLabel(side) {
  return side === 'con' ? '反方' : '正方'
}

/**
 * 渲染复盘 Markdown（M2 先支持已有数据的安全渲染；M4 的 AI 结果会填充同样的结构）。
 */
export function renderReviewMarkdown(review) {
  const judge = review.judge
  const lines = [`# 复盘：${review.title}`, '']
  lines.push(`- 日期：${review.date}`)
  if (review.opponent !== '') lines.push(`- 对手：${review.opponent}`)
  lines.push(`- 我方持方：${sideLabel(review.ourSide)}`)
  lines.push(`- 转写：${review.transcript.text === '' ? '未提供' : `${review.transcript.text.length} 字${review.transcript.segments.length > 0 ? `，${review.transcript.segments.length} 段` : ''}`}`)
  lines.push('')

  lines.push('## 一、判比赛')
  if (judge === undefined) {
    lines.push('（尚未生成判比赛结果）')
  } else {
    lines.push(`- 评委视角：${PERSPECTIVE_LABELS[judge.perspective] ?? judge.perspective ?? '未指定'}（模拟评委意见，非真实裁判结论）`)
    if (judge.winner !== undefined) lines.push(`- 判定：${sideLabel(judge.winner)}胜${judge.voteCount === undefined ? '' : ` · ${judge.voteCount}`}`)
    const votes = judge.votes ?? {}
    for (const type of VOTE_TYPES) {
      const side = votes[type]
      if (side === undefined || side === null) continue
      lines.push(`- ${VOTE_LABELS[type]}：${sideLabel(side)}${filled(judge.reasons?.[type]) ? ` —— ${judge.reasons[type]}` : ''}`)
    }
    if (judge.architecture !== undefined && (filled(judge.architecture?.pro) || filled(judge.architecture?.con))) {
      lines.push('', '### 整体架构比较')
      if (filled(judge.architecture?.pro)) lines.push(`- 我方架构：${judge.architecture.pro}`)
      if (filled(judge.architecture?.con)) lines.push(`- 对方架构：${judge.architecture.con}`)
      if (filled(judge.architecture?.compared)) lines.push(`- 比较结论：${judge.architecture.compared}`)
    }
    const survival = Array.isArray(judge.argumentSurvival) ? judge.argumentSurvival : []
    if (survival.length > 0) {
      lines.push('', '### 论证留存度')
      for (const item of survival) {
        lines.push(`- [${sideLabel(item.side)}] ${item.argument ?? ''}：${item.survived === true ? '存活' : item.survived === false ? '被打掉' : '未知'}${filled(item.afterClash) ? `（${item.afterClash}）` : ''}`)
      }
    }
    for (const reason of Array.isArray(judge.reasons) ? judge.reasons : []) {
      if (filled(reason)) lines.push(`- 理由：${reason}`)
    }
    const clashes = Array.isArray(judge.decisiveClashes) ? judge.decisiveClashes : []
    if (clashes.length > 0) {
      lines.push('', '### 关键交锋裁决')
      for (const clash of clashes) {
        lines.push(`- ${clash.clash ?? '交锋'}：判 ${sideLabel(clash.judgedFor)} 得点${filled(clash.why) ? `（${clash.why}）` : ''}`)
      }
    }
  }
  lines.push('')

  lines.push('## 二、环节复盘')
  const phaseReview = Array.isArray(review.phaseReview) ? review.phaseReview : []
  if (phaseReview.length === 0) {
    lines.push('（尚未生成环节复盘）')
  } else {
    for (const phase of phaseReview) {
      lines.push(`### ${phase.phase ?? '环节'}`)
      if (filled(phase.summary)) lines.push(phase.summary)
      const scores = phase.scores
      if (scores !== undefined && scores !== null) lines.push(`- 环节评分：我方 ${scores.pro ?? '-'} / 对方 ${scores.con ?? '-'}`)
      for (const finding of Array.isArray(phase.findings) ? phase.findings : []) {
        lines.push(`- ${filled(finding.at) ? `[${finding.at}] ` : ''}问题：${finding.issue ?? ''}${filled(finding.advice) ? `；建议：${finding.advice}` : ''}`)
      }
      for (const item of Array.isArray(phase.strengths) ? phase.strengths : []) lines.push(`- 亮点：${item}`)
      for (const item of Array.isArray(phase.weaknesses) ? phase.weaknesses : []) lines.push(`- 短板：${item}`)
      lines.push('')
    }
  }

  lines.push('## 三、改进清单')
  const overall = review.overall ?? {}
  if (filled(overall.verdict)) lines.push(`- 总评：${overall.verdict}`)
  for (const item of Array.isArray(overall.strengths) ? overall.strengths : []) lines.push(`- 优势：${item}`)
  for (const item of Array.isArray(overall.weaknesses) ? overall.weaknesses : []) lines.push(`- 短板：${item}`)
  for (const item of Array.isArray(overall.actionItems) ? overall.actionItems : []) lines.push(`- 待办：${item}`)
  lines.push('')

  const candidates = Array.isArray(review.evidenceCandidates) ? review.evidenceCandidates : []
  if (candidates.length > 0) {
    lines.push('## 四、证据候选（未核验不入库）')
    for (const candidate of candidates) {
      lines.push(`- [${candidate.type ?? 'data'}][${candidate.status ?? 'pending'}] ${candidate.claim ?? ''}${filled(candidate.need) ? `（${candidate.need}）` : ''}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push(`> 复盘 id：${review.id}｜AI：${review.ai?.provider ?? '未使用'} ${review.ai?.model ?? ''}｜模拟评委意见，非真实裁判结论`)
  return lines.join('\n')
}

/** 导出 Markdown 到工作区 `.debate/exports/reviews/`。 */
export function exportReviewMarkdown(workspace, selector, review) {
  const entry = requireEntry(workspace, selector)
  const markdown = renderReviewMarkdown(review)
  const dir = reviewExportDir(workspace)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `${review.id}.md`)
  fs.writeFileSync(target, `${markdown}\n`, 'utf8')
  return { path: target, markdown, projectId: entry.id }
}
