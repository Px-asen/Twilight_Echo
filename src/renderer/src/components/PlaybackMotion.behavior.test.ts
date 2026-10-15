import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('mini customizer lifecycle, reduced fades and onboarding parallax honor live motion preferences in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playback-motion-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [
        // The wizard shell, backdrop, flow and motion code are real; unrelated
        // per-step settings forms do not participate in pointer parallax.
        {
          name: 'motion-step-fixture',
          enforce: 'pre',
          load(id) {
            // The dropdown and its transition are real; task data sources are
            // covered separately by TaskCenter.behavior.test.ts.
            if (/\/components\/TaskCenter\.vue$/.test(id.replaceAll('\\', '/')))
              return '<template><div /></template>'
            if (/\/onboarding\/steps\/Step\w+\.vue$/.test(id.replaceAll('\\', '/')))
              return '<template><div class="onb-stage">设置你的聆听体验</div></template>'
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
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'PlaybackMotionTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
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
        )}<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}body::before,body::after{display:none!important}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:500,height:190,useContentSize:true,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});ipcMain.handle('motion-resize',async(_event,width,height)=>{win.setContentSize(width,height);return true});win.webContents.debugger.attach('1.3');ipcMain.handle('motion-system',(_event,reduced)=>win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:reduced?'reduce':'no-preference'}]}));ipcMain.handle('motion-capture',async(_event,label)=>{const dir=process.env.TWILIGHT_MOTION_VISUAL_DIR;if(!dir)return;await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,label+'.png'),(await win.webContents.capturePage()).toPNG())});win.webContents.on('console-message',(_e,_l,message)=>console.error(message));try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runPlaybackMotionTests()');console.log('PLAYBACK_MOTION_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /PLAYBACK_MOTION_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import '@renderer/assets/base.css'
import MiniPlayerApp from '@renderer/mini-player/MiniPlayerApp.vue'
import OnboardingWizard from '@renderer/components/onboarding/OnboardingWizard.vue'
import AppNoticeHost from '@renderer/components/AppNoticeHost.vue'
import {useSettingsStore} from '@renderer/stores/useSettingsStore.ts'
import {useAppNoticeStore} from '@renderer/stores/useAppNoticeStore.ts'
import {DEFAULT_MINI_PLAYER_SETTINGS,EMPTY_MINI_PLAYER_STATE,cloneMiniPlayerSettings} from '${join(workspace, 'src/shared/miniPlayer.ts').replaceAll('\\', '/')}'
const expect=(condition,message)=>{if(!condition)throw new Error(message)}
const sleep=delay=>new Promise(resolve=>setTimeout(resolve,delay))
const tick=async()=>{await nextTick();await sleep(0);await nextTick()}
const until=async(predicate,message)=>{for(let i=0;i<100;i++){await tick();if(predicate())return;await sleep(10)}throw new Error(message)}
const frame=()=>new Promise(requestAnimationFrame)
const ipc=window.require('electron').ipcRenderer
const capture=label=>ipc.invoke('motion-capture',label)
const clone=value=>JSON.parse(JSON.stringify(value))
let motionListener=()=>{}, stateListener=()=>{}, rejectSave=false, saveGate=null
let disk=cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS)
disk.windowWidth=500;disk.windowHeight=190
const snapshots=[]
window.api={miniPlayer:{
  onState:cb=>{stateListener=cb;return()=>{}},onSettings:()=>()=>{},onMotionPreference:cb=>{motionListener=cb;return()=>{}},
  getBootstrap:async()=>({settings:clone(disk),motionPreference:'full',state:{...EMPTY_MINI_PLAYER_STATE,isPlaying:true,currentTime:40,duration:180,track:{id:'motion-fixture',title:'Twilight Echo',artist:'静夜 · 测试艺术家',album:'夜的颜色',cover:null,coverSource:null}}}),
  updateSettings:async next=>{if(saveGate)await saveGate;if(rejectSave){rejectSave=false;throw new Error('保存失败测试')}disk=clone(next);snapshots.push({width:disk.windowWidth,height:disk.windowHeight,panel:!!document.querySelector('.mini-customizer')});await ipc.invoke('motion-resize',disk.windowWidth,disk.windowHeight);return clone(disk)},
  command:()=>{},moveTo:()=>{},moveEnd:()=>{},minimize:()=>{},returnToMain:()=>{},chooseBackgroundImage:async()=>null
}}
window.runPlaybackMotionTests=async()=>{
  let app=createApp(MiniPlayerApp);app.mount('#app')
  await until(()=>document.querySelector('.mini-player-root.is-ready'),'mini bootstrap failed')
  const open=()=>document.querySelector('.tool-customize').click()
  const close=()=>document.querySelector('[aria-label="关闭自定义面板"]').click()
  const panel=()=>document.querySelector('.mini-customizer')
  for(const mode of ['full','reduced','off']){
    motionListener(mode);await tick()
    open();await until(panel,mode+' customizer did not open')
    if(mode!=='off'){
      await until(()=>panel().getAnimations().length>0,mode+' panel enter has no actual animation')
      const animations=panel().getAnimations();animations.forEach(a=>{a.pause();a.currentTime=40})
      const css=getComputedStyle(panel())
      expect(css.transitionDuration.includes(mode==='full'?'0.2s':'0.12s'),mode+' panel duration '+css.transitionDuration)
      if(mode==='reduced')expect(css.transform==='none', 'reduced panel travelled')
      if(mode==='full')await capture('mini-customizer-enter')
      animations.forEach(a=>a.play())
    }
    await sleep(260)
    expect(document.querySelector('.mini-info').inert,'hidden mini metadata remains interactive')
    expect(disk.windowWidth===520&&disk.windowHeight===340,'customizer did not enlarge the native window')
    if(mode==='full')await capture('mini-customizer-open')
    close();await tick()
    if(mode!=='off'){
      expect(panel(),'panel unmounted before its leave')
      expect(disk.windowHeight===340,'native window shrank before leave')
      await until(()=>panel()?.getAnimations().length>0,mode+' panel leave has no actual animation')
      const animations=panel().getAnimations();animations.forEach(a=>{a.pause();a.currentTime=60})
      expect(Number(getComputedStyle(panel()).opacity)>0&&Number(getComputedStyle(panel()).opacity)<1,'leave did not render an intermediate opacity')
      if(mode==='full')await capture('mini-customizer-leave')
      animations.forEach(a=>a.play())
    }
    await until(()=>!panel()&&disk.windowHeight===190,mode+' customizer did not finish leaving')
    await until(()=>!document.querySelector('.mini-info').inert,'mini controls remained inert after leave')
  }
  motionListener('full');await tick();open();await until(panel,'reversal panel missing');await sleep(240)
  close();await tick();open();await sleep(260)
  expect(panel()&&disk.windowHeight===340,'rapid reopen lost panel or restored old size')
  close();await tick();motionListener('off')
  await until(()=>!panel()&&disk.windowHeight===190,'switching off mid-leave stranded panel')

  open();await until(panel,'failure panel missing')
  rejectSave=true
  document.querySelector('.customizer-theme-option:not(.active)').click();close();await sleep(80)
  expect(panel()&&disk.windowHeight===340,'save failure closed or resized the panel')
  expect(document.querySelector('.mini-customizer-error'),'save failure not displayed')
  close();await until(()=>!panel()&&disk.windowHeight===190,'retry close failed')

  let rejectPending
  saveGate=new Promise((_resolve,reject)=>{rejectPending=reject})
  open();await tick()
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick()
  saveGate=null;rejectPending(new Error('打开期间保存失败'))
  await until(panel,'failed opening/closing left an unreachable editor')
  expect(document.querySelector('.mini-customizer-error'),'opening failure lost actionable error')
  close();await until(()=>!panel()&&disk.windowHeight===190,'opening failure left customizerOpening stuck')

  motionListener('full');await tick();open();await until(panel,'delayed restore panel missing');await sleep(240)
  const beforeRestore=document.querySelector('.mini-artwork-wrap').getBoundingClientRect()
  let releaseRestore
  saveGate=new Promise(resolve=>{releaseRestore=resolve})
  close();await until(()=>!panel(),'delayed restore did not finish panel leave');await sleep(100)
  expect(document.querySelector('.mini-player-root').classList.contains('is-customizing'),'artwork changed layout before async native restore completed')
  const waitingRestore=document.querySelector('.mini-artwork-wrap').getBoundingClientRect()
  expect(Math.abs(waitingRestore.left-beforeRestore.left)<1&&Math.abs(waitingRestore.width-beforeRestore.width)<1,'artwork jumped while restore persistence was pending')
  saveGate=null;releaseRestore()
  await until(()=>disk.windowHeight===190&&!document.querySelector('.mini-player-root').classList.contains('is-customizing'),'delayed restore did not settle')

  // Actual noninteractive transition hosts must beat the global reduced reset.
  motionListener('reduced');await tick()
  const root=document.querySelector('.mini-player-root')
  for(const cls of ['mini-art-swap-enter-active mini-art-swap-enter-from','mini-meta-swap-leave-active mini-meta-swap-leave-to','mini-backdrop-fade-enter-active','mini-hud-leave-active mini-hud-leave-to']){
    const probe=document.createElement('div');probe.className=cls;root.append(probe)
    const css=getComputedStyle(probe)
    expect(css.transitionDuration==='0.12s','reduced mini fade was reset: '+cls+' '+css.transitionDuration)
    expect(!css.transitionProperty.includes('transform'),'reduced mini transition retained travel')
    probe.remove()
  }
  app.unmount();document.querySelector('#app').innerHTML=''

  await ipc.invoke('motion-resize',1200,760)
  const settings=useSettingsStore().settings
  settings.value.motionPreference='full'
  app=createApp(OnboardingWizard);app.mount('#app');await tick()
  const wizard=document.querySelector('.onboarding-wizard')
  const pointer=()=>wizard.dispatchEvent(new PointerEvent('pointermove',{clientX:1100,clientY:600,bubbles:true}))
  pointer();await frame();await tick()
  expect(document.querySelector('.onb-backdrop').style.transform.includes('translate3d'),'full parallax not written directly')
  for(const mode of ['reduced','off']){
    settings.value.motionPreference='full';await tick();pointer()
    settings.value.motionPreference=mode;await frame();await tick()
    for(const layer of document.querySelectorAll('.onb-backdrop,.onb-scene-no'))expect(layer.style.transform===''&&getComputedStyle(layer).transform==='none',mode+' queued pointer frame escaped cancellation')
    pointer();await frame()
    expect(document.querySelector('.onb-backdrop').style.transform==='','non-full accepted pointer writes')
  }
  // A live media-query change exercises the system branch without changing the
  // host OS setting. Explicit full must still win over that same query.
  app.unmount()
  const originalMatchMedia=window.matchMedia.bind(window)
  const changes=new Set();let reduced=false
  window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)'?{get matches(){return reduced},addEventListener:(_type,cb)=>changes.add(cb),removeEventListener:(_type,cb)=>changes.delete(cb)}:originalMatchMedia(query)
  settings.value.motionPreference='system';app=createApp(OnboardingWizard);app.mount('#app');await tick()
  reduced=true;changes.forEach(cb=>cb());await tick()
  expect(document.querySelector('.onboarding-wizard').dataset.motion==='reduced','system query change not applied')
  settings.value.motionPreference='full';await tick()
  expect(document.querySelector('.onboarding-wizard').dataset.motion==='full','explicit full lost to system reduce')
  app.unmount();expect(changes.size===0,'media subscription leaked on unmount');window.matchMedia=originalMatchMedia

  const host=ref(null), store=useAppNoticeStore()
  app=createApp({render:()=>h(AppNoticeHost,{ref:host})});app.mount('#app')
  document.documentElement.dataset.teMotion='reduced'
  store.pushNotice({kind:'info',message:'动效行为验证',sticky:true,presentation:'toast'});await tick();await frame()
  const notice=document.querySelector('.app-notice')
  expect(getComputedStyle(notice).transitionDuration==='0.12s','notice reduced fade is missing')
  expect(getComputedStyle(notice).transform==='none','notice reduced enter moved')
  await host.value.toggleHistory();await frame()
  expect(getComputedStyle(document.querySelector('.notice-history')).transitionDuration==='0.12s','history reduced fade is missing')
  host.value.toggleHistory();await tick();document.documentElement.dataset.teMotion='off';await sleep(200)
  expect(getComputedStyle(document.querySelector('.notice-history')).display==='none','off mid-close stranded history')
  app.unmount()
}
`
