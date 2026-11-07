import { CoreStatisticsService } from '../../../core/listening/service.ts'
import { recordListeningSeconds } from '../../../core/listening/model.ts'
import { useCoreConnection } from '../stores/coreConnection.ts'

export async function installListeningCoreFixture(localTracks, databaseCalls) {
  const listeners = new Set()
  let service, serial = 0, persisted = { days: {}, tracks: {} }
  let data = structuredClone(persisted)
  let persistenceError = null
  const snapshot = () => ({ protocolVersion: 1, epoch: 'journal-' + serial, sequence: service.getRevision(), phase: 'ready',
    statisticsRevision: service.getRevision(), libraryRevision: 1 })
  const publish = () => {
    const state = snapshot()
    for (const listener of listeners) listener({ connectionId: 'journal', message: { kind: 'state', epoch: state.epoch, sequence: state.sequence, snapshot: state } })
  }
  const replace = async next => {
    await service?.shutdown()
    data = structuredClone(next)
    persisted = structuredClone(data)
    serial++
    service = new CoreStatisticsService({
      repository: { load: async () => structuredClone(data), recover: async () => null,
        publish: async () => { persisted = service.exportData() } },
      now: Date.now,
      resolveLocalTracks: async ids => localTracks.value.filter(track => ids.includes(track.id)),
      timers: { setTimeout: (fn, delay) => setTimeout(fn, delay), clearTimeout: id => clearTimeout(id) },
      changed: publish
    })
    await service.initialize()
    publish()
    if (window.api.core) await useCoreConnection().refresh()
  }
  await replace(data)
  window.api.core = {
    connect: async () => ({ ok: true, value: { connectionId: 'journal', snapshot: snapshot() } }),
    onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    onStatus: () => () => {}, disconnect: async () => ({ ok: true }), cancel: async () => ({ ok: true }),
    request: async (_id, { name, payload }) => {
      try {
        let value
        switch (name) {
          case 'statistics.overview':
            value = await service.overview()
            if (persistenceError) value.persistence = { error: persistenceError, dirty: true, failureCount: 1 }
            break
          case 'statistics.tracks': {
            value = await service.projectPage(payload)
            break
          }
          case 'statistics.previewClear': value = service.previewClear(payload.range, payload.revision); break
          case 'statistics.clear': await service.clear(payload.range, payload.revision); data = service.exportData(); value = true; break
          case 'library.tracks': {
            databaseCalls.push({ type: 'artist', query: payload })
            const tracks = localTracks.value.filter(track => !payload.artist || track.artist === payload.artist)
            value = { revision: 1, offset: 0, total: tracks.length, tracks: [] }
            break
          }
          default: throw new Error('Unexpected journal request: ' + name)
        }
        return { ok: true, value }
      } catch (error) { return { ok: false, error: { code: error.code ?? 'FAILED', message: error.message } } }
    }
  }
  await useCoreConnection().attach()
  return {
    replace,
    data: () => data,
    persisted: () => persisted,
    flush: () => replace(data),
    record(track, seconds, timestamp) { recordListeningSeconds(data, track, seconds, timestamp, 1) },
    async error(message) { persistenceError = message; await replace(data) }
  }
}
