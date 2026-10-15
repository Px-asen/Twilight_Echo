import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('ambient motion pauses for visibility, focus and live preferences, and cleans up on unmount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-ambient-motion-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    const app = parse(await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8'))
    await writeFile(
      join(directory, 'app.css'),
      app.descriptor.styles.map((s) => s.content).join('\n')
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [
        {
          name: 'ambient-fixtures',
          enforce: 'pre',
          load(id) {
            const path = id.replaceAll('\\', '/')
            if (path.endsWith('/stores/useSettingsStore.ts'))
              return 'export function useSettingsStore(){return {settings:window.motionSettings}}'
            if (path.endsWith('/components/CoverImg.vue'))
              return '<script setup>defineProps(["cover"])</script><template><img :data-cover="cover" alt="" /></template>'
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        lib: { entry: join(directory, 'entry.ts'), formats: ['iife'], name: 'AmbientMotion' }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<link rel="stylesheet" href="app.css"><style>body{margin:0}.home-view{position:static;max-width:1000px}body::before{display:none}@keyframes test-status{to{opacity:.5}}.test-status{animation:test-status 1s infinite}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,ipcMain}=require('electron');const path=require('node:path');app.setPath('userData',path.join(path.dirname(process.argv.at(-1)),'user-data'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.webContents.debugger.attach('1.3');ipcMain.handle('system-motion',(_e,reduced)=>win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]}));try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runAmbientMotion()');console.log('AMBIENT_MOTION_OK');app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /AMBIENT_MOTION_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref,computed,Transition} from 'vue'
import '@renderer/assets/primeicons.css'
import '@renderer/assets/base.css'
import '@renderer/components/onboarding/OnboardingWizard.css'
import StreamingHome from '@renderer/components/StreamingHome.vue'
import StreamingLoadingStage from '@renderer/components/streaming-page/StreamingLoadingStage.vue'
import {useMotionPreference} from '@renderer/app/useMotionPreference'
const ipc=window.require('electron').ipcRenderer
const expect=(value,message)=>{if(!value)throw Error(message)}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const flush=async()=>{await nextTick();await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}
const root=document.documentElement,host=document.querySelector('#app')
window.motionSettings=ref({motionPreference:'system'})
let hidden=false,visibilityListeners=0
Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden})
const add=document.addEventListener.bind(document),remove=document.removeEventListener.bind(document)
document.addEventListener=(type,...args)=>{if(type==='visibilitychange')visibilityListeners++;add(type,...args)}
document.removeEventListener=(type,...args)=>{if(type==='visibilitychange')visibilityListeners--;remove(type,...args)}
const intervals=new Map(),set=window.setInterval.bind(window),clear=window.clearInterval.bind(window)
window.setInterval=(callback,ms,...args)=>{const id=set(callback,ms,...args);if(ms===7000)intervals.set(id,callback);return id}
window.clearInterval=id=>{intervals.delete(id);clear(id)}
let observer,observed=0
window.IntersectionObserver=class{constructor(callback){this.callback=callback;observer=this}observe(){observed++;this.callback([{isIntersecting:true}])}disconnect(){if(observed)observed--}unobserve(){this.disconnect()}}
const covers=Array.from({length:6},(_,i)=>({id:String(i),title:'Track '+i,artist:'Artist',album:'Album',cover:'cover-'+i,duration:180}))
const sections=[{key:'daily',title:'每日推荐',icon:'pi pi-music',tracks:covers}]
const open=ref(false)
const app=createApp({setup(){useMotionPreference(computed(()=>window.motionSettings.value.motionPreference));return()=>h('main',[
  h(StreamingHome,{providerLabel:'音乐',isLoggedIn:true,recsLoading:false,recsError:'',recSections:sections,recommendPlaylists:[]}),
  h(StreamingLoadingStage,{providerLabel:'音乐'}),
  h('i',{class:'pi pi-spin pi-spinner'}),
  h('i',{class:'test-status'}),
  h(Transition,{name:'playing-page'},()=>open.value?h('article',{class:'playing-music',id:'detail'},'歌词详情'):null)
])}})
window.runAmbientMotion=async()=>{
  app.mount(host);await flush()
  expect(root.dataset.teMotion==='full'&&root.dataset.teVisibility==='visible','initial system/visibility state')
  expect(intervals.size===1&&observed===1,'one visible collage timer/observer')
  expect(![...document.querySelectorAll('.home-flow>section')].some(e=>e.getAnimations().length),'content replayed nested entrance')
  expect(getComputedStyle(document.querySelector('.hero-collage-card')).animationName==='none','cover drift persists')
  expect(getComputedStyle(document.querySelector('.tls-title')).opacity==='1','loading label waited for an entrance')
  const loadingLoops=()=>document.querySelector('.tls-stage').getAnimations({subtree:true}).filter(a=>a.effect.getTiming().iterations===Infinity)
  expect(loadingLoops().length===1&&loadingLoops()[0].effect.target.matches('.pi-spinner'),'loading stage should have one status spinner')
  const hero=document.querySelector('.hero-stage'),first=()=>hero.querySelector('img').dataset.cover
  const initial=first();[...intervals.values()][0]();await flush();await sleep(260);expect(first()!==initial,'visible collage did not rotate')
  // Hidden offscreen windows update activeElement without emitting native focus events.
  hero.focus();hero.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));await flush();expect(intervals.size===0,'keyboard focus did not pause')
  hero.dispatchEvent(new MouseEvent('mouseenter'));hero.dispatchEvent(new MouseEvent('mouseleave'));await flush();expect(intervals.size===0,'pointer exit resumed a focused collage')
  hero.blur();hero.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));await flush();expect(intervals.size===1,'blur did not resume')
  observer.callback([{isIntersecting:false}]);await flush();expect(intervals.size===0,'offscreen collage still running')
  observer.callback([{isIntersecting:true}]);await flush();expect(intervals.size===1,'visible collage did not resume')
  const queuedTick=[...intervals.values()][0],beforeHidden=first()
  hidden=true;document.dispatchEvent(new Event('visibilitychange'));queuedTick();await flush()
  expect(intervals.size===0&&first()===beforeHidden,'hidden window advanced pending rotation')
  expect(root.dataset.teVisibility==='hidden'&&getComputedStyle(document.querySelector('.test-status')).animationPlayState==='paused','hidden CSS animation did not pause')
  hidden=false;document.dispatchEvent(new Event('visibilitychange'));await flush();expect(intervals.size===1,'window did not resume')
  await ipc.invoke('system-motion',true);await sleep(60);await flush();expect(root.dataset.teMotion==='reduced'&&intervals.size===0,'live OS reduction ignored')
  for(const mode of ['full','reduced','off']){
    window.motionSettings.value.motionPreference=mode;await flush()
    expect(root.dataset.teMotion===mode&&intervals.size===(mode==='full'?1:0),'explicit preference ignored: '+mode)
    expect(loadingLoops().length===(mode==='off'?0:1),'loading motion did not honor the explicit '+mode+' override '+JSON.stringify({animation:getComputedStyle(document.querySelector('.tls-stage .pi-spinner')).animation,loops:loadingLoops().length,animations:document.querySelector('.tls-stage').getAnimations({subtree:true}).map(a=>({iterations:a.effect.getTiming().iterations,target:a.effect.target.className}))}))
    if(mode!=='off')expect(getComputedStyle(document.querySelector('.tls-stage .pi-spinner')).animationDuration===(mode==='reduced'?'4s':'2s'),'loading spinner did not share the status motion speed')
    const probe=document.createElement('div');probe.className='playing-page-enter-active playing-page-enter-from';host.append(probe)
    const style=getComputedStyle(probe)
    expect(mode==='full'?style.transform!=='none':style.transform==='none','immersive view moved in '+mode)
    expect(style.filter==='none','immersive transition raster blur')
    expect(style.transitionDuration===(mode==='full'?'0.24s, 0.18s':mode==='reduced'?'0.12s':'0s'),'immersive timing '+mode+' '+style.transitionDuration)
    probe.remove()
  }
  window.motionSettings.value.motionPreference='full';await flush()
  open.value=true;await sleep(35);open.value=false;await sleep(25);open.value=true;await flush();await sleep(300)
  expect(document.querySelectorAll('#detail').length===1&&getComputedStyle(document.querySelector('#detail')).opacity==='1','rapid reversal left a duplicate/faded view')
  for(let i=0;i<20;i++){hidden=!hidden;document.dispatchEvent(new Event('visibilitychange'));await nextTick()}
  expect(intervals.size===1,'visibility changes multiplied timers')
  window.motionSettings.value.motionPreference='reduced';hidden=true;document.dispatchEvent(new Event('visibilitychange'));await flush()
  expect(getComputedStyle(document.querySelector('.pi-spin')).animationPlayState==='paused','reduced spinner ignored hidden-window pause')
  app.unmount();expect(intervals.size===0&&observed===0&&visibilityListeners===0,'unmount leaked ambient resources')
}
`
