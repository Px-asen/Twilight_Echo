import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('inset progress preserves panel clearance, pointer preview and keyboard focus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-edge-seek-'))
  try {
    const style = compileStyle({
      source: await readFile(new URL('./PlayerBar.css', import.meta.url), 'utf8'),
      filename: 'PlayerBar.css',
      id: 'data-v-test',
      scoped: true
    })
    assert.deepEqual(style.errors, [])
    const playerSource = await readFile(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
    const playerTemplate = parse(playerSource).descriptor.template!.content.replaceAll('\r\n', '\n')
    const idleTemplate = playerTemplate
      .slice(playerTemplate.lastIndexOf('  <div v-else ref="playerBarShellRef"'))
      .replace('v-else', 'v-if="hasPlayerBar"')
    const appSource = await readFile(new URL('../../App.vue', import.meta.url), 'utf8')
    const visibilitySource = appSource.slice(
      appSource.indexOf('const hasPlayerBar = computed('),
      appSource.indexOf('/* Shape and visibility resolution')
    )
    await writeFile(
      join(directory, 'IdleFixture.vue'),
      `<script setup>
import {computed,ref} from 'vue'
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import PlayerControlIcon from '@renderer/components/player-bar/PlayerControlIcon.vue'
import PlayerSeekProgress from '@renderer/components/player-bar/PlayerSeekProgress.vue'
const mode=ref('standard'),isMini=computed(()=>mode.value==='mini'),isCompact=computed(()=>mode.value==='compact'),isStandard=computed(()=>mode.value==='standard')
const currentTrack=ref(null),showOnboarding=ref(false),showLoginPage=ref(false),showSettingsPage=ref(false),showAppearancePage=ref(false),appearanceFullWindowPreview=ref(false),showThemeStudioPage=ref(false),showEqualizerPage=ref(false),showDspRackPage=ref(false),showPluginPage=ref(false),activePluginPage=ref(false),visualizerActive=ref(false)
${visibilitySource}
const shellDataAttrs=computed(()=>({'data-te-playbar-mode':mode.value,'data-te-playbar-hidden':'false','data-te-playbar-visibility':'auto'}))
const sequentialIcon='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';const formatTime=()=>'0:00',playerBarShellRef=ref(null),playerBarRef=ref(null)
window.idlePlayerFixture={mode,showOnboarding}
</script><template>${idleTemplate}</template><style scoped src="${join(workspace, 'src/renderer/src/components/player-bar/PlayerBar.css').replaceAll('\\', '/')}"></style>`
    )
    const volumeStart = playerTemplate.indexOf(
      `          <div\n            v-else-if="control === 'volume'"`
    )
    const volumeEnd = playerTemplate.indexOf(
      `          <button\n            v-else-if="control === 'queue'"`,
      volumeStart
    )
    assert.ok(volumeStart >= 0 && volumeEnd > volumeStart)
    const volumeTemplate = playerTemplate
      .slice(volumeStart, volumeEnd)
      .replace(`v-else-if="control === 'volume'"`, 'v-if="true"')
    const volumeHandlers = playerSource.slice(
      playerSource.indexOf('function onVolumeInput('),
      playerSource.indexOf('function onSleepTimerSelectValue(')
    )
    await writeFile(
      join(directory, 'VolumeFixture.vue'),
      `<script setup lang="ts">
import {ref} from 'vue'
import PlayerControlIcon from '@renderer/components/player-bar/PlayerControlIcon.vue'
import {useFloatingPanels} from '@renderer/components/player-bar/useFloatingPanels'
import {clampVolumePercent,createVolumeWheelStepper} from '@renderer/components/player-bar/volumeWheel'
const shell=ref(null),volume=ref(.5),glass=ref(false),showVolumeNotUnityCta=false,HIFI_STATUS_COPY={unityButtonShort:'100%'}
const {volumeOpen,toggleVolume}=useFloatingPanels(shell)
const setVolume=(value:number)=>volume.value=value,setUnityVolume=()=>setVolume(1)
${volumeHandlers}
window.volumeFixture={volume,glass}
</script><template><div ref="shell" class="player-bar-shell" data-te-playbar-mode="standard"><div class="player-bar"><div class="player-right">${volumeTemplate}</div></div></div></template><style scoped src="${join(workspace, 'src/renderer/src/components/player-bar/PlayerBar.css').replaceAll('\\', '/')}"></style>`
    )
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          vue: require.resolve('vue/dist/vue.runtime.esm-bundler.js'),
          '@renderer': join(workspace, 'src/renderer/src')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'SeekTest',
          cssFileName: 'runtime',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="full" data-te-player-layout="standard"><head><link rel="stylesheet" href="bundle/runtime.css"><style>body{margin:0}*,*::before,*::after{box-sizing:border-box}.player-bar{margin-top:50px;--te-player-progress-track:#888;--te-player-progress-fill:#ccc;--te-player-time-opacity:0;--te-player-time-surface:transparent}${style.code}</style></head><body><div id="app"></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /EDGE_SEEK_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep))
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `
import {createApp,h,ref,nextTick} from 'vue'
import SeekProgress from '${join(workspace, 'src/renderer/src/components/player-bar/PlayerSeekProgress.vue').replaceAll('\\', '/')}'
import {DEFAULT_PLAYER_BAR_LAYOUT} from '${join(workspace, 'src/shared/playerBarLayout.ts').replaceAll('\\', '/')}'
import IdleFixture from './IdleFixture.vue'
import VolumeFixture from './VolumeFixture.vue'
const reference=ref(false)
const position=ref(30),live=ref(false),duration=ref(150),track=ref(1),seeks=[],events=[]
for(const kind of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture','blur','change'])document.addEventListener(kind,e=>events.push([kind,e.target.className]),true)
const check=(value,message)=>{if(!value)throw Error(message)}
const scoped=(tag,props,children)=>h(tag,{'data-v-test':'',...props},children)
const renderControl=id=>{
 if(id==='cover')return scoped('div',{class:'player-cover-slot'},'')
 if(id==='trackInfo')return scoped('div',{class:'player-track-info'},[
  scoped('div',{class:'player-title-row'},[scoped('button',{class:'player-title player-title-button'},'A very long song title that must stay inside its column')]),
  scoped('button',{class:'player-artist'},'Ludovico Einaudi')])
 if(id==='transport')return scoped('div',{class:'player-controls'},[
  scoped('button',{class:'ctrl-btn previous-button'},'‹'),scoped('button',{class:'ctrl-btn btn-play'},'Play'),scoped('button',{class:'ctrl-btn next-button'},'›')])
 if(id==='volume')return scoped('div',{class:'volume-anchor'},[scoped('button',{class:'icon-btn volume-control-button'},'♪')])
 return scoped('button',{class:id==='playMode'?'ctrl-btn mode-btn-right':'icon-btn '+id+'-btn'},id==='playMode'?'↻':id.slice(0,1))
}
const seekApp=createApp({render:()=>scoped('div',{class:'player-bar-shell','data-te-playbar-mode':'standard'},[scoped('div',{class:['player-bar',reference.value?'player-bar-glass':'']},[
 scoped('div',{class:'player-left'},DEFAULT_PLAYER_BAR_LAYOUT.standard.left.map(renderControl)),
 scoped('div',{class:'player-center'},[
  ...DEFAULT_PLAYER_BAR_LAYOUT.standard.center.map(renderControl),
  h(SeekProgress,{'data-v-test':'',key:track.value,position:position.value,duration:duration.value,live:live.value,abStart:20,abEnd:50,formatTime:s=>s.toFixed(1),onSeek:s=>{seeks.push(s);position.value=s}})
 ]),scoped('div',{class:'player-right'},DEFAULT_PLAYER_BAR_LAYOUT.standard.right.map(renderControl))
])])});seekApp.mount('#app')
const slider=()=>document.querySelector('.progress-slider')
const frame=()=>document.querySelector('.player-bar').getBoundingClientRect()
window.prepareSeek=async(tone,glass,newLayout)=>{
 reference.value=newLayout
 document.documentElement.dataset.theme=tone
 document.querySelector('.player-bar').classList.toggle('player-bar-liquid',glass)
 live.value=false;duration.value=150;position.value=30;track.value++;seeks.length=0
 await nextTick()
 for(let index=0;index<6;index++){
  await new Promise(requestAnimationFrame)
  const transitioning=frame()
  check(transitioning.left>=-.1&&transitioning.right<=innerWidth+.1&&transitioning.bottom<=innerHeight+.1,'page transition keeps the player inside the viewport')
 }
 await new Promise(resolve=>setTimeout(resolve,360));await new Promise(requestAnimationFrame)
 const rail=slider().getBoundingClientRect(),bar=frame(),line=document.querySelector('.progress-track').getBoundingClientRect()
 const art=document.querySelector('.player-cover-slot').getBoundingClientRect()
 check(bar.bottom-line.bottom>=8,'rail clears the rounded panel bottom')
 check(rail.left-art.right>=12,'seek target clears artwork')
 check(rail.right<bar.right-20,'seek target clears the right rounded corner')
 const controls=document.querySelector('.player-controls').getBoundingClientRect()
 check(Math.abs((rail.left+rail.right)/2-(controls.left+controls.right)/2)<1,'seek rail stays centered below transport')
 check(line.top-controls.bottom>=8,'seek rail has breathing room below transport')
 check(rail.height>=20,'thin visual retains a large hit area')
 check(line.height<=3.1,'idle rail is thin')
 const surface=getComputedStyle(document.querySelector('.player-bar'))
 check(bar.bottom<innerHeight-10&&bar.left>=18&&bar.right<=innerWidth-18,'controls retain the floating inset on every page')
 check(parseFloat(surface.borderTopLeftRadius)>=20,'controls retain rounded corners')
 {
  const mode=document.querySelector('.mode-btn-right').getBoundingClientRect(),volume=document.querySelector('.volume-anchor').getBoundingClientRect()
  const tools=[...document.querySelector('.player-right').children].map(el=>el.getBoundingClientRect())
  check(mode.left>controls.right&&volume.left>controls.right,'play mode and volume return to the utility region');const play=document.querySelector('.btn-play').getBoundingClientRect();check(play.height>=31.9&&play.width>=59.9,'restored play capsule retains its desktop hit target');const right=document.querySelector('.player-right').getBoundingClientRect();check(mode.left>=right.left-.1&&volume.right<=right.right+.1,'utility controls stay within their region')
  check(tools[0].left>=rail.right+9&&tools.at(-1).right<=bar.right-10,'tools clear the seek area and panel edge')
  const info=document.querySelector('.player-track-info').getBoundingClientRect()
  check(info.left>=art.right&&info.right<rail.left,'metadata stays next to artwork and clear of seeking')
 }
 const fill=document.querySelector('.progress-fill').getBoundingClientRect()
 window.startFrame={top:bar.top,height:bar.height,left:line.left,right:line.right,fillRight:fill.right}
 return {x:rail.left+rail.width*.4,y:rail.top+rail.height/2,left:rail.left,width:rail.width}
}
window.checkHover=()=>{
 const bar=frame(),line=document.querySelector('.progress-track').getBoundingClientRect()
 check(line.height>=6.9&&line.height<=7.1,'hover expands the rail to seven pixels')
 check(bar.bottom-line.bottom>=8,'hover preserves bottom clearance')
 check(Math.abs(bar.height-window.startFrame.height)<.1&&Math.abs(bar.top-window.startFrame.top)<.1,'hover causes no layout shift')
}
window.checkHoverBounds=async()=>{
 for(let frameIndex=0;frameIndex<12;frameIndex++){
  const line=document.querySelector('.progress-track').getBoundingClientRect()
  const fill=document.querySelector('.progress-fill').getBoundingClientRect()
  check(Math.abs(line.left-window.startFrame.left)<.1&&Math.abs(line.right-window.startFrame.right)<.1,'hover keeps both rail endpoints fixed')
  check(Math.abs(fill.right-window.startFrame.fillRight)<.1,'hover cannot rewind the visible progress endpoint')
  check(seeks.length===0&&Number(slider().value)===30,'hover cannot change playback position')
  await new Promise(requestAnimationFrame)
 }
}
window.checkDrag=async()=>{
 check(seeks.length===0,'pointer moves must not repeatedly seek the engine')
 const input=slider(),value=Number(input.value)
 check(value>59&&value<66,'native thumb follows the small pointer movement')
 position.value=31;await nextTick()
 check(Number(input.value)===value,'playback tick cannot rewind a dragged thumb')
 const fill=document.querySelector('.progress-fill'),scale=new DOMMatrix(getComputedStyle(fill).transform).a
 check(Math.abs(scale-value/150)<.001,'drag fill follows immediately without playback smoothing')
 check(Math.abs(frame().height-window.startFrame.height)<.1,'drag preserves bar geometry')
 check(!document.querySelector('.progress-area').classList.contains('is-keyboard-focus'),'pointer drag has no keyboard focus frame')
 check(getComputedStyle(input).outlineStyle==='none','pointer drag has no rectangular outline')
 return value
}
window.checkCommit=async(value)=>{
 await nextTick();check(seeks.length===1,'release commits exactly one seek: '+JSON.stringify({seeks,events}))
 check(Math.abs(seeks[0]-value)<.2,'release commits the final pointer value')
 slider().focus()
}
window.checkKeyboard=()=>{
 check(seeks.length===2,'keyboard seek remains available')
 check(document.querySelector('.progress-area').classList.contains('is-keyboard-focus'),'keyboard focus remains discoverable')
 check(getComputedStyle(document.querySelector('.progress-track')).outlineStyle==='solid','keyboard focus marks the rounded track')
}
window.checkDisabled=async()=>{
 live.value=true;await nextTick();check(slider().disabled,'live stream disables seeking')
 live.value=false;duration.value=0;await nextTick();check(slider().disabled,'unknown duration disables seeking')
 duration.value=150;await nextTick();const input=slider()
 input.value='80';input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
 input.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));await nextTick()
 check(seeks.length===2,'canceled drag must not seek')
 input.value='90';input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
 track.value++;position.value=0;await nextTick();check(Number(slider().value)===0,'track switch discards old preview')
 document.documentElement.dataset.teMotion='off'
 check(getComputedStyle(document.querySelector('.progress-track')).transitionDuration==='0s','reduced motion disables rail animation')
 document.documentElement.dataset.teMotion='full'
}
window.prepareVolume=async(tone,glass)=>{
 if(!window.volumeApp){window.idleApp.unmount();window.volumeApp=createApp(VolumeFixture);window.volumeApp.mount('#app')}
 document.documentElement.dataset.theme=tone;window.volumeFixture.glass.value=glass;window.volumeFixture.volume.value=.5
 await nextTick();const bar=document.querySelector('.player-bar');bar.style.setProperty('--te-card-bg',tone==='dark'?'#202328':'#f5f5f7');bar.style.setProperty('--te-shell-control-text',tone==='dark'?'#f5f5f7':'#202328');bar.style.setProperty('--te-primary-500','#4569eb')
 const toggle=bar.querySelector('.volume-control-button');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click()
 await nextTick();await new Promise(resolve=>setTimeout(resolve,250))
 const popup=bar.querySelector('.volume-drawer').getBoundingClientRect(),anchor=toggle.getBoundingClientRect()
 check(popup.bottom<=anchor.top-9&&popup.top>=0,'volume popup stays above its control and inside the window')
 check(getComputedStyle(bar.querySelector('.volume-drawer')).borderRadius==='14px','volume restores its rounded popover')
 const input=bar.querySelector('.volume-drawer-slider');input.focus();await new Promise(requestAnimationFrame)
 check(input.getAttribute('aria-valuetext')==='50%','volume exposes its percentage')
}
window.checkVolumeKeys=async()=>{
 await nextTick();const input=document.querySelector('.volume-drawer-slider')
 check(getComputedStyle(input).outlineStyle==='solid','keyboard focus is visible after a native key: '+JSON.stringify({focus:input.matches(':focus'),visible:input.matches(':focus-visible'),outline:getComputedStyle(input).outline,volume:window.volumeFixture.volume.value,markup:input.outerHTML}));check(Math.abs(window.volumeFixture.volume.value-.51)<.001&&input.getAttribute('aria-valuetext')==='51%','native arrow adjusts and announces one percent')
 const anchor=document.querySelector('.volume-anchor');anchor.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}));await nextTick()
 check(Math.abs(window.volumeFixture.volume.value-.52)<.001,'wheel adjusts the same volume state')
 window.volumeFixture.volume.value=1;await nextTick();anchor.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true}));await nextTick();check(window.volumeFixture.volume.value===1,'wheel stays bounded at full volume')
 anchor.dispatchEvent(new WheelEvent('wheel',{deltaY:100,ctrlKey:true,bubbles:true,cancelable:true}));await nextTick();check(window.volumeFixture.volume.value===1,'pinch does not change volume')
 const toggle=document.querySelector('.volume-control-button');toggle.click();await nextTick();for(let tick=0;tick<30&&document.querySelector('.volume-drawer');tick++)await new Promise(resolve=>setTimeout(resolve,33));check(!document.querySelector('.volume-drawer')&&toggle.getAttribute('aria-expanded')==='false','volume toggle closes and reports its state')
}
window.checkIdlePlayer=async()=>{
 seekApp.unmount();window.idleApp=createApp(IdleFixture);window.idleApp.mount('#app');await nextTick();await new Promise(requestAnimationFrame)
 for(const mode of ['standard','mini','compact']){
  window.idlePlayerFixture.mode.value=mode;await nextTick();await new Promise(resolve=>setTimeout(resolve,260))
  const bar=document.querySelector('.player-bar'),box=bar.getBoundingClientRect()
  check(box.height>0&&box.bottom<=innerHeight&&box.left>=0&&box.right<=innerWidth,'startup without a restored song still displays an in-bounds player: '+mode+' '+JSON.stringify(box.toJSON()))
  check([...bar.querySelectorAll('button')].every(button=>button.disabled),'empty playback controls cannot start a nonexistent track')
  if(mode==='standard')check(bar.querySelector('.progress-slider').disabled,'empty progress is visible and disabled')
 }
 window.idlePlayerFixture.showOnboarding.value=true;await nextTick()
 check(!document.querySelector('.player-bar'),'startup player does not cover onboarding')
}
`

const runner = `const {app,BrowserWindow}=require('electron')
const wait=ms=>new Promise(r=>setTimeout(r,ms))
app.setPath('userData',require('node:path').join(__dirname,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:500,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)})
 try{
  await win.loadFile(process.argv.at(-1))
  const run=script=>win.webContents.executeJavaScript(script)
  for(const newLayout of [false,true])for(const width of [1380,760])for(const tone of ['light','dark'])for(const glass of [false,true]){
   win.setSize(width,500);win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0});await wait(180)
   const rail=await run('window.prepareSeek('+JSON.stringify(tone)+','+glass+','+newLayout+')')
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rail.x),y:Math.round(rail.y)})
   await run('window.checkHoverBounds()')
   await run('window.checkHover()')
   win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0})
   await run('window.checkHoverBounds()')
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rail.x),y:Math.round(rail.y)})
   await run('window.checkHoverBounds()')
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(rail.x),y:Math.round(rail.y)});await wait(20)
   for(const fraction of [.401,.404,.409,.417,.425]){
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rail.left+rail.width*fraction),y:Math.round(rail.y)});await wait(16)
   }
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rail.left+rail.width*.425),y:Math.round(rail.y-100)});await wait(20)
   const value=await run('window.checkDrag()')
   win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(rail.left+rail.width*.425),y:Math.round(rail.y-100)});await wait(30)
   await run('window.checkCommit('+value+')')
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(30)
   await run('window.checkKeyboard()');await run('window.checkDisabled()')
  }
  await run('window.checkIdlePlayer()')
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});win.webContents.focus()
  for(const tone of ['light','dark'])for(const glass of [false,true]){
   await run('window.prepareVolume('+JSON.stringify(tone)+','+glass+')')
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(30)
   await run('window.checkVolumeKeys()')
  }
  console.log('EDGE_SEEK_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`
