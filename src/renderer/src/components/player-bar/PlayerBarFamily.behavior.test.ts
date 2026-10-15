import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))
const renderer = join(workspace, 'src/renderer/src').replaceAll('\\', '/')

// Compile the product template and stylesheet rather than reconstructing its
// controls. Only the player-store boundary is substituted with observable
// callbacks. Floating panels, auto-hide, icons and seeking remain production code.
test('player family retains transport, usable bounds, seeking and disclosure across shapes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-player-family-'))
  try {
    const source = (
      await readFile(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
    ).replaceAll('\r\n', '\n')
    const template = parse(source).descriptor.template!.content
    const overlayStart = template.indexOf('    <!-- HiFi 右侧覆盖面板 -->')
    const idleStart = template.lastIndexOf('  <div v-else ref="playerBarShellRef"')
    const queueStart = template.indexOf('  <Teleport v-if="!preview" to=".app-shell"')
    assert.ok(overlayStart > 0 && idleStart > overlayStart && queueStart > idleStart)
    const fixtureTemplate =
      template.slice(0, overlayStart) + '  </div>\n' + template.slice(idleStart, queueStart)
    const regions = source.slice(
      source.indexOf('const barRegions = computed('),
      source.indexOf('const lyricsManagement = useLyricsManagement()')
    )
    const disclosure = source.slice(
      source.indexOf('const {\n  revealed: playbarRevealed,'),
      source.indexOf('// A track change or play/pause')
    )
    assert.ok(regions.includes('resolvePlayerBarRegions') && disclosure.includes('shellDataAttrs'))
    await writeFile(
      join(directory, 'PlayerFamilyFixture.vue'),
      `<script setup lang="ts">\n${fixtureScript(regions, disclosure)}\n</script>\n<template>${fixtureTemplate}</template>\n<style scoped src="${renderer}/components/player-bar/PlayerBar.css"></style>`
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
          '@renderer': renderer,
          '@shared': join(workspace, 'src/shared')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'PlayerFamilyTest',
          cssFileName: 'runtime',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    const globalStyles =
      (await readFile(new URL('../../assets/base.css', import.meta.url), 'utf8')) +
      (await readFile(new URL('../../assets/materials.css', import.meta.url), 'utf8')) +
      (await readFile(new URL('../../assets/materials.css', import.meta.url), 'utf8')) +
      (await readFile(new URL('../../assets/bohr.css', import.meta.url), 'utf8'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-platform="win32" data-te-motion="off"><head><meta charset="utf-8"><style>${globalStyles}\nhtml,body{margin:0;height:100%;overflow:hidden}*,*::before,*::after{box-sizing:border-box}.qa-content{padding:56px 36px;font-family:system-ui}.qa-content h1{font-size:24px;margin:0 0 8px}.qa-content p{margin:0;opacity:.6}#outside-focus{margin-top:20px}</style><link rel="stylesheet" href="bundle/runtime.css"></head><body><div class="qa-content"><h1>Echora 播放栏 · 实际组件验证</h1><p id="case-label"></p><button id="outside-focus">页面内容</button></div><div id="app"></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const evidence = process.env.TE_PLAYER_FAMILY_EVIDENCE_DIR
    if (evidence) await mkdir(evidence, { recursive: true })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /PLAYER_FAMILY_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep))
    await rm(target, { recursive: true, force: true })
  }
})

function fixtureScript(regions: string, disclosure: string): string {
  return `
import {computed,reactive,ref} from 'vue'
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import PlaybackModeIcon from '@renderer/components/icons/PlaybackModeIcon.vue'
import PlayerControlIcon from '@renderer/components/player-bar/PlayerControlIcon.vue'
import PlayerSeekProgress from '@renderer/components/player-bar/PlayerSeekProgress.vue'
import CoverImg from '@renderer/components/CoverImg.vue'
import CompactPlayerBarVisualizer from '@renderer/components/player-bar/CompactPlayerBarVisualizer.vue'
import {useFloatingPanels} from '@renderer/components/player-bar/useFloatingPanels'
import {usePlaybarAutoHide} from '@renderer/components/player-bar/usePlaybarAutoHide'
import {formatTime} from '@renderer/utils/playerTime'
import {resolvePlayerBarRegions,isDefaultStandardPlayerBar,PLAYER_BAR_REGION_NAMES,type PlayerBarRegionName,clonePlayerBarLayout,DEFAULT_PLAYER_BAR_LAYOUT} from '@shared/playerBarLayout'
import {HIFI_STATUS_COPY} from '@shared/audioProcessingOptions'
const props=reactive({mode:'standard',glass:false,autoHide:false,preview:false,visualizerVisible:false})
const isMini=computed(()=>props.mode==='mini'),isCompact=computed(()=>props.mode==='compact'),isStandard=computed(()=>props.mode==='standard'),glass=computed(()=>props.glass)
const sampleTrack={id:'family-proof',queueEntryId:'entry-proof',title:'A very long song title — 暮色回声 · Album version',artist:'Ludovico Einaudi',duration:180,cover:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="80" height="80"%3E%3Crect width="80" height="80" fill="%23394559"/%3E%3Ccircle cx="40" cy="40" r="28" fill="%23dcbd91"/%3E%3Ccircle cx="40" cy="40" r="8" fill="%23394559"/%3E%3C/svg%3E'}
const currentTrack=ref({...sampleTrack}),playerLeftKey=computed(()=>currentTrack.value?.id||'idle')
const settings=ref({playerBar:{layout:clonePlayerBarLayout(DEFAULT_PLAYER_BAR_LAYOUT),revealThresholdPx:30,hideDelayMs:90}})
const previewPlayerSettings=computed(()=>settings.value.playerBar)
${regions}
const playerBarShellRef=ref(null),playerBarRef=ref(null),fullyHidden=ref(false),autoHideActive=computed(()=>props.autoHide&&!!currentTrack.value)
const {volumeOpen,playlistOpen,moreOpen,floatingPanelOpen,toggleVolume,togglePlaylist,toggleMore,closeFloatingPanels}=useFloatingPanels(playerBarShellRef)
const onGlassPointerLeave=()=>{}
${disclosure}
const currentTime=ref(42),effectiveDuration=ref(180),isLiveStream=ref(false),isPlaying=ref(false),isStreamBuffering=ref(false),streamNowPlaying=ref(''),liveBadgeLabel='LIVE'
const dominantColor='#7c8dba',playButtonColor='#7c8dba',liquidGlassActive=false,showCompactVisualizer=computed(()=>isCompact.value&&props.visualizerVisible),visualizationData={spectrum:Array.from({length:128},(_,i)=>.2+.6*Math.abs(Math.sin(i*.11))),waveform:[],active:true}
const abLoopA=ref(null),abLoopB=ref(null),activeResumeOffer=null,volume=ref(.5),showVolumeNotUnityCta=false
const favoriteButtonVisible=true,favoriteButtonLiked=false,favoriteButtonLoading=false,favoriteButtonTitle='喜欢',playMode='sequential',modeTitle='顺序播放',desktopLyricsOn=false,miniPlayerOpening=false
const sequentialIcon='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Cpath d="M4 7h16M4 12h16M4 17h12" stroke="%23787980" fill="none"/%3E%3C/svg%3E',listLoopIcon=sequentialIcon,repeatIcon=sequentialIcon,heartModeIcon=sequentialIcon,shuffleIcon=sequentialIcon
const trackTitleOpensPlayingPage=computed(()=>!barRegions.value.some(region=>region.items.includes('cover')))
const actions={prev:0,next:0,play:0,seeks:[]}
const prev=()=>actions.prev++,next=()=>actions.next++,togglePlay=()=>{actions.play++;isPlaying.value=!isPlaying.value},seek=value=>{actions.seeks.push(value);currentTime.value=value}
const setCoverRef=()=>{},onCoverClick=()=>{},onTrackTitleClick=()=>{},onArtistClick=()=>{},toggleFavorite=()=>{},cyclePlayMode=()=>{},openEqualizerPage=()=>{},toggleDesktopLyrics=()=>{},openMiniPlayer=()=>{},emit=()=>{},onAcceptResume=()=>{},onDismissResume=()=>{},setGlassPressOrigin=()=>{},onGlassPointerMove=()=>{}
const setUnityVolume=()=>volume.value=1,onVolumeInput=event=>volume.value=Number(event.target.value),onVolumeWheel=()=>{}
window.familyFixture={props,settings,currentTrack,sampleTrack,isLiveStream,effectiveDuration,isPlaying,currentTime,actions,closeFloatingPanels,flashReveal,volumeOpen,playerBarRef}
`
}

const runtime = `
import {createApp,nextTick} from 'vue'
import PlayerFamilyFixture from './PlayerFamilyFixture.vue'
import {clonePlayerBarLayout,DEFAULT_PLAYER_BAR_LAYOUT,normalizePlayerBarLayout} from '@shared/playerBarLayout'
import {TWILIGHT_DEFAULT_THEME,themeTokensToCssVariables} from '@shared/theme'
const check=(value,message)=>{if(!value)throw Error(message)}
createApp(PlayerFamilyFixture).mount('#app')
const settle=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
const slider=()=>document.querySelector('.player-bar input[aria-label="播放进度"]')
window.prepareFamily=async(mode,tone,fontSize,custom,idle=false,live=false)=>{
 const f=window.familyFixture
 f.props.autoHide=false;f.closeFloatingPanels();f.props.mode=mode;f.props.glass=false;f.props.visualizerVisible=false
 f.currentTrack.value=idle?null:{...f.sampleTrack};f.isLiveStream.value=live;f.effectiveDuration.value=live?0:180;f.currentTime.value=42;f.isPlaying.value=false
 f.settings.value.playerBar.layout=clonePlayerBarLayout(DEFAULT_PLAYER_BAR_LAYOUT)
 if(custom){f.settings.value.playerBar.layout=normalizePlayerBarLayout({
   standard:{left:['cover','trackInfo'],center:['transport','playMode'],right:['volume','queue','favorite']},
   mini:{left:['transport','trackInfo'],center:[],right:['volume','queue','playMode']},
   compact:{left:['trackInfo','favorite'],center:['transport','playMode'],right:['volume','queue','time']}
 })}
 document.documentElement.dataset.theme=tone;document.documentElement.dataset.tePlayerLayout=mode
 for(const [key,value] of Object.entries(themeTokensToCssVariables(TWILIGHT_DEFAULT_THEME.variants[tone].tokens)))document.documentElement.style.setProperty(key,value)
 document.documentElement.style.setProperty('--te-font-size-body',fontSize+'px')
 document.body.style.background=tone==='dark'?'#181b20':'#f5f5f7';document.body.style.color=tone==='dark'?'#eff1f5':'#202328'
 document.getElementById('case-label').textContent=mode+' · '+tone+' · '+innerWidth+' px · '+fontSize+' px · '+(custom?'自定义排列':'默认排列')+(idle?' · 空闲':live?' · LIVE':'')
 await settle()
}
window.checkFamilyGeometry=(custom,idle=false)=>{
 const bar=document.querySelector('.player-bar'),box=bar.getBoundingClientRect()
 check(box.left>=-.1&&box.right<=innerWidth+.1&&box.bottom<=innerHeight+.1,'bar stays inside viewport: '+JSON.stringify({mode:window.familyFixture.props.mode,box:box.toJSON(),innerWidth,innerHeight}))
 const buttons=[...bar.querySelectorAll('button')].filter(el=>el.getBoundingClientRect().width>0)
 const boxes=buttons.map(el=>({el,rect:el.getBoundingClientRect()}))
 for(const {el,rect} of boxes){
   check(rect.left>=box.left-.2&&rect.right<=box.right+.2&&rect.top>=box.top-.2&&rect.bottom<=box.bottom+.2,'button clears bar edges: '+el.className+' '+JSON.stringify(rect.toJSON()))
   const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)
   if(!el.disabled)check(hit&&el.contains(hit),'button center stays reachable: '+el.className+' hit '+hit?.className)
 }
 for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
   const a=boxes[i].rect,b=boxes[j].rect,overlapX=Math.min(a.right,b.right)-Math.max(a.left,b.left),overlapY=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)
   check(overlapX<=.5||overlapY<=.5,'buttons do not overlap: '+boxes[i].el.className+' / '+boxes[j].el.className)
 }
 const transport=bar.querySelector('.player-controls'),play=bar.querySelector('.btn-play,.mini-play-button')
 check(play&&play.getBoundingClientRect().width>=27.9,'play target remains usable')
 if(!custom||!idle){check(transport&&bar.querySelector('.previous-button')&&bar.querySelector('.next-button'),'default family keeps previous / play / next')}
 if(play){const r=play.getBoundingClientRect(),style=getComputedStyle(play);check(parseFloat(style.borderTopLeftRadius)>=r.height/2-.5,'primary play shares rounded capsule grammar')}
 if(!idle){
   const input=slider(),rail=input?.getBoundingClientRect()
   check(input&&rail.height>=23.9&&rail.left>=box.left-.1&&rail.right<=box.right+.1,'seek has a 24px hit target within the bar: '+JSON.stringify({mode:window.familyFixture.props.mode,custom,rail:rail?.toJSON(),bar:box.toJSON()}))
   check(rail.width>=(window.familyFixture.props.mode==='mini'?90:80),'seek retains usable width')
 }
 return {mode:window.familyFixture.props.mode,viewport:innerWidth,custom,idle,bar:box.toJSON(),play:play.getBoundingClientRect().toJSON(),buttons:boxes.length,seek:slider()?.getBoundingClientRect().toJSON()}
}
window.familyTransport=async(kind)=>{
 const f=window.familyFixture,selector=kind==='prev'?'.previous-button':kind==='next'?'.next-button':'.btn-play',button=document.querySelector(selector)
 check(button&&!button.disabled,kind+' control is enabled')
 const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,before:f.actions[kind]}
}
window.checkFamilyTransport=async(kind,before)=>{await settle();check(window.familyFixture.actions[kind]===before+1,'actual template invokes '+kind+' callback exactly once');if(kind==='play')check(document.querySelector('.btn-play').getAttribute('aria-label')==='暂停','play state and accessible label update together')}
window.prepareFamilySeek=async()=>{const f=window.familyFixture;f.actions.seeks.length=0;f.currentTime.value=42;await settle();const r=slider().getBoundingClientRect();return {x:r.left+r.width*.5,y:r.top+r.height/2,width:r.width,left:r.left}}
window.checkFamilyDrag=()=>{check(window.familyFixture.actions.seeks.length===0,'drag preview does not repeatedly seek');return Number(slider().value)}
window.checkFamilySeekCommit=async(value)=>{await settle();const values=window.familyFixture.actions.seeks;check(values.length===1&&Math.abs(values[0]-value)<.2,'release commits one final seek: '+JSON.stringify(values))}
window.checkFamilyLive=async()=>{const input=slider();check(input.disabled&&input.getAttribute('aria-valuetext')==='LIVE','live stream announces LIVE and disables seeking');const before=window.familyFixture.actions.seeks.length;input.value='90';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));await settle();check(window.familyFixture.actions.seeks.length===before,'disabled live seek never calls playback')}
window.checkFamilyIdle=()=>{check([...document.querySelectorAll('.previous-button,.next-button,.btn-play,.mini-play-button')].every(el=>el.disabled),'idle transport is disabled');const input=slider();if(input)check(input.disabled,'idle seek is disabled')}
window.checkFamilyLongTime=async()=>{
 const f=window.familyFixture;f.effectiveDuration.value=600000;f.currentTime.value=599940;await settle()
 const input=slider(),rail=input.getBoundingClientRect(),labels=[...document.querySelectorAll('.player-bar .time-label,.player-bar .mini-progress-time,.player-bar .player-time-readout')]
 check(input.getAttribute('aria-valuetext').includes('10000:00'),'long duration uses the production minute-based time formatter')
 for(const label of labels){const box=label.getBoundingClientRect();check(box.right<=innerWidth+.1&&box.left>=-.1,'long time stays within viewport');check(box.right<=rail.left+.1||box.left>=rail.right-.1||box.bottom<=rail.top+.1||box.top>=rail.bottom-.1,'long time does not cover the seek target')}
 window.checkFamilyGeometry(false)
}
window.checkFamilyVariant=async(visualizer=false)=>{
 const f=window.familyFixture;f.props.glass=true;f.props.visualizerVisible=visualizer;f.isPlaying.value=visualizer
 document.documentElement.dataset.teMotion=visualizer?'full':'off';await settle();await new Promise(resolve=>setTimeout(resolve,260))
 const result=window.checkFamilyGeometry(false)
 if(f.props.mode==='standard'){const style=getComputedStyle(document.querySelector('.player-bar'));check(style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.boxShadow==='none','lyrics standard retains a transparent flush surface')}
 if(visualizer){const stage=document.querySelector('.compact-visualizer'),box=stage.getBoundingClientRect(),play=document.querySelector('.btn-play').getBoundingClientRect();check(stage.classList.contains('is-active')&&stage.querySelectorAll('.compact-visualizer__band').length>20,'actual compact skyline renders active spectral bands');check(box.bottom<=play.top,'compact visualizer stage stays above the transport')}
 return {...result,glass:true,visualizer}
}
window.prepareFamilyAutoHide=async()=>{const f=window.familyFixture;f.props.autoHide=true;f.flashReveal();await settle()}
window.checkFamilyHidden=()=>check(document.querySelector('.player-bar-shell').dataset.tePlaybarHidden==='true','idle pointer allows automatic hiding')
window.revealFamilyWithPanel=async()=>{const f=window.familyFixture;f.flashReveal();await settle();document.querySelector('.volume-control-button').click();await settle();const popup=document.querySelector('.volume-drawer').getBoundingClientRect();check(popup.top>=0&&popup.left>=0&&popup.right<=innerWidth,'volume popup stays within viewport')}
window.checkFamilyHeld=()=>check(document.querySelector('.player-bar-shell').dataset.tePlaybarHidden==='false','active panel or keyboard focus keeps auto-hide visible: '+JSON.stringify({mode:window.familyFixture.props.mode,panel:window.familyFixture.volumeOpen.value,active:document.activeElement?.outerHTML,focusVisible:document.activeElement?.matches(':focus-visible')}))
window.prepareFamilyFocus=async()=>{window.familyFixture.closeFloatingPanels();window.familyFixture.flashReveal();await settle();document.querySelector('.previous-button').focus()}
window.finishFamilyFocus=()=>document.getElementById('outside-focus').focus()
`

const runner = `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path')
app.setPath('userData',path.join(__dirname,'profile'));app.setPath('sessionData',path.join(__dirname,'session'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,frame:false,width:1380,height:900,useContentSize:true,webPreferences:{offscreen:{deviceScaleFactor:1},backgroundThrottling:false}})
 const evidence=process.env.TE_PLAYER_FAMILY_EVIDENCE_DIR,results=[]
 const run=(code)=>win.webContents.executeJavaScript(code)
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))
 const screenshot=async name=>{if(evidence){const result=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(result.data,'base64'))}}
 const resize=async width=>{win.setSize(width,900);await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(50)}
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)})
 try{
  await win.loadFile(process.argv.at(-1))
  win.webContents.debugger.attach('1.3')
  for(const width of [760,960,1380]){
   await resize(width)
   for(const mode of ['standard','mini','compact'])for(const tone of ['pureWhite','dark'])for(const fontSize of [14,18])for(const custom of [false,true]){
    await run('window.prepareFamily('+JSON.stringify(mode)+','+JSON.stringify(tone)+','+fontSize+','+custom+')')
    const result=await run('window.checkFamilyGeometry('+custom+')');results.push({...result,tone,fontSize})
    if((width===760&&fontSize===18&&!custom)||(width===1380&&fontSize===14&&!custom)||(width===960&&fontSize===18&&custom))await screenshot(mode+'-'+tone+'-'+width+'-'+fontSize+(custom?'-custom':''))
   }
  }
  await resize(960)
  for(const mode of ['standard','mini','compact']){
   await run('window.prepareFamily('+JSON.stringify(mode)+',"dark",14,false)')
   for(const kind of ['prev','play','next']){
    const point=await run('window.familyTransport('+JSON.stringify(kind)+')')
    for(const type of ['mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',x:Math.round(point.x),y:Math.round(point.y),clickCount:1})
    await run('window.checkFamilyTransport('+JSON.stringify(kind)+','+point.before+')')
   }
   const point=await run('window.prepareFamilySeek()')
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x),y:Math.round(point.y)})
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',x:Math.round(point.x),y:Math.round(point.y),clickCount:1})
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x+point.width*.08),y:Math.round(point.y)})
   await wait(30);const value=await run('window.checkFamilyDrag()')
   win.webContents.sendInputEvent({type:'mouseUp',button:'left',x:Math.round(point.x+point.width*.08),y:Math.round(point.y),clickCount:1})
   await run('window.checkFamilySeekCommit('+value+')')
   win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0})
   await run('window.prepareFamily('+JSON.stringify(mode)+',"dark",18,false,false,true)');await run('window.checkFamilyLive()')
   await screenshot(mode+'-live')
   await run('window.prepareFamily('+JSON.stringify(mode)+',"pureWhite",18,false,true,false)');await run('window.checkFamilyIdle()');await run('window.checkFamilyGeometry(false,true)')
   await screenshot(mode+'-idle')
  }
  await resize(760)
  for(const mode of ['standard','mini','compact']){await run('window.prepareFamily('+JSON.stringify(mode)+',"dark",18,false)');await run('window.checkFamilyLongTime()');await screenshot(mode+'-long-time-760')}
  for(const tone of ['pureWhite','dark'])for(const mode of ['standard','mini','compact']){
   await run('window.prepareFamily('+JSON.stringify(mode)+','+JSON.stringify(tone)+',18,false)');results.push({...await run('window.checkFamilyVariant(false)'),tone,fontSize:18});await screenshot(mode+'-'+tone+'-glass-760-18')
  }
  for(const tone of ['pureWhite','dark']){
   await run('window.prepareFamily("compact",'+JSON.stringify(tone)+',18,false)');results.push({...await run('window.checkFamilyVariant(true)'),tone,fontSize:18});await screenshot('compact-'+tone+'-visualizer-760-18')
  }
  await resize(960)
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});win.webContents.focus()
  for(const mode of ['mini','compact']){
   await run('window.prepareFamily('+JSON.stringify(mode)+',"dark",18,false)')
   await run('window.prepareFamilyAutoHide()');await wait(150);await run('window.checkFamilyHidden()')
   await run('window.revealFamilyWithPanel()');await wait(150);await run('window.checkFamilyHeld()');await screenshot(mode+'-volume-auto-hide')
   // A real keyboard event establishes the native :focus-visible modality.
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'})
   await run('window.prepareFamilyFocus()');await wait(150);await run('window.checkFamilyHeld()')
   await run('window.finishFamilyFocus()');await wait(150);await run('window.checkFamilyHidden()')
  }
  if(evidence)fs.writeFileSync(path.join(evidence,'player-family-geometry.json'),JSON.stringify({scope:'Actual Vue PlayerBar templates, stylesheet, icons, seek, floating panel and auto-hide; observable player-store callbacks; isolated hidden Electron userData',results},null,2))
  console.log('PLAYER_FAMILY_OK '+results.length+' geometry cases; real transport, pointer seek, LIVE, idle and auto-hide focus/popup checks');app.exit(0)
 }catch(error){await screenshot('player-family-failure');console.error(error);app.exit(1)}
})
`
