/** Private Core/audio-service data, not a remote state view. Legacy occurrence
 * IDs may embed paths. Queue/transport/format revisions remain member-local. */
export interface BridgeAutoMixPlan {
  version: 1
  ruleVersion: 'twilight-rules-5'
  mode: 'natural' | 'dj'
  sampleRate: number
  channels: number
  currentIdentity: string
  nextIdentity: string
  currentEntryId: string
  nextEntryId: string
  currentSourceStartSeconds: number
  currentSourceEndSeconds: number
  nextSourceStartSeconds: number
  nextSourceEndSeconds: number
  currentStartFrame: number
  currentEndFrame: number
  nextStartFrame: number
  nextEndFrame: number
  outputFrames: number
  currentRate: number
  nextRate: number
  nextGain: number
  effect: number
  kind: number
  bpm: number
  confidence: number
  score: number
  lowClash: number
  vocalClash: number
}

/** Native source_at curve: hold the selected rate for 80%, then ramp to unity.
 * The result is a source position, not elapsed presentation time. */
export function bridgeAutoMixSourceFrame(plan: BridgeAutoMixPlan, deck: 0 | 1, outputFrame: number): number {
  const frame = Math.max(0, Math.min(plan.outputFrames, outputFrame)), rate = deck ? plan.nextRate : plan.currentRate
  if (frame === plan.outputFrames) return deck ? plan.nextEndFrame : plan.currentEndFrame
  const hold = plan.outputFrames * .8, ramp = Math.max(0, frame-hold), duration = plan.outputFrames-hold
  const consumed = frame*rate + (duration ? (1-rate)*ramp*ramp/(2*duration) : 0)
  return (deck ? plan.nextStartFrame : plan.currentStartFrame) + consumed
}
