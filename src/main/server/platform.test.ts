import '../../adapters-node/index.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServerPlatform } from './platform.ts'
import {
  initializeServerProfile,
  readServerProfile,
  lockServerProfile,
  unlockStoppedServerProfile
} from './profile.ts'

test('Server path grants come from its own profile, not requested settings or symlink targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-server-platform-'))
  const signal = new AbortController().signal
  try {
    const music = join(root, 'music'),
      outside = join(root, 'outside'),
      profile = join(root, 'profile')
    await mkdir(music)
    await mkdir(outside)
    await mkdir(profile)
    const song = join(music, 'song.FLAC'),
      secret = join(outside, 'secret.flac')
    await writeFile(song, 'fixture')
    await writeFile(secret, 'private')
    await symlink(outside, join(music, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const platform = await createServerPlatform({ root: profile, libraryRoots: [music] })
    const audio = platform['paths.authorizeAudioFile']!
    assert.equal(await audio({ path: song }, signal), await realpath(song))
    await assert.rejects(audio({ path: secret }, signal), /授权目录/)
    await assert.rejects(audio({ path: join(music, 'escape', 'secret.flac') }, signal), /授权目录/)
    await assert.rejects(
      platform['settings.authorizePaths']!({ libraryFolders: [outside] }, signal),
      /授权/
    )
    assert.deepEqual(
      await platform['paths.areAudioFilesAuthorized']!(
        { paths: [song, secret, join(music, 'missing.flac')] },
        signal
      ),
      [true, false, false]
    )
    assert.equal(
      await platform['paths.prepareAudio']!({ source: join(music, 'missing.flac') }, signal),
      null
    )
    await assert.rejects(
      platform['paths.authorizeAudio']!({ source: 'https://user:pass@host.test/a.mp3' }, signal),
      /credentials/
    )
    await assert.rejects(
      platform['paths.authorizeAudio']!({ source: 'file:///outside.wav' }, signal),
      /protocol/
    )
    assert.equal(
      await platform['paths.authorizeAudio']!({ source: 'https://host.test/song.flac' }, signal),
      'https://host.test/song.flac'
    )
    assert.equal(platform['files.trashAudio'], undefined)
    assert.equal(typeof platform['credentials.protect'], 'function')
    assert.equal(typeof platform['credentials.unprotect'], 'function')
    await assert.rejects(
      platform['credentials.protect']!({ scope: 'outside-profile', value: 'fixture' }, signal),
      /凭据范围/
    )
  } finally {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})

test('Server artwork projects a cached bitmap without exposing its file or URL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-server-artwork-'))
  const signal = new AbortController().signal
  try {
    const platform = await createServerPlatform({ root, libraryRoots: [] })
    const cache = join(root, 'music-cache', 'cover-cache')
    await mkdir(cache)
    const data =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII='
    await writeFile(join(cache, 'fixture.png'), Buffer.from(data.split(',')[1], 'base64'))
    const artwork = await platform['artwork.present']!(
      { cover: 'cover://fixture.png', coverSource: null },
      signal
    )
    assert.equal(artwork.cover, 'cover://fixture.png')
    assert.equal(await platform['artwork.remotePreview']!({ cover: artwork.cover }, signal), data)
    assert.equal(await platform['artwork.remotePreview']!({ cover: null }, signal), null)
    await assert.rejects(
      platform['artwork.normalizeCachedCover']!({ handle: 'cover://../secret.png' }, signal),
      /无效/
    )
    const projected = await platform['artwork.present']!(
      { cover: null, coverSource: 'https://host.test/a.png' },
      signal
    )
    assert.match(projected.cover!, /^twilight-media:\/\/image\//)
    assert.equal(projected.coverSource, null)
  } finally {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})

test('Server initialization protects nonempty profiles and a live lock cannot be overridden', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-server-profile-'))
  try {
    const profile = join(root, 'profile')
    await initializeServerProfile(profile, [])
    const config = await readServerProfile(profile)
    assert.equal(config.version, 1)
    await assert.rejects(initializeServerProfile(profile, []), /空目录/)
    const release = await lockServerProfile(profile)
    try {
      await assert.rejects(
        lockServerProfile(profile),
        (error) => (error as NodeJS.ErrnoException).code === 'EEXIST'
      )
      await assert.rejects(unlockStoppedServerProfile(profile), /仍存在/)
    } finally {
      await release()
    }
    const again = await lockServerProfile(profile)
    await again()
  } finally {
    assert.equal(resolve(root, '..'), resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})
