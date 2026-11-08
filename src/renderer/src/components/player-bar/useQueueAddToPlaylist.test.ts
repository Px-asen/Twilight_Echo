import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { ref } from 'vue'
import type { Track } from '../../types/music.ts'
import type { MediaProviderPlaylistSummary } from '../../providers/mediaProvider.ts'
import {
  useQueueAddToPlaylist,
  type QueuePlaylistEntry,
  type QueueAddToPlaylistNotice,
  type QueuePlaylistTarget
} from './useQueueAddToPlaylist.ts'

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: 'local:moon',
    queueEntryId: 'entry:1',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'Breakfast',
    filePath: 'D:/Music/Moon River.flac',
    fileName: 'Moon River.flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local',
    ...overrides
  }
}

const ncmTrack = track({
  id: 'ncm:123',
  queueEntryId: 'entry:2',
  filePath: 'ncm:123',
  source: 'ncm',
  ncmSongId: 123
})

function remotePlaylist(
  overrides: Partial<MediaProviderPlaylistSummary> = {}
): MediaProviderPlaylistSummary {
  return { id: 7, name: '我的歌单', cover: null, trackCount: 4, owned: true, ...overrides }
}

type ProviderStub = {
  name?: string
  fetchUserLibrary?: (force?: boolean) => Promise<{
    likedPlaylist: MediaProviderPlaylistSummary | null
    playlists: MediaProviderPlaylistSummary[]
  }>
  addTracksToPlaylist?: (
    playlistId: number | string,
    trackIds: Array<number | string>
  ) => Promise<void>
  createPlaylist?: (name: string) => Promise<MediaProviderPlaylistSummary>
}

function createPicker(options: {
  queue?: Track[]
  playlists?: Array<QueuePlaylistTarget & { trackIds?: string[] }>
  provider?: ProviderStub | null
  addedCount?: number
  calls: string[]
  notices: QueueAddToPlaylistNotice[]
}) {
  return useQueueAddToPlaylist({
    queue: ref(options.queue ?? [track()]),
    playlists: ref(options.playlists ?? [{ id: 'pl_1', name: '深夜', count: 0 }]),
    getPlaylistMembership: async (id, ids) => ids.map(trackId => options.playlists?.find(p => p.id === id)?.trackIds?.includes(trackId) ?? false),
    mediaProviders: { get: () => options.provider ?? null } as never,
    addTracksToPlaylist: (name, tracks) => {
      options.calls.push(`local-add:${name}:${tracks.map((item) => item.id).join(',')}`)
      return options.addedCount ?? 1
    },
    createPlaylistWithTracks: (name, tracks) => {
      options.calls.push(`local-create:${name}:${tracks.map((item) => item.id).join(',')}`)
      return 'pl_new'
    },
    notify: (notice) => options.notices.push(notice)
  })
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('now playing picker accepts a track outside the queue and keeps the clicked snapshot', async () => {
  const calls: string[] = []
  const notices: QueueAddToPlaylistNotice[] = []
  const picker = createPicker({ queue: [], calls, notices })
  const current = track({ queueEntryId: undefined })
  picker.openForTrack(current)
  current.id = 'local:next-song'
  await picker.addToLocalPlaylist('深夜')
  assert.deepEqual(calls, ['local-add:深夜:local:moon'])
  assert.equal(picker.open.value, false)
  assert.equal(notices[0].kind, 'success')
})

test('queue picker adds the entry it was opened for to a local playlist and reports the result', async () => {
  const calls: string[] = []
  const notices: QueueAddToPlaylistNotice[] = []
  const picker = createPicker({
    playlists: [
      { id: 'pl_1', name: '深夜', trackIds: [] },
      { id: 'pl_2', name: '已有', trackIds: ['local:moon'] }
    ],
    calls,
    notices
  })

  picker.openForEntry('entry:1')
  await settle()

  assert.equal(picker.open.value, true)
  assert.equal(picker.targetLabel.value, 'Moon River · Audrey')
  assert.deepEqual(
    picker.localPlaylists.value.map((item) => `${item.name}:${item.contains}`),
    ['深夜:false', '已有:true']
  )
  // A local file has no remote library to write to, so the section stays hidden.
  assert.equal(picker.providerId.value, null)

  await picker.addToLocalPlaylist('深夜')

  assert.deepEqual(calls, ['local-add:深夜:local:moon'])
  assert.deepEqual(notices, [{ kind: 'success', message: '已添加到歌单「深夜」' }])
  assert.equal(picker.open.value, false)
  assert.equal(picker.targetTrack.value, null)
})

test('queue picker reports a duplicate instead of claiming a new addition', async () => {
  const calls: string[] = []
  const notices: QueueAddToPlaylistNotice[] = []
  const picker = createPicker({ addedCount: 0, calls, notices })

  picker.openForEntry('entry:1')
  await picker.addToLocalPlaylist('深夜')

  assert.deepEqual(notices, [{ kind: 'info', message: '「Moon River」已在歌单「深夜」中' }])
})

test('queue picker creates a local playlist seeded with the entry', async () => {
  const calls: string[] = []
  const notices: QueueAddToPlaylistNotice[] = []
  const picker = createPicker({ calls, notices })

  picker.openForEntry('entry:1')
  picker.startCreate('local')
  picker.newPlaylistName.value = '  新的   歌单  '
  assert.equal(picker.canConfirmCreate.value, true)
  await picker.confirmCreate()

  assert.deepEqual(calls, ['local-create:新的 歌单:local:moon'])
  assert.deepEqual(notices, [{ kind: 'success', message: '已创建歌单「新的 歌单」并添加' }])
  assert.equal(picker.open.value, false)
})

test('Core queue picker sends the selected occurrence and waits for its write acknowledgement', async () => {
  const notices: QueueAddToPlaylistNotice[] = []
  const writes: Array<{ id: string; entry: QueuePlaylistEntry }> = []
  let acknowledge!: () => void
  const picker = useQueueAddToPlaylist({
    queue: ref([]),
    playlists: ref([{ id: 'pl_1', name: '深夜', count: 9 }]),
    mediaProviders: { get: () => null } as never,
    addTracksToPlaylist: () => { throw new Error('Display data must not be written as a track') },
    createPlaylistWithTracks: () => { throw new Error('Display data must not seed a playlist') },
    addQueueEntry: async (id, entry) => {
      writes.push({ id, entry })
      await new Promise<void>(resolve => { acknowledge = resolve })
      return 1
    },
    notify: notice => notices.push(notice)
  })
  const entry: QueuePlaylistEntry = {
    id: 'network:moon', title: 'Moon River', artist: 'Audrey', album: 'Breakfast', duration: 180, size: 1,
    source: 'network', queueEntryId: 'occurrence:7', queue: { id: 'queue:1', revision: 4 }
  }
  picker.openForTrack(entry)
  const writing = picker.addToLocalPlaylist('深夜')
  assert.equal(picker.busyTarget.value, 'local:深夜')
  assert.equal(picker.localPlaylists.value[0].trackCount, 9)
  assert.equal(notices.length, 0)
  assert.equal('filePath' in writes[0].entry, false)
  assert.deepEqual(writes[0], { id: 'pl_1', entry })
  acknowledge()
  await writing
  assert.equal(picker.open.value, false)
  assert.equal(notices[0].kind, 'success')
})

test('Core occurrence write failure keeps the picker open and never reports success', async () => {
  const notices: QueueAddToPlaylistNotice[] = []
  let writes = 0
  const picker = useQueueAddToPlaylist({
    queue: ref([]),
    playlists: ref([{ id: 'pl_1', name: '深夜', count: 0 }]),
    mediaProviders: { get: () => null } as never,
    addTracksToPlaylist: () => 0,
    createPlaylistWithTracks: () => 'unused',
    addQueueEntry: async () => { writes++; throw new Error('队列已变化，请重试') },
    notify: notice => notices.push(notice)
  })
  picker.openForTrack({
    id: 'local:moon', title: 'Moon River', artist: '', album: '', duration: 180, size: 1,
    queueEntryId: 'occurrence:7', queue: { id: 'queue:1', revision: 4 }
  })
  await picker.addToLocalPlaylist('深夜')
  assert.equal(picker.open.value, true)
  assert.equal(picker.busyTarget.value, null)
  assert.equal(picker.errorMessage.value, '队列已变化，请重试')
  assert.equal(writes, 1)
  assert.equal(notices.length, 0)
})

test('a streaming entry lists the provider playlists it owns and writes with the remote song id', async () => {
  const calls: string[] = []
  const notices: QueueAddToPlaylistNotice[] = []
  const picker = createPicker({
    queue: [ncmTrack],
    calls,
    notices,
    provider: {
      name: '网易云音乐',
      fetchUserLibrary: async () => ({
        likedPlaylist: null,
        playlists: [remotePlaylist(), remotePlaylist({ id: 8, name: '收藏的', owned: false })]
      }),
      addTracksToPlaylist: async (playlistId, trackIds) => {
        calls.push(`remote-add:${playlistId}:${trackIds.join(',')}`)
      }
    }
  })

  picker.openForEntry('entry:2')
  await settle()

  assert.equal(picker.providerId.value, 'ncm')
  assert.equal(picker.providerName.value, '网易云音乐')
  assert.equal(picker.providerWritable.value, true)
  assert.equal(picker.providerLoading.value, false)
  assert.deepEqual(
    picker.providerPlaylists.value.map((item) => item.name),
    ['我的歌单']
  )

  await picker.addToProviderPlaylist(remotePlaylist())

  assert.deepEqual(calls, ['remote-add:7:123'])
  assert.deepEqual(notices, [{ kind: 'success', message: '已添加到网易云音乐歌单「我的歌单」' }])
  assert.equal(picker.open.value, false)
})

test('a streaming provider without library writes explains itself instead of listing playlists', async () => {
  const calls: string[] = []
  const notices: QueueAddToPlaylistNotice[] = []
  const picker = createPicker({
    queue: [ncmTrack],
    calls,
    notices,
    provider: { name: '网易云音乐' }
  })

  picker.openForEntry('entry:2')
  await settle()

  assert.equal(picker.providerId.value, 'ncm')
  assert.equal(picker.providerWritable.value, false)
  assert.equal(picker.providerLoading.value, false)
  assert.deepEqual(picker.providerPlaylists.value, [])
})

test('a source with no registered provider hides the remote section', async () => {
  const picker = createPicker({
    queue: [track({ id: 'network:share/a.flac', queueEntryId: 'entry:3', source: 'network' })],
    provider: null,
    calls: [],
    notices: []
  })

  picker.openForEntry('entry:3')
  await settle()

  assert.equal(picker.providerId.value, null)
  assert.equal(picker.providerLoading.value, false)
})

test('a failed remote playlist read is reported and retryable without breaking the local list', async () => {
  let attempt = 0
  const picker = createPicker({
    queue: [ncmTrack],
    calls: [],
    notices: [],
    provider: {
      name: '网易云音乐',
      addTracksToPlaylist: async () => {},
      fetchUserLibrary: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('登录状态已失效，请重新登录')
        return { likedPlaylist: null, playlists: [remotePlaylist()] }
      }
    }
  })

  picker.openForEntry('entry:2')
  await settle()

  assert.equal(picker.providerError.value, '登录状态已失效，请重新登录')
  assert.equal(picker.providerLoading.value, false)
  assert.equal(picker.localPlaylists.value.length, 1)

  await picker.reloadProviderPlaylists()

  assert.equal(picker.providerError.value, '')
  assert.deepEqual(
    picker.providerPlaylists.value.map((item) => item.name),
    ['我的歌单']
  )
})

test('a remote write failure keeps the picker open so another target can be chosen', async () => {
  const notices: QueueAddToPlaylistNotice[] = []
  const picker = createPicker({
    queue: [ncmTrack],
    calls: [],
    notices,
    provider: {
      name: '网易云音乐',
      fetchUserLibrary: async () => ({ likedPlaylist: null, playlists: [remotePlaylist()] }),
      addTracksToPlaylist: async () => {
        // Shape of a provider rejection after Electron re-serializes it.
        throw new Error("Error invoking remote method 'providers:call': Error: 歌单已达上限")
      }
    }
  })

  picker.openForEntry('entry:2')
  await settle()
  await picker.addToProviderPlaylist(remotePlaylist())

  assert.equal(picker.errorMessage.value, '歌单已达上限')
  assert.equal(picker.busyTarget.value, null)
  assert.equal(picker.open.value, true)
  assert.equal(notices.length, 0)
})

test('a streaming entry without a remote song id refuses the remote write locally', async () => {
  const calls: string[] = []
  const picker = createPicker({
    queue: [track({ id: 'ncm-unknown', queueEntryId: 'entry:4', source: 'ncm' })],
    calls,
    notices: [],
    provider: {
      name: '网易云音乐',
      fetchUserLibrary: async () => ({ likedPlaylist: null, playlists: [remotePlaylist()] }),
      addTracksToPlaylist: async (playlistId, trackIds) => {
        calls.push(`remote-add:${playlistId}:${trackIds.join(',')}`)
      }
    }
  })

  picker.openForEntry('entry:4')
  await settle()
  await picker.addToProviderPlaylist(remotePlaylist())

  assert.deepEqual(calls, [])
  assert.equal(picker.errorMessage.value, '该曲目缺少可写入云端歌单的歌曲 ID')
  assert.equal(picker.open.value, true)
})

test('a pending remote read cannot fill the picker after it moved to another entry', async () => {
  let releaseFirst: (() => void) | undefined
  const picker = createPicker({
    queue: [ncmTrack, track({ id: 'local:sun', queueEntryId: 'entry:5' })],
    calls: [],
    notices: [],
    provider: {
      name: '网易云音乐',
      addTracksToPlaylist: async () => {},
      fetchUserLibrary: async () =>
        new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ likedPlaylist: null, playlists: [remotePlaylist({ name: '过期结果' })] })
        })
    }
  })

  picker.openForEntry('entry:2')
  await settle()
  // Switching entries while the first read is in flight: the local file has no
  // remote section, and the stale response must not resurrect one.
  picker.openForEntry('entry:5')
  releaseFirst?.()
  await settle()

  assert.equal(picker.providerId.value, null)
  assert.deepEqual(picker.providerPlaylists.value, [])
})

test('the queue drawer row exposes the picker and the player bar mounts its dialog', () => {
  const source = readFileSync(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
  assert.match(source, /title="添加到歌单"/)
  assert.match(source, /queueAddToPlaylist\.openForEntry\(item\.queueEntryId\)/)
  assert.match(source, /<QueueAddToPlaylistDialog/)
  // The picker is teleported outside the bar, so outside-pointer dismissal has
  // to stand down while it is open or the drawer closes underneath it.
  assert.match(source, /isDismissBlocked: \(\) =>\s*queueAddToPlaylist\.open\.value/)
})

test('the queue picker syncs Core providers without the removed provider bridge', async () => {
  const source = readFileSync(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
  const body = source.match(/syncProviders: async \(\) => \{([\s\S]*?)\n  \}/)![1]
  let calls = 0
  await runInNewContext(`(async () => {${body}\n})()`, {
    window: { api: {} },
    syncPluginProviders: async () => { calls++ }
  })
  assert.equal(calls, 1)
})
