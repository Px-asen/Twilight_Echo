import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref } from 'vue'
import type { Track } from '../../types/music.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function historyFixture() {
  const text = readFileSync(new URL('../../composables/useLibraryRecentTracks.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('history.ts', text, ts.ScriptTarget.Latest, true)
  const source = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replace(/^export /gm, '')
  const stats = ref<Array<{ displayTrack: Track | null; cover: string | null }>>([]), overview = ref<object | null>(null), error = ref('')
  const mounts: Array<() => void> = [], limits: number[] = []
  let failure = '', hydrations = 0
  const useHistory = runInNewContext(ts.transpileModule(`${source}; useLibraryRecentTracks`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    Error, computed, ref, onMounted: (mount: () => void) => mounts.push(mount),
    getRecentTracks: (limit: number) => { limits.push(limit); return stats.value },
    useListeningStatsStore: () => ({ overview, error }),
    waitForListeningStatsReady: async () => { hydrations++; if (failure) throw Error(failure); overview.value = {} }
  })
  const history = useHistory()
  return { history, stats, overview, error, mounts, limits, fail: (message: string) => { failure = message }, hydrations: () => hydrations }
}

test('online home renders Core-resolved recent display identities and artwork without library matching', async () => {
  const f = historyFixture()
  assert.equal(f.history.state.value.loading, true)
  f.stats.value = Array.from({ length: 10 }, (_, i) => ({ displayTrack: { id: `song:${i}`, title: `Song ${i}`, artist: '', album: '', duration: 10, size: 1 }, cover: `cover://${i}` }))
  assert.equal(f.history.tracks.value.length, 6)
  assert.equal(f.history.tracks.value[0].cover, 'cover://0')
  assert.deepEqual(f.limits, [30])
  f.mounts.forEach(mount => mount())
  await tick()
  assert.equal(f.history.state.value.loading, false)
  assert.equal(f.hydrations(), 1)
  f.stats.value = [{ displayTrack: null, cover: null }, { displayTrack: { id: 'ncm:9', title: 'New', artist: '', album: '', duration: 10, size: 1, source: 'ncm' }, cover: 'twilight-media://image/recent-ncm-9' }]
  assert.deepEqual(f.history.tracks.value.map((track: Track) => ({ id: track.id, cover: track.cover })), [{ id: 'ncm:9', cover: 'twilight-media://image/recent-ncm-9' }])
})

test('online history errors remain visible and a successful explicit retry replaces them', async () => {
  const f = historyFixture()
  f.fail('Core migration unfinished')
  f.mounts.forEach(mount => mount())
  await tick()
  assert.equal(f.history.error.value, 'Core migration unfinished')
  f.fail('')
  f.history.retry()
  await tick()
  assert.equal(f.history.error.value, '')
  assert.equal(f.hydrations(), 2)
  f.error.value = 'Core disconnected'
  assert.equal(f.history.error.value, 'Core disconnected')
})

test('online home owns only UI requests and waits for the Core playback command', async () => {
  const source = readFileSync(new URL('./OnlineDashboard.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /history\.(capture|confirm)|window\.api\.library|useMusicStore|musicVersion/)
  assert.match(source, /await player\.playTrack\(track, queue\)/)
  assert.match(source, /await player\.playTrack\(queue\[0\], queue\)/)
  assert.match(source, /request !== actionRevision/)
})
