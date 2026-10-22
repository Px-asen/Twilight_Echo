import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
test('settings wallpaper preserves home and control contrast across pointer, focus and search states', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-settings-overlay-'))
  try {
    const app = await readFile(resolve('src/renderer/src/App.vue'), 'utf8')
    const template = parse(app).descriptor.template!.content
    const overlayStart = template.lastIndexOf(
      '<div',
      template.indexOf('class="settings-overlay-root"')
    )
    const overlay = template.slice(
      overlayStart,
      template.indexOf('  <CommandPalette', overlayStart)
    )
    const lifecycle = app.slice(
      app.indexOf('const settingsOverlayLeaves ='),
      app.indexOf('const { pushNotice }')
    )
    const surfaceContextStart = app.indexOf(
      '[showSettingsPage, showPluginPage, showAppearancePage, appearanceFullWindowPreview]'
    )
    assert.notEqual(surfaceContextStart, -1, 'settings surface context watcher is missing')
    const surfaceContext = app.slice(
      app.lastIndexOf('watch(', surfaceContextStart),
      app.indexOf('watch(', surfaceContextStart)
    )
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(
      join(directory, 'Shell.vue'),
      `
<script setup lang="ts">
import {computed,ref,watch,defineComponent,h} from 'vue'
import BackgroundAppearanceCustomizer from '@renderer/components/BackgroundAppearanceCustomizer.vue'
import AppBackgroundLayer from '@renderer/components/AppBackgroundLayer.vue'
import BackgroundEditorSettings from '@renderer/components/settings-page/BackgroundEditorSettings.vue'
import '@renderer/components/LocalDashboard.css'
import '@renderer/components/settings-page/SettingsLayout.css'
import {appearanceFullWindowPreview,appearanceEditorOpen} from '@renderer/composables/appearanceEditorState.ts'
import {useAppNavigation} from '@renderer/app/useAppNavigation.ts'
const navigation=useAppNavigation({appearancePreviewActive:()=>appearanceFullWindowPreview.value})
window.overlayNavigation=navigation
const {showSettingsPage,showAppearancePage,showPluginPage,localViewVisible,settingsInitialSection,settingsNavigationTarget}=navigation
const appearancePageRetained=computed(()=>showAppearancePage.value),appearancePageRef=ref(null),appearanceNavigationTarget=ref({revision:0}),navigationPages=[]
const closeAppearancePage=()=>navigation.closeAppearancePage(),openAppearancePage=()=>navigation.openAppearancePage()
${lifecycle}
${surfaceContext}
const noop=()=>{}
const openEqualizerPage=noop,openDspRackPage=noop,openThemeStudioPage=noop,openThemeWorkshop=noop,handleReopenOnboarding=noop,onSelectPluginPage=noop
const SettingsPage=defineComponent({render:()=>h('section',{class:'settings-preview-page','data-settings-layout':'categories'},[
 h('div',{class:'page-marker settings-marker'}),
 h('div',{class:'setting-copy'},h('strong',{id:'wallpaper-label'},'外观设置')),
 h('select',{class:'preview-select'},h('option','跟随主题')),
 h('button',{class:'preview-nav-item active'},'外观'),
 h(BackgroundEditorSettings,{class:'hover-row','data-setting-id':'background'}),
 h('div',{class:'painted-settings'},[
  h('div',{class:'dsp-meter'},[h('span','INPUT'),h('strong','待命'),h('small','源信号格式')]),
  h('div',{class:'signal-node-circle'},h('i','↔')),
  h('button',{class:'preset-btn'},'DSP 旁路'),
  h('button',{class:'brand-soft-button'},'打开均衡器'),
  h('div',{class:'path-control'},h('input',{value:'音乐库目录'})),
  h('div',{class:'segmented-control'},[h('button',{class:'active'},'标准'),h('button','详细')]),
  h('div',{class:'dsp-module-card'},h('div',{class:'mini-setting'},h('div',[h('strong','透明设置项'),h('span','跟随背景图')]))),
  h('textarea',{class:'diagnostic-note',value:'描述刚刚发生的问题'})
 ])
])})
const PluginPage=defineComponent({render:()=>h('section',{class:'settings-preview-page'},h('div',{class:'page-marker plugin-marker'}))})
</script>
<template><AppBackgroundLayer page="local"/><div class="app-shell"><div class="app-shell-content"><main class="main-content"><article v-if="localViewVisible" class="home"><div class="page-marker home-marker"/><section class="feature-card"><div class="feature-backdrop" aria-hidden="true"><img src="background://wallpaper.png" alt=""/></div><div class="hero-inner"><div class="hero-copy"><h2 class="hero-title">Ether Strike</h2><p class="hero-artist">Akira Complex</p><p class="hero-meta">Hypersynthetic · 44kHz</p></div><div class="hero-art"><div class="hero-art-frame"><img src="background://wallpaper.png" alt="封面"/></div></div></div></section><button class="block-more">查看更多</button><div class="route-stage is-bypassed" style="position:absolute;left:800px;top:430px"><div class="route-stage-copy"><small>EQ</small><strong>旁路</strong></div></div><span class="dsp-state" style="position:absolute;left:800px;top:510px">等待播放</span></article></main></div></div>${overlay}<BackgroundAppearanceCustomizer v-if="appearanceEditorOpen"/></template>`
    )
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [vue()],
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: {
        alias: {
          '/icon.png': resolve('resources/icon.png'),
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'OverlayTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    const styles = parse(app)
      .descriptor.styles.map((style) => style.content)
      .join('\n')
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<style>${styles}
body{margin:0}.home{height:100%}.page-marker{width:100px;height:70px;position:absolute;left:360px;top:160px}.home-marker{background:rgb(210,30,60)}.settings-marker{background:rgb(30,180,90)}.plugin-marker{background:rgb(60,90,210)}.settings-preview-page>.setting-copy{margin-left:300px}.hover-row{margin-top:280px}.settings-page-enter-active,.settings-page-leave-active{transition-duration:60ms!important}.feature-card{position:absolute;left:30px;top:310px;width:720px}.block-more{position:absolute;left:800px;top:340px}.painted-settings{position:absolute;left:530px;right:30px;top:55px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.diagnostic-note{background:var(--te-settings-control-bg);color:var(--te-settings-text)}
</style></head><body class="te-local-surface"><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90_000, env }
    )
    assert.match(result.stdout, /SETTINGS_OVERLAY_OK/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-settings-overlay-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `const {app,BrowserWindow,protocol,nativeImage}=require('electron'),path=require('node:path');
protocol.registerSchemesAsPrivileged([{scheme:'background',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-color-profile','srgb');
app.whenReady().then(async()=>{
 const bytes=Buffer.alloc(64*64*4);for(let i=0;i<bytes.length;i+=4){bytes[i]=40;bytes[i+1]=25;bytes[i+2]=15;bytes[i+3]=255}
 protocol.handle('background',request=>{const bitmap=Buffer.from(bytes);if(new URL(request.url).hostname==='bright.png')for(let i=0;i<bitmap.length;i+=4){bitmap[i]=bitmap[i+1]=bitmap[i+2]=245}return new Response(nativeImage.createFromBitmap(bitmap,{width:64,height:64}).toPNG(),{headers:{'content-type':'image/png','Access-Control-Allow-Origin':'*'}})});
 const win=new BrowserWindow({show:false,frame:false,width:1100,height:800,useContentSize:true,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)});
 const js=source=>win.webContents.executeJavaScript('(async()=>{try{return await ('+source+')}catch(error){console.error(error.stack);throw error}})()');
 const pixel=async(selector,expected)=>{
   const point=await js('window.markerPoint('+JSON.stringify(selector)+')');
   const image=await win.webContents.capturePage({x:Math.round(point.x),y:Math.round(point.y),width:1,height:1});
   const actual=[...image.toBitmap()].slice(0,3);
   if(actual.some((value,index)=>Math.abs(value-expected[index])>3)){
     const details=await js('window.markerDetails('+JSON.stringify(selector)+')');
     throw Error(selector+' is obscured by wallpaper: '+actual+' '+JSON.stringify(details));
   }
 };
 const rowContrast=async state=>{
   const point=await js('window.rowBackgroundPoint()');
   const image=await win.webContents.capturePage({x:Math.round(point.x),y:Math.round(point.y),width:1,height:1});
   const [blue,green,red]=image.toBitmap();
   await js('window.checkRowContrast('+JSON.stringify(state)+','+JSON.stringify('rgb('+red+','+green+','+blue+')')+')');
 };
 const surfaceContrast=async(selector,labels)=>{
   const point=await js('window.surfacePoint('+JSON.stringify(selector)+')');
   const image=await win.webContents.capturePage({x:Math.round(point.x),y:Math.round(point.y),width:1,height:1});
   const [blue,green,red]=image.toBitmap();
   await js('window.checkPaintedSurface('+JSON.stringify(selector)+','+JSON.stringify(labels)+','+JSON.stringify('rgb('+red+','+green+','+blue+')')+')');
 };
 try{
  await win.loadFile(process.argv.at(-1));await js('window.startOverlayTest()');
  for(const tone of ['pureWhite','dark'])for(const material of ['standard','transparent','liquidGlass'])for(const text of ['light','dark']){
   await js('window.prepareOverlay('+JSON.stringify(tone)+','+JSON.stringify(material)+','+JSON.stringify(text)+')');
   await pixel('.home-marker',[60,30,210]);
   // Manual text choices can intentionally disagree with the dark fixture image.
   if(material!=='transparent'||text==='light')await surfaceContrast('.feature-card',['.hero-title','.hero-artist','.hero-meta']);
   await surfaceContrast('.block-more',['']);
   await surfaceContrast('.route-stage',['small','strong']);
   await surfaceContrast('.dsp-state',['']);
   await js('window.checkHeroLayers()');
   await js('window.showSettings()');await pixel('.settings-marker',[90,180,30]);await js('window.checkSurfaceContrast()');
   for(const [selector,labels] of [['.dsp-meter',['strong','small']],['.signal-node-circle',['i']],['.preset-btn',['']],['.path-control input',['']],['.segmented-control',['button.active','button:not(.active)']],['.diagnostic-note',['']]])await surfaceContrast(selector,labels);
   await surfaceContrast('.brand-soft-button',['']);
   await js('window.checkWallpaperControl()');
   await js('window.checkFlattenedPanel()');
   win.webContents.sendInputEvent({type:'mouseMove',x:1050,y:20});
   await js('window.waitOverlay()');await js('window.checkIdleRow()');
   const row=await js('window.hoverPoint()');win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(row.x),y:Math.round(row.y)});
   await js('window.waitOverlay()');await rowContrast('hover');
   await js('document.querySelector(".appearance-entry").focus()');
   win.webContents.sendInputEvent({type:'mouseMove',x:1050,y:20});
   await js('window.waitOverlay()');await rowContrast('focus');
   await js('window.flashRow()');await rowContrast('search');
   await js('window.clearRowFlash()');await js('window.checkIdleRow()');
   await js('window.closeSettingsDuringFade()');await js('window.waitOverlay()');await pixel('.home-marker',[60,30,210]);
  }
  for(const tone of ['pureWhite','dark'])for(const text of ['light','dark']){
   await js('window.prepareColorSettings('+JSON.stringify(tone)+','+JSON.stringify(text)+')');
   await surfaceContrast('.brand-soft-button',['']);
   await js('window.closeSettingsDuringFade()');await js('window.waitOverlay()');
  }
  await js('window.runAutomaticRecipe()');await pixel('.home-marker',[60,30,210]);
  await js('window.returnFromPreview()');await pixel('.settings-marker',[90,180,30]);await js('window.checkSurfaceContrast()');
  await js('window.saveAutomaticRecipe()');await pixel('.home-marker',[60,30,210]);
  for(const tone of ['pureWhite','dark']){
   await js('window.runBrightRecipe('+JSON.stringify(tone)+')');
   await surfaceContrast('.feature-card',['.hero-title','.hero-artist','.hero-meta']);
   await js('window.checkHeroLayers()');
   await js('window.saveBrightRecipe()');
  }
  await js('window.showPlugin()');await pixel('.plugin-marker',[210,90,60]);
  await js('window.closePlugin()');await pixel('.home-marker',[60,30,210]);
  await js('window.interruptOverlayFade()');await pixel('.home-marker',[60,30,210]);
  console.log('SETTINGS_OVERLAY_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});`

const runtime = `
import {createApp,nextTick} from 'vue'
import Shell from './Shell.vue'
import '@renderer/assets/main.css'
import '@renderer/components/settings-page/SettingsPage.css'
import {useSettingsStore} from '@renderer/stores/useSettingsStore.ts'
import {bootstrapThemeRuntime,useThemeStore,previewAppearance} from '@renderer/stores/useThemeStore.ts'
import {appearanceFullWindowPreview,openAppearanceEditor} from '@renderer/composables/appearanceEditorState.ts'
import {cloneAppearance,normalizeAppBackgroundSettings} from '@shared/appAppearance.ts'
import {createDefaultThemeLibraryDocument,themeContrastRatio} from '@shared/theme.ts'
const expect=(value,message)=>{if(!value)throw Error(message)}
const store=useSettingsStore(),theme=useThemeStore()
let confirmed={...store.settings.value,motionPreference:'full',theme:'pureWhite',appBackground:normalizeAppBackgroundSettings({global:{kind:'image',image:'background://wallpaper.png'}})}
const snapshot=()=>({settings:confirmed,defaults:confirmed,paths:{},appVersion:'test',platform:'win32',restartReasons:[],windowTransparencySupported:false})
const startup=()=>({settings:snapshot(),systemTone:'pureWhite',pendingNavigation:null,themeBootstrap:{library:{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}}})
window.api={settings:{onChanged:()=>()=>{},update:async patch=>{confirmed={...confirmed,...patch};return snapshot()},importBackgroundImage:async()=> 'background://wallpaper.png'},themes:{onChanged:()=>()=>{},onSystemToneChanged:()=>()=>{}},plugins:{onChanged:()=>()=>{}}}
createApp(Shell).mount('#app')
const wait=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,160));await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame)}
window.waitOverlay=wait
window.startOverlayTest=async()=>{store.hydrateStartupSnapshot(startup());await bootstrapThemeRuntime(startup());await wait()}
window.markerPoint=selector=>{const rect=document.querySelector(selector)?.getBoundingClientRect();expect(rect?.width>0,'missing foreground '+selector);return{x:rect.left+rect.width/2,y:rect.top+rect.height/2}}
window.markerDetails=selector=>{const marker=document.querySelector(selector),rect=marker.getBoundingClientRect();return{ancestors:[marker,...(function*(el){while(el=el.parentElement)yield el})(marker)].map(el=>({class:el.className,opacity:getComputedStyle(el).opacity,filter:getComputedStyle(el).filter,background:getComputedStyle(el).backgroundColor,zIndex:getComputedStyle(el).zIndex})),layers:document.elementsFromPoint(rect.left+rect.width/2,rect.top+rect.height/2).map(el=>el.className)}}
window.prepareOverlay=async(tone,material,text)=>{const draft=cloneAppearance(confirmed);draft.surfaceMaterial=material;for(const mode of ['light','dark'])draft.appBackground.global.effects[mode].textTone=text;await theme.setPreviewTone(tone);await previewAppearance(draft);await wait()}
window.showSettings=async()=>{window.overlayNavigation.openSettingsPage();await wait();await Promise.allSettled(document.querySelector('.settings-preview-page').getAnimations().map(animation=>animation.finished))}
window.closeSettingsDuringFade=async()=>{window.overlayNavigation.closeSettingsPage();await nextTick();expect(getComputedStyle(document.querySelector('.settings-overlay-root')).display!=='none','overlay disappeared before leave completed');expect(document.querySelector('.settings-overlay-root').classList.contains('settings-overlay-root--active'),'leaving wallpaper escaped its containing block')}
const checkContrast=selector=>{const el=document.querySelector(selector),styles=getComputedStyle(el);expect((themeContrastRatio(styles.color,styles.backgroundColor,document.documentElement.dataset.theme==='dark'?'#17181a':'#ffffff')??0)>=4.5,'unreadable surface '+selector+': '+styles.color+' / '+styles.backgroundColor)}
window.checkSurfaceContrast=()=>{for(const selector of ['.preview-select','.preview-nav-item.active','.appearance-entry'])checkContrast(selector);expect(getComputedStyle(document.querySelector('#wallpaper-label')).color===getComputedStyle(document.querySelector('.settings-preview-page')).color,'wallpaper label stopped following background text')}
window.surfacePoint=selector=>{const rect=document.querySelector(selector).getBoundingClientRect();return{x:rect.left+8,y:rect.top+rect.height/2}}
window.checkPaintedSurface=(selector,labels,background)=>{
 const surface=document.querySelector(selector),canvas=document.createElement('canvas'),context=canvas.getContext('2d'),root=document.documentElement,styles=getComputedStyle(surface);
 const detail=JSON.stringify({theme:root.dataset.theme,material:root.dataset.teSurfaceMaterial,text:root.dataset.teSettingsTextTone,body:document.body.className,paint:styles.backgroundColor,settingsText:styles.getPropertyValue('--te-settings-text'),accentText:styles.getPropertyValue('--te-control-accent-text')});
 for(const label of labels){const el=label?surface.querySelector(label):surface;context.clearRect(0,0,1,1);context.fillStyle=getComputedStyle(el).color;context.fillRect(0,0,1,1);const [r,g,b,a]=context.getImageData(0,0,1,1).data;const color='rgba('+r+','+g+','+b+','+a/255+')';expect((themeContrastRatio(color,background)??0)>=4.5,'unreadable surface '+selector+' '+label+': '+color+' / '+background+' '+detail)}
}
window.checkHeroLayers=()=>{expect(document.querySelector('.hero-art-frame img').checkVisibility(),'front cover disappeared');if(document.documentElement.dataset.teSurfaceMaterial==='transparent')expect(getComputedStyle(document.querySelector('.feature-backdrop')).display==='none','transparent hero still paints a theme gradient over the wallpaper')}
window.checkFlattenedPanel=()=>{const page=getComputedStyle(document.querySelector('.settings-preview-page')),label=getComputedStyle(document.querySelector('.dsp-module-card strong'));expect(label.getPropertyValue('--te-settings-text')===page.getPropertyValue('--te-settings-text'),'flattened DSP panel stopped following wallpaper text')}
window.checkWallpaperControl=()=>{const button=getComputedStyle(document.querySelector('.brand-soft-button')),page=getComputedStyle(document.querySelector('.settings-preview-page')),reading=document.querySelector('.app-background-layer--reading[data-background-page="settings"][data-background-image-state="ready"]');expect(button.getPropertyValue('--te-control-accent-text')===(reading?button.getPropertyValue('--te-overlay-settings-text'):page.getPropertyValue('--te-settings-text')),'tinted accent button stopped following its painted settings surface')}
window.prepareColorSettings=async(tone,text)=>{await theme.setPreviewTone(tone);const draft=cloneAppearance(confirmed);draft.surfaceMaterial='transparent';draft.appBackground.global.kind='color';for(const mode of ['light','dark']){draft.appBackground.global[mode]=text==='light'?'#14202f':'#f0f3f8';draft.appBackground.global.effects[mode].textTone=text}await previewAppearance(draft);await wait();window.overlayNavigation.openSettingsPage();await wait()}
window.hoverPoint=()=>{const rect=document.querySelector('.hover-row').getBoundingClientRect();return{x:rect.left+5,y:rect.top+5}}
window.rowBackgroundPoint=()=>{const rect=document.querySelector('.hover-row').getBoundingClientRect();return{x:rect.left+8,y:rect.top+rect.height/2}}
window.checkIdleRow=()=>{
 const row=document.querySelector('.hover-row'),page=getComputedStyle(document.querySelector('.settings-preview-page'));
 expect(!row.matches(':hover')&&!row.matches(':focus-within')&&!row.classList.contains('search-target-flash'),'idle row state not exercised');
 const background=getComputedStyle(row).backgroundColor,canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.fillStyle=background;context.fillRect(0,0,1,1);
 expect(context.getImageData(0,0,1,1).data[3]===0,'idle row lost its transparent background: '+background);
 for(const [selector,token] of [['strong','--te-settings-text'],['span','--te-settings-text-muted']])expect(getComputedStyle(row.querySelector('.setting-copy>'+selector)).getPropertyValue(token)===page.getPropertyValue(token),'idle row stopped following wallpaper '+selector)
}
window.checkRowContrast=(state,background)=>{
 const row=document.querySelector('.hover-row');
 expect(state==='hover'?row.matches(':hover'):!row.matches(':hover'),'pointer state not exercised: '+state);
 expect(state==='focus'?row.matches(':focus-within'):!row.matches(':focus-within'),'focus state not exercised: '+state);
 expect(row.classList.contains('search-target-flash')===(state==='search'),'search state not exercised: '+state);
 for(const selector of ['strong','span']){const color=getComputedStyle(row.querySelector('.setting-copy>'+selector)).color;expect((themeContrastRatio(color,background)??0)>=4.5,'unreadable '+state+' row '+selector+': '+color+' / '+background)}
}
window.flashRow=async()=>{document.activeElement.blur();document.querySelector('.hover-row').classList.add('search-target-flash');await wait()}
window.clearRowFlash=async()=>{const row=document.querySelector('.hover-row');row.classList.remove('search-target-flash');await wait();await Promise.allSettled(row.getAnimations().map(animation=>animation.finished))}
const click=label=>{const button=[...document.querySelectorAll('.appearance-editor button,.appearance-full-preview-toolbar button')].find(el=>el.textContent.trim()===label&&el.checkVisibility());expect(button,'missing button '+label);button.click()}
window.runAutomaticRecipe=async()=>{
 await store.updateSettings({cardAppearance:{...store.settings.value.cardAppearance,enabled:true},liquidGlass:{...store.settings.value.liquidGlass,navigationEnabled:true,playbarEnabled:true,settingsNavigationEnabled:true,homeCards:{...store.settings.value.liquidGlass.homeCards,enabled:true}}});
 await previewAppearance(null);await theme.setPreviewTone('pureWhite');window.overlayNavigation.openSettingsPage();await wait();openAppearanceEditor();await wait();click('图片');await wait();
 const file=document.querySelector('input[type=file]');Object.defineProperty(file,'files',{configurable:true,value:[new File(['image'],'sample.png',{type:'image/png'})]});file.dispatchEvent(new Event('change',{bubbles:true}));await wait();
 click('图片通透推荐搭配');await wait();click('全窗口预览');await wait();expect(appearanceFullWindowPreview.value,'automatic preview did not start');expect(getComputedStyle(document.querySelector('.settings-overlay-root')).display==='none','preview covered home')
}
window.returnFromPreview=async()=>{click('返回编辑');await wait();click('保存并使用');await wait();expect(store.settings.value.surfaceMaterial==='transparent','automatic recipe did not persist');expect(!store.settings.value.cardAppearance.enabled&&!store.settings.value.liquidGlass.homeCards.enabled&&!store.settings.value.liquidGlass.navigationEnabled&&!store.settings.value.liquidGlass.playbarEnabled&&!store.settings.value.liquidGlass.settingsNavigationEnabled,'automatic recipe retained previous card or glass layers');expect(store.settings.value.appBackground.global.effects.light.textTone==='light','dark image was not analyzed');expect(store.settings.value.appBackground.global.effects.light.dim===0,'dark image got an unnecessary mask')}
window.saveAutomaticRecipe=async()=>{window.overlayNavigation.closeSettingsPage();await wait();expect(getComputedStyle(document.querySelector('.settings-overlay-root')).display==='none','saved settings covered home')}
window.runBrightRecipe=async tone=>{const backgrounds=normalizeAppBackgroundSettings(store.settings.value.appBackground);backgrounds.global.kind='image';backgrounds.global.image='background://bright.png';await store.updateSettings({theme:tone,appBackground:backgrounds});await theme.setPreviewTone(tone);await wait();window.overlayNavigation.openSettingsPage();await wait();openAppearanceEditor();await wait();click('图片通透推荐搭配');await wait();click('全窗口预览');await wait()}
window.saveBrightRecipe=async()=>{click('返回编辑');await wait();click('保存并使用');await wait();const tone=document.documentElement.dataset.theme==='dark'?'dark':'light';expect(store.settings.value.appBackground.global.effects[tone].textTone==='dark'&&store.settings.value.appBackground.global.effects[tone].dim===0,'bright image recipe did not preserve unmasked dark text');window.overlayNavigation.closeSettingsPage();await wait()}
window.showPlugin=async()=>{window.overlayNavigation.openPluginPage();await wait()}
window.closePlugin=async()=>{window.overlayNavigation.hidePluginPage();await wait()}
window.interruptOverlayFade=async()=>{for(let i=0;i<4;i++){window.overlayNavigation.openSettingsPage();await wait();window.overlayNavigation.closeSettingsPage();await nextTick();window.overlayNavigation.openSettingsPage();await nextTick()}await wait();window.overlayNavigation.closeSettingsPage();await wait();expect(getComputedStyle(document.querySelector('.settings-overlay-root')).display==='none','interrupted leave leaked the overlay')}
`
