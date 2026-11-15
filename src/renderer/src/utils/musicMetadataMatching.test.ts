import assert from 'node:assert/strict'
import test from 'node:test'

const { buildMetadataMatchCandidates, findBestMetadataMatch, enrichLocalTrackMetadata } =
  (await import(
    new URL('./musicMetadataMatching.ts', import.meta.url).href
  )) as typeof import('./musicMetadataMatching')

const localTrack = {
  id: 'local:abc',
  title: 'Moon River',
  artist: 'Audrey',
  album: 'Local Album',
  filePath: 'D:\\Music\\Moon River.flac',
  fileName: 'Moon River.flac',
  duration: 181,
  size: 10_000,
  cover: null,
  lyrics: null,
  source: 'local',
  format: 'flac'
}

test('findBestMetadataMatch matches provider metadata by normalized title, artist, and close duration', () => {
  const match = findBestMetadataMatch(localTrack, [
    {
      id: 'ncm:wrong',
      title: 'Moon River Live',
      artist: 'Audrey',
      album: 'Concert',
      filePath: 'ncm:wrong',
      fileName: 'Moon River Live',
      duration: 260,
      size: 0,
      cover: 'https://cover.example/live.jpg',
      lyrics: null,
      source: 'ncm'
    },
    {
      id: 'ncm:123',
      title: ' moon  river ',
      artist: 'AUDREY',
      album: 'Online Album',
      filePath: 'ncm:123',
      fileName: 'Moon River',
      duration: 179,
      size: 0,
      cover: 'https://cover.example/album.jpg',
      lyrics: '[00:00.00]Moon River',
      translatedLyrics: '[00:00.00]月亮河',
      source: 'ncm'
    }
  ])

  assert.equal(match?.track.id, 'ncm:123')
  assert.equal(match?.confidence, 'high')
})

test('findBestMetadataMatch rejects far-duration candidates even when title and artist match', () => {
  const match = findBestMetadataMatch(localTrack, [
    {
      id: 'ncm:live',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Live Album',
      filePath: 'ncm:live',
      fileName: 'Moon River',
      duration: 420,
      size: 0,
      cover: 'https://cover.example/live.jpg',
      lyrics: null,
      source: 'ncm'
    }
  ])

  assert.equal(match, null)
})

test('findBestMetadataMatch normalizes spacing around artist separators', () => {
  const match = findBestMetadataMatch(
    {
      ...localTrack,
      title: 'コンティニュー！',
      artist: 'lapix/藍月なくる',
      duration: 258
    },
    [
      {
        ...localTrack,
        id: 'ncm:1939672461',
        title: 'コンティニュー！',
        artist: 'lapix / 藍月なくる',
        filePath: 'ncm:1939672461',
        source: 'ncm',
        duration: 258
      }
    ]
  )

  assert.equal(match?.track.id, 'ncm:1939672461')
  assert.equal(match?.confidence, 'high')
})

test('metadata matching recognizes the same artist credits across separators and order', () => {
  const candidate = {
    ...localTrack,
    id: 'ncm:collaboration',
    source: 'ncm',
    title: '千里之外',
    artist: '周杰伦 / 费玉清'
  }
  for (const artist of ['周杰伦;费玉清', '费玉清、周杰伦', '周杰伦 & 费玉清']) {
    const match = findBestMetadataMatch({ ...localTrack, title: '千里之外', artist }, [candidate])
    assert.equal(match?.track.id, candidate.id, artist)
    assert.equal(match?.confidence, 'high')
  }
})

test('metadata matching accepts a missing guest credit only with close known duration', () => {
  const candidate = { ...localTrack, id: 'ncm:guest', source: 'ncm', artist: 'Audrey / Guest' }
  const match = findBestMetadataMatch(localTrack, [candidate])
  assert.equal(match?.track.id, candidate.id)
  assert.equal(match?.confidence, 'medium')
  for (const duration of [0, Number.NaN, localTrack.duration + 12]) {
    assert.equal(findBestMetadataMatch(localTrack, [{ ...candidate, duration }]), null)
  }
  assert.equal(
    findBestMetadataMatch({ ...localTrack, artist: 'Audrey / Other' }, [candidate]),
    null,
    'a shared artist alone must not match different collaborations'
  )
})

test('metadata matching treats scanner placeholders as missing metadata and fills them', () => {
  const candidate = { ...localTrack, id: 'ncm:123', source: 'ncm', album: 'Online Album' }
  for (const artist of ['Unknown Artist', '未知艺术家', '未知歌手']) {
    const track = { ...localTrack, artist, album: 'Unknown Album' }
    const match = findBestMetadataMatch(track, [candidate])
    assert.equal(match?.track.id, candidate.id)
    assert.equal(match?.confidence, 'medium')
    assert.equal(buildMetadataMatchCandidates(track, [candidate])[0].fills.metadata, true)
    const enriched = enrichLocalTrackMetadata(track, match)
    assert.equal(enriched.artist, 'Audrey')
    assert.equal(enriched.album, 'Online Album')
    assert.equal(enriched.id, localTrack.id)
    assert.equal(enriched.filePath, localTrack.filePath)
    assert.equal(findBestMetadataMatch({ ...track, duration: 0 }, [candidate]), null)
  }
})

test('metadata matching tolerates title punctuation without merging versions or covers', () => {
  const track = { ...localTrack, title: 'Don’t Stop' }
  const candidate = { ...localTrack, id: 'ncm:123', source: 'ncm', title: "Don't Stop" }
  assert.equal(findBestMetadataMatch(track, [candidate])?.track.id, candidate.id)
  for (const title of ["Don't Stop (Live)", "Don't Stop (Remix)", "Don't Stop (Instrumental)"]) {
    assert.equal(findBestMetadataMatch(track, [{ ...candidate, title }]), null)
  }
  assert.equal(findBestMetadataMatch(track, [{ ...candidate, artist: 'Other Singer' }]), null)
  assert.equal(
    findBestMetadataMatch({ ...track, title: '???' }, [{ ...candidate, title: '!!!' }]),
    null,
    'punctuation alone provides no title identity'
  )
})

test('buildMetadataMatchCandidates ranks provider candidates and exposes enrichment hints', () => {
  const candidates = buildMetadataMatchCandidates(localTrack, [
    {
      id: 'local:duplicate',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Local Duplicate',
      filePath: 'D:\\Music\\Duplicate.flac',
      fileName: 'Duplicate.flac',
      duration: 181,
      size: 10_000,
      cover: 'local-cover',
      lyrics: null,
      source: 'local'
    },
    {
      id: 'ncm:medium',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Provider Medium',
      filePath: 'ncm:medium',
      fileName: 'Moon River',
      duration: 197,
      size: 0,
      cover: null,
      lyrics: '[00:00.00]Medium lyric',
      source: 'ncm'
    },
    {
      id: 'bili:high',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Provider High',
      filePath: 'bili:high',
      fileName: 'Moon River',
      duration: 180,
      size: 0,
      cover: 'https://cover.example/high.jpg',
      lyrics: '[00:00.00]High lyric',
      translatedLyrics: '[00:00.00]高分歌词',
      source: 'bili'
    },
    {
      id: 'ncm:wrong',
      title: 'Different Song',
      artist: 'Audrey',
      album: 'Wrong',
      filePath: 'ncm:wrong',
      fileName: 'Different Song',
      duration: 180,
      size: 0,
      cover: null,
      lyrics: null,
      source: 'ncm'
    }
  ])

  assert.deepEqual(
    candidates.map((candidate) => candidate.track.id),
    ['bili:high', 'ncm:medium']
  )
  assert.equal(candidates[0].providerId, 'bili')
  assert.equal(candidates[0].sourceLabel, 'bili')
  assert.equal(candidates[0].confidence, 'high')
  assert.equal(candidates[0].fills.cover, true)
  assert.equal(candidates[0].fills.lyrics, true)
  assert.equal(candidates[0].fills.translatedLyrics, true)
  assert.equal(candidates[0].fills.metadata, false)
  assert.equal(candidates[1].confidence, 'medium')
})

test('buildMetadataMatchCandidates keeps provider search ranking when scores tie', () => {
  const first = {
    id: 'ncm:first',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'First Album',
    filePath: 'ncm:first',
    fileName: 'Moon River',
    duration: 180,
    size: 0,
    cover: null,
    lyrics: null,
    source: 'ncm'
  }
  const second = {
    ...first,
    id: 'bili:second',
    filePath: 'bili:second',
    source: 'bili'
  }

  const candidates = buildMetadataMatchCandidates(localTrack, [first, second])

  assert.deepEqual(
    candidates.map((candidate) => candidate.track.id),
    ['ncm:first', 'bili:second']
  )
})

test('enrichLocalTrackMetadata fills missing cover and lyrics without replacing local playback identity', () => {
  const enriched = enrichLocalTrackMetadata(localTrack, {
    track: {
      id: 'ncm:123',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Online Album',
      filePath: 'ncm:123',
      fileName: 'Moon River',
      duration: 180,
      size: 0,
      cover: 'https://cover.example/album.jpg',
      lyrics: '[00:00.00]Moon River',
      translatedLyrics: '[00:00.00]月亮河',
      source: 'ncm',
      streamUrl: 'https://temporary.example/song.mp3'
    },
    confidence: 'high',
    score: 95
  })

  assert.equal(enriched.id, 'local:abc')
  assert.equal(enriched.filePath, 'D:\\Music\\Moon River.flac')
  assert.equal(enriched.source, 'local')
  assert.equal(enriched.cover, 'https://cover.example/album.jpg')
  assert.equal(enriched.lyrics, '[00:00.00]Moon River')
  assert.equal(enriched.translatedLyrics, '[00:00.00]月亮河')
  assert.equal(enriched.lyricsSource, 'provider')
  assert.equal(enriched.translatedLyricsSource, 'provider')
  assert.deepEqual(enriched.metadataMatch, {
    providerId: 'ncm',
    trackId: 'ncm:123',
    confidence: 'high',
    score: 95
  })
  assert.equal(enriched.streamUrl, undefined)
})

test('enrichLocalTrackMetadata can fill missing artist and album from a close provider match', () => {
  const localMissingArtist = {
    ...localTrack,
    artist: '',
    album: ''
  }
  const match = findBestMetadataMatch(localMissingArtist, [
    {
      id: 'ncm:123',
      title: 'Moon River',
      artist: 'Audrey',
      album: 'Online Album',
      filePath: 'ncm:123',
      fileName: 'Moon River',
      duration: 180,
      size: 0,
      cover: null,
      lyrics: null,
      source: 'ncm'
    }
  ])

  const candidates = buildMetadataMatchCandidates(localMissingArtist, [match!.track])
  const enriched = enrichLocalTrackMetadata(localMissingArtist, match)

  assert.equal(match?.confidence, 'medium')
  assert.equal(candidates[0].fills.metadata, true)
  assert.equal(enriched.artist, 'Audrey')
  assert.equal(enriched.album, 'Online Album')
  assert.equal(enriched.id, 'local:abc')
  assert.equal(enriched.source, 'local')
})

test('enrichLocalTrackMetadata fills missing genre without overwriting an existing one', () => {
  const enriched = enrichLocalTrackMetadata(
    { ...localTrack, genre: null },
    {
      track: {
        id: 'ncm:123',
        title: 'Moon River',
        artist: 'Audrey',
        album: 'Online Album',
        genre: 'Jazz',
        filePath: 'ncm:123',
        fileName: 'Moon River',
        duration: 180,
        size: 0,
        cover: null,
        lyrics: null,
        source: 'ncm'
      },
      confidence: 'high',
      score: 95
    }
  )
  assert.equal(enriched.genre, 'Jazz')

  const preserved = enrichLocalTrackMetadata(
    { ...localTrack, genre: 'Soundtrack' },
    {
      track: {
        id: 'ncm:123',
        title: 'Moon River',
        artist: 'Audrey',
        album: 'Online Album',
        genre: 'Jazz',
        filePath: 'ncm:123',
        fileName: 'Moon River',
        duration: 180,
        size: 0,
        cover: null,
        lyrics: null,
        source: 'ncm'
      },
      confidence: 'high',
      score: 95
    }
  )
  assert.equal(preserved.genre, 'Soundtrack')
})

test('enrichLocalTrackMetadata preserves existing lyric source labels', () => {
  const enriched = enrichLocalTrackMetadata(
    {
      ...localTrack,
      lyrics: '[00:00.00]Local lyric',
      lyricsSource: 'local'
    },
    {
      track: {
        id: 'ncm:123',
        title: 'Moon River',
        artist: 'Audrey',
        album: 'Online Album',
        filePath: 'ncm:123',
        fileName: 'Moon River',
        duration: 180,
        size: 0,
        cover: 'https://cover.example/album.jpg',
        lyrics: '[00:00.00]Provider lyric',
        translatedLyrics: '[00:00.00]Provider translation',
        source: 'ncm'
      },
      confidence: 'high',
      score: 95
    }
  )

  assert.equal(enriched.lyrics, '[00:00.00]Local lyric')
  assert.equal(enriched.lyricsSource, 'local')
  assert.equal(enriched.translatedLyrics, '[00:00.00]Provider translation')
  assert.equal(enriched.translatedLyricsSource, 'provider')
})

test('enrichLocalTrackMetadata persists durable coverSource for session-protected remote covers without overwriting local covers', () => {
  const remoteCandidate = {
    id: 'ncm:789',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'Online Album',
    filePath: 'ncm:789',
    fileName: 'Moon River',
    duration: 180,
    size: 0,
    cover: 'twilight-media://image/session-token',
    coverSource: 'https://p2.music.126.net/durable.jpg',
    lyrics: null,
    source: 'ncm'
  }
  const match = { track: remoteCandidate, confidence: 'high' as const, score: 96 }

  const fromEmpty = enrichLocalTrackMetadata(localTrack, match)
  assert.equal(fromEmpty.cover, 'twilight-media://image/session-token')
  assert.equal(fromEmpty.coverSource, 'https://p2.music.126.net/durable.jpg')

  const staleHandleTrack = {
    ...localTrack,
    cover: 'twilight-media://image/stale-previous-session'
  }
  assert.equal(buildMetadataMatchCandidates(staleHandleTrack, [remoteCandidate])[0].fills.cover, true)
  const healed = enrichLocalTrackMetadata(staleHandleTrack, match)
  assert.equal(healed.cover, 'twilight-media://image/session-token')
  assert.equal(healed.coverSource, 'https://p2.music.126.net/durable.jpg')

  const embeddedCoverTrack = {
    ...localTrack,
    album: 'Unknown Album',
    cover: 'cover://embedded.jpg'
  }
  assert.equal(
    buildMetadataMatchCandidates(embeddedCoverTrack, [remoteCandidate])[0].fills.cover,
    false
  )
  const keptEmbedded = enrichLocalTrackMetadata(embeddedCoverTrack, match)
  assert.equal(keptEmbedded.cover, 'cover://embedded.jpg')
  assert.equal(keptEmbedded.coverSource, undefined)
})
