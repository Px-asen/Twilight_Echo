import { emptyMusicVersions, editMusicVersions } from '../../../../shared/musicVersions.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'

export async function installVersionsCoreFixture() {
  let document = emptyMusicVersions(), revision = 0, sequence = 0
  let failure = '', invalid = false
  let libraryQuery
  const listeners = new Set()
  const snapshot = () => ({ protocolVersion: 1, epoch: 'versions', sequence,
    phase: 'ready', versionsRevision: revision, libraryRevision: 0, playlistsRevision: 0 })
  const publish = () => {
    sequence++
    for (const listener of listeners) listener({ connectionId: 'versions', message: {
      kind: 'state', epoch: 'versions', sequence, snapshot: snapshot() } })
  }
  globalThis.window ??= {}
  window.api ??= {}
  window.api.core = {
    connect: async () => ({ ok: true, value: { connectionId: 'versions', snapshot: snapshot() } }),
    onMessage: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    onStatus: () => () => {}, disconnect: async () => ({ ok: true }), cancel: async () => ({ ok: true }),
    request: async (_id, { name, payload: p }) => {
      try {
        let value
        if (!['versions.page', 'versions.edit'].includes(name)) return { ok: true, value: await libraryQuery(name, p) }
        if (invalid) throw new Error('版本记录损坏，请重新读取')
        if (p.revision !== revision) throw Object.assign(new Error('版本记录已被其他窗口修改，请重新预览'), { code: 'STALE_REVISION' })
        if (name === 'versions.page') {
          const items = document[p.scope][p.kind]
          value = { revision, offset: p.offset, total: items.length, items: structuredClone(items.slice(p.offset, p.offset + p.limit)) }
        } else if (name === 'versions.edit') {
          if (failure) throw new Error(failure)
          document = editMusicVersions(document, p.scope, p.operation, p.keys, p.label)
          revision++
          publish()
          value = { revision }
        } else throw new Error('Unexpected versions request: ' + name)
        return { ok: true, value }
      } catch (error) { return { ok: false, error: { code: error.code ?? 'FAILED', message: error.message } } }
    }
  }
  await useCoreConnection().attach()
  return {
    persisted: () => document,
    fail: message => { failure = message },
    external: (next, notify = true) => { document = next; revision++; if (notify) publish() },
    invalid: value => { invalid = value; revision++; publish() },
    query: handler => { libraryQuery = handler }
  }
}
