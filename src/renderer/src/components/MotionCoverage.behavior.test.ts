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

test('motion modes, legacy overlays, discovery layout, popovers and satellite bootstrap work in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-motion-coverage-'))
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
          name: 'coverage-fixtures',
          enforce: 'pre',
          load(id) {
            const path = id.replaceAll('\\', '/')
            if (path.endsWith('/stores/useMusicStore.ts'))
              return 'export function useMusicStore(){return {createAggregatePlaylist:()=>"new-playlist",addTracksToPlaylistById:()=>0}}'
            if (path.endsWith('/components/CoverImg.vue'))
              return '<template><span class="cover-fixture"></span></template>'
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
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'MotionCoverageTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="full"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<link rel="stylesheet" href="app.css"><style>body{padding:24px;background:#edf0f5}body::before,body::after{display:none!important}#app{max-width:880px;margin:auto}.disc{animation:none!important}.workshop-delete-dialog{padding:24px;border-radius:16px;background:white}.workshop-delete-dialog::backdrop{background:#0005}</style></head><body><button id="opener">打开弹窗</button><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');app.setPath('userData',path.join(path.dirname(process.argv.at(-1)),'user-data'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:880,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.webContents.debugger.attach('1.3');ipcMain.handle('motion-system',(_e,reduced)=>win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]}));ipcMain.handle('motion-capture',async(_e,name)=>{if(process.env.TWILIGHT_MOTION_VISUAL_DIR){await fs.mkdir(process.env.TWILIGHT_MOTION_VISUAL_DIR,{recursive:true});await fs.writeFile(path.join(process.env.TWILIGHT_MOTION_VISUAL_DIR,name+'.png'),(await win.webContents.capturePage()).toPNG())}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runMotionCoverage()');console.log('MOTION_COVERAGE_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /MOTION_COVERAGE_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import '@renderer/assets/base.css'
import CreateAggregatePlaylistDialog from '@renderer/components/aggregate-playlist/CreateAggregatePlaylistDialog.vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import WorkshopDeleteDialog from '@renderer/components/theme-workshop/WorkshopDeleteDialog.vue'
import StreamingDiscovery from '@renderer/components/StreamingDiscovery.vue'
import StreamingProviderSwitcher from '@renderer/components/streaming-page/StreamingProviderSwitcher.vue'
import ProviderMusicHome from '@renderer/components/streaming-page/ProviderMusicHome.vue'
import TrayPlayerApp from '@renderer/tray-player/TrayPlayerApp.vue'
import {EMPTY_MINI_PLAYER_STATE} from '@renderer/../../shared/miniPlayer.ts'
const ipc=window.require('electron').ipcRenderer
const expect=(value,message)=>{if(!value)throw new Error(message)}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const frame=()=>new Promise(requestAnimationFrame)
const flush=async()=>{await nextTick();await frame();await frame()}
const until=async(fn,label)=>{for(let i=0;i<150;i++){if(fn())return;await sleep(10)}throw Error(label)}
const root=document.documentElement,opener=document.querySelector('#opener')
let app
const mount=async(render)=>{app?.unmount();document.querySelector('#app').innerHTML='';app=createApp({render});app.mount('#app');await nextTick()}
const setMode=async(mode)=>{root.dataset.teMotion=mode;await flush()}
const capture=async(name)=>{
  const animations=document.getAnimations().filter(a=>a.playState==='running')
  for(const animation of animations)animation.pause()
  await flush();await sleep(40)
  await ipc.invoke('motion-capture',name)
  for(const animation of animations)if(animation.playState==='paused')animation.play()
}
const playlist={id:'focus',name:'安静的夜晚',trackCount:12,coverUrl:'',creatorName:'Twilight Echo'}
window.runMotionCoverage=async()=>{
  for(const reduced of [false,true]){
    await ipc.invoke('motion-system',reduced);await sleep(30)
    for(const mode of ['full','reduced','off']){
      await setMode(mode)
      await mount(()=>h('div',{class:'main-content'},[h('article',{class:'page-down-enter-active page-down-enter-from'},'页面内容')]))
      const page=document.querySelector('article'),style=getComputedStyle(page)
      expect(mode==='full'?style.transform!=='none':style.transform==='none','page mode moved incorrectly: '+mode)
      expect(style.transitionDuration===(mode==='full'?'0.18s, 0.24s':mode==='reduced'?'0.12s':'0s'),'page duration ignored mode: '+mode+' '+style.transitionDuration)
      expect(style.filter==='none'&&!style.willChange.includes('filter'),'page transition reintroduced a raster blur: '+mode)
      root.classList.add('te-theme-tone-transition');page.className='glass-card';await nextTick()
      expect(getComputedStyle(page).transitionDuration===(mode==='full'?'0.2s, 0.2s, 0.2s':mode==='reduced'?'0.12s':'0s'),'theme transition ignored mode '+mode+' '+getComputedStyle(page).transitionDuration)
      root.classList.remove('te-theme-tone-transition')
    }
  }
  await ipc.invoke('motion-system',false)
  for(const mode of ['full','reduced','off']){
    await setMode(mode);const shown=ref(false)
    await mount(()=>h(CreateAggregatePlaylistDialog,{show:shown.value,tracks:[],onClose:()=>shown.value=false}))
    opener.focus();shown.value=true;await flush();const overlay=document.querySelector('.create-aggregate-overlay'),panel=overlay.querySelector('[data-dialog-panel]')
    if(mode!=='off'){overlay.getAnimations().forEach(a=>a.currentTime=60);expect(Number(getComputedStyle(overlay).opacity)<1,'overlay did not fade')}
    expect(mode==='full'?getComputedStyle(panel).transform!=='none':getComputedStyle(panel).transform==='none','overlay panel mode mismatch')
    if(mode==='full')await capture('aggregate-enter')
    await sleep(240);panel.querySelector('button').click();await nextTick()
    if(mode!=='off')expect(overlay.isConnected&&overlay.inert,'leaving overlay must remain visible and inert')
    await until(()=>!document.querySelector('.create-aggregate-overlay'),'overlay did not leave')
    expect(document.activeElement===opener,'overlay did not restore focus after leave')
    shown.value=true;await flush();shown.value=false;await sleep(25);shown.value=true;await sleep(250)
    expect(document.querySelectorAll('.create-aggregate-overlay').length===1&&!document.querySelector('.create-aggregate-overlay').inert,'rapid overlay reversal stranded state')
    shown.value=false;await nextTick();await setMode('off');await until(()=>!document.querySelector('.create-aggregate-overlay'),'off did not settle leave')
  }
  await setMode('full');const modal=ref(false)
  await mount(()=>h(NativeDialogTransition,null,{default:()=>modal.value?h(WorkshopDeleteDialog,{name:'夜色',onClose:()=>modal.value=false,onConfirm:()=>modal.value=false}):null}))
  opener.focus();modal.value=true;await flush();expect(document.querySelector('dialog').matches(':modal'),'workshop did not enter native top layer');await sleep(230)
  document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));await nextTick();expect(document.querySelector('dialog').matches(':modal'),'workshop left top layer too early');await until(()=>!document.querySelector('dialog'),'workshop did not close');expect(document.activeElement===opener,'workshop focus was not restored')
  for(const mode of ['full','reduced','off']){
    await setMode(mode);const expanded=ref(false)
    await mount(()=>h('div',null,[h(StreamingDiscovery,{providerLabel:'音乐',supportsCategories:true,supportsHighQuality:false,catalogue:null,catalogueLoading:true,catalogueError:'',selectedTag:'全部',order:'hot',highQuality:false,panelExpanded:expanded.value,playlists:[playlist],total:1,offset:0,hasMore:false,listLoading:false,listError:'',loadingMore:false,onTogglePanel:()=>expanded.value=!expanded.value}),h('footer',{id:'outside'},'外部区域')]))
    await flush();await until(()=>!document.querySelector('.disc').getAnimations().some(a=>a.playState==='running'),'discovery entrance did not settle');const results=document.querySelector('.disc-results'),initial=results.getBoundingClientRect().top
    document.querySelector('.disc-chip-more').click();await nextTick()
    if(mode==='full')expect(Math.abs(results.getBoundingClientRect().top-initial)<4,'discovery results jumped before the animation')
    if(mode!=='full')expect(results.getAnimations().length===0,'reduced/off projected results')
    expect(document.querySelector('#outside').getAnimations().length===0,'disclosure projected outside its boundary')
    await until(()=>![document.querySelector('#discovery-categories'),results].some(el=>el.getAnimations().some(a=>a.playState==='running')),'discovery animations did not settle');const expandedTop=results.getBoundingClientRect().top;expect(expandedTop>initial+20,'discovery did not expand '+JSON.stringify({mode,initial,expandedTop,panelHeight:document.querySelector('#discovery-categories').getBoundingClientRect().height,panelDisplay:getComputedStyle(document.querySelector('#discovery-categories')).display}))
    if(mode==='full')await capture('discovery-expanded')
    expanded.value=false;await sleep(190)
    if(mode==='full')expect(results.getAnimations().length>0,'collapse skipped result movement')
    await sleep(150);expect(Math.abs(results.getBoundingClientRect().top-initial)<1,'discovery did not settle to original geometry')
    expanded.value=true;await sleep(35);expanded.value=false;await sleep(20);expanded.value=true;await sleep(250);expect(!document.querySelector('#discovery-categories').inert,'rapid discovery reversal left inert panel')
  }
  for(const mode of ['full','reduced','off']){
    await setMode(mode)
    await mount(()=>h(StreamingProviderSwitcher,{modelValue:'one',options:[{id:'one',name:'音源一',icon:'pi pi-cloud',color:'#5070d0'},{id:'two',name:'音源二',icon:'pi pi-cloud',color:'#609090'}]}))
    await flush();document.querySelector('.provider-switcher-trigger').click();await flush()
    const menu=document.querySelector('[popover]');expect(menu.matches(':popover-open'),'provider menu did not open')
    expect(getComputedStyle(menu).transform==='none','provider menu should keep its anchor in every motion mode')
    if(mode==='full'){const a=menu.getAnimations().find(a=>a.transitionProperty==='opacity');expect(a,'provider menu did not fade '+JSON.stringify({mode,opacity:getComputedStyle(menu).opacity,transition:getComputedStyle(menu).transition,animations:menu.getAnimations().map(a=>({property:a.transitionProperty,time:a.currentTime,frames:a.effect.getKeyframes()}))}));a.pause();a.currentTime=60;expect(Number(getComputedStyle(menu).opacity)<1,'provider entry lacks intermediate state');a.play()}
    if(mode==='full')await capture('provider-menu-enter')
    await sleep(200);document.querySelector('.provider-switcher-trigger').click();await nextTick();expect(menu.inert,'leaving menu still interactive')
    if(mode==='full'){await sleep(20);expect(getComputedStyle(menu).display!=='none','popover display removed before leave')}
    await setMode('off');await sleep(30);expect(getComputedStyle(menu).display==='none','off did not release popover')
  }
  await setMode('full');const loading=ref(true),lists=ref([])
  await mount(()=>h(ProviderMusicHome,{providerLabel:'音乐',isLoggedIn:true,recsLoading:loading.value,recsError:'',recSections:[],recommendPlaylists:lists.value}))
  await flush();expect(document.querySelector('.music-skeleton'),'missing loading skeleton');lists.value=[playlist];loading.value=false;await flush()
  const content=document.querySelector('.music-content');expect(content.getAnimations().length>0,'home content did not fade after loading');await capture('provider-home-arrival');await sleep(200)
  lists.value=[playlist,{...playlist,id:'two'}];await flush();expect(document.querySelector('.music-content')===content&&content.getAnimations().length===0,'recommendation updates replayed entrance')
  app.unmount();let preferenceListener,resolveBootstrap
  window.api={trayPlayer:{getBootstrap:()=>new Promise(resolve=>resolveBootstrap=resolve),onState:()=>()=>{},onMotionPreference:cb=>{preferenceListener=cb;return()=>preferenceListener=null},command:()=>{},navigate:()=>{},hide:()=>{}}}
  await mount(()=>h(TrayPlayerApp));preferenceListener('off');resolveBootstrap({state:EMPTY_MINI_PLAYER_STATE,motionPreference:'full'});await flush()
  expect(root.dataset.teMotion==='off','stale tray bootstrap overwrote live preference');expect(getComputedStyle(document.querySelector('.tray-player')).transitionDuration==='0s','tray off still animated')
  preferenceListener('reduced');await flush();expect(root.dataset.teMotion==='reduced'&&getComputedStyle(document.querySelector('.tray-player')).transform==='none','tray reduced mode failed')
  app.unmount();expect(!preferenceListener,'tray leaked motion listener')
}
`
