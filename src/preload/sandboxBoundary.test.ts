import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Electron sandboxed preload scripts can only require the polyfilled
// `electron` module plus a small set of Node builtins. Importing anything
// else (for example node:crypto) fails the whole preload at runtime, which
// leaves window.api undefined and blanks the renderer.
const ALLOWED_SANDBOX_NODE_BUILTINS = new Set(['events', 'timers', 'url'])

test('DSP audition stays on the audio engine invoke bridge with a shared API contract', () => {
  const source = readFileSync(new URL('./domains/audioEngineApi.ts', import.meta.url), 'utf8')
  for (const channel of [
    'measureDspAudition',
    'selectDspAudition',
    'endDspAudition',
    'getDspAudition'
  ])
    assert.ok(source.includes(`ipcRenderer.invoke(IPC.audioEngine.${channel}`))
  assert.match(source, /JSON\.parse\(JSON\.stringify\(request\)\)/)
  const declarations = readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8')
  assert.match(declarations, /audition:.*DspAuditionApi/)
})

test('library loudness analysis uses shared DTOs, invoke channels and removable subscriptions', () => {
  const source = readFileSync(new URL('./domains/audioEngineApi.ts', import.meta.url), 'utf8')
  for (const name of ['startBatch', 'cancelBatch', 'getBatch', 'getResults', 'clearResults'])
    assert.ok(source.includes(`ipcRenderer.invoke('loudnessAnalysis:${name}'`))
  assert.match(source, /removeListener\('loudnessAnalysis:batchProgress', handler\)/)
  assert.doesNotMatch(source, /from ['"].*main\//)
  const declarations = readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8')
  assert.match(declarations, /loudnessAnalysis:.*LibraryLoudnessApi/)
})

test('queue workspace uses shared DTOs and versioned writes through the data bridge', () => {
  const source = readFileSync(new URL('./domains/dataApi.ts', import.meta.url), 'utf8')
  assert.match(source, /ipcRenderer\.invoke\('data:loadQueueWorkspace'\)/)
  assert.match(
    source,
    /invokeVersionedDataWrite\(\s*'data:saveQueueWorkspace',[\s\S]*isQueueWorkspaceDocument/
  )
  assert.doesNotMatch(source, /from ['"].*main\//)
  const declarations = readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8')
  assert.match(declarations, /loadQueueWorkspace:[\s\S]*QueueWorkspaceDocument/)
  assert.match(declarations, /saveQueueWorkspace:[\s\S]*expectedRevision: number/)
})

test('device profiles cross the sandbox as complete DTOs with a removable event subscription', () => {
  const source = readFileSync(new URL('./domains/audioEngineApi.ts', import.meta.url), 'utf8')
  for (const action of [
    'getDeviceProfiles',
    'saveDeviceProfile',
    'deleteDeviceProfile',
    'applyDeviceProfile'
  ]) {
    assert.ok(source.includes(`ipcRenderer.invoke(IPC.audioEngine.${action}`))
  }
  assert.match(source, /removeListener\(IPC\.audioEngine\.deviceProfilesChanged, listener\)/)
  assert.doesNotMatch(source, /import .*from ['"].*main\//)
})

test('native context menus expose DTO requests through the sandboxed system bridge', () => {
  const source = readFileSync(new URL('./domains/systemApi.ts', import.meta.url), 'utf8')
  assert.match(source, /ipcRenderer\.invoke\('contextMenu:popup', request\)/)
  assert.match(source, /ipcRenderer\.invoke\('contextMenu:close', requestId\)/)
  assert.doesNotMatch(source, /Menu\.buildFromTemplate|\.popup\(/)
  const declarations = readFileSync(new URL('./index.d.ts', import.meta.url), 'utf8')
  assert.match(declarations, /popupContextMenu: \(request: NativeContextMenuRequest\)/)
})

const COMMON_NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'querystring',
  'readline',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib'
])

function collectNodeSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /from\s+['"]node:([^'"]+)['"]/g,
    /require\(['"]node:([^'"]+)['"]\)/g,
    /import\s*\(\s*['"]node:([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

function collectBareBuiltinSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/from\s+['"]([^'"./][^'"]*)['"]/g)) {
    const specifier = match[1]
    if (COMMON_NODE_BUILTINS.has(specifier)) specifiers.push(specifier)
  }
  for (const match of source.matchAll(/require\(['"]([^'"])['"]\)/g)) {
    const specifier = match[1]
    if (COMMON_NODE_BUILTINS.has(specifier)) specifiers.push(specifier)
  }
  return specifiers
}

test('sandboxed preload only imports Node builtins supported by the sandbox', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const banned = [...collectNodeSpecifiers(source), ...collectBareBuiltinSpecifiers(source)].filter(
    (name) => !ALLOWED_SANDBOX_NODE_BUILTINS.has(name)
  )

  assert.deepEqual(
    banned,
    [],
    `sandboxed preload imports Node builtins that Electron cannot load: ${banned.join(', ')}`
  )
})

test('workshop project and restore APIs stay in the sandboxed bridge', () => {
  const source = readFileSync(new URL('./domains/themeWorkshopApi.ts', import.meta.url), 'utf8')
  for (const channel of ['get', 'restoreApplied', 'save', 'apply', 'importAsset'])
    assert.ok(source.includes("ipcRenderer.invoke('themeWorkshop:" + channel + "'"))
  assert.doesNotMatch(source, /from ['"].*main\//)
})
