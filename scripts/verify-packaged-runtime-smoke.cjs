const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')

function createPcmWaveBuffer({ sampleRate = 8000, durationMs = 1200, frequencyHz = 440 } = {}) {
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000))
  const dataSize = sampleCount * numChannels * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28)
  buffer.writeUInt16LE(numChannels * bytesPerSample, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < sampleCount; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * 8192)
    buffer.writeInt16LE(sample, 44 + i * bytesPerSample)
  }
  return buffer
}

function findMacExecutable(appBundlePath) {
  const macOsDir = path.join(appBundlePath, 'Contents', 'MacOS')
  if (!fs.existsSync(macOsDir)) return null
  const preferred = path.join(macOsDir, 'TwilightEcho')
  if (fs.existsSync(preferred)) return preferred
  const firstEntry = fs
    .readdirSync(macOsDir, { withFileTypes: true })
    .find((entry) => entry.isFile())
  return firstEntry ? path.join(macOsDir, firstEntry.name) : null
}

function findUnpackedExecutable(unpackedDir) {
  for (const name of ['TwilightEcho.exe', 'music', 'TwilightEcho']) {
    const candidate = path.join(unpackedDir, name)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

function resolvePackagedRuntimeTarget(targetPath) {
  const resolved = path.resolve(targetPath)
  assert.ok(fs.existsSync(resolved), `Packaged runtime target not found: ${resolved}`)

  if (resolved.endsWith('.asar')) {
    const parent = path.dirname(resolved)
    const grandParent = path.dirname(parent)
    if (path.basename(parent) === 'Resources' && path.basename(grandParent) === 'Contents') {
      const appBundle = path.dirname(grandParent)
      return { asarPath: resolved, executablePath: findMacExecutable(appBundle) }
    }
    if (path.basename(parent) === 'resources') {
      return { asarPath: resolved, executablePath: findUnpackedExecutable(grandParent) }
    }
    return { asarPath: resolved, executablePath: null }
  }

  if (resolved.endsWith('.app')) {
    const asarPath = path.join(resolved, 'Contents', 'Resources', 'app.asar')
    assert.ok(fs.existsSync(asarPath), `Packaged app.asar not found in bundle: ${asarPath}`)
    return { asarPath, executablePath: findMacExecutable(resolved) }
  }

  const unpackedAsar = path.join(resolved, 'resources', 'app.asar')
  if (fs.existsSync(unpackedAsar)) {
    return { asarPath: unpackedAsar, executablePath: findUnpackedExecutable(resolved) }
  }

  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue
    const bundlePath = path.join(resolved, entry.name)
    const bundleAsar = path.join(bundlePath, 'Contents', 'Resources', 'app.asar')
    if (fs.existsSync(bundleAsar)) {
      return { asarPath: bundleAsar, executablePath: findMacExecutable(bundlePath) }
    }
  }

  throw new Error(`Could not locate resources/app.asar or *.app bundle under: ${resolved}`)
}

function canRunPackagedExecutable(executablePath) {
  if (!executablePath || !fs.existsSync(executablePath)) return false
  if (process.platform === 'win32' && !executablePath.toLowerCase().endsWith('.exe')) return false
  if (process.platform !== 'win32' && executablePath.toLowerCase().endsWith('.exe')) return false
  const probe = spawnSync(executablePath, ['-e', 'process.exit(0)'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    stdio: 'ignore',
    timeout: 15_000
  })
  return !probe.error && probe.status === 0
}

function assertNoAncestorNodeModules(directory) {
  let cursor = path.resolve(directory)
  for (;;) {
    const candidate = path.join(cursor, 'node_modules')
    if (fs.existsSync(candidate)) {
      throw new Error(
        `Isolated smoke directory has an ancestor node_modules that would invalidate resolution isolation: ${candidate}`
      )
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

const SMOKE_PROBE_SOURCE = `'use strict'
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

function normalizeForPrefix(targetPath) {
  const resolved = path.resolve(targetPath).replaceAll('\\\\', '/')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function assertResolvedInsideApp(appRoot, resolvedPath, label) {
  const rootPrefix = normalizeForPrefix(appRoot) + '/'
  const normalized = normalizeForPrefix(resolvedPath)
  assert.ok(
    normalized.startsWith(rootPrefix),
    label + ' resolved outside isolated packaged app: ' + resolvedPath + ' (expected under ' + appRoot + ')'
  )
}

async function runLibraryScanSmoke({ appRoot, tempDir, musicDir, coverCacheDir }) {
  const workerPath = path.join(appRoot, 'out', 'main', 'libraryScanService.js')
  assert.ok(fs.existsSync(workerPath), 'Missing packaged libraryScanService.js: ' + workerPath)

  const stderrChunks = []
  const stdoutChunks = []
  const worker = spawn(process.execPath, [workerPath], {
    cwd: tempDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  worker.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
  worker.stderr.on('data', (chunk) => stderrChunks.push(chunk))

  const formatOutput = () => {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()
    const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
    return [stderr && 'stderr: ' + stderr, stdout && 'stdout: ' + stdout].filter(Boolean).join('\\n')
  }

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for libraryScanService ready message.\\n' + formatOutput()))
      }, 20_000)
      const onExit = (code, signal) => {
        clearTimeout(timer)
        reject(
          new Error(
            'libraryScanService exited before ready (code=' + code + ', signal=' + signal + ').\\n' + formatOutput()
          )
        )
      }
      const onMessage = (message) => {
        if (message && message.kind === 'ready') {
          clearTimeout(timer)
          worker.off('exit', onExit)
          worker.off('message', onMessage)
          resolve()
        }
      }
      worker.once('exit', onExit)
      worker.on('message', onMessage)
    })

    const scanResult = await new Promise((resolve, reject) => {
      const requestId = 'packaged-smoke-scan-1'
      const timer = setTimeout(() => {
        reject(new Error('Timed out waiting for libraryScanService scan response.\\n' + formatOutput()))
      }, 20_000)
      const onExit = (code, signal) => {
        clearTimeout(timer)
        reject(
          new Error(
            'libraryScanService exited during scan (code=' + code + ', signal=' + signal + ').\\n' + formatOutput()
          )
        )
      }
      const onMessage = (message) => {
        if (!message || message.requestId !== requestId || message.kind !== 'response') return
        clearTimeout(timer)
        worker.off('exit', onExit)
        worker.off('message', onMessage)
        resolve(message)
      }
      worker.once('exit', onExit)
      worker.on('message', onMessage)
      worker.send({
        kind: 'scan',
        requestId,
        request: {
          mode: 'full',
          roots: [musicDir],
          knownIdentities: [],
          knownTrackPaths: [],
          excludedPaths: [],
          coverCacheDir
        }
      })
    })

    assert.equal(
      scanResult.ok,
      true,
      'libraryScanService scan failed: ' + (scanResult.error || 'unknown error') + '\\n' + formatOutput()
    )
    const parsedTracks = scanResult.value && scanResult.value.parsedTracks
    assert.ok(Array.isArray(parsedTracks) && parsedTracks.length === 1, 'Expected 1 parsed WAV track from libraryScanService')
    assert.ok(Number(parsedTracks[0].duration) > 0, 'Expected positive duration on parsed WAV track')
    return parsedTracks.length
  } finally {
    if (worker.connected) worker.disconnect()
    worker.kill()
  }
}

async function runNcmGatewaySmoke({ appRequire, appRoot }) {
  const serverEntry = appRequire.resolve('@neteasecloudmusicapienhanced/api/server.js')
  assertResolvedInsideApp(appRoot, serverEntry, '@neteasecloudmusicapienhanced/api/server.js')
  const ncmRequire = createRequire(serverEntry)

  const unblockEntry = ncmRequire.resolve('@neteasecloudmusicapienhanced/unblockmusic-utils')
  assertResolvedInsideApp(appRoot, unblockEntry, '@neteasecloudmusicapienhanced/unblockmusic-utils')
  ncmRequire('@neteasecloudmusicapienhanced/unblockmusic-utils')

  const originalReadFileSync = fs.readFileSync
  fs.readFileSync = function patchedReadFileSync(file, ...rest) {
    if (path.basename(String(file)) === 'anonymous_token') return ''
    return originalReadFileSync.call(this, file, ...rest)
  }

  const { eapiReqDecrypt } = ncmRequire('./util/crypto.js')
  const axiosModule = ncmRequire('axios')
  const originalAxiosDefault = axiosModule.default
  const logger = ncmRequire('./util/logger.js')
  const originalLoggerInfo = logger.info
  logger.info = () => {}

  let upstreamCalls = 0
  axiosModule.default = async (settings) => {
    upstreamCalls += 1
    let apiUrl = String((settings && settings.url) || '')
    if (settings && typeof settings.data === 'string' && settings.data.includes('params=')) {
      try {
        const params = new URLSearchParams(settings.data).get('params')
        const decoded = params ? eapiReqDecrypt(params) : null
        if (decoded && decoded.url) apiUrl = decoded.url
      } catch {
        // Non-eapi payload; fall back to default mock body.
      }
    }
    if (apiUrl === '/api/login/qrcode/unikey') {
      return { status: 200, headers: {}, data: { code: 200, unikey: 'packaged-smoke-key' } }
    }
    return { status: 200, headers: {}, data: { code: 200, profile: null, account: null } }
  }

  let ncmApp = null
  try {
    const { serveNcmApi } = ncmRequire('./server.js')
    ncmApp = await serveNcmApi({ host: '127.0.0.1', port: '0', checkVersion: false })
    if (!ncmApp.server.listening) {
      await new Promise((resolve, reject) => {
        ncmApp.server.once('listening', resolve)
        ncmApp.server.once('error', reject)
      })
    }
    const address = ncmApp.server.address()
    assert.ok(address && typeof address === 'object' && address.port > 0, 'Expected ephemeral NCM port')
    const baseUrl = 'http://127.0.0.1:' + address.port

    const statusGet = await fetch(baseUrl + '/login/status?timestamp=1', {
      signal: AbortSignal.timeout(10_000)
    })
    assert.equal(statusGet.status, 200, 'Expected GET /login/status to return 200')
    const statusGetBody = await statusGet.json()
    assert.equal(statusGetBody.data.code, 200)

    const qrKeyGet = await fetch(baseUrl + '/login/qr/key?timestamp=2', {
      signal: AbortSignal.timeout(10_000)
    })
    assert.equal(qrKeyGet.status, 200, 'Expected GET /login/qr/key to return 200')
    const qrKeyBody = await qrKeyGet.json()
    assert.equal(qrKeyBody.data.unikey, 'packaged-smoke-key')

    // POST JSON body exercises express.json() -> body-parser -> type-is -> media-typer.
    const statusPost = await fetch(baseUrl + '/login/status?timestamp=3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ cookie: 'MUSIC_U=smoke-session' }),
      signal: AbortSignal.timeout(10_000)
    })
    assert.equal(statusPost.status, 200, 'Expected POST /login/status with JSON body to return 200')
    const statusPostBody = await statusPost.json()
    assert.equal(statusPostBody.data.code, 200)
    assert.ok(upstreamCalls >= 3, 'Expected mocked upstream axios to serve all NCM requests offline')
    return 3
  } finally {
    fs.readFileSync = originalReadFileSync
    axiosModule.default = originalAxiosDefault
    logger.info = originalLoggerInfo
    if (ncmApp && ncmApp.server) {
      try {
        const cache = ncmRequire('./util/apicache')
        for (const key of [...cache.getIndex().all]) cache.clear(key)
      } catch {
        // Ignore cache cleanup errors when server failed early.
      }
      ncmApp.server.closeAllConnections?.()
      await new Promise((resolve) => ncmApp.server.close(() => resolve()))
    }
  }
}

function runMetadataLibrarySmoke({ appRequire, appRoot, wavPath }) {
  for (const pkg of ['music-metadata', 'strtok3', 'node-taglib-sharp']) {
    const resolved = appRequire.resolve(pkg)
    assertResolvedInsideApp(appRoot, resolved, pkg)
  }
  const taglib = appRequire('node-taglib-sharp')
  assert.equal(typeof taglib.ByteVector?.fromByteArray, 'function', 'node-taglib-sharp ByteVector missing')
  assert.equal(typeof taglib.File?.createFromPath, 'function', 'node-taglib-sharp File.createFromPath missing')
  assert.ok(taglib.Picture && taglib.PictureType, 'node-taglib-sharp Picture exports missing')
  const tagFile = taglib.File.createFromPath(wavPath)
  try {
    assert.ok(tagFile.properties.durationMilliseconds > 0, 'Expected positive WAV duration from node-taglib-sharp')
  } finally {
    tagFile.dispose()
  }
}

async function main() {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
  const { appRoot, tempDir, musicDir, coverCacheDir, wavPath, resultPath } = config
  const appRequire = createRequire(path.join(appRoot, 'package.json'))

  runMetadataLibrarySmoke({ appRequire, appRoot, wavPath })
  const scannedTracks = await runLibraryScanSmoke({ appRoot, tempDir, musicDir, coverCacheDir })
  const ncmRoutesChecked = await runNcmGatewaySmoke({ appRequire, appRoot })

  fs.writeFileSync(
    resultPath,
    JSON.stringify({ ok: true, scannedTracks, ncmRoutesChecked }),
    'utf8'
  )
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
`

function verifyPackagedRuntimeSmoke(
  targetPath,
  { runner = 'auto', requirePackagedExecutable = false, timeoutMs = 60_000 } = {}
) {
  const { asarPath, executablePath } = resolvePackagedRuntimeTarget(targetPath)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-packaged-smoke-'))
  try {
    assertNoAncestorNodeModules(tempDir)
    const musicDir = path.join(tempDir, 'music')
    const coverCacheDir = path.join(tempDir, 'covers')
    fs.mkdirSync(musicDir, { recursive: true })
    fs.mkdirSync(coverCacheDir, { recursive: true })
    const wavPath = path.join(musicDir, 'smoke-track.wav')
    fs.writeFileSync(wavPath, createPcmWaveBuffer())

    const useElectronBinary =
      runner === 'electron' || (runner === 'auto' && canRunPackagedExecutable(executablePath))
    if ((runner === 'electron' || requirePackagedExecutable) && !useElectronBinary) {
      throw new Error(
        `Packaged Electron executable is missing or not runnable on ${process.platform}/${process.arch}: ${executablePath || '(none)'}`
      )
    }

    let isolatedAppRoot
    let hostBinary
    let mode
    if (useElectronBinary) {
      const resourcesDir = path.join(tempDir, 'resources')
      fs.mkdirSync(resourcesDir, { recursive: true })
      isolatedAppRoot = path.join(resourcesDir, 'app.asar')
      fs.copyFileSync(asarPath, isolatedAppRoot)
      hostBinary = executablePath
      mode = 'electron-asar'
    } else {
      isolatedAppRoot = path.join(tempDir, 'extracted-app')
      asar.extractAll(asarPath, isolatedAppRoot)
      hostBinary = process.execPath
      mode = 'extracted-node'
    }

    const probeScriptPath = path.join(tempDir, 'run-smoke-probe.cjs')
    const configPath = path.join(tempDir, 'smoke-config.json')
    const resultPath = path.join(tempDir, 'smoke-result.json')
    fs.writeFileSync(probeScriptPath, SMOKE_PROBE_SOURCE, 'utf8')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        appRoot: isolatedAppRoot,
        tempDir,
        musicDir,
        coverCacheDir,
        wavPath,
        resultPath
      }),
      'utf8'
    )

    const execution = spawnSync(hostBinary, [probeScriptPath, configPath], {
      cwd: tempDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: ''
      },
      encoding: 'utf8',
      timeout: timeoutMs
    })

    if (execution.error) throw execution.error
    if (execution.status !== 0) {
      const details = [
        execution.stderr?.trim() && `stderr:\n${execution.stderr.trim()}`,
        execution.stdout?.trim() && `stdout:\n${execution.stdout.trim()}`
      ]
        .filter(Boolean)
        .join('\n')
      throw new Error(
        `Packaged runtime smoke failed (mode=${mode}, status=${execution.status}):\n${details}`
      )
    }

    const summary = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    return {
      mode,
      asarPath,
      executablePath: useElectronBinary ? executablePath : null,
      scannedTracks: summary.scannedTracks,
      ncmRoutesChecked: summary.ncmRoutesChecked
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

function main(args = process.argv.slice(2)) {
  let runner = 'auto'
  let requirePackagedExecutable = false
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--require-executable') {
      requirePackagedExecutable = true
      continue
    }
    if (arg === '--runner') {
      runner = args[++i] || 'auto'
      continue
    }
    if (arg.startsWith('--runner=')) {
      runner = arg.slice('--runner='.length)
      continue
    }
    positional.push(arg)
  }
  assert.equal(
    positional.length,
    1,
    'Usage: node scripts/verify-packaged-runtime-smoke.cjs [--runner auto|electron|node] [--require-executable] <app-dir|App.app|app.asar>'
  )
  const result = verifyPackagedRuntimeSmoke(positional[0], {
    runner,
    requirePackagedExecutable
  })
  console.log(
    `Packaged runtime smoke verified (${result.mode}): ${result.scannedTracks} scanned track, ${result.ncmRoutesChecked} NCM routes`
  )
}

if (require.main === module) main()

module.exports = {
  assertNoAncestorNodeModules,
  canRunPackagedExecutable,
  createPcmWaveBuffer,
  resolvePackagedRuntimeTarget,
  verifyPackagedRuntimeSmoke
}
