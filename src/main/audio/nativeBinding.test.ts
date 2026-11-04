import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  getNativeAddonCandidates,
  loadNativeBindingWithDiagnostics,
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
