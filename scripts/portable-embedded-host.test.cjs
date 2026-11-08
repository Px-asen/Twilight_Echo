const assert = require('node:assert/strict')
const test = require('node:test')
const { PortError, createEmbeddedHarness, createFakePlatform, wireTrack } = require('./portable-embedded-harness.cjs')

const TRACKS = ['a', 'b', 'c'].map((id) => wireTrack(id))

test('native buffering preserves the playing intent, occurrence and position through pause and recovery', async () => {
  const platform = createFakePlatform()
  const h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'buffering' })
  await h.value('playback.replaceQueue', { tracks: TRACKS, startIndex: 0, play: true })
  const occurrence = (await h.snapshot()).queue.occurrenceId
  const plays = () => platform.calls.filter(({ key }) => key === 'audioEngine.play').length
  const started = plays()
  platform.audio.state = 'buffering'
  platform.audio.positionMs = 12500
  await h.audioEvent({ type: 'snapshot', snapshot: { ...platform.audio } })
  let snapshot = await h.snapshot()
  assert.equal(snapshot.playback.state, 'buffering')
  assert.equal(snapshot.playback.nativePlaybackActive, true)
  assert.equal(snapshot.playback.position, 12.5)
  assert.equal(snapshot.queue.occurrenceId, occurrence)
  assert.equal(plays(), started)
  // Reading metadata while the connection is stalled must not turn the queue into stopped.
  await h.value('playback.getQueueWindow', { offset: 0, limit: 10 }, 'query')
  assert.equal((await h.snapshot()).playback.state, 'buffering')
  platform.audio.state = 'playing'
  platform.audio.positionMs = 12600
  await h.audioEvent({ type: 'snapshot', snapshot: { ...platform.audio } })
  assert.equal((await h.snapshot()).playback.state, 'playing')
  assert.equal(plays(), started)
  platform.audio.state = 'buffering'
  await h.audioEvent({ type: 'snapshot', snapshot: { ...platform.audio } })
  await h.value('playback.pause')
  snapshot = await h.snapshot()
  assert.equal(snapshot.playback.state, 'paused')
  assert.equal(snapshot.playback.position, 12.6)
  assert.equal(snapshot.queue.occurrenceId, occurrence)
  await h.shutdown()
})

test('SAF identity migration preserves CUE/SACD, favorites, playlists, lyrics, bookmarks and a paused session through rescan and restart', async () => {
  const platform = createFakePlatform()
  const authority = 'alpha.documents'
  const uri = (name, tree = 'root') => `content://${authority}/tree/${tree}/document/${encodeURIComponent(`shared:Music/${name}`)}`
  const saf = `local:saf:${'a'.repeat(24)}`
  const cue = `local:cue:${'b'.repeat(24)}`
  const sacd = `local:sacd:${'c'.repeat(24)}:stereo:2`
  const external = `local:saf:${'d'.repeat(24)}`
  const tracks = [
    wireTrack(saf, { source: uri('Song #?%.flac') }),
    wireTrack(cue, { source: uri('Disc.flac'), cueRange: { startSeconds: 10, endSeconds: 42 } }),
    wireTrack(sacd, { source: `${uri('Disc.iso')}#twilight-sacd=stereo:2`, format: 'SACD ISO' }),
    wireTrack(external, { source: 'content://com.android.externalstorage.documents/tree/primary%3AMusic/document/primary%3AMusic%2FSong.flac' })
  ]
  const first = createEmbeddedHarness({ platform })
  await first.boot({ epoch: 'saf-old' })
  await first.value('library.syncTracks', { tracks })
  await first.value('playlists.toggleFavorite', { trackId: cue })
  await first.value('playlists.create', { name: 'SAF mix', trackIds: [saf, cue, sacd, external] })
  await first.value('lyrics.importLrc', { trackId: cue, lrcText: '[00:01.00]Preserved lyrics' })
  await first.value('playback.replaceQueue', { tracks, startIndex: 1, play: true })
  await first.value('bookmarks.add', { trackId: cue, positionSec: 8, label: 'CUE marker' })
  await first.value('playback.seek', { position: 12.75 })
  await first.value('playback.pause')
  await first.value('settings.edit', { key: 'playbackResumeMode', valueJson: '"trackAndPosition"' })
  const occurrence = (await first.snapshot()).queue.occurrenceId
  await first.shutdown()
  // Emulate the actual pre-namespace bookmark format, while keeping the real Core's envelope.
  const old = JSON.parse(platform.stored)
  old.bookmarks.bookmarks.find(({ label }) => label === 'CUE marker').trackKey = `local:${uri('Disc.flac')}#cue:10`
  const deleted = `local:saf:${'f'.repeat(24)}`
  old.lyricsManagement.tracks[deleted] = { ...old.lyricsManagement.tracks[cue], original: '[00:01.00]Offline edit' }
  old.bookmarks.bookmarks.push({ ...old.bookmarks.bookmarks[0], id: 'offline-marker', trackId: deleted,
    trackKey: 'local:content://offline.documents/tree/root/document/removed%3ASong.flac', label: 'Offline marker' })
  platform.stored = JSON.stringify(old)

  const migrated = createEmbeddedHarness({ platform })
  assert.equal((await migrated.boot({ epoch: 'saf-migrated' })).boot.ok, true)
  const qualified = (id) => id === external ? id : `${id}@${authority}`
  let snapshot = await migrated.snapshot()
  assert.equal(snapshot.track.id, qualified(cue))
  assert.equal(snapshot.queue.occurrenceId, occurrence)
  assert.equal(snapshot.playback.state, 'paused')
  assert.equal(snapshot.playback.position, 12.75)
  assert.deepEqual(snapshot.favoriteTrackIds, [qualified(cue)])
  assert.deepEqual(snapshot.playlists[0].trackIds, tracks.map(({ id }) => qualified(id)))
  assert.equal(snapshot.bookmarks.find(({ label }) => label === 'CUE marker').trackId, qualified(cue))
  const lyrics = await migrated.value('lyrics.current', { trackId: qualified(cue) }, 'query')
  assert.equal(lyrics.lines[0].text, 'Preserved lyrics')

  const next = tracks.map((track) => ({ ...track, id: qualified(track.id), source: track.source.replace('/tree/root/', '/tree/nested/') }))
  await migrated.value('library.syncTracks', { tracks: next })
  await migrated.value('library.syncTracks', { tracks: [...next].reverse() })
  assert.equal((await migrated.snapshot()).libraryTrackCount, 4)
  const page = await migrated.value('playback.getQueueWindow', { offset: 0, limit: 10 }, 'query')
  assert.deepEqual(page.items.map(({ track }) => track.id), tracks.map(({ id }) => qualified(id)))
  await migrated.value('playback.play')
  assert.equal(platform.queue[platform.audio.queueIndex].source, next[1].source)
  assert.deepEqual(platform.queue[platform.audio.queueIndex].cueRange, { startSeconds: 10, endSeconds: 42,
    pregapSeconds: 0, virtualPregapSeconds: 0, sourcePregapSeconds: 0 })
  const plays = platform.calls.filter(({ key }) => key === 'audioEngine.play').length
  const replacement = next.map((track) => ({ ...track, source: track.source.replace('/tree/nested/', '/tree/replacement/') }))
  await migrated.value('library.syncTracks', { tracks: replacement })
  await migrated.audioEvent({ type: 'snapshot', snapshot: { ...platform.audio } })
  assert.equal(platform.calls.filter(({ key }) => key === 'audioEngine.play').length, plays,
    'a playing rescan must not restart the native selection')
  assert.equal(platform.audio.state, 'playing')
  assert.equal(platform.queue[platform.audio.queueIndex].source, next[1].source)
  await migrated.value('playback.pause')
  platform.revoked.add(next[1].source)
  await migrated.value('playback.play')
  assert.equal(platform.queue[platform.audio.queueIndex].source, replacement[1].source)
  assert.equal((await migrated.snapshot()).playback.position, 12.75)
  assert.equal((await migrated.snapshot()).queue.occurrenceId, occurrence)
  await migrated.value('bookmarks.add', { trackId: qualified(cue), positionSec: 9, label: 'New grant marker' })
  await migrated.value('playback.pause')
  await migrated.shutdown()
  const saved = JSON.parse(platform.stored)
  assert.ok(saved.tracks.some(({ id, subTrack }) => id === qualified(sacd) && subTrack.endsWith('#twilight-sacd=stereo:2')))
  const markers = saved.bookmarks.bookmarks.filter(({ label }) => label === 'CUE marker' || label === 'New grant marker')
  assert.equal(new Set(markers.map(({ trackKey }) => trackKey)).size, 1, 'grant changes must not detach bookmarks')
  assert.equal(markers[0].trackKey, `saf:${qualified(cue)}`)
  assert.equal(saved.lyricsManagement.tracks[cue], undefined)
  assert.ok(saved.lyricsManagement.tracks[qualified(cue)])
  assert.ok(saved.lyricsManagement.tracks[`${deleted}@offline.documents`])
  assert.equal(saved.lyricsManagement.tracks[deleted], undefined)
  const final = createEmbeddedHarness({ platform })
  await final.boot({ epoch: 'saf-restart' })
  snapshot = await final.snapshot()
  assert.deepEqual(snapshot.favoriteTrackIds, [qualified(cue)])
  assert.equal(snapshot.playback.state, 'paused')
  assert.equal(snapshot.track.id, qualified(cue))
  assert.equal(snapshot.libraryTrackCount, 4)
  await final.shutdown()
})

test('legacy Kotlin mirror collision uses the saved source for each queue occurrence and never attaches favorites by new scan order', async () => {
  const platform = createFakePlatform()
  const id = `local:saf:${'e'.repeat(24)}`
  const make = (authority) => wireTrack(id, { source: `content://${authority}/tree/root/document/shared%3ASong.flac` })
  const alpha = make('alpha.documents'), beta = make('beta.documents'), external = make('com.android.externalstorage.documents')
  platform.stored = JSON.stringify({ libraryTracks: [alpha], queueTracks: [beta, external], currentQueueIndex: 0,
    favoriteTrackIds: [id], playlists: [{ id: 'legacy-mix', name: 'Old list', trackIds: [id] }],
    bookmarks: [{ id: 'bm', trackId: id, positionSec: 3, label: 'Library marker', createdAtMs: 1700000000000 }] })
  const h = createEmbeddedHarness({ platform })
  assert.equal((await h.boot({ epoch: 'saf-collision' })).boot.ok, true)
  const initial = await h.snapshot()
  assert.equal(initial.track.id, `${id}@beta.documents`)
  assert.deepEqual(initial.favoriteTrackIds, [`${id}@alpha.documents`])
  assert.deepEqual(initial.playlists[0].trackIds, [`${id}@alpha.documents`])
  assert.equal(initial.bookmarks[0].trackId, `${id}@alpha.documents`)
  const tracks = [external, { ...beta, id: `${id}@beta.documents` }, { ...alpha, id: `${id}@alpha.documents` }]
  await h.value('library.syncTracks', { tracks })
  await h.value('library.syncTracks', { tracks: [...tracks].reverse() })
  const snapshot = await h.snapshot()
  assert.equal(snapshot.libraryTrackCount, 3)
  assert.deepEqual(snapshot.favoriteTrackIds, [`${id}@alpha.documents`])
  const queue = await h.value('playback.getQueueWindow', { offset: 0, limit: 10 }, 'query')
  assert.deepEqual(queue.items.map(({ track }) => track.id), [`${id}@beta.documents`, id])
  await h.value('playback.play')
  assert.equal(platform.queue[platform.audio.queueIndex].source, beta.source)
  await h.shutdown()
})

test('USB direct IDs and DSD requests reach the native port, persist, and keep PCM as the legacy default', async () => {
  const platform = createFakePlatform()
  const h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'dsd-settings' })
  const initial = (await h.snapshot()).eqConfig
  assert.equal(initial.dsp.dsdOutputMode, 'pcm')
  assert.equal(initial.dsp.dsdRatePolicy, 'pcm-fallback')
  const device = 'usb-direct:/dev/bus/usb/001/002'
  let dsp
  for (const mode of ['pcm', 'auto', 'native', 'dop']) {
    dsp = { ...initial.dsp, outputDeviceId: device, dsdOutputMode: mode,
      dsdRatePolicy: 'downrate', dopConfirmedDeviceKey: '8369:123:1.00' }
    await h.value('audio.setEq', { dsp })
    assert.equal(platform.appliedDsp.dsp.outputDeviceId, device)
    assert.equal(platform.appliedDsp.dsp.dsdOutputMode, mode)
    assert.equal(platform.appliedDsp.dsp.dsdRatePolicy, 'downrate')
    assert.equal(platform.appliedDsp.dsp.playbackRate, initial.dsp.playbackRate)
    assert.equal(platform.appliedDsp.enabled, initial.enabled)
  }
  for (const patch of [{ dsdOutputMode: 'DSD' }, { dsdRatePolicy: 'guess' }, { dopConfirmedDeviceKey: true },
    { outputDeviceId: 'usb-direct:' }]) {
    assert.equal((await h.request('audio.setEq', { dsp: { ...dsp, ...patch } })).ok, false)
    assert.equal((await h.snapshot()).eqConfig.dsp.dsdOutputMode, 'dop')
  }
  await h.shutdown()
  const restored = createEmbeddedHarness({ platform })
  await restored.boot({ epoch: 'dsd-settings-restored' })
  assert.deepEqual((await restored.snapshot()).eqConfig.dsp, platform.appliedDsp.dsp)
  assert.equal(platform.appliedDsp.dsp.outputDeviceId, device)
  await restored.shutdown()
  const legacy = JSON.parse(platform.stored)
  for (const field of ['dsdOutputMode', 'dsdRatePolicy', 'dopConfirmedDeviceKey']) delete legacy.eqConfig.dsp[field]
  platform.stored = JSON.stringify(legacy)
  const migrated = createEmbeddedHarness({ platform })
  await migrated.boot({ epoch: 'dsd-settings-legacy' })
  assert.equal((await migrated.snapshot()).eqConfig.dsp.dsdOutputMode, 'pcm')
  assert.equal((await migrated.snapshot()).eqConfig.dsp.dopConfirmedDeviceKey, '')
  await migrated.shutdown()
})

test('DSD source bit clocks, DoP carriers and Native word clocks stay distinct through the actual bundle', async () => {
  const assert = require('node:assert/strict')
  const platform = createFakePlatform()
  const h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'dsd-facts' })
  await h.value('library.syncTracks', { tracks: [wireTrack('dsd')] })
  await h.value('playback.replaceQueue', { tracks: [{ id: 'dsd' }], startIndex: 0, play: true })
  platform.route.routeType = 'usb_dac'
  Object.assign(platform.audio, { isDsd: true, dsdRate: 64, sampleRate: 2822400, bitDepth: 1,
    outputBackend: 'usb-direct', exclusive: true, actualDeviceName: 'USB DAC', dsdRatePolicy: 'exact',
    dsdConversion: 'exact', dsdConversionReason: '', outputPerfect: false })
  for (const [mode, actualRate, bits, transport] of [['dop', 176400, 24, 176400], ['native', 2822400, 1, 88200]]) {
    Object.assign(platform.audio, { dsdMode: mode, actualSampleRate: actualRate, actualBitDepth: bits,
      actualDsdRate: 64, semanticSampleRate: actualRate, transportSampleRate: transport })
    await h.audioEvent({ type: 'snapshot', snapshot: { ...platform.audio } })
    const p = (await h.snapshot()).playback
    assert.equal(p.outputBackend, 'usb-direct')
    assert.equal(p.sourceSampleRate, 2822400)
    assert.equal(p.sourceBitDepth, 1)
    assert.equal(p.dsdMode, mode)
    assert.equal(p.dsdRate, 64)
    assert.equal(p.actualDsdRate, 64)
    assert.equal(p.actualSampleRate, actualRate)
    assert.equal(p.transportSampleRate, transport)
    assert.equal(p.outputPerfect, false)
  }
  Object.assign(platform.audio, { isDsd: false, dsdMode: null, dsdRate: null, actualDsdRate: null,
    dsdConversion: null, dsdConversionReason: null, transportSampleRate: null, semanticSampleRate: null })
  await h.audioEvent({ type: 'snapshot', snapshot: { ...platform.audio } })
  const cleared = (await h.snapshot()).playback
  assert.equal(cleared.isDsd, false)
  assert.equal(cleared.dsdMode, undefined)
  assert.equal(cleared.actualDsdRate, undefined)
  assert.equal(cleared.transportSampleRate, undefined)
  await h.shutdown()
  assert.equal(platform.stored.includes('"transportSampleRate"'), false)
})

test('Kotlin-mirror SACD bookmarks migrate to each logical track rather than the whole disc', async () => {
  const physical = 'content://docs/iso?grant=kept#original'
  const tracks = [1, 2].map(n => ({ ...wireTrack(`mirror-sacd-${n}`), source: `${physical}#twilight-sacd=stereo:${n}` }))
  const platform = createFakePlatform()
  platform.stored = JSON.stringify({ libraryTracks: tracks, queueTracks: tracks, currentQueueIndex: 1,
    bookmarks: tracks.map((track, n) => ({ id: `bm-sacd-${n}`, trackId: track.id, positionSec: n + 1, label: `Track ${n}`, createdAtMs: 1700000000000 })) })
  const h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'sacd-mirror' })
  const snapshot = await h.snapshot()
  assert.deepEqual(snapshot.bookmarks.map(({ trackId }) => trackId).sort(), tracks.map(({ id }) => id).sort())
  await h.shutdown()
  const saved = JSON.parse(platform.stored).bookmarks.bookmarks
  assert.equal(new Set(saved.map(({ trackKey }) => trackKey)).size, 2)
  assert.ok(saved.every(({ trackKey }) => trackKey.startsWith(`local:${physical}#${physical}#twilight-sacd=stereo:`)))
})

test('SACD tracks retain physical grants, logical native sources, availability and distinct bookmarks after restart', async () => {
  const platform = createFakePlatform()
  const h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'sacd-input' })
  const physical = 'content://documents/tree/disc?provider=keep#original'
  const tracks = ['stereo:1', 'stereo:2', 'multichannel:1'].map((selector, index) => wireTrack(`sacd-${index}`, {
    source: `${physical}#twilight-sacd=${selector}`, format: 'SACD ISO', sampleRate: 2822400, bitDepth: 1
  }))
  tracks.push(wireTrack('sacd-unavailable', { source: `${physical}#twilight-sacd=stereo:3`, unavailableReason: 'DST unavailable' }))
  await h.value('library.syncTracks', { tracks })
  const page = await h.value('search.songs', { query: 'Title sacd' }, 'query')
  assert.deepEqual(page.items.map(({ id, source }) => ({ id, source })).sort((a, b) => a.id.localeCompare(b.id)),
    tracks.map(({ id, source }) => ({ id, source })).sort((a, b) => a.id.localeCompare(b.id)))
  assert.equal(page.items.find(({ id }) => id === 'sacd-unavailable').unavailableReason, 'DST unavailable')
  await h.value('playback.replaceQueue', { tracks: tracks.slice(0, 3).map(({ id }) => ({ id })), startIndex: 0, play: true })
  await h.value('bookmarks.add', { trackId: tracks[0].id, positionSec: 5, label: 'First' })
  await h.value('playback.next')
  await h.value('bookmarks.add', { trackId: tracks[1].id, positionSec: 8, label: 'Second' })
  assert.equal(platform.queue[platform.audio.queueIndex].source, tracks[1].source)
  assert.ok(platform.calls.filter(({ key }) => key === 'resourceAccess.resolveNativeUri').every(({ args }) => args.resourceId === physical))
  assert.equal((await h.snapshot()).track.source, tracks[1].source)
  await h.shutdown()
  const saved = JSON.parse(platform.stored)
  for (const track of saved.tracks) {
    assert.equal(track.filePath, physical)
    assert.equal(track.subTrack, tracks.find(({ id }) => id === track.id).source)
    assert.equal(track.cueRange, undefined)
  }
  const bookmarks = saved.bookmarks.bookmarks.filter(({ label }) => label === 'First' || label === 'Second')
  assert.equal(new Set(bookmarks.map(({ trackKey }) => trackKey)).size, 2)
  assert.ok(bookmarks.every(({ trackKey }) => trackKey.startsWith(`local:${physical}#${physical}#twilight-sacd=stereo:`)))
  const restored = createEmbeddedHarness({ platform })
  await restored.boot({ epoch: 'sacd-restored' })
  const snapshot = await restored.snapshot()
  assert.equal(snapshot.track.source, tracks[1].source)
  assert.equal(snapshot.playback.state, 'paused')
  assert.deepEqual(snapshot.bookmarks.filter(({ label }) => label === 'First' || label === 'Second').map(({ trackId }) => trackId).sort(),
    [tracks[0].id, tracks[1].id].sort())
  await restored.value('playback.play')
  assert.equal(platform.queue[platform.audio.queueIndex].source, tracks[1].source)
  await restored.shutdown()
})

test('USB PCM request is independent, defaults off, persists and projects preference facts conservatively', async () => {
  const platform = createFakePlatform()
  const h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'usb-pcm' })
  const initial = (await h.snapshot()).eqConfig
  assert.equal(initial.dsp.usbPcmPassthrough, false)
  const dsp = { ...initial.dsp, usbPcmPassthrough: true }
  await h.value('audio.setEq', { dsp })
  assert.equal(platform.appliedDsp.dsp.usbPcmPassthrough, true)
  assert.equal((await h.snapshot()).eqConfig.bitPerfect, initial.bitPerfect)
  const invalid = await h.request('audio.setEq', { dsp: { ...dsp, usbPcmPassthrough: 'true' } })
  assert.equal(invalid.ok, false)
  assert.equal((await h.snapshot()).eqConfig.dsp.usbPcmPassthrough, true)
  Object.assign(platform.audio, { usbPcmPreferenceAccepted: true, usbPcmFormatMatched: true, outputPerfect: false })
  await h.audioEvent({ type: 'snapshot', snapshot: { ...platform.audio } })
  const playback = (await h.snapshot()).playback
  assert.equal(playback.usbPcmPreferenceAccepted, true)
  assert.equal(playback.usbPcmFormatMatched, true)
  assert.equal(playback.outputPerfect, false)
  await h.shutdown()
  assert.equal(platform.stored.includes('"usbPcmPreferenceAccepted"'), false)
  assert.equal(platform.stored.includes('"usbPcmFormatMatched"'), false)
  Object.assign(platform.audio, { usbPcmPreferenceAccepted: false, usbPcmFormatMatched: false })
  const restored = createEmbeddedHarness({ platform })
  await restored.boot({ epoch: 'usb-pcm-restored' })
  assert.equal((await restored.snapshot()).eqConfig.dsp.usbPcmPassthrough, true)
  assert.equal((await restored.snapshot()).playback.usbPcmPreferenceAccepted, false)
  assert.equal((await restored.snapshot()).playback.usbPcmFormatMatched, false)
  await restored.shutdown()
})

test('705.6 and 768 kHz fixed targets survive the embedded host and persisted reconstruction', async () => {
  for (const rate of [705600, 768000]) {
    const platform = createFakePlatform()
    const h = createEmbeddedHarness({ platform })
    await h.boot({ epoch: `high-${rate}` })
    const initial = (await h.snapshot()).eqConfig.dsp
    const dsp = { ...initial, allowedSampleRates: [705600, 768000],
      outputStage: { ...initial.outputStage, targetSampleRate: rate } }
    await h.value('audio.setEq', { bitPerfect: true, dsp })
    assert.equal(platform.appliedDsp.dsp.outputStage.targetSampleRate, rate)
    assert.deepEqual(platform.appliedDsp.dsp.allowedSampleRates, [705600, 768000])
    const invalid = await h.request('audio.setEq', { dsp: { ...dsp, allowedSampleRates: [768001] } })
    assert.equal(invalid.ok, false)
    assert.deepEqual((await h.snapshot()).eqConfig.dsp.allowedSampleRates, [705600, 768000])
    await h.shutdown()
    const restored = createEmbeddedHarness({ platform })
    await restored.boot({ epoch: `high-restored-${rate}` })
    const actual = (await restored.snapshot()).eqConfig.dsp
    assert.equal(actual.outputStage.targetSampleRate, rate)
    assert.deepEqual(actual.allowedSampleRates, [705600, 768000])
    await restored.shutdown()
  }
})

test('PCM family and allowed-rate settings persist, migrate defaults, and reject incompatible requests', async () => {
  const platform = createFakePlatform()
  const first = createEmbeddedHarness({ platform })
  await first.boot({ epoch: 'pcm-1' })
  const initial = (await first.snapshot()).eqConfig
  assert.equal(initial.dsp.sampleRateFamilySync, false)
  assert.deepEqual(initial.dsp.allowedSampleRates, [])
  const dsp = { ...initial.dsp, sampleRateFamilySync: true, allowedSampleRates: [96000, 44100] }
  await first.value('audio.setEq', { bitPerfect: true, dsp })
  assert.deepEqual(platform.appliedDsp.dsp.allowedSampleRates, [44100, 96000])
  for (const patch of [{ bitPerfect: false },
    { dsp: { ...dsp, outputStage: { ...dsp.outputStage, targetSampleRate: 96000 } } },
    ...[[48000, 48000], [7999], [48000.5], '48000', Array.from({ length: 33 }, (_, i) => 8000 + i)]
      .map(allowedSampleRates => ({ dsp: { ...dsp, allowedSampleRates } }))]) {
    const response = await first.request('audio.setEq', patch)
    assert.equal(response.ok, false)
    const accepted = (await first.snapshot()).eqConfig
    assert.equal(accepted.bitPerfect, true)
    assert.equal(accepted.dsp.sampleRateFamilySync, true)
    assert.deepEqual(accepted.dsp.allowedSampleRates, [44100, 96000])
  }
  await first.shutdown()
  assert.equal(JSON.parse(platform.stored).eqConfig.dsp.deviceSampleRates, undefined)
  const restored = createEmbeddedHarness({ platform })
  await restored.boot({ epoch: 'pcm-2' })
  assert.deepEqual((await restored.snapshot()).eqConfig.dsp.allowedSampleRates, [44100, 96000])
  assert.equal((await restored.snapshot()).eqConfig.dsp.sampleRateFamilySync, true)
  await restored.shutdown()
  const legacy = JSON.parse(platform.stored)
  delete legacy.eqConfig.dsp.sampleRateFamilySync
  delete legacy.eqConfig.dsp.allowedSampleRates
  platform.stored = JSON.stringify(legacy)
  const migrated = createEmbeddedHarness({ platform })
  await migrated.boot({ epoch: 'pcm-3' })
  assert.equal((await migrated.snapshot()).eqConfig.dsp.sampleRateFamilySync, false)
  assert.deepEqual((await migrated.snapshot()).eqConfig.dsp.allowedSampleRates, [])
  // A legacy fixed request remains legal even without an advertised capability.
  const current = (await migrated.snapshot()).eqConfig
  await migrated.value('audio.setEq', { bitPerfect: true, dsp: { ...current.dsp,
    outputStage: { ...current.dsp.outputStage, targetSampleRate: 96000 } } })
  await migrated.shutdown()
})

test('CUE ranges survive library, native queue, projections and session reconstruction', async () => {
  const platform = createFakePlatform()
  const h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'cue-1' })
  const source = 'content://documents/disc.flac'
  const ranges = [
    { startSeconds: 0, endSeconds: 20, pregapSeconds: 0, virtualPregapSeconds: 0, sourcePregapSeconds: 0 },
    { startSeconds: 20, endSeconds: 40, pregapSeconds: 2, virtualPregapSeconds: 2, sourcePregapSeconds: 0 }
  ]
  const tracks = ranges.map((cueRange, index) => ({ ...wireTrack(`cue-${index}`), source, cueRange,
    duration: cueRange.endSeconds - cueRange.startSeconds + cueRange.virtualPregapSeconds }))
  await h.value('library.syncTracks', { tracks })
  const page = await h.value('search.songs', { query: 'Title cue' }, 'query')
  assert.equal(page.items.length, 2)
  for (const track of page.items) {
    assert.equal(track.source, source)
    assert.deepEqual(track.cueRange, tracks.find((entry) => entry.id === track.id).cueRange)
  }
  await h.value('playback.replaceQueue', { tracks: tracks.map(({ id }) => ({ id })), startIndex: 1, play: true })
  assert.deepEqual(platform.queue[platform.audio.queueIndex].cueRange, ranges[1])
  assert.equal(platform.queue[platform.audio.queueIndex].source, source)
  const window = await h.value('playback.getQueueWindow', { offset: 0, limit: 10 }, 'query')
  assert.deepEqual(window.items.map((item) => item.track.cueRange), ranges)
  assert.deepEqual((await h.snapshot()).track.cueRange, ranges[1])
  platform.audio.positionMs = 12_750
  await h.audioEvent({ type: 'snapshot', snapshot: { ...platform.audio } })
  await h.value('playback.pause')
  await h.shutdown()

  const restored = createEmbeddedHarness({ platform })
  await restored.boot({ epoch: 'cue-2' })
  const snapshot = await restored.snapshot()
  assert.equal(snapshot.track.source, source)
  assert.deepEqual(snapshot.track.cueRange, ranges[1])
  assert.equal(snapshot.playback.state, 'paused')
  await restored.value('playback.play')
  assert.deepEqual(platform.queue[platform.audio.queueIndex].cueRange, ranges[1])
})

test('legacy Android CUE sources migrate in persisted rows, active selection and bookmarks', async () => {
  const platform = createFakePlatform()
  const first = createEmbeddedHarness({ platform })
  await first.boot({ epoch: 'legacy-cue-1' })
  const source = 'content://documents/disc.flac'
  const cueRange = { startSeconds: 20, endSeconds: 40, pregapSeconds: 1, virtualPregapSeconds: 1, sourcePregapSeconds: 0 }
  const track = { ...wireTrack('cue-legacy'), source, cueRange, duration: 21 }
  await first.value('library.syncTracks', { tracks: [track] })
  await first.value('playback.replaceQueue', { tracks: [{ id: track.id }], play: true })
  await first.value('bookmarks.add', { trackId: track.id, positionSec: 5, label: 'CUE bookmark' })
  await first.shutdown()
  const legacy = JSON.parse(platform.stored)
  const encoded = source + '#cue=20.0,40.0,1.0,0.0'
  const downgrade = (record) => { record.filePath = encoded; delete record.cueRange }
  legacy.tracks.forEach(downgrade)
  downgrade(legacy.session.track)
  for (const queue of legacy.queues) for (const row of queue.rows) downgrade(row.snapshot)
  for (const bookmark of legacy.bookmarks.bookmarks) bookmark.trackKey = `local:${encoded}`
  platform.stored = JSON.stringify(legacy)

  const second = createEmbeddedHarness({ platform })
  await second.boot({ epoch: 'legacy-cue-2' })
  const snapshot = await second.snapshot()
  assert.equal(snapshot.track.source, source)
  assert.deepEqual(snapshot.track.cueRange, cueRange)
  assert.equal(snapshot.bookmarks.find((item) => item.label === 'CUE bookmark').trackId, track.id)
  const window = await second.value('playback.getQueueWindow', { offset: 0, limit: 10 }, 'query')
  assert.deepEqual(window.items[0].track.cueRange, cueRange)
  await second.value('playback.play')
  assert.equal(platform.queue[platform.audio.queueIndex].source, source)
  assert.deepEqual(platform.queue[platform.audio.queueIndex].cueRange, cueRange)
  await second.shutdown()
  assert.ok(JSON.parse(platform.stored).bookmarks.bookmarks.some((item) => item.trackKey === `local:${source}#cue:20`))
})

test('the Kotlin-mirror migration keeps CUE bookmarks attached to their segment', async () => {
  const platform = createFakePlatform()
  const source = 'content://documents/disc.flac'
  const track = { ...wireTrack('cue-mirror'), source: source + '#cue=20.0,40.0,1.0,0.0', duration: 21 }
  platform.stored = JSON.stringify({ libraryTracks: [track], queueTracks: [track], currentQueueIndex: 0,
    bookmarks: [{ id: 'cue-bookmark', trackId: track.id, positionSec: 5, label: 'Cue', createdAtMs: 1700000000000 }] })
  const h = createEmbeddedHarness({ platform })
  await h.boot({ epoch: 'cue-mirror' })
  assert.equal((await h.snapshot()).track.cueRange.startSeconds, 20)
  await h.shutdown()
  assert.equal(JSON.parse(platform.stored).bookmarks.bookmarks.find((entry) => entry.id === 'cue-bookmark').trackKey,
    `local:${source}#cue:20`)
})

test('CUE wire import accepts saved fragments and rejects malformed ranges before replacing the library', async () => {
  const h = createEmbeddedHarness()
  await h.boot({ epoch: 'cue-validation' })
  const source = 'content://documents/disc.flac'
  await h.value('library.syncTracks', { tracks: [{ ...wireTrack('cue-old'), source: source + '#cue=20.0,40.0' }] })
  const page = await h.value('search.songs', { query: 'Title cue-old' }, 'query')
  assert.equal(page.items[0].source, source)
  assert.equal(page.items[0].cueRange.startSeconds, 20)
  for (const cueRange of [null, { startSeconds: 30, endSeconds: 20 }, { startSeconds: 20, endSeconds: 40, sourcePregapSeconds: 21 }]) {
    const response = await h.request('library.syncTracks', { tracks: [{ ...wireTrack('bad'), source, cueRange }] })
    assert.equal(response.error.code, 'INVALID_REQUEST')
    assert.equal((await h.snapshot()).libraryTrackCount, 1)
  }
})

function assertNoNulls(value, at = 'snapshot') {
  // CoreSleepTimerState.timer is explicitly nullable in Kotlin; null means no active timer.
  if (at === 'snapshot.sleepTimer.timer' && value === null) return
  if (value === null) assert.fail(`${at} is null; the Kotlin decoder rejects nulls for required fields`)
  if (Array.isArray(value)) value.forEach((item, index) => assertNoNulls(item, `${at}[${index}]`))
  else if (typeof value === 'object') for (const [key, item] of Object.entries(value)) assertNoNulls(item, `${at}.${key}`)
}

function assertIntegers(object, keys, at) {
  for (const key of keys) {
    if (object[key] === undefined) continue
    assert.ok(Number.isInteger(object[key]), `${at}.${key} must be integral, got ${object[key]}`)
  }
}

/** Mirrors the non-null / Int / Long fields of the Android CoreSnapshot DTOs. */
function assertKotlinSnapshot(snapshot) {
  assertNoNulls(snapshot)
  assert.equal(snapshot.protocolVersion, 1)
  assert.equal(typeof snapshot.epoch, 'string')
  assert.ok(['starting', 'ready', 'recovering', 'failed', 'stopped'].includes(snapshot.phase))
  assertIntegers(snapshot, ['sequence', 'libraryRevision', 'playlistsRevision', 'audioRevision', 'settingsRevision', 'lyricsRevision', 'libraryTrackCount'], 'snapshot')
  for (const key of ['isStreamBuffering', 'loading', 'migrationRequired']) assert.equal(typeof snapshot[key], 'boolean')
  if (snapshot.playback) {
    const p = snapshot.playback
    for (const key of ['dspActive', 'eqActive', 'exclusive', 'nativePlaybackActive', 'outputPerfect', 'sourceExact', 'pcmPassthrough', 'isDsd', 'gaplessActive', 'preloadReady', 'crossfadeActive', 'crossfadeMixActive']) {
      assert.equal(typeof p[key], 'boolean', `playback.${key}`)
    }
    for (const key of ['latencyMs', 'position', 'duration', 'volume', 'playbackRate', 'crossfadeSeconds', 'crossfadeEffectiveSeconds']) {
      assert.equal(typeof p[key], 'number', `playback.${key}`)
    }
    assert.ok(['stopped', 'loading', 'playing', 'paused', 'buffering', 'error'].includes(p.state))
    assert.ok(['sequence', 'loop', 'single', 'shuffle', 'heart'].includes(p.playMode))
    assertIntegers(p, ['bufferSizeFrames', 'queueIndex', 'queueRevision', 'requestedConfigRevision', 'appliedConfigRevision', 'clipCount', 'sourceSampleRate', 'sourceChannels', 'sourceBitDepth', 'actualSampleRate', 'actualBitDepth', 'actualChannels'], 'playback')
  }
  if (snapshot.track) {
    assert.equal(typeof snapshot.track.title, 'string')
    assert.ok(snapshot.track.title.length > 0)
    assertIntegers(snapshot.track, ['size', 'sampleRate', 'bitDepth', 'discNumber', 'trackNumber', 'addedAt'], 'track')
    if (snapshot.track.ncmSongId !== undefined) assert.equal(typeof snapshot.track.ncmSongId, 'string')
  }
  if (snapshot.queue) assertIntegers(snapshot.queue, ['revision', 'total', 'index'], 'queue')
  for (const bookmark of snapshot.bookmarks) assertIntegers(bookmark, ['createdAtMs'], 'bookmark')
  for (const playlist of snapshot.playlists) assertIntegers(playlist, ['trackCount', 'updatedAtMs'], 'playlist')
  if (snapshot.currentLyrics) for (const line of snapshot.currentLyrics.lines) assertIntegers(line, ['timeMs'], 'lyrics')
}

async function bootWithQueue(options = {}) {
  const h = createEmbeddedHarness(options)
  await h.boot({ epoch: 'embedded-test' })
  await h.value('library.syncTracks', { tracks: TRACKS })
  await h.value('playback.replaceQueue', { tracks: TRACKS.map(({ id }) => ({ id })), startIndex: 0, play: true })
  return h
}

for (const eventLoop of [true, false]) {
  test(`embedded host plays a queue and projects Kotlin-decodable snapshots (eventLoop=${eventLoop})`, async () => {
    const h = await bootWithQueue({ eventLoop })
    const snapshot = await h.snapshot()
    assertKotlinSnapshot(snapshot)
    assert.equal(snapshot.track.id, 'a')
    assert.equal(snapshot.track.source, TRACKS[0].source)
    assert.equal(snapshot.playback.state, 'playing')
    assert.equal(snapshot.queue.total, 3)
    assert.equal(snapshot.libraryTrackCount, 3)

    const window = await h.value('playback.getQueueWindow', { offset: 0, limit: 10 }, 'query')
    assert.equal(window.queueId, snapshot.queue.id)
    assert.deepEqual(window.items.map((item) => item.track.id), ['a', 'b', 'c'])
    assert.equal(window.currentIndex, 0)

    const selected = await h.value('playback.selectQueueIndex', { index: 2, occurrenceId: window.items[2].occurrenceId }, 'command', { expectedRevision: snapshot.queue.revision })
    assert.equal(selected.snapshot.track.id, 'c')
    const previous = await h.value('playback.previous')
    assert.equal(previous.snapshot.track.id, 'b')
    const paused = await h.value('playback.pause')
    assert.equal(paused.snapshot.playback.state, 'paused')
    const moded = await h.value('playback.setPlayMode', { mode: 'single' })
    assert.equal(moded.snapshot.playback.playMode, 'single')
    assert.equal(h.platform.audio.playMode, 'single')
    const volume = await h.value('playback.setVolume', { volume: 0.4 })
    assert.equal(volume.snapshot.playback.volume, 0.4)

    const states = h.events.filter((event) => event.kind === 'state')
    assert.ok(states.length > 0, 'drain must publish coalesced state events')
    for (let i = 1; i < states.length; i++) assert.ok(states[i].sequence > states[i - 1].sequence)
    for (const state of states) assertKotlinSnapshot(state.snapshot)
  })
}

test('natural track end advances through the Core session', async () => {
  const h = await bootWithQueue()
  // Native engine finished track 'a': Kotlin reports a stopped/ended engine.
  h.platform.audio.state = 'ended'
  h.platform.audio.positionMs = 200_000
  await h.audioEvent({ type: 'track-ended', queueIndex: 0, reason: 'eof' })
  await h.settle({ timersUpToMs: 50 })
  const snapshot = await h.snapshot()
  assert.equal(snapshot.track.id, 'b')
  assert.equal(snapshot.queue.index, 1)
})

test('wire guards: epoch, queue revision, duplicates, unknown names, readiness', async () => {
  const h = await bootWithQueue()
  const snapshot = await h.snapshot()

  const stale = await h.request('playback.pause', {}, 'command', { epoch: 'old-epoch' })
  assert.equal(stale.error.code, 'STALE_EPOCH')
  assert.equal(stale.error.retryable, true)

  const bootSnapshot = await h.request('core.getSnapshot', {}, 'query', { epoch: 'epoch-boot' })
  assert.equal(bootSnapshot.ok, true, 'the first snapshot query is epoch-exempt')

  const guarded = await h.request('playback.selectQueueIndex', { index: 1 }, 'command', { expectedRevision: snapshot.queue.revision + 7 })
  assert.equal(guarded.error.code, 'STALE_REVISION')
  assert.equal(guarded.error.retryable, true)

  const first = await h.request('playback.pause', {}, 'command', { commandId: 'cmd-1' })
  assert.equal(first.ok, true)
  const again = await h.request('playback.pause', {}, 'command', { commandId: 'cmd-1' })
  assert.equal(again.error.code, 'OUTCOME_UNKNOWN')

  const unknown = await h.request('nope.nothing', {}, 'query')
  assert.equal(unknown.error.code, 'INVALID_REQUEST')
  const badMode = await h.request('playback.setPlayMode', { mode: 'warp' })
  assert.equal(badMode.error.code, 'INVALID_REQUEST')
  const tooLoud = await h.request('playback.setVolume', { volume: 3 })
  assert.equal(tooLoud.error.code, 'INVALID_REQUEST')
  const future = await h.request('core.getSnapshot', {}, 'query', { protocolVersion: 99 })
  assert.equal(future.error.code, 'INVALID_REQUEST')

  const cold = createEmbeddedHarness()
  JSON.parse(cold.core.bootHost(JSON.stringify({ epoch: 'cold' })))
  const { requestId } = cold.send('playback.play', {}, 'command', { epoch: 'cold' })
  cold.settle()
  await cold.settle()
  assert.equal(cold.responses.get(requestId).error.code, 'NOT_READY')
})

test('cancelled requests answer CANCELLED once and drop the late result', async () => {
  const h = await bootWithQueue()
  const { requestId } = h.send('search.songs', { query: 'Title' }, 'query')
  assert.equal(JSON.parse(h.core.cancelRequest(JSON.stringify({ requestId }))).accepted, true)
  await h.settle()
  assert.equal(h.responses.get(requestId).error.code, 'CANCELLED')
})

test('revoked SAF grants surface PERMISSION_EXPIRED instead of a generic failure', async () => {
  const h = await bootWithQueue()
  await h.value('playback.stop')
  h.platform.revoked.add(TRACKS[1].source)
  const response = await h.request('playback.selectQueueIndex', { index: 1 })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'PERMISSION_EXPIRED')
})

test('library sync replaces or merges membership without touching the queue', async () => {
  const h = await bootWithQueue()
  const merged = await h.value('library.syncTracks', { tracks: [wireTrack('d')], merge: true })
  assert.equal(merged.snapshot.libraryTrackCount, 4)
  const replaced = await h.value('library.syncTracks', { tracks: [wireTrack('d')] })
  assert.equal(replaced.snapshot.libraryTrackCount, 1)
  assert.equal(replaced.snapshot.queue.total, 3, 'a scan must not replace the playing queue')
  assert.equal(replaced.snapshot.track.id, 'a')
  const search = await h.value('search.songs', { query: 'Title d' }, 'query')
  assert.deepEqual(search.items.map((item) => item.id), ['d'])
})

test('playlists, favorites and collections go through the Core playlist service', async () => {
  const h = await bootWithQueue()
  let snapshot = (await h.value('playlists.create', { name: 'Commute', trackIds: ['a', 'b'] })).snapshot
  assert.equal(snapshot.playlists.length, 1)
  const playlist = snapshot.playlists[0]
  assert.equal(playlist.name, 'Commute')
  assert.equal(playlist.trackCount, 2)
  snapshot = (await h.value('playlists.addTracks', { playlistId: playlist.id, trackIds: ['c'] })).snapshot
  assert.equal(snapshot.playlists[0].trackCount, 3)
  snapshot = (await h.value('playlists.rename', { playlistId: playlist.id, name: 'Evening' })).snapshot
  assert.equal(snapshot.playlists[0].name, 'Evening')
  snapshot = (await h.value('playlists.removeTrack', { playlistId: playlist.id, trackId: 'b' })).snapshot
  assert.deepEqual(snapshot.playlists[0].trackIds, ['a', 'c'])
  const duplicate = await h.request('playlists.create', { name: '' })
  assert.equal(duplicate.error.code, 'INVALID_REQUEST')
  const missing = await h.request('playlists.delete', { playlistId: 'nope' })
  assert.equal(missing.error.code, 'NOT_FOUND')

  snapshot = (await h.value('playlists.toggleFavorite', { trackId: 'b' })).snapshot
  assert.deepEqual(snapshot.favoriteTrackIds, ['b'])
  snapshot = (await h.value('playlists.toggleFavorite', { trackId: 'b' })).snapshot
  assert.deepEqual(snapshot.favoriteTrackIds, [])

  snapshot = (await h.value('playlists.delete', { playlistId: playlist.id })).snapshot
  assert.equal(snapshot.playlists.length, 0)

  const collections = await h.value('library.collections', {}, 'query')
  assert.equal(collections.albums.length, 1)
  assert.equal(collections.albums[0].trackCount, 3)
})

test('bookmarks use the Core-observed position of the current track', async () => {
  const h = await bootWithQueue()
  h.platform.audio.positionMs = 42_000
  await h.audioEvent({ type: 'snapshot', snapshot: { ...h.platform.audio } })
  let snapshot = (await h.value('bookmarks.add', { trackId: 'a', positionSec: 999, label: 'Chorus' })).snapshot
  assert.equal(snapshot.bookmarks.length, 1)
  assert.equal(snapshot.bookmarks[0].trackId, 'a')
  assert.equal(snapshot.bookmarks[0].label, 'Chorus')
  assert.ok(Math.abs(snapshot.bookmarks[0].positionSec - 42) < 1)
  const wrongTrack = await h.request('bookmarks.add', { trackId: 'b', positionSec: 1 })
  assert.equal(wrongTrack.error.code, 'STALE_REVISION')
  snapshot = (await h.value('bookmarks.remove', { bookmarkId: snapshot.bookmarks[0].id })).snapshot
  assert.equal(snapshot.bookmarks.length, 0)
  const missing = await h.request('bookmarks.remove', { bookmarkId: 'nope' })
  assert.equal(missing.error.code, 'NOT_FOUND')
})

test('lyrics import and lrclib fetch are stored as Core lyric overrides', async () => {
  const h = await bootWithQueue()
  const imported = await h.value('lyrics.importLrc', {
    trackId: 'a',
    lrcText: '[00:01.50]First synced line\n[00:01.50]第一行翻译\n[00:08.00]Second synced line'
  })
  assert.equal(imported.source, 'imported')
  assert.equal(imported.synced, true)
  assert.equal(imported.lines.length, 2)
  assert.equal(imported.lines[0].timeMs, 1500)
  assert.equal(imported.lines[0].translation, '第一行翻译')
  assert.equal(imported.snapshot.currentLyrics.source, 'imported')

  let lastUrl = null
  h.platform.network = ({ url }) => {
    lastUrl = url
    return { statusCode: 200, headers: {}, bodyUtf8: JSON.stringify({ syncedLyrics: '[00:02.00]Online line' }) }
  }
  const online = await h.value('lyrics.fetchOnline', { trackId: 'b' }, 'query')
  assert.match(lastUrl, /^https:\/\/lrclib\.net\/api\/get\?track_name=Title%20b&artist_name=Echo%20Ensemble/)
  assert.equal(online.source, 'online')
  assert.equal(online.lines[0].text, 'Online line')
  const viewB = await h.value('lyrics.current', { trackId: 'b' }, 'query')
  assert.equal(viewB.source, 'online')

  h.platform.network = () => ({ statusCode: 404, headers: {}, bodyUtf8: '' })
  const missing = await h.request('lyrics.fetchOnline', { trackId: 'c' }, 'query')
  assert.equal(missing.error.code, 'NOT_FOUND')
  const insecure = await h.request('lyrics.fetchOnline', { trackId: 'c', url: 'http://example.com/a.lrc' }, 'query')
  assert.equal(insecure.error.code, 'INVALID_REQUEST')
  h.platform.network = () => { throw new PortError('FAILED', 'offline', true) }
  const offline = await h.request('lyrics.fetchOnline', { trackId: 'c' }, 'query')
  assert.equal(offline.error.code, 'FAILED')
  assert.equal(offline.error.retryable, true)
})

test('a restart restores the queue, settings and documents from the session store', async () => {
  const platform = createFakePlatform()
  const first = createEmbeddedHarness({ platform })
  await first.boot({ epoch: 'run-1' })
  await first.value('library.syncTracks', { tracks: TRACKS })
  await first.value('playback.replaceQueue', { tracks: TRACKS.map(({ id }) => ({ id })), startIndex: 1, play: true })
  await first.value('playlists.toggleFavorite', { trackId: 'c' })
  await first.value('settings.edit', { key: 'playbackResumeMode', valueJson: '"track"' })
  await first.settle({ timersUpToMs: 50 })

  const second = createEmbeddedHarness({ platform })
  await second.boot({ epoch: 'run-2' })
  const snapshot = await second.snapshot()
  assertKotlinSnapshot(snapshot)
  assert.equal(snapshot.epoch, 'run-2')
  assert.equal(snapshot.track.id, 'b')
  assert.equal(snapshot.queue.total, 3)
  assert.equal(snapshot.libraryTrackCount, 3)
  assert.deepEqual(snapshot.favoriteTrackIds, ['c'])
})

test('queue clear removes a stopped selection and native queue, persists empty, and keeps the library and settings', async () => {
  const platform = createFakePlatform()
  const h = await bootWithQueue({ platform })
  await h.value('playback.setVolume', { volume: 0.42 })
  await h.value('playback.setPlayMode', { mode: 'loop' })
  await h.value('audio.setEq', { preampDb: -2 })
  await h.value('playlists.toggleFavorite', { trackId: 'c' })
  await h.value('playback.stop')
  const before = await h.snapshot()
  assert.equal(before.track.id, 'a')
  const emptyReplacement = await h.request('playback.replaceQueue', { tracks: [], play: false })
  assert.equal(emptyReplacement.ok, false, 'ReplaceQueue retains its nonempty contract')
  assert.equal(emptyReplacement.error.code, 'INVALID_REQUEST')
  const { id, revision } = (await h.snapshot()).queue
  await h.value('queue.edit', { id, revision, edit: { kind: 'clear' } }, 'command', { expectedRevision: revision })
  const cleared = await h.snapshot()
  assert.equal(cleared.track, undefined)
  assert.equal(cleared.queue.total, 0)
  assert.equal(cleared.queue.index, 0)
  assert.equal(cleared.queue.occurrenceId, undefined)
  assert.equal(cleared.playback.state, 'stopped')
  assert.equal(cleared.playback.position, 0)
  assert.equal(cleared.playback.volume, 0.42)
  assert.equal(cleared.playback.playMode, 'loop')
  assert.equal(cleared.libraryTrackCount, 3)
  assert.deepEqual(cleared.favoriteTrackIds, ['c'])
  assert.deepEqual(platform.queue, [])
  assert.equal(platform.audio.queueIndex, -1)
  await h.shutdown()
  const saved = JSON.parse(platform.stored)
  assert.equal(saved.session, null)
  assert.ok(saved.queues.every(queue => queue.rows.length === 0 && queue.selectedEntryId === null))

  const restoredPlatform = createFakePlatform()
  restoredPlatform.stored = platform.stored
  restoredPlatform.revision = platform.revision
  const restored = createEmbeddedHarness({ platform: restoredPlatform })
  await restored.boot({ epoch: 'empty-queue-restored' })
  const snapshot = await restored.snapshot()
  assert.equal(snapshot.track, undefined)
  assert.equal(snapshot.queue, undefined)
  assert.equal(snapshot.playback.state, 'stopped')
  assert.equal(snapshot.playback.volume, 0.42)
  assert.equal(snapshot.eqConfig.preampDb, -2)
  assert.equal(snapshot.libraryTrackCount, 3)
  assert.deepEqual(snapshot.favoriteTrackIds, ['c'])
  assert.deepEqual(restoredPlatform.queue, [])
  await restored.shutdown()
})

test('clear keeps an editable queue revision and undo restores a paused selection without native replay', async () => {
  const h = await bootWithQueue()
  async function edit(kind) {
    const { id, revision } = (await h.snapshot()).queue
    return h.value('queue.edit', { id, revision, edit: { kind } }, 'command', { expectedRevision: revision })
  }
  await edit('clear')
  assert.deepEqual(h.platform.queue, [])
  await edit('undo')
  let snapshot = await h.snapshot()
  assert.equal(snapshot.track.id, 'a')
  assert.equal(snapshot.queue.total, 3)
  assert.equal(snapshot.playback.state, 'paused')
  assert.deepEqual(h.platform.queue, [])
  await h.value('playback.play')
  assert.equal((await h.snapshot()).playback.state, 'playing')
  assert.equal(h.platform.queue[h.platform.audio.queueIndex].id, 'a')
  await edit('clear')
  await edit('clear')
  snapshot = await h.snapshot()
  assert.equal(snapshot.track, undefined)
  assert.equal(snapshot.queue.total, 0)
  assert.deepEqual(h.platform.queue, [])
  await h.shutdown()
})

test('legacy Kotlin-mirror and corrupt payloads migrate instead of failing boot', async () => {
  const legacy = createFakePlatform()
  legacy.revision = 3
  legacy.stored = JSON.stringify({
    libraryTracks: TRACKS,
    queueTracks: TRACKS,
    currentQueueIndex: 2,
    queueRevision: 9,
    playMode: 'loop',
    favoriteTrackIds: ['a'],
    bookmarks: [{ id: 'bm-1', trackId: 'b', positionSec: 12.5, label: 'Intro', createdAtMs: 1_700_000_000_000 }],
    playlists: [{ id: 'pl-1', name: 'Old list', trackIds: ['a', 'c'], trackCount: 2, updatedAtMs: 1_700_000_000_000 }],
    customLyrics: { a: { trackId: 'a', source: 'imported', synced: true, lines: [{ timeMs: 1000, text: 'Hello', translation: '你好' }] } },
    eqConfig: { enabled: true, preset: 'Rock', preampDb: -3, bandsDb: [4, 3, 1.5, -1, -1.5, 0, 2, 3.5, 4, 4], bitPerfect: false, gapless: true }
  })
  const h = createEmbeddedHarness({ platform: legacy })
  const booted = await h.boot({ epoch: 'legacy' })
  assert.equal(booted.boot.ok, true)
  const snapshot = await h.snapshot()
  assertKotlinSnapshot(snapshot)
  assert.equal(snapshot.libraryTrackCount, 3)
  assert.equal(snapshot.track.id, 'c')
  assert.equal(snapshot.queue.total, 3)
  assert.deepEqual(snapshot.favoriteTrackIds, ['a'])
  assert.equal(snapshot.bookmarks[0].label, 'Intro')
  assert.equal(snapshot.playlists[0].name, 'Old list')
  assert.equal(snapshot.eqConfig.preset, 'Rock')
  const lyrics = await h.value('lyrics.current', { trackId: 'a' }, 'query')
  assert.equal(lyrics.lines[0].text, 'Hello')
  assert.equal(lyrics.lines[0].translation, '你好')

  const corrupt = createFakePlatform()
  corrupt.revision = 1
  corrupt.stored = '{not json'
  const c = createEmbeddedHarness({ platform: corrupt })
  assert.equal((await c.boot({ epoch: 'corrupt' })).boot.ok, true)
  assert.ok(c.logs.some((log) => log.level === 'error' && /not valid JSON/.test(log.message)))
  await c.value('library.syncTracks', { tracks: TRACKS })
  await c.settle({ timersUpToMs: 50 })
  assert.equal(JSON.parse(corrupt.stored).schema, 'portable-core/1', 'the next save keeps CAS and replaces the corrupt payload')
})

test('rebooting retires the previous runtime and its pending port calls', async () => {
  const h = await bootWithQueue()
  const { requestId } = h.send('audioDevice.getRoute', {}, 'query')
  // The port call is queued in the outbox but never completed before the reboot.
  JSON.parse(h.core.bootHost(JSON.stringify({ epoch: 'second' })))
  await h.settle()
  assert.equal(h.responses.get(requestId).error.code, 'CANCELLED')
})

test('the host-pumped event loop exposes timers through nextTimerDelayMs', async () => {
  const h = createEmbeddedHarness({ eventLoop: true })
  assert.equal(typeof h.sandbox.__TWILIGHT_EVENT_LOOP__, 'object')
  assert.equal(typeof h.sandbox.setImmediate, 'undefined')
  h.sandbox.setTimeout(() => {}, 30)
  const drained = JSON.parse(h.core.drain())
  assert.ok(drained.nextTimerDelayMs > 0 && drained.nextTimerDelayMs <= 30)
})
