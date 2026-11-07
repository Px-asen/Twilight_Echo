// Isolated UI fixture: real Vue panel, simulated Core only, no native/device IO.
// Run `node scripts/bridge-ui-preview.mjs`, then open the printed loopback URL.
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixture = `
import { createApp, h, shallowRef } from 'vue'
import BridgeOutputPanel from '/src/renderer/src/components/settings-page/BridgeOutputPanel.vue'
import '/src/renderer/src/assets/main.css'
const facts = { sampleRate:48000, channels:2, bufferedFrames:3840, capacityFrames:12000, prebufferFrames:1920,
  consumedFrames:144000, underruns:0, started:true, failed:false, backend:'wasapi-exclusive', deviceName:'USB DAC',
  actualSampleRate:48000, actualBitDepth:24, actualChannels:2, actualOutputFormat:'int24-in32', exclusive:true, adaptiveSupported:true }
let revision = 1, hosting = false, selected = true, connected = true
let clockState = 'ready', adaptive = false
const timing = () => ({network:{state:clockState==='stale'?'stale':'ready',samples:21,offsetMs:3,roundTripMs:2.4,uncertaintyMs:1.2},
  output:{state:clockState,source:'wasapi-audio-clock',streamGeneration:1,epoch:1,sampleRate:48000,positionFrames:144000,
    sampledAtCoreMs:10000,ageMs:12,callbackRequestedFrames:148000,driftPpm:100.12,windowMs:60000,samples:241,residualFrames:.2}})
const ids = ['zone-11111111-1111-4111-8111-111111111111','zone-22222222-2222-4222-8222-222222222222']
let topologyRevision = 0
const groups = []
const sessions = ['local',...ids].map((id,i)=>({id,name:['此电脑主会话','书房','卧室'][i],revision:0,
  track:{id:'song-'+i,title:['Moon River','Clair de lune','Blue in Green'][i],artist:['Audrey Hepburn','Claude Debussy','Miles Davis'][i]},
  queue:{id:'queue-'+i,revision:0,total:12,index:0,occurrenceId:'entry-'+i},
  playback:{state:'paused',position:21,duration:240,volume:.5},output:null,error:null}))
const processing = new Map(sessions.map((s,i)=>[s.id,{revision:0,processing:{dspEnabled:true,directMode:false,eqEnabled:true,eqPreamp:i===1?-6:0}}]))
const zone = () => ({ revision, zoneId:'local', groupId:sessions[0].groupId??null, supported:true, hosting, receiving:false, selected, connected,
  peerName:'书房电脑', error:selected && !connected ? '输出桥连接已关闭；未切换到本机输出' : null,
  receiver:connected ? facts : null, selectedOutputId:selected?'bridge':'local',
  outputs:[{id:'local',name:'此电脑',available:!hosting},{id:'bridge',name:'书房电脑 · USB DAC',available:!hosting}] })
const path = () => ({zoneId:'local',source:{sampleRate:44100,bitDepth:16,channels:2,codec:'FLAC'},
  decoded:{sampleRate:44100,bitDepth:32,channels:2,format:'float32'},
  dsp:{applyState:'applied',nodes:[{type:'equalizer',active:true}],outputStage:{actualSampleRate:48000,resampled:true}},
  transport:{kind:selected?'tls-pcm':'local',sampleRate:48000,channels:2,connected},receiver:selected&&connected?{...facts,
    adaptive:adaptive?{requestedPpm:100.1,effectivePpm:99.7,inputFrames:148000,resamplerDelayFrames:134,pendingInputFrames:134,sourceConsumedFrames:144000,inputCreditFrames:8000}:null,
    timedStart:adaptive?{state:'running',presentedMediaFrames:139210.75}:null}:null,timing:selected&&connected?timing():null,
  output:{backend:connected?'wasapi-exclusive':'',sampleRate:connected?48000:0,bitDepth:connected?24:0,channels:connected?2:0,deviceName:connected?'USB DAC':null},hardware:null})
window.bridgeFixtureCore = {
  state:shallowRef({phase:'ready'}),
  query:async(name,payload={})=>{
    if(name==='groups.list') return {revision:topologyRevision,error:null,groups:structuredClone(groups)}
    if(name==='groups.signalPath') return {...path(),zoneId:payload.zoneId}
    if(name==='zones.list') return {revision:topologyRevision,limit:4,error:null,zones:sessions.map(s=>({...structuredClone(s),output:s.id==='local'?zone():{...zone(),selected:true,connected:s.id===ids[0],peerName:s.name+'电脑'}}))}
    if(name==='zones.dsp') return structuredClone(processing.get(payload.zoneId))
    if(name==='zones.signalPath') return {...path(),zoneId:payload.zoneId}
    return name==='zones.state'?zone():name==='audio.signalPath'?path():{invitation:'twilight-bridge://fixture.invalid:12345?token=fixture-only'}
  },
  command:async(name,payload)=>{
    if(name==='groups.create'){
      const source=sessions.find(s=>s.id===payload.source.zoneId),id='group-'+crypto.randomUUID()
      const group={id,name:payload.name,members:payload.members.map(({zoneId,downstreamDelayMs})=>({zoneId,downstreamDelayMs})),revision:0,
        track:{...source.track},queue:{...source.queue,id:'group-queue-'+Date.now()},playback:{...source.playback,state:'paused'},error:null,
        coordination:{phase:'paused',estimatedSkewMs:null,observationRangeMs:null,members:[]}}
      for(const m of group.members){const s=sessions.find(s=>s.id===m.zoneId);s.groupId=id;s.revision++;s.playback.state='paused'}
      groups.push(group);topologyRevision++;return{id}
    }
    if(name==='groups.remove'){
      for(const s of sessions)if(s.groupId===payload.groupId){s.groupId=null;s.playback.state='paused'}
      groups.splice(groups.findIndex(g=>g.id===payload.groupId),1);topologyRevision++;return
    }
    if(name==='groups.transport'){
      const g=groups.find(g=>g.id===payload.groupId),own=++g.revision
      if(payload.action.kind==='play'){
        g.coordination.phase='preparing';await new Promise(r=>setTimeout(r,1800));if(g.revision!==own)throw Error('播放已取消')
        g.playback.state='playing';g.coordination.phase='playing';g.coordination.estimatedSkewMs=.42;g.coordination.observationRangeMs=.8
      }else if(payload.action.kind==='volume')g.playback.volume=payload.action.volume
      else if(payload.action.kind==='seek')g.playback.position=payload.action.position
      else{g.playback.state=payload.action.kind==='pause'?'paused':'stopped';g.coordination.phase='paused'}
      return
    }
    if(name==='groups.queueFromQuery'){const g=groups.find(g=>g.id===payload.groupId);g.revision++;g.track={title:'新组队列',artist:'测试艺术家'};g.playback.state='paused';return}
    if(name==='zones.handoff'){
      const source=sessions.find(s=>s.id===payload.source.zoneId),target=sessions.find(s=>s.id===payload.target.zoneId)
      if(source.revision!==payload.source.revision||target.revision!==payload.target.revision) throw Error('会话状态已变化，请刷新')
      if(target.queue&&!payload.replace) throw Error('请明确确认替换目标会话的队列')
      source.playback.state='paused';source.revision++;target.revision++
      target.track={...source.track};target.queue={...source.queue,id:'copied-'+Date.now()}
      target.playback={...target.playback,state:payload.resume?'playing':'paused',position:source.playback.position}
      return
    }
    if(name==='zones.create'){
      if(payload.revision!==topologyRevision||sessions.length>=4) throw Error('请刷新 Zone 列表')
      const id='zone-'+crypto.randomUUID();sessions.push({id,name:payload.name,revision:0,track:null,queue:null,playback:{state:'stopped',volume:.5},error:null})
      processing.set(id,{revision:0,processing:{dspEnabled:true,eqPreamp:0}});topologyRevision++;return {id}
    }
    if(name==='zones.remove'){sessions.splice(sessions.findIndex(s=>s.id===payload.zoneId),1);topologyRevision++;return}
    if(name==='zones.dsp.edit'){
      const dsp=processing.get(payload.zoneId);if(dsp.revision!==payload.revision) throw Error('DSP 已变化')
      Object.assign(dsp.processing,payload.edit.settings);dsp.revision++;return
    }
    if(name==='zones.transport'){
      const s=sessions.find(s=>s.id===payload.zoneId);if(payload.revision!==null&&s.revision!==payload.revision) throw Error('会话已变化，请刷新')
      const own=++s.revision
      if(payload.action.kind==='play'){
        await new Promise(resolve=>setTimeout(resolve,1800));if(s.revision!==own) throw Error('播放已取消')
        s.playback.state='playing'
      }else if(payload.action.kind==='volume')s.playback.volume=payload.action.volume
      else s.playback.state=payload.action.kind==='pause'?'paused':'stopped'
      return
    }
    if(name==='zones.queueFromQuery'){const s=sessions.find(s=>s.id===payload.zoneId);s.revision++;s.track={title:'新队列测试曲目',artist:'测试艺术家'};s.queue={id:'prepared-'+Date.now(),revision:0,index:0,total:8,occurrenceId:'new-entry'};return}
    if(name==='zones.connect') return
    if(payload.revision!==revision) throw Error('输出已变化，请刷新')
    if(name==='zones.select'){selected=payload.outputId==='bridge';connected=selected}
    if(name==='bridge.connect'){selected=connected=true}
    if(name==='bridge.host'){hosting=payload.enabled;connected=false}
    revision++
  }
}
createApp({render:()=>h('main',{class:'fixture'},[
 h('div',{class:'fixture-kicker'},'TWILIGHT ECHO / 界面测试 · 模拟 Core'),
 h('h1','播放与输出'),h('p','以下为真实输出桥组件；所有连接和音频状态均为测试数据。'),
 h('nav',[
  h('button',{onClick:()=>{selected=true;connected=false;revision++}},'模拟断线'),
  h('button',{onClick:()=>{clockState=clockState==='ready'?'stale':'ready'}},'切换时钟过期'),
  h('button',{onClick:()=>{adaptive=!adaptive}},'切换时钟 SRC'),
  h('button',{onClick:()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'pureWhite':'dark'},'切换明暗'),
 ]),h(BridgeOutputPanel,{manage:true})
])}).mount('#app')
`
const server = await createServer({
  configFile: false, root,
  server: {
    host: '127.0.0.1', port: 5187, strictPort: true,
    // Builds replace native DLLs here; the fixture only needs renderer sources.
    watch: { ignored: ['**/out/**', '**/resources/audio-engine/**', '**/tmp/**', '**/.cache/**', '**/dist/**'] }
  },
  resolve: { alias: { '@renderer': resolve(root, 'src/renderer/src') } },
  plugins: [{
    name: 'bridge-isolated-preview', enforce: 'pre',
    resolveId(source) {
      if (source === 'bridge-fixture') return '\0bridge-fixture'
      if (/(?:^|\/)coreConnection(?:\.ts)?$/.test(source)) return '\0bridge-fixture-core'
    },
    load(id) {
      if (id === '\0bridge-fixture') return fixture
      if (id === '\0bridge-fixture-core') return 'export const useCoreConnection=()=>window.bridgeFixtureCore'
    },
    configureServer(server) {
      server.middlewares.use('/bridge-preview', async (_req, res) => {
        const html = await server.transformIndexHtml('/bridge-preview', `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twilight Echo · Bridge UI Fixture</title><style>
body{margin:0;overflow:auto!important;background:var(--te-settings-backplate,var(--te-app-bg,#181a1e));color:var(--color-text,#eee);font-family:'Segoe UI','Microsoft YaHei',sans-serif}
.fixture{max-width:840px;margin:48px auto;padding:0 28px 64px}.fixture-kicker{font-size:12px;letter-spacing:.06em;opacity:.6}h1{font-size:28px;margin:12px 0}nav{display:flex;gap:10px;margin-top:24px}nav button{padding:8px 14px;border:1px solid #8885;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
@media(max-width:600px){.fixture{margin:24px auto;padding:0 20px 32px}}
</style></head><body><div id="app"></div><script type="module" src="/@id/__x00__bridge-fixture"></script></body></html>`)
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html)
      })
    }
  }, vue()]
})
await server.listen()
console.log('Bridge UI fixture: http://127.0.0.1:5187/bridge-preview (simulated Core; no DAC IO)')
