/**
 * WAV 工具：DSH 内置语音转写（SenseVoice 本地 provider）只接受
 * **规范 16 kHz 单声道 PCM16 WAV**，且有单次字节上限（默认 4 MiB ≈ 131 秒）。
 *
 * 所以插件这边负责：
 *  1. 校验用户上传的音频是不是规范 WAV（不是就给出明确提示，不做格式转换；
 *     避免引入 ffmpeg 原生依赖）；
 *  2. 按秒切分 WAV（16kHz/单声道/PCM16 可以直接操作 PCM 数据，不需要解码）；
 *  3. 逐块调用转写服务，拼成完整转写文本（块区间可作为粗时间轴）。
 *
 * @module dsh-debate-workbench/wav
 */

/** 单次转写推荐的音频秒数（SenseVoice maxAudioBytes 默认 4MiB ≈ 131s，留余量）。 */
export const DEFAULT_CHUNK_SECONDS = 110
/** PCM16 单声道 16kHz 每秒字节数。 */
const BYTES_PER_SECOND = 16000 * 2

/** 读 RIFF/WAVE 头并解析 fmt/data 块。 */
export function parseWav(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (buffer.length < 44) return { canonical: false, reason: '文件太小，不是有效 WAV' }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { canonical: false, reason: '不是 RIFF/WAVE 文件' }
  }
  let offset = 12
  let fmt
  let dataOffset
  let dataBytes
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      dataOffset = body
      dataBytes = Math.min(size, buffer.length - body)
      break
    }
    offset = body + size + (size % 2)
  }
  if (fmt === undefined || dataOffset === undefined) {
    return { canonical: false, reason: 'WAV 缺少 fmt 或 data 块' }
  }
  const canonical = fmt.format === 1 && fmt.channels === 1 && fmt.sampleRate === 16000 && fmt.bitsPerSample === 16
  const durationSec = dataBytes / BYTES_PER_SECOND
  if (!canonical) {
    return {
      canonical: false,
      reason: `需要 16kHz 单声道 PCM16 WAV，当前是 ${fmt.sampleRate}Hz/${fmt.channels}声道/${fmt.bitsPerSample}bit`,
      format: fmt,
      durationSec,
    }
  }
  return {
    canonical: true,
    format: fmt,
    dataOffset,
    dataBytes,
    durationSec: Number(durationSec.toFixed(2)),
    totalBytes: buffer.length,
  }
}

/** 快速判断是否规范 WAV。 */
export function isCanonicalWav(bytes) {
  return parseWav(bytes).canonical === true
}

/** 生成一段规范 WAV 头（44 字节）。 */
function buildHeader(dataBytes) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/**
 * 切出 [startSec, endSec) 的一段规范 WAV。
 *
 * @param {Buffer|Uint8Array} bytes 原 WAV 字节
 * @param {number} startSec 开始秒
 * @param {number} endSec 结束秒
 * @returns {Buffer} 新的 WAV 字节
 */
export function sliceWav(bytes, startSec, endSec) {
  const parsed = parseWav(bytes)
  if (!parsed.canonical) throw new Error(`无法切片：${parsed.reason}`)
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const totalBytes = parsed.dataBytes
  const startByte = Math.max(0, Math.min(totalBytes, Math.round(Number(startSec) * BYTES_PER_SECOND)))
  const endByte = Math.max(startByte, Math.min(totalBytes, Math.round(Number(endSec) * BYTES_PER_SECOND)))
  const alignedStart = startByte - (startByte % 2)
  const alignedEnd = endByte - (endByte % 2)
  const pcm = buffer.subarray(parsed.dataOffset + alignedStart, parsed.dataOffset + alignedEnd)
  return Buffer.concat([buildHeader(pcm.length), pcm])
}

/**
 * 按固定秒数切分整段音频的区间列表。
 *
 * @param {number} durationSec 总时长（秒）
 * @param {number} [chunkSeconds] 每块秒数
 * @returns {Array<{ start: number, end: number, index: number }>} 区间
 */
export function chunkRanges(durationSec, chunkSeconds = DEFAULT_CHUNK_SECONDS) {
  const total = Math.max(0, Number(durationSec) || 0)
  const size = Math.max(10, Math.min(120, Number(chunkSeconds) || DEFAULT_CHUNK_SECONDS))
  const ranges = []
  let start = 0
  let index = 0
  while (start < total) {
    const end = Math.min(total, start + size)
    ranges.push({ start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), index })
    start = end
    index += 1
    if (index > 400) break
  }
  return ranges
}
