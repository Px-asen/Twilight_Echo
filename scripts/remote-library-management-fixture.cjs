'use strict'
const assert = require('node:assert/strict')
const { randomUUID, randomBytes } = require('node:crypto')
const { deflateSync, crc32 } = require('node:zlib')

function personalArtwork() {
  const chunk = (type, data) => {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(data.length); header.write(type, 4)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])))
    return Buffer.concat([header, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 2
  const pixels = randomBytes((256 * 3 + 1) * 256)
  for (let row = 0; row < 256; row++) pixels[row * (256 * 3 + 1)] = 0
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
  assert.ok(png.length > 64 * 1024)
  return `data:image/png;base64,${png.toString('base64')}`
}

/** Actual paired TLS -> remote gateway -> Core -> production SQLite/persistence. */
async function exerciseRemoteLibrary(secure, token, epoch) {
  const samples = {}
  const send = async (kind, name, payload = {}, commandId) => {
    const response = await secure(
      '/api/core/rpc',
      {
        requestId: randomUUID(),
        epoch,
        kind,
        name,
        payload,
        ...(kind === 'command' ? { commandId: commandId || randomUUID() } : {})
      },
      token
    )
    assert.equal(response.status, 200)
    return response.json
  }
  const query = async (name, payload) => {
    const result = await send('query', name, payload)
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`)
    samples[name] = result.value
    samples[`${name}.first`] ??= result.value
    return result.value
  }
  const mutate = async (name, payload, commandId) => {
    const result = await send('command', name, payload, commandId)
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`)
    samples[name] = result.value.result
    return result.value.result
  }
  const recordings = await query('catalog.query', { kind: 'recording', limit: 100 })
  const entityId = recordings.items[0].id
  const rating = await query('ratings.detail', { entityId })
  const rated = await mutate('ratings.set', { entityId, token: rating.token, steps: 9 })
  assert.equal(rated.value.steps, 9)
  assert.equal(
    (await send('command', 'ratings.set', { entityId, token: rating.token, steps: 1 })).error.code,
    'STALE_REVISION'
  )
  const preference = await query('preferences.detail', { entityId })
  const favorite = await mutate('preferences.set', {
    entityId,
    token: preference.token,
    state: 'favorite'
  })
  assert.equal(favorite.value.state, 'favorite')
  const tags = await query('tags.list')
  let tag = (
    await mutate('tags.create', { name: '手机 · 夜航', tagsRevision: tags.token.tagsRevision })
  ).tag
  tag = (
    await mutate('tags.member.set', {
      tagId: tag.id,
      entityId,
      present: true,
      membersRevision: tag.membersRevision
    })
  ).tag
  assert.equal(
    (await query('tags.entity', { entityId })).items.some((item) => item.id === tag.id),
    true
  )
  const filter = {
    version: 1,
    entity: 'recording',
    scope: 'library',
    where: {
      all: [
        { tag: { id: tag.id } },
        { preference: 'favorite' },
        { rating: { target: 'self', mode: 'personal', gteStars: 4.5 } }
      ]
    }
  }
  const focus = await query('focus.query', { query: filter, limit: 100 })
  assert.equal(focus.total, 1)
  assert.equal(focus.items[0].id, entityId)
  assert.equal(
    (await query('focus.facets', { query: filter, facet: 'personalRating' })).items.length > 0,
    true
  )
  const saved = await query('focus.saved.list')
  let savedItem = (
    await mutate('focus.saved.create', {
      name: '从手机保存',
      query: filter,
      savedRevision: saved.savedRevision
    })
  ).item
  savedItem = (
    await mutate('focus.saved.rename', {
      id: savedItem.id,
      name: '夜航筛选',
      nameRevision: savedItem.nameRevision
    })
  ).item
  const savedUpdate = await mutate('focus.saved.update', {
    id: savedItem.id,
    query: filter,
    queryRevision: savedItem.queryRevision
  })
  assert.equal(savedUpdate.item.name, '夜航筛选')
  const catalog = await query('playlists.catalog')
  let playlist = await mutate(
    'playlists.edit',
    { revision: catalog.revision, edit: { kind: 'create', name: '手机编辑歌单' } },
    'playlist-create-once'
  )
  assert.equal(typeof playlist.id, 'string')
  assert.equal(
    (
      await send(
        'command',
        'playlists.edit',
        { revision: catalog.revision, edit: { kind: 'create', name: '不能重复提交' } },
        'playlist-create-once'
      )
    ).error.code,
    'OUTCOME_UNKNOWN'
  )
  const source = await query('catalog.sources', { entityId })
  const appended = await mutate('playlists.addSources', {
    id: playlist.id,
    revision: playlist.revision,
    catalogRevision: source.revision,
    sourceIds: [source.items[0].id]
  })
  let members = await query('playlists.members', {
    id: playlist.id,
    revision: appended.revision,
    limit: 100
  })
  assert.equal(members.total, 1)
  assert.match(members.items[0].id, /^remote-member:/)
  assert.doesNotMatch(JSON.stringify(members), /filePath|[A-Z]:[\\/]/)
  const renamed = await mutate('playlists.edit', {
    revision: members.revision,
    edit: { kind: 'rename', id: playlist.id, name: '夜航 · Server' }
  })
  members = await query('playlists.members', {
    id: playlist.id,
    revision: renamed.revision,
    limit: 100
  })
  const removed = await mutate('playlists.edit', {
    revision: members.revision,
    edit: { kind: 'remove', id: playlist.id, ids: [members.items[0].id] }
  })
  assert.equal(
    (await query('playlists.members', { id: playlist.id, revision: removed.revision })).total,
    0
  )
  const releases = await query('catalog.query', { kind: 'release', limit: 100 })
  const artist = (await query('catalog.query', { kind: 'artist', limit: 100 })).items[0]
  const metadataEntity = artist || releases.items[0] || recordings.items[0]
  let metadata = await query('metadata.entity.detail', {
    entityId: metadataEntity.id,
    language: 'zh-Hans'
  })
  await mutate('metadata.entity.override', {
    entityId: metadataEntity.id,
    revision: metadata.revision,
    language: 'zh-Hans',
    mode: 'value',
    value: '在手机整理，保存在 Server。'
  })
  metadata = await query('metadata.entity.detail', {
    entityId: metadataEntity.id,
    language: 'zh-Hans'
  })
  assert.equal(metadata.introduction.value, '在手机整理，保存在 Server。')
  assert.equal(metadata.override.mode, 'value')
  const beforeArtwork = metadata.revision
  await mutate('metadata.entity.artworkOverride', {
    entityId: metadataEntity.id, revision: beforeArtwork, language: 'zh-Hans', mode: 'value', dataUrl: personalArtwork()
  })
  metadata = await query('metadata.entity.detail', { entityId: metadataEntity.id, language: 'zh-Hans' })
  assert.equal(metadata.artworkOverride.mode, 'value')
  assert.match(metadata.manualArtwork.dataUrl, /^data:image\//)
  assert.equal((await send('command', 'metadata.entity.artworkOverride', {
    entityId: metadataEntity.id, revision: beforeArtwork, language: 'zh-Hans', mode: 'clear'
  })).error.code, 'STALE_REVISION')
  await mutate('metadata.entity.artworkOverride', {
    entityId: metadataEntity.id, revision: metadata.revision, language: 'zh-Hans', mode: 'clear'
  })
  metadata = await query('metadata.entity.detail', { entityId: metadataEntity.id, language: 'zh-Hans' })
  assert.equal(metadata.artworkOverride.mode, 'clear')
  assert.equal(metadata.manualArtwork, null)
  await mutate('metadata.entity.artworkOverride', {
    entityId: metadataEntity.id, revision: metadata.revision, language: 'zh-Hans', mode: 'reset'
  })
  metadata = await query('metadata.entity.detail', { entityId: metadataEntity.id, language: 'zh-Hans' })
  assert.equal(metadata.artworkOverride, null)
  assert.equal((await query('ratings.history', { entityId })).total > 0, true)
  assert.equal((await query('preferences.history', { entityId })).total > 0, true)
  if (process.env.TWILIGHT_REMOTE_LIBRARY_SAMPLES) {
    require('node:fs').writeFileSync(
      process.env.TWILIGHT_REMOTE_LIBRARY_SAMPLES,
      JSON.stringify(
        { format: 'twilight-remote-library-software-fixture', version: 1, samples },
        null,
        2
      )
    )
  }
  console.log(
    '[remote-library]',
    JSON.stringify({
      pairedTls: true,
      realSqlite: true,
      rating: 4.5,
      favorite: true,
      tagMembership: true,
      focusMatches: 1,
      savedFocus: true,
      playlistCreateAddRenameRemove: true,
      opaqueMembers: true,
      metadataOverride: true,
      largePersonalArtworkSetClearReset: true,
      staleTokenRejected: true,
      duplicateCommandRejected: true,
      noHardware: true
    })
  )
  return {
    entityId,
    tagId: tag.id,
    focusId: savedItem.id,
    playlistId: playlist.id,
    metadataEntityId: metadataEntity.id
  }
}
async function exerciseSessionQueues(secure, token, epoch, zoneId = 'local') {
  const samples = {}
  const send = async (kind, name, payload = {}) => {
    const response = await secure('/api/core/rpc', { requestId: randomUUID(), epoch, kind, name, payload,
      ...(kind === 'command' ? { commandId: randomUUID() } : {}) }, token)
    assert.equal(response.status, 200, name)
    return response.json
  }
  const query = async (name, payload) => {
    const result = await send('query', name, payload)
    assert.equal(result.ok, true, JSON.stringify(result)); samples[name] = result.value
    return result.value
  }
  const mutate = async (name, payload) => {
    const result = await send('command', name, payload)
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value.result
  }
  const recordings = await query('catalog.query', { kind: 'recording', limit: 100 })
  const entityId = recordings.items[0].id
  const tags = await query('tags.list')
  let tag = (await mutate('tags.create', { name: 'Session tag', tagsRevision: tags.token.tagsRevision })).tag
  tag = (await mutate('tags.member.set', { tagId: tag.id, entityId, present: true, membersRevision: tag.membersRevision })).tag
  const filter = { version: 1, entity: 'recording', scope: 'library', where: { tag: { id: tag.id } } }
  const catalog = await query('playlists.catalog')
  const playlist = await mutate('playlists.edit', { revision: catalog.revision, edit: { kind: 'create', name: 'Session playlist' } })
  // Actual Core-owned SQL queues through the same paired TLS entry point. All
  // loads are explicitly paused; this test never opens the server's sound card.
  const destination = async () => {
    const zone = (await query('zones.list')).zones.find(z => z.id === zoneId)
    return { target: { kind: 'zone', id: zone.id, revision: zone.revision }, queue: zone.queue &&
      { id: zone.queue.id, revision: zone.queue.revision, occurrenceId: zone.queue.occurrenceId } }
  }
  const load = async readSelection => {
    let result
    // Playback metadata can finish after Pause. A rejected stale selection has
    // no side effects; refresh both revisions as a client would, without
    // retrying transport failures or replaying an acknowledged queue load.
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = await destination()
      const selection = await readSelection()
      result = await send('command', 'zones.queue.load', { ...target, selection, play: false })
      if (result.ok || result.error?.code !== 'STALE_REVISION') break
    }
    assert.equal(result.ok, true, JSON.stringify(result))
    const current = await destination()
    const page = await query('zones.queue.page', { target: current.target, queue: { id: current.queue.id, revision: current.queue.revision }, offset: 0, limit: 100 })
    assert.doesNotMatch(JSON.stringify(page), /filePath|[A-Z]:[\\/]/)
    return { current, page }
  }
  const repeated = await load(async () => {
    const currentSource = await query('catalog.sources', { entityId })
    return { kind: 'catalog', revision: currentSource.revision, sourceIds: [currentSource.items[0].id, currentSource.items[0].id] }
  })
  assert.equal(repeated.page.total, 2)
  assert.notEqual(repeated.page.items[0].queueEntryId, repeated.page.items[1].queueEntryId)
  const selected = await send('command', 'zones.queue.select', { target: repeated.current.target,
    queue: { id: repeated.current.queue.id, revision: repeated.current.queue.revision },
    index: 1, occurrenceId: repeated.page.items[1].queueEntryId })
  assert.equal(selected.ok, true, JSON.stringify(selected))
  repeated.current = await destination()
  assert.equal(repeated.current.queue.occurrenceId, repeated.page.items[1].queueEntryId)
  assert.equal((await query('zones.list')).zones.find(z => z.id === zoneId).playback.state, 'playing')
  const paused = await send('command', 'zones.transport', { zoneId, revision: null, action: { kind: 'pause' } })
  assert.equal(paused.ok, true, JSON.stringify(paused))
  repeated.current = await destination()
  const edit = await send('command', 'zones.queue.edit', { target: repeated.current.target,
    queue: { id: repeated.current.queue.id, revision: repeated.current.queue.revision },
    edit: { kind: 'remove', entryIds: [repeated.page.items[1].queueEntryId] } })
  assert.equal(edit.ok, true, JSON.stringify(edit))
  const stale = await send('command', 'zones.queue.edit', { target: repeated.current.target,
    queue: { id: repeated.current.queue.id, revision: repeated.current.queue.revision }, edit: { kind: 'clear' } })
  assert.equal(stale.error.code, 'STALE_REVISION')
  assert.equal((await load(async () => {
    const tagPage = await query('tags.members', { tagId: tag.id })
    return { kind: 'tag', input: { tagId: tag.id, token: tagPage.token } }
  })).page.total, 1)
  assert.equal((await load(async () => {
    const focusPage = await query('focus.query', { query: filter })
    return { kind: 'focus', input: { query: filter, token: focusPage.token } }
  })).page.total, 1)
  const latestSource = await query('catalog.sources', { entityId })
  const playlistRevision = (await query('playlists.catalog')).revision
  const added = await mutate('playlists.addSources', { id: playlist.id, revision: playlistRevision,
    catalogRevision: latestSource.revision, sourceIds: [latestSource.items[0].id, latestSource.items[0].id] })
  // Ordinary playlists deduplicate track identities; queue occurrences above
  // deliberately do not. Keep the existing playlist membership contract.
  assert.equal((await query('playlists.members', { id: playlist.id, revision: added.revision })).total, 1)
  assert.equal((await load(async () => {
    const snapshot = await query('core.getSnapshot')
    const currentCatalog = await query('playlists.catalog')
    return { kind: 'playlist', id: playlist.id, revision: currentCatalog.revision, versionsRevision: snapshot.versionsRevision }
  })).page.total, 1)
  if (process.env.TWILIGHT_SESSION_QUEUE_SAMPLES) require('node:fs').writeFileSync(process.env.TWILIGHT_SESSION_QUEUE_SAMPLES,
    JSON.stringify({ format: 'twilight-session-queue-wire', version: 1, samples }, null, 2))
  console.log('[session-queues]', JSON.stringify({ pairedTls: true, realSqlite: true,
    catalogTagFocusPlaylistLoads: true, repeatedOccurrences: true, occurrencePlayback: true, staleEditRejected: true, noHardware: true }))
}
module.exports = { exerciseRemoteLibrary, exerciseSessionQueues }
