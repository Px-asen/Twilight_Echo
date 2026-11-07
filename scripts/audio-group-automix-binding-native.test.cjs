'use strict'
// Real C ABI/NAPI selection + member-local source binding, decoder, preparation
// and render handoff. Features are controlled policy evidence, not model output.
const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')
const { setTimeout: delay } = require('node:timers/promises')

if (process.argv.includes('--native-worker')) {
  const native = require(process.env.TWILIGHT_BRIDGE_NATIVE || resolve(__dirname, '../resources/audio-engine/twilight_audio_node.node'))
  process.on('message', async ({ id, method, args = [] }) => {
    try {
      let value
      if (method === 'start') {
        const [current, next, rate, owned = true, processing = {}, position = 74] = args
        native.Stop(); native.SetBridgeQueueControl(owned)
        native.SetOutputBackend('bridge-pcm'); native.SetOutputDevice(`${rate}/2`)
        native.SetOutputConfig(JSON.stringify({ routingMode: 'auto', pcmToDsdMode: 'off' }))
        native.SetVolume(1); native.SetPlaybackRate(1); native.SetAutoMixMode('off')
        if (owned) native.SetBridgeAutoMixMode('natural')
        native.SetDspConfig(JSON.stringify({ gapless: true, ...processing }))
        native.LoadQueue(JSON.stringify([{ id: 'a', source: current, queueEntryId: 'shared:a:1' },
          { id: 'b', source: next, queueEntryId: 'shared:b:1' }]), 0)
        native.SetPlayMode('sequential'); native.Play(current, position)
        for (let i=0;i<400&&!JSON.parse(native.GetPlaybackInfo()).preloadReady;i++) await delay(10)
        assert.equal(JSON.parse(native.GetPlaybackInfo()).preloadReady, true, native.GetPlaybackInfo())
        if (owned) native.CommitBridgeSourceControls()
        value = JSON.parse(native.GetPlaybackInfo())
      } else if (method === 'ready') {
        for (let i=0;i<1500;i++) {
          const info = JSON.parse(native.GetPlaybackInfo())
          if (info.autoMixState !== 'preparing') { value=info; break }
          await delay(10)
        }
        assert.equal(value?.autoMixState, 'ready', JSON.stringify(value))
      } else if (method === 'handoff') {
        const [rate, capture = false, maximumSeconds = 25] = args
        const blocks = [], gaps = []
        let initialGeneration
        for (let i=0;i<rate*maximumSeconds/1000;i++) {
          const block=native.PullBridgePcm(1000), timeline=JSON.parse(block.sourceTimeline)
          if (capture) blocks.push(block.pcm)
          if (capture && timeline?.entryId === 'shared:a:1' && timeline.positionFrames < 83.9*rate &&
              timeline.frames+74*rate-timeline.positionFrames > 1 && gaps.length < 8)
            gaps.push({frames:timeline.frames,position:timeline.positionFrames,gap:timeline.frames+74*rate-timeline.positionFrames,
              diagnostics:JSON.parse(native.GetPlaybackInfo()).diagnostics})
          initialGeneration ??= block.generation
          assert.equal(block.generation, initialGeneration)
          if (timeline?.transitionSerial) {
            value=timeline
            if (capture) {
              for (let n=0;n<12;n++) blocks.push(native.PullBridgePcm(1000).pcm)
              value={...value,pcm:Buffer.concat(blocks).toString('base64'),dsp:JSON.parse(native.GetDspGraphStatus()),gaps}
            }
            break
          }
          // Faster than a DAC, but leave the independent decoder worker time
          // to refill its bounded ring; this is not a decoder-throughput test.
          await delay(2)
        }
        assert.ok(value, native.GetPlaybackInfo())
      } else if (method === 'capture') {
        const [frames, chunk = 1000] = args, pcm = Buffer.alloc(frames*8), timelines = []
        for (let n=0;n<frames;n+=chunk) {
          const block=native.PullBridgePcm(Math.min(chunk,frames-n))
          block.pcm.copy(pcm,n*8);timelines.push(block.sourceTimeline ? JSON.parse(block.sourceTimeline) : null)
          await delay(2)
        }
        value={pcm:pcm.toString('base64'),timelines,
          info:JSON.parse(native.GetPlaybackInfo()),dsp:JSON.parse(native.GetDspGraphStatus())}
      } else if (method === 'close') {
        native.Stop(); process.send({ id, value: true }, () => process.disconnect()); return
      } else {
        value=native[method](...args)
        if (typeof value === 'string' && value.startsWith('{')) value=JSON.parse(value)
      }
      process.send({ id, value })
    } catch (error) { process.send({ id, error: String(error), info: native.GetPlaybackInfo() }) }
  })
} else if (!process.env.TWILIGHT_AUTOMIX_PROBE_ONLY) {
  const test=require('node:test')
  const { createHash }=require('node:crypto')
  const lock=require('../audio-engine/automix-native/dependencies.lock.json')
  const modelVersion=`twilight-automix-native-1:${lock.models['beat-this-small0'].graphSha256}:${lock.models.yamnet.graphSha256}`
  function wave(hz) {
    const rate=8000, frames=rate*90, bytes=Buffer.alloc(44+frames*4)
    bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16)
    bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*4,28)
    bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40)
    for(let n=0;n<frames;n++)for(let c=0;c<2;c++)bytes.writeInt16LE(Math.round(5000*Math.sin(n*2*Math.PI*hz/rate)),44+n*4+c*2)
    return bytes
  }
  function features(sourceIdentity, start, end, duration = 90) {
    const beats=[],voice=[]
    for(let s=start;s<end;s+=.5)beats.push(s)
    for(let n=0;n<64;n++){const s=Math.min(start+n*.48,end-.975);voice.push({startSeconds:s,endSeconds:s+.975,probability:.001,music:.9});if(s+.975>=end-1e-8)break}
    return {ok:true,algorithm:'Twilight AutoMix',modelVersion,sourceIdentity,
      coverage:{startSeconds:start,endSeconds:end,durationSeconds:duration,complete:start===0&&end===duration},bpm:120,tempoConfidence:.9,rmsDb:-12,peak:.4,
      key:-1,keyConfidence:0,beats,downbeats:[],voice,frameDb:Array(Math.ceil((end-start)*50)).fill(-12),framePeak:Array(Math.ceil((end-start)*50)).fill(.4)}
  }
  test('one owner policy binds two native frame domains and renders the same group handoff', {timeout:60000}, async t => {
    const directory=await mkdtemp(join(tmpdir(),'twilight-shared-automix-')), children=[]
    t.after(async()=>{
      for(const child of children){try{await child.call('close');await child.exited}catch{if(child.process.exitCode===null)child.process.kill()}}
      await rm(directory,{recursive:true,force:true})
    })
    const files=[join(directory,'a.wav'),join(directory,'b.wav')], hashes=[]
    for(let d=0;d<2;d++){const bytes=wave(d?330:220);await writeFile(files[d],bytes)
      // Required playback source identity, not an ordinary file-integrity check.
      hashes.push(createHash('sha256').update(bytes).digest('hex'))}
    function worker() {
      const child=fork(__filename,['--native-worker'],{execArgv:[],windowsHide:true,stdio:['ignore','ignore','pipe','ipc']})
      let serial=0, stderr='';child.stderr.on('data',data=>stderr+=data)
      const pending=new Map(),exited=once(child,'exit')
      child.on('message',message=>{const p=pending.get(message.id);if(!p)return;pending.delete(message.id)
        message.error?p.reject(Error(message.error+' '+message.info)):p.resolve(message.value)})
      child.on('exit',()=>{for(const p of pending.values())p.reject(Error('worker exited: '+stderr));pending.clear()})
      const api={process:child,exited,call:(method,...args)=>new Promise((resolve,reject)=>{
        const id=++serial;pending.set(id,{resolve,reject});child.send({id,method,args})})}
      children.push(api);return api
    }
    const leader=worker(), follower=worker()
    await Promise.all([leader.call('start',...files,48000),follower.call('start',...files,44100)])
    const request={ruleVersion:'twilight-rules-5',currentSource:files[0],nextSource:files[1],currentSourceStartSeconds:0,
      currentSourceEndSeconds:90,nextSourceStartSeconds:0,nextSourceEndSeconds:90,
      currentFeatures:features(hashes[0],60,90),nextFeatures:features(hashes[1],0,30)}
    // A capture sender has no autonomous device callback to ACK a graph
    // queued after startup. Selection must commit it before issuing a ticket.
    await Promise.all([leader.call('SetDspConfig',JSON.stringify({gapless:true})),
      follower.call('SetDspConfig',JSON.stringify({gapless:true}))])
    const selected=await leader.call('SelectAutoMix',JSON.stringify(request))
    assert.equal(selected.ok,true,JSON.stringify(selected));assert.ok(selected.sharedPlan)
    assert.equal(selected.sharedPlan.currentEntryId,'shared:a:1')
    const missing=await follower.call('BindBridgeAutoMixSelection',JSON.stringify(request))
    assert.equal(missing.ok,false);assert.equal(missing.reason,'invalid_shared_plan')
    // Failed binding consumes its own local plan number; follower IDs cannot be
    // inferred from the leader. No follower SelectAutoMix call is made.
    const bad=await follower.call('BindBridgeAutoMixSelection',JSON.stringify({...request,
      sharedPlan:{...selected.sharedPlan,nextEntryId:'wrong-occurrence'}}))
    assert.equal(bad.ok,false);assert.equal(bad.reason,'shared_source_binding_mismatch')
    const bound=await follower.call('BindBridgeAutoMixSelection',JSON.stringify({...request,sharedPlan:selected.sharedPlan}))
    assert.equal(bound.ok,true,JSON.stringify(bound));assert.notEqual(bound.selectionId,selected.selectionId)
    assert.equal(bound.sampleRate,44100);assert.equal(bound.strategy,selected.strategy)
    assert.ok(Math.abs(bound.currentStartSeconds-selected.currentStartSeconds)<1/44100)
    await Promise.all([leader.call('PrepareAutoMix',JSON.stringify({...request,selectionId:selected.selectionId})),
      follower.call('PrepareAutoMix',JSON.stringify({...request,selectionId:bound.selectionId}))])
    const ready=await Promise.all([leader.call('ready'),follower.call('ready')])
    await Promise.all([leader.call('SubmitAutoMix',ready[0].autoMixPlanId),follower.call('SubmitAutoMix',ready[1].autoMixPlanId)])
    const transitions=await Promise.all([leader.call('handoff',48000),follower.call('handoff',44100)])
    assert.ok(Math.abs(transitions[0].transitionFrame/48000-transitions[1].transitionFrame/44100)<.001,
      JSON.stringify(transitions))
    for(const timeline of transitions){assert.equal(timeline.entryId,'shared:b:1');assert.equal(timeline.transitionSerial,1)
      assert.ok(timeline.positionFrames>0)}
    // Local preference edits are retained while the group keeps its own mode.
    await follower.call('SetAutoMixMode','dj')
    assert.equal((await follower.call('GetPlaybackInfo')).autoMixMode,'natural')
    await follower.call('SetBridgeQueueControl',false)
    await delay(130)
    assert.equal((await follower.call('GetPlaybackInfo')).autoMixMode,'dj')
    await assert.rejects(follower.call('SetBridgeAutoMixMode','natural'))
    // A local transport mutation invalidates the already issued follower ticket.
    await follower.call('start',...files,44100)
    const ticket=await follower.call('BindBridgeAutoMixSelection',JSON.stringify({...request,sharedPlan:selected.sharedPlan}))
    assert.equal(ticket.ok,true)
    await follower.call('Seek',75)
    await assert.rejects(follower.call('PrepareAutoMix',JSON.stringify({...request,selectionId:ticket.selectionId})),/stale_selection_ticket/)
    await follower.call('start',...files,44100,false)
    const outside=await follower.call('BindBridgeAutoMixSelection',JSON.stringify({...request,sharedPlan:selected.sharedPlan}))
    assert.equal(outside.ok,false);assert.equal(outside.reason,'group_ownership_required')
    // Same source/filter, 50ms different DSP latency. Align each rendered PCM
    // stream by its reported latency, exactly as the group's DAC start does.
    // Both the waveform and the post-DSP mixing envelope must then agree.
    const ir=join(directory,'unity-ir.wav'), impulse=Buffer.alloc(44+128*8)
    impulse.write('RIFF');impulse.writeUInt32LE(impulse.length-8,4);impulse.write('WAVEfmt ',8);impulse.writeUInt32LE(16,16)
    impulse.writeUInt16LE(3,20);impulse.writeUInt16LE(2,22);impulse.writeUInt32LE(48000,24);impulse.writeUInt32LE(384000,28)
    impulse.writeUInt16LE(8,32);impulse.writeUInt16LE(32,34);impulse.write('data',36);impulse.writeUInt32LE(128*8,40)
    impulse.writeFloatLE(1,44);impulse.writeFloatLE(1,48);await writeFile(ir,impulse)
    const processing={dspEnabled:true,convolverEnabled:true,convolverIrPath:ir}
    await Promise.all([leader.call('start',...files,48000,true,{...processing,convolverDelayMs:0}),
      follower.call('start',...files,48000,true,{...processing,convolverDelayMs:50})])
    const policy={...selected.sharedPlan,currentStartFrame:80*48000,currentEndFrame:84*48000,nextStartFrame:0,
      nextEndFrame:4*48000,outputFrames:4*48000,currentRate:1,nextRate:1,nextGain:1,effect:0,kind:1,bpm:0,confidence:0,score:1}
    const tickets=await Promise.all([leader,follower].map(w=>w.call('BindBridgeAutoMixSelection',JSON.stringify({...request,sharedPlan:policy}))))
    assert.ok(tickets.every(t=>t.ok),JSON.stringify(tickets))
    await Promise.all([leader,follower].map((w,i)=>w.call('PrepareAutoMix',JSON.stringify({...request,selectionId:tickets[i].selectionId}))))
    const dspReady=await Promise.all([leader.call('ready'),follower.call('ready')])
    await Promise.all([leader,follower].map((w,i)=>w.call('SubmitAutoMix',dspReady[i].autoMixPlanId)))
    const captured=await Promise.all([leader.call('handoff',48000,true),follower.call('handoff',48000,true)])
    const audio=captured.map(v=>Buffer.from(v.pcm,'base64')),latencies=captured.map(v=>v.dsp.totalLatencyFrames)
    assert.equal(latencies[1]-latencies[0],2400)
    assert.deepEqual(captured.map(v=>v.transitionFrame),[480000,480000],JSON.stringify(captured.map(({pcm: _pcm,...v})=>v)))
    assert.equal(captured[0].frames-captured[0].positionFrames,captured[1].frames-captured[1].positionFrames)
    for(const [lo,hi] of [[48000,96000],[7*48000,9*48000],[10*48000,10*48000+4800]]) {
      let squared=0
      for(let frame=lo;frame<hi;frame++)squared+=(audio[0].readFloatLE((frame+latencies[0])*8)-audio[1].readFloatLE((frame+latencies[1])*8))**2
      const rms=Math.sqrt(squared/(hi-lo))
      assert.ok(rms<1e-6,`DSP-compensated PCM/envelope RMS difference ${rms} in ${lo}..${hi}`)
    }
    // A short source can finish before even one graph-latency has elapsed.
    // Compare with a zero-extended source, not a hand-written convolution model.
    const pcmWave=(frames, impulseAt)=>{
      const bytes=Buffer.alloc(44+frames*8)
      impulse.subarray(0,44).copy(bytes);bytes.writeUInt32LE(bytes.length-8,4);bytes.writeUInt32LE(frames*8,40)
      for(const at of impulseAt)for(let c=0;c<2;c++)bytes.writeFloatLE(.2,44+at*8+c*4)
      return bytes
    }
    const longIr=join(directory,'long-ir.wav'),echo=pcmWave(4097,[0,4096])
    echo.writeFloatLE(1,44);echo.writeFloatLE(1,48);await writeFile(longIr,echo)
    const tailProcessing={...processing,convolverIrPath:longIr,convolverDelayMs:50}
    const short=join(directory,'terminal-short.wav'),padded=join(directory,'terminal-padded.wav')
    await writeFile(short,pcmWave(960,[959]));await writeFile(padded,pcmWave(12000,[959]))
    await Promise.all([leader.call('start',short,short,48000,true,tailProcessing,0),
      follower.call('start',padded,padded,48000,true,tailProcessing,0)])
    await Promise.all([leader.call('SetBridgeAutoMixMode','off'),follower.call('SetBridgeAutoMixMode','off')])
    const terminal=await Promise.all([leader.call('capture',10000,257),follower.call('capture',10000,257)])
    const endedPcm=Buffer.from(terminal[0].pcm,'base64'),paddedPcm=Buffer.from(terminal[1].pcm,'base64')
    let tailError=0,tailEnergy=0
    for(let n=0;n<10000;n++){const expected=paddedPcm.readFloatLE(n*8);tailError+=(endedPcm.readFloatLE(n*8)-expected)**2;tailEnergy+=expected**2}
    assert.ok(tailEnergy>.01,'reference must emit the delayed terminal impulse')
    assert.ok(tailError<1e-10,`terminal DSP tail differs from zero-extended source: squared error ${tailError}`)
    assert.equal(terminal[0].timelines.filter(Boolean).at(-1).positionFrames,960,'DSP drain is not source consumption')
    await delay(150) // Native control/status publication runs on a 100ms clock.
    assert.equal((await leader.call('GetPlaybackInfo')).state,'stopped')
    // Incoming EOF inside the common post-DSP mix drain. A zero-extended
    // counterpart must produce the same samples, including its final echo.
    const shortNext=join(directory,'mix-short-next.wav'),paddedNext=join(directory,'mix-padded-next.wav')
    const shortBytes=pcmWave(4*48000+240,[4*48000-5,4*48000+239])
    const paddedBytes=pcmWave(4*48000+8000,[4*48000-5,4*48000+239])
    await writeFile(shortNext,shortBytes);await writeFile(paddedNext,paddedBytes)
    const nextFiles=[paddedNext,shortNext],nextBytes=[paddedBytes,shortBytes],nextFrames=[200000,192240]
    await Promise.all([leader.call('start',files[0],paddedNext,48000,true,{...tailProcessing,convolverDelayMs:0}),
      follower.call('start',files[0],shortNext,48000,true,tailProcessing)])
    const nearEofRequests=nextFiles.map((file,i)=>{
      const identity=createHash('sha256').update(nextBytes[i]).digest('hex'),duration=nextFrames[i]/48000
      return {...request,nextSource:file,nextSourceEndSeconds:duration,nextFeatures:features(identity,0,duration,duration),
        sharedPlan:{...policy,nextIdentity:identity,nextSourceEndSeconds:duration}}
    })
    const nearTickets=await Promise.all([leader,follower].map((w,i)=>w.call('BindBridgeAutoMixSelection',JSON.stringify(nearEofRequests[i]))))
    assert.ok(nearTickets.every(t=>t.ok),JSON.stringify(nearTickets))
    await Promise.all([leader,follower].map((w,i)=>w.call('PrepareAutoMix',JSON.stringify({...nearEofRequests[i],selectionId:nearTickets[i].selectionId}))))
    const nearReady=await Promise.all([leader.call('ready'),follower.call('ready')])
    await Promise.all([leader,follower].map((w,i)=>w.call('SubmitAutoMix',nearReady[i].autoMixPlanId)))
    const nearEof=await Promise.all([leader.call('capture',11*48000),follower.call('capture',11*48000)])
    const nearPcm=nearEof.map(v=>Buffer.from(v.pcm,'base64')),nearDelay=nearEof.map(v=>v.dsp.totalLatencyFrames)
    let nearError=0
    for(let n=48000;n<10*48000+5000;n++)nearError+=(nearPcm[0].readFloatLE((n+nearDelay[0])*8)-nearPcm[1].readFloatLE((n+nearDelay[1])*8))**2
    assert.ok(nearError<1e-8,`incoming EOF/terminal echo differs from zero extension: squared error ${nearError}`)
    await delay(150)
    for(const [i,result] of nearEof.entries()){
      const promoted=result.timelines.filter(v=>v?.transitionSerial)
      assert.ok(promoted.length,'EOF must not strand the mix in a drain loop')
      assert.equal(promoted[0].transitionFrame,480000)
      assert.ok(promoted.every(v=>v.positionFrames<=nextFrames[i]),'zero input must not advance source position past EOF')
      assert.equal((await [leader,follower][i].call('GetPlaybackInfo')).state,'stopped')
    }
    t.diagnostic('Terminal convolution delay/echo equals zero extension; incoming EOF inside the mix drain completes once, flushes its tail and preserves the real source cursor.')
    t.diagnostic(`Shared ${selected.strategy} decision; native 48000/44100Hz handoff difference ${(1000*Math.abs(transitions[0].transitionFrame/48000-transitions[1].transitionFrame/44100)).toFixed(5)}ms, independent selection/preparation IDs, source leases and local-mode restoration.`)
    t.diagnostic(`Member DSP delays ${latencies.join('/')} frames: aligned PCM agrees before, during and after the common mix; source boundary and post-handoff origin agree.`)
  })
}
