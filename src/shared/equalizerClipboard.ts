import type { EqualizerBand, EqualizerFilterType } from './audioEngineTypes.ts'
import {
  EQ_BAND_MIN_FREQUENCY_HZ,
  EQ_BAND_MAX_FREQUENCY_HZ
} from './audioProcessingOptions.ts'

export interface EqualizerClipboardApi {
  copyEqBands: (bands: EqualizerBand[]) => Promise<void>
  pasteEqBands: () => Promise<EqualizerBand[]>
}

const filterTypes = new Set<EqualizerFilterType>([
  'peak',
  'lowShelf',
  'highShelf',
  'bandPass',
  'lowPass',
  'highPass',
  'allPass',
  'notch'
])

export function normalizeEqClipboardBands(value: unknown): EqualizerBand[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    throw new Error('复制的 EQ 频段数量必须为 1–32 个')
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('剪贴板中的 EQ 频段无效')
    const band = item as EqualizerBand
    if (
      !Number.isFinite(band.frequency) ||
      band.frequency < EQ_BAND_MIN_FREQUENCY_HZ ||
      band.frequency > EQ_BAND_MAX_FREQUENCY_HZ ||
      !Number.isFinite(band.gain) ||
      band.gain < -24 ||
      band.gain > 24 ||
      !Number.isFinite(band.q) ||
      band.q < 0.1 ||
      band.q > 20 ||
      !filterTypes.has(band.filterType) ||
      (band.enabled !== undefined && typeof band.enabled !== 'boolean') ||
      (band.channelMask !== undefined &&
        (!Number.isInteger(band.channelMask) ||
          band.channelMask < 0 ||
          band.channelMask > 0xffffffff))
    )
      throw new Error('剪贴板中的 EQ 频段参数无效')
    return {
      frequency: band.frequency,
      gain: band.gain,
      q: band.q,
      filterType: band.filterType,
      ...(band.enabled === undefined ? {} : { enabled: band.enabled }),
      ...(band.channelMask === undefined ? {} : { channelMask: band.channelMask })
    }
  })
}

export function formatEqBandClipboard(bands: EqualizerBand[]): string {
  return JSON.stringify({ kind: 'twilight-echo/eq-bands', version: 1, bands })
}

export function parseEqBandClipboard(text: string): EqualizerBand[] {
  if (text.length > 65536) throw new Error('剪贴板中的 EQ 数据过大')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('剪贴板中没有可粘贴的 Twilight EQ 频段')
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('kind' in value) ||
    value.kind !== 'twilight-echo/eq-bands' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('bands' in value)
  )
    throw new Error('剪贴板中没有可粘贴的 Twilight EQ 频段')
  return normalizeEqClipboardBands(value.bands)
}
