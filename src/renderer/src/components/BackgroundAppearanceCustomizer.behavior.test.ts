import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { compileStyle, parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)
test('appearance editor renders reversible drafts and wallpapers across tones, pages and materials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-appearance-'))
  try {
    const stylePaths = [
      'src/renderer/src/components/SideMenu.vue',
      'src/renderer/src/components/TitleBar.vue',
      'src/renderer/src/components/PlayingMusic.vue',
      'src/renderer/src/App.vue',
      'src/renderer/src/components/player-bar/PlayerBar.css',
      'src/renderer/src/components/LocalDashboard.css',
      'src/renderer/src/components/song-list/SongList.css',
      'src/renderer/src/components/streaming-page/StreamingPage.css',
      'src/renderer/src/components/settings-page/SettingsPage.css'
    ]
    const styles = await Promise.all(
      stylePaths.map(async (path) => {
        const source = await readFile(resolve(path), 'utf8')
        const css = path.endsWith('.vue')
          ? parse(source)
              .descriptor.styles.map((style) => style.content)
              .join('\n')
          : source
        const compiled = compileStyle({
          source: css,
          filename: path,
          id: 'data-v-fixture',
          scoped: true
        })
        assert.deepEqual(compiled.errors, [])
        return compiled.code
      })
    )
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [
        {
          name: 'modal-preview-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (source.endsWith('AppearanceWindowPreview.vue')) return '\0modal-window'
            if (
              source.endsWith('/stores/useThemeStore.ts') &&
              importer?.endsWith('/composables/useBackgroundAppearanceEditor.ts')
            )
              return '\0measured-appearance-preview'
            return null
          },
          load(id) {
            if (id === '\0modal-window')
              return `import {ref,h} from 'vue';export default {setup(_,ctx){const navigationExpanded=ref(true);ctx.expose({navigationExpanded,toggleNavigation:()=>{navigationExpanded.value=!navigationExpanded.value}});return()=>h('div',{class:'appearance-window-preview',style:{position:'relative',height:'100%',width:'100%'}},[h('div',{class:'fixture-context-anchor',style:{position:'absolute',top:'12px',right:'12px',maxWidth:'calc(100% - 24px)'}},ctx.slots['context-tools']?.())])}}`
            if (id === '\0measured-appearance-preview')
              return `export {useThemeStore} from '@renderer/stores/useThemeStore.ts';import {previewAppearance as preview} from '@renderer/stores/useThemeStore.ts';import {cloneAppearance} from '@shared/appAppearance.ts';export async function previewAppearance(draft){window.previewRequests.push(draft?cloneAppearance(draft):null);if(draft&&window.failPreview)throw Error('预览失败示例');await preview(draft)}`
            return null
          }
        },
        vue()
      ],
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          'primeicons/primeicons.css': require.resolve('primeicons/primeicons.css')
        }
      },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'AppearanceTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>${styles.join('\n')}body{margin:0}.fixture-content{position:absolute;left:280px;top:80px;color:var(--te-neutral-900)}.fixture-tile{width:240px;height:160px;padding:20px;box-sizing:border-box}.fixture-settings{position:fixed;inset:0;z-index:2000;isolation:isolate;background:var(--te-settings-bg)}.fixture-settings>.app-background-layer{z-index:-1}.fixture-player{isolation:isolate;z-index:1100}.fixture-player>.app-background-layer{z-index:-1}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90_000 }
    )
    assert.match(result.stdout, /APPEARANCE_OK/)
    assert.match(result.stdout, /APPEARANCE_IMAGE_BUSY_OK/)
    assert.match(result.stdout, /APPEARANCE_TONE_OK/)
    assert.match(result.stdout, /APPEARANCE_IMAGE_PALETTE_OK/)
    assert.match(result.stdout, /APPEARANCE_BACKGROUND_OWNERSHIP_OK/)
    assert.match(result.stdout, /APPEARANCE_LEGACY_BACKGROUND_BASELINE_OK/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-appearance-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `
const {app,BrowserWindow,protocol,nativeImage}=require('electron'),fs=require('node:fs'),path=require('node:path');
protocol.registerSchemesAsPrivileged(['background','theme-asset'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}})));
app.setPath('userData',path.join(__dirname,'profile'));
app.commandLine.appendSwitch('force-color-profile','srgb');
app.whenReady().then(async()=>{
 const bytes=Buffer.alloc(1280*800*4);
 for(let y=0;y<800;y++)for(let x=0;x<1280;x++){const offset=(y*1280+x)*4;bytes[offset]=90;bytes[offset+1]=60;bytes[offset+2]=40;bytes[offset+3]=255}
 const wallpaper=nativeImage.createFromBitmap(bytes,{width:1280,height:800}).toPNG();
 protocol.handle('background',request=>request.url.includes('missing')?new Response('',{status:404}):new Response(wallpaper,{headers:{'content-type':'image/png','Access-Control-Allow-Origin':'*'}}));
 const themeBytes=Buffer.alloc(32*32*4);for(let index=0;index<themeBytes.length;index+=4){themeBytes[index]=68;themeBytes[index+1]=126;themeBytes[index+2]=174;themeBytes[index+3]=255}
 const themeWallpaper=nativeImage.createFromBitmap(themeBytes,{width:32,height:32}).toPNG();
 protocol.handle('theme-asset',()=>new Response(themeWallpaper,{headers:{'content-type':'image/png','Access-Control-Allow-Origin':'*'}}));
 // Pixel samples use content coordinates; native Windows borders must not shrink the viewport.
 const win=new BrowserWindow({show:false,width:1280,height:820,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 // Keep crop coordinates in CSS pixels regardless of the Windows display scale.
 const capture=async()=>nativeImage.createFromBuffer(Buffer.from((await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true})).data,'base64'));
 const capturePixel=async point=>{
  const image=await capture();
  const size=image.getSize();
  const viewport=await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
  if(point.x+point.width>viewport.width||point.y+point.height>viewport.height)throw new Error('pixel sample lies outside the CSS viewport: '+JSON.stringify(viewport));
  // On Windows, capturePage bitmap pixels can differ from CSS coordinates even when devicePixelRatio is 1.
  const ratioX=size.width/viewport.width,ratioY=size.height/viewport.height;
  const pixel=image.crop({x:Math.round(point.x*ratioX),y:Math.round(point.y*ratioY),width:Math.max(1,Math.round(point.width*ratioX)),height:Math.max(1,Math.round(point.height*ratioY))}).toBitmap();
  if(pixel.length<4)throw new Error('pixel sample is empty');
  return pixel;
 };
 const referencePixel=async rgb=>{
  await win.webContents.executeJavaScript('window.setAppearancePixelReference('+JSON.stringify(rgb)+')');
  return capturePixel({x:4,y:4,width:1,height:1});
 };
 try{
  await win.loadFile(process.argv.at(-1));
  win.webContents.debugger.attach('1.3');
  await win.webContents.executeJavaScript('window.runAppearanceTests()');
  // capturePage can apply a display color transform even with an sRGB PNG.
  // Compare to the same window's mathematical CSS result, keeping channel tolerance unchanged.
  const expectedWallpaper=await referencePixel([40,60,90].map(channel=>Math.round(channel*0.8*0.6)));
  for(const page of ['local','streaming','player','settings'])for(const blur of [0,30]){
   await win.webContents.executeJavaScript('window.prepareAppearancePixels('+JSON.stringify(page)+','+blur+')');
   const viewport=await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
   // Windows runners can clamp a hidden window to their smaller virtual display.
   for(const point of [{x:600,y:400,width:1,height:1},{x:viewport.width-10,y:400,width:1,height:1}]){
    const pixel=await capturePixel(point);
    if([0,1,2].some(channel=>Math.abs(pixel[channel]-expectedWallpaper[channel])>3))throw new Error(page+' background brightness/dim or blur edge mismatch: '+[...pixel]+' expected '+[...expectedWallpaper]);
   }
  }
  await win.webContents.executeJavaScript('window.prepareMissingBackground()');
  const expectedFallback=await referencePixel([0x12,0x34,0x56]);
  const fallback=await capturePixel({x:600,y:400,width:1,height:1});
  // Full-frame capture may round color channels; use the same tolerance as wallpaper samples.
  if([0,1,2].some(channel=>Math.abs(fallback[channel]-expectedFallback[channel])>3))throw new Error('missing image did not fall back to solid color: '+[...fallback]+' expected '+[...expectedFallback]);
  if(process.env.TWILIGHT_APPEARANCE_EVIDENCE_DIR){fs.mkdirSync(process.env.TWILIGHT_APPEARANCE_EVIDENCE_DIR,{recursive:true});for(const tone of ['pureWhite','dark']){await win.webContents.executeJavaScript('window.showAppearanceEvidence('+JSON.stringify(tone)+')');fs.writeFileSync(path.join(process.env.TWILIGHT_APPEARANCE_EVIDENCE_DIR,'appearance-'+tone+'.png'),(await win.webContents.capturePage()).toPNG())}win.setContentSize(620,820);await win.webContents.executeJavaScript('window.settleAppearance()');if(await win.webContents.executeJavaScript('document.querySelector(".appearance-editor").scrollWidth>document.querySelector(".appearance-editor").clientWidth+1'))throw new Error('narrow editor overflows');fs.writeFileSync(path.join(process.env.TWILIGHT_APPEARANCE_EVIDENCE_DIR,'appearance-narrow.png'),(await win.webContents.capturePage()).toPNG())}
  await win.webContents.executeJavaScript('window.runCharacterTests()');
  console.log('APPEARANCE_IMAGE_BUSY_OK');
  await win.webContents.executeJavaScript('window.runPreviewPerformanceTests()');
  await win.webContents.executeJavaScript('window.runAppearanceToneTests()');
  console.log('APPEARANCE_TONE_OK');
  await win.webContents.executeJavaScript('window.runImagePaletteTests()');
  console.log('APPEARANCE_IMAGE_PALETTE_OK');
  const evidenceDirectory=process.env.TWILIGHT_BACKGROUND_EVIDENCE_DIR,ownership=[],ownershipFailures=[];
  if(evidenceDirectory)fs.mkdirSync(evidenceDirectory,{recursive:true});
  const checkOwnership=async report=>{
   const expected=await referencePixel(report.expectedRgb),pixel=await capturePixel({x:600,y:400,width:1,height:1});
   const matches=[0,1,2].every(channel=>Math.abs(pixel[channel]-expected[channel])<=3),result={...report,pixel:[...pixel.subarray(0,4)],expected:[...expected.subarray(0,4)],matches};ownership.push(result);
   if(evidenceDirectory){fs.writeFileSync(path.join(evidenceDirectory,'ownership-'+report.id+'.png'),(await win.webContents.capturePage()).toPNG());fs.writeFileSync(path.join(evidenceDirectory,'ownership-pixels.json'),JSON.stringify(ownership,null,2))}
   if(!matches)ownershipFailures.push(report.id+': '+result.pixel+' expected '+result.expected);
  };
  const ownershipCases=await win.webContents.executeJavaScript('window.beginBackgroundOwnershipTests()');
  for(let index=0;index<ownershipCases;index++)await checkOwnership(await win.webContents.executeJavaScript('window.prepareBackgroundOwnershipCase('+index+')'));
  await checkOwnership(await win.webContents.executeJavaScript('window.prepareBackgroundCancelPreview()'));
  await checkOwnership(await win.webContents.executeJavaScript('window.cancelBackgroundOwnershipPreview()'));
  await win.webContents.executeJavaScript('window.finishBackgroundOwnershipTests()');
  const legacyCases=await win.webContents.executeJavaScript('window.beginLegacyBackgroundTests()');
  for(let index=0;index<legacyCases;index++)await checkOwnership(await win.webContents.executeJavaScript('window.prepareLegacyBackgroundCase('+index+')'));
  await win.webContents.executeJavaScript('window.finishLegacyBackgroundTests()');
  if(ownershipFailures.length)throw Error('background ownership pixel mismatch: '+ownershipFailures.join('; '));
  console.log('APPEARANCE_BACKGROUND_OWNERSHIP_OK '+ownership.length);
  console.log('APPEARANCE_LEGACY_BACKGROUND_BASELINE_OK '+legacyCases);
  console.log('APPEARANCE_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})
`

const runtime = `
import {createApp,h,nextTick,ref} from 'vue'
import Editor from '@renderer/components/BackgroundAppearanceCustomizer.vue'
import Background from '@renderer/components/AppBackgroundLayer.vue'
import '@renderer/assets/base.css'
import '@renderer/assets/materials.css'
import '@renderer/assets/appearance.css'
import 'primeicons/primeicons.css'
import {useSettingsStore} from '@renderer/stores/useSettingsStore.ts'
import {bootstrapThemeRuntime,useThemeStore,syncThemeSettingsAppearance,previewAppearance} from '@renderer/stores/useThemeStore.ts'
import {appearanceEditorOpen,appearanceFullWindowPreview,openAppearanceEditor} from '@renderer/composables/appearanceEditorState.ts'
import {useBackgroundAppearanceEditor} from '@renderer/composables/useBackgroundAppearanceEditor.ts'
import {useAppearanceHistory} from '@renderer/composables/useAppearanceHistory.ts'
import {applyAppearancePreset,cloneAppearance,defaultCardAppearance,normalizeAppBackgroundSettings,cardCssVariables,resolveBackgroundPalette,backgroundEffect} from '@shared/appAppearance.ts'
import {createDefaultThemeLibraryDocument,themeContrastRatio} from '@shared/theme.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const settle=async()=>{await nextTick();for(let i=0;i<4;i++)await new Promise(resolve=>requestAnimationFrame(resolve))}
window.settleAppearance=settle
const page=ref('local'),writes=[],settingsListeners=new Set();let failSave=false,failImport=false
let legacyThemes=[],legacyStyles={};
window.previewRequests=[]
window.api={settings:{onChanged:listener=>{settingsListeners.add(listener);return()=>settingsListeners.delete(listener)},update:async patch=>{if(failSave)throw new Error('保存失败示例');writes.push(patch);confirmed={...confirmed,...patch};const result=snapshot();for(const listener of settingsListeners)listener(result);return result},importBackgroundImage:async()=> {if(failImport)throw new Error('图片导入失败示例');return 'background://wallpaper.png'}},themes:{onChanged:()=>()=>{},onSystemToneChanged:()=>()=>{},validateAssets:async()=>true},plugins:{onChanged:()=>()=>{},onNotice:()=>()=>{}},extensions:{list:async()=>[{pluginId:'background-legacy',ui:[],themes:legacyThemes}],readThemeStylesheet:async path=>legacyStyles[path]}}
const settingsStore=useSettingsStore(),theme=useThemeStore()
let confirmed={...settingsStore.settings.value,theme:'dark',appBackground:normalizeAppBackgroundSettings({global:{kind:'image',image:'background://wallpaper.png'}}),cardAppearance:defaultCardAppearance(),surfaceMaterial:'standard'}
const snapshot=()=>({settings:confirmed,defaults:confirmed,paths:{},appVersion:'test',platform:'win32',windowTransparencySupported:false,restartReasons:[]})
const startup=()=>({systemTone:'dark',settings:snapshot(),themeBootstrap:{library:{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}}})
createApp({setup(){return()=>h('div',[
 h(Background,{page:page.value}),
 h('div',{class:'app-shell'},[
  h('div',{class:'title-bar','data-v-fixture':''},['Twilight Echo',h('button',{class:'menu-btn','data-v-fixture':''},'⌂')]),
  h('div',{class:'side-menu','data-v-fixture':''},[h('strong','本地音乐'),h('button',{class:'menu-item','data-v-fixture':''},[h('span',{class:'item-label','data-v-fixture':''},'背景文字')])]),
  h('div',{class:'fixture-content home','data-v-fixture':''},[h('div',{class:'album-card fixture-tile','data-v-fixture':''},'夜航星'),h('div',{class:'context-menu'},'菜单保留底板')]),
  h('div',{class:'player-bar','data-v-fixture':'',style:{position:'fixed',bottom:'15px',left:'280px',width:'850px',height:'65px'}},['♫ 夜航星',h('button',{class:'btn-play','data-v-fixture':''},'▶')])]),
 page.value==='settings'?h('div',{class:'fixture-settings settings-overlay-root settings-overlay-root--active','data-v-fixture':''},[h(Background,{page:'settings',embedded:true}),h('main',{class:'settings-preview-page','data-v-fixture':'',style:{position:'absolute',left:'280px',top:'80px'}},[h('input',{class:'number-input','data-v-fixture':'',type:'number',value:36}),h('select',{class:'preview-select','data-v-fixture':''},[h('option','背景文字')])])]):null,
 page.value==='player'?h('div',{class:'playing-music fixture-player','data-v-fixture':''},[h(Background,{page:'player',embedded:true}),h('div',{class:'backdrop','data-v-fixture':''},'旧封面背景'),h('button',{class:'lyric-return-button','data-v-fixture':'',style:{position:'absolute',left:'280px',top:'80px'}},'返回播放')]):null,
 appearanceEditorOpen.value?h(Editor):null
])}}).mount('#app')
const button=(text)=>[...document.querySelectorAll('.appearance-editor button,.appearance-full-preview-toolbar button')].find(el=>el.textContent.trim()===text && el.checkVisibility())
window.runAppearanceTests=async()=>{
 settingsStore.hydrateStartupSnapshot(startup());await bootstrapThemeRuntime(startup());await settle()
 const cache=localStorage.getItem('twilight-echo:theme-runtime-cache:v1')
 openAppearanceEditor();await settle();expect(document.querySelector('[role=dialog]'),'editor not mounted')
 button('透明').click();document.querySelector('#background-dim').value=40;document.querySelector('#background-dim').dispatchEvent(new Event('input',{bubbles:true}));await settle()
 expect(writes.length===0,'draft persisted before save');expect(settingsStore.settings.value.surfaceMaterial==='standard','confirmed settings mutated')
 const controls=document.querySelector('.appearance-editor-controls');controls.scrollTop=240;const scroll=controls.scrollTop
 button('全窗口预览').click();await settle();expect(appearanceFullWindowPreview.value,'full preview not active');expect(document.documentElement.dataset.teSurfaceMaterial==='transparent','transparent runtime not applied')
 expect(localStorage.getItem('twilight-echo:theme-runtime-cache:v1')===cache,'preview polluted startup cache')
 expect(getComputedStyle(document.querySelector('.side-menu')).backdropFilter==='none','sidebar blur remains')
 expect(getComputedStyle(document.querySelector('.player-bar')).backgroundColor==='rgba(0, 0, 0, 0)','playbar still opaque')
 expect(getComputedStyle(document.querySelector('.context-menu')).backgroundColor!=='rgba(0, 0, 0, 0)','menu lost its readable plate')
 button('返回编辑').click();await settle();expect(document.querySelector('.appearance-editor-controls').scrollTop===scroll,'return to editor lost scroll');button('全窗口预览').click();await settle()
 button('取消').click();await settle();expect(writes.length===0,'cancel persisted');expect(document.documentElement.dataset.teSurfaceMaterial==='standard','cancel did not restore')
 openAppearanceEditor();await settle();button('透明').click();button('保存并使用').click();await settle();expect(writes.length===1,'save must write once');expect(confirmed.surfaceMaterial==='transparent','saved material missing');expect(!appearanceEditorOpen.value,'editor stayed open after save')
 openAppearanceEditor();await settle();button('毛玻璃').click();failSave=true;button('保存并使用').click();await settle();expect(document.querySelector('[role=alert]').textContent.includes('保存失败'),'save failure not visible');expect(appearanceEditorOpen.value,'failure discarded draft');failSave=false;button('保存并使用').click();await settle();expect(confirmed.cardAppearance.dark.backgroundOpacity===60,'retry lost draft');expect(writes.length===2,'retry wrote unexpected patches')
 openAppearanceEditor();await settle();const select=document.querySelector('[aria-label="背景应用范围"]');select.value='settings';select.dispatchEvent(new Event('change',{bubbles:true}));await settle();const inherit=document.querySelector('.appearance-checkbox input');inherit.checked=false;inherit.dispatchEvent(new Event('change',{bubbles:true}));await settle();expect(document.querySelector('#background-scale').value==='1','inheritance copy changed zoom');button('恢复当前项默认').click();await settle();expect(inherit.checked,'page reset did not restore inheritance');button('取消').click();await settle();expect(confirmed.appBackground.pages.settings.inherit,'cancel changed page inheritance')
 openAppearanceEditor();await settle();failImport=true;const input=document.querySelector('.appearance-file-input'),transfer=new DataTransfer();transfer.items.add(new File(['invalid'],'invalid.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));await settle();expect(document.querySelector('[role=alert]').textContent.includes('图片导入失败'),'import error missing');expect(document.querySelector('.appearance-mini-window').style.getPropertyValue('--appearance-image').includes('wallpaper.png'),'import failure replaced draft image');expect(writes.length===2,'image import persisted settings');failImport=false;document.querySelector('[aria-label="取消并关闭"]').click();await settle();expect(!appearanceEditorOpen.value,'close did not cancel')
 settingsStore.hydrateStartupSnapshot(startup());await bootstrapThemeRuntime(startup());await settle();expect(document.documentElement.dataset.teCardCustom==='on','saved card profile lost after bootstrap');expect(getComputedStyle(document.documentElement).getPropertyValue('--te-card-blur').trim()==='20px','saved card blur not applied')
 const independent=cloneAppearance(confirmed);independent.appBackground.global.effects.dark.textTone='light';independent.appBackground.pages.streaming={...independent.appBackground.global,inherit:false,effects:{...independent.appBackground.global.effects,dark:{...independent.appBackground.global.effects.dark,textTone:'dark'}}};page.value='streaming';document.body.className='te-streaming-surface';await previewAppearance(independent);await settle();expect(getComputedStyle(document.querySelector('.side-menu')).getPropertyValue('--te-navigation-text').trim()==='#1a202c','streaming navigation inherited local text tone');expect(document.documentElement.dataset.theme==='dark','text tone switched whole theme');await previewAppearance(null)
 for(const tone of ['pureWhite','dark'])for(const material of ['theme','frosted','transparent','liquidGlass'])for(const currentPage of ['local','streaming','player','settings']){
  page.value=currentPage;document.body.className=currentPage==='streaming'?'te-streaming-surface':'te-local-surface';const draft=applyAppearancePreset(confirmed,material);draft.appBackground.global.effects[tone==='dark'?'dark':'light'].textTone=tone==='dark'?'light':'dark';await theme.setPreviewTone(tone);await previewAppearance(draft);await settle();expect(document.documentElement.dataset.teSurfaceMaterial===draft.surfaceMaterial,'material mismatch');const painter=[...document.querySelectorAll('.app-background-layer')].find(el=>el.dataset.backgroundPage===currentPage);expect(getComputedStyle(painter).display!=='none','missing painter '+currentPage);expect(getComputedStyle(painter.querySelector('.app-background-image')).backgroundImage.includes('wallpaper.png'),'page lost image');expect(getComputedStyle(painter.querySelector('.app-background-image')).filter.includes('brightness(1)'),'wrong effect')
 }
 await previewAppearance(null);await theme.setPreviewTone(null)
 const first=cloneAppearance(confirmed),second=cloneAppearance(confirmed);first.surfaceMaterial='transparent';second.surfaceMaterial='liquidGlass';await Promise.all([previewAppearance(first),previewAppearance(second)]);expect(document.documentElement.dataset.teSurfaceMaterial==='liquidGlass','old preview won race');await previewAppearance(null)
}
window.prepareAppearancePixels=async(currentPage,blur)=>{
 page.value=currentPage;document.body.className=currentPage==='streaming'?'te-streaming-surface':currentPage==='settings'?'te-settings-surface':'te-local-surface';const draft=cloneAppearance(confirmed);draft.surfaceMaterial='transparent';draft.appBackground.global.effects.dark={...draft.appBackground.global.effects.dark,blur,brightness:80,dim:40};await theme.setPreviewTone('dark');await previewAppearance(draft);await settle()
}
window.setAppearancePixelReference=async rgb=>{
 let reference=document.querySelector('#appearance-pixel-reference');if(!reference){reference=document.createElement('div');reference.id='appearance-pixel-reference';document.body.append(reference)}
 reference.style.cssText='all:initial!important;position:fixed!important;left:0!important;top:0!important;width:12px!important;height:12px!important;z-index:2147483647!important;background:rgb('+rgb.join(',')+')!important;opacity:1!important;filter:none!important;mix-blend-mode:normal!important;display:block!important';await settle()
}
window.prepareMissingBackground=async()=>{page.value='local';document.body.className='te-local-surface';const draft=cloneAppearance(confirmed);draft.surfaceMaterial='transparent';draft.appBackground.global.image='background://missing.png';draft.appBackground.global.dark='#123456';await previewAppearance(draft);await settle()}
window.showAppearanceEvidence=async tone=>{await previewAppearance(null);await theme.setPreviewTone(tone);openAppearanceEditor();await settle();const buttons=[...document.querySelectorAll('.appearance-preview-toolbar button')];buttons[tone==='dark'?1:0].click();await settle()}
window.runCharacterTests=async()=>{
 appearanceEditorOpen.value=false;await previewAppearance(null);await settle();
 const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;z-index:6000';document.body.append(host);let editor;
 let foreignUndoCalls=0;const foreignHistory={canUndo:true,canRedo:true,undo:()=>foreignUndoCalls++,redo:()=>foreignUndoCalls++};
 const app=createApp({setup:()=>()=>h(Editor,{embedded:true,characterEditor:true,externalTone:'dark',themeHistory:foreignHistory,ref:value=>editor=value})});app.mount(host);await settle();
 expect(host.querySelector('[aria-label="撤销外观调整"]').disabled&&host.querySelector('[aria-label="重做外观调整"]').disabled,'daily history falls back to a theme draft');
 const before=writes.length,pick=id=>host.querySelector('[data-part="'+id+'"]').click();
 editor.previewDraft.surfaceMaterial='liquidGlass';editor.previewDraft.liquidGlass.navigationEnabled=false;editor.previewDraft.liquidGlass.playbarEnabled=false;await settle();const globalMaterialBefore=JSON.stringify({legacy:editor.previewDraft.liquidGlass,navigation:editor.previewDraft.appearanceLayers.scopes.navigation,playbar:editor.previewDraft.appearanceLayers.scopes['player-bar']});pick('card');await settle();const globalCardMaterial=host.querySelector('[aria-label="部件材质"]');globalCardMaterial.value='frosted';globalCardMaterial.dispatchEvent(new Event('change',{bubbles:true}));await settle();expect(editor.previewDraft.surfaceMaterial==='liquidGlass'&&editor.previewDraft.appearanceLayers.scopes.card.dark.material.mode==='frosted'&&JSON.stringify({legacy:editor.previewDraft.liquidGlass,navigation:editor.previewDraft.appearanceLayers.scopes.navigation,playbar:editor.previewDraft.appearanceLayers.scopes['player-bar']})===globalMaterialBefore,'changing card material alters global or unrelated component materials');await editor.cancel();await settle();
 editor.previewDraft.cardAppearance.light.borderRadius=17;editor.previewDraft.cardAppearance.dark.borderRadius=19;await settle();editor.reset();await settle();expect(editor.previewDraft.cardAppearance.light.borderRadius===17&&editor.previewDraft.cardAppearance.dark.borderRadius===19,'adjustment reset changes locked geometry');await editor.cancel();await settle();
 expect(!host.querySelector('.appearance-popover'),'character editor opens a popover');pick('navigation');await settle();
 expect(host.querySelector('.appearance-inspector .appearance-material-field span').textContent==='侧边栏','wrong inspector');
 const navigationBefore=JSON.stringify(editor.previewDraft),navigationToggle=host.querySelector('[data-preview-navigation-toggle]');expect(navigationToggle.getAttribute('aria-expanded')==='true'&&navigationToggle.textContent.trim()==='收起侧边栏','sidebar state starts unclear');navigationToggle.click();await settle();expect(navigationToggle.getAttribute('aria-expanded')==='false'&&navigationToggle.textContent.trim()==='展开侧边栏','sidebar preview does not collapse');expect(JSON.stringify(editor.previewDraft)===navigationBefore&&!editor.hasChanges&&!editor.canUndo,'preview state changes appearance draft');navigationToggle.click();await settle();expect(navigationToggle.getAttribute('aria-expanded')==='true','sidebar preview does not expand');
 const select=host.querySelector('[aria-label="部件材质"]');select.value='liquidGlass';select.dispatchEvent(new Event('change',{bubbles:true}));await settle();
 expect(editor.previewDraft.appearanceLayers.scopes.navigation.dark.material.mode==='liquidGlass','navigation glass edits wrong target');expect(writes.length===before,'material preview persisted');
 expect(!document.querySelector('#part-opacity')?.getClientRects().length,'glass parameters expand before requested');host.querySelector('.appearance-parameters-button').click();await settle();
 const range=document.querySelector('#part-opacity');range.value='42';range.dispatchEvent(new Event('input',{bubbles:true}));await settle();
 const changed=JSON.stringify(editor.previewDraft);expect(editor.canUndo,'material undo missing');const textInput=document.createElement('input');textInput.type='text';host.append(textInput);const textUndo=new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});textInput.dispatchEvent(textUndo);await settle();expect(!textUndo.defaultPrevented&&JSON.stringify(editor.previewDraft)===changed,'text editing intercepts native undo');textInput.remove();range.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));await settle();expect(JSON.stringify(editor.previewDraft)!==changed&&editor.canRedo,'focused slider cannot undo its adjustment');editor.redo();await settle();expect(JSON.stringify(editor.previewDraft)===changed&&foreignUndoCalls===0,'redo loses draft or crosses into theme history');
 const inspector=host.querySelector('.appearance-inspector'),body=host.querySelector('.appearance-character-body'),canvas=host.querySelector('.appearance-character-canvas');expect(inspector.classList.contains('is-horizontal')&&canvas.contains(inspector)&&inspector.closest('.fixture-context-anchor')&&inspector.getBoundingClientRect().width<=440&&inspector.getBoundingClientRect().right<=canvas.getBoundingClientRect().right+1,'context strip covers or narrows the canvas');expect(!inspector.querySelector('[aria-label="收起属性"]')&&!inspector.querySelector('[aria-label="展开属性"]')&&!inspector.querySelector('[aria-label*="圆角"]'),'horizontal context retains obsolete collapse or geometry controls');inspector.querySelector('.appearance-parameters-button').click();await settle();expect(!document.querySelector('#part-opacity')&&JSON.stringify(editor.previewDraft)===changed,'closing on-demand parameters loses draft');inspector.querySelector('.appearance-parameters-button').click();await settle();expect(document.querySelector('#part-opacity').value==='42','reopening parameters loses value');
 host.querySelector('.appearance-return').click();await settle();expect(!host.querySelector('.appearance-inspector'),'return does not restore full preview');expect(JSON.stringify(editor.previewDraft)===changed,'return discards draft');expect(document.activeElement.dataset.part==='navigation','return loses keyboard focus');
 pick('card');await settle();const cardMaterial=host.querySelector('[aria-label="部件材质"]');cardMaterial.value='solid';cardMaterial.dispatchEvent(new Event('change',{bubbles:true}));await settle();host.querySelector('.appearance-parameters-button').click();await settle();const source=document.querySelector('[aria-label="材质底色来源"]');source.value='custom';source.dispatchEvent(new Event('change',{bubbles:true}));await settle();const color=document.querySelector('[aria-label="部件底色"]');color.value='#123456';color.dispatchEvent(new Event('input',{bubbles:true}));await settle();expect(editor.previewDraft.appearanceLayers.scopes.card.dark.material.color==='#123456','card color edits wrong target');expect(editor.previewDraft.appearanceLayers.scopes.navigation.dark.material.mode==='liquidGlass'&&editor.previewDraft.appearanceLayers.scopes.navigation.dark.material.opacity===42,'card edit destroys other part settings');
 host.querySelector('.appearance-parameters-button').click();await settle();expect(!document.querySelector('[aria-label="部件底色"]')&&editor.previewDraft.appearanceLayers.scopes.card.dark.material.color==='#123456','closing card parameters loses independent color');host.querySelector('.appearance-parameters-button').click();await settle();expect(document.querySelector('[aria-label="部件底色"]').value==='#123456'&&host.querySelector('[aria-label="部件材质"]').value==='solid','reopening card parameters loses its mode or color');host.querySelector('.appearance-parameters-button').click();await settle();
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle();expect(!host.querySelector('.appearance-inspector')&&editor.hasChanges,'Escape discards adjustment');expect(writes.length===before,'part/keyboard navigation persists');
 const cardDraft=JSON.stringify(editor.previewDraft);window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}));await settle();expect(JSON.stringify(editor.previewDraft)!==cardDraft&&editor.canRedo,'keyboard undo ineffective');window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:true,bubbles:true}));await settle();expect(JSON.stringify(editor.previewDraft)===cardDraft,'keyboard redo loses draft');
 failSave=true;expect(!await editor.apply(),'failed commit reported success');expect(editor.hasChanges&&editor.previewDraft.appearanceLayers.scopes.card.dark.material.color==='#123456','failed commit loses draft');failSave=false;expect(await editor.apply(),'retry does not apply');await settle();expect(writes.length===before+1&&!editor.hasChanges&&!editor.canUndo,'apply does not save once and reset history');
 pick('inner-panel');await settle();editor.previewDraft.appearanceLayers.scopes['inner-panel'].dark.body.enabled=true;const background=host.querySelector('[aria-label="背景颜色"]');background.value='#654321';background.dispatchEvent(new Event('input',{bubbles:true}));await settle();expect(!editor.previewDraft.appearanceLayers.scopes['inner-panel'].dark.body.enabled,'merged background color remains covered by the old inner body');await editor.cancel();await settle();expect(!editor.hasChanges&&!editor.canUndo&&!editor.canRedo,'discard retains pending history');
 const originalImporter=window.api.settings.importBackgroundImage;let releaseImport,importCalls=0;
 window.api.settings.importBackgroundImage=async(name,data)=>{importCalls++;expect(name==='cutout.png'&&data.byteLength>0,'image editor does not forward its selected PNG');await new Promise(resolve=>releaseImport=resolve);return 'background://cutout.png'};
 try{
  pick('player-bar');await settle();host.querySelector('.appearance-parameters-button').click();await settle();document.querySelector('.appearance-image-settings summary').click();await settle();
  const baseline=JSON.stringify(editor.previewDraft),writesBefore=writes.length,legacyEffect=JSON.stringify(editor.previewDraft.appearanceLayers.scopes['player-bar'].dark.effect),picker=document.querySelector('[aria-label="上传背景皮肤"]'),transfer=new DataTransfer();
  const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='),character=>character.charCodeAt(0));
  transfer.items.add(new File([png],'cutout.png',{type:'image/png'}));picker.files=transfer.files;picker.dispatchEvent(new Event('change',{bubbles:true}));await settle();
  expect(importCalls===1&&editor.previewBusy&&document.querySelector('.appearance-layer-settings').matches(':disabled'),'image import does not lock the actual appearance editor');
  expect(!await editor.apply()&&!await editor.prepareLeave()&&!await editor.collapse(),'pending image import can apply or leave the real parent editor');
  await editor.cancel();editor.setTone('pureWhite');pick('inner-panel');host.querySelector('.appearance-return').click();await settle();
  expect(editor.previewPart==='player-bar'&&editor.tone==='dark'&&editor.previewBusy&&JSON.stringify(editor.previewDraft)===baseline&&writes.length===writesBefore,'pending image import loses its part, tone, draft or persistence boundary');
  releaseImport();await settle();
  const skin=editor.previewDraft.appearanceLayers.scopes['player-bar'].dark.skin;
  expect(!editor.previewBusy&&editor.hasChanges&&skin.image==='background://cutout.png'&&skin.enabled&&skin.placement==='outside'&&skin.fit==='fill'&&Object.values(skin.frame).every(value=>value===0)&&JSON.stringify(editor.previewDraft.appearanceLayers.scopes['player-bar'].dark.effect)===legacyEffect&&!editor.previewDraft.appearanceLayers.scopes.controls.dark.skin.image&&writes.length===writesBefore,'parent skin upload is swallowed, persists early, changes legacy color or attaches to controls');
  const remove=[...document.querySelectorAll('.appearance-layer-settings button')].find(button=>button.textContent.trim()==='移除皮肤');expect(remove&&!remove.disabled,'completed upload does not restore its skin controls');remove.click();await settle();
  const removed=editor.previewDraft.appearanceLayers.scopes['player-bar'].dark.skin;expect(!removed.image&&!removed.enabled&&JSON.stringify(editor.previewDraft.appearanceLayers.scopes['player-bar'].dark.effect)===legacyEffect,'removing a skin changes the legacy effect in the real parent draft');await editor.cancel();await settle();expect(!editor.hasChanges&&!editor.previewBusy&&writes.length===writesBefore,'cancel does not restore the skin draft without saving');
  pick('inner-panel');await settle();editor.previewDraft.appearanceLayers.scopes['inner-panel'].dark.body.enabled=true;editor.previewDraft.appearanceLayers.scopes['inner-panel'].light.body.enabled=true;await settle();host.querySelector('.appearance-parameters-button').click();await settle();document.querySelector('.appearance-more-button').click();await settle();
  const backgroundScope=host.querySelector('[aria-label="背景应用范围"]');backgroundScope.value='streaming';backgroundScope.dispatchEvent(new Event('input',{bubbles:true}));backgroundScope.dispatchEvent(new Event('change',{bubbles:true}));await settle();expect(editor.previewDraft.appearanceLayers.scopes['inner-panel'].dark.body.enabled,'selecting another background scope erases the untouched legacy body');backgroundScope.value='global';backgroundScope.dispatchEvent(new Event('change',{bubbles:true}));await settle();
  const backgroundPicker=host.querySelector('.appearance-file-input'),backgroundTransfer=new DataTransfer();backgroundTransfer.items.add(new File([png],'cutout.png',{type:'image/png'}));backgroundPicker.files=backgroundTransfer.files;backgroundPicker.dispatchEvent(new Event('change',{bubbles:true}));await settle();expect(editor.previewBusy,'merged background import bypasses the existing busy boundary');releaseImport();await settle();
  expect(editor.previewDraft.appBackground.global.image==='background://cutout.png'&&!editor.previewDraft.appearanceLayers.scopes['inner-panel'].dark.body.enabled&&editor.previewDraft.appearanceLayers.scopes['inner-panel'].light.body.enabled&&writes.length===writesBefore,'merged background image is hidden by an old body, changes the opposite tone, or persists before applying');await editor.cancel();await settle();
 }finally{window.api.settings.importBackgroundImage=originalImporter;app.unmount();host.remove()}
}
window.runAppearanceToneTests=async()=>{
 await theme.setPreviewTone(null);await settingsStore.updateSettings({theme:'pureWhite'});await settle();
 const host=document.createElement('div');host.style.cssText='position:fixed;inset:0;z-index:6000';document.body.append(host);let editor;
 const selectedTone=ref('pureWhite');
 const app=createApp({setup:()=>()=>h(Editor,{embedded:true,characterEditor:true,externalTone:selectedTone.value,onToneChange:value=>selectedTone.value=value,ref:value=>editor=value})});app.mount(host);await settle();
 const applyButton=()=>host.querySelector('.appearance-character-footer .appearance-save');
 try{
  const before=writes.length;
  expect(!editor.hasChanges&&applyButton().disabled,'opening appearance creates a tone change');
  editor.setTone('dark');await settle();
  expect(editor.hasChanges&&!applyButton().disabled,'dark selection does not enable Apply Appearance');
  expect(writes.length===before&&confirmed.theme==='pureWhite'&&document.documentElement.dataset.theme==='pureWhite','tone selection persists before Apply Appearance');
  applyButton().click();await settle();
  expect(writes.length===before+1&&writes.at(-1).theme==='dark'&&confirmed.theme==='dark'&&document.documentElement.dataset.theme==='dark','applying dark does not persist and update the real theme runtime once');
  expect(!editor.hasChanges&&applyButton().disabled,'successful dark apply retains a pending tone');
  editor.setTone('pureWhite');await settle();failSave=true;
  expect(!await editor.apply(),'failed tone save reports success');await settle();
  expect(editor.hasChanges&&editor.tone==='light'&&editor.previewBusy===false&&confirmed.theme==='dark'&&writes.length===before+1,'failed tone save loses the selection or changes confirmed settings');
  failSave=false;expect(await editor.apply(),'tone save cannot retry');await settle();
  expect(confirmed.theme==='pureWhite'&&document.documentElement.dataset.theme==='pureWhite'&&writes.length===before+2&&!editor.hasChanges,'tone retry does not save once and update the app');
  editor.setTone('dark');await settle();await editor.cancel();await settle();
  expect(!editor.hasChanges&&editor.tone==='light'&&selectedTone.value==='pureWhite'&&confirmed.theme==='pureWhite'&&writes.length===before+2,'discard does not restore the confirmed tone without saving');
  await settingsStore.updateSettings({theme:'system'});await settle();const systemWrites=writes.length,systemTone=document.documentElement.dataset.theme;
  expect(!editor.hasChanges,'following the system implicitly creates a fixed tone draft');
  editor.setTone(systemTone==='dark'?'pureWhite':'dark');await settle();await editor.cancel();await settle();
  expect(confirmed.theme==='system'&&writes.length===systemWrites&&!editor.hasChanges,'discard replaces system mode with a manual tone');
  editor.setTone(systemTone);await settle();expect(editor.hasChanges,'explicit same-tone selection cannot replace system mode');
  expect(await editor.apply(),'explicit system-tone selection cannot apply');await settle();
  expect(confirmed.theme===systemTone&&writes.length===systemWrites+1&&!editor.hasChanges,'explicit tone does not persist from system mode');
 }finally{failSave=false;app.unmount();host.remove()}
}
window.runImagePaletteTests=async()=>{
 await previewAppearance(null);await theme.setPreviewTone(null);await settingsStore.updateSettings({theme:'pureWhite'});page.value='local';document.body.className='te-local-surface';await settle();
 const host=document.createElement('div');document.body.append(host);let editor;
 const probe=createApp({setup(){editor=useBackgroundAppearanceEditor({embedded:true});return()=>h('div')}});probe.mount(host);await settle();
 try{
  const before=writes.length,original=JSON.stringify(confirmed.appBackground),background=editor.state.draft.appBackground.global;
  background.effects.light={...background.effects.light,textTone:'theme',brightness:100,dim:0};editor.state.draft.surfaceMaterial='standard';editor.state.draft.cardAppearance.enabled=false;
  editor.chooseImage();await editor.importImage({target:{files:[new File(['fixture'],'palette.png',{type:'image/png'})],value:'palette.png'}});await settle();
  expect(!editor.importing.value&&!editor.state.error&&!editor.imagePaletteNotice.value,'decoded local image did not finish palette analysis');
  expect(background.imagePalette?.image==='background://wallpaper.png'&&background.imagePalette.average==='#283c5a'&&background.imagePalette.accent==='#283c5a'&&background.imagePalette.opacity===1,'real image/canvas sampling did not derive the source colors');
  expect(writes.length===before&&JSON.stringify(confirmed.appBackground)===original,'image analysis persisted before Apply Appearance');
  await editor.fullPreview(true);await settle();const palette=resolveBackgroundPalette(background,'light'),navigation=getComputedStyle(document.querySelector('.side-menu'));
  expect(document.documentElement.dataset.teLocalImagePalette==='on'&&document.documentElement.dataset.teLocalTextTone==='light'&&document.documentElement.dataset.theme==='pureWhite','automatic image text tone does not reach preview without changing the theme');
  expect(navigation.getPropertyValue('--te-control-bg').trim()===palette.controlBackground&&navigation.getPropertyValue('--te-neutral-900').trim()===palette.controlForeground,'derived control colors and foreground do not reach real surfaces: '+JSON.stringify({control:navigation.getPropertyValue('--te-control-bg').trim(),ink:navigation.getPropertyValue('--te-neutral-900').trim(),palette}));
  expect(writes.length===before,'palette full preview persisted settings');await editor.save();await settle();
  expect(writes.length===before+1&&confirmed.appBackground.global.imagePalette.average==='#283c5a'&&document.documentElement.dataset.teLocalImagePalette==='on'&&!editor.hasChanges.value,'Apply Appearance did not save the analyzed image once and update runtime');
  editor.removeImage();await editor.fullPreview(true);await settle();expect(document.documentElement.dataset.teLocalImagePalette==='off'&&!editor.state.draft.appBackground.global.imagePalette,'removing image leaves stale palette controls');
  await editor.cancel();await settle();expect(document.documentElement.dataset.teLocalImagePalette==='on'&&editor.state.draft.appBackground.global.imagePalette.average==='#283c5a'&&writes.length===before+1,'cancel does not restore saved image palette without persistence');
 }finally{await editor.cancel();probe.unmount();host.remove()}
}

const backgroundThemeColors={pureWhite:{app:'#dde5ef',local:'#e1e9f3',settings:'#e8edf5',streaming:'#e4edf6',player:'#dae5f1'},dark:{app:'#172535',local:'#1a2c40',settings:'#20344a',streaming:'#22364c',player:'#162b42'}};
const backgroundImageTuning={blur:5,brightness:100,dim:16,scale:1,positionX:50,positionY:50,textTone:'theme'};
const colorRgb=color=>[1,3,5].map(offset=>parseInt(color.slice(offset,offset+2),16));
const imageTuning=()=>({light:{...backgroundImageTuning},dark:{...backgroundImageTuning}});
const themeColorProfile=withImage=>{
 const profile=theme.createProfile('Background ownership fixture');profile.id='user:background-ownership';
 profile.modes={appearance:{backgroundTreatment:withImage?'image':'solid',contrastGuard:'off'}};
 for(const tone of ['pureWhite','dark'])profile.overrides[tone]=Object.fromEntries(Object.entries(backgroundThemeColors[tone]).map(([page,color])=>['surface.'+page,color]));
 if(withImage){profile.assets=[{id:'wallpaper',path:'wallpaper.png',type:'image'}];profile.assetBindings={appBackground:'wallpaper'}}
 return profile;
};
const ownershipCases=[];let ownershipRestore,cancelOwnershipEditor,cancelOwnershipProbe,cancelOwnershipHost,cancelOwnershipWrites;
const waitForBackgroundPaint=async()=>{
 for(let attempt=0;attempt<60;attempt++){await settle();const visible=[...document.querySelectorAll('.app-background-layer')].filter(layer=>getComputedStyle(layer).display!=='none');if(visible.every(layer=>layer.dataset.backgroundImageState!=='loading'))return}
 throw Error('background painter did not finish loading its local image');
};
window.beginBackgroundOwnershipTests=async()=>{
 ownershipRestore={theme:confirmed.theme,...cloneAppearance(confirmed)};
 const clean=cloneAppearance({...confirmed,appBackground:normalizeAppBackgroundSettings(null),cardAppearance:defaultCardAppearance(),appearanceLayers:undefined,surfaceMaterial:'standard',liquidGlass:{...confirmed.liquidGlass,navigationEnabled:false,playbarEnabled:false,settingsNavigationEnabled:false,homeCards:{...confirmed.liquidGlass.homeCards,enabled:false}}});
 await settingsStore.updateSettings({theme:'pureWhite',...clean});await previewAppearance(null);await theme.setPreviewTone(null);await settle();
 for(const tone of ['pureWhite','dark'])for(const currentPage of ['local','settings','streaming','player']){
  const selected=tone==='dark'?'#243649':'#f4f4f7';ownershipCases.push({id:'solid-'+tone+'-'+currentPage,tone,page:currentPage,withThemeImage:true,background:{global:{kind:'color',customized:true,light:'#f4f4f7',dark:'#243649',effects:imageTuning()}},expectedColor:selected,expectedImage:'none',expectedRgb:colorRgb(selected),custom:true,dim:0,storedDim:16});
 }
 for(const currentPage of ['local','settings','streaming','player']){
  ownershipCases.push({id:'default-theme-color-'+currentPage,tone:'pureWhite',page:currentPage,withThemeImage:false,background:{},expectedColor:backgroundThemeColors.pureWhite[currentPage],expectedImage:'none',expectedRgb:colorRgb(backgroundThemeColors.pureWhite[currentPage]),custom:false,dim:0});
  ownershipCases.push({id:'default-theme-image-'+currentPage,tone:'pureWhite',page:currentPage,withThemeImage:true,background:{global:{effects:imageTuning()}},expectedColor:backgroundThemeColors.pureWhite[currentPage],expectedImage:'theme-asset:',expectedRgb:[174,126,68],custom:false,dim:0,storedDim:16});
 }
 for(const kind of ['none','theme','image'])ownershipCases.push({id:'empty-'+kind+'-returns-theme',tone:'pureWhite',page:'local',withThemeImage:true,background:{global:{kind,customized:true,image:'',light:'#123456',effects:imageTuning()}},expectedColor:backgroundThemeColors.pureWhite.local,expectedImage:'theme-asset:',expectedRgb:[174,126,68],custom:false,dim:0,storedDim:16});
 for(const currentPage of ['local','settings','streaming','player'])ownershipCases.push({id:'missing-picture-'+currentPage,tone:'pureWhite',page:currentPage,withThemeImage:true,background:{global:{kind:'image',customized:true,image:'background://missing.png',light:'#b5c6d7',effects:imageTuning()}},expectedColor:'#b5c6d7',expectedImage:'background:',expectedRgb:colorRgb('#b5c6d7'),custom:true,dim:.16,storedDim:16,imageState:'error'});
 for(const [name,selected] of [['white','#ffffff'],['black','#000000'],['gray','#777777']])for(const currentPage of ['local','settings','streaming','player']){
  const old=selected==='#ffffff'?'#000000':'#ffffff';ownershipCases.push({id:'cached-missing-'+name+'-'+currentPage,tone:'pureWhite',page:currentPage,withThemeImage:true,background:{global:{kind:'image',customized:true,image:'background://missing.png',light:selected,imagePalette:{image:'background://missing.png',average:old,accent:old},effects:imageTuning()}},expectedColor:selected,expectedImage:'background:',expectedRgb:colorRgb(selected),custom:true,dim:.16,storedDim:16,imageState:'error',fallbackTone:selected==='#000000'?'light':'dark',contrast:true});
 }
 for(const selected of ['#ffffff','#000000']){
  const textTone=selected==='#ffffff'?'light':'dark';ownershipCases.push({id:'manual-cached-missing-'+(selected==='#ffffff'?'white':'black'),tone:'pureWhite',page:'local',withThemeImage:true,background:{global:{kind:'image',customized:true,image:'background://missing.png',light:selected,imagePalette:{image:'background://missing.png',average:'#112233',accent:'#445566'},effects:{light:{...backgroundImageTuning,textTone}}}},expectedColor:selected,expectedImage:'background:',expectedRgb:colorRgb(selected),custom:true,dim:.16,imageState:'error',fallbackTone:selected==='#ffffff'?'dark':'light',manualText:textTone==='light'?'#f4f7fb':'#1a202c'});
 }
 ownershipCases.push({id:'independent-settings-color',tone:'pureWhite',page:'settings',withThemeImage:true,background:{global:{kind:'image',image:'background://wallpaper.png',effects:imageTuning()},pages:{settings:{inherit:false,kind:'color',light:'#a3b4c5',effects:imageTuning()}}},expectedColor:'#a3b4c5',expectedImage:'none',expectedRgb:colorRgb('#a3b4c5'),custom:true,dim:0});
 ownershipCases.push({id:'independent-settings-empty-image',tone:'pureWhite',page:'settings',withThemeImage:true,background:{global:{kind:'color',customized:true,light:'#123456',effects:imageTuning()},pages:{settings:{inherit:false,kind:'image',image:'',customized:true,effects:imageTuning()}}},expectedColor:backgroundThemeColors.pureWhite.settings,expectedImage:'theme-asset:',expectedRgb:[174,126,68],custom:false,dim:0});
 ownershipCases.push({id:'independent-settings-picture',tone:'pureWhite',page:'settings',withThemeImage:true,background:{global:{kind:'color',customized:true,light:'#123456'},pages:{settings:{inherit:false,kind:'image',image:'background://wallpaper.png',effects:{light:{...backgroundImageTuning,dim:25}}}}},expectedColor:'#f4f4f7',expectedImage:'background:',expectedRgb:[30,45,68],custom:true,dim:.25});
 ownershipCases.push({id:'settings-inherits-global-color',tone:'pureWhite',page:'settings',withThemeImage:true,background:{global:{kind:'color',customized:true,light:'#c6d7e8',effects:imageTuning()},pages:{settings:{inherit:true,kind:'image',image:'background://wallpaper.png',effects:{light:{...backgroundImageTuning,dim:70}}}}},expectedColor:'#c6d7e8',expectedImage:'none',expectedRgb:colorRgb('#c6d7e8'),custom:true,dim:0,storedDim:16});
 return ownershipCases.length;
};
const fallbackControlContrasts=item=>{
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d'),channels=value=>{context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data]};
 const selectors=item.page==='settings'?['.fixture-settings .number-input','.fixture-settings .preview-select']:item.page==='player'?['.fixture-player .lyric-return-button']:['.title-bar .menu-btn','.side-menu .menu-item','.player-bar .btn-play'];
 return selectors.map(selector=>{const element=document.querySelector(selector);expect(element&&element.checkVisibility(),'fallback control is not visible '+item.id+' '+selector);const ancestors=[];for(let current=element;current;current=current.parentElement)ancestors.unshift(current);let background=[...item.expectedRgb];for(const ancestor of ancestors){const rgba=channels(getComputedStyle(ancestor).backgroundColor),alpha=rgba[3]/255;background=background.map((channel,index)=>Math.round(rgba[index]*alpha+channel*(1-alpha)))}const color=getComputedStyle(element).color,surface='rgb('+background.join(',')+')',ratio=themeContrastRatio(color,surface);expect(ratio>=4.5,'cached fallback makes real text/control unreadable '+item.id+' '+selector+': '+color+' on '+surface+' = '+ratio);return {selector,color,surface,ratio}});
};
window.prepareBackgroundOwnershipCase=async index=>{
 const item=ownershipCases[index],profile=themeColorProfile(item.withThemeImage),profileBefore=JSON.stringify(profile),background=normalizeAppBackgroundSettings(item.background);
 page.value=item.page;document.body.className=item.page==='streaming'?'te-streaming-surface':item.page==='settings'?'te-settings-surface':'te-local-surface';
 await settingsStore.updateSettings({theme:item.tone,appBackground:background});const stored=JSON.stringify(settingsStore.settings.value.appBackground),writesBefore=writes.length;
 await theme.setPreviewTone(null);await theme.preview(profile);await waitForBackgroundPaint();
 const css=getComputedStyle(document.documentElement),color=css.getPropertyValue('--te-'+item.page+'-bg').trim(),image=css.getPropertyValue('--te-'+item.page+'-bg-image').trim(),dim=css.getPropertyValue('--te-'+item.page+'-background-dim').trim(),custom=document.documentElement.getAttribute('data-te-'+item.page+'-custom-background');
 expect(color===item.expectedColor,'theme/background color ownership mismatch '+item.id+': '+color+' expected '+item.expectedColor);
 expect(item.expectedImage==='none'?image==='none':image.includes(item.expectedImage),'theme/background image ownership mismatch '+item.id+': '+image);
 expect(custom===(item.custom?'on':'off'),'default/none background unexpectedly owns its theme '+item.id+': '+custom);
 expect(Number(dim)===item.dim,'dormant tuning reached painter '+item.id+': '+dim);
 if(item.imageState)expect(document.querySelector('.app-background-layer[data-background-page="'+item.page+'"]').dataset.backgroundImageState===item.imageState,'unavailable image does not finish fallback '+item.id);
 if(item.fallbackTone)expect(document.documentElement.getAttribute('data-te-'+item.page+'-image-fallback-tone')===item.fallbackTone,'cached palette does not follow actual fallback tone '+item.id);
 const contrasts=item.contrast?fallbackControlContrasts(item):undefined;
 if(item.manualText)expect(document.documentElement.getAttribute('data-te-local-text-tone-source')==='manual'&&getComputedStyle(document.body).getPropertyValue('--te-local-background-text').trim()===item.manualText,'fallback replaces an explicit manual text choice '+item.id);
 expect(JSON.stringify(settingsStore.settings.value.appBackground)===stored&&JSON.stringify(profile)===profileBefore&&writes.length===writesBefore,'rendering/preview mutates saved tuning or its theme '+item.id);
 if(item.storedDim!==undefined)expect(backgroundEffect(settingsStore.settings.value.appBackground.global,item.tone==='dark'?'dark':'light').dim===item.storedDim,'background render rewrote saved dim '+item.id);
 return JSON.parse(JSON.stringify({id:item.id,page:item.page,tone:item.tone,expectedRgb:item.expectedRgb,color,image,custom,dim,storedGlobalEffects:settingsStore.settings.value.appBackground.global.effects,contrasts}));
};
window.prepareBackgroundCancelPreview=async()=>{
 page.value='local';document.body.className='te-local-surface';await settingsStore.updateSettings({theme:'pureWhite',appBackground:normalizeAppBackgroundSettings({global:{kind:'color',customized:true,light:'#f4f4f7',effects:imageTuning()}})});await theme.preview(themeColorProfile(true));await waitForBackgroundPaint();
 cancelOwnershipHost=document.createElement('div');document.body.append(cancelOwnershipHost);cancelOwnershipProbe=createApp({setup(){cancelOwnershipEditor=useBackgroundAppearanceEditor({embedded:true});return()=>h('div')}});cancelOwnershipProbe.mount(cancelOwnershipHost);await settle();cancelOwnershipWrites=writes.length;
 cancelOwnershipEditor.state.draft.appBackground.global.light='#765432';await cancelOwnershipEditor.fullPreview(true);await waitForBackgroundPaint();
 expect(confirmed.appBackground.global.light==='#f4f4f7'&&confirmed.appBackground.global.effects.light.dim===16&&writes.length===cancelOwnershipWrites,'draft color preview changes saved color or image tuning');
 return {id:'cancel-before-draft',page:'local',tone:'pureWhite',expectedRgb:colorRgb('#765432'),storedColor:confirmed.appBackground.global.light,storedDim:confirmed.appBackground.global.effects.light.dim};
};
window.cancelBackgroundOwnershipPreview=async()=>{
 await cancelOwnershipEditor.cancel();await waitForBackgroundPaint();
 expect(!cancelOwnershipEditor.hasChanges.value&&confirmed.appBackground.global.light==='#f4f4f7'&&confirmed.appBackground.global.effects.light.dim===16&&writes.length===cancelOwnershipWrites,'cancel does not restore confirmed color without rewriting saved image tuning');
 return {id:'cancel-restored-confirmed',page:'local',tone:'pureWhite',expectedRgb:colorRgb('#f4f4f7'),storedColor:confirmed.appBackground.global.light,storedDim:confirmed.appBackground.global.effects.light.dim};
};
window.finishBackgroundOwnershipTests=async()=>{
 if(cancelOwnershipProbe){cancelOwnershipProbe.unmount();cancelOwnershipHost.remove()}
 await theme.preview(null);await settingsStore.updateSettings(ownershipRestore);await previewAppearance(null);await theme.setPreviewTone(null);await settle();
};

const legacyBackgroundCases=[];let legacyBackgroundRestore;
window.beginLegacyBackgroundTests=async()=>{
 legacyBackgroundRestore={theme:confirmed.theme,...cloneAppearance(confirmed)};
 const toneRule=(tone,color,image='none')=>':root[data-theme="'+tone+'"]{--te-app-bg:'+color+';--te-local-bg:var(--te-app-bg);--te-app-bg-image:'+image+'}';
 legacyStyles={
  'background-color.css':toneRule('pureWhite','#dbe8f5')+'@media(min-width:1000px){@supports(display:grid){'+toneRule('dark','#1b2c3d')+'}}.fixture-tile{outline-color:#123456}',
  'background-image.css':toneRule('pureWhite','#dbe8f5','url("theme-asset://legacy/wallpaper.png")')+'@media(min-width:1000px){@supports(display:grid){'+toneRule('dark','#1b2c3d','url("theme-asset://legacy/wallpaper.png")')+'}}.fixture-tile{outline-color:#123456}'
 };
 legacyThemes=[{id:'stylesheet-only',name:'Stylesheet only',stylesheet:'background-color.css'},{id:'app-variables-only',name:'App variables only',variables:{'--te-app-bg':'#b7cadc','--te-app-bg-image':'none'}},{id:'image-stylesheet-only',name:'Image stylesheet only',stylesheet:'background-image.css'}];
 for(const kind of ['stylesheet-only','app-variables-only','image-stylesheet-only'])for(const tone of ['pureWhite','dark'])for(const phase of ['custom','none','cancel'])legacyBackgroundCases.push({kind,tone,phase});
 return legacyBackgroundCases.length;
};
window.prepareLegacyBackgroundCase=async index=>{
 const item=legacyBackgroundCases[index],nativeColor=item.kind==='app-variables-only'?'#b7cadc':item.tone==='dark'?'#1b2c3d':'#dbe8f5',selectedColor=item.tone==='dark'?'#2a3b4c':'#765432';
 page.value='local';document.body.className='te-local-surface';await previewAppearance(null);await theme.setPreviewTone(null);
 await settingsStore.updateSettings({theme:item.tone,appBackground:normalizeAppBackgroundSettings({global:{kind:'color',customized:true,light:'#765432',dark:'#2a3b4c',effects:imageTuning()}})});
 await waitForBackgroundPaint();
 const original=JSON.stringify(confirmed.appBackground),writesBefore=writes.length,cache=localStorage.getItem('twilight-echo:theme-runtime-cache:v1');
 await theme.previewTheme({kind:'plugin',pluginId:'background-legacy',themeId:item.kind});await waitForBackgroundPaint();
 const baseline=getComputedStyle(document.documentElement),baselineColor=baseline.getPropertyValue('--te-theme-local-bg').trim(),baselineApp=baseline.getPropertyValue('--te-theme-app-bg').trim(),baselineImage=baseline.getPropertyValue('--te-theme-local-bg-image').trim();
 expect(baselineColor===nativeColor&&baselineApp===nativeColor,'legacy theme baseline follows the custom saved color or loses native inheritance '+JSON.stringify({item,baselineColor,baselineApp,nativeColor}));
 expect(item.kind==='image-stylesheet-only'?baselineImage.includes('theme-asset://legacy/'):baselineImage==='none','legacy background image baseline is lost '+JSON.stringify({item,baselineImage}));
 const stylesheet=document.getElementById('twilight-theme-runtime').textContent;
 if(item.kind!=='app-variables-only')expect((stylesheet.match(/outline-color/g)||[]).length===1&&stylesheet.includes('@media')&&stylesheet.includes('@supports'),'baseline metadata duplicates paint declarations or loses media/supports conditions');
 if(item.phase!=='custom'){
  const draft=cloneAppearance(confirmed);draft.appBackground=normalizeAppBackgroundSettings({global:{...draft.appBackground.global,kind:'none'}});await previewAppearance(draft);await waitForBackgroundPaint();
  expect(document.documentElement.dataset.teLocalCustomBackground==='off','legacy none preview still owns its theme');
  if(item.phase==='cancel'){await previewAppearance(null);await waitForBackgroundPaint()}
 }
 const css=getComputedStyle(document.documentElement),color=css.getPropertyValue('--te-local-bg').trim(),image=css.getPropertyValue('--te-local-bg-image').trim(),themeOwned=item.phase==='none',expectedColor=themeOwned?nativeColor:selectedColor;
 expect(color===expectedColor,'legacy theme color preview/cancel mismatch '+JSON.stringify({item,color,expectedColor}));
 expect(themeOwned&&item.kind==='image-stylesheet-only'?image.includes('theme-asset://legacy/'):image==='none','legacy theme image preview/cancel mismatch '+JSON.stringify({item,image}));
 expect(JSON.stringify(confirmed.appBackground)===original&&writes.length===writesBefore,'legacy preview/cancel rewrites confirmed appearance');
 expect(localStorage.getItem('twilight-echo:theme-runtime-cache:v1')===cache,'legacy preview/cancel rewrites startup cache with a trial theme');
 return {id:'legacy-'+item.kind+'-'+item.tone+'-'+item.phase,page:'local',tone:item.tone,expectedRgb:themeOwned&&item.kind==='image-stylesheet-only'?[174,126,68]:colorRgb(expectedColor),color,image,baselineColor,baselineApp,baselineImage,storedDim:confirmed.appBackground.global.effects.light.dim};
};
window.finishLegacyBackgroundTests=async()=>{
 await previewAppearance(null);await theme.previewTheme(null);await settingsStore.updateSettings(legacyBackgroundRestore);await theme.setPreviewTone(null);await settle();
};

window.runPreviewPerformanceTests=async()=>{
 const visibilityDescriptor=Object.getOwnPropertyDescriptor(document,'hidden');let hidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
 const visibility=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))};
 const host=document.createElement('div');document.body.append(host);let editor;
 const probe=createApp({setup(){editor=useBackgroundAppearanceEditor({embedded:true});return()=>h('div')}});probe.mount(host);await settle();
 const requests=()=>window.previewRequests.filter(Boolean),clear=()=>window.previewRequests.length=0;
 const paintedCard=()=>getComputedStyle(document.documentElement).getPropertyValue('--te-card-bg').trim();
 try{
  await editor.fullPreview(true);await settle();clear();const before=writes.length;
  editor.state.draft.surfaceMaterial='standard';editor.state.draft.cardAppearance.enabled=true;editor.state.draft.cardAppearance.dark.backgroundColor='#345678';
  for(let i=0;i<100;i++)editor.state.draft.cardAppearance.dark.backgroundOpacity=i;
  await nextTick();expect(requests().length===0,'synchronous draft edits enter the global theme runtime before the next frame');
  for(let i=0;i<100;i++){editor.state.draft.cardAppearance.dark.backgroundOpacity=i;await nextTick()}
  editor.state.draft.cardAppearance.dark.backgroundOpacity=73;await nextTick();expect(requests().length===0,'microtask draft edits schedule more than one frame');await settle();
  expect(requests().length===1&&requests()[0].cardAppearance.dark.backgroundOpacity===73,'one frame does not apply the latest draft exactly once');expect(paintedCard()===cardCssVariables(editor.state.draft.cardAppearance.dark)['--te-card-bg'],'coalesced preview does not reach the real theme runtime');expect(writes.length===before,'frame previews persist settings');
  clear();editor.state.draft.cardAppearance.dark.backgroundOpacity=51;await nextTick();visibility(true);
  for(let i=0;i<100;i++)editor.state.draft.cardAppearance.dark.backgroundOpacity=i;await settle();expect(requests().length===0,'hidden editor applies a pending or changed draft');
  visibility(false);editor.state.draft.cardAppearance.dark.backgroundOpacity=88;await settle();expect(requests().length===1&&requests()[0].cardAppearance.dark.backgroundOpacity===88&&paintedCard()===cardCssVariables(editor.state.draft.cardAppearance.dark)['--te-card-bg'],'visibility restore applies stale or duplicate drafts');
  await editor.fullPreview(false);visibility(true);clear();await editor.fullPreview(true);editor.state.draft.cardAppearance.dark.backgroundOpacity=64;await settle();expect(requests().length===0,'enabling a hidden full preview still runs the theme engine');visibility(false);await settle();expect(requests().length===1&&requests()[0].cardAppearance.dark.backgroundOpacity===64,'hidden full preview cannot resume its latest draft');
  clear();window.failPreview=true;editor.state.draft.cardAppearance.dark.backgroundOpacity=65;await settle();expect(editor.state.error.includes('预览失败示例')&&editor.hasChanges.value,'preview failure hides its error or discards the draft');window.failPreview=false;editor.state.draft.cardAppearance.dark.backgroundOpacity=66;await settle();expect(!editor.state.error&&requests().at(-1).cardAppearance.dark.backgroundOpacity===66,'failed preview cannot retry with the preserved draft');
  clear();editor.selectMaterial('transparent');await nextTick();await editor.fullPreview(false);await settle();expect(requests().length===0&&document.documentElement.dataset.teSurfaceMaterial===confirmed.surfaceMaterial,'closing full preview reapplies a pending transient theme');
  await editor.fullPreview(true);await settle();clear();editor.selectMaterial('frosted');await nextTick();await editor.cancel();await settle();expect(requests().length===0&&!editor.hasChanges.value&&writes.length===before&&document.documentElement.dataset.teSurfaceMaterial===confirmed.surfaceMaterial,'cancel leaves pending theme work or loses its baseline');
  await editor.fullPreview(true);await settle();clear();editor.selectMaterial('transparent');await nextTick();failSave=true;await editor.save();await settle();expect(requests().length===0&&editor.hasChanges.value&&editor.state.draft.surfaceMaterial==='transparent'&&editor.state.error.includes('保存失败示例')&&writes.length===before,'failed save loses the pending draft or reapplies preview');failSave=false;await editor.save();await settle();expect(writes.length===before+1&&!editor.hasChanges.value&&confirmed.surfaceMaterial==='transparent'&&!appearanceFullWindowPreview.value,'save retry fails to commit once or clear preview');
  await editor.fullPreview(true);await settle();clear();editor.selectMaterial('theme');await nextTick();await editor.save();await settle();expect(requests().length===0&&writes.length===before+2&&!editor.hasChanges.value&&document.documentElement.dataset.teSurfaceMaterial===confirmed.surfaceMaterial,'successful save is overwritten by its pending preview');
  await editor.fullPreview(true);await settle();clear();editor.selectMaterial('transparent');await nextTick();probe.unmount();await settle();expect(requests().length===0&&!appearanceFullWindowPreview.value&&document.documentElement.dataset.teSurfaceMaterial===confirmed.surfaceMaterial,'unmounted editor reapplies temporary appearance');
 }finally{window.failPreview=false;failSave=false;probe.unmount();host.remove();if(visibilityDescriptor)Object.defineProperty(document,'hidden',visibilityDescriptor);else delete document.hidden}
 const historyHost=document.createElement('div');document.body.append(historyHost);const draft=ref(cloneAppearance(confirmed));draft.value.cardAppearance.dark.backgroundOpacity=20;let history;
 const serialize=JSON.stringify;let serializations=0;JSON.stringify=(value,...args)=>{if(value===draft.value)serializations++;return serialize(value,...args)};
 const historyProbe=createApp({setup(){history=useAppearanceHistory(()=>draft.value,value=>draft.value=value);return()=>h('div')}});historyProbe.mount(historyHost);
 try{
  const initial=serializations;history.reset();expect(serializations===initial,'reset repeats serialization of the unchanged baseline');draft.value.cardAppearance.dark.backgroundOpacity=21;expect(history.canUndo.value,'synchronous draft has no undo');const pending=serializations;history.reset();expect(serializations===pending&&!history.canUndo.value,'pending/reset cannot reuse the same draft snapshot');draft.value.cardAppearance.dark.backgroundOpacity=22;expect(history.canUndo.value,'second draft has no undo');const captured=serializations;history.undo();expect(serializations===captured&&draft.value.cardAppearance.dark.backgroundOpacity===21,'synchronous undo serializes the same pending snapshot again or loses its baseline');history.redo();expect(draft.value.cardAppearance.dark.backgroundOpacity===22,'redo does not restore synchronous adjustment');
 }finally{JSON.stringify=serialize}
 try{
  draft.value.cardAppearance.dark.backgroundOpacity=20;history.reset();draft.value.cardAppearance.dark.backgroundOpacity=21;await new Promise(resolve=>setTimeout(resolve,80));draft.value.cardAppearance.dark.backgroundOpacity=22;await new Promise(resolve=>setTimeout(resolve,100));draft.value.cardAppearance.dark.backgroundOpacity=23;await new Promise(resolve=>setTimeout(resolve,210));history.undo();expect(draft.value.cardAppearance.dark.backgroundOpacity===20&&!history.canUndo.value&&history.canRedo.value,'180ms slider gesture becomes multiple history steps');history.redo();expect(draft.value.cardAppearance.dark.backgroundOpacity===23,'gesture redo loses its last slider value');
  draft.value.cardAppearance.dark.backgroundOpacity=0;history.reset();for(let i=1;i<=60;i++){draft.value.cardAppearance.dark.backgroundOpacity=i;history.undo();history.redo()}let undos=0;while(history.canUndo.value&&undos<70){history.undo();undos++}expect(undos===49&&draft.value.cardAppearance.dark.backgroundOpacity===11,'history is unbounded or discards the wrong oldest snapshot');
 }finally{historyProbe.unmount();historyHost.remove()}
}
`
