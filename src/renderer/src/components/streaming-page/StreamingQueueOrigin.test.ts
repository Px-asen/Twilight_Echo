import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { nextTick, ref } from 'vue'
import type { StreamingCollectionNavigationRequest } from '../../utils/queuePlaybackOrigin.ts'

const source = readFileSync(new URL('../StreamingPage.vue', import.meta.url), 'utf8')

function navigationHarness() {
  const routing = source.slice(
    source.indexOf('let detailNavigationProvider:'),
    source.indexOf('async function openTrackAlbum(')
  )
  const collection = source.slice(
    source.indexOf('async function openRequestedCollection('),
    source.indexOf('async function openUserList(')
  )
  const opened: Array<{ kind: string; id: string; provider: string }> = []
  const notices: Array<{ message: string }> = []
  const selected: string[] = []
  const scope = {
    nextTick,
    props: { active: true },
    activeProvider: ref('other'),
    providerStore: { syncProviders: async () => {} },
    mediaProviders: {
      get: (id: string) =>
        id === 'ncm'
          ? {
              name: '网易云音乐',
              fetchAlbumTracks: async () => [],
              fetchPlaylistTracks: async () => []
            }
          : undefined
    },
    selectProvider: (id: string) => {
      selected.push(id)
      scope.activeProvider.value = id
    },
    pushNotice: (notice: { message: string }) => notices.push(notice),
    openAlbum: async (album: { id: string }, provider: string) => {
      opened.push({ kind: 'album', id: album.id, provider })
    },
    openPlaylist: async (playlist: { id: string }) => {
      opened.push({ kind: 'playlist', id: playlist.id, provider: scope.activeProvider.value })
    }
  }
  const runtime = runInNewContext(
    stripTypeScriptTypes(
      `let detailNavigationToken = 0\n${routing}\n${collection}\n;({ openRequestedCollection, cancel: () => detailNavigationToken++ })`
    ),
    scope
  ) as {
    openRequestedCollection: (request: StreamingCollectionNavigationRequest) => Promise<void>
    cancel: () => void
  }
  return { scope, runtime, opened, selected, notices }
}

function request(kind: 'album' | 'playlist', id: string): StreamingCollectionNavigationRequest {
  return { key: 1, origin: { kind, scope: 'provider', providerId: 'ncm', id, name: 'Source' } }
}

test('queue album and playlist links open their captured provider identity while browsing another provider', async () => {
  const h = navigationHarness()
  await h.runtime.openRequestedCollection(request('album', 'album-12'))
  await h.runtime.openRequestedCollection(request('playlist', 'playlist-34'))
  assert.deepEqual(h.opened, [
    { kind: 'album', id: 'album-12', provider: 'ncm' },
    { kind: 'playlist', id: 'playlist-34', provider: 'ncm' }
  ])
  assert.deepEqual(h.selected, ['ncm'])
})

test('navigation away or a newer source click cancels an older queue source lookup', async () => {
  const h = navigationHarness()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  h.scope.providerStore.syncProviders = () => pending
  const older = h.runtime.openRequestedCollection(request('album', 'older'))
  h.runtime.cancel()
  release()
  await older
  assert.equal(h.opened.length, 0)
  h.scope.providerStore.syncProviders = async () => {}
  await h.runtime.openRequestedCollection(request('album', 'newer'))
  assert.equal(h.opened[0]?.id, 'newer')
})

test('a removed provider keeps the user on the current page and explains unavailable playback source', async () => {
  const h = navigationHarness()
  const source = request('playlist', 'removed')
  source.origin.providerId = 'removed-provider'
  await h.runtime.openRequestedCollection(source)
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.selected, [])
  assert.match(h.notices[0].message, /暂不支持此播放来源/)
})
