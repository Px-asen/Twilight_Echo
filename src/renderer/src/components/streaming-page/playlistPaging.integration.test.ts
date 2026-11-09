import assert from 'node:assert/strict'
import * as files from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { ref, shallowRef, watch } from 'vue'
import { CoreBrowseService } from '../../../../core/browse/service.ts'
import type { CoreRequestEnvelope } from '../../../../shared/coreProtocol.ts'
import { createBrowseWindow } from '../../stores/browseSessions.ts'
import type { CorePlayerClient } from '../../stores/player/corePlayerTypes.ts'
import type { Track } from '../../types/music'

const source = readFileSync(new URL('../StreamingPage.vue', import.meta.url), 'utf8')
const ast = ts.createSourceFile(
  'page.ts',
  source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1],
  ts.ScriptTarget.Latest,
  true
)
const functions = ast.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    ['openPlaylist', 'loadBrowseRange'].includes(node.name?.text ?? '')
)
const code = ts.transpileModule(functions.map((node) => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText

async function setup(t: test.TestContext, paged = true) {
  const root = await files.mkdtemp(join(tmpdir(), 'twilight-playlist-browse-'))
  const calls: Array<{ method: string; args: unknown[] }> = []
  let fail = false
  const track = (i: number) => ({
    id: `bili:${i}`,
    title: `Track ${i}`,
    artist: '',
    album: '',
    source: 'bili',
    duration: 1,
    size: 0,
    filePath: '',
    fileName: '',
    cover: null,
    lyrics: null
  })
  const service = new CoreBrowseService({
    files,
    root,
    newId: () => 'playlist-session',
    providerContext: () => 'account',
    callProvider: async (provider, method, args) => {
      assert.equal(provider, 'bili')
      assert.equal(args[0], 'large')
      calls.push({ method, args: [...args] })
      if (fail) throw new Error('rate limited')
      if (method === 'fetchPlaylistTracks') return [track(0)]
      assert.equal(method, 'fetchPlaylistTracksPage')
      const offset = Number(args[1]),
        limit = Number(args[2])
      return {
        tracks: Array.from({ length: Math.min(limit, 4201 - offset) }, (_, i) => track(offset + i)),
        total: 4201,
        nextOffset: Math.min(4201, offset + limit),
        hasMore: offset + limit < 4201
      }
    }
  })
  const invoke = (name: string, payload: unknown, signal = new AbortController().signal) =>
    service.execute(
      'page',
      {
        kind: ['browse.open', 'browse.release'].includes(name) ? 'command' : 'query',
        name,
        payload
      } as CoreRequestEnvelope,
      signal
    )
  const client = { command: invoke, query: invoke } as Pick<CorePlayerClient, 'command' | 'query'>
  const detailBrowse = createBrowseWindow(client, () => false, 4)
  const detailTracks = shallowRef<Track[]>([])
  const stop = watch(
    detailBrowse.state,
    (value) => {
      detailTracks.value = value.tracks
    },
    { flush: 'sync' }
  )
  t.after(async () => {
    stop()
    detailBrowse.dispose()
    await service.shutdown()
    await files.rm(root, { recursive: true, force: true })
  })
  const currentDetail = ref<{ type: string; playlist: { id: string; trackCount?: number } } | null>(
    null
  )
  const detailLoading = ref(false),
    detailError = ref('')
  let token = 0
  const methods = runInNewContext(`${code}\n({openPlaylist,loadBrowseRange})`, {
    detailTracks,
    detailBrowse,
    browseState: detailBrowse.state,
    detailLoading,
    detailError,
    currentDetail,
    restoringPage: false,
    restoringBrowse: false,
    activeProvider: ref('bili'),
    isExternalActive: ref(true),
    beginDetailTransition() {},
    pushDetail: (detail: typeof currentDetail.value) => {
      currentDetail.value = detail
    },
    replaceTopDetail: (detail: typeof currentDetail.value) => {
      currentDetail.value = detail
    },
    beginDetailLoad: () => {
      detailBrowse.reset()
      detailLoading.value = true
      return ++token
    },
    isActiveDetailLoad: (value: number) => value === token,
    providerStore: {
      getProvider: () => ({
        supportedMethods: paged ? ['fetchPlaylistTracksPage'] : ['fetchPlaylistTracks']
      })
    },
    friendlyStreamingError: (error: unknown) => String(error),
    reportBrowseError: (error: unknown) => {
      detailError.value = String(error)
    }
  }) as {
    openPlaylist: (playlist: { id: string }, force?: boolean) => Promise<void>
    loadBrowseRange: (start: number, end: number) => void
  }
  return {
    methods,
    calls,
    detailBrowse,
    detailTracks,
    currentDetail,
    detailLoading,
    detailError,
    setFailure: (value: boolean) => {
      fail = value
    }
  }
}

test('the playlist handler selects advertised paging and keeps a bounded display window', async (t) => {
  const f = await setup(t)
  await f.methods.openPlaylist({ id: 'large' }, true)
  assert.ok(
    f.calls.every((call) => call.method === 'fetchPlaylistTracksPage' && call.args[3] === true)
  )
  assert.deepEqual(
    f.calls.map((call) => call.args[1]),
    [0, 200, 400, 600]
  )
  assert.equal(f.detailTracks.value.length, 800)
  assert.equal(f.currentDetail.value?.playlist.trackCount, 4201)
  assert.equal(f.detailLoading.value, false)
})

test('virtual range changes replace the window and expose provider failures', async (t) => {
  const f = await setup(t)
  await f.methods.openPlaylist({ id: 'large' })
  f.methods.loadBrowseRange(100, 200)
  assert.equal(f.calls.length, 4)
  f.methods.loadBrowseRange(3000, 3050)
  await new Promise<void>((resolve, reject) => {
    const stop = watch(f.detailBrowse.state, (value) => {
      if (!value.loading) {
        stop()
        value.error ? reject(Error(value.error)) : resolve()
      }
    })
  })
  assert.equal(f.detailBrowse.state.value.offset, 2800)
  assert.ok(f.detailTracks.value.length <= 800)
  f.setFailure(true)
  await assert.rejects(f.detailBrowse.load(4000), /rate limited/)
  assert.match(f.detailBrowse.state.value.error, /rate limited/)
})

test('providers with the original API retain their full-loading behavior through Core', async (t) => {
  const f = await setup(t, false)
  await f.methods.openPlaylist({ id: 'large' })
  assert.deepEqual(f.calls, [{ method: 'fetchPlaylistTracks', args: ['large', false] }])
  assert.equal(f.detailTracks.value[0].id, 'bili:0')
  assert.equal(f.currentDetail.value?.playlist.trackCount, 1)
})
