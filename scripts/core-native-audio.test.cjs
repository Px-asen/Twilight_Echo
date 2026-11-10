'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { execFile } = require('node:child_process')
const { mkdtemp, mkdir, copyFile, readdir, symlink, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'isolated released native audio loads through private Core MessagePorts with no window or playback',
  { timeout: 75_000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-native-audio-'))
    try {
      const main = join(directory, 'out', 'main')
      const resources = join(directory, 'resources', 'audio-engine')
      const stage = process.env.TAE_AUDIO_ENGINE_STAGE_DIR
        ? resolve(process.env.TAE_AUDIO_ENGINE_STAGE_DIR)
        : join(root, 'resources', 'audio-engine')
      await mkdir(main, { recursive: true })
      await mkdir(resources, { recursive: true })
      for (const file of await readdir(stage, { withFileTypes: true }))
        if (file.isFile()) await copyFile(join(stage, file.name), join(resources, file.name))
      await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'junction')
      const build = (contents, outfile) =>
        buildSync({
          stdin: { contents, resolveDir: root },
          bundle: true,
          packages: 'external',
          platform: 'node',
          format: 'cjs',
          define: { 'import.meta.url': JSON.stringify(pathToFileURL(outfile).href) },
          outfile
        })
      build(`require('./src/main/audioEngineService.ts')`, join(main, 'audioEngineService.js'))
      build(worker, join(main, 'coreNativeFixture.js'))
      build(fixture, join(directory, 'runner.cjs'))
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const execution = promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
        env,
        windowsHide: true,
        timeout: 65_000,
        maxBuffer: 2 * 1024 * 1024
      })
      execution.child.stderr?.on('data', (data) => process.stderr.write(data))
      execution.child.stdout?.on('data', (data) => process.stdout.write(data))
      await execution
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.equal(result.windows, 0)
      assert.equal(result.parentBusinessMessages, 0)
      assert.equal(result.privatePorts, 1)
      assert.equal(result.state, 'stopped')
      assert.equal(result.nativePlaybackActive, false)
      assert.equal(result.fftDisabled, true)
      assert.equal(result.frames, 1)
      assert.equal(result.loopAcknowledged, true)
      assert.deepEqual(result.transportMethods, [])
      assert.equal(result.runtime.addonPath, join(resources, 'twilight_audio_node.node'))
      assert.equal(result.capabilities.features.ffmpeg, true)
      assert.equal(result.alive, 0)
      const journal = join(directory, '中文用户 🎵', '日志')
      const events = (
        await Promise.all(
          (await readdir(journal))
            .filter((name) => name.endsWith('.jsonl'))
            .map(async (name) =>
              (await readFile(join(journal, name), 'utf8')).trim().split('\n').map(JSON.parse)
            )
        )
      ).flat()
      assert.ok(events.some((event) => event.event === 'engine.started'))
      assert.ok(events.filter((event) => event.event === 'health.sample').length >= 2)
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-native-audio-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const profile = join(__dirname, 'profile')
mkdirSync(profile)
app.setPath('userData', profile)
app.disableHardwareAcceleration()
process.env.TAE_DIAGNOSTICS_DIR = join(__dirname, '中文用户 🎵', '日志')
const children = new Set()
let core, audio, ports = 0, parentBusinessMessages = 0, result
const fork = (entry, args, name) => {
  const child = utilityProcess.fork(join(__dirname, 'out', 'main', entry), args, {serviceName:name, stdio:'pipe'})
  children.add(child)
  child.stdout.on('data', data => process.stdout.write(data))
  child.stderr.on('data', data => process.stderr.write(data))
  child.once('exit', () => children.delete(child))
  return child
}
const cleanup = async () => {
  const exits = [...children].map(child => new Promise(resolve => child.once('exit', resolve)))
  for (const child of children) child.kill()
  await Promise.all(exits)
}
app.whenReady().then(() => new Promise((resolve, reject) => {
  core = fork('coreNativeFixture.js', [], 'twilight-core-native-fixture')
  core.on('message', message => {
    if (message.kind === 'core:service-open') {
      assert.equal(message.service, 'audio')
      assert.equal(audio, undefined)
      audio = fork('audioEngineService.js', ['--twilight-core-service'], 'twilight-native-fixture-audio')
      audio.on('message', () => parentBusinessMessages++)
      audio.once('exit', code => core.postMessage({kind:'core:service-exit', epoch:message.epoch, leaseId:message.leaseId, code}))
      const {port1, port2} = new MessageChannelMain()
      audio.postMessage({kind:'core:attach-service'}, [port1])
      core.postMessage({kind:'core:service-connected',epoch:message.epoch,leaseId:message.leaseId}, [port2])
      ports++
    } else if (message.kind === 'core:service-close') audio?.kill()
    else if (message.kind === 'result') { result = message.value; resolve() }
    else if (message.kind === 'failed') reject(new Error(message.error))
  })
  core.once('exit', code => { if (!result) reject(new Error('Core fixture exited before result: '+code)) })
})).then(async () => {
  await cleanup()
  writeFileSync(join(__dirname,'result.json'), JSON.stringify({...result, windows:BrowserWindow.getAllWindows().length, privatePorts:ports, parentBusinessMessages, alive:children.size}))
  app.exit(0)
}).catch(async error => {console.error(error); await cleanup(); app.exit(1)})
`

const worker = String.raw`
const assert = require('node:assert/strict')
const { AudioEngineManager } = require('./src/main/audioEngineManager.ts')
const { AudioEngineServiceBinding } = require('./src/main/audioEngineServiceClient.ts')
const { CoreServiceLauncher } = require('./src/main/coreProcess/serviceLauncher.ts')
const { CoreVisualizationService } = require('./src/core/audio/visualizationService.ts')
const epoch = 'native-fixture'
const parent = process.parentPort
const transportMethods = []
let manager, visualization, binding, timer
const launcher = new CoreServiceLauncher(epoch, message => parent.postMessage(message))
parent.on('message', event => launcher.handle(event.data, event.ports))
const main = async () => {
  manager = new AudioEngineManager({exclusiveMode:false,audioProcessing:{fftEnabled:true}}, {
    audioServiceFactory:() => {
      binding = new AudioEngineServiceBinding({serviceEntry:'audio',launch:()=> {
        const lease = launcher.launch('audio')
        const send = lease.postMessage.bind(lease)
        lease.postMessage = message => {
          if (message.kind === 'request' && ['Play','Seek','LoadQueue'].includes(message.method)) transportMethods.push(message.method)
          send(message)
        }
        return lease
      }})
      return binding
    }
  })
  manager.on('error', error => { throw error })
  await manager.start()
  const capabilities = JSON.parse(await binding.callAsync('GetEngineCapabilities', []))
  assert.equal(typeof capabilities.features, 'object')
  const nativeFacts = JSON.parse(await binding.callAsync('GetPlaybackInfo', []))
  assert.equal(nativeFacts.state, 'stopped')
  let frames = 0, receive
  const frame = new Promise(resolve => {receive=resolve})
  visualization = new CoreVisualizationService({epoch,engine:manager,send:(_client,event)=>{frames++;receive(event)},schedule:callback=>{timer=callback;return ()=>{timer=null}}})
  await visualization.initialize()
  const disabled = await manager.readVisualizationDataAsync({spectrumPoints:8,spectrogramFrames:0})
  assert.equal(disabled.tapStatus, 'disabled')
  assert.equal(disabled.active, false)
  await visualization.subscribe('fixture',{subscriptionId:'spectrum',options:{spectrumPoints:8,spectrogramFrames:0}})
  timer()
  const event = await frame
  assert.equal(event.epoch,epoch)
  assert.equal(event.sequence,1)
  assert.equal(event.data.spectrum.length,8)
  await visualization.disconnect('fixture')
  assert.equal(timer,null)
  const loopAcknowledged = await manager.setLoopRangeConfirmed(-1,-1)
  await visualization.shutdown()
  // The diagnostic thread starts independently of the service ready message.
  await new Promise(resolve => setTimeout(resolve, 1200))
  const info = await manager.getPlaybackInfo()
  const runtime = manager.getNativeRuntimeIdentity()
  const result = {state:info.state,nativePlaybackActive:info.nativePlaybackActive,fftDisabled:disabled.tapStatus==='disabled',frames,loopAcknowledged,transportMethods,runtime,capabilities}
  manager.destroy()
  launcher.destroy()
  parent.postMessage({kind:'result',value:result})
}
main().catch(error => { manager?.destroy(); launcher.destroy(); parent.postMessage({kind:'failed',error:error.stack||String(error)}) })
`
