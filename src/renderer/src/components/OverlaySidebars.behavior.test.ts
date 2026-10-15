import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('overlay sidebars preserve content and playback geometry, source controls and large queue access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-overlay-sidebars-'))
  try {
    const app = await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8')
    const appStyles = [...app.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((match) => match[1])
      .join('\n')
    const player = await readFile(
      join(workspace, 'src/renderer/src/components/PlayerBar.vue'),
      'utf8'
    )
    const narrowHook = player.match(
      /function reconcileNarrowSidebars\(\): void \{[\s\S]*?\n\}/
    )?.[0]
    assert.ok(narrowHook, 'production playback must reconcile navigation on viewport changes')
    assert.match(player, /watch\(\(\) => props\.leftNavigationOpen, reconcileNarrowSidebars\)/)
    assert.match(player, /window\.addEventListener\('resize', reconcileNarrowSidebars\)/)
    const narrowLifecycle = player.slice(
      player.indexOf('let sidebarLayoutObserver:'),
      player.indexOf('function openQueueSource(')
    )
    assert.match(narrowLifecycle, /new MutationObserver\(reconcileNarrowSidebars\)/)
    const queueOpenHook = app.match(/function handleQueueOpened\(\): void \{[\s\S]*?\n\}/)?.[0]
    assert.ok(queueOpenHook, 'application must reconcile navigation when its queue opens')
    await writeFile(join(directory, 'app-shell.css'), appStyles)
    await writeFile(
      join(directory, 'entry.ts'),
      runtime
        .replace('/* PRODUCTION_NARROW_SIDEBAR_HOOK */', narrowHook)
        .replace('/* PRODUCTION_NARROW_SIDEBAR_LIFECYCLE */', narrowLifecycle)
        .replace('/* PRODUCTION_QUEUE_OPEN_HOOK */', queueOpenHook)
    )
    await writeFile(
      join(directory, 'fixtures.ts'),
      `import {ref} from 'vue'
export const useSettingsStore=()=>({settings:ref({navigationPages:{version:1,order:[],hidden:[]}}),updateSettings:async()=>{}})
export const useMusicStore=()=>({libraryScanStatus:ref({state:'idle'}),libraryScanProgress:ref(null)})
export const clearLocalCoverDataCache=()=>{}
export const invalidateRemoteCoverGrant=()=>{}
export const resolveCover=async()=>null`
    )
    await writeFile(
      join(directory, 'PlayerSurface.vue'),
      `<script setup lang="ts">
defineProps<{shape:string;idleEntrance:boolean}>()
const emit=defineEmits<{control:[]}>()
</script>
<template>
  <div class="player-bar-shell" :data-te-playbar-mode="shape" data-te-playbar-hidden="false" data-te-playbar-visibility="visible">
    <div class="player-bar" :class="{'player-bar-mini':shape==='mini','player-bar-compact':shape==='compact'}">
      <div class="player-left">覆盖侧栏验证</div><div class="player-center">Twilight Echo</div><div class="player-right">播放</div>
      <button class="fixture-player-left" type="button" aria-label="左端播放操作" @click="emit('control')">◀</button>
      <button v-if="!idleEntrance" key="active" class="fixture-player-right" type="button" aria-label="右端播放操作" aria-controls="playback-queue-sidebar" @click="emit('control')">▶</button>
      <button v-else key="idle" id="idle-queue-opener" class="fixture-player-right" type="button" aria-label="打开播放队列" aria-controls="playback-queue-sidebar" @click="emit('control')">队列</button>
    </div>
  </div>
</template>
<style scoped src="${join(workspace, 'src/renderer/src/components/player-bar/PlayerBar.css').replaceAll('\\', '/')}"></style>
<style scoped>.fixture-player-left,.fixture-player-right{position:absolute;top:50%;transform:translateY(-50%);width:28px;height:28px;z-index:5;border:0;border-radius:5px;background:var(--te-control-bg);color:var(--te-chrome-text);cursor:pointer}.fixture-player-left{left:8px}.fixture-player-right{right:8px}.player-left{padding-left:34px}.player-right{padding-right:34px}</style>`
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [vue()],
      resolve: {
        alias: [
          { find: '/icon.png', replacement: join(workspace, 'resources/icon.png') },
          {
            find: /^(?:.*\/stores\/use(?:Settings|Music)Store|.*\/utils\/coverLoader)(?:\.ts)?$/,
            replacement: join(directory, 'fixtures.ts')
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') }
        ]
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'OverlaySidebarsTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">
      ${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}
      <style>html,body{margin:0;height:100%;overflow:hidden}#app{height:100%}.app-shell-title{height:44px;min-height:44px}.title-bar{position:fixed;inset:0 0 auto;height:44px;display:flex;gap:12px;align-items:center;padding:0 12px;background:var(--te-app-bg)}.title-bar button{font:inherit;border:0;background:var(--te-control-bg);color:var(--te-shell-control-text);padding:5px 12px;border-radius:5px}.content-fixture{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:16px;padding:24px;background:var(--te-home-bg,var(--te-app-bg))}.content-fixture article{min-height:130px;background:var(--te-card-bg);border-radius:8px;padding:16px}.content-fixture h1{grid-column:1/-1;margin:0;font-size:26px}.content-fixture button{font:inherit;padding:8px;border:1px solid var(--te-card-border);border-radius:6px;background:var(--te-control-bg);color:var(--te-shell-control-text)}</style>
      </head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90_000, maxBuffer: 2_000_000, env: environment }
    )
    assert.match(result.stdout, /OVERLAY_SIDEBARS_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});
 win.webContents.on('console-message',event=>console.error(event.message));
 try{
  await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  let scenarios=0;
  for(const size of [[1280,800],[960,560],[760,520],[620,500]]){
   win.setContentSize(...size);await new Promise(resolve=>setTimeout(resolve,35));
   for(const tone of ['pureWhite','dark'])for(const layout of ['classic','custom'])for(const shape of ['standard','mini','compact']){
    const scenario={width:size[0],height:size[1],tone,layout,shape};
    await win.webContents.executeJavaScript('window.runOverlayScenario('+JSON.stringify(scenario)+')');scenarios++;
    if(process.env.TE_OVERLAY_PREVIEW_DIR&&((size[0]===1280&&tone==='pureWhite'&&layout==='classic'&&shape==='standard')||(size[0]===960&&tone==='dark'&&layout==='custom'&&shape==='mini')||(size[0]===620&&tone==='pureWhite'&&layout==='classic'&&shape==='compact'))){fs.mkdirSync(process.env.TE_OVERLAY_PREVIEW_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TE_OVERLAY_PREVIEW_DIR,tone+'-'+layout+'-'+size[0]+'-'+shape+'.png'),(await win.webContents.capturePage()).toPNG())}
   }
  }
  win.setContentSize(1280,800);await new Promise(resolve=>setTimeout(resolve,35));
  await win.webContents.executeJavaScript('window.runQueueBehavior()');
  await win.webContents.executeJavaScript('window.runQueuePresentationBehavior()');
  await win.webContents.executeJavaScript('window.runQueueSelectionAndDialogFocus()');
  if(process.env.TE_OVERLAY_PREVIEW_DIR)for(const tone of ['pureWhite','dark']){await win.webContents.executeJavaScript('window.prepareQueuePreview('+JSON.stringify(tone)+')');fs.writeFileSync(path.join(process.env.TE_OVERLAY_PREVIEW_DIR,tone+'-default-queue.png'),(await win.webContents.capturePage()).toPNG())}
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});await win.webContents.executeJavaScript('window.checkForcedColorFallback()');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  await win.webContents.executeJavaScript('window.prepareSourceKeyboard()');win.webContents.focus();
  for(const event of [{type:'keyDown',keyCode:'Enter'},{type:'char',keyCode:String.fromCharCode(13)},{type:'keyUp',keyCode:'Enter'}])win.webContents.sendInputEvent(event);
  await new Promise(resolve=>setTimeout(resolve,65));await win.webContents.executeJavaScript('window.checkSourceKeyboard()');
  await win.webContents.executeJavaScript('window.prepareSelectionKeyboard()');
  for(const event of [{type:'keyDown',keyCode:'Enter'},{type:'char',keyCode:String.fromCharCode(13)},{type:'keyUp',keyCode:'Enter'}])win.webContents.sendInputEvent(event);
  await new Promise(resolve=>setTimeout(resolve,65));await win.webContents.executeJavaScript('window.checkSelectionKeyboard()');
  await win.webContents.executeJavaScript('window.prepareQueueMenuEscape()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await new Promise(resolve=>setTimeout(resolve,65));
  await win.webContents.executeJavaScript('window.checkQueueMenuEscape()');
  await win.webContents.executeJavaScript('window.prepareNarrowSidebarPolicy()');win.setContentSize(560,500);await new Promise(resolve=>setTimeout(resolve,85));
  await win.webContents.executeJavaScript('window.checkNarrowSidebarPolicy()');
  if(process.env.TE_OVERLAY_PREVIEW_DIR)fs.writeFileSync(path.join(process.env.TE_OVERLAY_PREVIEW_DIR,'dark-custom-persistent-560-queue.png'),(await win.webContents.capturePage()).toPNG());
  win.setContentSize(760,520);await new Promise(resolve=>setTimeout(resolve,55));await win.webContents.executeJavaScript('window.checkLargeFontSidebarPolicy()');
  win.setContentSize(1280,800);await new Promise(resolve=>setTimeout(resolve,55));
  await win.webContents.executeJavaScript('window.prepareNativeModal()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await new Promise(resolve=>setTimeout(resolve,65));
  await win.webContents.executeJavaScript('window.checkNativeModalEscape()');
  await win.webContents.executeJavaScript('window.prepareEscape()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await new Promise(resolve=>setTimeout(resolve,45));
  await win.webContents.executeJavaScript('window.checkFirstEscape()');
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await new Promise(resolve=>setTimeout(resolve,45));
  await win.webContents.executeJavaScript('window.checkSecondEscape()');
  console.log('OVERLAY_SIDEBARS_OK '+scenarios+' geometry scenarios');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});`

const runtime = `import {createApp,h,ref,nextTick,onMounted,onBeforeUnmount,watch} from 'vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import PlaybackQueueSidebar from '@renderer/components/player-bar/PlaybackQueueSidebar.vue'
import PlayerSurface from './PlayerSurface.vue'
import {useFloatingPanels} from '@renderer/components/player-bar/useFloatingPanels'
import {usePlaybackQueueDrawerActions} from '@renderer/components/player-bar/usePlaybackQueueDrawerActions'
import {useEscapeToClose} from '@renderer/app/useDismissLayer'
import {useSideMenuClearance} from '@renderer/app/useSideMenuClearance'
import {overlaySidebarsNeedExclusiveMode} from '@renderer/app/overlaySidebars'
import {themeShellLayoutToCssVariables} from '@renderer/../../shared/themeLayout.ts'
import '@renderer/assets/main.css'
import '@renderer/assets/icon-fonts.ts'
import './app-shell.css'
const leftOpen=ref(false),shape=ref('standard'),queue=ref([]),queueIndex=ref(0),liquid=ref(false),idleEntrance=ref(false),innerDismissOpen=ref(false)
const history=ref([]),historyLoading=ref(false),canUndo=ref(false)
const sourceEvents=[],playEvents=[],nextEvents=[],tailEvents=[],removeEvents=[],moveEvents=[],historyEvents=[],playlistEvents=[];let playerControls=0,sessions=0,undoEvents=0,tailSequence=0,panels,geometry
let captureActionFocus=false,closeQueueOnSource=false,actionDialog=null
const closeActionDialog=()=>{actionDialog?.close();actionDialog?.remove();actionDialog=null}
const openActionDialog=label=>{if(!captureActionFocus)return;closeActionDialog();actionDialog=document.createElement('dialog');actionDialog.setAttribute('aria-label',label);const button=document.createElement('button');button.type='button';button.textContent=label+'操作';actionDialog.append(button);document.body.append(actionDialog);actionDialog.show();button.focus({preventScroll:true})}
const nativeMenuRequests=[],pendingNativeMenus=new Map()
window.api={window:{popupContextMenu:request=>{nativeMenuRequests.push(request);return new Promise(resolve=>pendingNativeMenus.set(request.requestId,resolve))},closeContextMenu:async requestId=>{pendingNativeMenus.get(requestId)?.(null);pendingNativeMenus.delete(requestId)}}}
const origins=[{scope:'local',kind:'album',id:'local-album-key',name:'本地专辑来源'},{scope:'provider',providerId:'fixture-provider',kind:'album',id:'provider-album-42',name:'流媒体专辑来源'},{scope:'aggregate',kind:'playlist',id:'aggregate-list-key',name:'聚合歌单来源'},{scope:'provider',providerId:'fixture-provider',kind:'playlist',id:'provider-playlist-84',name:'流媒体歌单来源'}]
const tracks=count=>Array.from({length:count},(_,index)=>({id:'track-'+index,queueEntryId:'entry-'+index,title:'歌曲 '+index,artist:'测试艺术家',album:'专辑名称',duration:180,cover:null,filePath:'C:/fixture/'+index+'.flac',fileName:index+'.flac',size:1,lyrics:null,source:'local',queuePlaybackOrigin:origins[index%origins.length]}))
const queueActions=usePlaybackQueueDrawerActions({queue,createPlaylistWithTracks:()=>'',commands:{
 enqueueTrack:track=>{tailEvents.push(track.queueEntryId);queue.value=[...queue.value,{...track,queueEntryId:'tail-entry-'+(++tailSequence)}]},
 playNextTrack:track=>nextEvents.push(track.queueEntryId),
 removeQueueItem:index=>{const current=queue.value[queueIndex.value]?.queueEntryId;removeEvents.push(queue.value[index]?.queueEntryId);queue.value=queue.value.filter((_,i)=>i!==index);queueIndex.value=queue.value.findIndex(track=>track.queueEntryId===current)},
 clearQueue:()=>{queue.value=[];queueIndex.value=-1},
 reorderQueue:(from,to)=>{const current=queue.value[queueIndex.value]?.queueEntryId,updated=[...queue.value];moveEvents.push([updated[from]?.queueEntryId,from,to]);const [moved]=updated.splice(from,1);updated.splice(to,0,moved);queue.value=updated;queueIndex.value=updated.findIndex(track=>track.queueEntryId===current)},
 saveQueueAsPlaylist:()=>''
}})
const expect=(condition,message)=>{if(!condition)throw Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,55));await nextTick();geometry?.measureSideMenuClearance();await nextTick()}
const rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
const sameRect=(left,right)=>Object.keys(left).every(key=>Math.abs(left[key]-right[key])<.6)
const pointer=element=>element.dispatchEvent(new PointerEvent('pointerdown',{button:0,isPrimary:true,bubbles:true,cancelable:true}))
const key=(element,value,options={})=>element.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...options}))
const row=id=>document.querySelector('.queue-item[data-queue-entry-id="'+id+'"]')
const nativeItems=items=>items.flatMap(item=>[item,...nativeItems(item.submenu||[])])
const currentNativeMenu=()=>nativeMenuRequests.at(-1)
const chooseMenu=async label=>{const request=currentNativeMenu(),item=nativeItems(request.items).find(item=>typeof label==='string'?item.label===label:label.test(item.label));expect(item,'native menu action missing: '+label+' '+JSON.stringify(request.items));expect(item.enabled!==false,'native menu action disabled: '+item.label);pendingNativeMenus.get(request.requestId)?.(item.id);pendingNativeMenus.delete(request.requestId);await settle()}
const openGlobalMenu=async()=>{const button=document.querySelector('.queue-global-more');expect(button,'queue global menu entry missing');button.focus();pointer(button);button.click();await settle();return button}
const app=createApp({setup(){
 const shell=ref(null)
 panels=useFloatingPanels(shell,{isInternalTarget:target=>target instanceof Element&&!!target.closest('.queue-sidebar,.side-menu,.title-bar .menu-btn')})
 const props={get leftNavigationOpen(){return !!window.__narrowPolicyEnabled&&leftOpen.value}}
 const dismissFloatingPanels=panels.dismissFloatingPanels
 /* PRODUCTION_NARROW_SIDEBAR_HOOK */
 watch(()=>props.leftNavigationOpen,reconcileNarrowSidebars)
 /* PRODUCTION_NARROW_SIDEBAR_LIFECYCLE */
 const closeLeft=()=>{leftOpen.value=false;document.querySelector('#navigation-opener')?.focus({preventScroll:true})}
 const closeNavigation=closeLeft
 /* PRODUCTION_QUEUE_OPEN_HOOK */
 watch(panels.playlistOpen,open=>{if(open&&window.__narrowPolicyEnabled)handleQueueOpened()})
 useEscapeToClose(leftOpen,closeLeft);useEscapeToClose(panels.playlistOpen,panels.closeFloatingPanels)
 useEscapeToClose(innerDismissOpen,()=>innerDismissOpen.value=false)
 geometry=useSideMenuClearance({showLocalSidebar:ref(true),hasPlayerBar:ref(true)})
 watch(geometry.playerBottomClearance,clearance=>document.documentElement.style.setProperty('--te-playbar-bottom-clearance',clearance+'px'),{immediate:true})
 onMounted(()=>geometry.startSideMenuMonitor());onBeforeUnmount(()=>geometry.dispose())
 return()=>h('div',{class:'app-shell',style:{'--te-side-menu-bottom':geometry.sideMenuBottomOffset.value+'px','--te-side-menu-tools-clearance':geometry.sideMenuToolsClearance.value+'px'}},[
  h('div',{class:'app-shell-title'},[h('div',{class:'title-bar'},[h('button',{id:'navigation-opener',class:'menu-btn',onClick:()=>leftOpen.value=!leftOpen.value},'导航'),h('button',{id:'queue-opener',onClick:panels.togglePlaylist},'播放队列')])]),
  h('div',{class:['app-shell-navigation',{'navigation-temporary':leftOpen.value}]},[h(SideMenu,{open:leftOpen.value,liquidMaterial:liquid.value,activeKey:'streaming-home'})]),
  h('div',{class:'app-shell-content'},[h('main',{class:['main-content',{'menu-open':leftOpen.value}]},[h('div',{class:'content-fixture'},[h('h1','内容区域宽度保持稳定'),h('article',{id:'content-card-left'},[h('p','左右侧栏覆盖在页面上。'),h('button',{id:'content-action'},'正文控件')]),h('article',{id:'content-card-right'},'测试两侧覆盖时的实际正文几何')])])]),
  h('div',{class:'app-shell-player',ref:shell},[h(PlayerSurface,{shape:shape.value,idleEntrance:idleEntrance.value,onControl:()=>playerControls++})]),
  h(PlaybackQueueSidebar,{open:panels.playlistOpen.value,queue:queue.value,queueIndex:queueIndex.value,isPlaying:false,summary:'当前播放队列',canUndo:canUndo.value,undoLabel:'清空',draggedEntryId:queueActions.draggedEntryId.value,liquidMaterial:liquid.value,history:history.value,historyLoading:historyLoading.value,
   onPlay:id=>{playEvents.push(id);queueIndex.value=queue.value.findIndex(track=>track.queueEntryId===id)},onOpenSource:origin=>{sourceEvents.push(JSON.parse(JSON.stringify(origin)));if(closeQueueOnSource)panels.closeFloatingPanels();openActionDialog('来源详情')},onClose:panels.closeFloatingPanels,onClear:queueActions.clear,onSessions:()=>{sessions++;openActionDialog('播放会话')},onUndo:()=>undoEvents++,
   onNext:queueActions.playNext,onTail:queueActions.addToTail,onRemove:queueActions.remove,onMove:(id,direction)=>queueActions.move(id,direction),onAddPlaylist:id=>{playlistEvents.push(id);openActionDialog('添加到歌单')},onReplayHistory:id=>historyEvents.push(id),onDragStart:queueActions.onDragStart,onDragOver:queueActions.onDragOver,onDrop:queueActions.onDrop,onDragEnd:queueActions.onDragEnd})
 ])
}}).mount('#app')
const configureLayout=layout=>{
 const root=document.documentElement
 for(const property of [...root.style])if(property.startsWith('--te-shell-'))root.style.removeProperty(property)
 if(layout==='custom'){
  root.dataset.teShellLayout='custom';root.dataset.teShellNavigation='toggle'
  const grid={columns:['standard','fill'],rows:['auto','fill','auto'],areas:[['titleBar','titleBar'],['navigation','content'],['navigation','playerBar']]}
  for(const [key,value]of Object.entries(themeShellLayoutToCssVariables({desktop:grid,compact:grid,navigation:'toggle'})))root.style.setProperty(key,value)
 }else{delete root.dataset.teShellLayout;delete root.dataset.teShellNavigation}
}
const setOpen=async()=>{leftOpen.value=true;if(!panels.playlistOpen.value)panels.togglePlaylist();await settle()}
window.runOverlayScenario=async(config)=>{
 const root=document.documentElement;root.dataset.theme=config.tone;root.dataset.teNavigationStyle='expanded';root.style.setProperty('--te-font-size-body','14px');configureLayout(config.layout);shape.value=config.shape;liquid.value=false
 queue.value=tracks(24);queueIndex.value=0;leftOpen.value=false;panels.closeFloatingPanels();await settle();await document.fonts.ready
 const main=document.querySelector('.main-content'),cardLeft=document.querySelector('#content-card-left'),cardRight=document.querySelector('#content-card-right')
 const baseline=[main,cardLeft,cardRight].map(rect);const playerBefore=rect(document.querySelector('.player-bar'))
 await setOpen()
 const left=document.querySelector('.side-menu'),right=document.querySelector('.queue-sidebar'),bar=document.querySelector('.player-bar')
 expect([main,cardLeft,cardRight].every((element,index)=>sameRect(rect(element),baseline[index])),'opening overlays changed content geometry: '+JSON.stringify(config))
 expect(sameRect(rect(bar),playerBefore),'opening overlays moved or resized playback: '+JSON.stringify(config))
 const expandedNavigation=rect(left).width,expandedQueue=rect(right).width
 expect(expandedNavigation>0&&expandedNavigation<=innerWidth-8+.6&&expandedQueue>=Math.min(260,innerWidth-8)-.6&&expandedQueue>=expandedNavigation-.6,'navigation density or queue reading width is unusable: '+JSON.stringify(config))
 for(const property of ['backgroundColor','backdropFilter','borderRadius','borderTopColor','boxShadow'])expect(getComputedStyle(left)[property]===getComputedStyle(right)[property],'panel materials differ at '+property+': '+JSON.stringify(config))
 expect(rect(left).bottom===innerHeight-6&&rect(right).bottom===innerHeight-6,'painted sidebars do not reach the inset window bottom')
 for(const selector of ['.fixture-player-left','.fixture-player-right']){
  const control=document.querySelector(selector),r=control.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)
  expect(hit===control||control.contains(hit),'sidebar covers a playback control: '+selector+' '+JSON.stringify(config));pointer(control);control.click()
 }
 expect(panels.playlistOpen.value,'playback pointer dismissed the queue')
 const list=document.querySelector('.queue-list'),barRect=rect(bar)
 expect(rect(list).bottom<=barRect.top+1,'queue scroller puts actions underneath playback: '+JSON.stringify(config))
 for(const group of left.querySelectorAll('.menu-group-toggle'))if(group.getAttribute('aria-expanded')==='false')group.click()
 await settle();const nav=left.querySelector('.menu-nav');nav.scrollTop=nav.scrollHeight;await settle()
 const last=[...nav.querySelectorAll('.menu-item')].filter(button=>button.checkVisibility()).at(-1)
 expect(rect(last).bottom<=barRect.top+1,'last navigation action cannot scroll above the player: '+JSON.stringify(config))
 expect(document.documentElement.scrollWidth<=innerWidth,'overlay creates horizontal viewport overflow')
 let previousNavigation=expandedNavigation
 for(const mode of ['compact','rail']){root.dataset.teNavigationStyle=mode;await settle();expect(rect(left).width<previousNavigation&&Math.abs(rect(right).width-expandedQueue)<.6,'navigation density fails to shrink independently of the readable queue');previousNavigation=rect(left).width;expect([main,cardLeft,cardRight].every((element,index)=>sameRect(rect(element),baseline[index]))&&sameRect(rect(bar),playerBefore),'navigation density moves content or playback')}
 root.dataset.teNavigationStyle='expanded';await settle()
}
window.runQueueBehavior=async()=>{
 configureLayout('classic');document.documentElement.dataset.theme='dark';shape.value='standard';await setOpen();queue.value=tracks(24);queueIndex.value=0;await settle()
 const source=document.querySelector('.queue-source'),expected=origins[0];const plays=playEvents.length
 pointer(source);source.click();await settle();expect(JSON.stringify(sourceEvents.at(-1))===JSON.stringify(expected),'source click changes its captured origin');expect(playEvents.length===plays,'source click also plays the row');expect(panels.playlistOpen.value,'source pointer dismissed the teleported queue')
 const navigationButton=document.querySelector('.side-menu .menu-item');pointer(navigationButton);expect(panels.playlistOpen.value,'related navigation pointer dismissed the queue')
 pointer(document.querySelector('#content-action'));await settle();expect(!panels.playlistOpen.value,'uncovered content did not dismiss the queue');await setOpen()
 liquid.value=true;await settle();for(const property of ['backgroundColor','backdropFilter'])expect(getComputedStyle(document.querySelector('.side-menu'),'::before')[property]===getComputedStyle(document.querySelector('.queue-sidebar'),'::before')[property],'liquid panel substrate drift: '+property);liquid.value=false
 for(const tone of ['pureWhite','dark'])for(const fallback of ['no-blur','reduced']){
  document.documentElement.dataset.theme=tone;if(fallback==='no-blur')document.body.classList.add('te-no-blur');else document.documentElement.dataset.teEffectsMode='reduced'
  for(const glass of [false,true]){liquid.value=glass;await settle();const pseudo=glass?'::before':null;const styles=[...document.querySelectorAll('.side-menu,.queue-sidebar')].map(panel=>getComputedStyle(panel,pseudo));expect(styles[0].backgroundColor===styles[1].backgroundColor&&styles.every(style=>style.backdropFilter==='none'),'reduced-effect sidebar fallback differs: '+tone+' '+fallback+' '+glass);const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=styles[0].backgroundColor;ctx.fillRect(0,0,1,1);expect(ctx.getImageData(0,0,1,1).data[3]===255,'sidebar fallback remains translucent without diffusion')}
  document.body.classList.remove('te-no-blur');delete document.documentElement.dataset.teEffectsMode
 }
 liquid.value=false;document.documentElement.dataset.theme='dark';await settle()
 queue.value=tracks(10000);queueIndex.value=7654;document.documentElement.style.setProperty('--te-font-size-body','21px');await settle()
 let rows=[...document.querySelectorAll('.queue-item')];expect(rows.length>0&&rows.length<40,'10k queue renders unbounded rows: '+rows.length);const rowHeight=parseFloat(getComputedStyle(document.querySelector('.queue-sidebar')).getPropertyValue('--queue-row-height'));expect(rowHeight>=84&&[...document.querySelectorAll('.queue-window .queue-item')].every(item=>Math.abs(rect(item).height-rowHeight)<1),'font-scaled row height disagrees with virtual window');expect(document.querySelector('.queue-item.active .queue-title')?.textContent==='歌曲 7654','current entry is not revealed after a font change')
 const list=document.querySelector('.queue-list');list.scrollTop=list.scrollHeight;list.dispatchEvent(new Event('scroll'));await settle();rows=[...document.querySelectorAll('.queue-item')];expect(rows.length<40&&rows.at(-1).querySelector('.queue-title').textContent==='歌曲 9999','end of large queue is inaccessible or unbounded')
 const largeQueuePlays=playEvents.length;key(row('entry-9999').querySelector('.queue-track'),'Home');await settle();expect(row('entry-7655')?.classList.contains('selected'),'Home cannot reveal the first upcoming row in a large queue');key(row('entry-7655').querySelector('.queue-track'),'End');await settle();expect(row('entry-9999')?.classList.contains('selected')&&document.activeElement===row('entry-9999').querySelector('.queue-track'),'End cannot reveal and focus the final virtual row');expect(playEvents.length===largeQueuePlays&&queueIndex.value===7654,'large queue keyboard selection changes current playback')
 row('entry-9999').querySelector('.queue-row-more').click();await settle();await chooseMenu(/上移|向上移动/);expect(queue.value[9998].queueEntryId==='entry-9999'&&queue.value[queueIndex.value].queueEntryId==='entry-7654','moving the end of a virtual queue changes another occurrence or current playback');const dragSource=row('entry-9999'),dragTarget=row('entry-9998'),transfer=new DataTransfer();dragSource.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));dragTarget.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));dragTarget.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));dragSource.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));await settle();expect(queue.value.at(-1).queueEntryId==='entry-9999'&&queue.value[queueIndex.value].queueEntryId==='entry-7654','dragging at the large queue end loses stable occurrence identity')
 await openGlobalMenu();await chooseMenu('清空播放队列');expect(document.querySelector('.queue-empty')&&document.querySelector('.queue-sidebar'),'clearing removes the empty queue entry point');expect(!document.querySelector('.queue-item'),'clearing leaves mounted queue rows')
 await openGlobalMenu();await chooseMenu('会话');expect(sessions===1,'empty queue loses session recovery through the global menu')
 panels.closeFloatingPanels();await settle();const oldOpener=document.querySelector('.fixture-player-right');oldOpener.focus();panels.togglePlaylist();await settle();idleEntrance.value=true;await settle();expect(!oldOpener.isConnected,'idle fixture did not replace the original queue opener');document.querySelector('.queue-close').click();await settle();expect(document.activeElement===document.querySelector('#idle-queue-opener'),'closing an emptied queue loses focus after the playback opener is replaced');idleEntrance.value=false;await settle();panels.togglePlaylist();await settle()
 queue.value=tracks(4);queueIndex.value=0;document.documentElement.style.setProperty('--te-font-size-body','14px');await settle()
}
window.runQueuePresentationBehavior=async()=>{
 configureLayout('classic');document.documentElement.dataset.theme='pureWhite';document.documentElement.style.setProperty('--te-font-size-body','14px');queue.value=tracks(6).map(track=>({...track,id:'repeated-song'}));queueIndex.value=1;history.value=[];await setOpen();await settle()
 expect(document.querySelector('.queue-current .queue-title')?.textContent==='歌曲 1','current song has no separate playing section')
 expect([...document.querySelectorAll('.queue-sidebar h3')].some(element=>element.textContent.includes('正在播放'))&&[...document.querySelectorAll('.queue-sidebar h3')].some(element=>element.textContent.includes('接下来播放')),'current and upcoming songs have no visible hierarchy')
 expect(!row('entry-0')&&row('entry-2'),'default upcoming queue includes previously passed tracks or misses the next song')
 const currentBody=row('entry-1').querySelector('.queue-track');currentBody.focus();key(currentBody,'ArrowDown');await settle();expect(row('entry-2').classList.contains('selected')&&document.activeElement===row('entry-2').querySelector('.queue-track'),'keyboard navigation from current song does not enter the upcoming list')
 const compact=row('entry-2');expect(rect(compact).height>=68&&rect(compact).height<=80,'normal queue rows do not retain compact music-list density: '+rect(compact).height);expect(compact.textContent.includes('3:00'),'queue row omits track duration');expect(compact.querySelector('.queue-source')&&compact.querySelector('.queue-row-more'),'source or visible row action entrance missing')
 const initialPlays=playEvents.length;const selectedTrack=compact.querySelector('.queue-track');selectedTrack.focus();selectedTrack.click();await settle();expect(playEvents.length===initialPlays&&queueIndex.value===1,'single row click changes playback');expect(row('entry-2').classList.contains('selected')&&row('entry-1').classList.contains('active'),'selected and playing states overwrite each other');expect(row('entry-2').getAttribute('aria-selected')==='true'||row('entry-2').querySelector('[aria-selected="true"],[aria-pressed="true"]'),'selection only changes visual color');expect(row('entry-1').getAttribute('aria-current')==='true'||row('entry-1').querySelector('[aria-current="true"]'),'playing status only changes visual color')
 selectedTrack.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));await settle();expect(playEvents.at(-1)==='entry-2'&&queueIndex.value===2,'double click resolves duplicate track IDs instead of the exact queue occurrence')
 const global=await openGlobalMenu();await chooseMenu(/查看完整队列/);expect(row('entry-0'),'full queue menu cannot reveal earlier entries');expect(document.activeElement===global,'global native menu does not return keyboard focus')
 let body=row('entry-2').querySelector('.queue-track');body.focus();key(body,'ArrowDown');await settle();expect(row('entry-3').classList.contains('selected'),'ArrowDown does not select the adjacent queue occurrence');body=row('entry-3').querySelector('.queue-track');key(body,'Home');await settle();expect(row('entry-0').classList.contains('selected'),'Home does not select the first full queue occurrence');key(row('entry-0').querySelector('.queue-track'),'End');await settle();expect(row('entry-5').classList.contains('selected'),'End does not select the final queue occurrence');expect(queueIndex.value===2,'arrow and endpoint navigation starts playback')
 const more=row('entry-5').querySelector('.queue-row-more');more.focus();more.click();await settle();expect(nativeItems(currentNativeMenu().items).some(item=>item.label==='查看来源'),'row native menu has no source action');await chooseMenu('下一首播放');expect(nextEvents.at(-1)==='entry-5','row menu next loses stable queue identity');expect(document.activeElement===more,'row menu action does not restore focus')
 more.click();await settle();await chooseMenu('添加到队尾');expect(tailEvents.at(-1)==='entry-5'&&queue.value.at(-1).queueEntryId.startsWith('tail-entry-'),'row menu cannot append the exact occurrence at the queue end');expect(queue.value.at(-1).queuePlaybackOrigin.id===origins[1].id,'appended occurrence loses its captured source')
 row('entry-5').querySelector('.queue-row-more').click();await settle();await chooseMenu(/上移|向上移动/);expect(moveEvents.at(-1)[0]==='entry-5','row move menu reorders a different duplicate track');expect(queue.value.findIndex(track=>track.queueEntryId==='entry-5')===4,'row keyboard alternative cannot move the final original item')
 const sourceBefore=sourceEvents.length,playsBeforeSource=playEvents.length;row('entry-3').querySelector('.queue-row-more').click();await settle();await chooseMenu('查看来源');expect(sourceEvents.length===sourceBefore+1&&sourceEvents.at(-1).id===origins[3].id,'native menu source action loses captured collection');expect(playEvents.length===playsBeforeSource,'source menu activation also starts playback')
 body=row('entry-3').querySelector('.queue-track');body.focus();key(body,'F10',{shiftKey:true});await settle();await chooseMenu('添加到歌单');expect(playlistEvents.at(-1)==='entry-3','Shift+F10 cannot open exact-row actions');body.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));await settle();await chooseMenu('下一首播放');expect(nextEvents.at(-1)==='entry-3','right click cannot open exact-row actions')
 const doomed='entry-4',removedBefore=removeEvents.length;row(doomed).querySelector('.queue-row-more').click();await settle();const obsoleteMenu=currentNativeMenu();queue.value=queue.value.filter(track=>track.queueEntryId!==doomed);await settle();expect(pendingNativeMenus.size===0,'removing the menu owner leaves an obsolete native popup active');expect(document.activeElement?.isConnected&&document.querySelector('.queue-sidebar').contains(document.activeElement),'removing the menu owner loses keyboard focus');const removeItem=nativeItems(obsoleteMenu.items).find(item=>item.label==='移除');expect(removeItem,'row native menu has no remove action');pendingNativeMenus.get(obsoleteMenu.requestId)?.(removeItem.id);pendingNativeMenus.delete(obsoleteMenu.requestId);await settle();expect(removeEvents.length===removedBefore&&queue.value.some(track=>track.queueEntryId==='entry-5'),'a stale row menu removed its replacement or a matching duplicate song')
 body=row('entry-3').querySelector('.queue-track');body.focus();key(body,'Delete');await settle();expect(removeEvents.at(-1)==='entry-3'&&!queue.value.some(track=>track.queueEntryId==='entry-3'),'Delete removes a track by provider ID instead of queue entry ID');const beforeSourceDelete=removeEvents.length,source=row('entry-5').querySelector('.queue-source');source.focus();key(source,'Delete');await settle();expect(removeEvents.length===beforeSourceDelete,'Delete on a source control removes its parent track')
 const historyTrack={...tracks(1)[0],queueEntryId:'obsolete-history-occurrence',title:'曾经真正播放',duration:65};history.value=[{id:'actual-history-record',playedAt:'2026-10-13T06:12:00.000Z',track:{id:historyTrack.id,queueEntryId:historyTrack.queueEntryId,source:historyTrack.source,title:historyTrack.title,artist:historyTrack.artist,album:historyTrack.album,duration:historyTrack.duration,filePath:historyTrack.filePath,queuePlaybackOrigin:historyTrack.queuePlaybackOrigin},playMode:'shuffle'}];await settle();const historyToggle=document.querySelector('.queue-history-toggle');expect(historyToggle&&historyToggle.getAttribute('aria-expanded')==='false','history does not start as an explicit disclosure');const queueBody=document.querySelector('.queue-current')||document.querySelector('.queue-window');expect(queueBody&&(historyToggle.compareDocumentPosition(queueBody)&Node.DOCUMENT_POSITION_FOLLOWING),'history disclosure is not above queue content');historyToggle.click();await settle();let historyRow=document.querySelector('.queue-history-item[data-history-entry-id="actual-history-record"]');expect(historyRow&&historyRow.textContent.includes('曾经真正播放')&&historyRow.textContent.includes('1:05'),'history does not show the real durable playback record');const beforeHistoryPlay=playEvents.length,replays=historyEvents.length;historyRow.querySelector('.history-track').click();await settle();expect(historyEvents.length===replays&&playEvents.length===beforeHistoryPlay,'single history click replays a song');historyRow.querySelector('.history-track').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}));await settle();expect(historyEvents.at(-1)==='actual-history-record','history replay uses the obsolete queue occurrence instead of record ID');queue.value=tracks(2);queueIndex.value=0;await settle();expect(document.querySelector('.queue-history-item[data-history-entry-id="actual-history-record"]')?.textContent.includes('曾经真正播放'),'history is fabricated from the replacement queue');historyToggle.click();await settle();expect(!document.querySelector('.queue-history-item')&&history.value.length===1,'collapsing history deletes its saved records');historyToggle.click();await settle();historyRow=document.querySelector('.queue-history-item');historyRow.querySelector('.history-track').focus();key(historyRow.querySelector('.history-track'),'Enter');await settle();expect(historyEvents.at(-1)==='actual-history-record','history has no keyboard replay route')
 queue.value=tracks(10000);queueIndex.value=0;await settle();const historyList=document.querySelector('.queue-list');historyList.scrollTop=historyList.scrollHeight;historyList.dispatchEvent(new Event('scroll'));await settle();const historyRows=[...document.querySelectorAll('.queue-window .queue-item')];expect(historyRows.length>0&&historyRows.length<40&&historyRows.at(-1).querySelector('.queue-title').textContent==='歌曲 9999','expanded history offsets hide the final virtual queue rows');await openGlobalMenu();await chooseMenu('定位正在播放');expect(row('entry-0')&&document.querySelector('.queue-history-item'),'locating playback loses current song with expanded history');await openGlobalMenu();await chooseMenu('只看接下来');expect(document.querySelector('.queue-current .queue-title')?.textContent==='歌曲 0'&&!document.querySelector('.queue-window .queue-item.active'),'upcoming view duplicates the current song');const upcomingList=document.querySelector('.queue-list');upcomingList.scrollTop=upcomingList.scrollHeight;upcomingList.dispatchEvent(new Event('scroll'));await settle();expect(document.querySelector('.queue-window .queue-item:last-child .queue-title')?.textContent==='歌曲 9999','upcoming virtualization loses the last row beneath history and current headings')
 canUndo.value=true;await openGlobalMenu();await chooseMenu(/撤销/);expect(undoEvents===1,'global menu drops undo');await openGlobalMenu();await chooseMenu('定位正在播放');expect(row('entry-0'),'global menu cannot locate current playback');const sessionsBefore=sessions;await openGlobalMenu();await chooseMenu('清空播放队列');expect(history.value.length===1&&document.querySelector('.queue-history-item'),'clear queue also discards the independent history');await openGlobalMenu();expect(nativeItems(currentNativeMenu().items).some(item=>item.label==='清空播放队列'&&item.enabled===false),'clear remains enabled on an empty queue');await chooseMenu('会话');expect(sessions===sessionsBefore+1&&document.querySelector('.queue-empty'),'empty queue loses its global session recovery route')
 history.value=[];canUndo.value=false;queue.value=tracks(4);queueIndex.value=0;await settle()
}
window.runQueueSelectionAndDialogFocus=async()=>{
 queue.value=tracks(100);queueIndex.value=5;history.value=[];await setOpen();const list=document.querySelector('.queue-list');list.scrollTop=400;list.dispatchEvent(new Event('scroll'));await settle();const listRect=rect(list),candidate=[...document.querySelectorAll('.queue-window .queue-item')].find(item=>rect(item).top>=listRect.top+10&&rect(item).bottom<=listRect.bottom-10);expect(candidate,'selection scroll fixture has no fully visible queue row');const id=candidate.dataset.queueEntryId,body=candidate.querySelector('.queue-track');body.focus({preventScroll:true});const scrollBefore=list.scrollTop,playBefore=playEvents.length;pointer(body);body.click();await settle();expect(Math.abs(list.scrollTop-scrollBefore)<1,'single row selection unexpectedly recenters the queue');expect(row(id)?.classList.contains('selected')&&playEvents.length===playBefore&&queueIndex.value===5,'single row selection changes playback instead of selection')
 captureActionFocus=true;try{for(const label of ['添加到歌单','查看来源']){const more=row(id).querySelector('.queue-row-more');more.focus({preventScroll:true});more.click();await settle();await chooseMenu(label);expect(actionDialog?.open&&document.activeElement===actionDialog.querySelector('button'),'closing '+label+' menu steals the newly opened interface focus');expect(pendingNativeMenus.size===0,'completed '+label+' action leaves a native menu active');closeActionDialog();await settle()}await openGlobalMenu();await chooseMenu('会话');expect(actionDialog?.open&&document.activeElement===actionDialog.querySelector('button'),'closing sessions menu steals the new dialog focus');expect(playEvents.length===playBefore,'opening source or collection interfaces changes playback');closeActionDialog();await settle();closeQueueOnSource=true;const sourceMore=row(id).querySelector('.queue-row-more');sourceMore.focus({preventScroll:true});sourceMore.click();await settle();await chooseMenu('查看来源');expect(!panels.playlistOpen.value&&!document.querySelector('.queue-sidebar'),'source navigation does not synchronously close the queue');expect(actionDialog?.open&&document.activeElement===actionDialog.querySelector('button'),'closing queue during source navigation steals the new interface focus');closeQueueOnSource=false;closeActionDialog();const reopenedFrom=document.querySelector('#queue-opener');reopenedFrom.focus();reopenedFrom.click();await settle();expect(document.querySelector('.queue-sidebar'),'queue cannot reopen after source navigation');document.querySelector('.queue-close').click();await settle();expect(document.activeElement===reopenedFrom,'ordinary queue close loses opener focus after source navigation')}finally{captureActionFocus=false;closeQueueOnSource=false;closeActionDialog()}
 queue.value=tracks(4);queueIndex.value=0;await settle()
}
window.prepareQueuePreview=async tone=>{configureLayout('classic');document.documentElement.dataset.theme=tone;document.documentElement.style.setProperty('--te-font-size-body','14px');shape.value='standard';queue.value=tracks(24);queueIndex.value=2;history.value=[];panels.closeFloatingPanels();await settle();await setOpen();const toggle=document.querySelector('.queue-history-toggle');if(toggle.getAttribute('aria-expanded')==='true'){toggle.click();await settle()}document.querySelector('.queue-close').blur();await document.fonts.ready;await settle()}
let keyboardSourceCount=0,keyboardPlayCount=0
window.prepareSourceKeyboard=async()=>{queue.value=tracks(4);queueIndex.value=1;await setOpen();await settle();const source=document.querySelector('.queue-item.active .queue-source');source.focus();keyboardSourceCount=sourceEvents.length;keyboardPlayCount=playEvents.length;expect(document.activeElement===source,'source is not a keyboard target')}
window.checkSourceKeyboard=()=>{expect(sourceEvents.length===keyboardSourceCount+1&&JSON.stringify(sourceEvents.at(-1))===JSON.stringify(origins[1]),'Enter does not emit the exact source origin');expect(playEvents.length===keyboardPlayCount,'source Enter plays the track')}
let selectionKeyboardPlayCount=0,menuEscapeOpener=null
window.prepareSelectionKeyboard=async()=>{queue.value=tracks(4);queueIndex.value=0;await setOpen();const body=row('entry-2').querySelector('.queue-track');body.click();await settle();body.focus();selectionKeyboardPlayCount=playEvents.length}
window.checkSelectionKeyboard=()=>{expect(playEvents.length===selectionKeyboardPlayCount+1&&playEvents.at(-1)==='entry-2'&&queueIndex.value===2,'native Enter does not play the selected queue occurrence exactly once')}
window.prepareQueueMenuEscape=async()=>{queue.value=tracks(4);queueIndex.value=0;await setOpen();menuEscapeOpener=await openGlobalMenu();expect(pendingNativeMenus.has(currentNativeMenu().requestId),'global menu did not open native action request')}
window.checkQueueMenuEscape=()=>{expect(panels.playlistOpen.value&&leftOpen.value,'native menu Escape closes a sidebar');expect(pendingNativeMenus.size===0,'Escape leaves the native menu request active');expect(document.activeElement===menuEscapeOpener,'menu Escape does not restore its opener')}
window.prepareNarrowSidebarPolicy=async()=>{configureLayout('classic');leftOpen.value=false;panels.closeFloatingPanels();await settle();window.__narrowPolicyEnabled=true;await setOpen();expect(document.querySelector('.queue-sidebar')&&leftOpen.value,'wide layout cannot open both sidebars')}
window.checkNarrowSidebarPolicy=async()=>{expect(leftOpen.value&&!panels.playlistOpen.value&&!document.querySelector('.queue-sidebar'),'shrinking a wide window leaves two overlapping sidebars');configureLayout('custom');document.documentElement.dataset.teShellNavigation='persistent';leftOpen.value=false;await settle();panels.togglePlaylist();await settle();const menu=document.querySelector('.side-menu');expect(menu.inert&&!menu.classList.contains('open')&&rect(menu).right<=0,'narrow persistent navigation stays visible after closing');expect(document.querySelector('.queue-sidebar'),'narrow queue cannot open beside closed persistent navigation');window.__narrowPolicyEnabled=false}
window.checkLargeFontSidebarPolicy=async()=>{window.__narrowPolicyEnabled=true;panels.closeFloatingPanels();leftOpen.value=false;configureLayout('custom');document.documentElement.dataset.teShellNavigation='persistent';document.documentElement.style.setProperty('--te-font-size-body','14px');await settle();expect(!document.querySelector('.side-menu').inert,'persistent navigation is unavailable while two normal-width panels fit');document.documentElement.style.setProperty('--te-font-size-body','28px');await settle();const menu=document.querySelector('.side-menu');expect(rect(menu).width>=448&&menu.inert&&rect(menu).right<=0,'large-font persistent navigation does not switch to toggle mode');leftOpen.value=true;await settle();document.querySelector('#queue-opener').click();await settle();expect(panels.playlistOpen.value&&!leftOpen.value&&menu.inert,'large-font queue opening leaves overlapping navigation');document.documentElement.style.setProperty('--te-font-size-body','14px');window.__narrowPolicyEnabled=false;await settle()}
window.prepareEscape=async()=>{configureLayout('classic');leftOpen.value=false;panels.closeFloatingPanels();await settle();leftOpen.value=true;await settle();document.querySelector('#queue-opener').focus();panels.togglePlaylist();await settle()}
window.checkFirstEscape=()=>{expect(!panels.playlistOpen.value&&leftOpen.value,'Escape closes more than the foremost sidebar');expect(document.activeElement===document.querySelector('#queue-opener'),'queue close does not restore its entry button')}
window.checkSecondEscape=()=>{expect(!leftOpen.value&&document.querySelector('.side-menu').inert,'second Escape leaves navigation active')}
window.checkForcedColorFallback=async()=>{await setOpen();for(const glass of [false,true]){liquid.value=glass;await settle();const panels=[...document.querySelectorAll('.side-menu,.queue-sidebar')],styles=panels.map(panel=>getComputedStyle(panel,glass?'::before':null));expect(styles[0].backgroundColor===styles[1].backgroundColor&&styles.every(style=>style.backdropFilter==='none'&&style.boxShadow==='none'),'forced-color sidebar materials differ');expect(getComputedStyle(panels[0]).borderTopColor===getComputedStyle(panels[1]).borderTopColor,'forced-color panel boundaries differ')}liquid.value=false;await settle()}
let nativeDialog=null,nativeCancelCount=0
window.prepareNativeModal=async()=>{configureLayout('classic');await setOpen();nativeDialog=document.createElement('dialog');nativeDialog.innerHTML='<button autofocus>原生对话框操作</button>';nativeDialog.addEventListener('cancel',()=>nativeCancelCount++);document.body.append(nativeDialog);nativeDialog.showModal();await settle();const externalEscape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});window.dispatchEvent(externalEscape);expect(!externalEscape.defaultPrevented&&leftOpen.value&&panels.playlistOpen.value,'sidebar captures Escape owned by a native modal');innerDismissOpen.value=true;await settle();const innerEscape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});window.dispatchEvent(innerEscape);await settle();expect(innerEscape.defaultPrevented&&!innerDismissOpen.value&&nativeDialog.open&&leftOpen.value&&panels.playlistOpen.value,'custom dismiss layer inside native modal does not close first')}
window.checkNativeModalEscape=()=>{expect(nativeCancelCount===1&&!nativeDialog.open&&leftOpen.value&&panels.playlistOpen.value,'native Escape closes a sidebar or misses the modal cancel');nativeDialog.remove();nativeDialog=null}
`
