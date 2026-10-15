import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('contextual theme properties preserve draft history and structural values in the shared canvas toolbar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-studio-context-'))
  const artifactDirectory = process.env.TWILIGHT_CONTEXT_ARTIFACT_DIR
    ? resolve(process.env.TWILIGHT_CONTEXT_ARTIFACT_DIR)
    : undefined
  try {
    if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true })
    const pagePath = resolve('src/renderer/src/components/AppearancePage.vue')
    const { descriptor } = parse(await readFile(pagePath, 'utf8'), { filename: pagePath })
    const compiled = compileStyle({
      source: descriptor.styles.find((entry) => entry.scoped)!.content,
      filename: pagePath,
      id: 'data-v-context-probe',
      scoped: true
    })
    assert.deepEqual(compiled.errors, [])
    await writeFile(join(directory, 'page.css'), compiled.code)
    const iconFixture = await readFile(resolve('scripts/fixtures/theme-icon-settings.mjs'), 'utf8')
    await writeFile(
      join(directory, 'entry.ts'),
      runtime +
        iconFixture.replace('export function registerIconTests', 'function registerIconTests') +
        '\nregisterIconTests({page,active,tick,until,expect,choose,setPart});'
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'studio-context-boundaries',
          enforce: 'pre',
          resolveId(source, importer) {
            if (source.endsWith('/stores/useThemeStore')) return '\0context-theme-store'
            if (source.endsWith('/stores/useSettingsStore')) return '\0context-settings'
            if (source.endsWith('/extensions/registry')) return '\0context-registry'
            if (source.endsWith('/app/useBackStack')) return '\0context-back-stack'
            if (
              importer?.includes('ThemeStudioPage.vue') &&
              /\/(SongList|EqualizerPage|LocalHome|PlayerBar|PlayingMusic|SideMenu|TitleBar)\.vue$/.test(
                source
              )
            )
              return '\0context-unused-preview'
            return null
          },
          load(id) {
            if (id === '\0context-unused-preview') return 'export default {render:()=>null}'
            if (id === '\0context-back-stack')
              return 'export const useBackHandlerWhileMounted=()=>()=>{}'
            if (id === '\0context-registry')
              return "import {ref} from 'vue';export const useExtensionRegistry=()=>({themeContributions:ref([]),syncExtensions:async()=>{}})"
            if (id === '\0context-settings')
              return "import {ref} from 'vue';export const useSettingsStore=()=>({settings:ref({}),updateSettings:async()=>{window.commits.settings++}})"
            if (id === '\0context-theme-store') return storeFixture
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'StudioContextFixture',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<link rel="stylesheet" href="page.css"><style>body{margin:0;background:#17181a}#app{margin:24px;width:calc(100vw - 48px)}.appearance-page{position:static!important;display:block!important;overflow:visible!important}.appearance-floating-host{height:220px;overflow:hidden}</style></head><body><div id="app" class="appearance-page" data-appearance-workspace="customize" data-v-context-probe><div id="mount" class="appearance-floating-host" data-v-context-probe></div></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /STUDIO_CONTEXT_OK/)
    const metrics = JSON.parse(result.stdout.match(/STUDIO_CONTEXT_METRICS (.*)/)![1])
    assert.equal(metrics.draftHistory, true)
    assert.equal(metrics.geometryPreserved, true)
    assert.equal(metrics.imageBinding, true)
    assert.equal(metrics.metadataDoesNotPreview, true)
    assert.equal(metrics.outsideFocusPreserved, true)
    assert.equal(metrics.nativeKeyboard, true)
    assert.equal(metrics.layoutCases.length, 6)
    assert.equal(metrics.icons.uploadRestoreHistory, true)
    assert.equal(metrics.icons.applyDiscard, true)
    assert.equal(metrics.icons.cancelFailurePreserveDraft, true)
    assert.equal(metrics.icons.busyAndStaleProtected, true)
    assert.equal(metrics.iconLayoutCases.length, 18)
    console.info('Studio contextual properties:', JSON.stringify(metrics))
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-studio-context-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const storeFixture = `
import {ref,computed} from 'vue';
import {normalizeThemeProfile,TWILIGHT_DEFAULT_THEME_ID} from '@shared/theme.ts';
const saving=ref(false),error=ref(''),activeTheme=ref({kind:'builtin',id:TWILIGHT_DEFAULT_THEME_ID}),profiles=ref([]);
const snapshot=computed(()=>({data:{profiles:profiles.value,activeTheme:activeTheme.value,profileHistory:{},windowInheritance:{}}}));
const store={profiles,activeTheme,saving,error,snapshot,effectiveVariables:ref({}),load:async()=>{},setPreviewTone:async()=>{},previewTheme:async()=>{},
preview:async value=>{if(value){window.previewCalls++;window.lastPreview=JSON.parse(JSON.stringify(value))}},
createProfile:(name,source)=>{const profile=normalizeThemeProfile({schemaVersion:2,id:'user:'+crypto.randomUUID(),name,description:'',baseThemeId:source?.baseThemeId??source?.id??TWILIGHT_DEFAULT_THEME_ID,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),overrides:{pureWhite:{},dark:{'shape.globalRadius':'23px','playback.control.radius':'31px','library.coverRadius':'21px','typography.bodySize':'18px'}},modes:{navigation:{iconScale:'lg'}},windowDefaults:{miniPlayer:{cornerRadius:29}}});window.createdDraft=JSON.parse(JSON.stringify(profile));return profile},
saveProfile:async value=>{window.commits.saveAttempts++;if(window.failSave)throw Error('Context save failed');const saved=normalizeThemeProfile(JSON.parse(JSON.stringify(value)));if(!saved)throw Error('invalid fixture profile');profiles.value=[saved];window.commits.saved.push(saved);return snapshot.value},
setActive:async value=>{window.commits.activations++;activeTheme.value=value;return snapshot.value},
importAsset:async(profileId,type)=>{window.assetRequests.push({profileId,type});if(window.iconImportMode==='deferred')return new Promise((resolve,reject)=>{window.resolveIconImport=resolve;window.rejectIconImport=reject});if(window.iconImportMode==='cancel')return null;if(window.iconImportMode==='fail')throw Error('Icon import failed');if(window.iconImportMode==='jpeg')return {id:'unsupported-icon',path:'assets/icon.jpg',type:'image'};if(window.iconImportMode==='png')return {id:'uploaded-icon',path:'assets/icon.png',type:'image'};return {id:'context-image',path:'assets/context-background.png',type:'image'}}};
export const useThemeStore=()=>store;
`

const runtime = `
import {createApp,h,nextTick,ref} from 'vue';
import {useEscapeToClose} from '@renderer/app/useDismissLayer';
import Page from '@renderer/components/ThemeStudioPage.vue';
import {isStudioTokenEditable,parseStudioColor} from '@renderer/components/theme-studio/themeVisualControls.ts';
import {readThemeStudioRecovery} from '@renderer/components/theme-studio/themeStudioRecovery.ts';
import '@renderer/assets/base.css';
import '@renderer/components/settings-page/SettingsPage.css';
import '@renderer/components/settings-page/BackgroundAppearanceCustomizer.css';
window.commits={saveAttempts:0,saved:[],activations:0,settings:0};window.assetRequests=[];window.failSave=false;window.lastPreview=undefined;window.previewCalls=0;
const expect=(value,message)=>{if(!value)throw Error(message)};
const tick=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(resolve));await nextTick()};
const until=async(predicate,message)=>{const end=performance.now()+4000;while(!predicate()){if(performance.now()>end)throw Error(message);await tick()}};
const page=ref(),part=ref('background'),domain=ref('personalization'),active=ref(true);
window.outerEscapeCount=0;
createApp({setup(){useEscapeToClose(()=>true,()=>window.outerEscapeCount++);return()=>h(Page,{ref:page,embedded:true,unified:true,controlsOnly:true,contextual:true,active:active.value,part:part.value,initialDomain:domain.value,initialKey:'preset:builtin:twilight-echo-default',onDomainChange:value=>domain.value=value})}}).mount('#mount');
const input=async(element,value)=>{element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));await tick()};
const choose=async(name,value)=>{const element=document.querySelector('[aria-label="'+name+'"]');expect(element,'missing '+name);element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));await tick()};
const setPart=async value=>{part.value=value;await tick()};
const geometry=()=>{const draft=window.lastPreview??window.createdDraft;return {radius:draft.overrides.dark['shape.globalRadius'],playerRadius:draft.overrides.dark['playback.control.radius'],libraryRadius:draft.overrides.dark['library.coverRadius'],iconScale:draft.modes.navigation?.iconScale,windowRadius:draft.windowDefaults?.miniPlayer?.cornerRadius}};
let baselineGeometry;
window.contextTests=async()=>{
 await until(()=>page.value&&!page.value.state.busy&&window.createdDraft,'actual studio never initializes');baselineGeometry=JSON.stringify(geometry());
 expect(!document.querySelector('.theme-studio-workspace,.theme-preview-pane,iframe')&&document.querySelector('.studio-context-bar'),'contextual mode mounts a permanent editor or second preview');
 domain.value='presets';await tick();await page.value.openTools();await tick();
 const name=document.querySelector('.theme-name-input'),originalName=name.value,previewCount=window.previewCalls;await choose('主题名称','Renamed without visual work');await new Promise(resolve=>setTimeout(resolve,550));
 expect(name.value==='Renamed without visual work'&&page.value.state.canUndo&&readThemeStudioRecovery()?.draft.name==='Renamed without visual work'&&window.previewCalls===previewCount,'name edit loses recovery/history or unnecessarily rebuilds the visual preview');
 await page.value.perform('undo');await tick();expect(name.value===originalName,'metadata undo loses the original name');await page.value.perform('redo');await tick();expect(name.value==='Renamed without visual work','metadata redo loses the renamed draft');
 document.querySelector('.studio-context-more').click();domain.value='personalization';await tick();
 const footprint=JSON.stringify(window.commits),color=document.querySelector('[aria-label="内框背景颜色"]');await input(color,'#345678');await until(()=>window.lastPreview.overrides.dark['surface.app']==='#345678','context color never reaches actual draft preview');
 expect(page.value.state.hasUnsavedChanges&&page.value.state.canUndo&&JSON.stringify(window.commits)===footprint,'context color commits or loses draft history');
 await page.value.perform('undo');await until(()=>window.lastPreview.overrides.dark['surface.app']!=='#345678','context undo does not restore prior draft');await page.value.perform('redo');await until(()=>window.lastPreview.overrides.dark['surface.app']==='#345678','context redo does not restore color');
 await choose('选中背景样式','image');const imageButton=[...document.querySelectorAll('.studio-context-material button')].find(element=>element.textContent==='选择图片');expect(imageButton,'contextual image import is inaccessible');imageButton.click();await until(()=>window.lastPreview.assets?.some(asset=>asset.id==='context-image'),'imported image does not enter the actual draft');await choose('主题背景图片','context-image');await until(()=>window.lastPreview.assetBindings?.appBackground==='context-image','selected image does not bind to the current background');expect(window.assetRequests.length===1&&window.assetRequests[0].profileId===window.lastPreview.id&&JSON.stringify(window.commits)===footprint,'image import saves settings or loses the current project');
 await page.value.perform('undo');await until(()=>!window.lastPreview.assetBindings?.appBackground&&window.lastPreview.assets?.length===1,'image binding undo removes the resource or retains the binding');await page.value.perform('redo');await until(()=>window.lastPreview.assetBindings?.appBackground==='context-image','image binding redo is detached');await choose('选中背景样式','solid');
 const primary=document.querySelector('.studio-context-adjustment input[type=range]');await input(primary,'27');await until(()=>window.lastPreview.overrides.dark['background.overlayOpacity']==='27%','direct background adjustment misses its actual token');await page.value.perform('undo');await until(()=>window.lastPreview.overrides.dark['background.overlayOpacity']!=='27%','direct adjustment undo loses history');await page.value.perform('redo');await until(()=>window.lastPreview.overrides.dark['background.overlayOpacity']==='27%','direct adjustment redo loses history');
 const confirm=window.confirm;window.confirm=()=>false;expect(!await page.value.prepareLeave()&&page.value.state.hasUnsavedChanges,'denied leave discards contextual draft');window.confirm=confirm;
 for(const selected of ['personalization','shell','navigation','library','typography','player','windows','motion','advanced']){
  domain.value=selected;await tick();await page.value.openTools();await tick();
  const pane=document.querySelector('.theme-studio-workspace');expect(pane,'openTools does not expose requested category');
  expect([...pane.querySelectorAll('[data-studio-setting]')].every(element=>isStudioTokenEditable(element.dataset.studioSetting)&&element.dataset.studioSetting!=='navigation.iconScale'),'structural geometry remains reachable in '+selected);
  expect(!pane.textContent.includes('圆角'),'window or token radius survives UI filtering in '+selected);
  if(selected==='typography')expect(pane.querySelector('[data-studio-setting="typography.bodySize"]'),'accessible text sizing was removed '+JSON.stringify({domain:domain.value,controls:[...pane.querySelectorAll('[data-studio-setting]')].map(element=>element.dataset.studioSetting)}));
  if(selected==='navigation'||selected==='windows'||selected==='personalization'){await page.value.perform('reset');await until(()=>JSON.stringify(geometry())===baselineGeometry,'local reset changes hidden geometry')}
 }
 expect(JSON.stringify(geometry())===baselineGeometry&&JSON.stringify(window.commits)===footprint,'UI disclosure/filtering resets old geometry or saves settings');
 await setPart('player-bar');expect(!document.querySelector('.theme-studio-workspace'),'part change leaves stale tools visible');await choose('选中播放按钮样式','pro');await until(()=>window.lastPreview.modes.player?.controls==='pro','player style is detached from draft');
 await setPart('navigation');const navigationInput=document.querySelector('[aria-label="侧边栏颜色"]');await input(navigationInput,'#465768');await until(()=>parseStudioColor(window.lastPreview.overrides.dark['navigation.surface']??'')?.hex==='#465768','navigation color does not reach the selected token');
 const navOpacity=document.querySelector('.studio-context-adjustment input[type=range]');await input(navOpacity,'36');await until(()=>parseStudioColor(window.lastPreview.overrides.dark['navigation.surface']??'')?.opacity===36,'direct navigation opacity is detached from the actual color');expect(parseStudioColor(window.lastPreview.overrides.dark['navigation.surface']).hex==='#465768','opacity edit changes the selected color');
 await setPart('card');await choose('选中卡片模糊材质','0');await until(()=>window.lastPreview.overrides.dark['material.cardBlur']==='0px','card material selector uses a fake field');await input(document.querySelector('.studio-context-adjustment input[type=range]'),'9');await until(()=>window.lastPreview.overrides.dark['material.cardBlur']==='9px','direct card blur uses a fake field');expect(JSON.stringify(geometry())===baselineGeometry,'direct card material edits hidden structure');
 await setPart('navigation');domain.value='navigation';await tick();await page.value.openTools();await tick();expect(document.querySelector('[data-studio-setting="navigation.logo"]'),'navigation functional controls were removed with sizing');
 const held=JSON.stringify(window.lastPreview);active.value=false;await tick();expect(!document.querySelector('.appearance-popover')&&JSON.stringify(window.lastPreview)===held,'inactive creator leaves portal controls or loses draft');await page.value.openTools();await tick();expect(!document.querySelector('.appearance-popover'),'inactive creator reopens portal controls');active.value=true;await tick();
 await setPart('background');await input(document.querySelector('[aria-label="内框背景颜色"]'),'#456789');await until(()=>window.lastPreview.overrides.dark['surface.app']==='#456789','second context edit did not preview');
 window.failSave=true;await page.value.perform('apply');expect(page.value.state.error.includes('Context save failed')&&page.value.state.hasUnsavedChanges&&JSON.stringify(geometry())===baselineGeometry,'failed apply clears dirty draft or retained structural values');
 window.failSave=false;await page.value.perform('apply');expect(window.commits.saved.length===1&&window.commits.activations===1&&window.commits.settings===0&&!page.value.state.hasUnsavedChanges,'context retry does not save/apply once');expect(JSON.stringify(geometry())===baselineGeometry,'successful save normalizes hidden geometry away');
 return {draftHistory:true,geometryPreserved:true,imageBinding:true,metadataDoesNotPreview:true};
};
window.contextLayout=async currentTone=>{
 document.documentElement.dataset.theme=currentTone==='dark'?'dark':'pureWhite';await setPart('navigation');await setPart('background');
 const bar=document.querySelector('.studio-context-bar'),rect=bar.getBoundingClientRect(),color=bar.querySelector('.studio-context-colors').getBoundingClientRect(),media=bar.querySelector('.studio-context-material').getBoundingClientRect(),other=bar.querySelector('.studio-context-more').getBoundingClientRect();
 expect(rect.width<=400.1&&rect.width>=320&&rect.right<=innerWidth-24+0.1&&rect.height<=100&&bar.scrollWidth<=bar.clientWidth,'context floating toolbar clips or fills the canvas at '+innerWidth+' '+JSON.stringify(rect.toJSON()));
 expect(color.right<=media.left&&media.right<=other.left,'context direct groups overlap or reorder');
 expect(!bar.querySelector('.studio-context-title')&&bar.querySelectorAll('input[type=range]').length===1&&getComputedStyle(bar).fontSize==='15px'&&bar.querySelector('input[type=color]').getBoundingClientRect().height>=34&&other.height>=34,'context direct fields lose readability, hit targets, or progressive disclosure');
 const beforeHeight=rect.height;await page.value.openTools();await tick();const popup=document.querySelector('.theme-studio-workspace'),portal=document.querySelector('.appearance-popover'),box=portal.getBoundingClientRect(),style=getComputedStyle(popup);
 expect(box.left>=rect.right||box.right<=rect.left||box.top>=rect.bottom||box.bottom<=rect.top,'context details cover the direct toolbar '+JSON.stringify({bar:rect.toJSON(),popup:box.toJSON()}));
 expect(getComputedStyle(portal).position==='fixed'&&style.backgroundColor===getComputedStyle(bar).backgroundColor&&getComputedStyle(portal).backdropFilter==='none'&&box.left>=12&&box.right<=innerWidth-12+0.1&&box.bottom<=innerHeight-12+0.1&&!document.querySelector('.appearance-floating-host').contains(portal)&&bar.getBoundingClientRect().height===beforeHeight,'context details lose solid neutral backing, portal bounds, or reserve canvas space');
 expect(getComputedStyle(popup.querySelector('.theme-editor-pane')).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(popup.querySelector('.studio-control-section')).backgroundColor==='rgba(0, 0, 0, 0)','context details introduce nested card backplates');
 popup.querySelector('input,select,button')?.focus();const draftBeforeEscape=JSON.stringify(window.lastPreview);popup.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();expect(!document.querySelector('.theme-studio-workspace')&&document.activeElement===document.querySelector('.studio-context-more')&&JSON.stringify(window.lastPreview)===draftBeforeEscape,'Escape leaves context tools open, drops focus or mutates the draft');
 return {tone:currentTone,windowWidth:innerWidth,windowHeight:innerHeight,width:rect.width,height:rect.height,popupWidth:box.width,solid:true,portal:true,directSliders:1};
};
window.contextNarrow=async()=>{const host=document.querySelector('.appearance-floating-host');host.style.width='320px';host.style.setProperty('--te-control-font-size','18px');host.style.setProperty('--te-font-size-body','18px');await setPart('navigation');await setPart('background');const bar=document.querySelector('.studio-context-bar'),rect=bar.getBoundingClientRect();expect(rect.width===320&&bar.scrollWidth<=bar.clientWidth&&Math.abs(parseFloat(getComputedStyle(bar).fontSize)-18*15/14)<.1,'context tools overflow available space or shrink accessible text');for(const control of bar.querySelectorAll('button,select,input')){const bounds=control.getBoundingClientRect();expect(bounds.width===0||(bounds.left>=rect.left&&bounds.right<=rect.right+0.1),'context direct control overflows available space')};await page.value.openTools();await tick();expect(Math.abs(parseFloat(getComputedStyle(document.querySelector('.studio-context-popup')).fontSize)-18*15/14)<.1,'context portal drops accessible text size');document.querySelector('.studio-context-more').click();await tick();host.style.removeProperty('--te-control-font-size');host.style.removeProperty('--te-font-size-body');return {width:rect.width,height:rect.height,accessibleFontSize:18}};
window.prepareContextKeyboard=async()=>{await setPart('navigation');await setPart('background');document.querySelector('.studio-context-more').focus()};
window.prepareContextIllustration=async()=>{await page.value.openTools();await tick()};
window.finishContextKeyboard=async()=>{await tick();const button=document.querySelector('.studio-context-more');expect(button.getAttribute('aria-expanded')==='true'&&document.querySelector('.theme-studio-workspace'),'native Enter does not reveal context tools');expect(getComputedStyle(document.activeElement).outlineStyle==='solid','context controls lack keyboard focus');button.focus();};
window.finishContextEscape=async()=>{await tick();expect(!document.querySelector('.theme-studio-workspace')&&document.activeElement===document.querySelector('.studio-context-more')&&window.outerEscapeCount===0,'native Escape closes the parent selection instead of only the tools');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();expect(window.outerEscapeCount===1,'second Escape does not reach the parent after tools close')};
let nativeName,nativeDraft;
window.prepareContextNativeText=async()=>{domain.value='presets';await tick();await page.value.openTools();await tick();const input=document.querySelector('.theme-name-input');expect(input,'theme name text input cannot be reached through tools');nativeName=input.value;nativeDraft=JSON.stringify(window.lastPreview);input.focus();input.select()};
window.finishContextNativeText=async()=>{await tick();expect(document.querySelector('.theme-name-input').value===nativeName&&JSON.stringify(window.lastPreview)===nativeDraft,'native text undo edits the theme history or loses the input value')};
window.prepareContextOutside=async()=>{await page.value.openTools();await tick();const button=document.createElement('button');button.id='outside-context-control';button.textContent='外部控件';button.style.cssText='position:fixed;top:8px;right:8px;width:80px;height:34px';document.body.append(button);const rect=button.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}};
window.finishContextOutside=async()=>{await tick();const button=document.querySelector('#outside-context-control');expect(!document.querySelector('.appearance-popover')&&document.activeElement===button,'outside pointer dismissal steals focus back from the clicked control');button.remove()};
`

const runner = `
const {app,BrowserWindow,protocol}=require('electron'),path=require('node:path'),fs=require('node:fs');app.setPath('userData',path.join(__dirname,'profile'));protocol.registerSchemesAsPrivileged([{scheme:'theme-asset',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.whenReady().then(async()=>{
 protocol.handle('theme-asset',()=>new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=','base64'),{headers:{'content-type':'image/png'}}));
 const win=new BrowserWindow({show:false,width:1280,height:720,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});win.webContents.on('console-message',event=>console.error(event.message));
 try{
  await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const result=await win.webContents.executeJavaScript('window.contextTests()'),icons=await win.webContents.executeJavaScript('window.iconTests()'),layoutCases=[],iconLayoutCases=[];
  for(const [width,height] of [[1280,720],[760,480],[521,400]]){win.setContentSize(width,height);for(const tone of ['dark','light']){
   layoutCases.push(await win.webContents.executeJavaScript('window.contextLayout('+JSON.stringify(tone)+')'));
   for(const font of [14,20,28])iconLayoutCases.push(await win.webContents.executeJavaScript('window.iconLayout('+JSON.stringify(tone)+','+font+')'));
   if(process.env.TWILIGHT_CONTEXT_ARTIFACT_DIR){fs.writeFileSync(path.join(process.env.TWILIGHT_CONTEXT_ARTIFACT_DIR,'studio-'+tone+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());await win.webContents.executeJavaScript('window.prepareContextIllustration()');fs.writeFileSync(path.join(process.env.TWILIGHT_CONTEXT_ARTIFACT_DIR,'studio-'+tone+'-'+width+'-expanded.png'),(await win.webContents.capturePage()).toPNG())}
  }}
  const narrow=await win.webContents.executeJavaScript('window.contextNarrow()');
  await win.webContents.executeJavaScript('window.prepareIconKeyboard()');await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\\r',unmodifiedText:'\\r'});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await win.webContents.executeJavaScript('window.finishIconKeyboard()');await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await win.webContents.executeJavaScript('window.finishIconEscape()');
  await win.webContents.executeJavaScript('window.prepareContextKeyboard()');await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\\r',unmodifiedText:'\\r'});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await win.webContents.executeJavaScript('window.finishContextKeyboard()');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await win.webContents.executeJavaScript('window.finishContextEscape()');
  await win.webContents.executeJavaScript('window.prepareContextNativeText()');await win.webContents.debugger.sendCommand('Input.insertText',{text:'Native theme text'});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2});await win.webContents.executeJavaScript('window.finishContextNativeText()');
  const outside=await win.webContents.executeJavaScript('window.prepareContextOutside()');for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...outside,button:'left',clickCount:1});await win.webContents.executeJavaScript('window.finishContextOutside()');
  console.log('STUDIO_CONTEXT_METRICS',JSON.stringify({...result,icons,nativeKeyboard:true,outsideFocusPreserved:true,layoutCases,iconLayoutCases,narrow}));console.log('STUDIO_CONTEXT_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});
`
