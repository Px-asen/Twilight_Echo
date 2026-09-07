import type { DspGraphNode } from '../../../shared/dspGraph.ts'

export function vst3ParameterValue(node: DspGraphNode, id: number, fallback: number): number {
  const parameters = node.params.parameters
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return fallback
  const value = (parameters as Record<string, unknown>)[String(id)]
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

export function setVst3Parameter(node: DspGraphNode, id: number, value: string | number): void {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return
  const current =
    node.params.parameters &&
    typeof node.params.parameters === 'object' &&
    !Array.isArray(node.params.parameters)
      ? (node.params.parameters as Record<string, unknown>)
      : {}
  current[String(id)] = Math.max(0, Math.min(1, number))
  node.params.parameters = current
}

export function vst3ParameterStep(stepCount: number): number {
  return stepCount > 0 ? 1 / stepCount : 0.001
}

export function isReadOnlyVst3Parameter(flags: number): boolean {
  return (flags & 2) !== 0 || (flags & 16) !== 0
}
