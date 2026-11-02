import { coreFsPromises } from '../ports/index.ts'
import {
  EQ_BAND_MIN_FREQUENCY_HZ,
  EQ_BAND_MAX_FREQUENCY_HZ
} from '../../shared/audioProcessingOptions.ts'

const { readFile, stat } = coreFsPromises
import type {
  DspCorrectionBand,
  DspCorrectionImportResult,
  DspCorrectionFilterType,
  DspCorrectionFormat,
  DspCorrectionProfile
} from '../../shared/dspGraph.ts'
import type { DspAssetLibrary } from './dspAssetLibrary.ts'

const MAX_CORRECTION_PROFILE_BYTES = 2 * 1024 * 1024
const MAX_CORRECTION_PROFILE_LINES = 4096
const MAX_CORRECTION_BANDS = 32
const ALL_CHANNELS_MASK = 0xffffffff
const BUTTERWORTH_Q = Math.SQRT1_2

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const PREAMP_LINE = new RegExp(`^Preamp\\s*:\\s*(${NUMBER})\\s*dB$`, 'i')
const FILTER_LINE = new RegExp('^Filter(?:\\s+\\d+)?\\s*:\\s*(ON|OFF)\\s+(\\S+)(?:\\s+(.*))?$', 'i')

const FILTER_TYPES: Record<string, DspCorrectionFilterType> = {
  PK: 'peak',
  PEQ: 'peak',
  LSC: 'lowShelf',
  HSC: 'highShelf',
  BP: 'bandPass',
  LP: 'lowPass',
  HP: 'highPass',
  LPQ: 'lowPass',
  HPQ: 'highPass',
  AP: 'allPass',
  NO: 'notch'
}

const FILTER_TYPES_REQUIRING_GAIN = new Set(['PK', 'PEQ', 'LSC', 'HSC'])
const FILTER_NUMBER = new RegExp(`^(${NUMBER})(Hz|dB)?$`, 'i')
const CHANNEL_BITS: Record<string, number> = {
  L: 0,
  FL: 0,
  R: 1,
  FR: 1,
  C: 2,
  FC: 2,
  LFE: 3,
  SUB: 3,
  LS: 4,
  SL: 4,
  RS: 5,
  SR: 5,
  LB: 6,
  BL: 6,
  LRS: 6,
  RB: 7,
  BR: 7,
  RRS: 7
}

/**
 * Parses only documented parametric-EQ text produced by Equalizer APO, REW,
 * or AutoEq. It deliberately rejects other text instead of treating it as a
 * best-effort correction profile.
 */
export function parseCorrectionProfileText(source: string): DspCorrectionProfile {
  if (typeof source !== 'string' || source.length === 0) {
    throw new Error('校正文件为空')
  }
  if (source.length > MAX_CORRECTION_PROFILE_BYTES) {
    throw new Error('校正文件超过 2 MiB 限制')
  }
  if (source.includes('\0')) {
    throw new Error('校正文件不是有效文本')
  }

  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length > MAX_CORRECTION_PROFILE_LINES) {
    throw new Error('校正文件行数超过限制')
  }

  const format = detectFormat(lines)
  const bands: DspCorrectionBand[] = []
  let preampDb = 0
  let sawPreamp = false
  let channelMask = ALL_CHANNELS_MASK
  let devices = 0
  const firstFilter = lines.findIndex((line) => /^Filter(?:\s+\d+)?\s*:/i.test(line.trim()))

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = lines[index].trim()
    if (!line || isComment(line) || isKnownHeader(line)) continue

    const preamp = PREAMP_LINE.exec(line)
    if (preamp) {
      if (channelMask !== ALL_CHANNELS_MASK) {
        throw parseError(lineNumber, 'Preamp 只能作用于全部声道')
      }
      if (sawPreamp) throw parseError(lineNumber, '只允许一个 Preamp 指令')
      preampDb = parseBoundedNumber(preamp[1], -24, 24, lineNumber, 'Preamp')
      sawPreamp = true
      continue
    }

    const channel = /^Channel\s*:\s*(.+)$/i.exec(line)
    if (channel) {
      channelMask = parseChannelMask(channel[1], lineNumber)
      continue
    }

    // A managed scene has no device selection; separate device blocks cannot
    // be flattened into one EQ without changing which filters are applied.
    if (/^Device\s*:\s*\S.*$/i.test(line)) {
      if (++devices > 1) throw parseError(lineNumber, '包含多个 Device 段，请分别导入')
      continue
    }
    // REW writes measurement names, notes and dates before its first filter.
    if (
      format === 'rew' &&
      index < firstFilter &&
      (/^(Dated|Notes|Equaliser)\s*:/i.test(line) || !line.includes(':'))
    )
      continue

    const filter = FILTER_LINE.exec(line)
    if (filter) {
      const sourceType = filter[2].toUpperCase()
      if (sourceType === 'NONE') continue
      if (bands.length >= MAX_CORRECTION_BANDS) {
        throw parseError(lineNumber, `最多支持 ${MAX_CORRECTION_BANDS} 个参数 EQ 段`)
      }
      if (sourceType === 'LS' || sourceType === 'HS') {
        throw parseError(
          lineNumber,
          `${sourceType} 搁架按拐点频率定义，请改用 ${sourceType}C（中心频率与 Q）`
        )
      }
      const filterType = FILTER_TYPES[sourceType]
      if (!filterType) throw parseError(lineNumber, `不支持的滤波器 ${sourceType}`)
      const params = parseFilterParameters(filter[3] ?? '', lineNumber)
      const usesGain = FILTER_TYPES_REQUIRING_GAIN.has(sourceType)
      if (usesGain && params.GAIN === undefined) {
        throw parseError(lineNumber, `${sourceType} 滤波器需要 Gain`)
      }
      if (!usesGain && params.GAIN !== undefined && Number(params.GAIN) !== 0) {
        throw parseError(lineNumber, `${sourceType} 滤波器不使用 Gain`)
      }
      let q: number
      if (sourceType === 'LP' || sourceType === 'HP') {
        if (params.Q !== undefined && Math.abs(Number(params.Q) - BUTTERWORTH_Q) > 0.0005) {
          throw parseError(
            lineNumber,
            `${sourceType} 的 Q 固定为 0.7071，其他 Q 请使用 ${sourceType}Q`
          )
        }
        q = BUTTERWORTH_Q
      } else {
        if (params.Q === undefined) throw parseError(lineNumber, `${sourceType} 缺少 Q`)
        q = parseBoundedNumber(params.Q, 0.1, 20, lineNumber, 'Q')
      }
      if (params.FC === undefined) throw parseError(lineNumber, `${sourceType} 缺少 Fc`)
      bands.push({
        frequency: parseBoundedNumber(
          params.FC,
          EQ_BAND_MIN_FREQUENCY_HZ,
          EQ_BAND_MAX_FREQUENCY_HZ,
          lineNumber,
          'Fc'
        ),
        gain: usesGain ? parseBoundedNumber(params.GAIN!, -24, 24, lineNumber, 'Gain') : 0,
        q,
        filterType,
        enabled: filter[1].toUpperCase() === 'ON',
        channelMask
      })
      continue
    }

    if (/^Filter(?:\s+\d+)?\s*:/i.test(line)) {
      throw parseError(lineNumber, '滤波器语法或滤波器类型不受支持')
    }
    if (/^(GraphicEQ|Include|Copy|Delay|Preamp|Channel|Device)\s*:/i.test(line)) {
      throw parseError(lineNumber, '该校正指令不支持；仅可导入参数 EQ')
    }
    throw parseError(lineNumber, '无法识别的内容，不会猜测校正格式')
  }

  if (bands.length === 0) {
    throw new Error('未找到可用的参数 EQ 滤波器')
  }
  return { format, preampDb, bands }
}

function parseFilterParameters(
  source: string,
  lineNumber: number
): Partial<Record<'FC' | 'GAIN' | 'Q', string>> {
  const tokens = source.trim().split(/\s+/).filter(Boolean)
  const params: Partial<Record<'FC' | 'GAIN' | 'Q', string>> = {}
  for (let index = 0; index < tokens.length; ) {
    const key = tokens[index++].toUpperCase()
    if (key === 'BW') throw parseError(lineNumber, 'BW 带宽写法暂不支持，请使用 Q')
    if (/^\d+(?:\.\d+)?dB$/i.test(key)) throw parseError(lineNumber, '斜率写法暂不支持，请使用 Q')
    if (key !== 'FC' && key !== 'GAIN' && key !== 'Q') {
      throw parseError(lineNumber, `无法识别的滤波器参数 ${key}`)
    }
    if (params[key] !== undefined) throw parseError(lineNumber, `重复的 ${key}`)
    const number = FILTER_NUMBER.exec(tokens[index++] ?? '')
    const unit = key === 'FC' ? 'Hz' : key === 'GAIN' ? 'dB' : null
    if (
      !number ||
      !Number.isFinite(Number(number[1])) ||
      (number[2] && number[2].toLowerCase() !== unit?.toLowerCase())
    ) {
      throw parseError(lineNumber, `${key} 数值或单位无效`)
    }
    if (unit && !number[2] && tokens[index]?.toLowerCase() === unit.toLowerCase()) index++
    params[key] = number[1]
  }
  return params
}

export async function parseCorrectionProfileFile(filePath: string): Promise<DspCorrectionProfile> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('校正资料必须是文件')
  if (info.size <= 0 || info.size > MAX_CORRECTION_PROFILE_BYTES) {
    throw new Error('校正文件大小不在允许范围内')
  }
  return parseCorrectionProfileText(await readFile(filePath, 'utf8'))
}

export async function importCorrectionProfileFile(
  sourcePath: string,
  assets: Pick<DspAssetLibrary, 'importFile'>
): Promise<DspCorrectionImportResult> {
  const profile = await parseCorrectionProfileFile(sourcePath)
  const asset = await assets.importFile({ kind: 'correctionProfile', sourcePath })
  return { asset, profile }
}

function detectFormat(lines: string[]): DspCorrectionFormat {
  const headers = lines
    .map((line) => line.trim().replace(/^(?:#|;|\/\/)+\s*/, ''))
    .filter(Boolean)
    .slice(0, 64)
  if (headers.some((line) => /\bautoeq\b/i.test(line))) return 'autoeq'
  if (headers.some((line) => /\broom\s+eq\b|^Filter Settings file$/i.test(line))) return 'rew'
  return 'equalizerApo'
}

function isComment(line: string): boolean {
  return /^(?:#|;|\/\/)/.test(line)
}

function isKnownHeader(line: string): boolean {
  return (
    /^Equalizer\s+APO(?:\s+configuration)?$/i.test(line) ||
    /^Filter\s+Settings\s+file$/i.test(line) ||
    /^Room\s+EQ(?:\s+Wizard)?(?:\s+V?[\d.]+)?$/i.test(line) ||
    /^AutoEq(?:\s+.*)?$/i.test(line) ||
    /^Parametric\s+EQ(?:\s+settings)?$/i.test(line)
  )
}

function parseChannelMask(value: string, lineNumber: number): number {
  const tokens = value
    .trim()
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean)
  if (tokens.length === 0) throw parseError(lineNumber, 'Channel 指令不能为空')
  if (tokens.length === 1 && (tokens[0] === 'ALL' || tokens[0] === '*')) return ALL_CHANNELS_MASK

  let mask = 0
  for (const token of tokens) {
    const bit =
      CHANNEL_BITS[token] ??
      (/^\d+$/.test(token) && Number(token) >= 1 && Number(token) <= 32
        ? Number(token) - 1
        : undefined)
    if (bit === undefined) throw parseError(lineNumber, `不支持的声道 ${token}`)
    mask |= 1 << bit
  }
  return mask >>> 0
}

function parseBoundedNumber(
  value: string,
  minimum: number,
  maximum: number,
  lineNumber: number,
  field: string
): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw parseError(lineNumber, `${field} 必须在 ${minimum} 到 ${maximum} 之间`)
  }
  return number
}

function parseError(lineNumber: number, message: string): Error {
  return new Error(`校正文件第 ${lineNumber} 行：${message}`)
}
