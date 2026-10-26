/**
 * DSH 内置语音转写（`speechToText` 服务）接入。
 *
 * 服务契约（DSH 0.2.0-rc.2）：
 *   const spec = service.resolve({ audio: Uint8Array, language?: string })
 *   const transcript = await service.transcribe(spec, signal)
 *   // => { text, audioSeconds, inferenceSeconds }
 *
 * 限制：本地 SenseVoice provider 只接受 16kHz 单声道 PCM16 WAV，单次默认 4 MiB
 * （约 131 秒），所以这里按 ~110 秒切片、逐块转写，再拼成完整文本。
 *
 * 没有启用语音插件（服务不存在）时，返回 available:false，由调用方降级提示。
 *
 * @module dsh-debate-workbench/speech
 */
import { chunkRanges, parseWav, sliceWav } from './wav.js'

/** 安全取服务（可选依赖语义）。 */
function serviceOf(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('speechToText') : undefined
  } catch {
    return undefined
  }
}

/**
 * 读取转写服务的可用状态。
 *
 * @param {any} ctx 插件上下文
 * @returns {{ available: boolean, reason?: string, providers?: Array<any>, selected?: string }}
 */
export function speechStatus(ctx) {
  const service = serviceOf(ctx)
  if (service === undefined || service === null) {
    return {
      available: false,
      reason: '未启用 DSH 官方「语音输入」插件（插件面板 → 官方 → 语音输入），启用并下载模型后可用自动转写',
    }
  }
  if (typeof service.transcribe !== 'function' || typeof service.resolve !== 'function') {
    return { available: false, reason: '当前宿主语音服务不可用（缺少 resolve/transcribe）' }
  }
  let providers = []
  let selected
  try {
    if (typeof service.listProviders === 'function') providers = service.listProviders() ?? []
    if (typeof service.snapshot === 'function') {
      const snapshot = service.snapshot()
      selected = snapshot?.selection?.providerId
      if (Array.isArray(snapshot?.providers) && providers.length === 0) providers = snapshot.providers
    }
  } catch {
    providers = []
  }
  return { available: true, providers, selected }
}

/**
 * 转写一段规范 WAV：自动按 ~110 秒切片，逐块调用服务。
 *
 * @param {any} ctx 插件上下文
 * @param {Buffer|Uint8Array} bytes 规范 WAV 字节
 * @param {{ language?: string, chunkSeconds?: number, signal?: AbortSignal, onProgress?: (info: any) => void }} [options] 选项
 * @returns {Promise<any>} `{ text, chunks, provider, audioSeconds, inferenceSeconds, durationSec }`
 */
export async function transcribeWav(ctx, bytes, options = {}) {
  const status = speechStatus(ctx)
  if (!status.available) throw new Error(`无法转写：${status.reason}`)
  const service = serviceOf(ctx)
  const parsed = parseWav(bytes)
  if (!parsed.canonical) {
    throw new Error(
      [
        `音频格式不被 DSH 内置转写支持：${parsed.reason}`,
        '请在录音软件里导出「16kHz 单声道 PCM16 WAV」，或改用「导入字幕/转写文本」（.srt/.vtt/.txt）。',
      ].join('\n'),
    )
  }
  const ranges = chunkRanges(parsed.durationSec, options.chunkSeconds)
  if (ranges.length === 0) throw new Error('音频时长为 0，无法转写')
  const language = typeof options.language === 'string' && options.language !== '' ? options.language : undefined
  const chunks = []
  let provider
  let audioSeconds = 0
  let inferenceSeconds = 0
  let text = ''
  for (const range of ranges) {
    if (options.signal?.aborted === true) throw new Error('转写已取消')
    const slice = sliceWav(bytes, range.start, range.end)
    const spec = service.resolve({ audio: new Uint8Array(slice), ...(language === undefined ? {} : { language }) })
    const transcript = await service.transcribe(spec, options.signal ?? new AbortController().signal)
    const chunkText = typeof transcript?.text === 'string' ? transcript.text.trim() : ''
    chunks.push({ index: range.index, start: range.start, end: range.end, text: chunkText })
    if (chunkText !== '') text += (text === '' ? '' : '\n') + chunkText
    if (transcript?.provider !== undefined) provider = transcript.provider
    provider = provider ?? spec?.provider?.id
    audioSeconds += Number(transcript?.audioSeconds) || range.end - range.start
    inferenceSeconds += Number(transcript?.inferenceSeconds) || 0
    if (typeof options.onProgress === 'function') options.onProgress({ done: range.index + 1, total: ranges.length, range })
  }
  return {
    text,
    chunks,
    provider: typeof provider === 'string' ? provider : 'sensevoice-local',
    audioSeconds: Number(audioSeconds.toFixed(2)),
    inferenceSeconds: Number(inferenceSeconds.toFixed(2)),
    durationSec: parsed.durationSec,
    chunkSeconds: ranges.length > 0 ? Math.round(ranges[0].end - ranges[0].start) : 0,
  }
}
