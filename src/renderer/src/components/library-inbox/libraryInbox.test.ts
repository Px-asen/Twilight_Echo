import assert from 'node:assert/strict'
import test from 'node:test'
import type { Track } from '@renderer/types/music'
import {
  buildInboxIssues,
  currentInboxTracks,
  inboxStatus,
  parseInboxDecisions,
  serializeInboxDecisions,
  type InboxDecision
} from './libraryInbox.ts'

const track = (id = '1', patch: Partial<Track> = {}): Track => ({
  id,
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  source: 'local',
  filePath: `D:/music/${id}.flac`,
  fileName: `${id}.flac`,
  size: 100,
  duration: 180,
  cover: null,
  lyrics: null,
  ...patch
})

test('inbox distinguishes missing data, filename candidates and medium-confidence enrichment', () => {
  const result = buildInboxIssues([
    track('1', { title: '1', artist: 'Unknown Artist', album: '未知专辑' }),
    track('2', { coverSource: 'https://example.test/cover' }),
    track('3', {
      metadataMatch: { providerId: 'test', trackId: 'x', confidence: 'medium', score: 0.5 }
    }),
    track('4', { source: 'provider' })
  ])
  assert.deepEqual(
    result.map((issue) => [issue.track.id, issue.kind]),
    [
      ['1', 'cover'],
      ['1', 'tags'],
      ['3', 'cover'],
      ['3', 'enrichment']
    ]
  )
  assert.match(result[1].reason, /可能来自文件名/)
})

test('decisions survive restart but changed metadata and reimport become pending', () => {
  const source = track()
  const issue = buildInboxIssues([source])[0]
  const decisions = parseInboxDecisions(
    serializeInboxDecisions(
      new Map([[issue.key, { fingerprint: issue.fingerprint, status: 'ignored' }]])
    )
  )
  assert.equal(inboxStatus(buildInboxIssues([{ ...source }])[0], decisions), 'ignored')
  assert.equal(
    inboxStatus(buildInboxIssues([{ ...source, album: 'New album' }])[0], decisions),
    'pending'
  )
  assert.equal(
    inboxStatus(buildInboxIssues([{ ...source, addedAt: 123 }])[0], decisions),
    'pending'
  )
  assert.equal(buildInboxIssues([{ ...source, cover: 'cover' }]).length, 0)
  assert.throws(() => parseInboxDecisions('{'))
  assert.throws(() => parseInboxDecisions('{"version":2}'))
  assert.deepEqual(
    [...parseInboxDecisions('{"version":1,"entries":[null,["a",{"status":"other"}]]}')],
    []
  )
})

test('CUE entries remain separate and changed source objects reject late updates', () => {
  const first = track('cue1', { filePath: 'D:/album.flac', subTrack: '1' })
  const second = track('cue2', { filePath: 'D:/album.flac', subTrack: '2' })
  const issues = buildInboxIssues([first, second])
  assert.notEqual(issues[0].key, issues[1].key)
  assert.deepEqual(currentInboxTracks([first, second], [{ ...first }, second]), [second])
  assert.deepEqual(currentInboxTracks([first], []), [])
})

test('10k issues retain track references and duplicate review creates no mutations', () => {
  const sources = Array.from({ length: 10000 }, (_, index) => track(String(index)))
  const result = buildInboxIssues(sources)
  assert.equal(result.length, 10000)
  assert.equal(result[9999].track, sources[9999])
  const duplicate = buildInboxIssues(sources, {
    groups: [{ key: 'group', kind: 'metadataCandidate', confidence: 'possible', items: sources }],
    suggestions: [],
    contentHashUnavailableIds: []
  })
  assert.equal(duplicate.length, 20000)
  assert.ok(duplicate[19999].key.length < 500)
  const decisions = new Map<string, InboxDecision>()
  for (const issue of result)
    decisions.set(issue.key, { fingerprint: issue.fingerprint, status: 'done' })
  assert.equal(parseInboxDecisions(serializeInboxDecisions(decisions)).size, 10000)
  assert.equal(sources[0].title, 'Title')
})

test('duplicate decisions expire when group membership changes and canonical Windows paths match', () => {
  const first = track('1')
  const second = track('2')
  const third = track('3')
  const duplicateIssues = (members: Track[]) =>
    buildInboxIssues([first, second, third], {
      groups: [{ key: 'same', kind: 'metadataCandidate', confidence: 'possible', items: members }],
      suggestions: [],
      contentHashUnavailableIds: []
    }).filter((issue) => issue.kind === 'duplicate')
  const previous = duplicateIssues([{ ...first, filePath: 'd:\\MUSIC\\1.flac' }, second])[0]
  assert.ok(previous)
  const decisions = new Map<string, InboxDecision>([
    [previous.key, { fingerprint: previous.fingerprint, status: 'done' }]
  ])
  const changed = duplicateIssues([first, third])[0]
  assert.equal(previous.key, changed.key)
  assert.equal(inboxStatus(changed, decisions), 'pending')
})
