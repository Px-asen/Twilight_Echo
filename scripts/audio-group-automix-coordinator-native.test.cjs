'use strict'
// Actual Core coordinator + native exports/leases/prepare/render in two
// processes. Analysis tables and separation worker are controlled fixtures;
// DAC clocks are not hardware and no Python/model pack is installed.
const test=require('node:test'),assert=require('node:assert/strict')
const {fork}=require('node:child_process'),{once}=require('node:events')
const {mkdtemp,mkdir,writeFile,readFile,access,rm}=require('node:fs/promises')
const {join}=require('node:path'),{tmpdir}=require('node:os'),{createHash}=require('node:crypto')

test('one Core coordinator prepares rate-local stems and submits a common real-native handoff', {timeout:60000}, async t=>{
  await import('../src/adapters-node/index.ts')
  const [{SyncGroupEngine},{CoreAutoMixService},{ProviderPlaybackIdentityRegistry},am,{STEM_MODEL_VERSION,STEM_CHECKPOINT_SHA256}]=await Promise.all([
    import('../src/core/playback/syncGroupEngine.ts'),import('../src/core/audio/autoMixService.ts'),
    import('../src/core/audio/providerPlaybackIdentity.ts'),import('../src/shared/twilightAutoMix.ts'),import('../src/core/audio/autoMixStemService.ts')])
  const root=await mkdtemp(join(tmpdir(),'twilight-group-coordinator-')),children=[]
  let engine,service,coordinator,now=10000,scheduled
  t.after(async()=>{
    await service?.shutdown();await engine?.close()
    for(const w of children){try{await w.call('close');await w.exited}catch{if(w.child.exitCode===null)w.child.kill()}}
    await rm(root,{recursive:true,force:true})
  })
  function worker(){
    const child=fork(join(__dirname,'audio-group-automix-binding-native.test.cjs'),['--native-worker'],
      {execArgv:[],windowsHide:true,stdio:['ignore','ignore','pipe','ipc']})
    let serial=0,stderr='';const pending=new Map(),exited=once(child,'exit')
    child.stderr.on('data',data=>stderr+=data)
    child.on('message',message=>{const p=pending.get(message.id);if(!p)return;pending.delete(message.id)
      message.error?p.reject(Error(message.error+' '+message.info)):p.resolve(message.value)})
    child.on('exit',()=>{for(const p of pending.values())p.reject(Error('worker exit '+stderr));pending.clear()})
    const api={child,exited,call:(method,...args)=>new Promise((resolve,reject)=>{
      const id=++serial;pending.set(id,{resolve,reject});child.send({id,method,args})})}
    children.push(api);return api
  }
  function wave(hz){
    const rate=8000,frames=rate*90,b=Buffer.alloc(44+frames*4)
    b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16)
    b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*4,28)
    b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*4,40)
    for(let n=0;n<frames;n++)for(let c=0;c<2;c++)b.writeInt16LE(Math.round(4000*Math.sin(2*Math.PI*hz*n/rate)),44+n*4+c*2)
    return b
  }
  const files=[join(root,'a.wav'),join(root,'b.wav')]
  await Promise.all(files.map((file,i)=>writeFile(file,wave(i?330:220))))
  const items=files.map((source,i)=>({id:i?'b':'a',source,queueEntryId:i?'shared:b:1':'shared:a:1',duration:90}))
  const rates=[48000,44100],workers=rates.map(()=>worker()),calls=[],materials=[],analyses=[]
  const outputs=workers.map((w,i)=>{
    let loaded=false,timed='disabled',epoch=0,last
    const rate=rates[i]
    const invoke=async(method,...args)=>{calls.push({member:i,method});return w.call(method,...args)}
    const read=async()=>{
      if(loaded){const captured=await w.call('capture',1,1);last=captured.timelines[0]}
      const playback=await w.call('GetPlaybackInfo'),dsp=await w.call('GetDspGraphStatus')
      return {playback,dsp:{...dsp,applyState:'applied',compileState:'ready'},sourceTimeline:last?{...last,epoch}:null,
        bridge:{supported:true,hosting:false,receiving:false,selected:true,connected:true,peerName:'controlled DAC',error:null,
          receiver:{sampleRate:rate,channels:2,capacityFrames:rate/4,prebufferFrames:rate/25,bufferedFrames:rate/10,
            consumedFrames:0,underruns:0,started:true,failed:false,adaptiveSupported:true,
            timedStart:{state:timed,ended:false}},
          timing:{network:{state:'ready'},output:{state:'ready',ageMs:0}},
          synchronization:{state:'correcting',phaseErrorMs:0,uncertaintyMs:0}}}
    }
    return {id:`member-${i}`,downstreamDelayMs:0,read,prepare:async()=>assert.fail('requires continuous'),
      arm:async()=>{timed='running'},silence:async()=>{timed='disabled';await w.call('CancelAutoMix')},volume:async()=>{},
      continuous:{acquire:()=>w.call('SetBridgeQueueControl',true),release:()=>w.call('SetBridgeQueueControl',false),
        hold:()=>w.call('SetBridgeQueueControl',true),advance:async()=>assert.fail('AutoMix must own the transition'),
        rebind:async()=>true,prepare:async(_items,position)=>{await w.call('start',...files,rate,true,{},position);loaded=true;epoch++;timed='prepared'}},
      autoMix:{mode:mode=>w.call('SetBridgeAutoMixMode',mode),select:json=>invoke('SelectAutoMix',json),
        bind:async json=>{
          // Consume one follower-local ticket before the valid binding.
          const request=JSON.parse(json),bad=await w.call('BindBridgeAutoMixSelection',JSON.stringify({...request,
            sharedPlan:{...request.sharedPlan,nextEntryId:'wrong-local-ticket'}}))
          assert.equal(bad.ok,false)
          return invoke('BindBridgeAutoMixSelection',json)
        },prepare:async json=>{await invoke('PrepareAutoMix',json);return true},status:()=>w.call('GetPlaybackInfo'),
        submit:async id=>{await invoke('SubmitAutoMix',id);return true},cancel:async()=>{await w.call('CancelAutoMix');return true}}
    }
  })
  const pack=join(root,'pack');await mkdir(join(pack,'runtime'),{recursive:true});await mkdir(join(pack,'models'))
  const manifest=JSON.stringify({modelVersion:STEM_MODEL_VERSION,checkpointSha256:STEM_CHECKPOINT_SHA256})
  for(const [file,data] of [['manifest.json',manifest],['model.lock.json',manifest],['runtime/python.exe','fixture'],['models/955717e8-8726e21a.th','fixture']])
    await writeFile(join(pack,file),data)
  await writeFile(join(root,'worker.py'),'controlled test worker; never executed')
  engine=new SyncGroupEngine({outputs,initial:await workers[0].call('GetPlaybackInfo'),now:()=>now,wallNow:Date.now,token:()=>`queue-${now}`,
    wait:async ms=>{now+=ms},schedule:action=>{scheduled=action;return()=>{if(scheduled===action)scheduled=null}},changed:()=>{}})
  const attach=engine.setAutoMixCoordinator.bind(engine)
  engine.setAutoMixCoordinator=next=>{coordinator=next;attach(next)}
  service=new CoreAutoMixService({root,engine,settings:()=>({autoMixStemMode:'auto',autoMixStemDevice:'cpu',autoMixStemCacheMiB:256}),
    identities:new ProviderPlaybackIdentityRegistry(),authorize:async source=>source,useSources:action=>action(),now:Date.now,
    environment:async()=>({candidates:[pack],workerDirectory:root,temporaryDirectory:root}),probe:async()=>({cpu:true,gpu:false}),
    analysis:{cancel:()=>assert.fail('scoped cancellation only'),analyze:async(source,json,priority)=>{
      const o=JSON.parse(json),start=o.rangeStartSeconds,end=Math.min(90,start+30),voice=[]
      for(let n=0;n<64;n++){const s=Math.min(start+n*.48,end-.975);voice.push({startSeconds:s,endSeconds:s+.975,probability:.001,music:.9});if(s+.975>=end-1e-8)break}
      analyses.push({source,priority})
      return {ok:true,algorithm:'Twilight AutoMix',modelVersion:am.TWILIGHT_AUTOMIX_MODEL_VERSION,sourceIdentity:o.sourceIdentity,
        coverage:{startSeconds:start,endSeconds:end,durationSeconds:90,complete:false},bpm:120,tempoConfidence:.9,rmsDb:-12,peak:.3,
        key:-1,keyConfidence:0,beats:Array.from({length:(end-start)*2},(_,i)=>start+i*.5),downbeats:[],voice,
        frameDb:Array((end-start)*50).fill(-12),framePeak:Array((end-start)*50).fill(.3)}
    }},runWorker:async({requestPath},signal)=>{
      signal.throwIfAborted();const request=JSON.parse(await readFile(requestPath,'utf8')),selection=request.selection
      const stemMaterials={version:2,modelVersion:STEM_MODEL_VERSION,arrangementVersion:am.TWILIGHT_AUTOMIX_STEM_ARRANGEMENT_VERSION,selectionId:selection.selectionId}
      for(const [deck,prefix] of ['current','next'].entries()){
        const input=selection.inputs[deck],pcm=await readFile(input.path)
        assert.equal(pcm.length,input.frames*selection.channels*4)
        for(let n=0;n<pcm.length;n+=4)pcm.writeFloatLE(pcm.readFloatLE(n)*.8,n)
        const path=join(selection.stemDirectory,`${prefix}-mixed.f32`);await writeFile(path,pcm)
        stemMaterials[prefix]={...input,path,sha256:createHash('sha256').update(pcm).digest('hex')}
      }
      materials.push({rate:selection.sampleRate,id:selection.selectionId,directory:selection.stemDirectory,origins:selection.inputs.map(v=>v.origin)})
      await writeFile(join(selection.stemDirectory,'result.json'),JSON.stringify({ok:true,runId:request.runId,stemMaterials}))
    }})
  await engine.setAutoMixMode('natural');await engine.loadQueue(items);await engine.play(files[0],60);service.activate()
  await coordinator.idle()
  assert.equal(calls.filter(c=>c.method==='SelectAutoMix').length,1)
  assert.equal(calls.filter(c=>c.method==='BindBridgeAutoMixSelection').length,1)
  assert.equal(analyses.filter(a=>a.priority==='boundary').length,2,'analysis is group-level, not per-native')
  assert.deepEqual(materials.map(m=>m.rate),rates);assert.notEqual(materials[0].id,materials[1].id)
  assert.notEqual(materials[0].directory,materials[1].directory)
  assert.ok(Math.abs(materials[0].origins[0]/rates[0]-materials[1].origins[0]/rates[1])<1/44100)
  assert.equal(calls.filter(c=>c.method==='SubmitAutoMix').length,2,JSON.stringify(await engine.getPlaybackInfo()))
  assert.equal((await engine.getPlaybackInfo()).autoMixStemEnhanced,true,'group status must retain verified enhancement, not an initial member snapshot')
  const ready=await Promise.all(workers.map(w=>w.call('GetPlaybackInfo')))
  assert.ok(ready.every(s=>s.autoMixStemEnhanced),JSON.stringify(ready.map(s=>[s.autoMixState,s.autoMixReason,s.autoMixStemEnhanced])))
  for(const m of materials)await assert.rejects(access(m.directory),{code:'ENOENT'})
  const markers=await Promise.all(workers.map((w,i)=>w.call('handoff',rates[i],false,35)))
  assert.ok(Math.abs(markers[0].transitionFrame/rates[0]-markers[1].transitionFrame/rates[1])<.001)
  now=engine.state().audibleAtCoreMs+Math.max(...markers.map((m,i)=>m.transitionFrame*1000/rates[i]))+100
  const tick=scheduled;scheduled=null;tick();for(let n=0;n<100&&(await engine.getPlaybackInfo()).queueIndex!==1;n++)await new Promise(r=>setTimeout(r,5))
  assert.equal((await engine.getPlaybackInfo()).queueIndex,1,JSON.stringify(engine.state()))
  assert.equal((await engine.getPlaybackInfo()).naturalBoundaries.trackSerial,1)
  t.diagnostic('One common boundary analysis/policy; independent 48000/44100Hz native exports, ticket IDs, material origins, verified group enhancement status, common promotion and released directories; controlled separation output.')
})
