/**
 * 字幕/转写文本解析。
 *
 * 支持：
 *  - SRT（序号 + `00:00:01,000 --> 00:00:04,000` + 文本）
 *  - WebVTT（`WEBVTT` 头 + `00:00:01.000 --> 00:00:04.000` + 文本，可带 cue 设置）
 *  - 纯文本（无时间戳，整段作为一个 segment）
 *
 * 视频/会议软件（腾讯会议、飞书妙记、讯飞听见等）导出的字幕一般就是这两种格式。
 *
 * @module dsh-debate-workbench/transcript
 */

/** 解析时间戳 `01:02:03,500` / `01:02.500` / `1:02:03.4` → 秒。 */
export function parseTimestamp(value) {
  const raw = String(value ?? '').trim().replace(',', '.')
  if (raw === '') return undefined
  const parts = raw.split(':')
  if (parts.length === 2) {
    const [minutes, rest] = parts
    const seconds = Number(rest)
    const mins = Number(minutes)
    if (!Number.isFinite(mins) || !Number.isFinite(seconds)) return undefined
    return mins * 60 + seconds
  }
  if (parts.length === 3) {
    const [hours, minutes, rest] = parts
    const secs = Number(rest)
    const mins = Number(minutes)
    const hrs = Number(hours)
    if (!Number.isFinite(hrs) || !Number.isFinite(mins) || !Number.isFinite(secs)) return undefined
    return hrs * 3600 + mins * 60 + secs
  }
  const alone = Number(raw)
  return Number.isFinite(alone) ? alone : undefined
}

/** 秒 → `mm:ss`（用于 Markdown/提示）。 */
export function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(secs).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

/** 判断字幕格式：srt | vtt | undefined。 */
export function detectSubtitleFormat(text, fileName) {
  const source = String(text ?? '')
  const name = String(fileName ?? '').toLowerCase()
  if (source.includes('WEBVTT') || name.endsWith('.vtt')) return 'vtt'
  if (/-->/.test(source) || name.endsWith('.srt')) return 'srt'
  return undefined
}

/** 清理字幕文本：去掉 HTML/VTT 标签与多余空白。 */
function cleanCueText(lines) {
  return lines
    .join(' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 通用「带 --> 的块」解析（SRT 与 VTT 主体一致）。 */
function parseCueBlocks(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const blocks = normalized.split(/\n{2,}/)
  const segments = []
  for (const block of blocks) {
    const lines = block.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (lines.length === 0) continue
    const timeIndex = lines.findIndex(line => line.includes('-->'))
    if (timeIndex < 0) continue
    const timeLine = lines[timeIndex]
    const match = /([\d:.,]+)\s*-->\s*([\d:.,]+)/.exec(timeLine)
    if (match === null) continue
    const start = parseTimestamp(match[1])
    const end = parseTimestamp(match[2])
    const textLines = lines.slice(timeIndex + 1)
    const content = cleanCueText(textLines)
    if (content === '') continue
    segments.push({
      start: start === undefined ? undefined : Number(start.toFixed(2)),
      end: end === undefined ? undefined : Number(end.toFixed(2)),
      text: content,
    })
  }
  return segments
}

/** 解析 SRT。 */
export function parseSrt(text) {
  return parseCueBlocks(text)
}

/** 解析 WebVTT（去掉 WEBVTT 头与 NOTE 块）。 */
export function parseVtt(text) {
  const source = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '')
    .split(/\n{2,}/)
    .filter(block => !/^\s*NOTE\b/i.test(block))
    .filter(block => !/^\s*WEBVTT\b/i.test(block.trim()))
    .join('\n\n')
  return parseCueBlocks(source)
}

/**
 * 解析字幕文本：自动识别 srt/vtt，否则作为纯文本返回单段。
 *
 * @param {string} text 字幕/文本内容
 * @param {{ fileName?: string, format?: 'srt'|'vtt'|'text' }} [options] 指定格式
 * @returns {{ format: 'srt'|'vtt'|'text', segments: Array<any> }}
 */
export function parseSubtitle(text, options = {}) {
  const source = String(text ?? '')
  const explicit = options.format
  const format = explicit === 'srt' || explicit === 'vtt' || explicit === 'text'
    ? explicit
    : detectSubtitleFormat(source, options.fileName) ?? 'text'
  if (format === 'srt') return { format, segments: parseSrt(source) }
  if (format === 'vtt') return { format, segments: parseVtt(source) }
  const trimmed = source.trim()
  return {
    format: 'text',
    segments: trimmed === '' ? [] : [{ start: undefined, end: undefined, text: trimmed }],
  }
}

/** segments → 完整文本。 */
export function segmentsToText(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map(segment => String(segment?.text ?? '').trim())
    .filter(text => text !== '')
    .join('\n')
}

/**
 * 按环节边界给 segments 打上 phase 标签。
 *
 * @param {Array<any>} segments 字幕段
 * @param {Array<{ phase: string, start: number, end: number }>} [boundaries] 环节边界（秒）
 * @returns {Array<any>} 带 phase 的 segments
 */
export function assignPhases(segments, boundaries) {
  const list = Array.isArray(segments) ? segments : []
  if (!Array.isArray(boundaries) || boundaries.length === 0) return list
  return list.map(segment => {
    const start = Number(segment?.start)
    if (!Number.isFinite(start)) return segment
    const hit = boundaries.find(boundary => start >= Number(boundary.start) && start < Number(boundary.end))
    return hit === undefined ? segment : { ...segment, phase: String(hit.phase) }
  })
}

/** 校验环节边界数组（供工具参数使用）。 */
export function normalizePhaseBoundaries(value) {
  if (!Array.isArray(value)) return []
  const output = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const phase = String(item.phase ?? '').trim()
    const start = Number(item.start)
    const end = Number(item.end)
    if (phase === '' || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    output.push({ phase, start, end })
  }
  return output
}
