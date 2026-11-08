'use strict'
const { app, BrowserWindow, utilityProcess, dialog, nativeImage } = require('electron')
const {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  openSync,
  writeSync,
  closeSync
} = require('node:fs')
const { join, basename } = require('node:path')
const { pathToFileURL } = require('node:url')
const { freemem } = require('node:os')
const assert = require('node:assert/strict')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const profile = join(config.directory, 'profile'),
  sampleDir = join(config.directory, 'heaps')
mkdirSync(profile, { recursive: true })
mkdirSync(sampleDir, { recursive: true })
app.setPath('userData', profile)
app.getAppPath = () => config.buildRoot
const report = {
  status: 'running',
  startedAt: Date.now(),
  roles: { [process.pid]: 'main' },
  phases: [],
  events: [],
  errors: [],
  settings: {
    width: 1280,
    height: 939,
    theme: 'pureWhite',
    gpuEnabled: true,
    forcedGc: false,
    scenario: config.scenario ?? 'full',
    coreHost: config.coreHost ?? 'electron',
    sandbox: !config.diagnosticNoSandbox,
    acceptanceEligible: !config.diagnosticNoSandbox && config.scenario !== 'steady',
    provider: 'deterministic fixture through real plugin host',
    library: 'synthetic metadata; one real silent WAV'
  }
}
let currentPhase = null,
  finished = false,
  win,
  core,
  epoch,
  snapshot,
  serial = 0,
  sampling = false
const children = new Set(),
  pending = new Map()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function save() {
  writeFileSync(join(config.directory, 'run.json'), JSON.stringify(report, null, 2))
}
function checkMemory() {
  if (freemem() < config.minFreeBytes)
    throw Object.assign(Error('Available physical memory fell below 1 GiB'), {
      code: 'MEMORY_PRESSURE'
    })
}
async function until(read, name, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (finished) throw Error('Benchmark stopped')
    checkMemory()
    const result = await read()
    if (result) return result
    await pause(100)
  }
  throw Error(`Timed out: ${name}`)
}
function seed() {
  const media = join(profile, 'media'),
    covers = join(profile, 'music-cache', 'cover-cache')
  mkdirSync(media, { recursive: true })
  mkdirSync(covers, { recursive: true })
  const duration = Math.max(
    config.soakSeconds + config.cycles * 10 + config.settleSeconds * 12 + 600,
    3600
  )
  const bytes = 8000 * 2 * duration,
    header = Buffer.alloc(44)
  header.write('RIFF')
  header.writeUInt32LE(bytes + 36, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(16000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(bytes, 40)
  const wav = join(media, 'silence.wav'),
    file = openSync(wav, 'w'),
    block = Buffer.alloc(65536)
  writeSync(file, header)
  for (let written = 0; written < bytes; written += block.length)
    writeSync(file, block, 0, Math.min(block.length, bytes - written))
  closeSync(file)
  for (let i = 0; i < 12; i++) {
    const pixels = Buffer.alloc(500 * 500 * 4)
    for (let p = 0; p < pixels.length; p += 4) {
      pixels[p] = 65 + i * 10
      pixels[p + 1] = 110
      pixels[p + 2] = 180 - i * 8
      pixels[p + 3] = 255
    }
    writeFileSync(
      join(covers, `memory-${i}.png`),
      nativeImage.createFromBitmap(pixels, { width: 500, height: 500 }).toPNG()
    )
  }
  const library = openSync(join(profile, 'music-library.json'), 'w')
  writeSync(
    library,
    `{"version":2,"revision":1,"folders":[${JSON.stringify(media)}],"exclusions":[],"tracks":[`
  )
  for (let i = 0; i < config.size; i++) {
    if (i % 200 === 0) checkMemory()
    writeSync(
      library,
      (i ? ',' : '') +
        JSON.stringify({
          id: `memory-local-${i}`,
          title: `Memory song ${String(i).padStart(6, '0')}`,
          artist: `Artist ${i % 100}`,
          album: `Album ${Math.floor(i / 12)}`,
          genre: 'Ambient',
          duration: i === 0 ? duration : 180,
          size: i === 0 ? bytes + 44 : 1000000,
          sampleRate: 8000,
          bitDepth: 16,
          format: 'WAV',
          source: 'local',
          filePath: i === 0 ? wav : join(profile, 'synthetic-library', `synthetic-${i}.wav`),
          cover: `cover://memory-${i % 12}.png`,
          addedAt: 1000 + i
        })
    )
  }
  writeSync(library, ']}')
  closeSync(library)
  writeFileSync(
    join(profile, 'settings.json'),
    JSON.stringify({
      onboardingCompleted: true,
      startupHomePage: 'local',
      theme: 'pureWhite',
      libraryFolders: [media],
      watchLibrary: false,
      musicIdentification: { newImports: false, history: false, sources: [], setup: 'declined' },
      launchAtLogin: false,
      playbackResumeMode: 'off',
      onlineLyricsFallback: false,
      closeWindowBehavior: 'tray',
      autoCheckUpdate: false,
      streamingActiveProvider: 'memory',
      smtcEnabled: false,
      softwareVolume: 0.7,
      audioProcessing: { volumeNormalization: 'off' }
    })
  )
  writeFileSync(
    join(profile, 'window-state.json'),
    JSON.stringify({ width: 1280, height: 939, maximized: false, fullScreen: false })
  )
}
const identity = {
  id: 'memory-benchmark',
  role: 'desktop',
  permissions: [
    'playback:read',
    'playback:write',
    'library:read',
    'library:write',
    'statistics:read',
    'settings:read',
    'settings:write',
    'migration:write',
    'plugins:read',
    'providers:call'
  ]
}
const fork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (entry, args, options = {}) => {
  const child = fork(join(config.root, 'scripts/memory-utility-wrapper.cjs'), args, {
    ...options,
    env: {
      ...(options.env ?? process.env),
      TWILIGHT_MEMORY_ORIGINAL_ENTRY: entry,
      TWILIGHT_MEMORY_SAMPLE_DIR: sampleDir
    }
  })
  const send = child.postMessage.bind(child)
  observeChild(child, options.serviceName ?? basename(entry), child, (transform) => {
    child.postMessage = (message, ports) => {
      transform(message)
      return send(message, ports)
    }
  })
  return child
}
require('./memory-node-observer.cjs').observeNodeSpawns({
  childProcess: require('node:child_process'),
  scriptsRoot: join(config.root, 'scripts'),
  sampleDir,
  observe: observeChild,
  codec: config.coreHost === 'node' ? require(config.supervisionCodecPath) : undefined
})
function observeChild(child, role, peer, intercept, decode = (value) => value) {
  children.add(child)
  child.once('spawn', () => {
    report.roles[child.pid] = role
  })
  child.once('exit', (code) => {
    children.delete(child)
    report.events.push({
      timestamp: Date.now(),
      event: 'utility-exit',
      role,
      code
    })
  })
  intercept((message) => {
    if (role === 'twilight-core' && message.kind === 'core:initialize') {
      epoch = message.configuration.epoch
      message.configuration.plugins.bundledPlugins = [
        {
          id: 'com.twilightecho.fixture.memory',
          sourcePath: join(config.root, 'scripts/fixtures/memory-provider'),
          defaultEnabled: true
        }
      ]
    }
  })
  if (role === 'twilight-core') {
    core = peer
    child.on('message', (wire) => {
      const message = decode(wire)
      if (message.kind === 'core:initialized') peer.postMessage({ kind: 'core:connect', identity })
      if (message.kind === 'core:fatal') void finish(Error(message.error))
      if (message.kind !== 'core:client-message' || message.clientId !== identity.id) return
      const item = message.message
      if (item.kind === 'state') snapshot = item.snapshot
      if (item.kind === 'response') {
        const job = pending.get(item.requestId)
        if (job) {
          pending.delete(item.requestId)
          clearTimeout(job.timer)
          item.ok
            ? job.resolve(item.value)
            : job.reject(Object.assign(Error(item.error.message), item.error))
        }
      }
    })
  }
}
function request(kind, name, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = `memory-${++serial}`
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(Error(`Timed out: ${name}`))
    }, 120000)
    pending.set(requestId, { resolve, reject, timer })
    core.postMessage({
      kind: 'core:request',
      clientId: identity.id,
      request: { kind, name, payload, requestId, epoch }
    })
  })
}
async function mountedWindow() {
  const result = await until(
    () =>
      BrowserWindow.getAllWindows().find(
        (w) =>
          w.webContents.getURL().includes('index.html') &&
          !w.webContents.getURL().includes('window=')
      ),
    'main window'
  )
  await until(
    async () =>
      !result.webContents.isLoading() &&
      (await result.webContents.executeJavaScript(
        "Boolean(document.getElementById('app')?.__vue_app__)"
      )),
    'Vue mount'
  )
  result.setContentSize(1280, 939)
  result.show()
  return result
}
async function sample() {
  if (sampling || finished) return
  sampling = true
  try {
    checkMemory()
    const utilities = []
    for (const child of children) {
      try {
        const value = JSON.parse(readFileSync(join(sampleDir, `${child.pid}.json`), 'utf8'))
        if (Date.now() - value.timestamp < 6000) utilities.push(value)
      } catch {
        /* a write or process startup can overlap this read */
      }
    }
    const renderers = []
    for (const window of BrowserWindow.getAllWindows()) {
      const contents = window.webContents
      if (contents.isDestroyed() || contents.isLoading()) continue
      try {
        if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
        const heap = await contents.debugger.sendCommand('Runtime.getHeapUsage')
        const dom = await contents.debugger.sendCommand('Memory.getDOMCounters')
        renderers.push({ pid: contents.getOSProcessId(), heap, dom })
      } catch (error) {
        if (!contents.isDestroyed())
          report.errors.push({ kind: 'renderer-sample', message: error.message })
      }
    }
    const metrics = app.getAppMetrics()
    for (const m of metrics) report.roles[m.pid] ??= m.type
    require('node:fs').appendFileSync(
      join(config.directory, 'runtime.jsonl'),
      JSON.stringify({
        timestamp: Date.now(),
        phase: currentPhase?.name,
        main: { pid: process.pid, ...process.memoryUsage() },
        utilities,
        renderers,
        metrics,
        playback: snapshot?.playback && {
          state: snapshot.playback.state,
          position: snapshot.playback.position,
          queueToken: snapshot.playback.queueToken,
          nativePlaybackActive: snapshot.playback.nativePlaybackActive,
          renderPerformance: snapshot.playback.renderPerformance
        },
        freePhysicalBytes: freemem()
      }) + '\n'
    )
  } catch (error) {
    void finish(error)
  } finally {
    sampling = false
  }
}
async function phase(name, action, dwell = config.settleSeconds * 1000) {
  currentPhase = { name, start: Date.now() }
  report.phases.push(currentPhase)
  console.log('[memory-phase]', name)
  const started = performance.now()
  await action?.()
  currentPhase.actionMs = performance.now() - started
  await pause(dwell)
  checkMemory()
  currentPhase.end = Date.now()
  save()
}
async function js(code) {
  return win.webContents.executeJavaScript(code, true)
}
const visibleElement = `(selector) => [...document.querySelectorAll(selector)].find(element =>
  element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
  !element.closest('[inert]'))`
async function visible(selector) {
  return js(`Boolean((${visibleElement})(${JSON.stringify(selector)}))`)
}
async function rendered(selector) {
  win.moveTop()
  win.focus()
  await until(() => visible(selector), `visible ${selector}`)
  await until(
    () =>
      js(`(() => {
        const element = (${visibleElement})(${JSON.stringify(selector)})
        return element && !document.getAnimations().some(animation =>
          animation.playState === 'running' &&
          animation.effect?.target === element &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime))
      })()`),
    `finished transitions for ${selector}`
  )
}
async function navigate(id) {
  if (!(await visible('.side-menu.open'))) await click('.title-bar .menu-btn')
  await until(
    () => js(`Boolean(document.querySelector('[data-page-id="${id}"]'))`),
    `navigation ${id}`
  )
  await js(`(() => {
    const group = document.querySelector('[data-page-id="${id}"]').closest('.menu-group')
    if (group && !group.classList.contains('expanded')) group.querySelector('.menu-group-toggle').click()
  })()`)
  await click(`[data-page-id="${id}"]`)
  await until(
    () =>
      js(
        `document.querySelector('[data-page-id="${id}"]')?.getAttribute('aria-current') === 'page'`
      ),
    `active navigation ${id}`
  )
  if (await visible('.side-menu.open')) await click('.title-bar .menu-btn')
  await rendered(id.startsWith('streaming-') ? '.streaming-page' : '.song-list')
}
async function click(selector) {
  await until(() => visible(selector), `clickable ${selector}`)
  await js(`(${visibleElement})(${JSON.stringify(selector)}).click()`)
}
async function screenshot(name) {
  win.moveTop()
  win.focus()
  let timeout
  await Promise.race([
    js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(Error('Foreground paint did not complete')), 5000)
    })
  ]).finally(() => clearTimeout(timeout))
  // Capture only after the foreground compositor has painted the new view.
  writeFileSync(
    join(config.directory, `${name}.png`),
    (await win.webContents.capturePage()).toPNG()
  )
}
async function finish(error) {
  if (finished) return
  finished = true
  if (currentPhase && !currentPhase.end) {
    currentPhase.end = Date.now()
    currentPhase.incomplete = true
  }
  report.status = error
    ? error.code === 'MEMORY_PRESSURE'
      ? 'memory-pressure'
      : 'failed'
    : 'complete'
  if (error) {
    report.error = error.stack ?? String(error)
    console.error(report.error)
    save()
    if (win && !win.isDestroyed()) await screenshot('failure').catch(() => {})
  }
  report.finishedAt = Date.now()
  save()
  for (const item of pending.values()) clearTimeout(item.timer)
  for (const w of BrowserWindow.getAllWindows()) w.destroy()
  app.quit()
  setTimeout(() => {
    for (const child of children) child.kill()
    app.exit(error ? 1 : 0)
  }, 5000).unref()
}
dialog.showErrorBox = (title, text) => {
  void finish(Error(`${title}: ${text}`))
}
app.on('web-contents-created', (_event, contents) => {
  contents.on('preload-error', (_event, _path, error) => {
    void finish(error)
  })
  contents.on('render-process-gone', (_event, details) => {
    if (!finished && details.reason !== 'clean-exit')
      void finish(
        Error(
          `Renderer ${details.reason}; exitCode=${details.exitCode}; sandbox=${!config.diagnosticNoSandbox}`
        )
      )
  })
})
async function main() {
  setTimeout(
    () => void finish(Error('Benchmark exceeded its scenario deadline')),
    (config.soakSeconds + config.settleSeconds * 12 + config.cycles * 15 + 900) * 1000
  ).unref()
  seed()
  currentPhase = { name: 'cold-start', start: Date.now() }
  report.phases.push(currentPhase)
  require(join(config.buildRoot, 'out/main/index.js'))
  await app.whenReady()
  setInterval(() => void sample(), 2000).unref()
  setInterval(() => {
    try {
      checkMemory()
    } catch (error) {
      void finish(error)
    }
  }, 1000).unref()
  win = await mountedWindow()
  await until(
    () => snapshot?.phase === 'ready' && !snapshot.migrationRequired,
    'Core ready',
    300000
  )
  const metadata = await request('query', 'library.metadata')
  assert.equal(metadata.trackCount, config.size)
  report.environment = await js('({dpr:devicePixelRatio,width:innerWidth,height:innerHeight})')
  report.environment.gpu = app.getGPUFeatureStatus()
  report.providers = await request('query', 'providers.list')
  assert.ok(
    report.providers.some(
      (provider) => provider.id === 'memory' && provider.health?.available !== false
    ),
    'fixture provider registration'
  )
  currentPhase.end = Date.now()
  save()
  await phase('idle', async () => {
    await navigate('allSongs')
    if (config.scenario !== 'steady') await screenshot('library')
  })
  await phase(
    'playing',
    async () => {
      const staged = await request('command', 'queue.submit', {
        kind: 'begin',
        selectedIndex: 0,
        play: true
      })
      await request('command', 'queue.submit', {
        kind: 'append',
        id: staged.id,
        sequence: 1,
        items: [{ kind: 'local', id: 'memory-local-0' }]
      })
      await request('command', 'queue.submit', { kind: 'commit', id: staged.id, sequence: 2 })
      await until(
        () => snapshot?.playback?.state === 'playing' && snapshot.playback.position > 0.2,
        'native playback'
      )
      if (config.scenario === 'steady') report.steadyPlaybackStart = snapshot.playback
    },
    config.scenario === 'steady' ? config.soakSeconds * 1000 : undefined
  )
  if (config.scenario === 'steady') {
    report.steadyPlaybackEnd = snapshot.playback
    assert.equal(snapshot.playback.state, 'playing')
    assert.ok(
      snapshot.playback.position - report.steadyPlaybackStart.position >= config.soakSeconds * 0.9,
      'native playback must advance throughout the steady phase'
    )
    await phase('paused', () => request('command', 'playback.pause'))
    assert.equal(snapshot.playback.state, 'paused')
    await finish()
    return
  }
  await phase('bulk-favorites', async () => {
    const assets = join(config.buildRoot, 'out/renderer/assets')
    const file = readdirSync(assets).find(
      (name) =>
        name.endsWith('.js') &&
        /function useMusicStore\(/.test(readFileSync(join(assets, name), 'utf8'))
    )
    assert.ok(file, 'production music store module')
    const text = readFileSync(join(assets, file), 'utf8'),
      exported = /useMusicStore as ([\w$]+)/.exec(text)?.[1] ?? 'useMusicStore'
    const url = pathToFileURL(join(assets, file)).href
    report.bulk = await js(
      `(async()=>{ const module=await import(${JSON.stringify(url)}); const store=module[${JSON.stringify(exported)}](); const start=performance.now(); const result=await store.readFavoriteTrackPages(async append=>{for(let offset=0;offset<${config.size};offset+=200){const page=await store.queryTracks({sort:'insertion',offset,limit:200});await append(page.tracks)}}); return { ...result, durationMs:performance.now()-start }; })()`
    )
    assert.equal(report.bulk.count, config.size)
  })
  await phase('navigation', async () => {
    for (let i = 0; i < config.cycles; i++) {
      const start = performance.now()
      await navigate(i % 2 ? 'albums' : 'artists')
      await navigate('allSongs')
      report.events.push({
        event: 'navigation-cycle',
        cycle: i,
        timestamp: Date.now(),
        durationMs: performance.now() - start
      })
    }
    await screenshot('after-navigation')
  })
  await phase('streaming', async () => {
    await navigate('streaming-home')
    await rendered('.streaming-page .music-playlist')
    for (let i = 0; i < config.cycles; i++) {
      const start = performance.now()
      await click('.streaming-page .music-playlist')
      await rendered('.streaming-page .detail-view')
      await until(
        () =>
          js(
            'Boolean(document.querySelector(".detail-view")) && document.body.innerText.includes("Fixture track")'
          ),
        'playlist details'
      )
      if (i === config.cycles - 1) await screenshot('streaming-detail')
      await click('.title-bar-back .back-btn')
      await rendered('.streaming-page .music-playlist')
      report.events.push({
        event: 'streaming-cycle',
        cycle: i,
        timestamp: Date.now(),
        durationMs: performance.now() - start
      })
    }
    await screenshot('streaming')
  })
  await phase('player-dsp', async () => {
    await navigate('allSongs')
    for (let i = 0; i < config.cycles; i++) {
      const start = performance.now()
      await click('[title="打开播放页面"]')
      await rendered('.playing-music')
      if (i === config.cycles - 1) await screenshot('playing-page')
      await click('.title-bar-back .back-btn')
      await click('[aria-label="DSP 工作台"]')
      await rendered('.audio-workspace')
      if (i === config.cycles - 1) await screenshot('dsp-workspace')
      await click('[aria-label="DSP 工作台"]')
      await rendered('.song-list')
      report.events.push({
        event: 'player-dsp-cycle',
        cycle: i,
        timestamp: Date.now(),
        durationMs: performance.now() - start
      })
    }
    await screenshot('player-dsp')
  })
  await phase('returned-idle', () => navigate('allSongs'))
  await phase(
    'soak',
    async () => {
      report.soakStart = snapshot.playback
    },
    config.soakSeconds * 1000
  )
  report.soakEnd = snapshot.playback
  report.soakElapsedMs = currentPhase.end - currentPhase.start
  assert.equal(report.soakEnd.state, 'playing')
  assert.ok(
    report.soakEnd.position - report.soakStart.position >= (report.soakElapsedMs / 1000) * 0.9,
    'native playback must advance throughout the soak'
  )
  await phase('afterglow', async () => {
    const before = snapshot.playback.position
    // The window disappears before an IPC/evaluate reply can reach its caller.
    // Observe the real window lifetime instead of waiting on the destroyed renderer.
    void js('void window.api.app.afterglow.enter(); true').catch((error) => {
      if (!win.isDestroyed()) void finish(error)
    })
    await until(
      () =>
        !BrowserWindow.getAllWindows().some(
          (w) =>
            w.webContents.getURL().includes('/index.html') &&
            !w.webContents.getURL().includes('window=')
        ),
      'Afterglow unload'
    )
    await pause(1000)
    assert.ok(snapshot.playback.position > before)
  })
  await phase('restored', async () => {
    app.emit('activate')
    win = await mountedWindow()
    await until(
      () =>
        js(
          'Boolean(document.querySelector(".song-list")) && Boolean(document.querySelector(".player-bar"))'
        ),
      'restored library and playing track'
    )
    assert.equal(snapshot.playback.state, 'playing')
    await rendered('.song-list')
    await screenshot('restored')
  })
  await phase('paused', () => request('command', 'playback.pause'))
  assert.equal(snapshot.playback.state, 'paused')
  await finish()
}
main().catch(finish)
