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
import { build } from 'vite'
import { createMotionTrajectory, restingMotion } from '../app/motion/trajectory.ts'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('motion trajectories preserve inherited velocity and finish at the exact resting state', () => {
  const opening = createMotionTrajectory(restingMotion([54, 610]), [360, 180], 360)
  let last = 54
  for (let time = 0; time <= 360; time += 3) {
    const state = opening.sample(time)
    assert.ok(
      state.values[0] >= last && state.values[0] <= 360,
      'resting entrance bounced or reversed'
    )
    assert.ok(state.values[1] >= 180 && state.values[1] <= 610)
    last = state.values[0]
  }
  const current = opening.sample(83)
  const closing = createMotionTrajectory(current, [54, 610], 260)
  assert.deepEqual(closing.sample(0), current)
  assert.ok(
    closing.sample(2).values[0] > current.values[0],
    'reversal discarded its incoming momentum'
  )
  assert.deepEqual(closing.sample(260), restingMotion([54, 610]))
  assert.deepEqual(closing.sample(800), restingMotion([54, 610]))
})

test('page handoffs, mid-flight reversals, shared artwork and motion policy remain continuous in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-continuous-motion-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [vue()],
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
          name: 'ContinuousMotion',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="full"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>html,body{margin:0;font:14px system-ui;background:#f6f4fa;color:#242232}body::before,body::after{display:none!important}#app{padding:36px}.pages{position:relative;display:grid;width:800px;height:380px;overflow:auto;background:#eee9f5;border-radius:18px}.surface{grid-area:1/1;background:#f9f7fc;padding:28px;box-sizing:border-box;min-width:0}.surface h2{margin:0 0 20px}.surface .tiles{display:flex;gap:20px}.tile{width:160px;height:160px;background:linear-gradient(130deg,#324c5c,#a5c6cb);border-radius:12px}.indicator-host{position:relative;display:flex;flex-direction:column;width:180px;gap:5px}.menu-item{position:relative;height:40px;border:0;background:transparent;text-align:left;padding:0 12px}.indicator{position:absolute;top:0;left:0;width:1px;height:1px;background:#e5daf7;transform-origin:0 0}.artwork-small{position:fixed;bottom:20px;left:32px;width:54px;height:54px;border-radius:8px;overflow:hidden}.artwork-small img,.cover-frame img{width:100%;height:100%;object-fit:cover}.cover-frame{width:220px;height:220px;animation:none!important;border-radius:14px;overflow:hidden}.art-panel{position:fixed;inset:28px 80px 100px 250px;padding:30px;background:#f9f7fc}.drawer{position:absolute;right:0;bottom:0;width:300px;height:220px;background:#e5daf7;padding:24px;box-sizing:border-box;border-radius:18px}button{font:inherit}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs/promises'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1040,height:700,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:true,contextIsolation:false}});ipcMain.handle('motion-capture',async(_e,name)=>{const dir=process.env.TWILIGHT_MOTION_VISUAL_DIR;if(dir){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,name+'.png'),(await win.webContents.capturePage()).toPNG())}});try{await win.loadFile(process.argv.at(-1));const result=await win.webContents.executeJavaScript('window.runContinuousMotion()');console.log('CONTINUOUS_MOTION_OK '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /CONTINUOUS_MOTION_OK/)
    // Exercise the real callers, not only the primitive fixture.
    for (const file of ['App.vue', 'SongList.vue', 'StreamingPage.vue', 'PlayerBar.vue']) {
      const content = await readFile(
        join(workspace, 'src/renderer/src', file === 'App.vue' ? file : `components/${file}`),
        'utf8'
      )
      assert.match(content, /<MotionTransition/)
    }
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,ref,nextTick,withDirectives,vShow,defineAsyncComponent} from 'vue'
import MotionTransition from '@renderer/components/MotionTransition.vue'
import {useSharedArtwork} from '@renderer/app/motion/useSharedArtwork'
import {useNavigationIndicator} from '@renderer/app/motion/useNavigationIndicator'
import '@renderer/assets/base.css'
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const tick=async()=>{await nextTick();await new Promise(requestAnimationFrame)}
const expect=(ok,message)=>{if(!ok)throw Error(message)}
const ipc=window.require('electron').ipcRenderer
const capture=async name=>{const animations=document.getAnimations();animations.forEach(a=>a.pause());await tick();await tick();await sleep(35);await ipc.invoke('motion-capture',name);animations.forEach(a=>a.play())}
const rect=element=>element.getBoundingClientRect()
let app
const mount=async setup=>{app?.unmount();document.querySelector('#app').innerHTML='';app=createApp({setup});app.mount('#app');await tick()}
window.runContinuousMotion=async()=>{
  const page=ref('专辑'),direction=ref('page-down')
  await mount(()=>()=>h('div',{class:'pages'},[h(MotionTransition,{name:direction.value,snapshot:true,waitForEnter:true},()=>h('section',{key:page.value,class:'surface','data-page':page.value},[h('h2',page.value),h('div',{class:'tiles'},[h('div',{class:'tile'}),h('div',{class:'tile'}),h('div',{class:'tile'})])]))]))
  page.value='艺术家';await nextTick()
  let surfaces=[...document.querySelectorAll('.surface')]
  expect(surfaces.length===2,'Page entrance waited for its predecessor')
  expect(surfaces[0].inert&&!surfaces[1].inert,'Leaving page did not relinquish interaction')
  const incoming=surfaces[1].getAnimations()[0]
  expect(incoming&&incoming.effect.getTiming().duration===240,'Page ignores shared enter timing')
  incoming.pause();incoming.currentTime=70
  const before=rect(surfaces[1]).top
  direction.value='page-up';page.value='歌单';await nextTick()
  const departing=document.querySelector('[data-page="艺术家"]')
  expect(Math.abs(rect(departing).top-before)<1,'Retarget jumped a moving page')
  await capture('page-handoff')
  page.value='专辑';await tick();await sleep(320)
  expect(document.querySelectorAll('.surface').length===1&&document.querySelector('.surface').textContent==='专辑','Rapid pages did not settle on the final target')
  let resolvePage;const delayed=ref(false),skip=ref(false)
  const Lazy=defineAsyncComponent(()=>new Promise(resolve=>resolvePage=resolve))
  await mount(()=>()=>h('div',{class:'pages'},[h(MotionTransition,{snapshot:true,waitForEnter:true},()=>skip.value?h('section',{class:'surface',key:'final'},'最终页面'):delayed.value?h(Lazy):h('section',{class:'surface',key:'initial'},'原始页面'))]))
  delayed.value=true;await tick();await sleep(300)
  expect(document.querySelector('[data-motion-snapshot]')?.textContent==='原始页面','Lazy destination faded to a blank view')
  expect(document.querySelector('[data-motion-snapshot]').inert,'Waiting snapshot became interactive')
  resolvePage({render:()=>h('section',{class:'surface'},'异步页面')});await tick();await sleep(300)
  expect(document.querySelectorAll('.surface').length===1&&document.querySelector('.surface').textContent==='异步页面','Lazy handoff did not release its painter')
  app.unmount()
  const Late=defineAsyncComponent(()=>new Promise(resolve=>resolvePage=resolve))
  delayed.value=false;skip.value=false
  await mount(()=>()=>h('div',{class:'pages'},[h(MotionTransition,{snapshot:true,waitForEnter:true},()=>skip.value?h('section',{class:'surface',key:'final'},'最终页面'):delayed.value?h(Late):h('section',{class:'surface',key:'initial'},'原始页面'))]))
  delayed.value=true;await tick();skip.value=true;await tick();resolvePage({render:()=>h('section',{class:'surface'},'过期页面')});await tick();await sleep(300)
  expect(document.querySelectorAll('.surface').length===1&&document.querySelector('.surface').textContent==='最终页面','Obsolete lazy mount replaced the latest destination')
  const displayed=ref(false)
  await mount(()=>()=>h('div',{class:'pages'},[h(MotionTransition,{name:'drawer-up',pin:false},()=>withDirectives(h('section',{class:'drawer'},'播放队列'),[[vShow,displayed.value]]))]))
  displayed.value=true;await tick();await sleep(60)
  const drawer=document.querySelector('.drawer'),opening=drawer.getAnimations()[0]
  opening.pause();opening.currentTime=80
  opening.currentTime=78;const previousTop=rect(drawer).top;opening.currentTime=80
  const entryVelocity=(rect(drawer).top-previousTop)/.002
  const alpha=Number(getComputedStyle(drawer).opacity)
  displayed.value=false;await nextTick()
  expect(Math.abs(Number(getComputedStyle(drawer).opacity)-alpha)<.03,'Drawer reversal reset opacity')
  const closing=drawer.getAnimations()[0];closing.pause();closing.currentTime=0;const reverseTop=rect(drawer).top;closing.currentTime=2
  const reverseVelocity=(rect(drawer).top-reverseTop)/.002
  expect(entryVelocity<0&&reverseVelocity<0&&Math.abs(reverseVelocity-entryVelocity)<Math.abs(entryVelocity)*.4,'Drawer reversal discarded incoming velocity: '+entryVelocity+' / '+reverseVelocity)
  closing.play()
  await sleep(30);displayed.value=true;await tick();await sleep(330)
  expect(!drawer.inert&&getComputedStyle(drawer).display!=='none','Reversed drawer remained inert')
  displayed.value=false;await tick();document.documentElement.dataset.teMotion='off';await tick()
  expect(getComputedStyle(drawer).display==='none','Off mode did not finish pending leave')
  document.documentElement.dataset.teMotion='reduced';displayed.value=true;await tick()
  expect(drawer.getAnimations().every(a=>a.effect.getKeyframes().every(f=>f.transform==='none')),'Reduced drawer translated')
  await sleep(120);document.documentElement.dataset.teMotion='full'
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));displayed.value=false;await tick()
  expect(!drawer.getAnimations().length&&getComputedStyle(drawer).display==='none','Keyboard close waited for motion')
  document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))
  const edgeOpen=ref(false)
  await mount(()=>()=>h(MotionTransition,{name:'drawer-right',panel:'.edge-panel',pin:false},()=>edgeOpen.value?h('div',{class:'edge-overlay',style:'position:fixed;inset:0;background:#0005'},[h('aside',{class:'edge-panel',style:'position:absolute;right:0;top:0;bottom:0;width:320px;background:#faf8ff;padding:28px;box-sizing:border-box'},[h('h2','声音与播放'),h('p','面板沿右侧展开，背景保持稳定。')])]):null))
  edgeOpen.value=true;await tick()
  let edge=document.querySelector('.edge-overlay'),panel=document.querySelector('.edge-panel')
  expect(rect(edge).left===0&&rect(edge).width===innerWidth&&getComputedStyle(edge).transform==='none','Right drawer moved the full-window backdrop')
  expect(new DOMMatrix(panel.getAnimations()[0].effect.getKeyframes()[0].transform).m41>0,'Right drawer entered from the wrong edge')
  await sleep(60);await capture('right-drawer-enter');await sleep(260)
  edgeOpen.value=false;await nextTick()
  expect(new DOMMatrix(panel.getAnimations()[0].effect.getKeyframes().at(-1).transform).m41>0,'Right drawer exited across the content instead of returning to its edge')
  await sleep(35);edgeOpen.value=true;await nextTick()
  expect(document.querySelectorAll('.edge-overlay').length===1,'Reopening left a second backdrop')
  document.documentElement.dataset.teVisibility='hidden';await tick()
  expect(!document.getAnimations().length,'Hidden window retained a panel animation')
  delete document.documentElement.dataset.teVisibility
  const selected=ref('专辑')
  await mount(()=>{const root=ref(null),indicator=ref(null);useNavigationIndicator(root,indicator,selected);return()=>h('nav',{class:'indicator-host',ref:root},[h('span',{class:'indicator',ref:indicator}),...['专辑','艺术家','歌单'].map(title=>h('button',{class:['menu-item',{active:selected.value===title}]},title))])})
  await sleep(40)
  const selectedButton=document.querySelectorAll('.menu-item')[1]
  selectedButton.style.setProperty('--te-lg-press-x','24px');selectedButton.style.setProperty('--te-lg-press-y','16px')
  selected.value='艺术家';await tick();await sleep(55)
  const marker=document.querySelector('.indicator'),position=new DOMMatrix(getComputedStyle(marker).transform).m42
  expect(position>1&&position<44,'Button press styles snapped the indicator to its destination')
  selected.value='歌单';await nextTick()
  expect(Math.abs(new DOMMatrix(getComputedStyle(marker).transform).m42-position)<1,'Indicator reset on a new target')
  await sleep(550);expect(Math.abs(new DOMMatrix(getComputedStyle(marker).transform).m42-90)<1,'Indicator did not reach selected row')
  const expanded=ref(false);let artwork
  const src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#294956"/><circle cx="210" cy="85" r="45" fill="#f4d2a6"/><path d="M0 240L300 170M0 265L300 195M0 290L300 220" stroke="#c6e2df" stroke-width="5"/></svg>')
  await mount(()=>{const small=ref(null);artwork=useSharedArtwork(()=>small.value);return()=>h('div',null,[h('div',{ref:small,class:'artwork-small'},[h('img',{src})]),h(MotionTransition,{name:'playing-page',pin:false,onEnter:artwork.enter,onBeforeLeave:artwork.leave},()=>expanded.value?h('section',{class:'art-panel'},[h('div',{class:'cover-frame'},h('img',{src})),h('h2','潮汐与月'),h('p','林晚 · 潮汐')]):null)])})
  await document.querySelector('.artwork-small img').decode()
  artwork.capture();expanded.value=true;await tick();await sleep(80)
  const flight=document.querySelector('.te-shared-artwork');expect(flight,'Shared artwork did not start')
  expect(getComputedStyle(document.querySelector('.art-panel')).transform==='none'||new DOMMatrix(getComputedStyle(document.querySelector('.art-panel')).transform).a===1,'Player text scaled with artwork')
  await capture('shared-artwork-enter')
  const flightAnimation=flight.getAnimations()[0];flightAnimation.pause();flightAnimation.currentTime=78;const previousWidth=rect(flight).width;flightAnimation.currentTime=80
  const incomingWidth=rect(flight).width,coverVelocity=(incomingWidth-previousWidth)/.002
  expanded.value=false;await nextTick();expect(document.querySelectorAll('.te-shared-artwork').length===1&&document.querySelector('.te-shared-artwork')===flight,'Reversal replaced its painted image')
  const returnFlight=flight.getAnimations()[0];returnFlight.pause();returnFlight.currentTime=0
  expect(Math.abs(rect(flight).width-incomingWidth)<.1,'Cover reversal jumped its dimensions')
  returnFlight.currentTime=2;const returnVelocity=(rect(flight).width-incomingWidth)/.002
  expect(coverVelocity>0&&returnVelocity>0&&Math.abs(returnVelocity-coverVelocity)<coverVelocity*.4,'Cover reversal reset velocity: '+coverVelocity+' / '+returnVelocity)
  returnFlight.play()
  await sleep(340);expect(!document.querySelector('.te-shared-artwork')&&getComputedStyle(document.querySelector('.artwork-small')).visibility==='visible','Artwork cleanup hid the real cover')
  expanded.value=true;await tick();await sleep(30);document.documentElement.dataset.teMotion='off';await tick()
  expect(!document.querySelector('.te-shared-artwork'),'Preference change leaked artwork')
  app.unmount();expect(!document.getAnimations().length,'Unmount left running animations')
  return {overlap:true,reversal:true,rapidNavigation:true,lazyHandoff:true,indicator:true,artwork:true,preferences:true,cleanup:true}
}
`
