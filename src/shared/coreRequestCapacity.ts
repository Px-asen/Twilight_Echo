import type { CoreRequestEnvelope } from './coreProtocol.ts'

export const CORE_REQUEST_CAPACITY = {
  active: 128,
  clientActive: 16,
  clientReaders: 12,
  queued: 128,
  clientQueued: 64
} as const

export function isCorePriorityRequest(request: CoreRequestEnvelope): boolean {
  // Selecting an existing occurrence locates it before issuing queue.select.
  if (request.kind === 'query') return request.name === 'queue.locate'
  // Playlist reads wait for an open submission. Its remaining batches must
  // reach the owner even when those reads occupy every ordinary request slot.
  if (request.name === 'playlists.submit') return request.payload.kind !== 'begin'
  return (
    request.name.startsWith('playback.') ||
    ['queue.select', 'queue.fromQuery', 'queue.submit', 'catalog.play', 'focus.play'].includes(request.name)
  )
}
