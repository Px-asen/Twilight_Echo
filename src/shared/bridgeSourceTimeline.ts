/** Private audio-service observation, never part of a remote Zone view. Legacy
 * occurrence IDs may contain a local path, so keep this behind the Core ports. */
export interface BridgeSourceTimeline {
  generation: number
  frames: number
  sampleRate: number
  positionFrames: number
  transitionFrame: number
  transitionSerial: number
  entryId: string
  advanceReady: boolean
  epoch: number
}
export function readBridgeSourceTimeline(value: unknown): Omit<BridgeSourceTimeline, 'epoch'> | null {
  if (value === undefined || value === null || value === 'null') return null
  if (typeof value !== 'string' || value.length > 64 * 1024) throw new Error('Invalid Bridge source timeline')
  const v = JSON.parse(value) as Omit<BridgeSourceTimeline, 'epoch'>
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid Bridge source timeline')
  for (const key of ['generation', 'frames', 'sampleRate', 'positionFrames', 'transitionFrame', 'transitionSerial'] as const)
    if (!Number.isSafeInteger(v[key]) || v[key] < 0) throw new Error('Invalid Bridge source frame')
  if (v.sampleRate < 44100 || v.sampleRate > 192000 || v.transitionFrame > v.frames ||
      typeof v.entryId !== 'string' || !v.entryId.length || v.entryId.length > 8192 || v.entryId.includes('\0'))
    throw new Error('Invalid Bridge source occurrence')
  return { generation: v.generation, frames: v.frames, sampleRate: v.sampleRate, positionFrames: v.positionFrames,
    transitionFrame: v.transitionFrame, transitionSerial: v.transitionSerial, entryId: v.entryId, advanceReady: v.advanceReady === true }
}
