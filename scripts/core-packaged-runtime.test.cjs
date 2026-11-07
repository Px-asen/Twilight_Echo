'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { existsSync } = require('node:fs')
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const test = require('node:test')

test(
  'unmodified Windows package keeps its real Core and native audio alive without renderer ownership',
  {
    skip: process.platform !== 'win32',
    timeout: 180_000
  },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-packaged-'))
    const profile = join(directory, 'profile')
    try {
      await prepareProfile(profile)
      for (const phase of ['first', 'cold'])
        await runPackage(
          join(process.env.TWILIGHT_PACKAGED_APP_DIR || join(root, 'dist', 'win-unpacked'), 'TwilightEcho.exe'),
          directory,
          bootstrap.replace(
            '__TEST_CONFIGURATION__',
            JSON.stringify({
              profile,
              phase,
              directory,
              metadataEvidence: join(root, '.local', 'metadata-release-preview'),
              screenshot: join(root, '.core-packaged-render.png')
            })
          )
        )
      const first = JSON.parse(await readFile(join(directory, 'first.json'), 'utf8'))
      const cold = JSON.parse(await readFile(join(directory, 'cold.json'), 'utf8'))
      assert.equal(first.packaged, true)
      assert.equal(first.rebuilds, 2)
      assert.equal(first.coreProcesses, 1)
      assert.equal(first.zeroWindowPlayback, true)
      assert.equal(first.replayedTransport, 0)
      assert.equal(first.rendererCommandsOnRebuild, 0)
      assert.equal(first.migrationCommits, 1)
      assert.equal(first.metadataSetup.declined, true)
      assert.equal(first.metadataSetup.accepted.setup, 'accepted')
      assert.equal(first.metadataSetup.accepted.newImports, true)
      assert.equal(first.metadataSetup.accepted.history, true)
      assert.equal(first.metadataSetup.accepted.ncmLocalFallback, true)
      for (const source of ['musicbrainz', 'vocadb', 'theaudiodb', 'discogs', 'platform.ncm'])
        assert.ok(first.metadataSetup.accepted.sources.includes(source))
      assert.ok(first.metadataSetup.jobs > 0)
      assert.deepEqual(cold.metadataSetup, first.metadataSetup.accepted)
      assert.match(first.nativeAddon, /resources[\\/]audio-engine[\\/]twilight_audio_node\.node$/)
      assert.equal(cold.migrationCommits, 0)
      assert.equal(cold.state, 'paused')
      assert.equal(cold.occurrenceId, first.occurrenceId)
      assert.ok(Math.abs(cold.position - first.position) < 1)
      assert.deepEqual(cold.transportMethods, [])
      for (const result of [first, cold]) {
        assert.equal(result.gracefulExit, true)
        assert.equal(result.liveServicesAtExit, 0)
        assert.deepEqual(result.failures, [])
        assert.deepEqual(result.rendererErrors, [])
      }
      await writeFile(
        join(root, '.core-packaged-result.json'),
        JSON.stringify({ first, cold }, null, 2)
      )
    } finally {
      const runtimeLog = join(directory, 'runtime.log')
      if (existsSync(runtimeLog))
        await writeFile(join(root, '.core-packaged-main.log'), await readFile(runtimeLog, 'utf8'))
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-packaged-'))
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
)

async function prepareProfile(profile) {
  const music = join(profile, 'music')
  await mkdir(music, { recursive: true })
  const dataSize = 8000 * 2 * 180,
    wave = Buffer.alloc(44 + dataSize)
  wave.write('RIFF')
  wave.writeUInt32LE(wave.length - 8, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(8000, 24)
  wave.writeUInt32LE(16000, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(dataSize, 40)
  await writeFile(join(music, 'silence.wav'), wave)
  await writeFile(
    join(profile, 'music-library.json'),
    JSON.stringify({
      version: 2,
      revision: 0,
      folders: [music],
      exclusions: [],
      tracks: [
        {
          id: 'packaged-silence',
          title: 'Packaged silence',
          artist: 'Core integration',
          album: 'Renderer lifecycle',
          duration: 180,
          filePath: join(music, 'silence.wav'),
          source: 'local'
        }
      ]
    })
  )
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({
      onboardingCompleted: true,
      libraryFolders: [music],
      launchAtLogin: false,
      playbackResumeMode: 'trackAndPosition',
      onlineLyricsFallback: false,
      closeWindowBehavior: 'tray',
      autoCheckUpdate: false,
      smtcEnabled: false,
      audioProcessing: { loudnormEnabled: false }
    })
  )
}

async function runPackage(executable, directory, expression) {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'TWILIGHT_DEV_USER_DATA_DIR'])
    delete env[key]
  for (const key of Object.keys(env).filter(
    (key) => key.startsWith('TWILIGHT_METADATA_') || key === 'TWILIGHT_DEV_METADATA_SETUP_FILE'
  ))
    delete env[key]
  const child = spawn(executable, ['--inspect-brk=127.0.0.1:0'], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = '',
    closed = false,
    socket
  const exit = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      closed = true
      resolveExit({ code, signal })
    })
  })
  child.stdout.on('data', (data) => process.stdout.write(data))
  child.stderr.on('data', (data) => {
    stderr += data
    process.stderr.write(data)
  })
  const timer = setTimeout(() => child.kill(), 80_000)
  try {
    const endpoint = await waitFor(() => {
      assert.equal(
        closed,
        false,
        'Package exited before inspector attachment (' +
          child.exitCode +
          '/' +
          child.signalCode +
          '):\n' +
          stderr
      )
      return stderr.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]
    }, 'packaged main inspector')
    socket = new WebSocket(endpoint)
    await once(socket, 'open')
    const pending = new Map(),
      events = new Map()
    let serial = 0
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.id) {
        const item = pending.get(message.id)
        if (!item) return
        pending.delete(message.id)
        message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result)
      } else events.get(message.method)?.(message.params)
    })
    const send = (method, params = {}) =>
      new Promise((resolveCall, reject) => {
        const id = ++serial
        pending.set(id, { resolve: resolveCall, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    await send('Runtime.enable')
    await send('Debugger.enable')
    const paused = new Promise((resolvePause) => events.set('Debugger.paused', resolvePause))
    await send('Runtime.runIfWaitingForDebugger')
    const event = await paused
    const evaluation = await send('Debugger.evaluateOnCallFrame', {
      callFrameId: event.callFrames[0].callFrameId,
      expression,
      returnByValue: true
    })
    assert.equal(evaluation.exceptionDetails, undefined, JSON.stringify(evaluation))
    assert.equal(evaluation.result.value, 'packaged acceptance armed')
    await send('Debugger.resume')
    socket.close()
    const result = await exit
    assert.equal(result.code, 0, 'Packaged runtime failed:\n' + stderr)
    assert.equal(result.signal, null)
  } finally {
    clearTimeout(timer)
    socket?.close()
    if (!closed) {
      child.kill()
      await exit
    }
  }
}

async function waitFor(read, label) {
  for (let i = 0; i < 600; i++) {
    const value = await read()
    if (value) return value
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw Error('Timed out: ' + label)
}

// Injected only through the local Node inspector before the real packaged entry.
// The product, its service registry, preload, native modules and renderer are unmodified.
const bootstrap = String.raw`(() => {
  const require = process.getBuiltinModule('node:module').createRequire(process.execPath)
  const { app, BrowserWindow, utilityProcess, MessageChannelMain, dialog } = require('electron')
  const { writeFileSync, appendFileSync, mkdirSync } = require('node:fs')
  const { join } = require('node:path')
  const assert = require('node:assert/strict')
  const { profile, phase, directory, screenshot, metadataEvidence } = __TEST_CONFIGURATION__
  assert.equal(app.isReady(), false, 'Profile must be isolated before Electron is ready')
  app.setPath('userData', profile)
  mkdirSync(join(profile,'logs'),{recursive:true});app.setPath('logs',join(profile,'logs'))
  process.env.TWILIGHT_LOG_DIRECTORY=join(profile,'logs','diagnostics')
  const log=(...args)=>appendFileSync(join(directory,'runtime.log'),args.map(String).join(' ')+'\n')
  log('packaged acceptance bootstrap',phase,profile)
  // Node workers otherwise inherit the test-only --inspect-brk attachment.
  const workers=require('node:worker_threads'),Worker=workers.Worker
  workers.Worker=class extends Worker {
    constructor(entry,options) {
      super(entry,{...options,execArgv:[]})
    }
  }
  app.disableHardwareAcceleration()
  assert.equal(app.isPackaged, true)
  assert.equal(app.getPath('userData'), profile)
  const children = new Set(), transportMethods = [], commands = [], pending = new Map()
  const failures = [], rendererErrors = [], relays = []
  let core, epoch, snapshot, nativeAddon, coreProcesses = 0, requestSerial = 0, result
  const identity = { id:'packaged-acceptance', role:'desktop', permissions:[
    'playback:read','playback:write','library:read','library:write',
    'statistics:read','settings:read','settings:write','migration:write'
  ] }
  const fork = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (entry, args, options) => {
    assert.ok(entry.startsWith(join(process.resourcesPath, 'app.asar', 'out', 'main')),
      'Service must use the packaged entry: ' + entry)
    const child = fork(entry, args, options)
    child.stdout?.on('data',data=>log(options?.serviceName,data))
    child.stderr?.on('data',data=>log(options?.serviceName,data))
    children.add(child); child.once('exit', () => children.delete(child))
    const send = child.postMessage.bind(child)
    child.postMessage = (message, ports) => {
      if (options?.serviceName === 'twilight-core') {
        if (message.kind === 'core:initialize') epoch = message.configuration.epoch
        if (message.kind === 'core:request' && message.request.kind === 'command')
          commands.push({ clientId:message.clientId, name:message.request.name })
      }
      if (options?.serviceName === 'twilight-audio' && message.kind === 'core:attach-service') {
        const original = ports[0], { port1, port2 } = new MessageChannelMain()
        original.on('message', ({ data }) => {
          if (data.kind === 'request' && ['Play','Seek','LoadQueue'].includes(data.method))
            transportMethods.push(data.method)
          port1.postMessage(data)
        })
        port1.on('message', ({ data }) => {
          if (data.kind === 'ready') nativeAddon = data.capabilities.nativeRuntime.addonPath
          original.postMessage(data)
        })
        original.start();port1.start();relays.push(original,port1)
        return send(message,[port2])
      }
      return send(message,ports)
    }
    if (options?.serviceName === 'twilight-core') {
      core = child; coreProcesses++
      child.on('message', message => {
        if (message.kind === 'core:initialized') child.postMessage({kind:'core:connect',identity})
        if (message.kind === 'core:fatal') failures.push(message.error)
        if (message.kind !== 'core:client-message' || message.clientId !== identity.id) return
        const item = message.message
        if (item.kind === 'state') snapshot = item.snapshot
        if (item.kind === 'response') {
          const job = pending.get(item.requestId)
          if (!job) return
          pending.delete(item.requestId);clearTimeout(job.timer)
          item.ok ? job.resolve(item.value) : job.reject(Object.assign(Error(item.error.message),item.error))
        }
      })
    }
    return child
  }
  dialog.showErrorBox = (title, content) => { console.error(title,content);app.exit(1) }
  app.on('web-contents-created', (_event, contents) => {
    contents.on('did-fail-load',(_event,code,message,url)=>failures.push(code+' '+message+' '+url))
    contents.on('preload-error', (_event, _path, error) => failures.push(error.stack))
    contents.on('render-process-gone',(_event,details)=>failures.push('renderer: '+JSON.stringify(details)))
    contents.on('console-message', details => {
      if (details.level === 'error') {rendererErrors.push(details.message);console.error('[renderer]',details.message)}
    })
  })
  app.on('will-quit', () => {
    if (result) writeFileSync(join(directory,phase+'.json'),JSON.stringify({
      ...result,packaged:app.isPackaged,gracefulExit:true,liveServicesAtExit:children.size,failures,rendererErrors
    }))
  })
  const pause = ms => new Promise(resolve => setTimeout(resolve,ms))
  async function until(read,label) {
    for (let i=0;i<600;i++) {
      assert.deepEqual(failures,[],label)
      const value=await read()
      if(value) return value
      await pause(50)
    }
    throw Error('Timed out: '+label+'\n'+rendererErrors.join('\n')+'\n'+JSON.stringify({
      windows:BrowserWindow.getAllWindows().map(win=>({id:win.id,url:win.webContents.getURL(),loading:win.webContents.isLoading()})),
      coreProcesses,epoch,snapshot:snapshot?.phase
    }))
  }
  function request(kind,name,payload={}) {
    const requestId='packaged-'+ ++requestSerial
    return new Promise((resolve,reject) => {
      const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Timed out: '+name))},15000)
      pending.set(requestId,{resolve,reject,timer})
      core.postMessage({kind:'core:request',clientId:identity.id,request:{kind,name,payload,requestId,epoch}})
    })
  }
  async function mountedWindow() {
    const win=await until(()=>BrowserWindow.getAllWindows().find(item=>
      item.webContents.getURL().includes('index.html') && !item.webContents.getURL().includes('window=')),'main window')
    await until(async()=>!win.webContents.isLoading() && await win.webContents.executeJavaScript(
      "Boolean(document.getElementById('app')?.__vue_app__)"),'packaged Vue mount')
    return win
  }
  async function main() {
    await app.whenReady()
    let win=await mountedWindow()
    await until(()=>snapshot?.phase==='ready' && !snapshot.migrationRequired,'packaged Core ready')
    assert.equal((await request('query','migration.status')).complete,true)
    if(phase==='cold') {
      const state=await request('query','state.snapshot')
      const metadataSetup=(await request('query','settings.state')).settings.musicIdentification
      await pause(300)
      assert.equal(await win.webContents.executeJavaScript("Boolean(document.querySelector('.metadata-setup[open]'))"),false)
      result={state:state.playback.state,occurrenceId:state.queue.occurrenceId,position:state.playback.position,
        migrationCommits:commands.filter(row=>row.name==='migration.commit').length,transportMethods,metadataSetup}
      for(const window of BrowserWindow.getAllWindows()) window.destroy()
      app.quit();return
    }
    const policy=await until(async()=>{
      const p=await request('query','metadata.entity.policy')
      return p.sources?.some(source=>source.provider==='platform.ncm' && source.enrichment.some(c=>c.kind==='artist' && !c.reason)) && p
    },'packaged NCM metadata capabilities')
    assert.equal(policy.enabled,true);assert.equal(policy.identity,true);assert.equal(policy.introduction,true)
    assert.equal(policy.artwork.find(item=>item.kind==='artist').reason,null)
    const before=(await request('query','settings.state')).settings.musicIdentification
    assert.equal(before.setup,'pending');assert.equal(before.newImports,false);assert.equal(before.history,false)
    assert.equal((await request('query','metadata.entity.jobs')).total,0)
    const dialog=()=>win.webContents.executeJavaScript("Boolean(document.querySelector('.metadata-setup[open]'))")
    await until(dialog,'post-import metadata opt-in dialog')
    mkdirSync(metadataEvidence,{recursive:true})
    async function setTheme(theme) {
      const state=await request('query','settings.state')
      await request('command','settings.edit',{revision:state.revision,patch:{theme}})
      await until(()=>win.webContents.executeJavaScript('document.documentElement.dataset.theme === '+JSON.stringify(theme)),'rendered '+theme+' theme')
    }
    await setTheme('pureWhite')
    win.show();await pause(200)
    writeFileSync(join(metadataEvidence,'prompt-light.png'),(await win.webContents.capturePage()).toPNG())
    win.setMinimumSize(480,540);win.setSize(520,760)
    await setTheme('dark')
    await pause(200)
    assert.equal(await win.webContents.executeJavaScript("(()=>{const d=document.querySelector('.metadata-setup');return d.scrollWidth<=d.clientWidth && d.getBoundingClientRect().right<=innerWidth})()"),true)
    writeFileSync(join(metadataEvidence,'prompt-narrow-dark.png'),(await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript("[...document.querySelectorAll('.metadata-setup button')].find(b=>b.textContent.trim()==='暂不开启').click()")
    await until(async()=>(await request('query','settings.state')).settings.musicIdentification.setup==='declined','saved metadata decline')
    assert.equal((await request('query','metadata.entity.jobs')).total,0)
    await until(async()=>!await dialog(),'closed metadata dialog')
    const declined=await request('query','settings.state')
    await request('command','settings.edit',{revision:declined.revision,patch:{musicIdentification:{...declined.settings.musicIdentification,setup:'pending'}}})
    await until(dialog,'reopened fixture metadata choice')
    await win.webContents.executeJavaScript("document.querySelector('.metadata-setup-enable').click()")
    const accepted=await until(async()=>{
      const s=(await request('query','settings.state')).settings.musicIdentification
      return s.setup==='accepted' && s
    },'saved all-source metadata acceptance')
    const metadataJobs=await until(async()=>{
      const page=await request('query','metadata.entity.jobs');return page.total>0 && page.total
    },'automatic metadata jobs after consent')
    const metadataSetup={declined:true,accepted,jobs:metadataJobs}
    await until(async()=>!await dialog(),'accepted metadata dialog closed')
    win.setSize(1280,900)
    await setTheme('pureWhite')
    await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\"设置\"]').click()")
    await until(()=>win.webContents.executeJavaScript("Boolean(document.querySelector('[data-settings-category=library]'))"),'packaged settings mount')
    await win.webContents.executeJavaScript("document.querySelector('[data-settings-category=library]').click(); const trigger=document.querySelector('#music-metadata .settings-group-trigger');if(trigger.getAttribute('aria-expanded')!=='true')trigger.click();document.getElementById('music-metadata').scrollIntoView({block:'start'})")
    await until(()=>win.webContents.executeJavaScript("document.querySelectorAll('#music-metadata input[type=checkbox]').length>=5"),'all metadata source controls')
    assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('#music-metadata input[type=checkbox]')].every(input=>input.checked)"),true)
    assert.equal(await win.webContents.executeJavaScript("[...document.querySelectorAll('#music-metadata [role=switch]')].every(input=>input.getAttribute('aria-checked')==='true')"),true)
    await pause(250)
    writeFileSync(join(metadataEvidence,'settings-all-sources.png'),(await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\"网易云资料兜底\"]').click()")
    await until(async()=>(await request('query','settings.state')).settings.musicIdentification.ncmLocalFallback===false,'disabled NCM local fallback')
    await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\"网易云资料兜底\"]').click()")
    await until(async()=>(await request('query','settings.state')).settings.musicIdentification.ncmLocalFallback===true,'restored NCM local fallback')
    await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\"设置\"]').click()")
    const page=await request('query','library.tracks',{limit:10})
    assert.equal(page.total,1)
    const staged=await request('command','queue.submit',{kind:'begin',selectedIndex:0,play:true})
    await request('command','queue.submit',{kind:'append',id:staged.id,sequence:1,items:[
      {kind:'local',id:page.tracks[0].id},{kind:'local',id:page.tracks[0].id}
    ]})
    await request('command','queue.submit',{kind:'commit',id:staged.id,sequence:2})
    await until(()=>snapshot?.playback?.state==='playing' && snapshot.playback.position>0.2,'packaged native silence')
    assert.equal(nativeAddon,join(process.resourcesPath,'audio-engine','twilight_audio_node.node'))
    const occurrenceId=snapshot.queue.occurrenceId,originalEpoch=snapshot.epoch,transportCount=transportMethods.length
    let rendererCommandsOnRebuild=0
    for(let rebuild=0;rebuild<2;rebuild++) {
      const before=await request('query','state.snapshot')
      for(const window of BrowserWindow.getAllWindows()) window.destroy()
      assert.equal(BrowserWindow.getAllWindows().length,0)
      await pause(rebuild===0?5500:500)
      const headless=await request('query','state.snapshot')
      assert.equal(headless.epoch,originalEpoch);assert.equal(headless.queue.occurrenceId,occurrenceId)
      assert.equal(headless.playback.state,'playing');assert.ok(headless.playback.position>before.playback.position)
      assert.equal((await request('query','library.tracks',{limit:10})).total,1)
      await request('query','statistics.summary');await request('query','player.lyrics')
      const commandCount=commands.length
      app.emit(rebuild===0?'activate':'second-instance')
      win=await mountedWindow();await pause(300)
      rendererCommandsOnRebuild+=commands.slice(commandCount).filter(row=>
        row.name.startsWith('playback.')||row.name.startsWith('queue.')).length
      const attached=await request('query','state.snapshot')
      assert.equal(attached.epoch,originalEpoch);assert.equal(attached.queue.occurrenceId,occurrenceId)
      assert.equal(attached.playback.state,'playing')
    }
    const replayedTransport=transportMethods.length-transportCount
    await request('command','playback.pause')
    const final=await request('query','state.snapshot')
    const statistics=await request('query','statistics.tracks',{limit:10})
    assert.equal(statistics.total,1);assert.equal(statistics.items[0].plays,1)
    win.show();await pause(500)
    writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG())
    result={rebuilds:2,coreProcesses,zeroWindowPlayback:true,replayedTransport,rendererCommandsOnRebuild,metadataSetup,
      migrationCommits:commands.filter(row=>row.name==='migration.commit').length,
      occurrenceId,position:final.playback.position,nativeAddon}
    for(const window of BrowserWindow.getAllWindows()) window.destroy()
    app.quit()
  }
  main().catch(error=>{log(error.stack||error);console.error(error.stack||error);app.exit(1)})
  return 'packaged acceptance armed'
})()`
