import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BUILT_IN_THEME_PRESET_IDS,
  TWILIGHT_DEFAULT_THEME_ID,
  createDefaultThemeLibraryDocument,
  resolveThemeProfileTokens,
  type ThemeProfileV2
} from '../../shared/theme.ts'
import { PersistentDataRevisionConflictError } from '../../shared/versionedPersistence.ts'
import { ThemeLibraryRepository } from './themeLibraryRepository.ts'

test('theme library migrates initial selection and protects every write with revisions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-theme-library-'))
  try {
    const repository = new ThemeLibraryRepository(join(directory, 'themes.json'), () =>
      createDefaultThemeLibraryDocument(
        { kind: 'plugin', pluginId: 'com.example.theme', themeId: 'midnight' },
        { miniPlayer: false, desktopLyrics: false }
      )
    )
    const initial = await repository.load()
    assert.equal(initial.revision, 0)
    assert.deepEqual(initial.data.activeTheme, {
      kind: 'plugin',
      pluginId: 'com.example.theme',
      themeId: 'midnight'
    })
    assert.deepEqual(initial.data.windowInheritance, {
      miniPlayer: false,
      desktopLyrics: false
    })

    const saved = await repository.saveProfile(createProfile('user:midnight'), 0)
    assert.equal(saved.revision, 1)
    await assert.rejects(
      () => repository.setActive({ kind: 'user', id: 'user:midnight' }, 0),
      PersistentDataRevisionConflictError
    )
    const active = await repository.setActive({ kind: 'user', id: 'user:midnight' }, 1)
    assert.equal(active.revision, 2)
    const deleted = await repository.deleteProfile('user:midnight', 2)
    assert.equal(deleted.revision, 3)
    assert.deepEqual(deleted.data.activeTheme, {
      kind: 'builtin',
      id: TWILIGHT_DEFAULT_THEME_ID
    })
    await assert.rejects(
      () => repository.deleteProfile(TWILIGHT_DEFAULT_THEME_ID, 3),
      /默认主题不能删除/
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('every built-in theme rejects deletion without changing the persisted library', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-theme-delete-protection-'))
  const file = join(directory, 'themes.json')
  try {
    const repository = new ThemeLibraryRepository(file, createDefaultThemeLibraryDocument)
    const saved = await repository.saveProfile(createProfile('user:retained'), 0)
    const content = readFileSync(file, 'utf8')
    for (const id of BUILT_IN_THEME_PRESET_IDS) {
      await assert.rejects(
        () => repository.deleteProfile(id, saved.revision),
        id === TWILIGHT_DEFAULT_THEME_ID ? /默认主题不能删除/ : /内置主题不能删除/
      )
      assert.equal(readFileSync(file, 'utf8'), content)
      assert.deepEqual(await repository.load(), saved)
    }
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'twilight-theme-delete-protection-')))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('deleting another personal theme preserves the active choice and removes only its history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-theme-delete-inactive-'))
  const file = join(directory, 'themes.json')
  try {
    const repository = new ThemeLibraryRepository(file, createDefaultThemeLibraryDocument)
    const retained = createProfile('user:active')
    const removed = createProfile('user:removed')
    let snapshot = await repository.saveProfile(retained, 0)
    snapshot = await repository.saveProfile(removed, snapshot.revision)
    snapshot = await repository.saveProfile(
      { ...removed, name: 'Edited personal theme' },
      snapshot.revision
    )
    assert.equal(snapshot.data.profileHistory[removed.id].length, 1)
    const previousRevision = snapshot.revision
    snapshot = await repository.setActive({ kind: 'user', id: retained.id }, snapshot.revision)
    await assert.rejects(
      () => repository.deleteProfile(removed.id, previousRevision),
      PersistentDataRevisionConflictError
    )
    assert.deepEqual(await repository.load(), snapshot)
    const deleted = await repository.deleteProfile(removed.id, snapshot.revision)
    assert.equal(deleted.revision, snapshot.revision + 1)
    assert.deepEqual(deleted.data.activeTheme, { kind: 'user', id: retained.id })
    assert.deepEqual(deleted.data.profiles, [
      snapshot.data.profiles.find((p) => p.id === retained.id)
    ])
    assert.equal(deleted.data.profileHistory[removed.id], undefined)
    assert.deepEqual(
      await new ThemeLibraryRepository(file, createDefaultThemeLibraryDocument).load(),
      deleted
    )
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'twilight-theme-delete-inactive-')))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('theme library reads v1 profiles as v2 without rewriting the recovery source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-theme-v1-migration-'))
  const file = join(directory, 'themes.json')
  try {
    const legacy = {
      version: 2,
      revision: 4,
      savedAt: '2026-07-22T00:00:00.000Z',
      data: {
        schemaVersion: 1,
        activeTheme: { kind: 'user', id: 'user:legacy' },
        profiles: [{ ...createProfile('user:legacy'), schemaVersion: 1 }],
        windowInheritance: { miniPlayer: true, desktopLyrics: true }
      }
    }
    writeFileSync(file, JSON.stringify(legacy), 'utf8')
    const repository = new ThemeLibraryRepository(file, createDefaultThemeLibraryDocument)
    const migrated = await repository.load()
    assert.equal(migrated.revision, 4)
    assert.equal(migrated.data.profiles[0].schemaVersion, 2)
    assert.deepEqual(migrated.data.profiles[0].modes, {})
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).data.profiles[0].schemaVersion, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('theme profile writes keep a bounded recoverable history without changing CAS semantics', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-theme-history-'))
  try {
    const repository = new ThemeLibraryRepository(
      join(directory, 'themes.json'),
      createDefaultThemeLibraryDocument
    )
    let profile = createProfile('user:history')
    let snapshot = await repository.saveProfile(profile, 0, '2026-07-23T00:00:00.000Z')
    for (let index = 1; index <= 12; index += 1) {
      profile = {
        ...profile,
        updatedAt: `2026-07-23T00:${String(index).padStart(2, '0')}:00.000Z`,
        overrides: {
          ...profile.overrides,
          pureWhite: { 'color.primary.500': `#${String(index).padStart(2, '0')}3456` }
        }
      }
      snapshot = await repository.saveProfile(profile, snapshot.revision)
    }
    const history = snapshot.data.profileHistory['user:history']
    assert.ok(history)
    assert.ok(history.length <= 8)
    assert.equal(history[0].profile.overrides.pureWhite['color.primary.500'], '#113456')
    assert.ok(Buffer.byteLength(JSON.stringify(history), 'utf8') <= 256 * 1024)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('saved player colors survive activation and a fresh repository load in both tones', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-theme-player-colors-'))
  const file = join(directory, 'themes.json')
  try {
    const repository = new ThemeLibraryRepository(file, createDefaultThemeLibraryDocument)
    const profile = createProfile('user:player-colors')
    profile.overrides = {
      pureWhite: {
        'playback.progress.track': '#123456',
        'playback.progress.fill': 'linear-gradient(90deg, #ff0000, #00ff00)',
        'playback.control.surface': '#654321',
        'playback.control.hoverSurface': '#abcdef'
      },
      dark: {
        'playback.progress.track': '#345678',
        'playback.progress.fill': 'linear-gradient(90deg, #0000ff, #ff00ff)',
        'playback.control.surface': '#876543',
        'playback.control.hoverSurface': '#fedcba'
      }
    }
    const saved = await repository.saveProfile(profile, 0)
    await repository.setActive({ kind: 'user', id: profile.id }, saved.revision)
    const reloaded = await new ThemeLibraryRepository(
      file,
      createDefaultThemeLibraryDocument
    ).load()
    assert.deepEqual(reloaded.data.activeTheme, { kind: 'user', id: profile.id })
    const persisted = reloaded.data.profiles[0]
    assert.deepEqual(persisted.overrides, profile.overrides)
    for (const tone of ['pureWhite', 'dark'] as const) {
      const tokens = resolveThemeProfileTokens(persisted, tone)
      for (const [id, value] of Object.entries(profile.overrides[tone])) {
        assert.equal(tokens[id], value)
      }
    }
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'twilight-theme-player-colors-')))
    rmSync(directory, { recursive: true, force: true })
  }
})

function createProfile(id: string): ThemeProfileV2 {
  return {
    schemaVersion: 2,
    id,
    name: 'Midnight',
    description: '',
    baseThemeId: TWILIGHT_DEFAULT_THEME_ID,
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:00:00.000Z',
    overrides: {
      pureWhite: { 'color.primary.500': '#123456' },
      dark: {}
    },
    modes: {}
  }
}
