import { MAX_LOUDNESS_BATCH_TRACKS, normalizeLoudnessGroups } from '../../shared/libraryLoudness.ts'
import {
  normalizeIpcString,
  normalizeLocalPath,
  stringifyJsonForIpcStorage
} from '../security/ipcValidation.ts'
import type { LibraryLoudnessManager } from './libraryLoudnessManager.ts'

export function createLibraryLoudnessHandlers(
  manager: LibraryLoudnessManager,
  assertSender: (event: unknown) => void
) {
  const groups = (value: unknown) => {
    const normalized = normalizeLoudnessGroups(value)
    for (const group of normalized) {
      for (const track of group.tracks)
        track.filePath = normalizeLocalPath(track.filePath, 'loudness path')
    }
    stringifyJsonForIpcStorage(normalized, 'loudness batch', 16 * 1024 * 1024)
    return normalized
  }
  return {
    start: async (event: unknown, value: unknown) => {
      assertSender(event)
      return manager.start(groups(value))
    },
    cancel: async (event: unknown, jobId: unknown) => {
      assertSender(event)
      await manager.cancel(normalizeIpcString(jobId, 'loudness job id', 128))
    },
    snapshot: async (event: unknown) => {
      assertSender(event)
      return manager.snapshot()
    },
    results: async (event: unknown, value: unknown) => {
      assertSender(event)
      return manager.results(groups(value))
    },
    clear: async (event: unknown, value: unknown) => {
      assertSender(event)
      if (!Array.isArray(value) || !value.length || value.length > MAX_LOUDNESS_BATCH_TRACKS)
        throw new Error('响度结果清理范围无效')
      manager.clear(value.map((id) => normalizeIpcString(id, 'loudness result id', 8192)))
    }
  }
}
