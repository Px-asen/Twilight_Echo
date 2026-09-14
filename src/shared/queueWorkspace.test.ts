import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isQueueWorkspaceDocument,
  isSavedQueueTrack,
  type NamedQueueSession
} from './queueWorkspace.ts'

const session = (): NamedQueueSession => ({
  id: 'work',
  name: '工作',
  createdAt: '2026-09-14T00:00:00Z',
  updatedAt: '2026-09-14T00:00:00Z',
  playMode: 'shuffle',
  entries: [
    {
      id: 'song',
      queueEntryId: 'q1',
      title: 'Song',
      artist: '',
      album: '',
      duration: 100,
      source: 'local',
      filePath: 'C:\\music\\song.flac'
    }
  ],
  originalEntryIds: ['q1'],
  currentEntryId: 'q1',
  position: 12
})

test('workspace boundary accepts stable identities and rejects stale media fields and inconsistent cursors', () => {
  assert.equal(isQueueWorkspaceDocument({ version: 1, sessions: [session()], history: [] }), true)
  assert.equal(
    isSavedQueueTrack({
      ...session().entries[0],
      source: 'ncm',
      filePath: 'https://expired.test/a'
    }),
    false
  )
  assert.equal(
    isSavedQueueTrack({ ...session().entries[0], streamUrl: 'twilight-media://expired' }),
    false
  )
  assert.equal(
    isQueueWorkspaceDocument({
      version: 1,
      sessions: [{ ...session(), currentEntryId: 'missing' }],
      history: []
    }),
    false
  )
  assert.equal(
    isQueueWorkspaceDocument({
      version: 1,
      sessions: [{ ...session(), originalEntryIds: [] }],
      history: []
    }),
    false
  )
  assert.equal(
    isQueueWorkspaceDocument({
      version: 1,
      sessions: [{ ...session(), position: NaN }],
      history: []
    }),
    false
  )
  assert.equal(
    isQueueWorkspaceDocument({
      version: 1,
      sessions: [
        {
          ...session(),
          entries: [session().entries[0], session().entries[0]],
          originalEntryIds: ['q1', 'q1']
        }
      ],
      history: []
    }),
    false
  )
})

test('workspace bounds session count, aggregate entries and actual history independently', () => {
  assert.equal(
    isQueueWorkspaceDocument({
      version: 1,
      sessions: Array.from({ length: 21 }, (_, index) => ({ ...session(), id: String(index) })),
      history: []
    }),
    false
  )
  const history = Array.from({ length: 201 }, (_, index) => ({
    id: String(index),
    playedAt: '2026-09-14T00:00:00Z',
    track: session().entries[0],
    playMode: 'heart'
  }))
  assert.equal(isQueueWorkspaceDocument({ version: 1, sessions: [], history }), false)
  assert.equal(
    isQueueWorkspaceDocument({ version: 1, sessions: [], history: history.slice(1) }),
    true
  )
})
