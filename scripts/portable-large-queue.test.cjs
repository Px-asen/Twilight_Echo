const assert = require('node:assert/strict')
const test = require('node:test')
const { createEmbeddedHarness, createFakePlatform } = require('./portable-embedded-harness.cjs')

for (const count of [200, 201, 1410]) {
  test(`embedded queue replacement retains all ${count} tracks, selection and order`, async () => {
    const h = createEmbeddedHarness({ platform: createFakePlatform() })
    assert.equal((await h.boot({ epoch: 'large-queue' })).boot.ok, true)
    const tracks = Array.from({ length: count }, (_, i) => ({
      id: `desktop-stream:${i}`, source: `content://large/${i}`, title: `Song ${i}`, duration: 210
    }))
    const startIndex = count - 2
    const response = await h.request('playback.replaceQueue', { tracks, startIndex, play: false })
    assert.equal(response.ok, true, JSON.stringify(response.error))
    const snapshot = await h.snapshot()
    assert.equal(snapshot.queue.total, count)
    assert.equal(snapshot.queue.index, startIndex)
    assert.equal(snapshot.track.id, tracks[startIndex].id)
    assert.notEqual(snapshot.playback.state, 'playing')
    const ids = []
    for (let offset = 0; offset < count; offset += 100) {
      const page = await h.request('playback.getQueueWindow', {
        id: snapshot.queue.id, revision: snapshot.queue.revision, offset, limit: 100
      }, 'query')
      assert.equal(page.ok, true, JSON.stringify(page.error))
      ids.push(...page.value.items.map(item => item.track.id))
    }
    assert.deepEqual(ids, tracks.map(track => track.id))
    const playing = await h.request('playback.play', { position: 0 })
    assert.equal(playing.ok, true, JSON.stringify(playing.error))
    assert.equal((await h.snapshot()).track.id, tracks[startIndex].id)
    assert.equal((await h.shutdown()).ok, true)
  })
}
