/** Worker-only media preparation; the output path is allocated by Core, never by a renderer. */
export interface CastPcmSegmentRequest {
  outputPath: string
  startSeconds: number
  endSeconds: number
  virtualPregapSeconds: number
}
