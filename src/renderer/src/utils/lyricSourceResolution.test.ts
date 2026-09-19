import assert from 'node:assert/strict'
import test from 'node:test'

const { resolveLyricsWithSources } = (await import(
  new URL('./lyricSourceResolution.ts', import.meta.url).href
)) as typeof import('./lyricSourceResolution')

const localTrack = {
  id: 'local:abc',
  title: 'Local Song',
  artist: 'Artist',
  album: 'Album',
  filePath: 'D:\\Music\\Local Song.flac',
  fileName: 'Local Song.flac',
  dir: 'D:\\Music',
  duration: 180,
  size: 10_000,
  cover: null,
  lyrics: null,
  source: 'local'
}

test('lyric resolution uses local lyrics first while provider may fill missing translation', async () => {
  let providerCalls = 0
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => '[00:01.00]Local lyric',
    loadProviderLyrics: async () => {
      providerCalls++
      return {
        lyrics: '[00:01.00]Provider lyric',
        translatedLyrics: '[00:01.00]Provider translation'
      }
    }
  })

  assert.equal(providerCalls, 1)
  assert.equal(result.lyrics, '[00:01.00]Local lyric')
  assert.equal(result.lyricsSource, 'local')
  assert.equal(result.translatedLyrics, '[00:01.00]Provider translation')
  assert.equal(result.translatedLyricsSource, 'provider')
})

test('lyric resolution supports a local original combined with a provider translation', async () => {
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      lyrics: '[00:01.00]Embedded lyric',
      translatedLyrics: '[00:01.00]Embedded translation',
      lyricsSource: 'embedded',
      translatedLyricsSource: 'embedded'
    },
    originalSource: 'local',
    translationSource: 'provider',
    loadLocalLyrics: async () => '[00:01.00]Local lyric',
    loadProviderLyrics: async () => ({
      lyrics: '[00:01.00]Provider lyric',
      translatedLyrics: '[00:01.00]Provider translation'
    })
  })

  assert.deepEqual(result, {
    lyrics: '[00:01.00]Local lyric',
    translatedLyrics: '[00:01.00]Provider translation',
    romanizedLyrics: null,
    lyricsSource: 'local',
    translatedLyricsSource: 'provider',
    romanizedLyricsSource: null
  })
})

test('local translated and romanized files load even when the original is already embedded', async () => {
  let translatedCalls = 0
  let romanizedCalls = 0
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      lyrics: '[00:01.00]Embedded lyric',
      lyricsSource: 'embedded'
    },
    loadLocalTranslatedLyrics: async () => {
      translatedCalls++
      return '[00:01.00]Local translation'
    },
    loadLocalRomanizedLyrics: async () => {
      romanizedCalls++
      return '[00:01.00]Local romanization'
    }
  })

  assert.equal(translatedCalls, 1)
  assert.equal(romanizedCalls, 1)
  assert.equal(result.lyrics, '[00:01.00]Embedded lyric')
  assert.equal(result.translatedLyrics, '[00:01.00]Local translation')
  assert.equal(result.translatedLyricsSource, 'local')
  assert.equal(result.romanizedLyrics, '[00:01.00]Local romanization')
  assert.equal(result.romanizedLyricsSource, 'local')
})

test('explicit local romanization clears a stale non-local value when its file is missing', async () => {
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      lyrics: '[00:01.00]Embedded lyric',
      lyricsSource: 'embedded',
      romanizedLyrics: '[00:01.00]Provider romanization',
      romanizedLyricsSource: 'provider'
    },
    romanizationSource: 'local',
    loadLocalRomanizedLyrics: async () => null
  })

  assert.equal(result.romanizedLyrics, null)
  assert.equal(result.romanizedLyricsSource, null)
})

test('online fallback failure preserves an existing romanized layer', async () => {
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      romanizedLyrics: '[00:01.00]Existing romanization',
      romanizedLyricsSource: 'local'
    },
    loadOnlineLyrics: async () => {
      throw new Error('online unavailable')
    }
  })

  assert.equal(result.failure, 'online')
  assert.equal(result.romanizedLyrics, '[00:01.00]Existing romanization')
  assert.equal(result.romanizedLyricsSource, 'local')
})

test('provider translation is fetched when automatic local lyrics have no translation', async () => {
  let providerCalls = 0
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => '[00:01.00]Local lyric',
    loadProviderLyrics: async () => {
      providerCalls++
      return {
        lyrics: '[00:01.00]Provider lyric',
        translatedLyrics: '[00:01.00]Provider translation'
      }
    }
  })

  assert.equal(providerCalls, 1)
  assert.equal(result.lyrics, '[00:01.00]Local lyric')
  assert.equal(result.translatedLyrics, '[00:01.00]Provider translation')
  assert.equal(result.translatedLyricsSource, 'provider')
})

test('lyric resolution falls back to provider lyrics when local lyrics are missing', async () => {
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => null,
    loadProviderLyrics: async () => ({
      lyrics: '[00:01.00]Provider lyric',
      translatedLyrics: '[00:01.00]Provider translation'
    })
  })

  assert.equal(result.lyrics, '[00:01.00]Provider lyric')
  assert.equal(result.lyricsSource, 'provider')
  assert.equal(result.translatedLyrics, '[00:01.00]Provider translation')
  assert.equal(result.translatedLyricsSource, 'provider')
})

test('lyric resolution preserves existing embedded lyrics and only asks provider for missing translation', async () => {
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      lyrics: '[00:01.00]Embedded lyric',
      lyricsSource: 'embedded'
    },
    loadLocalLyrics: async () => {
      throw new Error('local loader should not be called when lyrics already exist')
    },
    loadProviderLyrics: async () => ({
      lyrics: '[00:01.00]Provider lyric',
      translatedLyrics: '[00:01.00]Provider translation'
    })
  })

  assert.equal(result.lyrics, '[00:01.00]Embedded lyric')
  assert.equal(result.lyricsSource, 'embedded')
  assert.equal(result.translatedLyrics, '[00:01.00]Provider translation')
  assert.equal(result.translatedLyricsSource, 'provider')
})

test('lyric resolution keeps local lyrics when provider lookup fails', async () => {
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => '[00:01.00]Local lyric',
    loadProviderLyrics: async () => {
      throw new Error('provider unavailable')
    }
  })

  assert.equal(result.lyrics, '[00:01.00]Local lyric')
  assert.equal(result.lyricsSource, 'local')
  assert.equal(result.translatedLyrics, null)
  assert.equal(result.translatedLyricsSource, null)
})

test('lyric resolution preserves a provider failure when no source returned lyrics', async () => {
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => null,
    loadProviderLyrics: async () => {
      throw new Error('provider unavailable')
    }
  })

  assert.equal(result.lyrics, null)
  assert.equal(result.translatedLyrics, null)
  assert.equal(result.failure, 'provider')
})

test('lyric resolution can still use provider lyrics when local lookup fails', async () => {
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => {
      throw new Error('local lrc unreadable')
    },
    loadProviderLyrics: async () => ({
      lyrics: '[00:01.00]Provider lyric',
      translatedLyrics: '[00:01.00]Provider translation'
    })
  })

  assert.equal(result.lyrics, '[00:01.00]Provider lyric')
  assert.equal(result.lyricsSource, 'provider')
  assert.equal(result.translatedLyrics, '[00:01.00]Provider translation')
  assert.equal(result.translatedLyricsSource, 'provider')
})

test('lyric resolution falls back to online when local and provider miss', async () => {
  let onlineCalls = 0
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => null,
    loadProviderLyrics: async () => ({ lyrics: null, translatedLyrics: null }),
    loadOnlineLyrics: async () => {
      onlineCalls++
      return '[00:01.00]Online lyric'
    }
  })

  assert.equal(onlineCalls, 1)
  assert.equal(result.lyrics, '[00:01.00]Online lyric')
  assert.equal(result.lyricsSource, 'online')
})

test('lyric resolution does not call online when lyrics already present', async () => {
  let onlineCalls = 0
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => '[00:01.00]Local lyric',
    loadProviderLyrics: async () => ({ lyrics: null, translatedLyrics: null }),
    loadOnlineLyrics: async () => {
      onlineCalls++
      return '[00:01.00]Online lyric'
    }
  })

  assert.equal(onlineCalls, 0)
  assert.equal(result.lyrics, '[00:01.00]Local lyric')
  assert.equal(result.lyricsSource, 'local')
})

test('lyric resolution prefers provider wordLyrics when original provider lyrics empty', async () => {
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => null,
    loadProviderLyrics: async () => ({
      lyrics: null,
      translatedLyrics: null,
      wordLyrics: '[0,1000](0,500,0)Hello'
    })
  })

  assert.equal(result.lyrics, '[0,1000](0,500,0)Hello')
  assert.equal(result.lyricsSource, 'provider')
})

test('lyric resolution prefers provider wordLyrics over provider line lyrics', async () => {
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => null,
    loadProviderLyrics: async () => ({
      lyrics: '[00:01.00]Provider lyric',
      translatedLyrics: null,
      wordLyrics: '[0,1000](0,500,0)Word'
    })
  })

  assert.equal(result.lyrics, '[0,1000](0,500,0)Word')
  assert.equal(result.lyricsSource, 'provider')
})

test('lyric resolution does not overwrite local lyrics with provider wordLyrics', async () => {
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => '[00:01.00]Local lyric',
    loadProviderLyrics: async () => ({
      lyrics: '[00:01.00]Provider lyric',
      translatedLyrics: null,
      wordLyrics: '[0,1000](0,500,0)Word'
    })
  })

  assert.equal(result.lyrics, '[00:01.00]Local lyric')
  assert.equal(result.lyricsSource, 'local')
})

test('online fallback can attach a companion translation from the provider path', async () => {
  let translationCalls = 0
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => null,
    loadProviderLyrics: async () => ({ lyrics: null, translatedLyrics: null }),
    loadOnlineLyrics: async () => '[00:01.00]Online lyric',
    loadOnlineTranslation: async () => {
      translationCalls++
      return '[00:01.00]Online translation'
    }
  })

  assert.equal(translationCalls, 1)
  assert.equal(result.lyrics, '[00:01.00]Online lyric')
  assert.equal(result.lyricsSource, 'online')
  assert.equal(result.translatedLyrics, '[00:01.00]Online translation')
  assert.equal(result.translatedLyricsSource, 'online')
})

test('online fallback keeps translation hidden when companion lookup misses', async () => {
  let translationCalls = 0
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => null,
    loadProviderLyrics: async () => ({ lyrics: null, translatedLyrics: null }),
    loadOnlineLyrics: async () => '[00:01.00]Online lyric',
    loadOnlineTranslation: async () => {
      translationCalls++
      return null
    }
  })

  assert.equal(translationCalls, 1)
  assert.equal(result.lyrics, '[00:01.00]Online lyric')
  assert.equal(result.lyricsSource, 'online')
  assert.equal(result.translatedLyrics, null)
  assert.equal(result.translatedLyricsSource, null)
})

test('online companion translation is not fetched when no online lyrics were found', async () => {
  let translationCalls = 0
  const result = await resolveLyricsWithSources({
    track: localTrack,
    loadLocalLyrics: async () => null,
    loadProviderLyrics: async () => ({ lyrics: null, translatedLyrics: null }),
    loadOnlineLyrics: async () => null,
    loadOnlineTranslation: async () => {
      translationCalls++
      return '[00:01.00]Should not be used'
    }
  })

  assert.equal(translationCalls, 0)
  assert.equal(result.lyrics, null)
  assert.equal(result.translatedLyrics, null)
})

test('online companion translation does not overwrite an existing translation', async () => {
  let translationCalls = 0
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      lyrics: '[00:01.00]Embedded lyric',
      translatedLyrics: '[00:01.00]Embedded translation',
      lyricsSource: 'embedded',
      translatedLyricsSource: 'embedded'
    },
    loadLocalLyrics: async () => '[00:01.00]Local lyric',
    loadProviderLyrics: async () => ({ lyrics: null, translatedLyrics: null }),
    loadOnlineLyrics: async () => '[00:01.00]Online lyric',
    loadOnlineTranslation: async () => {
      translationCalls++
      return '[00:01.00]Should not overwrite'
    }
  })

  assert.equal(translationCalls, 0)
  assert.equal(result.lyrics, '[00:01.00]Embedded lyric')
  assert.equal(result.translatedLyrics, '[00:01.00]Embedded translation')
  assert.equal(result.translatedLyricsSource, 'embedded')
})

test('automatic resolution prefers AMLL after a local miss and before provider', async () => {
  const calls: string[] = []
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      metadataMatch: { providerId: 'ncm', trackId: '12345', confidence: 'high', score: 1 }
    },
    loadLocalLyrics: async () => {
      calls.push('local')
      return null
    },
    loadAmlTtml: async () => {
      calls.push('amll')
      return '<tt><body><p begin="00:01.00" end="00:02.00">AMLL</p></body></tt>'
    },
    loadProviderLyrics: async () => {
      calls.push('provider')
      return { lyrics: '[00:01.00]Provider', translatedLyrics: null }
    }
  })
  assert.equal(result.lyricsSource, 'amll')
  assert.equal(result.lyrics?.includes('<tt>'), true)
  assert.deepEqual(calls, ['local', 'amll'])
})

test('automatic resolution replaces existing NCM provider lyrics with AMLL', async () => {
  let providerCalls = 0
  const ttml = '<tt><body><p begin="00:01.00" end="00:02.00" ttm:agent="v1">AMLL</p></body></tt>'
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      id: 'ncm:28996501',
      source: 'ncm',
      ncmSongId: 28996501,
      lyrics: '[0,1000](0,500,0)Provider words',
      translatedLyrics: '[00:00.00]Provider translation',
      lyricsSource: 'provider',
      translatedLyricsSource: 'provider'
    },
    loadAmlTtml: async () => ttml,
    loadProviderLyrics: async () => {
      providerCalls++
      return { lyrics: '[00:01.00]Provider', translatedLyrics: '[00:01.00]Provider translation' }
    }
  })

  assert.equal(providerCalls, 0)
  assert.equal(result.lyrics, ttml)
  assert.equal(result.lyricsSource, 'amll')
  assert.equal(result.translatedLyrics, null)
  assert.equal(result.translatedLyricsSource, null)
})

test('unmarked NCM lyrics are treated as provider data and remain AMLL-replaceable', async () => {
  const ttml = '<tt><body><p begin="00:01.00" end="00:02.00">AMLL</p></body></tt>'
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      id: 'ncm:28996501',
      source: 'ncm',
      ncmSongId: 28996501,
      lyrics: '[00:01.00]Legacy NCM lyric',
      translatedLyrics: '[00:01.00]Legacy NCM translation'
    },
    loadAmlTtml: async () => ttml
  })

  assert.equal(result.lyrics, ttml)
  assert.equal(result.lyricsSource, 'amll')
  assert.equal(result.translatedLyrics, null)
})

test('automatic AMLL miss preserves existing provider lyrics as the fallback', async () => {
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      id: 'ncm:28996501',
      source: 'ncm',
      ncmSongId: 28996501,
      lyrics: '[00:01.00]Provider lyric',
      translatedLyrics: '[00:01.00]Provider translation',
      lyricsSource: 'provider',
      translatedLyricsSource: 'provider'
    },
    loadAmlTtml: async () => null
  })

  assert.equal(result.lyrics, '[00:01.00]Provider lyric')
  assert.equal(result.lyricsSource, 'provider')
  assert.equal(result.translatedLyrics, '[00:01.00]Provider translation')
  assert.equal(result.translatedLyricsSource, 'provider')
})

test('automatic AMLL never overwrites embedded lyrics', async () => {
  let amlCalls = 0
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      metadataMatch: { providerId: 'ncm', trackId: '28996501', confidence: 'high', score: 1 },
      lyrics: '[00:01.00]Embedded lyric',
      lyricsSource: 'embedded'
    },
    loadAmlTtml: async () => {
      amlCalls++
      return '<tt />'
    }
  })

  assert.equal(amlCalls, 0)
  assert.equal(result.lyrics, '[00:01.00]Embedded lyric')
  assert.equal(result.lyricsSource, 'embedded')
})

test('automatic local lyrics replace a lower-priority provider baseline before AMLL', async () => {
  let amlCalls = 0
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      lyrics: '[00:01.00]Provider lyric',
      lyricsSource: 'provider',
      metadataMatch: { providerId: 'ncm', trackId: '28996501', confidence: 'high', score: 1 }
    },
    loadLocalLyrics: async () => '[00:01.00]Local lyric',
    loadAmlTtml: async () => {
      amlCalls++
      return '<tt />'
    }
  })

  assert.equal(amlCalls, 0)
  assert.equal(result.lyrics, '[00:01.00]Local lyric')
  assert.equal(result.lyricsSource, 'local')
})

test('low-confidence local metadata never requests AMLL', async () => {
  let amlCalls = 0
  const result = await resolveLyricsWithSources({
    track: {
      ...localTrack,
      metadataMatch: { providerId: 'ncm', trackId: '12345', confidence: 'medium', score: 0.5 }
    },
    loadAmlTtml: async () => {
      amlCalls++
      return '<tt />'
    }
  })
  assert.equal(amlCalls, 0)
  assert.equal(result.lyrics, null)
})
