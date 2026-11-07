'use strict'
// Accelerated time, real registry/shared SQL session/coordinator, two actual
// receiver/SWR/render/commit/history plants. DAC/host clocks, network delivery,
// pipeline and DSP/downstream latency are controlled; no hardware or TLS here.
const assert = require('node:assert/strict')
const test = require('node:test')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { EventEmitter } = require('node:events')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const { randomUUID } = require('node:crypto')
const { resolveMingwEnvironment } = require('./audio-engine-toolchain.cjs')

test('30-minute shared group controls real SWR plants with independent clocks, latency changes and member recovery', { timeout: 300000 }, async t => {
  await import('../src/adapters-node/index.ts')
  const [ { CoreZoneRegistry }, { SyncGroupEngine }, { CorePlaybackSession }, { LibraryDatabase },
    { BridgeClockMonitor }, { BridgeTimelineController }, { createDefaultPlaybackInfo }, { normalizeOutputConfig },
    { playbackQueueApi }, { createCorePlaybackRepository }, { createPlaybackSessionStoreBundle }, { zoneQueueFence } ] = await Promise.all([
    import('../src/core/playback/zoneRegistry.ts'), import('../src/core/playback/syncGroupEngine.ts'), import('../src/core/playback/session.ts'),
    import('../src/main/library/libraryDatabase.ts'), import('../src/shared/audioBridgeClock.ts'), import('../src/shared/audioBridgeSync.ts'),
    import('../src/core/audio/audioEngineHelpers.ts'), import('../src/shared/audioOutputConfig.ts'), import('../src/main/coreProcess/zoneRuntime.ts'),
    import('../src/main/persistence/corePlaybackRepository.ts'), import('../src/main/persistence/playbackSessionRepository.ts'), import('../src/shared/coreZones.ts')
  ])
  const directory = await mkdtemp(join(tmpdir(), 'twilight-group-soak-'))
  const env = resolveMingwEnvironment(), build = process.env.TAE_MINGW_BUILD_DIR || env.TAE_MINGW_BUILD_DIR || join(__dirname, '../audio-engine/build/mingw-static')
  const executable = join(resolve(build), 'twilight_bridge_group_fixture.exe')
  const signal = () => new AbortController().signal, base = 1e8, duration = Number(process.env.TAE_GROUP_SIM_MS || 1800000)
  assert.ok(duration >= 1000 && duration % 100 === 0)
  let now = base, scheduled = null, tickDone = null, registry, local
  const devices = [], faults = [], events = []
  const initial = () => createDefaultPlaybackInfo('wasapi', 'controlled-fixture', true, normalizeOutputConfig())
  const db = new LibraryDatabase(':memory:')
  db.replaceDocument({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [
    { id: 'tone', title: 'Long deterministic tone', filePath: 'C:/fixture.wav', duration: 4000 }
  ] })
  const database = new Proxy(db, { get: (target, key) => typeof target[key] === 'function' ? async (...a) => target[key](...a) : target[key] })
  const dependencies = { queues: playbackQueueApi(database), resolver: { resolve: async track => ({ source: track.filePath, expiresAt: null }) }, authorize: async source => source }
  const repository = id => createCorePlaybackRepository(createPlaybackSessionStoreBundle(join(directory, id)), database, id+':persisted')
  const session = (engine, id) => new CorePlaybackSession({ ...dependencies, engine, repository: repository(id), resumeMode: () => 'trackAndPosition',
    now: () => now, schedule: () => () => {}, changed: () => {}, fatal: error => faults.push(String(error)) })
  const settle = async () => { for (let i=0;i<4;i++) await new Promise(r => setImmediate(r)) }
  t.after(async () => {
    try { await registry?.shutdown(); await local?.playback.shutdown() } catch (error) { faults.push(String(error)) }
    for (const d of devices) { if (d.child.exitCode === null) { d.child.stdin.end(); await d.exited } }
    db.close(); assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep)); await rm(directory, { recursive: true, force: true })
  })

  class IndependentEngine extends EventEmitter {
    info = initial(); items = []; token = ''
    async start() {} async getPlaybackInfo() { return { ...this.info } }
    getQueueSnapshot() { return this.items } getQueueToken() { return this.token } getPlaybackEnd() { return null }
    async continueAfterPlaybackEnd() { return false }
    async loadQueue(items, index=0) { this.items=items; this.token=randomUUID(); this.info.queueIndex=index; this.info.source=items[index]?.source || '' }
    async rebindQueue(request) { this.items=request.items; this.token=randomUUID(); return { queueToken:this.token } }
    async play() { assert.fail('An independent member cannot Play during group ownership') }
    async pause() { this.info.state='paused' } async stop() { this.info.state='stopped' }
    async seek(value) { this.info.position=value } async setVolume(value) { this.info.volume=value }
    async setPlayMode(value) { this.info.playMode=value } async setPlaybackRate(value) { this.info.playbackRate=value }
  }

  async function device(descriptor, devicePpm, hostPpm, dspFrames, dspRate, downstream, pipeline) {
    const child = spawn(executable, [], { stdio:['pipe','pipe','pipe'], windowsHide:true, env })
    const lines = createInterface({ input:child.stdout })[Symbol.asyncIterator]()
    let stderr = '', tail = Promise.resolve()
    child.stderr.on('data', b => { stderr += b })
    const exited = new Promise((r,j) => { child.once('error',j); child.once('exit',(code,signal)=>r({code,signal})) })
    const command = text => {
      const next=tail.then(async()=>{child.stdin.write(text+'\n');const row=await lines.next();assert.equal(row.done,false,stderr);return JSON.parse(row.value)})
      tail=next.then(()=>{},()=>{}); return next
    }
    const d = { id:descriptor.id, child, exited, devicePpm, hostPpm, downstream, pipeline,
      drift:devicePpm, connected:true, controller:null, monitor:new BridgeClockMonitor(), facts:null,
      ppm:0, seed:null, pending:null, fraction:0, at:now, target:null, position:0, probes:0, nextProbe:now,
      dsp:{revision:0,activeSceneId:null,totalLatencyFrames:dspFrames,totalTailFrames:0,latencySampleRate:dspRate,nodes:[],applyState:'applied',compileState:'ready'},
      playback:{...initial(),volume:devicePpm>0?.8:.4}, prepares:0, lastArm:0, phaseChecks:0, corrections:0 }
    devices.push(d)
    function exchange(time, frames, sequence) {
      const host = at => at*(1+hostPpm*1e-6)+5000+(devicePpm<0?12000:0)
      const up=.2+(sequence%7)*.01+(sequence%17===0?8:0), down=.2+(sequence%5)*.015+(sequence%11===0?12:0)
      const clock={...d.facts.clock,positionFrames:frames,sampledAtMs:host(time)+40000,readAtMs:host(time)+40000,callbackRequestedFrames:Math.ceil(frames+pipeline)}
      return {sentAtMs:time-.1-up,receivedAtMs:time+.1+down,remoteReceiveMs:host(time-.1),remoteSendMs:host(time+.1),
        nativeReadBeforeMs:host(time-.01),nativeReadAfterMs:host(time+.01),clock}
    }
    const read = async () => ({ playback:{...d.playback}, dsp:{...d.dsp}, bridge:{supported:true,hosting:false,receiving:false,selected:true,
      connected:d.connected,peerName:descriptor.name,error:null,receiver:d.facts || { adaptiveSupported:true,sampleRate:48000,channels:2,
        capacityFrames:12000,prebufferFrames:1920,bufferedFrames:0,consumedFrames:0,underruns:0,started:false,failed:false },
      timing:d.monitor.view(now+20),synchronization:d.controller?.view() || null} })
    d.output = { id:descriptor.id,downstreamDelayMs:downstream,read,
      async prepare(_item,position,current) {
        assert.ok(current());d.position=position;d.at=now;d.fraction=0;d.ppm=0;d.pending=null;d.controller=null;d.target=null;d.prepares++
        d.facts=await command(`prepare ${position*48000} ${d.dsp.totalLatencyFrames*48000/d.dsp.latencySampleRate} ${downstream*48} ${pipeline}`)
        d.monitor=new BridgeClockMonitor();d.nextProbe=now+250
        for(let i=0;i<4;i++)d.monitor.observe(exchange(now-(3-i)*250,d.facts.clock.positionFrames-(3-i)*12000*(1+d.drift*1e-6),i+1))
      },
      async arm(at,frame) {
        if(d.seed){d.ppm=d.seed.ratePpm;d.facts=await command(`rate ${d.ppm}`)}
        d.target=at;d.lastArm=now;d.facts=await command(`arm ${(at-now)*(1+hostPpm*1e-6)} ${frame}`)
        d.controller=new BridgeTimelineController({sampleRate:48000,startAtCoreMs:at,streamGeneration:d.facts.clock.streamGeneration,clockEpoch:d.facts.clock.epoch,mediaFrame:frame},d.ppm,d.seed||undefined)
        events.push({at:now-base,kind:'arm',id:d.id,position:d.position})
      },
      async silence() {
        if(d.controller)events.push({at:now-base,kind:'silence',id:d.id,sync:d.controller.view(),clock:d.monitor.view(now).output.driftPpm})
        d.seed=d.controller?.seed()||d.seed
        d.controller=null;d.pending=null;d.target=null;await command('close');d.facts=null
      },
      async volume(value) {d.playback.volume=value}
    }
    d.advance=async to=>{
      if(!d.target||!d.facts){d.at=to;return}
      if(d.pending&&d.pending.at<=to){d.ppm=d.pending.ppm;d.pending=null}
      const framesFloat=(to-d.at)*48*(1+d.drift*1e-6)+d.fraction, frames=Math.floor(framesFloat);d.fraction=framesFloat-frames
      const frameMs=(1+hostPpm*1e-6)/(48*(1+d.drift*1e-6))
      const firstDelta=(d.at-d.target)*(1+hostPpm*1e-6)+pipeline*frameMs
      d.facts=await command(`step ${d.ppm} ${frames} ${firstDelta} ${frameMs} ${pipeline} ${3840+(d.probes%7)*480}`)
      d.phaseChecks=d.facts.phaseChecks;d.at=to
      if(to>=d.nextProbe){
        d.nextProbe+=250
        const sample=exchange(to,d.facts.clock.positionFrames,++d.probes)
        d.facts.clock=sample.clock;d.monitor.observe(sample)
        const observation=d.monitor.presentation(d.facts,sample.receivedAtMs)
        if(observation){
          const decision=d.controller.update(observation,sample.receivedAtMs,!d.pending)
          assert.notEqual(decision.kind,'failed',JSON.stringify(d.controller.view()))
          if(decision.kind==='rate'){d.pending={at:to+100+(d.probes%3)*50,ppm:decision.ppm};d.corrections++}
        }
      }
    }
    const independent=new IndependentEngine(),playback=session(independent,descriptor.id);await playback.initialize()
    return { playback,dsp:{},groupOutput:d.output,output:async()=> (await read()).bridge,
      connect:async(_peer,coordinated)=>{assert.equal(coordinated,true);d.connected=true;d.seed=null},sources:()=>independent.items.map(i=>i.source),close:()=>playback.shutdown() }
  }

  local=await device({id:'local',name:'Controlled A'},200,-80,480,48000,0,480)
  let engine, shared, storedZones=[],storedGroups=[]
  registry=new CoreZoneRegistry({local,load:async()=>storedZones,save:async v=>{storedZones=v},newId:randomUUID,changed:()=>{},
    create:descriptor=>device(descriptor,-200,80,1920,96000,3,960),
    groups:{load:async()=>storedGroups,save:async v=>{storedGroups=v},create:async(descriptor,outputs)=>{
      engine=new SyncGroupEngine({outputs,initial:initial(),now:()=>now,wallNow:()=>now,token:randomUUID,
        wait:async(_ms,abort)=>{abort.throwIfAborted();assert.fail('Prepared clock/PCM must already be ready')},
        schedule:(action,ms)=>{const job={at:now+ms,action};scheduled=job;tickDone?.();tickDone=null;return()=>{if(scheduled===job)scheduled=null}},
        changed:()=>{if(engine?.state().phase==='failed'){tickDone?.();tickDone=null}}})
      shared=session(engine,descriptor.id);await shared.initialize()
      return {playback:shared,engine,sources:()=>engine.getQueueSnapshot().map(i=>i.source),close:async()=>{await shared.shutdown();await engine.close()}}
    }}})
  await registry.initialize();const zoneId=await registry.create('Controlled B',0)
  await registry.fromQuery('local',0,{ids:['tone']},'tone',signal())
  const view=await registry.list(),groupId=await registry.createGroup({revision:view.revision,name:'Soak group',
    members:view.zones.map(z=>({zoneId:z.id,revision:z.revision,downstreamDelayMs:z.id==='local'?0:3})),
    source:{zoneId:'local',queue:zoneQueueFence(view.zones[0].queue)}},signal())
  const queue=(await registry.listGroups()).groups[0].queue.id
  await registry.groupTransport(groupId,0,{kind:'play'},signal())
  const all=[],steady=[];let activeMs=0,estimatedMax=0,recovered=false,dspChanged=false,reversed=false
  for(let elapsed=100;elapsed<=duration;elapsed+=100){
    const to=base+elapsed
    if(!dspChanged&&elapsed>=duration/3){devices[1].dsp.totalLatencyFrames+=480;dspChanged=true;events.push({at:elapsed,kind:'dsp-delay'})}
    if(!reversed&&elapsed>=duration/2){for(const d of devices)d.drift=-d.drift;reversed=true;events.push({at:elapsed,kind:'reverse-drift'})}
    await Promise.all(devices.map(d=>d.advance(to)));now=to
    const audible=engine.state().audibleAtCoreMs
    if(audible!==null&&now>=audible&&devices.every(d=>d.facts?.analogMediaFrames!=null)){
      const error=Math.abs(devices[0].facts.analogMediaFrames-devices[1].facts.analogMediaFrames)/48
      all.push(error);activeMs+=100
      if(devices.every(d=>now-d.lastArm>60000)&&(elapsed<duration/2||elapsed>duration/2+120000))steady.push(error)
    }
    if(scheduled&&scheduled.at<=now){
      const job=scheduled;scheduled=null
      const done=new Promise(r=>{tickDone=r});job.action();await done
      assert.notEqual(engine.state().phase,'failed',engine.state().error)
      estimatedMax=Math.max(estimatedMax,engine.state().estimatedSkewMs||0)
    }
    if(!recovered&&elapsed>=duration*2/3){
      devices[1].connected=false
      if(scheduled){const job=scheduled;scheduled=null;const done=new Promise(r=>{tickDone=r});job.action();await done}
      assert.equal(engine.state().phase,'failed');assert.ok(devices.every(d=>d.facts===null))
      assert.ok((await registry.list()).zones.every(z=>z.groupId===groupId))
      await registry.connect(zoneId,{host:'localhost',port:1,token:'a'.repeat(48),fingerprint:'b'.repeat(64)},(await registry.list()).zones[1].revision)
      assert.notEqual((await registry.listGroups()).groups[0].playback.state,'playing')
      await registry.groupTransport(groupId,(await registry.listGroups()).groups[0].revision,{kind:'play'},signal())
      recovered=true;events.push({at:elapsed,kind:'explicit-reconnect'})
    }
    if(elapsed%60000===0){assert.equal((await registry.listGroups()).groups[0].queue.id,queue);await settle()}
  }
  const quantiles=values=>{const a=[...values].sort((a,b)=>a-b);return {samples:a.length,p50:a[Math.floor(a.length*.5)],p99:a[Math.floor(a.length*.99)],maximum:a.at(-1)}}
  const result={simulatedMs:duration,activeMs,steady:quantiles(steady),all:quantiles(all),estimatedMax,
    members:devices.map(d=>({id:d.id,prepares:d.prepares,corrections:d.corrections,phaseChecks:d.phaseChecks})),events}
  t.diagnostic(JSON.stringify(result))
  assert.ok(activeMs>duration*.95,'Excessive silence/rebuffer '+JSON.stringify(result))
  if(duration>=1800000){assert.ok(steady.length>duration/100*.7,'Repeated rebuffer must not hide long-term skew');assert.ok(result.steady.maximum<1,'Steady group skew '+JSON.stringify(result))}
  assert.ok(devices.every(d=>d.prepares>=3&&d.prepares<12&&d.corrections>100&&d.phaseChecks>1000))
  await registry.groupTransport(groupId,null,{kind:'pause'},signal());await shared.flush()
  assert.equal((await registry.listGroups()).groups[0].queue.id,queue)
  assert.equal((await registry.listGroups()).groups[0].playback.state,'paused')
  assert.equal(faults.length,0,faults.join('\n'))
})
