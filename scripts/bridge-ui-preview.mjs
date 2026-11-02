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
  actualSampleRate:48000, actualBitDepth:24, actualChannels:2, actualOutputFormat:'int24-in32', exclusive:true }
let revision = 1, hosting = false, selected = true, connected = true
const zone = () => ({ revision, zoneId:'local', supported:true, hosting, receiving:false, selected, connected,
  peerName:'书房电脑', error:selected && !connected ? '输出桥连接已关闭；未切换到本机输出' : null,
  receiver:connected ? facts : null, selectedOutputId:selected?'bridge':'local',
  outputs:[{id:'local',name:'此电脑',available:!hosting},{id:'bridge',name:'书房电脑 · USB DAC',available:!hosting}] })
const path = () => ({zoneId:'local',source:{sampleRate:44100,bitDepth:16,channels:2,codec:'FLAC'},
  decoded:{sampleRate:44100,bitDepth:32,channels:2,format:'float32'},
  dsp:{applyState:'applied',nodes:[{type:'equalizer',active:true}],outputStage:{actualSampleRate:48000,resampled:true}},
  transport:{kind:selected?'tls-pcm':'local',sampleRate:48000,channels:2,connected},receiver:selected&&connected?facts:null,
  output:{backend:connected?'wasapi-exclusive':'',sampleRate:connected?48000:0,bitDepth:connected?24:0,channels:connected?2:0,deviceName:connected?'USB DAC':null},hardware:null})
window.bridgeFixtureCore = {
  state:shallowRef({phase:'ready'}),
  query:async name=>name==='zones.state'?zone():name==='audio.signalPath'?path():{invitation:'twilight-bridge://fixture.invalid:12345?token=fixture-only'},
  command:async(name,payload)=>{
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
  h('button',{onClick:()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'pureWhite':'dark'},'切换明暗'),
 ]),h(BridgeOutputPanel,{manage:true})
])}).mount('#app')
`
const server = await createServer({
  configFile: false, root,
  server: {
    host: '127.0.0.1', port: 5187, strictPort: true,
    // Builds replace native DLLs here; the fixture only needs renderer sources.
    watch: { ignored: ['**/out/**', '**/resources/audio-engine/**'] }
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
body{margin:0;background:var(--te-settings-backplate,var(--te-app-bg,#181a1e));color:var(--color-text,#eee);font-family:'Segoe UI','Microsoft YaHei',sans-serif}
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
