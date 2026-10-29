import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeExperiences, assertExperienceMethod } from './pluginExperience.ts'
import { validatePluginManifest } from '../main/plugins/manifest.ts'

const experience = {
  id: 'rhine-lab',
  name: 'Rhine Lab',
  entry: 'dist/index.html',
  bridgeVersion: 1
}
const manifest = {
  id: 'com.example.rhine',
  name: 'Rhine',
  version: '0.1.0',
  description: 'Test',
  author: 'Test',
  license: 'MIT',
  apiVersion: 4,
  type: ['ui'],
  permissions: ['ui:inject'],
  engines: { twilightEcho: '*' },
  contributes: { experiences: [experience] }
}

test('API v4 accepts declarative experiences without a process entry', () => {
  assert.equal(validatePluginManifest(manifest).main, undefined)
  assert.deepEqual(normalizeExperiences(manifest), [experience])
})
test('experience requires API v4, UI type and explicit injection permission', () => {
  for (const patch of [{ apiVersion: 3 }, { type: ['tool'] }, { permissions: [] }])
    assert.throws(() => validatePluginManifest({ ...manifest, ...patch }))
})
test('experience entry rejects external, encoded, traversal and non-HTML paths', () => {
  for (const entry of [
    '../index.html',
    '/index.html',
    'C:/index.html',
    'dist\\index.html',
    'https://example.com/index.html',
    'dist/%2e%2e/index.html',
    'dist/index.js'
  ])
    assert.throws(() =>
      normalizeExperiences({
        ...manifest,
        contributes: { experiences: [{ ...experience, entry }] }
      })
    )
})
test('experience rejects duplicate ids and unknown bridge versions', () => {
  assert.throws(() =>
    normalizeExperiences({ ...manifest, contributes: { experiences: [experience, experience] } })
  )
  assert.throws(() =>
    normalizeExperiences({
      ...manifest,
      contributes: { experiences: [{ ...experience, bridgeVersion: 3 }] }
    })
  )
})

test('bridge v2 is opt-in and v1 experiences stay unchanged', () => {
  const normalized = normalizeExperiences({
    ...manifest,
    contributes: { experiences: [{ ...experience, bridgeVersion: 2 }] }
  })
  assert.equal(normalized[0].bridgeVersion, 2)
  assert.equal(normalizeExperiences(manifest)[0].bridgeVersion, 1)
  assert.throws(() => assertExperienceMethod('music.metadata.write', ['library:read']))
  assert.throws(() => assertExperienceMethod('player.reorderQueue', ['player:observe']))
})
test('bridge permissions are explicit and prototype properties are not operations', () => {
  assert.doesNotThrow(() => assertExperienceMethod('player.play', ['player:control']))
  for (const method of [
    'player.play',
    'plugins.disable',
    'settings.update',
    '__proto__',
    'constructor',
    'ipc.invoke'
  ])
    assert.throws(() => assertExperienceMethod(method, ['ui:inject']))
})
test('legacy process plugins remain valid', () => {
  for (const apiVersion of [1, 2, 3])
    assert.equal(
      validatePluginManifest({ ...manifest, apiVersion, contributes: undefined, main: 'index.js' })
        .apiVersion,
      apiVersion
    )
})

test('service operations require their own grants, not just UI access', () => {
  for (const [method, permission] of [
    ['radio.list', 'network'],
    ['radio.add', 'library:write'],
    ['podcasts.subscribe', 'library:write'],
    ['network.create', 'app:settings'],
    ['network.browse', 'network'],
    ['stats.read', 'library:read'],
    ['diagnostics.export', 'app:settings'],
    ['plugins.update', 'plugins:manage'],
    ['player.sleep', 'player:control'],
    ['player.rate', 'player:control']
  ]) {
    assert.throws(() => assertExperienceMethod(method, ['ui:inject']))
    assert.doesNotThrow(() => assertExperienceMethod(method, [permission]))
  }
})

test('plugin.request relays experience calls to plugin background code under network grant', () => {
  assert.throws(() => assertExperienceMethod('plugin.request', ['ui:inject']))
  assert.throws(() => assertExperienceMethod('plugin.request', ['library:read']))
  assert.doesNotThrow(() => assertExperienceMethod('plugin.request', ['network']))
})

test('panel launch keeps an experience out of sidebar navigation', () => {
  const panelManifest = {
    ...manifest,
    contributes: { experiences: [{ ...experience, launch: 'panel' }] }
  }
  const normalized = normalizeExperiences(panelManifest)
  assert.equal(normalized[0].launch, 'panel')
  assert.equal(normalizeExperiences(manifest)[0].launch, undefined)
  assert.throws(() =>
    normalizeExperiences({
      ...manifest,
      contributes: { experiences: [{ ...experience, launch: 'flyout' }] }
    })
  )
})

test('sidebar launch accepts packaged widgets with an optional bounded height', () => {
  for (const sidebar of [undefined, {}, { height: 64 }, { height: 144 }, { height: 480 }]) {
    const widget = { ...experience, launch: 'sidebar', ...(sidebar ? { sidebar } : {}) }
    const source = { ...manifest, contributes: { experiences: [widget] } }
    assert.deepEqual(normalizeExperiences(source), [widget])
    assert.equal(validatePluginManifest(source).main, undefined)
  }
})

test('sidebar sizing rejects malformed options without changing page or panel defaults', () => {
  for (const sidebar of [
    null,
    [],
    '144',
    { height: 63 },
    { height: 481 },
    { height: 64.5 },
    { height: '144' },
    { height: NaN },
    { height: Infinity }
  ]) {
    assert.throws(() =>
      normalizeExperiences({
        ...manifest,
        contributes: { experiences: [{ ...experience, launch: 'sidebar', sidebar }] }
      })
    )
  }
  for (const launch of [undefined, 'page', 'panel']) {
    assert.throws(() =>
      normalizeExperiences({
        ...manifest,
        contributes: { experiences: [{ ...experience, launch, sidebar: { height: 144 } }] }
      })
    )
  }
  assert.deepEqual(normalizeExperiences(manifest), [experience])
})
