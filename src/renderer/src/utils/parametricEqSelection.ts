import type { EqualizerBand } from '@renderer/types/settings'
import { frequencyToPercent, gainToPercent } from '@renderer/utils/eqViewport'
import {
  clampEqValue,
  displayBandGain,
  filterUsesGain,
  PARAMETRIC_EQ_MIN_Q,
  PARAMETRIC_EQ_MAX_Q
} from '@renderer/utils/parametricEqInteraction'
import {
  EQ_BAND_MIN_FREQUENCY_HZ,
  EQ_BAND_MAX_FREQUENCY_HZ
} from '../../../shared/audioProcessingOptions.ts'

export type EqBandPatch = { index: number; patch: Partial<EqualizerBand> }
export type EqSelection = { indices: number[]; primary: number }
export type EqSelectionBox = { left: number; right: number; top: number; bottom: number }

export function selectEqBands(
  bands: readonly EqualizerBand[],
  current: readonly number[],
  index: number,
  anchor: number,
  modifiers: { toggle: boolean; range: boolean }
): EqSelection {
  let indices: number[]
  if (modifiers.range && bands[anchor]) {
    const ordered = bands.map((band, index) => ({ frequency: band.frequency, index }))
    ordered.sort((a, b) => a.frequency - b.frequency || a.index - b.index)
    const start = ordered.findIndex((band) => band.index === anchor)
    const end = ordered.findIndex((band) => band.index === index)
    indices = ordered
      .slice(Math.min(start, end), Math.max(start, end) + 1)
      .map((band) => band.index)
    if (modifiers.toggle) indices = [...new Set([...current, ...indices])]
  } else if (modifiers.toggle) {
    indices = current.includes(index)
      ? current.filter((item) => item !== index)
      : [...current, index]
  } else {
    indices = current.includes(index) ? [...current] : [index]
  }
  return { indices, primary: indices.includes(index) ? index : (indices.at(-1) ?? -1) }
}

export function eqBandsInBox(
  bands: readonly EqualizerBand[],
  box: EqSelectionBox,
  displayRange: number
): number[] {
  const indices: number[] = []
  bands.forEach((band, index) => {
    const x = frequencyToPercent(band.frequency)
    const y = gainToPercent(displayBandGain(band), displayRange)
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) indices.push(index)
  })
  return indices
}

export function groupEqBandPatches(
  bands: readonly EqualizerBand[],
  indices: readonly number[],
  anchorIndex: number,
  patch: Partial<EqualizerBand>
): EqBandPatch[] {
  const anchor = bands[anchorIndex]
  let frequencyRatio = 1
  let qRatio = 1
  let gainRatio = 1
  let gainOffset = 0
  const gainIndices = indices.filter((index) => filterUsesGain(bands[index].filterType))
  if (patch.frequency !== undefined) {
    let min = 0,
      max = Infinity
    for (const index of indices) {
      min = Math.max(min, EQ_BAND_MIN_FREQUENCY_HZ / bands[index].frequency)
      max = Math.min(max, EQ_BAND_MAX_FREQUENCY_HZ / bands[index].frequency)
    }
    frequencyRatio = clampEqValue(patch.frequency / anchor.frequency, min, max)
  }
  if (patch.q !== undefined) {
    let min = 0,
      max = Infinity
    for (const index of indices) {
      min = Math.max(min, PARAMETRIC_EQ_MIN_Q / bands[index].q)
      max = Math.min(max, PARAMETRIC_EQ_MAX_Q / bands[index].q)
    }
    qRatio = clampEqValue(patch.q / anchor.q, min, max)
  }
  const changeGain = patch.gain !== undefined && filterUsesGain(anchor.filterType)
  if (changeGain) {
    if (anchor.gain !== 0) {
      const largest = Math.max(...gainIndices.map((index) => Math.abs(bands[index].gain)))
      gainRatio = clampEqValue(patch.gain! / anchor.gain, -24 / largest, 24 / largest)
    } else {
      let min = -Infinity,
        max = Infinity
      for (const index of gainIndices) {
        min = Math.max(min, -24 - bands[index].gain)
        max = Math.min(max, 24 - bands[index].gain)
      }
      gainOffset = clampEqValue(patch.gain!, min, max)
    }
  }
  return indices.map((index) => {
    const band = bands[index]
    const next = { ...patch }
    if (patch.frequency !== undefined) next.frequency = band.frequency * frequencyRatio
    if (patch.q !== undefined) next.q = band.q * qRatio
    delete next.gain
    if (changeGain && filterUsesGain(band.filterType))
      next.gain = band.gain * gainRatio + gainOffset
    return { index, patch: next }
  })
}
