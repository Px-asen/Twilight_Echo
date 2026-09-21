import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_TAG_COVER_BYTES,
  hasTagPatch,
  successfulTagPaths,
  summarizeTagWriteResults,
  tagPatchFromForm,
  toDuplicateReviewGroups,
  validateTagCoverFile
} from './localLibraryTagManagement.ts'

test('tag editor validates image type and bounded cover size before IPC', () => {
  assert.equal(validateTagCoverFile({ type: 'image/gif', size: 10 }), '封面只支持 PNG 或 JPEG 图片')
  assert.equal(validateTagCoverFile({ type: 'image/png', size: 0 }), '封面文件为空')
  assert.equal(
    validateTagCoverFile({ type: 'image/jpeg', size: MAX_TAG_COVER_BYTES + 1 }),
    '封面不能超过 8 MiB'
  )
  assert.equal(validateTagCoverFile({ type: 'image/png', size: 12 }), null)
})

test('tag editor preserves per-file outcomes instead of treating rollback as success', () => {
  const results = [
    { filePath: 'a.wav', status: 'success' as const },
    { filePath: 'b.wav', status: 'failed' as const, message: 'denied' },
    { filePath: 'c.wav', status: 'rolledBack' as const },
    { filePath: 'd.wav', status: 'notAttempted' as const }
  ]
  assert.deepEqual(summarizeTagWriteResults(results), {
    successCount: 1,
    failedCount: 1,
    rolledBackCount: 1,
    notAttemptedCount: 1
  })
  assert.deepEqual(successfulTagPaths(results), ['a.wav'])
})

test('tag form creates a bounded patch and duplicate review is presentation only', () => {
  const patch = tagPatchFromForm({
    title: '  Updated  ',
    artist: undefined,
    album: undefined,
    albumArtist: undefined,
    track: 2,
    disc: 0,
    year: 2026,
    genre: '  Rock ',
    coverData: undefined
  })
  assert.deepEqual(patch, { title: 'Updated', track: 2, year: 2026, genre: 'Rock' })
  assert.equal(hasTagPatch(patch), true)
  const groups = toDuplicateReviewGroups({
    groups: [
      {
        key: 'hash:abc',
        kind: 'contentHash',
        confidence: 'exact',
        items: []
      }
    ],
    suggestions: [
      {
        action: 'mergeSuggestion',
        group: { key: 'hash:abc', kind: 'contentHash', confidence: 'exact', items: [] },
        keepId: null,
        affectedIds: [],
        requiresConfirmation: true,
        destructive: false
      }
    ],
    contentHashUnavailableIds: []
  })
  assert.equal(groups[0].label, '相同文件 hash · 精确置信度')
  assert.equal(groups[0].suggestion?.destructive, false)
})

test('blank batch form fields stay absent so a batch edit cannot clear unrelated tags', () => {
  const patch = tagPatchFromForm({
    title: undefined,
    artist: undefined,
    album: undefined,
    albumArtist: undefined,
    track: undefined,
    disc: undefined,
    year: undefined,
    genre: 'Electronic',
    coverData: undefined
  })
  assert.deepEqual(patch, { genre: 'Electronic' })
})

test('typing and clearing text or whitespace never clears existing tags', () => {
  assert.deepEqual(
    tagPatchFromForm({
      title: '',
      artist: '  ',
      album: '\t',
      albumArtist: undefined,
      genre: ' Jazz ',
      track: undefined,
      disc: undefined,
      year: undefined,
      coverData: undefined
    }),
    { genre: 'Jazz' }
  )
})
