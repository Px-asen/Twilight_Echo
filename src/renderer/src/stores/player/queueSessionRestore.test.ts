import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music'
import { captureQueueSession } from '@renderer/utils/queueSessionTrack.ts'
import { resolveQueueSession, type QueueSessionRestoreSources } from './queueSessionRestore.ts'

const track = (id: string, entryId = id): Track => ({
  id,
  queueEntryId: entryId,
  source: 'local',
  title: id,
  artist: '',
  album: '',
  filePath: `C:\\music\\${id}.flac`,
  fileName: id,
  duration: 100,
  size: 1,
  cover: null,
  lyrics: null
})
const sources = (localTracks: Track[]): QueueSessionRestoreSources => ({
  localTracks: new Map(localTracks.map((track) => [track.id, track])),
  savedStreams: new Map(),
  availableProviders: new Set(),
  networkProfiles: new Set(),
  authorizeFiles: async (paths) => paths.map(() => true),
  isCurrent: () => true
})

test('restore prunes missing files, keeps duplicate occurrences and recalculates the selected index', async () => {
  const queue = [track('missing'), track('a', 'a1'), track('a', 'a2'), track('gone')]
  const session = captureQueueSession('work', queue, [...queue].reverse(), queue[2], 23, 'shuffle')
  const resolver = sources(queue.slice(0, 3))
  const batches: string[][] = []
  resolver.authorizeFiles = async (paths) => {
    batches.push(paths)
    return paths.map((path) => !path.includes('missing'))
  }
  const result = await resolveQueueSession(session, resolver)
  assert.deepEqual(
    result.queue.map((track) => track.queueEntryId),
    ['a1', 'a2']
  )
  assert.deepEqual(
    result.original.map((track) => track.queueEntryId),
    ['a2', 'a1']
  )
  assert.equal(result.index, 1)
  assert.equal(result.position, 23)
  assert.equal(result.missing.length, 2)
  assert.equal(batches.flat().length, 2)
  const missingCursor = await resolveQueueSession(
    { ...session, currentEntryId: 'missing' },
    resolver
  )
  assert.equal(missingCursor.index, 0)
  assert.equal(missingCursor.position, 0)
})

test('restore resolves current station URLs and preserves deferred provider/network identity without old URLs', async () => {
  const queue = [
    { ...track('ncm:1'), source: 'ncm', ncmSongId: 1, streamUrl: 'https://expired.test/ncm' },
    { ...track('plugin:2'), source: 'plugin' },
    { ...track('radio:1'), source: 'radio', filePath: 'https://expired.test/radio' },
    {
      ...track('nas:1'),
      source: 'network',
      networkSource: {
        profileId: 'nas',
        entry: {
          id: 'song',
          profileId: 'nas',
          name: 'song',
          path: '/song.flac',
          kind: 'audio' as const
        }
      }
    }
  ]
  const resolver = sources([])
  resolver.availableProviders = new Set(['ncm'])
  resolver.networkProfiles = new Set(['nas'])
  resolver.savedStreams = new Map([
    [
      'radio:radio:1',
      {
        ...queue[2],
        filePath: 'https://current.test/radio',
        streamUrl: 'https://current.test/radio'
      }
    ]
  ])
  const result = await resolveQueueSession(
    captureQueueSession('remote', queue, queue, queue[0], 5, 'sequential'),
    resolver
  )
  assert.equal(result.queue.length, 3)
  assert.equal(result.missing.length, 1)
  assert.equal(result.deferred, 2)
  assert.equal(result.queue[0].streamUrl, null)
  assert.equal(result.queue[0].filePath, '')
  assert.equal(result.queue[1].streamUrl, 'https://current.test/radio')
  assert.equal(result.queue[2].filePath, '')
  assert.equal(result.queue[2].networkSource?.profileId, 'nas')
})

test('20,000-entry restore batches authorization and aborts before applying stale work', async () => {
  const queue = Array.from({ length: 20_000 }, (_, index) => track(String(index)))
  const session = captureQueueSession('large', queue, queue, queue[19_999], 10, 'sequential')
  const resolver = sources(queue)
  const lengths: number[] = []
  resolver.authorizeFiles = async (paths) => {
    lengths.push(paths.length)
    return paths.map(() => true)
  }
  const restored = await resolveQueueSession(session, resolver)
  assert.equal(restored.index, 19_999)
  assert.equal(restored.queue.length, 20_000)
  assert.ok(lengths.every((length) => length <= 256))
  assert.equal(
    lengths.reduce((sum, length) => sum + length, 0),
    20_000
  )
  let current = true
  resolver.isCurrent = () => current
  resolver.authorizeFiles = async (paths) => {
    current = false
    return paths.map(() => true)
  }
  await assert.rejects(resolveQueueSession(session, resolver), /已取消恢复/)
})
