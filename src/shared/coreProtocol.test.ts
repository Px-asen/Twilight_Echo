import assert from 'node:assert/strict'
import test from 'node:test'
import { crc32 } from 'node:zlib'
import { isCoreRequest, coreOperation } from './coreProtocol.ts'
import { isBoundedCoreJson } from './coreRequestValidation.ts'
import { emptyCoreStateCounts } from './coreState.ts'
import { validCorePlatformPayload, type CorePlatformRequest } from './corePlatform.ts'

const request = (name: string, payload: unknown, kind = 'command') => ({
  kind,
  name,
  payload,
  requestId: 'request:1',
  epoch: 'core:1'
})

test('personal metadata operations stay library-write scoped and the full 2 MiB bitmap request crosses the public payload budget', () => {
  const tiny = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=',
    'base64'
  )
  // A bounded PNG ancillary chunk makes a maximum-size structural fixture,
  // exercising the actual JSON envelope rather than a small validator sample.
  const extra = Buffer.alloc(2 * 1024 * 1024 - tiny.length)
  extra.writeUInt32BE(extra.length - 12, 0)
  extra.write('tEXt', 4)
  extra.fill(120, 8, extra.length - 4)
  extra.write('Comment\0', 8)
  extra.writeUInt32BE(crc32(extra.subarray(4, -4)), extra.length - 4)
  const png =
    'data:image/png;base64,' +
    Buffer.concat([tiny.subarray(0, -12), extra, tiny.subarray(-12)]).toString('base64')
  const payload = { entityId: 'artist', revision: 0, language: 'en', mode: 'value', dataUrl: png }
  assert.equal(isCoreRequest(request('metadata.entity.artworkOverride', payload)), true)
  assert.equal(
    isCoreRequest(request('metadata.entity.artworkOverride', { ...payload, dataUrl: png + 'A' })),
    false
  )
  assert.equal(
    isCoreRequest(
      request('metadata.entity.artworkOverride', { ...payload, filePath: 'D:/not-authorized.png' })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('metadata.entity.sourcePreference', {
        entityId: 'artist',
        revision: 0,
        language: 'en',
        provider: null
      })
    ),
    true
  )
  for (const name of [
    'metadata.entity.sourcePreference',
    'metadata.entity.artworkOverride'
  ] as const)
    assert.equal(coreOperation(name)?.permission, 'library:write')
})

test('Focus exposes bounded versioned queries and independent saved edits without private contexts or queue pages', () => {
  const query = {
    version: 1,
    entity: 'recording',
    where: {
      all: [
        { source: { provider: 'local', bitDepth: { gte: 24 } } },
        { not: { rating: { target: 'self', mode: 'personal', gteStars: 4 } } }
      ]
    }
  }
  for (const [name, input] of Object.entries({
    'focus.query': { query, limit: 200 },
    'focus.facets': { query, facet: 'provider', limit: 200 },
    'focus.saved.list': { limit: 200, savedRevision: 0 }
  })) {
    assert.equal(isCoreRequest(request(name, input, 'query')), true)
    assert.equal(isCoreRequest(request(name, { ...input, limit: 201 }, 'query')), false)
    assert.equal(isCoreRequest(request(name, { ...input, platformContexts: {} }, 'query')), false)
    assert.equal(isCoreRequest(request(name, { ...input, profileId: 'other' }, 'query')), false)
    assert.equal(
      coreOperation(name as Parameters<typeof coreOperation>[0])?.permission,
      'library:read'
    )
  }
  for (const [name, input] of Object.entries({
    'focus.saved.create': { name: 'Night', query, savedRevision: 0 },
    'focus.saved.rename': { id: 'saved', name: 'Jazz', nameRevision: 1 },
    'focus.saved.update': { id: 'saved', query, queryRevision: 1 },
    'focus.saved.delete': { id: 'saved', nameRevision: 1, queryRevision: 1 }
  })) {
    assert.equal(isCoreRequest(request(name, input)), true)
    assert.equal(isCoreRequest(request(name, { ...input, tracks: [] })), false)
    assert.equal(
      coreOperation(name as Parameters<typeof coreOperation>[0])?.permission,
      'library:write'
    )
  }
  const token = {
    savedRevision: 0,
    catalogRevision: 0,
    contentRevision: 0,
    genresRevision: 0,
    metadataRevision: 0,
    ratingsRevision: 0,
    preferencesRevision: 0,
    tagsRevision: 0,
    linkRevision: 0,
    historyRevision: 0,
    queryKey: 'query',
    contextKey: 'context',
    asOf: 1,
    expiresAt: null
  }
  assert.equal(isCoreRequest(request('focus.play', { query, token })), true)
  assert.equal(coreOperation('focus.play')?.permission, 'playback:write')
  assert.equal(
    isCoreRequest(request('focus.play.status', { requestId: 'one', epoch: 'current' }, 'query')),
    true
  )
  assert.equal(
    isCoreRequest(
      request('focus.play.status', { requestId: 'one', epoch: 'current', owner: 'other' }, 'query')
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('focus.play.status', { requestId: '', epoch: 'current' }, 'query')),
    false
  )
  assert.equal(coreOperation('focus.play.status')?.permission, 'playback:read')
  assert.equal(
    isCoreRequest(request('focus.query', { query: { ...query, sql: 'SELECT 1' } }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'focus.query',
        {
          query: { ...query, where: { all: Array.from({ length: 65 }, () => ({ text: 'song' })) } }
        },
        'query'
      )
    ),
    false
  )
  let where: unknown = { text: 'song' }
  for (let i = 0; i < 8; i++) where = { not: where }
  assert.equal(
    isCoreRequest(request('focus.query', { query: { ...query, where } }, 'query')),
    false
  )
  for (const name of ['focus.state', 'focus.playbackPage'])
    assert.equal(isCoreRequest(request(name, {}, 'query')), false)
})

test('tags expose bounded reference queries and independent edits, not paths, profiles or private queue pages', () => {
  const token = { tagsRevision: 1, catalogRevision: 2, contentRevision: 3, linkRevision: 4 }
  const inputs = {
    'tags.list': { search: '夜晚', offset: 0, limit: 100, token },
    'tags.entity': { entityId: 'recording', limit: 100, token },
    'tags.members': { tagId: 'tag:one', limit: 100, token },
    'tags.recordings': { tagId: 'tag:one', limit: 100, token }
  }
  for (const [name, input] of Object.entries(inputs)) {
    assert.equal(isCoreRequest(request(name, input, 'query')), true)
    assert.equal(isCoreRequest(request(name, { ...input, limit: 101 }, 'query')), false)
    assert.equal(isCoreRequest(request(name, { ...input, profileId: 'someone' }, 'query')), false)
    assert.equal(
      coreOperation(name as Parameters<typeof coreOperation>[0])?.permission,
      'library:read'
    )
  }
  const commands = {
    'tags.create': { name: '夜晚', tagsRevision: 1 },
    'tags.rename': { tagId: 'tag:one', name: '雨夜', nameRevision: 1 },
    'tags.delete': { tagId: 'tag:one', nameRevision: 1, membersRevision: 2 },
    'tags.member.set': {
      tagId: 'tag:one',
      entityId: 'recording',
      present: true,
      membersRevision: 2
    }
  }
  for (const [name, input] of Object.entries(commands)) {
    assert.equal(isCoreRequest(request(name, input)), true)
    assert.equal(isCoreRequest(request(name, { ...input, filePath: 'D:/private.flac' })), false)
    assert.equal(
      coreOperation(name as Parameters<typeof coreOperation>[0])?.permission,
      'library:write'
    )
  }
  assert.equal(
    isCoreRequest(request('tags.member.set', { tagId: 'tag:one', entityId: 'r', present: true })),
    false
  )
  assert.equal(
    isCoreRequest(request('tags.play', { tagId: 'tag:one', token, sourceId: 'source' })),
    true
  )
  assert.equal(
    isCoreRequest(
      request('tags.play', { tagId: 'tag:one', token: { ...token, path: 'D:/private' } })
    ),
    false
  )
  assert.equal(isCoreRequest(request('tags.play', { tagId: 'tag:one', token, tracks: [] })), false)
  assert.equal(coreOperation('tags.play')?.permission, 'playback:write')
  for (const name of ['tags.state', 'tags.playbackPage', 'tags.sourceTracks'])
    assert.equal(isCoreRequest(request(name, {}, 'query')), false)
})

test('preferences validate local states and server-owned targets without exposing migration or playback policy', () => {
  const token = { preferencesRevision: 0, linkRevision: 0, targetKey: 'opaque' }
  for (const state of ['none', 'favorite', 'ban'])
    assert.equal(
      isCoreRequest(request('preferences.set', { entityId: 'song', token, state })),
      true
    )
  for (const state of [null, false, 'like', 1, undefined])
    assert.equal(
      isCoreRequest(request('preferences.set', { entityId: 'song', token, state })),
      false
    )
  for (const extra of [
    { profileId: 'other' },
    { filePath: 'D:/private' },
    { targetId: 'identity' }
  ])
    assert.equal(
      isCoreRequest(
        request('preferences.set', { entityId: 'song', token, state: 'ban', ...extra })
      ),
      false
    )
  assert.equal(
    isCoreRequest(
      request('preferences.set', { entityId: 'song', token: { ...token, extra: 1 }, state: 'ban' })
    ),
    false
  )
  assert.equal(isCoreRequest(request('preferences.detail', { entityId: 'song' }, 'query')), true)
  assert.equal(
    isCoreRequest(
      request(
        'preferences.targets',
        { entityId: 'song', trackContext: { provider: 'local', id: 'song' }, limit: 100 },
        'query'
      )
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('preferences.targets', { entityId: 'song', limit: 101 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(
      request('preferences.history', { entityId: 'song', offset: 0, limit: 100 }, 'query')
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('preferences.history', { entityId: 'song', limit: 101 }, 'query')),
    false
  )
  for (const name of [
    'preferences.automaticEligibility',
    'preferences.playlistsMigrate',
    'preferences.playlistsSave'
  ])
    assert.equal(isCoreRequest(request(name, { tracks: [] })), false)
  for (const name of ['preferences.detail', 'preferences.targets', 'preferences.history'])
    assert.equal(
      coreOperation(name as Parameters<typeof coreOperation>[0])?.permission,
      'library:read'
    )
  assert.equal(coreOperation('preferences.set')?.permission, 'library:write')
  assert.equal(coreOperation('playback.favorite')?.permission, 'playback:write')
})

test('ratings validate half-star steps, bounded history and server-owned default profile', () => {
  const token = { ratingsRevision: 0, linkRevision: 0, targetKey: 'opaque' }
  assert.equal(isCoreRequest(request('ratings.detail', { entityId: 'song' }, 'query')), true)
  assert.equal(
    isCoreRequest(
      request('ratings.targets', { entityId: 'manual', offset: 20, limit: 100 }, 'query')
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('ratings.targets', { entityId: 'manual', limit: 101 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'ratings.targets',
        { entityId: 'manual', trackContext: { provider: 'local', id: 'song' } },
        'query'
      )
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request(
        'ratings.targets',
        {
          entityId: 'manual',
          trackContext: { provider: 'local', id: 'song', filePath: 'D:/private' }
        },
        'query'
      )
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'ratings.targets',
        { entityId: 'manual', trackContext: { provider: 'Local', id: 'song' } },
        'query'
      )
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('ratings.targets', { entityId: 'manual', kind: 'release' }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('ratings.history', { entityId: 'song', limit: 100 }, 'query')),
    true
  )
  assert.equal(
    isCoreRequest(request('ratings.history', { entityId: 'song', limit: 101 }, 'query')),
    false
  )
  for (const steps of [1, 10, null])
    assert.equal(isCoreRequest(request('ratings.set', { entityId: 'song', token, steps })), true)
  for (const steps of [0, 11, 1.5, '8', undefined])
    assert.equal(isCoreRequest(request('ratings.set', { entityId: 'song', token, steps })), false)
  for (const extra of [
    { profileId: 'other' },
    { filePath: 'D:/private' },
    { targetId: 'identity' }
  ])
    assert.equal(
      isCoreRequest(request('ratings.set', { entityId: 'song', token, steps: 8, ...extra })),
      false
    )
  assert.equal(
    isCoreRequest(
      request('ratings.set', { entityId: 'song', token: { ...token, x: 1 }, steps: 8 })
    ),
    false
  )
  assert.equal(coreOperation('ratings.detail')?.permission, 'library:read')
  assert.equal(coreOperation('ratings.targets')?.permission, 'library:read')
  assert.equal(coreOperation('ratings.history')?.permission, 'library:read')
  assert.equal(coreOperation('ratings.set')?.permission, 'library:write')
})

test('unified catalog exposes bounded identity queries and explicit playback, not caller-owned source authority', () => {
  assert.equal(
    isCoreRequest(
      request('catalog.query', { kind: 'recording', source: 'ncm', limit: 200 }, 'query')
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('catalog.query', { kind: 'file', limit: 200 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('catalog.query', { kind: 'release', limit: 201 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('catalog.query', { kind: 'artist', search: 'x'.repeat(513) }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('catalog.query', { kind: 'artist', sql: 'anything' }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('catalog.detail', { id: 'entity', revision: 2 }, 'query')),
    true
  )
  assert.equal(
    isCoreRequest(
      request('catalog.sources', { entityId: 'entity', offset: 200, revision: 2 }, 'query')
    ),
    true
  )
  assert.equal(isCoreRequest(request('catalog.status', {}, 'query')), true)
  assert.equal(isCoreRequest(request('catalog.refresh', {})), true)
  assert.equal(isCoreRequest(request('catalog.cancel', {})), true)
  assert.equal(isCoreRequest(request('catalog.play', { sourceId: 'source', revision: 2 })), true)
  assert.equal(isCoreRequest(request('catalog.play', { sourceId: 'source' })), false)
  assert.equal(
    isCoreRequest(
      request('catalog.play', { sourceId: 'source', revision: 2, filePath: 'C:/private' })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('catalog.play', { sourceId: 'source', revision: 2, streamUrl: 'https://private' })
    ),
    false
  )
  assert.equal(isCoreRequest(request('catalog.refresh', { tracks: [] })), false)
  assert.equal(coreOperation('catalog.query')?.permission, 'library:read')
  assert.equal(coreOperation('catalog.refresh')?.permission, 'library:write')
  assert.equal(coreOperation('catalog.play')?.permission, 'playback:write')
})

test('OPRA exposes bounded catalog queries and an explicit refresh command', () => {
  assert.equal(isCoreRequest(request('opra.search', { query: 'HD 600' }, 'query')), true)
  assert.equal(isCoreRequest(request('opra.search', { query: '' }, 'query')), true)
  assert.equal(isCoreRequest(request('opra.search', { query: 'x'.repeat(257) }, 'query')), false)
  assert.equal(isCoreRequest(request('opra.profile', { id: 'author::hd600' }, 'query')), true)
  assert.equal(isCoreRequest(request('opra.profile', { id: 'x'.repeat(129) }, 'query')), false)
  assert.equal(isCoreRequest(request('opra.status', {}, 'query')), true)
  assert.equal(isCoreRequest(request('opra.refresh', {})), true)
  assert.equal(isCoreRequest(request('opra.refresh', {}, 'query')), false)
  assert.equal(isCoreRequest(request('opra.refresh', { url: 'https://other.test' })), false)
  assert.equal(coreOperation('opra.profile')?.permission, 'settings:read')
  assert.equal(coreOperation('opra.refresh')?.permission, 'settings:write')
})

test('plugin marketplace and experience commands expose bounded actions, not arbitrary paths or uploaded library authority', () => {
  for (const name of ['plugins.index.list', 'plugins.index.status', 'extensions.experiences']) {
    assert.equal(isCoreRequest(request(name, {}, 'query')), true)
    assert.equal(isCoreRequest(request(name, { method: 'anything' }, 'query')), false)
  }
  assert.equal(isCoreRequest(request('plugins.index.refresh', {})), true)
  assert.equal(
    isCoreRequest(request('plugins.index.install', { id: 'com.example.experience' })),
    true
  )
  assert.equal(isCoreRequest(request('plugins.index.install', { id: '../package' })), false)
  assert.equal(
    isCoreRequest(
      request('plugins.index.install', { id: 'com.example.experience', path: '/tmp/package.tep' })
    ),
    false
  )
  const task = { id: 'com.example.experience', operation: 'task', args: { scope: 'all' } }
  assert.equal(isCoreRequest(request('extensions.music', task)), true)
  assert.equal(isCoreRequest(request('extensions.music', { ...task, albums: [] })), false)
  assert.equal(
    isCoreRequest(request('extensions.music', { ...task, operation: 'anyMethod' })),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'extensions.resource',
        { url: 'plugin-ui://com.example.experience/1.0.0/ui/index.html' },
        'query'
      )
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('extensions.resource', { url: 'file:///private/music.flac' }, 'query')),
    false
  )
  assert.equal(coreOperation('extensions.resource')?.permission, 'plugins:resources')
  assert.equal(coreOperation('plugins.installSource')?.permission, 'plugins:resources')
})

test('playback presentation and queue upload expose finite, revision-fenced identities rather than renderer media authority', () => {
  for (const name of ['player.presentation', 'player.lyrics', 'playback.diagnostics']) {
    assert.equal(isCoreRequest(request(name, {}, 'query')), true)
    assert.equal(isCoreRequest(request(name, { method: 'any' }, 'query')), false)
  }
  assert.equal(coreOperation('playback.diagnostics')?.permission, 'settings:read')
  assert.equal(isCoreRequest(request('playback.control', { type: 'pause' })), true)
  assert.equal(isCoreRequest(request('playback.control', { type: 'anyMethod' })), false)
  assert.equal(isCoreRequest(request('playback.control', { type: 'set-volume', value: 2 })), false)
  const provider = {
    kind: 'provider',
    track: { id: 'ncm:7', source: 'ncm', title: 'Seven', artist: '', album: '', duration: 60 }
  }
  assert.equal(isCoreRequest(request('queue.submit', { kind: 'begin', selectedIndex: 0 })), true)
  const page = { kind: 'append', id: 'upload', sequence: 1, items: [provider] }
  assert.equal(isCoreRequest(request('queue.submit', page)), true)
  assert.equal(
    isCoreRequest(request('queue.submit', { ...page, items: Array(201).fill(provider) })),
    false
  )
  assert.equal(
    isCoreRequest(
      request('queue.submit', {
        ...page,
        items: [{ ...provider, track: { ...provider.track, streamUrl: 'https://private' } }]
      })
    ),
    false
  )
  for (const cover of [
    null,
    'twilight-media://image/token_abc-123',
    'cover://cached_art.jpg',
    'data:image/jpeg;base64,AA=='
  ]) {
    assert.equal(
      isCoreRequest(
        request('queue.submit', {
          ...page,
          items: [{ ...provider, track: { ...provider.track, cover } }]
        })
      ),
      true
    )
  }
  for (const invalidCover of [
    'https://p2.music.126.net/raw.jpg',
    'http://example.com/raw.jpg',
    'file:///C:/Users/private.jpg',
    'twilight-media://audio/token_abc-123'
  ]) {
    assert.equal(
      isCoreRequest(
        request('queue.submit', {
          ...page,
          items: [{ ...provider, track: { ...provider.track, cover: invalidCover } }]
        })
      ),
      false
    )
  }
  assert.equal(
    isCoreRequest(
      request('queue.submit', {
        ...page,
        items: [
          {
            ...provider,
            track: { ...provider.track, coverSource: 'https://p2.music.126.net/raw.jpg' }
          }
        ]
      })
    ),
    false
  )
  const queue = { id: 'queue', revision: 3 }
  assert.equal(
    isCoreRequest(request('queue.locate', { ...queue, occurrenceId: 'entry' }, 'query')),
    true
  )
  assert.equal(
    isCoreRequest(
      request('queue.insert', {
        ...queue,
        items: [
          { kind: 'occurrence', queueId: queue.id, revision: queue.revision, occurrenceId: 'entry' }
        ]
      })
    ),
    true
  )
  const add = { id: 'playlist', revision: 2, queue, occurrenceIds: ['entry'] }
  assert.equal(isCoreRequest(request('playlists.addQueueEntries', add)), true)
  assert.equal(
    isCoreRequest(
      request('playlists.addQueueEntries', { ...add, occurrenceIds: Array(201).fill('entry') })
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('playlists.saveQueue', { name: 'Saved', revision: 2, queue })),
    true
  )
})

test('recent library resolution accepts bounded CUE hints and rejects malformed or oversized identities', () => {
  const base = {
    entries: [
      {
        id: 'history:1',
        sourceIds: ['ncm:1'],
        snapshot: {
          id: 'local:cue:2',
          title: 'Track two',
          artist: 'Artist',
          source: 'local',
          filePath: 'D:/Music/disc.flac',
          duration: 30,
          subTrack: '2',
          cueRange: { startSeconds: 30, endSeconds: 60, pregapSeconds: 0 }
        }
      }
    ],
    revision: 4,
    versionsRevision: 9
  }
  assert.equal(isCoreRequest(request('library.recent.resolve', base, 'query')), true)
  assert.equal(coreOperation('library.recent.resolve')?.permission, 'library:read')
  assert.equal(
    isCoreRequest(
      request(
        'library.recent.resolve',
        {
          ...base,
          entries: [
            {
              ...base.entries[0],
              snapshot: {
                ...base.entries[0].snapshot,
                cueRange: { startSeconds: 30, endSeconds: 30, pregapSeconds: 0 }
              }
            }
          ]
        },
        'query'
      )
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'library.recent.resolve',
        {
          ...base,
          entries: [
            {
              ...base.entries[0],
              snapshot: { ...base.entries[0].snapshot, mediaUrl: 'https://example.test/audio' }
            }
          ]
        },
        'query'
      )
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'library.recent.resolve',
        {
          ...base,
          entries: [{ ...base.entries[0], sourceIds: Array(201).fill('ncm:1') }]
        },
        'query'
      )
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'library.recent.resolve',
        {
          ...base,
          entries: Array.from({ length: 3 }, (_, index) => ({
            id: `history:${index}`,
            snapshot: { id: `local:${index}`, title: 't'.repeat(32768), artist: 'a' }
          }))
        },
        'query'
      )
    ),
    false
  )
})

test('cloud transfers and model installation expose bounded commands, never file paths or native processes', () => {
  for (const name of ['ncm.cloud.chooseUploadFiles', 'automix.install.cancel']) {
    assert.equal(isCoreRequest(request(name, {})), true)
    assert.equal(isCoreRequest(request(name, { path: 'D:/private' })), false)
  }
  assert.equal(isCoreRequest(request('automix.install.start', { enableAfterInstall: true })), true)
  assert.equal(isCoreRequest(request('automix.install.start', { enableAfterInstall: false })), true)
  assert.equal(isCoreRequest(request('automix.install.start', {})), false)
  assert.equal(isCoreRequest(request('ncm.cloud.upload', { handle: 'picked' })), true)
  assert.equal(
    isCoreRequest(request('ncm.cloud.download', { cloudSongId: 'cloud:1', fileName: 'song.flac' })),
    true
  )
  assert.equal(
    isCoreRequest(
      request('ncm.cloud.download', {
        cloudSongId: 1,
        fileName: 'song.flac',
        url: 'https://private'
      })
    ),
    false
  )
  assert.equal(isCoreRequest(request('ncm.cloud.page', { revision: 3, limit: 200 }, 'query')), true)
  assert.equal(
    isCoreRequest(request('ncm.cloud.page', { revision: 3, limit: 201 }, 'query')),
    false
  )
})

test('settings restore retains the old byte bound and revision while accepting serialized backup JSON', () => {
  assert.equal(isCoreRequest(request('settings.backup', {}, 'query')), true)
  assert.equal(
    isCoreRequest(request('settings.restore', { revision: 0, json: '{"theme":"dark"}' })),
    true
  )
  assert.equal(isCoreRequest(request('settings.restore', { json: '{}' })), false)
  assert.equal(
    isCoreRequest(
      request('settings.restore', { revision: 0, json: 'a'.repeat(2 * 1024 * 1024 + 1) })
    ),
    false
  )
})

test('inbox decisions use Core issue indexes and a revision fence; pages and mutations are bounded', () => {
  const view = { id: 'inbox', revision: 1 }
  assert.equal(
    isCoreRequest(request('library.inbox.refresh', { duplicatesId: 'inspection' })),
    true
  )
  assert.equal(isCoreRequest(request('library.inbox.page', { ...view, limit: 200 }, 'query')), true)
  assert.equal(
    isCoreRequest(request('library.inbox.page', { ...view, limit: 201 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('library.inbox.mark', { ...view, indexes: [0], status: 'done' })),
    true
  )
  assert.equal(
    isCoreRequest(request('library.inbox.mark', { id: 'inbox', indexes: [0], status: 'done' })),
    false
  )
  assert.equal(
    isCoreRequest(
      request('library.inbox.mark', { ...view, indexes: Array(129).fill(0), status: 'done' })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('library.inbox.mark', {
        ...view,
        indexes: [0],
        status: 'done',
        fingerprint: 'renderer value'
      })
    ),
    false
  )
})

test('Core analysis takes revision-fenced records and SQL selections, never arbitrary file paths or groups', () => {
  assert.equal(
    isCoreRequest(request('analysis.request', { kind: 'bpm', id: 'one', version: 1 })),
    true
  )
  assert.equal(
    isCoreRequest(
      request('analysis.request', {
        kind: 'bpm',
        id: 'one',
        version: 1,
        filePath: 'D:/private.wav'
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('analysis.request', { kind: 'bpm', id: 'one', version: -1 })),
    false
  )
  const selection = { query: { contentRevision: 4 }, total: 20, ranges: [[0, 20]] }
  assert.equal(
    isCoreRequest(request('library.loudness.prepare', { mode: 'album', selection })),
    true
  )
  assert.equal(
    isCoreRequest(request('library.loudness.prepare', { mode: 'album', groups: [] })),
    false
  )
  assert.equal(
    isCoreRequest(request('library.loudness.page', { id: 'plan', limit: 200 }, 'query')),
    true
  )
  assert.equal(
    isCoreRequest(request('library.loudness.page', { id: 'plan', limit: 201 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('library.loudness.result', { id: 'plan', index: -1 }, 'query')),
    false
  )
})

test('personal backup accepts a Core preview identity and restore choices, never renderer-owned data or file paths', () => {
  for (const name of ['backup.export', 'backup.preview', 'backup.recover', 'backup.chooseFolder']) {
    assert.equal(isCoreRequest(request(name, {})), true)
    assert.equal(isCoreRequest(request(name, { statistics: {} })), false)
    assert.equal(isCoreRequest(request(name, { path: 'D:/backup.json' })), false)
  }
  const options = { domains: ['statistics', 'versions'], conflict: 'keep-local', mappings: [] }
  assert.equal(isCoreRequest(request('backup.stage', { id: 'preview', options })), true)
  assert.equal(isCoreRequest(request('backup.stage', { options })), false)
  assert.equal(
    isCoreRequest(
      request('backup.stage', { id: 'preview', options: { ...options, domains: ['settings'] } })
    ),
    false
  )
  assert.equal(isCoreRequest(request('backup.stage', { id: 'preview', options, data: {} })), false)
  assert.equal(isCoreRequest(request('backup.export', { domains: ['music', 'versions'] })), true)
  for (const domains of [[], ['music', 'music'], ['unknown']])
    assert.equal(isCoreRequest(request('backup.export', { domains })), false)
  assert.equal(
    isCoreRequest(
      request('backup.repreview', { id: 'preview', options: { ...options, domains: ['music'] } })
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('backup.repreview', { id: 'preview', options, data: {} })),
    false
  )
  assert.equal(
    isCoreRequest(
      request('backup.stage', {
        id: 'preview',
        options: { ...options, domains: ['music', 'music'] }
      })
    ),
    false
  )
  for (const name of [
    'musicBackupExport',
    'musicBackupRestore',
    'musicBackupRevision',
    'musicBackupPreview'
  ])
    assert.equal(isCoreRequest(request(name, {})), false)
})

test('duplicate inspection exposes finite task and bounded result pages, never caller-supplied candidates or hash paths', () => {
  assert.equal(isCoreRequest(request('library.duplicates.start', {})), true)
  assert.equal(
    isCoreRequest(request('library.duplicates.start', { filePaths: ['private.wav'] })),
    false
  )
  assert.equal(isCoreRequest(request('library.duplicates.cancel', { id: 'inspection' })), true)
  assert.equal(isCoreRequest(request('library.duplicates.status', {}, 'query')), true)
  assert.equal(
    isCoreRequest(request('library.duplicates.groups', { id: 'inspection', limit: 200 }, 'query')),
    true
  )
  assert.equal(
    isCoreRequest(
      request('library.duplicates.items', { id: 'inspection', group: 0, offset: 200 }, 'query')
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('library.duplicates.items', { id: 'inspection' }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('library.duplicates.groups', { id: 'inspection', group: 0 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(
      request('library.duplicates.unavailable', { id: 'inspection', limit: 201 }, 'query')
    ),
    false
  )
})

test('library maintenance accepts frozen selections and bounded patches, never arbitrary file-write paths', () => {
  assert.equal(
    isCoreRequest(request('playlists.repair', { id: 'playlist', revision: 1, folder: 'E:/Moved' })),
    true
  )
  assert.equal(
    isCoreRequest(
      request('playlists.repair', { id: 'playlist', revision: 1, folder: 'E:/Moved', missing: [] })
    ),
    false
  )
  assert.equal(isCoreRequest(request('playlists.repair.status', {}, 'query')), true)
  assert.equal(
    isCoreRequest(
      request('library.selection.open', {
        query: { contentRevision: 1, sort: 'title' },
        total: 5,
        ranges: [[0, 5]]
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('library.selection.open', { query: { sort: 'title' }, total: 5, ranges: [[0, 5]] })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('library.selection.open', {
        query: { contentRevision: 1, offset: 0 },
        total: 5,
        ranges: [[0, 5]]
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('library.remove', { selectionId: 'frozen', mode: 'trash' })),
    true
  )
  assert.equal(
    isCoreRequest(
      request('library.remove', { items: [{ filePath: 'D:/other.wav' }], mode: 'trash' })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('library.tags.write', { selectionId: 'frozen', patch: { title: 'Title', track: 2 } })
    ),
    true
  )
  for (const patch of [
    { filePath: 'other.wav', title: 'Title' },
    { title: 'x'.repeat(1025) },
    { year: 0 },
    { coverBase64: 'not base64' },
    {}
  ])
    assert.equal(
      isCoreRequest(request('library.tags.write', { selectionId: 'frozen', patch })),
      false
    )
  assert.equal(isCoreRequest(request('library.tags.restore', { fromJournal: true })), true)
  assert.equal(
    isCoreRequest(request('library.tags.restore', { fromJournal: true, selectionId: 'mixed' })),
    false
  )
  assert.equal(isCoreRequest(request('library.reset', {})), false)
  assert.equal(coreOperation('library.tags.write')?.permission, 'library:write')
})

test('AutoMix exposes bounded capability queries; process launches remain fixed private operations', () => {
  assert.equal(coreOperation('automix.capabilities')?.permission, 'settings:read')
  assert.equal(isCoreRequest(request('automix.capabilities', {}, 'query')), true)
  assert.equal(isCoreRequest(request('automix.capabilities', { refresh: true }, 'query')), true)
  assert.equal(
    isCoreRequest(request('automix.capabilities', { path: 'other/python.exe' }, 'query')),
    false
  )
  assert.equal(isCoreRequest(request('automix.runWorker', {})), false)
  const valid = (name: string, payload: unknown) =>
    validCorePlatformPayload({
      kind: 'core:platform',
      epoch: 'core',
      requestId: 'automix',
      name,
      payload
    } as CorePlatformRequest)
  assert.equal(valid('automix.environment', {}), true)
  assert.equal(valid('automix.probe', { packDirectory: 'D:/pack' }), true)
  const job = { packDirectory: 'D:/pack', requestPath: 'D:/ticket/request.json', budgetMs: 90000 }
  assert.equal(valid('automix.runWorker', job), true)
  assert.equal(valid('automix.runWorker', { ...job, budgetMs: 90001 }), false)
  assert.equal(valid('automix.runWorker', { ...job, script: 'arbitrary.py' }), false)
  assert.equal(valid('automix.runWorker', { ...job, env: {} }), false)
})

test('settings commands are revision-fenced and cannot bypass native configuration transactions', () => {
  assert.equal(coreOperation('settings.state')?.permission, 'settings:read')
  assert.equal(coreOperation('settings.edit')?.permission, 'settings:write')
  assert.equal(isCoreRequest(request('settings.state', {}, 'query')), true)
  assert.equal(
    isCoreRequest(request('settings.edit', { revision: 0, patch: { watchLibrary: false } })),
    true
  )
  for (const patch of [
    { audioDevice: 'DAC' },
    { softwareVolume: 1 },
    { audioProcessing: {} },
    { audioEqAutoPreamp: { enabled: true, manualDb: 0 } }
  ])
    assert.equal(isCoreRequest(request('settings.edit', { revision: 0, patch })), false)
  assert.equal(isCoreRequest(request('settings.edit', { patch: {} })), false)
  assert.equal(isCoreRequest(request('settings.edit', { revision: -1, patch: {} })), false)
  assert.equal(
    isCoreRequest(
      request('settings.edit', { revision: 0, patch: { fontFamily: 'x'.repeat(512 * 1024) } })
    ),
    false
  )
  const platform = (payload: unknown) =>
    validCorePlatformPayload({
      kind: 'core:platform',
      name: 'settings.authorizePaths',
      epoch: 'core',
      requestId: 'paths',
      payload
    } as CorePlatformRequest)
  assert.equal(platform({ libraryFolders: [], downloadFolder: '' }), true)
  assert.equal(platform({ libraryFolders: ['D:/Music'] }), true)
  assert.equal(platform({ libraryFolders: ['D:/Music\0evil'] }), false)
  assert.equal(platform({ audioProcessing: { convolverIrPath: 'arbitrary' } }), false)
})

test('automatic EQ preamp and headphone compensation are revision-fenced DSP commands, not generic preference writes', () => {
  assert.equal(
    isCoreRequest(
      request('audio.dsp.edit', { revision: 3, edit: { kind: 'autoPreamp', enabled: true } })
    ),
    true
  )
  for (const edit of [
    { kind: 'autoPreamp', enabled: 1 },
    { kind: 'autoPreamp', enabled: true, manualDb: 10 }
  ])
    assert.equal(isCoreRequest(request('audio.dsp.edit', { revision: 3, edit })), false)
  assert.equal(
    isCoreRequest(
      request('audio.dsp.edit', {
        revision: 3,
        edit: {
          kind: 'headphoneCompensation',
          settings: { enabled: false, preampDb: -2, bands: [] }
        }
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('audio.dsp.edit', {
        revision: 3,
        edit: { kind: 'headphoneCompensation', settings: null }
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('audio.dsp.edit', {
        revision: 3,
        edit: { kind: 'headphoneCompensation', enabled: false }
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('settings.edit', {
        revision: 3,
        patch: { headphoneCompensation: { enabled: false } }
      })
    ),
    false
  )
})

test('sleep timers use Core deadlines and revisions, never client EOF/clock/fade ownership', () => {
  assert.equal(coreOperation('sleep.configure')?.permission, 'playback:write')
  assert.equal(isCoreRequest(request('sleep.state', {}, 'query')), true)
  assert.equal(
    isCoreRequest(request('sleep.configure', { revision: 2, mode: 'minutes', minutes: 30 })),
    true
  )
  assert.equal(isCoreRequest(request('sleep.configure', { revision: 2, mode: 'trackEnd' })), true)
  for (const payload of [
    { revision: 2, mode: 'minutes', endsAt: 100 },
    { revision: 2, mode: 'minutes', minutes: 0 },
    { revision: 2, mode: 'minutes', minutes: 721 },
    { revision: 2, mode: 'trackEnd', fadeSeconds: 0 },
    { mode: 'trackEnd' }
  ])
    assert.equal(isCoreRequest(request('sleep.configure', payload)), false)
  assert.equal(isCoreRequest(request('sleep.cancel', { revision: 2 })), true)
  assert.equal(isCoreRequest(request('sleep.boundary', { boundary: 'trackEnd' })), false)
})

test('watcher status is a finite library-read query, never a caller-selected path or factory', () => {
  assert.equal(coreOperation('scan.watchers')?.permission, 'library:read')
  assert.equal(isCoreRequest(request('scan.watchers', {}, 'query')), true)
  assert.equal(isCoreRequest(request('scan.watchers', { path: 'D:/Music' }, 'query')), false)
  assert.equal(isCoreRequest(request('scan.watchers', {}, 'command')), false)
})

test('metadata edits use authority-owned candidates and record versions, never renderer tracks or patches', () => {
  assert.equal(
    isCoreRequest(request('metadata.candidates', { id: 'local:one', version: 3 }, 'query')),
    true
  )
  assert.equal(isCoreRequest(request('metadata.apply', { token: 'candidate:1', index: 0 })), true)
  assert.equal(
    isCoreRequest(request('metadata.apply', { token: 'candidate:1', index: 100 })),
    false
  )
  assert.equal(
    isCoreRequest(request('metadata.apply', { token: 'candidate:1', index: 0, track: {} })),
    false
  )
  assert.equal(isCoreRequest(request('metadata.clear', { id: 'local:one', version: -1 })), false)
  assert.equal(isCoreRequest(request('metadata.start', { paths: ['D:/Music'] })), false)
  assert.equal(coreOperation('metadata.apply')?.permission, 'library:write')
  assert.equal(coreOperation('metadata.candidates')?.permission, 'library:read')
})

test('Cast exposes discovered identities and paged views, not endpoints, sources or arbitrary backend methods', () => {
  const start = {
    revision: 3,
    deviceId: 'discovered',
    queue: { id: 'queue', revision: 7, occurrenceId: 'duplicate:2' }
  }
  assert.equal(isCoreRequest(request('cast.start', start)), true)
  assert.equal(
    isCoreRequest(request('cast.start', { ...start, source: 'D:/Music/one.flac' })),
    false
  )
  assert.equal(
    isCoreRequest(request('cast.start', { ...start, endpoint: 'http://127.0.0.1/control' })),
    false
  )
  assert.equal(
    isCoreRequest(request('cast.start', { ...start, queue: { ...start.queue, revision: -1 } })),
    false
  )
  assert.equal(
    isCoreRequest(request('cast.start', { ...start, queue: { id: 'queue', revision: 7 } })),
    false
  )
  assert.equal(isCoreRequest(request('cast.end', { revision: 3 })), true)
  assert.equal(isCoreRequest(request('cast.discover', {})), true)
  assert.equal(isCoreRequest(request('cast.devices', { offset: 0, limit: 100 }, 'query')), true)
  assert.equal(isCoreRequest(request('cast.devices', { offset: 0, limit: 101 }, 'query')), false)
  assert.equal(isCoreRequest(request('cast.invoke', { method: 'load' })), false)
  assert.equal(coreOperation('cast.start')?.permission, 'playback:write')
  const platform = (name: string, payload: object) =>
    validCorePlatformPayload({
      kind: 'core:platform',
      epoch: 'core',
      requestId: 'stop',
      name,
      payload
    } as CorePlatformRequest)
  assert.equal(
    platform('cast.arm', {
      target: { deviceId: 'one', protocol: 'dlna', controlUrl: 'http://127.0.0.1/control' }
    }),
    true
  )
  assert.equal(
    platform('cast.arm', {
      target: {
        deviceId: 'one',
        protocol: 'chromecast',
        host: '127.0.0.1',
        port: 8009,
        receiverSessionId: 'exact-session'
      }
    }),
    true
  )
  assert.equal(
    platform('cast.arm', {
      target: { deviceId: 'one', protocol: 'chromecast', host: '127.0.0.1', port: 8009 }
    }),
    false
  )
  assert.equal(platform('cast.disarm', { deviceId: 'one' }), true)
  assert.equal(isCoreRequest(request('cast.arm', { target: {} })), false)
})

test('DSP domains use revision-fenced edits and platform-owned file selection, with paged catalogs', () => {
  assert.equal(
    isCoreRequest(
      request('audio.dsp.edit', {
        revision: 2,
        edit: { kind: 'processing', settings: { eqPreamp: -3 } }
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('audio.dsp.edit', { revision: 2, edit: { kind: 'invoke', method: 'Play' } })
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('audio.dsp.import', { revision: 2, kind: 'correctionProfile' })),
    true
  )
  assert.equal(
    isCoreRequest(
      request('audio.dsp.import', {
        revision: 2,
        kind: 'correctionProfile',
        path: 'C:/private.apo'
      })
    ),
    false
  )
  assert.equal(isCoreRequest(request('audio.vst3', { limit: 201 }, 'query')), false)
  assert.equal(
    isCoreRequest(
      request(
        'audio.vst3.parameters',
        { id: 'vst3:fixture', revision: 3, offset: 200, limit: 200 },
        'query'
      )
    ),
    true
  )
  assert.equal(coreOperation('audio.dsp')?.permission, 'settings:read')
  assert.equal(coreOperation('audio.dsp.edit')?.permission, 'settings:write')
  assert.equal(coreOperation('audio.vst3.edit')?.permission, 'settings:write')
})

test('Core output API accepts only finite edits with a revision', () => {
  for (const edit of [
    { kind: 'backend', output: 'wasapi' },
    { kind: 'device', device: 'dac-id' },
    { kind: 'exclusive', enabled: false },
    { kind: 'autoRelease', enabled: true },
    { kind: 'config', config: { routingMode: 'mono-to-stereo', preferredBufferSize: 512 } },
    {
      kind: 'config',
      config: {
        playbackPolicy: 'continuity-first',
        continuitySampleRate: 96000,
        asioOutputChannelStart: 12
      }
    }
  ])
    assert.equal(isCoreRequest(request('audio.output.edit', { revision: 2, edit })), true)
  for (const payload of [
    { edit: { kind: 'device', device: 'a' } },
    { revision: -1, edit: { kind: 'device', device: 'a' } },
    { revision: 0, edit: { kind: 'method', method: 'Play' } },
    { revision: 0, edit: { kind: 'config', config: { source: 'arbitrary.wav' } } },
    { revision: 0, edit: { kind: 'config', config: { preferredBufferSize: Infinity } } },
    { revision: 0, edit: { kind: 'exclusive', enabled: 1 } }
  ])
    assert.equal(isCoreRequest(request('audio.output.edit', payload)), false)
  assert.equal(isCoreRequest(request('audio.output', {}, 'query')), true)
  assert.equal(
    isCoreRequest(
      request('audio.profiles.edit', { revision: 0, edit: { kind: 'remove', id: 'desk' } })
    ),
    true
  )
  assert.equal(isCoreRequest(request('audio.output', { method: 'Stop' }, 'query')), false)
})

test('Core song search accepts bounded query pages and revision fences, not caller-owned source lists', () => {
  assert.equal(
    isCoreRequest(
      request(
        'search.songs',
        {
          query: 'Moon',
          limit: 100,
          offset: 200,
          contentRevision: 5,
          versionsRevision: 3,
          networkRevision: 7
        },
        'query'
      )
    ),
    true
  )
  assert.equal(isCoreRequest(request('search.songs', { query: '', scope: 'local' }, 'query')), true)
  for (const payload of [
    { query: 'Moon', limit: 101 },
    { query: 'Moon', offset: -1 },
    { query: 'Moon', versionsRevision: 1.2 },
    { query: 'Moon', scope: 'plugin' },
    { query: 'Moon', providers: ['private'] },
    { query: 'Moon', localTracks: [] },
    { query: 'Moon', playbackQuery: { search: 'other' } },
    { query: 'x'.repeat(4097) }
  ])
    assert.equal(isCoreRequest(request('search.songs', payload, 'query')), false)
})

test('Core collection search selects a known domain and source, never an arbitrary provider method', () => {
  assert.equal(
    isCoreRequest(
      request(
        'search.collections',
        { kind: 'albums', query: 'Moon', scope: 'local', contentRevision: 5, limit: 100 },
        'query'
      )
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request(
        'search.collections',
        { kind: 'artists', query: 'Artist', providerId: 'fixture' },
        'query'
      )
    ),
    true
  )
  for (const payload of [
    { kind: 'unknown', query: 'Moon' },
    { kind: 'albums', query: 'Moon', method: 'getProfile' },
    { kind: 'albums', query: 'Moon', providerId: 'fixture', scope: 'local' },
    { kind: 'playlists', query: 'Moon', limit: 101 },
    { kind: 'albums', query: 'Moon', playlistsRevision: -1 }
  ])
    assert.equal(isCoreRequest(request('search.collections', payload, 'query')), false)
})

test('Core downloads expose bounded pages and task identities, never raw provider jobs or file delivery URLs', () => {
  assert.equal(
    isCoreRequest(
      request('downloads.create', {
        providerId: 'fixture',
        track: { id: 'one', title: 'Song', artist: 'Artist' },
        quality: 'lossless'
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('downloads.create', {
        providerId: 'fixture',
        track: { id: 'one', title: 'Song', artist: 'Artist', blob: 'x'.repeat(65536) },
        quality: 'lossless'
      })
    ),
    false
  )
  assert.equal(isCoreRequest(request('downloads.page', { revision: 0, limit: 200 }, 'query')), true)
  assert.equal(
    isCoreRequest(request('downloads.page', { revision: 0, limit: 201 }, 'query')),
    false
  )
  assert.equal(isCoreRequest(request('downloads.result', { id: 'one', addToLibrary: true })), true)
  assert.equal(
    isCoreRequest(
      request('downloads.result', { id: 'one', addToLibrary: true, path: '/private.wav' })
    ),
    false
  )
  assert.equal(isCoreRequest(request('downloads.cancel', { providerJobId: 'job' })), false)
  assert.equal(isCoreRequest(request('downloads.play', { id: 'one', play: false })), true)
  assert.equal(
    isCoreRequest(request('downloads.play', { id: 'one', url: 'http://127.0.0.1/file' })),
    false
  )
})

test('Core network commands accept source identities and bounded pages, never arbitrary plans or methods', () => {
  assert.equal(
    isCoreRequest(
      request('network.play', { revision: 1, profileId: 'nas', entryId: 'one', play: false })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('network.play', {
        revision: 1,
        profileId: 'nas',
        entryId: 'one',
        url: 'https://private.test/a'
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'network.directory',
        { revision: 1, profileId: 'nas', path: '/', limit: 201 },
        'query'
      )
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('network.profiles.edit', {
        revision: 1,
        kind: 'update',
        id: 'nas',
        patch: { auth: { kind: 'password', password: 'new' } }
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('network.profiles.edit', {
        revision: 1,
        kind: 'update',
        id: 'nas',
        patch: { credential: { encryptedId: 'arbitrary' } }
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('network.job', { revision: 1, kind: 'enrich', profileId: 'nas' })),
    true
  )
  assert.equal(
    isCoreRequest(request('network.invoke', { method: 'resolvePlayback', args: [] })),
    false
  )
})

test('Core streams expose bounded identity commands and focused edits, not source/progress document writes', () => {
  assert.equal(
    isCoreRequest(
      request('radio.edit', {
        revision: 1,
        edit: { kind: 'add', name: 'Jazz', streamUrl: 'https://example.test/live' }
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('radio.edit', {
        revision: 1,
        edit: { kind: 'add', name: 'Jazz', streamUrl: 'file:///secret' }
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('podcasts.subscribe', { revision: 1, feedUrl: 'https://example.test/feed' })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('podcasts.edit', { revision: 1, edit: { kind: 'progress', id: 'one', seconds: 3 } })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('streams.play', {
        revision: 1,
        kind: 'podcast',
        id: 'one',
        guid: 'urn:episode:one',
        resume: true,
        play: false
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('streams.play', {
        revision: 1,
        kind: 'podcast',
        id: 'one',
        guid: 'one',
        mediaUrl: 'https://evil.test/one'
      })
    ),
    false
  )
  assert.equal(isCoreRequest(request('podcasts.defaultRate', { revision: 1, rate: 1.5 })), true)
  assert.equal(isCoreRequest(request('podcasts.defaultRate', { revision: 1, rate: 3 })), false)
  assert.equal(
    isCoreRequest(request('podcasts.episodes', { revision: 1, id: 'one', limit: 201 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(request('radio.directory', { query: 'Jazz', limit: 51 }, 'query')),
    false
  )
})

test('Core lyric commands expose bounded focused edits and current-track lookups, never paths or whole documents', () => {
  assert.equal(
    isCoreRequest(
      request('lyrics.edit', {
        revision: 2,
        edit: {
          kind: 'track',
          trackId: 'song',
          patch: {
            originalSelection: 'manual',
            original: '[00:01]Edited',
            offsetMs: -100
          }
        }
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('lyrics.search', { trackId: 'song', occurrenceId: 'one' }, 'query')),
    true
  )
  assert.equal(
    isCoreRequest(
      request(
        'lyrics.search',
        { trackId: 'song', occurrenceId: 'one', title: 'arbitrary' },
        'query'
      )
    ),
    false
  )
  assert.equal(isCoreRequest(request('lyrics.importDraft', { path: 'D:/private.lrc' })), false)
  assert.equal(
    isCoreRequest(
      request('lyrics.exportDraft', { contents: '[00:01]Draft', path: 'D:/private.lrc' })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('lyrics.edit', {
        revision: 2,
        edit: { kind: 'track', trackId: 'song', patch: { original: '中'.repeat(350000) } }
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('lyrics.edit', {
        revision: 2,
        edit: { kind: 'track', trackId: 'song', patch: { source: 'file', path: 'D:/private.lrc' } }
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('lyrics.edit', {
        revision: 2,
        edit: { kind: 'visibility', patch: { showOriginal: true, tracks: {} } }
      })
    ),
    false
  )
})

test('Core workspace uses authoritative capture and bounded revision-fenced pages', () => {
  const longOccurrence = `queue:D:/Music/${'folder/'.repeat(40)}one.flac:0`
  assert.equal(
    isCoreRequest(
      request('queue.select', { id: 'q', revision: 1, index: 0, occurrenceId: longOccurrence })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('queue.edit', {
        id: 'q',
        revision: 1,
        edit: { kind: 'remove', entryIds: [longOccurrence] }
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('queue.select', { id: 'q', revision: 1, index: 0, occurrenceId: 'x'.repeat(8193) })
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('workspace.restore', { revision: 1, id: 'named', play: false })),
    true
  )
  for (const payload of [
    { id: 'named' },
    { revision: 1, id: 'named', entries: [] },
    { revision: 1, id: 'named', libraryQueue: { id: 'arbitrary' } }
  ])
    assert.equal(isCoreRequest(request('workspace.restore', payload)), false)
  assert.equal(
    isCoreRequest(
      request('workspace.edit', { revision: 1, edit: { kind: 'saveCurrent', name: 'Work' } })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('workspace.edit', {
        revision: 1,
        edit: { kind: 'saveCurrent', name: 'Work', position: 30, entries: [] }
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('workspace.edit', { revision: 1, edit: { kind: 'record', track: { id: 'fake' } } })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'workspace.history',
        { revision: 1, contentRevision: 2, offset: 0, limit: 200 },
        'query'
      )
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('workspace.history', { revision: 1, limit: 201 }, 'query')),
    false
  )
})

test('Core validates each domain payload before dispatch, including nested query and edit variants', () => {
  const valid = [
    request('versions.edit', {
      revision: 1,
      scope: 'tracks',
      operation: 'sources',
      keys: ['local:a', 'ncm:7'],
      label: 'Master'
    }),
    request(
      'versions.page',
      { revision: 1, scope: 'albums', kind: 'families', offset: 0, limit: 128 },
      'query'
    ),
    request(
      'playlists.view',
      { id: 'p', revision: 1, versionsRevision: 1, variantRow: '0', limit: 200 },
      'query'
    ),
    request('statistics.summary', {}, 'query'),
    request(
      'statistics.tracks',
      { sort: 'seconds', offset: 128, limit: 128, revision: 2 },
      'query'
    ),
    request('statistics.clear', { range: null, revision: 0 }),
    request('statistics.clear', {
      range: { startDay: '2024-02-29', endDay: '2026-10-22' },
      revision: 3
    }),
    request('playback.play', { position: 0 }),
    request('playback.pause', {}),
    request('queue.fromQuery', {
      query: { ids: ['one', 'one'], sort: 'playlist', contentRevision: 12 },
      play: false
    }),
    request('queue.edit', {
      id: 'queue',
      revision: 1,
      edit: { kind: 'move', entryId: 'first', beforeEntryId: null }
    }),
    request('queue.select', { id: 'queue', revision: 1, index: 0, occurrenceId: 'first' }),
    request('queue.page', { id: 'queue', revision: 1, offset: 0, limit: 200 }, 'query'),
    request('migration.begin', {
      id: 'import',
      manifest: { version: 1, counts: emptyCoreStateCounts() }
    }),
    request('migration.stage', {
      id: 'import',
      batch: 0,
      domain: 'inbox',
      rows: [{ key: 'one', value: { status: 'done', fingerprint: 'old' } }]
    }),
    request(
      'library.tracks',
      {
        playlistView: 'all',
        aggregate: { hiddenSources: ['ncm'], variantPreferences: { one: 'local' } },
        sort: 'playlist'
      },
      'query'
    )
  ]
  for (const value of valid) assert.equal(isCoreRequest(value), true, JSON.stringify(value))
  const invalid = [
    request('versions.edit', {
      revision: 1,
      scope: 'tracks',
      operation: 'eval',
      keys: ['a'],
      label: ''
    }),
    request('versions.edit', {
      revision: 1,
      scope: 'tracks',
      operation: 'sources',
      keys: [],
      label: ''
    }),
    request(
      'versions.page',
      { revision: 1, scope: 'tracks', kind: 'versions', limit: 129 },
      'query'
    ),
    request(
      'playlists.view',
      { id: 'p', revision: 1, versionsRevision: 1, variantRow: '-1' },
      'query'
    ),
    request(
      'playlists.view',
      { id: 'p', revision: 1, versionsRevision: 1, variantRow: '0', sourceCounts: true },
      'query'
    ),
    request('statistics.tracks', { limit: 129 }, 'query'),
    request('statistics.tracks', { sort: 'eval' }, 'query'),
    request('statistics.clear', {
      range: { startDay: '2026-02-29', endDay: '2026-03-01' },
      revision: 0
    }),
    request('statistics.clear', { range: [], revision: 0 }),
    request('statistics.clear', { range: null }),
    request('statistics.clear', {
      range: { startDay: '2026-10-22', endDay: '2026-10-21' },
      revision: 0
    }),
    request('arbitrary.method', {}),
    request('playback.pause', { source: '/tmp/malicious' }),
    request('playback.play', { position: NaN }),
    request('playback.volume', { volume: 2 }),
    request('queue.select', { id: 'queue', revision: -1, index: 0, occurrenceId: 'first' }),
    request('queue.select', { id: 'queue', revision: 1, index: '0', occurrenceId: 'first' }),
    request('queue.edit', { id: 'queue', revision: 1, edit: { kind: 'eval', code: 'anything' } }),
    request('queue.edit', {
      id: 'queue',
      revision: 1,
      edit: { kind: 'insert', trackIds: ['one'], items: [] }
    }),
    request('queue.edit', { id: 'queue', revision: 1, edit: { kind: 'move', entryId: 'first' } }),
    request('queue.fromQuery', { query: { limit: 1001 }, play: true }),
    request('queue.fromQuery', { query: { filters: { sampleRate: 0 } } }),
    request('queue.fromQuery', { query: { filters: { method: 'spawn' } } }),
    request('queue.fromQuery', { query: { unknown: 'ignored?' } }),
    request('migration.stage', { id: 'import', batch: 0, domain: 'credentials', rows: [] }),
    request('migration.stage', {
      id: 'import',
      batch: 0,
      domain: 'inbox',
      rows: [
        { key: 'same', value: 1 },
        { key: 'same', value: 2 }
      ]
    }),
    request('migration.begin', { id: 'import', manifest: { version: 1, counts: {} } }),
    request('state.snapshot', {}, 'command'),
    { ...request('playback.pause', {}), identity: 'trusted' }
  ]
  for (const value of invalid) assert.equal(isCoreRequest(value), false, JSON.stringify(value))
})

test('Core JSON budgets reject cycles, deep objects, binary/prototype values and oversized UTF-8 before retention', () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  let deep: unknown = null
  for (let i = 0; i < 40; i++) deep = { child: deep }
  for (const value of [
    cycle,
    deep,
    new Uint8Array(3),
    new Map(),
    new Date(),
    { n: Infinity },
    { f: () => {} },
    [undefined]
  ])
    assert.equal(isBoundedCoreJson(value, 1024), false)
  assert.equal(isBoundedCoreJson({ text: '汉'.repeat(100) }, 100), false)
  assert.equal(isBoundedCoreJson({ text: '汉'.repeat(10), optional: undefined }, 100), true)
  assert.equal(
    isBoundedCoreJson(
      {
        get secret() {
          throw new Error('Must not invoke accessors')
        }
      },
      100
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('migration.stage', {
        id: 'import',
        batch: 0,
        domain: 'inbox',
        rows: [{ key: 'big', value: 'x'.repeat(5 * 1024 * 1024) }]
      })
    ),
    false
  )
})

test('Core import previews accept only bounded domain operations, not paths, bridges or leaked credentials', () => {
  assert.equal(
    isCoreRequest(
      request('imports.previewStart', {
        link: 'https://music.163.com/playlist?id=7',
        credentials: { accessToken: 'temporary', country: 'US' }
      })
    ),
    true
  )
  assert.equal(isCoreRequest(request('imports.previewFile', {})), true)
  assert.equal(
    isCoreRequest(request('imports.previewFile', { path: 'C:/private/list.m3u' })),
    false
  )
  assert.equal(
    isCoreRequest(
      request('imports.previewStart', { link: 'x', credentials: { accessToken: 'bad\r\ntoken' } })
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('imports.previewStart', { link: 'x', credentials: { password: 'bad' } })),
    false
  )
  assert.equal(
    isCoreRequest(request('imports.previewPage', { id: 'p', revision: 1, limit: 201 }, 'query')),
    false
  )
  assert.equal(
    isCoreRequest(
      request(
        'imports.previewChoices',
        { id: 'p', revision: 1, kind: 'columns', offset: 200, limit: 200 },
        'query'
      )
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('imports.previewConfigure', {
        id: 'p',
        revision: 1,
        columns: { title: 0, location: 2 }
      })
    ),
    true
  )
  assert.equal(
    isCoreRequest(
      request('imports.previewConfigure', { id: 'p', revision: 1, columns: { title: -1 } })
    ),
    false
  )
  assert.equal(
    isCoreRequest(
      request('imports.previewSave', {
        id: 'p',
        revision: 1,
        playlistsRevision: 2,
        target: { id: 'old', generation: 'before' }
      })
    ),
    true
  )
})

test('network cache clearing is a finite write operation, never an arbitrary filesystem command', () => {
  assert.equal(isCoreRequest(request('network.clearCache', {})), true)
  assert.equal(isCoreRequest(request('network.clearCache', { path: 'D:/Music' })), false)
  assert.equal(isCoreRequest(request('network.clearCache', {}, 'query')), false)
})

test('aggregate cache operations require settings permissions and never accept filesystem targets', () => {
  assert.equal(isCoreRequest(request('cache.clear', {})), true)
  assert.equal(isCoreRequest(request('cache.info', {}, 'query')), true)
  assert.equal(isCoreRequest(request('cache.clear', { root: 'D:/Music' })), false)
  assert.equal(isCoreRequest(request('cache.clear', { service: 'scan', method: 'kill' })), false)
  assert.equal(isCoreRequest(request('cache.clear', {}, 'query')), false)
  assert.equal(coreOperation('cache.clear')?.permission, 'settings:write')
  assert.equal(coreOperation('cache.info')?.permission, 'settings:read')
  const platformPayload = (payload: object) =>
    validCorePlatformPayload({
      kind: 'core:platform',
      epoch: 'e',
      requestId: 'id',
      name: 'cache.clearPlatform',
      payload
    } as CorePlatformRequest)
  assert.equal(platformPayload({}), true)
  assert.equal(platformPayload({ root: 'D:/Music' }), false)
  assert.equal(platformPayload({ method: 'rm', args: ['D:/Music'] }), false)
})

test('personalized streams submit provider identities and revision fences, never renderer-owned tracks or URLs', () => {
  assert.equal(
    isCoreRequest(request('personalized.start', { providerId: 'ncm', key: 'fm', play: false })),
    true
  )
  assert.equal(
    isCoreRequest(
      request('personalized.start', { providerId: 'ncm', key: 'radar', selectedId: 'ncm:7' })
    ),
    true
  )
  assert.equal(
    isCoreRequest(request('personalized.start', { providerId: 'ncm', key: 'heart' })),
    false
  )
  assert.equal(
    isCoreRequest(request('personalized.start', { providerId: 'ncm', key: 'fm', tracks: [] })),
    false
  )
  assert.equal(isCoreRequest(request('personalized.refill', { id: 'queue', revision: 3 })), true)
  assert.equal(isCoreRequest(request('personalized.refill', { id: 'queue', revision: -1 })), false)
})

test('Core source edits, downloads and statistics use finite identities and version fences', () => {
  const input = {
    kind: 'provider',
    track: {
      id: 'ncm:7',
      source: 'ncm',
      title: 'Seven',
      artist: 'Singer',
      album: 'Album',
      duration: 60
    }
  }
  for (const name of ['imports.bind', 'imports.previewBind'])
    assert.equal(
      isCoreRequest(request(name, { id: 'import', revision: 2, entryId: 'entry', input })),
      true
    )
  assert.equal(
    isCoreRequest(
      request('imports.bind', {
        id: 'import',
        revision: 2,
        entryId: 'entry',
        track: { filePath: 'D:/private.flac' }
      })
    ),
    false
  )
  assert.equal(
    isCoreRequest(request('playlists.replaceSource', { revision: 3, oldTrackId: 'old', input })),
    true
  )
  assert.equal(isCoreRequest(request('playlists.rematch', { revision: 3, input })), true)
  assert.equal(isCoreRequest(request('library.reveal', { id: 'track', version: 4 })), true)
  assert.equal(
    isCoreRequest(request('library.reveal', { id: 'track', path: 'D:/private.flac' })),
    false
  )
  assert.equal(isCoreRequest(request('downloads.indexed', { id: 'download' }, 'query')), true)
  assert.equal(isCoreRequest(request('downloads.reveal', { id: 'download' })), true)
  assert.equal(
    isCoreRequest(request('statistics.previewClear', { range: null, revision: 5 }, 'query')),
    true
  )
  assert.equal(isCoreRequest(request('statistics.previewClear', { range: null }, 'query')), false)
})

test('liked playback and heart refill accept selection identities, never a caller-chosen liked playlist or tracks', () => {
  assert.equal(isCoreRequest(request('liked.play', { selectedId: 'ncm:7', play: false })), true)
  assert.equal(isCoreRequest(request('liked.play', { playlistId: 123 })), false)
  assert.equal(isCoreRequest(request('liked.play', { tracks: [] })), false)
  assert.equal(isCoreRequest(request('heart.refill', { id: 'q', revision: 3 })), true)
  assert.equal(isCoreRequest(request('heart.refill', { id: 'q', revision: -1 })), false)
})
