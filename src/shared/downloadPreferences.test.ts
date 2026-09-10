import assert from 'node:assert/strict'
import test from 'node:test'
import {
  downloadTrackName,
  normalizeDownloadPreferences,
  DEFAULT_DOWNLOAD_PREFERENCES
} from './downloadPreferences.ts'

test('old settings retain provider filenames and optional writes are opt in', () => {
  assert.deepEqual(normalizeDownloadPreferences(null), DEFAULT_DOWNLOAD_PREFERENCES)
  assert.deepEqual(
    normalizeDownloadPreferences({ naming: '../../x', embedMetadata: 'true' }),
    DEFAULT_DOWNLOAD_PREFERENCES
  )
})

test('download naming supports both artist/title orders without losing Unicode', () => {
  const track = { title: '夜曲', artist: '周杰伦' }
  assert.equal(downloadTrackName(track, 'artist-title'), '周杰伦 - 夜曲')
  assert.equal(downloadTrackName(track, 'title-artist'), '夜曲 - 周杰伦')
  assert.equal(downloadTrackName(track, 'provider'), null)
})
