'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { createRequire } = require('node:module')
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'real zero-window Core completes AutoMix/BPM/loudness across detached clients and recovers paused without replay',
  { timeout: 90000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-automix-'))
    const common = {
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      define: {
        'import.meta.url': JSON.stringify(
          require('node:url').pathToFileURL(join(root, 'package.json')).href
        ),
        __TWILIGHT_AUTOMIX_EVALUATION__: 'true'
      }
    }
    try {
      // Evaluation is enabled only in this fixture. Native/audio analysis are fixed
      // simulated services; no audio device, model or renderer is opened.
      await build({
        ...common,
        entryPoints: [join(root, 'src/main/coreProcess/entry.ts')],
        packages: 'external',
        banner: { js: `module.paths.unshift(${JSON.stringify(join(root, 'node_modules'))});` },
        outfile: join(directory, 'automix-core.cjs')
      })
      for (const [name, contents] of Object.entries({
        runner,
        'silent-audio': audio,
        'simulated-analysis': analysis
      }))
        await build({
          ...common,
          stdin: { contents, resolveDir: root },
          outfile: join(directory, name + '.cjs')
        })
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), root],
        { env, windowsHide: true, timeout: 80000, maxBuffer: 2 * 1024 * 1024 }
      )
      process.stdout.write(result.stdout)
      process.stderr.write(result.stderr)
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')), {
        windows: 0,
        preparedDetached: true,
        submits: 1,
        reconnects: 5,
        recoveredPaused: true,
        retainedOccurrence: true,
        bpmPersisted: true,
        loudnessDetached: true
      })
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-automix-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runner = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile'), children = [], alive = new Set()
mkdirSync(profile)
app.setPath('userData', profile); app.disableHardwareAcceleration()
let supervisor, serial = 0
const calls = () => existsSync(join(__dirname, 'calls.jsonl')) ? readFileSync(join(__dirname, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []
const count = method => calls().filter(row => row.method === method).length
const waitFor = async condition => { for(let i=0;i<1000;i++) { if(await condition()) return; await new Promise(resolve=>setTimeout(resolve, 10)) } throw Error('AutoMix stage timed out: '+JSON.stringify(calls())) }
const identity = { id:'test:desktop', role:'desktop', permissions:['playback:read','playback:write','library:read','migration:write','settings:read','settings:write'] }
async function main() {
  await app.whenReady()
  const files = [join(profile, 'one.wav'), join(profile, 'two.wav')], library = join(profile, 'music-library.json')
  files.forEach((file, index) => writeFileSync(file, 'source-'+index))
  writeFileSync(library, JSON.stringify({ version:2, revision:0, folders:[], exclusions:[], tracks:files.map((filePath,index) => ({id:index?'two':'one',title:index?'Two':'One',source:'local',filePath,duration:60})) }))
  supervisor = new CoreSupervisor({
    configuration: { root:profile, libraryFilePath:library, coverCacheDir:join(profile,'covers'), libraryStorage:'sqlite', resumeMode:'trackAndPosition', autoMixEnabled:true },
    entries: { core:join(__dirname,'automix-core.cjs'), audio:join(__dirname,'silent-audio.cjs'), analysis:join(__dirname,'simulated-analysis.cjs'), database:join(root,'out/main/libraryDatabaseService.js'), scan:join(root,'out/main/libraryScanService.js') },
    readyTimeoutMs:30000, requestTimeoutMs:15000, stopTimeoutMs:5000,
    platform: {
      ...createDspCorePlatform(),
      'automix.environment':async()=>({candidates:[],workerDirectory:profile,temporaryDirectory:profile}),
      'settings.authorizePaths':async paths=>paths,
      'downloads.authorizedRoots':async()=>({libraryRoots:[],downloadRoot:null}),
      'paths.prepareAudio':async({source})=>{assert.ok(files.includes(source));return source},
      'paths.authorizeAudio':async({source})=>{assert.ok(files.includes(source));return source},
      'paths.authorizeAudioFile':async({path})=>{assert.ok(files.includes(path));return path},
      'artwork.normalizeCachedCover':async()=>null
    },
    fork(entry,args,serviceName) {
      const child=utilityProcess.fork(entry,args,{serviceName,stdio:'pipe'});children.push({child,serviceName});alive.add(child)
      child.once('exit',()=>alive.delete(child));child.stdout.on('data',data=>process.stdout.write(data));child.stderr.on('data',data=>process.stderr.write(data));return child
    }, channel:()=>new MessageChannelMain()
  })
  supervisor.on('failure',error=>console.error('[automix-headless]',error))
  supervisor.connect(identity)
  const request=(kind,name,payload={})=>supervisor.request(identity.id,{kind,name,payload,epoch:supervisor.getStatus().epoch,requestId:'request:'+ ++serial})
  const initialized=once(supervisor,'initialized'), started=supervisor.start();void started.catch(()=>{});await initialized
  await request('command','migration.begin',{id:'empty-profile',manifest:{version:1,counts:emptyCoreStateCounts()}})
  await request('command','migration.commit',{id:'empty-profile'});await started
  const settings=await request('query','settings.state')
  await request('command','settings.edit',{revision:settings.revision,patch:{autoMixStemMode:'off',autoAnalyzeBpm:true}})
  await request('command','audio.dsp.edit',{revision:(await request('query','audio.dsp')).revision,edit:{kind:'processing',settings:{volumeNormalization:'loudnorm'}}})
  await request('command','queue.fromQuery',{query:{ids:['one','two'],sort:'playlist'},selectedId:'one',play:true})
  await waitFor(()=>calls().some(row=>row.analysis)).catch(async error=>{console.error('state:',JSON.stringify(await request('query','state.snapshot')));throw error})
  const initial=await request('query','state.snapshot')
  supervisor.disconnect(identity.id)
  writeFileSync(join(__dirname,'release-analysis'),'')
  await waitFor(()=>count('SubmitAutoMix')===1)
  await waitFor(()=>existsSync(join(profile,'bpm-analysis-cache.json'))&&existsSync(join(profile,'loudness-analysis-cache.json')))
  supervisor.connect(identity)
  await waitFor(async()=>{const state=await request('query','state.snapshot');return state.playback.autoMixPlanId===17&&state.track.bpmAnalysis?.bpm===123&&state.loudness.status==='cached'})
  const stablePlays=count('Play'), stableSeeks=count('Seek'), stableLoads=count('LoadQueue')
  supervisor.disconnect(identity.id)
  for(let i=0;i<5;i++) {
    supervisor.connect(identity)
    const attached=await request('query','state.snapshot')
    assert.equal(attached.queue.occurrenceId,initial.queue.occurrenceId)
    assert.equal(attached.playback.autoMixMode,'natural')
    assert.equal(attached.playback.autoMixState,'ready')
    assert.equal(attached.playback.autoMixPlanId,17)
    assert.equal(attached.track.bpmAnalysis.bpm,123)
    supervisor.disconnect(identity.id)
  }
  assert.equal(count('SubmitAutoMix'),1)
  assert.equal(count('Play'),stablePlays);assert.equal(count('Seek'),stableSeeks);assert.equal(count('LoadQueue'),stableLoads)
  const before=count('Play'), seeks=count('Seek'), loads=count('LoadQueue')
  assert.equal(before,1)
  supervisor.connect(identity)
  const page=await request('query','library.tracks',{ids:['one','two']})
  assert.equal(page.tracks.find(track=>track.id==='one').bpmAnalysis.bpm,123)
  const plan=await request('command','library.loudness.prepare',{mode:'track',selection:{query:{ids:['one','two'],sort:'playlist',contentRevision:page.revision},total:2,ranges:[[0,2]]}})
  await request('command','library.loudness.start',{id:plan.id})
  await waitFor(()=>calls().some(row=>row.analysis==='loudness-batch'))
  await request('command','playback.pause')
  assert.equal((await request('query','state.snapshot')).playback.state,'paused')
  supervisor.disconnect(identity.id)
  writeFileSync(join(__dirname,'release-batch'),'')
  await waitFor(()=>existsSync(join(profile,'library-loudness'))&&require('node:fs').readdirSync(join(profile,'library-loudness')).filter(name=>name.endsWith('.json')).length===2)
  supervisor.connect(identity)
  await waitFor(async()=>(await request('query','library.loudness.state')).status.state==='completed')
  assert.equal((await request('query','library.loudness.result',{id:plan.id,index:1})).status,'measured')
  assert.equal((await request('query','automix.capabilities')).status,'missing')
  await request('command','lifecycle.flush')
  const epoch=supervisor.getStatus().epoch
  const recovered=new Promise((resolve,reject)=>supervisor.on('status',status=>{if(status.phase==='failed')reject(Error('Core recovery failed'));if(status.phase==='ready'&&status.epoch!==epoch)resolve()}))
  children.find(row=>row.serviceName==='twilight-core').child.kill();await recovered
  const current=await request('query','state.snapshot')
  assert.equal(current.playback.state,'paused')
  assert.equal(current.queue.occurrenceId,initial.queue.occurrenceId)
  assert.equal((await request('query','library.tracks',{ids:['one']})).tracks[0].bpmAnalysis.bpm,123)
  assert.equal(calls().filter(row=>row.analysis==='bpm').length,1)
  assert.equal(count('Play'),before);assert.equal(count('Seek'),seeks);assert.equal(count('SubmitAutoMix'),1)
  assert.ok(count('LoadQueue')>=loads)
  await supervisor.shutdown();assert.equal(alive.size,0)
  writeFileSync(join(__dirname,'result.json'),JSON.stringify({windows:BrowserWindow.getAllWindows().length,preparedDetached:true,submits:1,reconnects:5,recoveredPaused:true,retainedOccurrence:true,bpmPersisted:true,loudnessDetached:true}));app.quit()
}
main().catch(async error=>{console.error(error);await supervisor?.shutdown().catch(console.error);for(const child of alive)child.kill();app.exit(1)})
`

const audio = String.raw`
const { createServicePort } = require('./src/main/services/servicePort.ts')
const { createAudioServiceCapabilities } = require('./src/shared/audioServiceContract.ts')
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
let state='stopped',source='',queue=[],revision=0,mode='off',mix='off'
const port=createServicePort({supervise:async(message,reply)=>{state='stopped';reply({kind:'supervisor:audio-stopped',requestId:message.requestId,stopped:true})}})
port.postMessage({kind:'ready',available:true,capabilities:createAudioServiceCapabilities(['ApplyDspState','GetDspGraphStatus','RebindQueue'])})
port.on('message',message=>{
  appendFileSync(join(__dirname,'calls.jsonl'),JSON.stringify({method:message.method,...(['LoadQueue','Play'].includes(message.method)?{args:message.args}:{})})+'\n')
  if(message.method==='Stop')state='stopped'
  if(message.method==='Pause')state='paused'
  if(message.method==='Play'){state='playing';source=message.args[0]}
  if(message.method==='LoadQueue'){queue=JSON.parse(message.args[0]);source=queue[0]?.source??''}
  if(message.method==='RebindQueue')queue=JSON.parse(message.args[0])
  if(message.method==='ApplyDspState')revision=message.args[0]
  if(message.method==='SetAutoMixMode')mode=message.args[0]
  if(message.method==='CancelAutoMix')mix='off'
  if(message.method==='PrepareAutoMix')mix='ready'
  const value=message.method==='RebindQueue'?true:message.method==='GetPlaybackInfo'?{state,source,position:1,duration:60,queueIndex:0,preloadReady:queue.length>1,upcomingQueueIndex:1,upcomingTrack:queue[1],playbackRate:1,actualSampleRate:48000,actualChannels:2,autoMixMode:mode,autoMixState:mix,autoMixPlanId:mix==='ready'?17:0}:message.method==='GetDspGraphStatus'?{revision,nodes:[],totalLatencyFrames:0,totalTailFrames:0}:message.method==='SelectAutoMix'?JSON.stringify({ok:true,selectionId:4,currentStartSeconds:45}):null
  port.postMessage({kind:'response',requestId:message.requestId,ok:true,value})
})
`

const analysis = String.raw`
const { createServicePort }=require('./src/main/services/servicePort.ts')
const { TWILIGHT_AUTOMIX_MODEL_VERSION }=require('./src/shared/twilightAutoMix.ts')
const { LIBRARY_LOUDNESS_ALGORITHM_VERSION }=require('./src/shared/libraryLoudness.ts')
const { appendFileSync,existsSync }=require('node:fs')
const { join }=require('node:path')
const port=createServicePort()
port.postMessage({kind:'ready',protocolVersion:1,analyses:['bpm','loudness','automix','loudness-batch']})
port.on('message',async message=>{
  appendFileSync(join(__dirname,'calls.jsonl'),JSON.stringify({method:'analyze',analysis:message.analysis})+'\n')
  while(!existsSync(join(__dirname,message.analysis==='loudness-batch'?'release-batch':'release-analysis')))await new Promise(resolve=>setTimeout(resolve,5))
  const measured={integratedLufs:-20,truePeakDb:-1,source:'analyzed',analyzedAt:'2026-10-22T12:00:00Z',algorithmVersion:LIBRARY_LOUDNESS_ALGORITHM_VERSION,available:true}
  if(message.analysis!=='automix') {
    const options=JSON.parse(message.optionsJson)
    const value=message.analysis==='bpm'?{bpm:123,confidence:.9,source:'analyzed',analyzedAt:measured.analyzedAt,algorithmVersion:1}:message.analysis==='loudness'?measured:{tracks:options.segments.map(()=>measured),album:options.album?measured:null}
    port.postMessage({kind:'response',requestId:message.requestId,ok:true,value});return
  }
  const o=JSON.parse(message.optionsJson),duration=o.sourceEndSeconds-o.sourceStartSeconds,start=o.rangeStartSeconds,end=Math.min(start+30,duration)
  port.postMessage({kind:'response',requestId:message.requestId,ok:true,value:{ok:true,algorithm:'Twilight AutoMix',modelVersion:TWILIGHT_AUTOMIX_MODEL_VERSION,sourceIdentity:o.sourceIdentity,coverage:{startSeconds:start,endSeconds:end,durationSeconds:duration,complete:start===0&&end===duration},bpm:120,tempoConfidence:.9,rmsDb:-12,peak:.2,key:-1,keyConfidence:0,beats:[],downbeats:[],voice:[],frameDb:Array(Math.ceil((end-start)*50)).fill(-12),framePeak:Array(Math.ceil((end-start)*50)).fill(.2)}})
})
`
