import {
  PARAMETRIC_EQ_MAX_FREQUENCY,
  PARAMETRIC_EQ_MAX_GAIN,
  PARAMETRIC_EQ_MAX_Q,
  PARAMETRIC_EQ_MIN_FREQUENCY,
  PARAMETRIC_EQ_MIN_GAIN,
  PARAMETRIC_EQ_MIN_Q,
  clampEqValue
} from './parametricEqInteraction.ts'

export type EqParameter = 'frequency' | 'gain' | 'q'

export const eqParameterLimits = {
  frequency: { min: PARAMETRIC_EQ_MIN_FREQUENCY, max: PARAMETRIC_EQ_MAX_FREQUENCY, step: 1 },
  gain: { min: PARAMETRIC_EQ_MIN_GAIN, max: PARAMETRIC_EQ_MAX_GAIN, step: 0.1 },
  q: { min: PARAMETRIC_EQ_MIN_Q, max: PARAMETRIC_EQ_MAX_Q, step: 0.01 }
} as const

export function eqParameterPosition(field: EqParameter, value: number): number {
  const { min, max } = eqParameterLimits[field]
  const bounded = clampEqValue(value, min, max)
  return field === 'gain'
    ? (bounded - min) / (max - min)
    : Math.log(bounded / min) / Math.log(max / min)
}

export function normalizeEqParameter(field: EqParameter, value: number): number {
  const { min, max, step } = eqParameterLimits[field]
  return Number((Math.round(clampEqValue(value, min, max) / step) * step).toFixed(2))
}

export function eqParameterAtPosition(field: EqParameter, position: number): number {
  const { min, max } = eqParameterLimits[field]
  const ratio = clampEqValue(position, 0, 1)
  return normalizeEqParameter(
    field,
    field === 'gain' ? min + ratio * (max - min) : min * (max / min) ** ratio
  )
}

export function nudgeEqParameter(
  field: EqParameter,
  value: number,
  direction: -1 | 1,
  fine = false
): number {
  if (field === 'gain') return normalizeEqParameter(field, value + direction * (fine ? 0.1 : 0.5))
  const factor = field === 'frequency' ? (fine ? 1.005 : 1.025) : fine ? 1.01 : 1.08
  return normalizeEqParameter(field, value * factor ** direction)
}

export function createEqKnobGesture(options: {
  field: EqParameter
  readValue: () => number
  preview: (value: number) => void
  commit: () => void
}) {
  let drag: {
    pointerId: number
    y: number
    position: number
    value: number
    changed: boolean
  } | null = null

  return {
    active: () => drag !== null,
    start(pointerId: number, y: number): boolean {
      if (drag) return false
      const value = options.readValue()
      drag = {
        pointerId,
        y,
        position: eqParameterPosition(options.field, value),
        value,
        changed: false
      }
      return true
    },
    move(pointerId: number, y: number, fine = false): void {
      if (!drag || drag.pointerId !== pointerId) return
      drag.position = clampEqValue(drag.position + ((drag.y - y) / 180) * (fine ? 0.1 : 1), 0, 1)
      drag.y = y
      const value = eqParameterAtPosition(options.field, drag.position)
      if (value === drag.value) return
      drag.value = value
      drag.changed = true
      options.preview(value)
    },
    finish(pointerId?: number): boolean {
      if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return false
      const changed = drag.changed
      drag = null
      if (changed) options.commit()
      return true
    }
  }
}

export function createEqWheelCommit(commit: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    commit()
  }
  return {
    pending: () => timer !== null,
    schedule(): void {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(flush, 140)
    },
    flush
  }
}
