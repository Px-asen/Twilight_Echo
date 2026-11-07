import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('real player artwork and volume reversals stay continuous without scaling lyrics or changing playback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playback-surfaces-'))
  try {
    await writeFile(
      join(directory, 'shell-stores.mjs'),
      (
        await readFile(join(workspace, 'scripts/fixtures/appearance-preview-stores.mjs'), 'utf8')
      ).replaceAll('__SHARED__', join(workspace, 'src/shared').replaceAll('\\', '/'))
    )
    await writeFile(join(directory, 'entry.mjs'), runtime)
    await build({
      configFile: false,
      root: workspace,
      publicDir: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'playback-surface-data',
          enforce: 'pre',
          resolveId(source) {
            if (/(?:^|\/)usePlayerStore(?:\.ts)?$/.test(source)) return '\0motion-player'
            if (/(?:^|\/)useSettingsStore(?:\.ts)?$/.test(source)) return '\0motion-settings'
            if (/\/stores\/lyricsManagement(?:\.ts)?$/.test(source)) return '\0motion-lyrics'
            if (/\/stores\/(useThemeStore|useNcmStore)(?:\.ts)?$/.test(source))
              return join(directory, 'shell-stores.mjs')
            return null
          },
          load(id) {
            if (id === '\0motion-player')
              return 'export const usePlayerStore=()=>window.motionPlayer'
            if (id === '\0motion-settings')
              return 'export const useSettingsStore=()=>window.motionSettings'
            if (id === '\0motion-lyrics')
              return 'export const useLyricsManagement=()=>window.motionLyrics'
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.mjs'),
          name: 'PlaybackSurfaces',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="full"><head><meta charset="utf-8">${files
        .filter((name) => name.endsWith('.css'))
        .map((name) => `<link rel="stylesheet" href="bundle/${name}">`)
        .join(
          ''
        )}<style>html,body,#app{margin:0;height:100%;overflow:hidden}body::before,body::after{display:none!important}.fixture-library{padding:100px 7vw;height:100%;box-sizing:border-box;background:var(--te-app-bg);color:var(--te-neutral-900)}.fixture-library h1{font-size:40px}.fixture-covers{display:flex;gap:24px;margin-top:40px}.fixture-covers img{width:180px;height:180px;border-radius:12px}</style></head><body><div id="app"></div><script src="bundle/${files.find((name) => name.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const{app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs/promises'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:850,useContentSize:true,webPreferences:{offscreen:true,nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});ipcMain.handle('surface-capture',async(_e,name)=>{const dir=process.env.TWILIGHT_MOTION_VISUAL_DIR;if(dir){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,name+'.png'),(await win.webContents.capturePage()).toPNG())}});try{await win.loadFile(path.join(__dirname,'index.html'));console.log('PLAYBACK_SURFACES_OK '+JSON.stringify(await win.webContents.executeJavaScript('window.testPlaybackSurfaces()')));app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 }
    )
    assert.match(result.stdout, /PLAYBACK_SURFACES_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = String.raw`import{createApp,h,ref,nextTick}from'vue'
import{createPinia}from'pinia'
import PlayerBar from '@renderer/components/PlayerBar.vue'
import PlayingMusic from '@renderer/components/PlayingMusic.vue'
import MotionTransition from '@renderer/components/MotionTransition.vue'
import{useSharedArtwork}from'@renderer/app/motion/useSharedArtwork'
import{useMotionPreference}from'@renderer/app/useMotionPreference'
import{usePlayerStore as fixturePlayer,useSettingsStore as fixtureSettings}from'./shell-stores.mjs'
import{DEFAULT_LYRICS_APPEARANCE}from'@renderer/../../shared/lyricsAppearance.ts'
import{DEFAULT_LYRICS_MANAGEMENT}from'@renderer/../../shared/lyricsManagement.ts'
import '@renderer/assets/main.css'
import '@renderer/assets/icon-fonts.ts'
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),tick=async()=>{await nextTick();await new Promise(requestAnimationFrame)},expect=(value,message)=>{if(!value)throw Error(message)}
const click=element=>{element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,isPrimary:true}));element.click()}
const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const paint=canvas.getContext('2d');paint.fillStyle='#294956';paint.fillRect(0,0,512,512);paint.fillStyle='#f4d2a6';paint.beginPath();paint.arc(348,140,72,0,Math.PI*2);paint.fill();paint.strokeStyle='#c6e2df';paint.lineWidth=8;for(let i=0;i<6;i++){paint.beginPath();paint.moveTo(-20,320+i*40);paint.lineTo(560,180+i*40);paint.stroke()}const cover=canvas.toDataURL()
const track={id:'surface-track',title:'潮汐与月',artist:'林晚',album:'潮汐',duration:263,cover,source:'local',lyrics:'[00:00.00]潮水轻轻漫过岸边\n[00:20.00]月光落在你的身旁\n[00:40.00]所有声音慢慢走远\n[01:00.00]留一盏灯，陪夜晚'}
window.api={data:{loadPlaybackBookmarks:async()=>null},diagnostics:{record:()=>{}},providers:{list:async()=>[]}}
window.motionSettings={settings:ref({...fixtureSettings().settings.value,theme:'dark',motionPreference:'full',nowPlayingBackground:'solid',lyricsAppearance:structuredClone(DEFAULT_LYRICS_APPEARANCE)})}
window.motionLyrics={document:ref(structuredClone(DEFAULT_LYRICS_MANAGEMENT)),entryFor:()=>undefined,effectiveOffsetSeconds:()=>0,ensureLoaded:async()=>{}}
window.motionPlayer={...fixturePlayer(),currentTrack:ref(track),currentTime:ref(25),duration:ref(263),themeCoverUrl:ref(cover),isPlaying:ref(false),visualizerActive:ref(false),refreshBookmarks:async()=>{},lyricsLoadState:ref({trackId:track.id,status:'ready'}),playbackClockSnapshot:ref({trackId:track.id,epoch:1,position:25,duration:263,rate:1,state:'paused',revision:1,sampledAt:performance.now(),source:'native-info',needsResync:false}),estimatePlaybackClockPosition:()=>25,seek:()=>{throw Error('motion changed playback')}}
const expanded=ref(false),bar=ref(null);let shared
const app=createApp({setup(){useMotionPreference(ref('full'));shared=useSharedArtwork(()=>bar.value?.getArtworkElement()??null);return()=>h('div',null,[h('main',{class:'fixture-library'},[h('h1','专辑'),h('p','潮汐与月 · 林晚'),h('div',{class:'fixture-covers'},[h('img',{src:cover}),h('img',{src:cover})])]),h(MotionTransition,{name:'playing-page',pin:false,onEnter:shared.enter,onBeforeLeave:shared.leave},()=>expanded.value?h(PlayingMusic):null),h(PlayerBar,{ref:bar,preview:true,previewTrack:track,previewState:'idle',glass:expanded.value,onClickCover:()=>{shared.capture();expanded.value=!expanded.value}})])}})
app.use(createPinia());const errors=[];app.config.errorHandler=e=>errors.push(String(e));app.mount('#app')
const ipc=window.require('electron').ipcRenderer
const capture=async name=>{const running=document.getAnimations();running.forEach(a=>a.pause());await tick();await tick();await sleep(40);await ipc.invoke('surface-capture',name);running.forEach(a=>{if(a.playState==='paused')a.play()})}
window.testPlaybackSurfaces=async()=>{
 await tick();const small=bar.value.getArtworkElement();await small.querySelector('img').decode()
 const volumeButton=document.querySelector('[aria-label="音量控制"]');expect(volumeButton,'real volume control is missing')
 click(volumeButton);await tick();await sleep(60)
 const volumeDrawer=document.querySelector('.volume-drawer'),drawerRect=volumeDrawer.getBoundingClientRect(),buttonRect=volumeButton.getBoundingClientRect()
 expect(Math.abs(drawerRect.left+drawerRect.width/2-buttonRect.left-buttonRect.width/2)<1,'volume motion lost its centered base transform')
 const alpha=Number(getComputedStyle(volumeDrawer).opacity);click(volumeButton);await nextTick()
 expect(Math.abs(Number(getComputedStyle(volumeDrawer).opacity)-alpha)<.03,'real volume close reset its in-flight opacity')
 await sleep(35);const closingAlpha=Number(getComputedStyle(volumeDrawer).opacity);click(volumeButton);await nextTick()
 expect(Math.abs(Number(getComputedStyle(document.querySelector('.volume-drawer')).opacity)-closingAlpha)<.03,'real volume reopen reset its in-flight opacity')
 await sleep(330);click(volumeButton);await tick();await sleep(230)
 expect(!document.querySelector('.volume-drawer'),'real volume leave leaked its surface')
 const hifiButton=document.querySelector('[aria-label="HiFi 控制台"]');click(hifiButton);await tick();await sleep(60)
 const hifi=document.querySelector('.hifi-overlay');expect(hifi,'real HiFi panel did not open')
 expect(new DOMMatrix(hifi.getAnimations()[0].effect.getKeyframes()[0].transform).m41>0,'HiFi entered from the wrong edge')
 hifi.getAnimations().forEach(animation=>{animation.pause();animation.currentTime=120})
 expect(Number(getComputedStyle(hifi).opacity)>.8,'HiFi spring did not visibly advance by 120ms: '+getComputedStyle(hifi).opacity)
 await capture('real-hifi-enter');await sleep(300)
 expect(Number(getComputedStyle(hifi).opacity)===1,'HiFi did not become fully visible')
 await capture('real-hifi-open')
 const sectionButton=label=>[...hifi.querySelectorAll('.deck-rail-btn')].find(button=>button.textContent.trim()===label)
 click(sectionButton('工具'));await nextTick()
 const tools=hifi.querySelector('.deck-stack:not([data-motion-snapshot])')
 expect(tools?.textContent.includes('SLEEP TIMER')&&!tools.inert,'HiFi tab waited for the outgoing content')
 expect(hifi.querySelector('[data-motion-snapshot]')?.inert,'HiFi outgoing form remained interactive')
 expect(new DOMMatrix(tools.getAnimations()[0].effect.getKeyframes()[0].transform).m42>0,'HiFi tab did not follow its rail order')
 await sleep(35);click(sectionButton('链路'));await nextTick()
 const consolePage=hifi.querySelector('.deck-stack:not([data-motion-snapshot])')
 expect(new DOMMatrix(consolePage.getAnimations()[0].effect.getKeyframes()[0].transform).m42<0,'HiFi tab return did not reverse direction')
 await sleep(300);expect(hifi.querySelectorAll('.deck-stack').length===1&&consolePage.textContent.includes('SIGNAL PATH'),'rapid HiFi tabs retained stale forms')
 const hifiRect=hifi.getBoundingClientRect();hifi.querySelector('.hifi-resize-handle').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:hifiRect.left}))
 document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:hifiRect.left-120}));await tick()
 expect(Math.abs(hifi.getBoundingClientRect().width-hifiRect.width-120)<1,'HiFi width chased the pointer through a delayed layout transition')
 document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));click(hifiButton);await nextTick()
 expect(new DOMMatrix(hifi.getAnimations()[0].effect.getKeyframes().at(-1).transform).m41>0,'HiFi close travelled across the page')
 for(let i=0;i<100&&document.querySelector('.hifi-overlay');i++)await sleep(20)
 expect(!document.querySelector('.hifi-overlay'),'HiFi leave leaked its surface')
 click(small);await tick();await sleep(70)
 expect(errors.length===0,errors.join(';'));expect(document.querySelector('.te-shared-artwork'),'real cover did not enter shared motion')
 const target=document.querySelector('.cover-frame'),geometry=target.getBoundingClientRect();expect(getComputedStyle(target).scale==='none','target geometry is still controlled by its entry scale')
 expect(Math.abs(geometry.width-target.offsetWidth)<1,'shared artwork measured an intermediate size')
 await capture('real-player-expanding');
 for(let i=0;i<100&&document.querySelector('.te-shared-artwork');i++)await sleep(20)
 const settled=target.getBoundingClientRect();expect(!document.querySelector('.te-shared-artwork')&&getComputedStyle(target).visibility==='visible','expanded cover not restored')
 expect(document.querySelectorAll('.lyric-row').length===4,'actual lyric viewport failed to render')
 expect(window.motionPlayer.currentTime.value===25&&window.motionPlayer.currentTrack.value.id===track.id,'motion changed playback')
 await capture('real-player-open')
 click(bar.value.getArtworkElement());await tick();await sleep(30);click(bar.value.getArtworkElement());await tick()
 for(let i=0;i<100&&(document.querySelectorAll('.playing-music').length!==1||document.querySelector('.te-shared-artwork'));i++)await sleep(20)
 expect(document.querySelectorAll('.playing-music').length===1&&!document.querySelector('.te-shared-artwork'),'rapid reopen left duplicate surfaces')
 click(bar.value.getArtworkElement());await tick()
 for(let i=0;i<100&&(document.querySelector('.playing-music')||document.querySelector('.te-shared-artwork'));i++)await sleep(20)
 expect(!document.querySelector('.playing-music')&&!document.querySelector('.te-shared-artwork'),'closing left a player surface')
 document.documentElement.dataset.teMotion='reduced';await tick();click(bar.value.getArtworkElement());await tick();expect(!document.querySelector('.te-shared-artwork'),'reduced mode moved artwork');await sleep(160)
 expanded.value=false;await tick();await sleep(160)
 expect(errors.length===0,errors.join(';'));app.unmount();return{realSurfaces:true,settledCover:settled.width,lyrics:4,rapidReopen:true,reduced:true}
}
`
