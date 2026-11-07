import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'
import {
  getNativeAddonCandidates,
  loadNativeBindingWithDiagnostics,
  nativeRuntimeIdentity,
  rendererFallbackAllowed
} from './nativeBinding.ts'

test('the legacy fallback capability stays false even in an old diagnostic environment', (t) => {
  const old = process.env.TWILIGHT_ENABLE_HTMLAUDIO_FALLBACK
  process.env.TWILIGHT_ENABLE_HTMLAUDIO_FALLBACK = '1'
  t.after(() => {
    if (old === undefined) delete process.env.TWILIGHT_ENABLE_HTMLAUDIO_FALLBACK
    else process.env.TWILIGHT_ENABLE_HTMLAUDIO_FALLBACK = old
  })
  assert.equal(rendererFallbackAllowed(), false)
})

test('runtime identity follows the platform library, including Linux engine changes with an unchanged addon', t => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-native-identity-'))
  t.after(() => { assert.ok(root.startsWith(join(tmpdir(), 'twilight-native-identity-'))); rmSync(root, { recursive: true, force: true }) })
  mkdirSync(join(root, 'automix-native'))
  for (const name of ['twilight_audio_node.node', 'automix-native/beat-this.tamg', 'automix-native/yamnet.tamg',
    'twilight-audio-engine.dll', 'libtwilight-audio-engine.so', 'libtwilight-audio-engine.dylib']) writeFileSync(join(root, name), name)
  const addon = join(root, 'twilight_audio_node.node')
  const first = nativeRuntimeIdentity(addon, 'linux')
  assert.equal(first['twilight-audio-engine.dll'], undefined)
  assert.notEqual(first['libtwilight-audio-engine.so'], 'unavailable')
  writeFileSync(join(root, 'libtwilight-audio-engine.so'), 'new engine')
  const next = nativeRuntimeIdentity(addon, 'linux')
  assert.equal(first['twilight_audio_node.node'], next['twilight_audio_node.node'])
  assert.notEqual(first['libtwilight-audio-engine.so'], next['libtwilight-audio-engine.so'])
  assert.notEqual(nativeRuntimeIdentity(addon, 'win32')['twilight-audio-engine.dll'], 'unavailable')
  assert.notEqual(nativeRuntimeIdentity(addon, 'darwin')['libtwilight-audio-engine.dylib'], 'unavailable')
})

test('packaged utility workers load only the addon beside their own archive', () => {
  const resources = join(process.cwd(), 'fixture-evaluation', 'resources')
  for (const entry of [
    join('out', 'main', 'audioEngineService.js'),
    join('out', 'main', 'chunks', 'nativeBinding-hash.js'),
    join('out', 'main', 'audioAnalysisService.js')
  ]) {
    assert.deepEqual(
      getNativeAddonCandidates({
        modulePath: join(resources, 'app.asar', entry),
        resourcesPath: join(process.cwd(), 'stale-electron', 'resources'),
        appPath: join(process.cwd(), 'stale-project'),
        cwd: process.cwd()
      }),
      [join(resources, 'audio-engine', 'twilight_audio_node.node')]
    )
  }
})

test('a missing packaged addon does not fall through to the launch directory', () => {
  const candidates = getNativeAddonCandidates({
    modulePath: join(
      process.cwd(),
      'missing-package-fixture',
      'resources',
      'app.asar',
      'out',
      'main',
      'audioEngineService.js'
    ),
    cwd: process.cwd()
  })
  const result = loadNativeBindingWithDiagnostics(() => candidates)
  assert.equal(result.binding, null)
  assert.equal(result.candidateCount, 1)
  assert.deepEqual(result.attempts, [])
})

test('the Server image addon shares package anchoring without changing the playback addon default', () => {
  const root = join(process.cwd(), 'server-package')
  const modulePath = join(root, 'out', 'server', 'platform.cjs')
  assert.equal(
    getNativeAddonCandidates({
      modulePath,
      resourcesPath: '',
      binary: 'twilight_image_node.node'
    })[0],
    join(root, 'resources', 'audio-engine', 'twilight_image_node.node')
  )
  assert.equal(
    getNativeAddonCandidates({ modulePath, resourcesPath: '' })[0],
    join(root, 'resources', 'audio-engine', 'twilight_audio_node.node')
  )
})

test('development workers without an app singleton anchor to their source tree', () => {
  const root = join(process.cwd(), 'dev-fixture')
  for (const entry of [
    join('src', 'main', 'audio', 'nativeBinding.ts'),
    join('out', 'main', 'chunks', 'nativeBinding-hash.js'),
    join('out', 'server', 'audioEngineService.cjs')
  ]) {
    const candidates = getNativeAddonCandidates({
      modulePath: join(root, entry),
      resourcesPath: '',
      cwd: join(process.cwd(), 'unrelated-launch-directory')
    })
    assert.equal(candidates[0], join(root, 'resources', 'audio-engine', 'twilight_audio_node.node'))
    assert.ok(candidates.every((candidate) => !candidate.includes('unrelated-launch-directory')))
  }
})
