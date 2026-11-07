'use strict'
// Registry + shared SQL session + production managers/decoder services + TLS.
// Only receiver DAC clocks/SRC are simulated; no host audio device is opened.
const assert = require('node:assert/strict')
const test = require('node:test')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { randomUUID } = require('node:crypto')

test('production group owner coordinates two independent decoder services over TLS and recovers only paused', { timeout: 45000 }, async t => {
  await import('../src/adapters-node/index.ts')
  const [ { AudioEngineManager }, { AudioEngineServiceBinding }, { AudioBridgeRuntime }, { createRemoteTlsIdentity },
    { CorePlaybackSession }, { CoreZoneRegistry }, { createSyncGroupRuntime, syncGroupCatalog },
    { LibraryDatabase }, { playbackQueueApi, zoneCatalog }, { zoneGroupOutput }, { createDefaultSettings }, { coreAudioConfiguration },
    { createCorePlaybackRepository }, { createPlaybackSessionStoreBundle }, { zoneQueueFence } ] = await Promise.all([
    import('../src/main/audioEngineManager.ts'), import('../src/main/audioEngineServiceClient.ts'), import('../src/main/audio/bridgeRuntime.ts'),
    import('../src/adapters-node/remoteTlsIdentity.ts'), import('../src/core/playback/session.ts'), import('../src/core/playback/zoneRegistry.ts'),
    import('../src/main/coreProcess/syncGroupRuntime.ts'), import('../src/main/library/libraryDatabase.ts'),
    import('../src/main/coreProcess/zoneRuntime.ts'), import('../src/main/coreProcess/zoneGroupOutput.ts'),
    import('../src/core/settings/normalization.ts'), import('../src/core/audio/settings.ts'),
    import('../src/main/persistence/corePlaybackRepository.ts'), import('../src/main/persistence/playbackSessionRepository.ts'), import('../src/shared/coreZones.ts')
  ])
  const root = resolve(__dirname, '..'), directory = await mkdtemp(join(tmpdir(), 'twilight-sync-group-native-'))
  const serviceEntry = process.env.TWILIGHT_SYNC_SERVICE || join(root, 'out/main/audioEngineService.js')
  const resourcesBootstrap = join(directory, 'native-resources.cjs')
  const execArgv = process.env.TWILIGHT_SYNC_RESOURCES ? ['--require', resourcesBootstrap] : []
  if (execArgv.length) await writeFile(resourcesBootstrap,
    `Object.defineProperty(process, 'resourcesPath', { value: ${JSON.stringify(resolve(process.env.TWILIGHT_SYNC_RESOURCES))} })`)
  const devices = [], errors = [], now = () => Number(process.hrtime.bigint())/1e6
  let registry, local, groupRuntime
  const until = async (predicate, describe=()=>errors.join('\n'), timeout=7000) => {
    const end = Date.now()+timeout
    while (!(await predicate()) && Date.now() < end) await delay(20)
    if (!(await predicate())) assert.fail(JSON.stringify({ detail:describe(),groups:await registry?.listGroups(),
      windows:devices.map(d=>d.windows),trace:devices.map(d=>d.trace?.slice(-8)),errors }))
  }
  const db = new LibraryDatabase(':memory:')
  const database = new Proxy(db, { get: (target, key) => typeof target[key] === 'function' ? async (...args) => target[key](...args) : target[key] })
  const dependencies = { queues: playbackQueueApi(database), resolver: { resolve: async track => ({ source: track.filePath, expiresAt: null }) }, authorize: async s => s }
  const {TWILIGHT_AUTOMIX_MODEL_VERSION:modelVersion}=await import('../src/shared/twilightAutoMix.ts')
  const {ProviderPlaybackIdentityRegistry}=await import('../src/core/audio/providerPlaybackIdentity.ts')
  const groupAnalyses=[]
  const autoMix={settings:()=>({autoMixStemMode:'off',autoMixStemDevice:'cpu',autoMixStemCacheMiB:512}),
    identities:new ProviderPlaybackIdentityRegistry(),authorize:async source=>source,useSources:action=>action(),now:Date.now,
    environment:async()=>assert.fail('disabled stems must not probe a pack'),probe:async()=>assert.fail('no probe'),runWorker:async()=>assert.fail('no worker'),
    analysis:{cancel:()=>assert.fail('scoped analysis cancellation only'),analyze:async(source,json,priority)=>{
      const o=JSON.parse(json);groupAnalyses.push({source,priority})
      return {ok:true,algorithm:'Twilight AutoMix',modelVersion,sourceIdentity:o.sourceIdentity,
        coverage:{startSeconds:0,endSeconds:12,durationSeconds:12,complete:true},bpm:120,tempoConfidence:.9,rmsDb:-12,peak:.4,
        key:-1,keyConfidence:0,beats:Array.from({length:24},(_,i)=>i*.5),downbeats:[],
        voice:Array.from({length:24},(_,i)=>({startSeconds:Math.min(i*.48,11.025),endSeconds:Math.min(i*.48+.975,12),probability:.001,music:.9})),
        frameDb:Array(600).fill(-12),framePeak:Array(600).fill(.4)}
    }}}
  t.after(async () => {
    t.diagnostic('Native preparation receipts: '+JSON.stringify(devices.map(d=>d.preparations)))
    try { await registry?.shutdown(); await local?.playback.shutdown() } catch (e) { errors.push(String(e)) }
    for (const d of devices) {
      clearInterval(d.timer)
      try { await d.audio.callBridge('BridgeShutdown') } catch {}
      d.audio.destroy(); await d.receiver.close()
      if (d.child && d.child.exitCode === null && d.child.signalCode === null) {
        const exit = once(d.child, 'exit'); d.child.kill(); await exit
      }
    }
    db.close()
    if(errors.length)t.diagnostic(errors.join('\n'))
    assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep))
    await rm(directory, { recursive: true, force: true })
  })
  const rate = 44100, frames = rate*12, wave = Buffer.alloc(44+frames*4)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length-8,4); wave.write('WAVEfmt ',8); wave.writeUInt32LE(16,16)
  wave.writeUInt16LE(1,20); wave.writeUInt16LE(2,22); wave.writeUInt32LE(rate,24); wave.writeUInt32LE(rate*4,28)
  wave.writeUInt16LE(4,32); wave.writeUInt16LE(16,34); wave.write('data',36); wave.writeUInt32LE(frames*4,40)
  for (let n=0;n<frames;n++) for(let c=0;c<2;c++) wave.writeInt16LE(Math.round(Math.sin(n*2*Math.PI*1000/rate)*8192),44+(n*2+c)*2)
  const source=join(directory,'tone.wav'); await writeFile(source,wave)
  db.replaceDocument({ version:2,revision:0,folders:[],exclusions:[],tracks:[{ id:'a',title:'Tone',filePath:source,duration:12 }] })

  async function create(descriptor, ppm, preamp) {
    const d = { descriptor, child:null, timer:null, blocks:[], arms:[], rates:[], audio:null, receiver:null }
    const facts = { sampleRate:48000,channels:2,bufferedFrames:0,capacityFrames:12000,prebufferFrames:1920,consumedFrames:0,
      underruns:0,started:false,failed:false,backend:'wasapi-exclusive',deviceName:descriptor.name,
      actualSampleRate:48000,actualBitDepth:24,actualChannels:2,actualOutputFormat:'int24',exclusive:true,adaptiveSupported:true }
    const blank = () => ({ supported:true,state:'disabled',error:'',ended:false,targetAtMs:0,mediaFrame:0,
      deviceStartFrame:null,deviceStartAtMs:null,presentedMediaFrames:null })
    let timed=blank(),adaptive=null,generation=0,start=0,target=0,position=0,updated=0,lastDrain=0,drainRemainder=0
    const advance=()=>{const at=now();if(target&&adaptive&&['armed','running'].includes(timed.state)) {
      position=Math.min(adaptive.inputFrames,position+Math.max(0,at-Math.max(target,updated))*48*(1+ppm*1e-6)/(1+adaptive.requestedPpm*1e-6))
      if(timed.deviceStartFrame!==null)timed.presentedMediaFrames=position
    }updated=at}
    const dac={
      Stop(){},SetOutputDevice(){},SetOutputBackend(){},PullBridgePcm(){assert.fail('Receiver cannot decode')},
      OpenBridgeReceiver(backend,device){assert.equal(backend,'wasapi-exclusive');assert.equal(device,descriptor.id)
        ++generation;start=0;target=0;position=0;updated=0;lastDrain=0;drainRemainder=0;timed=blank();adaptive=null;facts.started=false;facts.bufferedFrames=facts.consumedFrames=0},
      CloseBridgeReceiver(){facts.started=false;facts.bufferedFrames=0;timed=blank();adaptive=null;target=0},
      WriteBridgePcm(data){if(d.blocks.length<30)d.blocks.push(Buffer.from(data));facts.bufferedFrames+=data.length/8
        if(adaptive)adaptive.inputFrames+=data.length/8;assert.ok(facts.bufferedFrames<=facts.capacityFrames)},
      StartBridgeReceiver(){facts.started=true},PrepareBridgeTimedReceiver(){timed.state='prepared';facts.started=true},
      PrepareBridgeAdaptiveReceiver(){timed.state='prepared';facts.started=true;adaptive={requestedPpm:0,effectivePpm:0,inputFrames:0,
        pendingInputFrames:134,resamplerDelayFrames:134,sourceConsumedFrames:0,inputCreditFrames:12000}},
      SetBridgeTimedCorrection(value,stream){assert.equal(stream,generation);advance();adaptive.requestedPpm=adaptive.effectivePpm=value;d.rates.push({generation,ppm:value})},
      ArmBridgeTimedReceiver(at,stream,frame){assert.equal(stream,generation);assert.equal(timed.state,'prepared')
        assert.ok(facts.bufferedFrames>=facts.prebufferFrames);target=at-40000;timed.state='armed';timed.targetAtMs=at;timed.mediaFrame=frame;d.arms.push(target)},
      EndBridgeTimedReceiver(){timed.ended=true},
      GetBridgeReceiverInfo(){advance();const at=now();if(facts.started&&!start)start=at
        if(adaptive)adaptive.inputCreditFrames=timed.ended?0:facts.capacityFrames-facts.bufferedFrames
        return JSON.stringify({...facts,timedStart:timed,adaptive,clock:{supported:true,valid:facts.started,running:facts.started,
          source:'wasapi-audio-clock',streamGeneration:generation,epoch:1,sampleRate:48000,positionFrames:facts.started?(at-start)*48*(1+ppm*1e-6):0,
          sampledAtMs:at+40000,readAtMs:at+40000,callbackRequestedFrames:facts.consumedFrames}})}
    }
    for(const method of Object.keys(dac)){
      const original=dac[method]
      dac[method]=(...args)=>{try{return original(...args)}catch(error){errors.push(method+': '+String(error)+' '+JSON.stringify({facts,timed,generation}));throw error}}
    }
    d.receiver = new AudioBridgeRuntime(dac)
    const settings=createDefaultSettings(process.platform);settings.audioProcessing={...settings.audioProcessing,dspEnabled:true,eqEnabled:true,eqPreamp:preamp}
    settings.dspScenes=undefined // Derive each fixture's initial scene from its own processing settings.
    d.audio=new AudioEngineManager(coreAudioConfiguration(settings),{platform:process.platform,initialBridgeSelected:true,
      audioServiceFactory:()=>new AudioEngineServiceBinding({serviceEntry,requestTimeoutMs:5000,
        launch(){const child=fork(serviceEntry,[],{execArgv,cwd:root,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true})
          d.child=child;child.stdout.resume();child.stderr.on('data',data=>errors.push(String(data)));child.postMessage=message=>child.send(message);return child}})})
    d.audio.on('error',error=>errors.push(String(error)));devices.push(d)
    const playback=new CorePlaybackSession({...dependencies,engine:d.audio,
      repository:createCorePlaybackRepository(createPlaybackSessionStoreBundle(join(directory,descriptor.id)),database,descriptor.id+':persisted'),
      resumeMode:()=> 'trackAndPosition',now:Date.now,schedule:()=>()=>{},changed:()=>{},fatal:e=>errors.push(String(e))})
    await playback.initialize()
    const identity=createRemoteTlsIdentity(),grant=await d.receiver.startHost({...identity,name:descriptor.name,backend:'wasapi-exclusive',device:descriptor.id,sampleRate:48000})
    const peer={host:'127.0.0.1',port:grant.port,token:grant.token,fingerprint:identity.fingerprint}
    await d.audio.callBridge('BridgeConnect',[peer])
    d.timer=setInterval(()=>{if(!facts.started)return
      const at=now()
      if(timed.state!=='disabled'){if(!target||at<target)return;timed.state='running';timed.deviceStartAtMs=timed.targetAtMs
        timed.deviceStartFrame=Math.round((target-start)*48*(1+ppm*1e-6))}
      // A delayed JS timer is not a slower hardware DAC. Consume elapsed
      // device time through the same synthetic SRC/ppm model as advance(),
      // retaining fractional frames instead of accumulating timer jitter.
      const elapsed=at-(lastDrain||target||at)
      const due=elapsed*48*(1+ppm*1e-6)/(1+(adaptive?.requestedPpm??0)*1e-6)+drainRemainder
      const whole=Math.floor(due);drainRemainder=due-whole;lastDrain=at
      const n=Math.min(whole,facts.bufferedFrames);facts.bufferedFrames-=n;facts.consumedFrames+=n},10)
    d.facts=facts;d.timed=()=>timed;d.peer=peer
    const groupOutput=zoneGroupOutput(descriptor.id,d.audio), read=groupOutput.read
    d.trace=[]; d.windows=[];d.mixStatuses=[];d.selections=[];d.submits=[];d.preparations=[]
    const nativeSelect=groupOutput.autoMix.select,nativeSubmit=groupOutput.autoMix.submit
    groupOutput.autoMix.select=async json=>{const selected=await nativeSelect(json);d.selections.push(selected);return selected}
    groupOutput.autoMix.submit=async id=>{d.submits.push(id);return nativeSubmit(id)}
    const nativePrepare=groupOutput.autoMix.prepare
    // A normal first prepare, then one delayed IPC receipt on automatic repeat.
    groupOutput.autoMix.prepare=async json=>{if(d.preparations.length)await delay(100);const ok=await nativePrepare(json),error=d.audio.lastNativeError,s=await d.audio.getAutoMixNativeStatus()
      d.preparations.push({at:now(),ok,error,state:s.autoMixState,reason:s.autoMixReason,id:s.autoMixPlanId});return ok}
    const nativeMixStatus=groupOutput.autoMix.status
    groupOutput.autoMix.status=async()=>{const s=await nativeMixStatus();d.mixStatuses.push({at:now(),mode:s.autoMixMode,state:s.autoMixState,reason:s.autoMixReason,id:s.autoMixPlanId})
      if(d.mixStatuses.length>20)d.mixStatuses.shift();return s}
    const prepare=groupOutput.continuous.prepare
    groupOutput.continuous.prepare=async(items,...args)=>{d.windows.push(items);return prepare(items,...args)}
    groupOutput.read=async()=>{const s=await read();d.trace.push({at:now(),position:s.playback.position,preload:s.playback.preloadReady,
      duration:s.playback.duration,timeline:s.sourceTimeline,sync:s.bridge.synchronization,timed:s.bridge.receiver?.timedStart?.state,
      mix:[s.playback.autoMixMode,s.playback.autoMixState,s.playback.autoMixReason,s.playback.autoMixPlanId],
      dsp:[s.dsp.applyState,s.dsp.compileState,s.dsp.totalLatencyFrames,s.dsp.latencySampleRate]});if(d.trace.length>100)d.trace.shift();return s}
    return {playback,dsp:{},groupOutput,output:()=>d.audio.callBridge('BridgeStatus'),
      connect:async(p,coordinated)=>{if(!coordinated)await playback.stop();await d.audio.callBridge('BridgeConnect',[p]);if(coordinated)await d.audio.callBridge('BridgeCancelTimed')},
      sources:()=>d.audio.getQueueSnapshot().map(i=>i.source),close:()=>playback.shutdown()}
  }
  local=await create({id:'local',name:'DAC A'},100,-6)
  registry=new CoreZoneRegistry({...zoneCatalog(directory),local,newId:randomUUID,changed:()=>{},create:descriptor=>create(descriptor,-100,0),
    groups:{...syncGroupCatalog(directory),create:async(descriptor,outputs)=>groupRuntime=await createSyncGroupRuntime({root:directory,descriptor,outputs,database,playback:dependencies,autoMix,changed:()=>{}})}})
  await registry.initialize()
  const zoneId=await registry.create('DAC B',0)
  await registry.fromQuery('local',0,{ids:['a','a'],sort:'playlist'},'a',new AbortController().signal)
  const view=await registry.list(),original=view.zones[0].queue.id
  const groupId=await registry.createGroup({revision:view.revision,name:'Native group',members:view.zones.map(z=>({zoneId:z.id,revision:z.revision,downstreamDelayMs:z.id===zoneId?3:0})),
    source:{zoneId:'local',queue:zoneQueueFence(view.zones[0].queue)}},new AbortController().signal)
  assert.notEqual(devices[0].child.pid,devices[1].child.pid)
  const group=(await registry.listGroups()).groups[0]
  assert.notEqual(group.queue.id,original);assert.equal(group.playback.state,'paused')
  await registry.groupTransport(groupId,group.revision,{kind:'play'},new AbortController().signal)
  await until(()=>devices.every(d=>d.timed().state==='running'&&d.blocks.length>=14))
  assert.equal((await registry.listGroups()).groups[0].playback.state,'playing')
  const starts=devices.map(d=>d.arms.at(-1));assert.ok(Math.abs(starts[0]-starts[1]-3)<3,'per-member downstream deadline: '+starts)
  const rms=d=>{let sum=0,n=0;for(const block of d.blocks.slice(3,14))for(let i=0;i<block.length;i+=4){sum+=block.readFloatLE(i)**2;n++}return Math.sqrt(sum/n)}
  const ratio=rms(devices[0])/rms(devices[1]);assert.ok(ratio>.48&&ratio<.53,'member DSP RMS ratio '+ratio)
  let learning
  await until(async()=>{
    learning=await Promise.all(devices.map(d=>d.audio.callBridge('BridgeStatus')))
    return learning.every((state,i)=>state.timing.output.driftPpm!==null&&state.synchronization?.state==='correcting'&&
      state.synchronization.samples>=8&&Math.abs(state.synchronization.effectivePpm??0)>1&&
      devices[i].rates.filter(rate=>rate.generation===state.receiver.clock.streamGeneration).length>=3)
  },()=>JSON.stringify({learning,rates:devices.map(d=>d.rates),errors}))
  const learned=devices.map(d=>d.rates.map(rate=>rate.ppm))
  await registry.groupTransport(groupId,(await registry.listGroups()).groups[0].revision,{kind:'seek',position:3},new AbortController().signal)
  await until(()=>devices.every(d=>d.arms.length>=2&&d.timed().state==='running'))
  for(const [index,d] of devices.entries()){
    const status=await d.audio.callBridge('BridgeStatus')
    const seed=d.rates.find(rate=>rate.generation===status.receiver.clock.streamGeneration)
    assert.ok(seed&&learned[index].includes(seed.ppm),'Re-arm must apply a previously acknowledged same-DAC rate: '+JSON.stringify({id:d.descriptor.id,seed,learned:learned[index],rates:d.rates,sync:status.synchronization,clock:status.receiver.clock}))
  }
  // Duplicate SQL occurrences share media but not identity. Cross the audible
  // boundary without another prepare/arm, connection or stream generation.
  await registry.groupTransport(groupId,(await registry.listGroups()).groups[0].revision,{kind:'seek',position:10},new AbortController().signal)
  await until(()=>devices.every(d=>d.arms.length===3&&d.timed().state==='running'))
  const epochs = await Promise.all(devices.map(d=>d.audio.callBridge('BridgeSourceTimeline')))
  let transitionView, transitionTimelines
  await until(async()=> {
    transitionView = (await registry.listGroups()).groups[0]
    transitionTimelines = await Promise.all(devices.map(d=>d.audio.callBridge('BridgeSourceTimeline')))
    return transitionView.queue.index===1
  }, ()=>JSON.stringify({transitionView,transitionTimelines,arms:devices.map(d=>d.arms),windows:devices.map(d=>d.windows),
    queues:devices.map(d=>d.audio.getQueueSnapshot()),trace:devices.map(d=>d.trace),errors}))
  assert.ok(devices.every(d=>d.arms.length===3),'Gapless promotion must not re-arm any receiver')
  const after = await Promise.all(devices.map(d=>d.audio.callBridge('BridgeSourceTimeline')))
  for (let i=0;i<after.length;i++) {
    assert.ok(after[i],JSON.stringify({state:groupRuntime.engine.state(),view:(await registry.listGroups()).groups[0],trace:devices.map(d=>d.trace.slice(-4)),errors}))
    assert.equal(after[i].epoch,epochs[i].epoch); assert.equal(after[i].generation,epochs[i].generation)
    assert.notEqual(after[i].entryId,epochs[i].entryId); assert.equal(after[i].transitionSerial,1)
  }
  // The same runtime now automatically analyzes/selects/prepares/commits.
  // Only analysis tables and DAC clocks are controlled boundaries.
  await groupRuntime.playback.pause()
  await groupRuntime.playback.setMode('repeat')
  await groupRuntime.playback.seek(5)
  await registry.editGroupSettings({groupId,revision:(await registry.listGroups()).groups[0].revision,autoMixMode:'natural'},new AbortController().signal)
  assert.equal((await registry.listGroups()).groups[0].autoMixMode,'natural')
  assert.equal((await registry.listGroups()).groups[0].playback.state,'paused')
  await groupRuntime.playback.play()
  let mixStatus
  await until(async()=>{mixStatus=await groupRuntime.engine.getPlaybackInfo();return devices.every(d=>d.submits.length===1)&&mixStatus.autoMixState==='ready'},
    ()=>JSON.stringify({mixStatus,selections:devices.map(d=>d.selections),preparations:devices.map(d=>d.preparations),submits:devices.map(d=>d.submits)}))
  const selected=devices[0].selections[0]
  assert.equal(selected.ok,true,JSON.stringify(selected));assert.equal(devices[1].selections.length,0)
  assert.equal(groupAnalyses.filter(a=>a.priority==='boundary').length,1,'same source/range is analyzed once for the group')
  const mixRearms=[],groupPlay=groupRuntime.engine.play.bind(groupRuntime.engine)
  groupRuntime.engine.play=async(...args)=>{mixRearms.push({position:args[1],stack:new Error('unexpected re-arm').stack,trace:devices.map(d=>d.trace.at(-1))});return groupPlay(...args)}
  const armsBeforeMix=devices.map(d=>d.arms.length),serialBeforeMix=(await groupRuntime.engine.getPlaybackInfo()).naturalBoundaries.trackSerial
  await until(async()=>((await groupRuntime.engine.getPlaybackInfo()).naturalBoundaries?.trackSerial??0)>serialBeforeMix,
    ()=>JSON.stringify({selected,mixRearms,mixStatuses:devices.map(d=>d.mixStatuses),mix:groupRuntime.engine.state(),trace:devices.map(d=>d.trace.slice(-3)),errors}),10000)
  assert.deepEqual(devices.map(d=>d.arms.length),armsBeforeMix,'common AutoMix promotion cannot re-arm a receiver')
  assert.equal((await groupRuntime.engine.getPlaybackInfo()).naturalBoundaries.trackSerial,serialBeforeMix+1)
  await until(async()=>((await groupRuntime.engine.getPlaybackInfo()).naturalBoundaries?.trackSerial??0)>serialBeforeMix+1,
    ()=>JSON.stringify({mixRearms,mix:groupRuntime.engine.state(),submits:devices.map(d=>d.submits),trace:devices.map(d=>d.trace.slice(-4)),errors}),12000)
  assert.deepEqual(devices.map(d=>d.arms.length),armsBeforeMix,'a repeated occurrence needs a fresh plan, not another timed start')
  assert.deepEqual(devices.map(d=>d.submits.length),[2,2],JSON.stringify({mix:await groupRuntime.engine.getPlaybackInfo(),
    selections:devices.map(d=>d.selections),preparations:devices.map(d=>d.preparations),statuses:devices.map(d=>d.mixStatuses.slice(-30)),trace:devices.map(d=>d.trace.slice(-5)),errors}))
  assert.equal(groupAnalyses.filter(a=>a.priority==='boundary').length,1,'repeat reuses verified content windows')
  groupRuntime.engine.play=groupPlay
  await registry.editGroupSettings({groupId,revision:(await registry.listGroups()).groups[0].revision,autoMixMode:'off'},new AbortController().signal)
  assert.equal((await registry.listGroups()).groups[0].playback.state,'paused')
  await registry.groupTransport(groupId,(await registry.listGroups()).groups[0].revision,{kind:'play'},new AbortController().signal)
  devices[1].facts.failed=true
  await until(async()=>!(await devices[1].audio.callBridge('BridgeStatus')).connected)
  await until(()=>!devices[0].facts.started)
  assert.ok((await registry.list()).zones.every(z=>z.groupId===groupId))
  devices[1].facts.failed=false
  await registry.connect(zoneId,devices[1].peer,(await registry.list()).zones.find(z=>z.id===zoneId).revision)
  assert.notEqual((await registry.listGroups()).groups[0].playback.state,'playing')
  assert.ok(devices.every(d=>!d.facts.started))
  await registry.removeGroup(groupId,(await registry.listGroups()).groups[0].revision)
  assert.equal((await registry.list()).zones[0].queue.id,original)
  assert.ok((await registry.list()).zones.every(z=>!z.groupId&&z.playback.state==='paused'))
  t.diagnostic(`Real registry/SQLite, two decoder services, TLS, common Play/Seek, gapless duplicate occurrence and common AutoMix preparation/submit/promotion without re-arm, failure/reconnect/removal; member -6/0 dB PCM RMS ratio ${ratio.toFixed(4)}. Receiver clocks and SRC are synthetic, not a physical skew measurement.`)
})
