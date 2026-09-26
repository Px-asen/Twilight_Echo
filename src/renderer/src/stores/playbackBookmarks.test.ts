import assert from 'node:assert/strict'
import test from 'node:test'
import { usePlaybackBookmarks } from './playbackBookmarks.ts'

test('bookmark keys keep plain local files stable and separate sub-tracks of one file', () => {
  const { trackKeyFor } = usePlaybackBookmarks()
  const filePath = 'D:/Music/album.flac'

  assert.equal(trackKeyFor({ id: 'a', filePath, source: 'local' }), `local:${filePath}`)
  assert.equal(trackKeyFor({ id: 'remote-1', filePath: '', source: 'ncm' }), 'ncm:remote-1')

  const cueKeys = [0, 245.5].map((startSeconds) =>
    trackKeyFor({
      id: `cue-${startSeconds}`,
      filePath,
      source: 'local',
      cueRange: { startSeconds, endSeconds: startSeconds + 200, pregapSeconds: 0 }
    })
  )
  assert.notEqual(cueKeys[0], cueKeys[1])

  const isoKeys = ['#sacd-stereo-1', '#sacd-stereo-2'].map((area) =>
    trackKeyFor({ id: area, filePath: 'D:/Music/disc.iso', source: 'local', subTrack: area })
  )
  assert.notEqual(isoKeys[0], isoKeys[1])
})
