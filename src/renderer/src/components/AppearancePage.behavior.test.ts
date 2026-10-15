import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { APPEARANCE_PARTS, resolveAppearancePart } from './appearanceParts.ts'

const require = createRequire(import.meta.url)
test('inner background is one discoverable target and old background navigation remains compatible', () => {
  assert.equal(APPEARANCE_PARTS.filter((part) => part.id === 'background').length, 0)
  assert.equal(APPEARANCE_PARTS.find((part) => part.id === 'inner-panel')?.label, '内框背景')
  assert.equal(APPEARANCE_PARTS.find((part) => part.id === 'outer-panel')?.label, '外框')
  assert.equal(resolveAppearancePart('background'), 'inner-panel')
  assert.equal(resolveAppearancePart('inner-panel'), 'inner-panel')
  assert.equal(resolveAppearancePart('player-bar'), 'player-bar')
})
test('unified appearance workspace keeps discoverable theme operations and independent drafts', async () => {
  const directory = await mkdtemp(join(require('node:os').tmpdir(), 'twilight-appearance-tabs-'))
  try {
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    await writeFile(
      join(directory, 'entry.ts'),
      (await readFile(resolve('scripts/fixtures/appearance-page.mjs'), 'utf8')).replaceAll(
        '__RENDERER__',
        renderer
      )
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'appearance-test-boundaries',
          enforce: 'pre',
          resolveId(source) {
            const child = source.match(
              /\/(AppearanceSettingsSection|AppearanceThemeShelf|AppearanceWindowPreview|ThemeStudioPage|ThemeWorkshopPage)\.vue$/
            )?.[1]
            if (child) return '\0appearance-child:' + child
            if (source.endsWith('/extensions/registry')) return '\0appearance-registry'
            if (source.endsWith('/stores/useThemeStore')) return '\0appearance-theme-store'
            if (source.endsWith('/stores/useSettingsStore')) return '\0appearance-settings'
            if (source.endsWith('/app/scrollMotion.ts')) return '\0appearance-motion'
            return null
          },
          load(id) {
            if (id === '\0appearance-registry')
              return `import {ref} from 'vue';export const contributions=ref([{pluginId:'com.twilightecho.tool.theme-workshop',id:'theme-workshop'}]);export const syncExtensions=async()=>{};export const useExtensionRegistry=()=>({uiContributions:contributions,syncExtensions,themeContributions:ref([{pluginId:'plugin.one',id:'theme',name:'Installed theme'}])});`
            if (id === '\0appearance-theme-store') return themeStoreBoundary
            if (id === '\0appearance-settings')
              return "import {ref} from 'vue';const settings=ref({});export const useSettingsStore=()=>({settings,loadSettings:async()=>{}})"
            if (id === '\0appearance-motion') return 'export const scrollMotionBehavior=()=>"auto"'
            if (id.startsWith('\0appearance-child:')) {
              const name = id.split(':')[1]
              if (name === 'AppearanceWindowPreview') return previewBoundary
              if (name === 'AppearanceSettingsSection') return appearanceSettingsBoundary(renderer)
              return `import {ref,computed} from 'vue';export default {props:['initialKey','initialProjectId','initialSourceKey','initialDomain','initialGroup','unified','contextual','part','controlsOnly'],setup(props,ctx){const key=ref('${name}'==='ThemeStudioPage'?props.initialKey:'workshop:'+ (props.initialProjectId??'project-one'));const tone=ref('dark'),dirty=ref(false),error=ref('');window.editorRefs['${name}']={key,tone,dirty,error};const state=computed(()=>({key:key.value,tone:tone.value,busy:false,canUndo:true,canRedo:true,canReset:true,canExport:true,canApply:true,status:'Preview',dirty:dirty.value,hasUnsavedChanges:dirty.value,error:error.value}));if(props.initialSourceKey)window.customizedSource=props.initialSourceKey;ctx.expose({state,openTools:async()=>window.actions.push({editor:'${name}',action:'tools'}),selectGroup:()=>{},projects:ref([{id:'project-one',name:'Project one'}]),customGroups:ref(['Custom control']),selectKey:async value=>{key.value='${name}'==='ThemeStudioPage'?value:'workshop:'+value;dirty.value=false;error.value=''},setTone:value=>tone.value=value,perform:async action=>{window.actions.push({editor:'${name}',action});error.value='';if(action==='duplicate'){key.value='profile:new-draft';dirty.value=true}if(action==='apply'&&window.failCreationSave)error.value='theme save failed';else if(action==='apply')dirty.value=false},collapse:async()=>false,discard:async()=>{dirty.value=false},prepareLeave:async()=>{window.leaveCalls.push('${name}');return window.allowLeave['${name}']!==false}});return {props}},template:'<div class="fixture-${name}"><button data-context-field>{{props.part}}</button><span class="fixture-domain">{{props.initialDomain||props.initialGroup}}</span></div>'}`
            }
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'AppearanceFixture',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<style>:root{--te-primary-500:#2563eb;--te-control-accent:#2563eb}body{margin:0;background:#f6f6f7}html[data-theme=dark] body{background:#18191b}.fixture-AppearanceSettingsSection{display:flex;flex:1;min-height:0;flex-direction:column}.fixture-AppearanceWindowPreview{position:relative;display:flex;align-items:flex-end;gap:8px;flex:1;min-height:140px;padding:12px;box-sizing:border-box}.fixture-scene-placeholder{position:absolute;inset:12px 12px 52px;border-radius:8px;background:linear-gradient(135deg,#8881,#8883)}.fixture-AppearanceWindowPreview>button{position:relative}.fixture-ThemeStudioPage,.fixture-ThemeWorkshopPage{padding:12px}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 150_000 }
    )
    assert.match(result.stdout, /APPEARANCE_CAPABILITIES_OK/)
    assert.match(result.stdout, /APPEARANCE_MANAGEMENT_OK/)
    assert.match(result.stdout, /APPEARANCE_RESPONSIVE_CASES 70/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(require('node:os').tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-appearance-tabs-'))
    await rm(directory, { recursive: true, force: true })
  }
})

function appearanceSettingsBoundary(renderer: string): string {
  return `
import {ref} from 'vue';
import AppearanceWindowPreview from '${renderer}/components/AppearanceWindowPreview.vue';
import {registerSettingsDisclosure} from '${renderer}/components/settings-page/settingsDisclosureRegistry.ts';
export default {components:{AppearanceWindowPreview},props:{commit:null,themeHistory:null,externalToolbar:Boolean,active:Boolean},emits:['editTheme'],setup(props,ctx){
const playerOpen=ref(false),behaviorOpen=ref(false),preview=ref(),previewPart=ref('overview'),previewBusy=ref(false);
window.dailyRefs={preview,previewPart,previewBusy};
registerSettingsDisclosure('player-bar',()=>playerOpen.value=true);registerSettingsDisclosure('player-bar-behavior-details',()=>behaviorOpen.value=true);
window.dailyContexts.push({commit:props.commit,history:props.themeHistory,externalToolbar:props.externalToolbar});
const apply=async()=>{window.actions.push({editor:'AppearanceSettingsSection',action:'apply'});return window.allowApply!==false};
ctx.expose({preview,previewPart,previewBusy,resetView:()=>previewPart.value='overview',collapse:async()=>false,setTone:()=>{},discard:async()=>{},apply,prepareLeave:async()=>{window.leaveCalls.push('AppearanceSettingsSection');return window.allowLeave.AppearanceSettingsSection!==false},reveal:async entry=>{window.revealed=entry.id}});
return {playerOpen,behaviorOpen,preview,previewPart,apply,more:()=>ctx.emit('editTheme','player-bar')}
},template:'<div class="fixture-AppearanceSettingsSection"><AppearanceWindowPreview ref="preview" :active="active" :focused-region="previewPart" @region="previewPart=$event"/><button data-daily-apply @click="apply">应用外观</button><button data-daily-more @click="more">主题制作：播放栏</button><div v-show="playerOpen" :inert="!playerOpen" id="player-bar"><div v-show="behaviorOpen" :inert="!behaviorOpen" id="player-bar-behavior-details"><label data-setting-id="player-page-mode">播放页形态<select aria-label="播放页形态"><option>标准</option><option>紧凑</option></select></label></div></div></div>'}
`
}

const themeStoreBoundary = `
import {ref} from 'vue';
const defaultId='builtin:twilight-echo-default';
const initialProfile=()=>({schemaVersion:2,id:'personal',name:'Personal theme',description:'',baseThemeId:defaultId,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),overrides:{pureWhite:{},dark:{}},modes:{}});
const profiles=ref([initialProfile()]),activeTheme=ref({kind:'builtin',id:defaultId}),saving=ref(false),error=ref('');
const snapshot=ref({revision:0,data:{profiles:profiles.value,activeTheme:activeTheme.value,profileHistory:{},windowInheritance:{miniPlayer:false,desktopLyrics:false}}});
const accept=()=>snapshot.value={revision:snapshot.value.revision+1,data:{...snapshot.value.data,profiles:profiles.value,activeTheme:activeTheme.value}};
const plain=value=>JSON.parse(JSON.stringify(value));
const store={profiles,activeTheme,saving,error,snapshot,effectiveVariables:ref({}),load:async()=>{},setPreviewTone:async()=>{},previewTheme:async()=>{},preview:async()=>{},
createProfile:(name='自定义主题',source=null)=>{const derived=source?.id?.startsWith('builtin:');const profile={schemaVersion:2,id:'user:'+crypto.randomUUID(),name,baseThemeId:derived?source.id:source?.baseThemeId??defaultId,description:'',createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),overrides:{pureWhite:derived?{}:{...source?.overrides?.pureWhite},dark:derived?{}:{...source?.overrides?.dark}},modes:derived?{}:plain(source?.modes??{}),...(derived?{source:{kind:'builtin-preset',presetId:source.id}}:{})};window.themeCreates.push(plain(profile));return profile},
saveProfile:async profile=>{saving.value=true;window.saveAttempts++;window.themeMutations.push({kind:'save',id:profile.id,name:profile.name});try{if(window.holdSave)await new Promise(resolve=>window.releaseSave=resolve);if(window.failProfileSave)throw Error('profile save failed');const saved=plain(profile);window.realSaves.push(saved);profiles.value=[...profiles.value.filter(p=>p.id!==profile.id),saved];const result=accept();if(window.failPersistedSaveRuntime)throw Error('saved runtime failed');return result}finally{saving.value=false;window.releaseSave=undefined}},
deleteProfile:async id=>{saving.value=true;window.deleteAttempts++;window.themeMutations.push({kind:'delete',id});try{if(window.holdDelete)await new Promise(resolve=>window.releaseDelete=resolve);if(window.failDelete)throw Error('profile delete failed');if(id===defaultId||id.startsWith('builtin:'))throw Error('内置主题不能删除');if(!profiles.value.some(p=>p.id===id))throw Error('主题档案不存在');profiles.value=profiles.value.filter(p=>p.id!==id);if(activeTheme.value.kind==='user'&&activeTheme.value.id===id)activeTheme.value={kind:'builtin',id:defaultId};const result=accept();if(window.failDeletedRuntime)throw Error('deleted runtime failed');return result}finally{saving.value=false;window.releaseDelete=undefined}},
setActive:async value=>{saving.value=true;window.actions.push({editor:'ThemeSelection',action:'apply'});window.themeMutations.push({kind:'activate',selection:plain(value)});try{if(window.failActivation)throw Error('theme activation failed');activeTheme.value=plain(value);return accept()}finally{saving.value=false}}
};
export const useThemeStore=()=>store;
export function resetThemeFixture(){profiles.value=[initialProfile()];activeTheme.value={kind:'builtin',id:defaultId};snapshot.value={revision:0,data:{profiles:profiles.value,activeTheme:activeTheme.value,profileHistory:{},windowInheritance:{miniPlayer:false,desktopLyrics:false}}};saving.value=false;error.value=''}
`
const previewBoundary = `
import {ref,nextTick} from 'vue';
export default {props:['focusedRegion','active'],emits:['region'],setup(props,ctx){window.fixtureLegacyBackground=()=>ctx.emit('region','background');const id=++window.fixturePreviewCounter,navigationExpanded=ref(true),layeredView=ref(false),layerSpacing=ref(56),zoomInput=ref();const record=(action,value)=>window.previewCalls.push({id,action,value});ctx.expose({focusCameraZoom:async()=>{record('camera-focus');await nextTick();zoomInput.value?.focus()},zoomIn:()=>record('zoom-in'),zoomOut:()=>record('zoom-out'),fitPart:()=>record('fit'),navigationExpanded,toggleNavigation:()=>{navigationExpanded.value=!navigationExpanded.value;record('navigation',navigationExpanded.value)},layeredView,layerSpacing,setLayeredView:value=>{layeredView.value=!!value;record('layered',layeredView.value)},setLayerSpacing:value=>{layerSpacing.value=Math.max(0,Math.min(80,value));record('spacing',layerSpacing.value)}});return {props,id,navigationExpanded,layeredView,layerSpacing,zoomInput,restore:()=>{layeredView.value=false;record('layered',false)},card:()=>ctx.emit('region','card'),navigation:()=>ctx.emit('region','navigation'),player:()=>ctx.emit('region','player-bar')}},template:'<div style="position:relative" class="fixture-AppearanceWindowPreview appearance-window-preview" :data-preview-id="id" :data-selected="props.focusedRegion" :data-navigation-expanded="navigationExpanded" :data-layered-view="layeredView" :data-layer-spacing="layerSpacing"><span class="fixture-scene-placeholder" aria-hidden="true"></span><div class="fixture-context-anchor" style="position:absolute;top:12px;right:12px;max-width:calc(100% - 24px)"><slot name="context-tools"></slot></div><input v-if="layeredView" ref="zoomInput" type="range" aria-label="相机缩放" min=".35" max="4" step=".01"><button v-if="layeredView" aria-label="返回2D视图" @click="restore">2D</button><button data-preview-part="card" @click="card">选择卡片</button><button data-preview-part="navigation" @click="navigation">选择侧边栏</button><button data-preview-part="player-bar" @click="player">选择播放栏</button></div>'}
`
const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs/promises');app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{let win,currentCase;const output=process.env.TE_APPEARANCE_PAGE_QA_OUTPUT,manifest=[];try{
if(output)await fs.mkdir(output,{recursive:true});win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
for(const mode of ['dark','pureWhite']){const point=await win.webContents.executeJavaScript('window.checkEditorContrast('+JSON.stringify(mode)+')');await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await new Promise(r=>setTimeout(r,30));await win.webContents.executeJavaScript('window.checkEditorHover()')}
await win.webContents.executeJavaScript('window.checkEditorContrast("dark")');await win.webContents.executeJavaScript('window.fixture()');await win.webContents.executeJavaScript('window.managementFixture()');console.log('APPEARANCE_MANAGEMENT_OK');
const runCase=async(width,height,tone,mode,layered)=>{currentCase={width,height,tone,mode,layered};win.setContentSize(width,height);const result=await win.webContents.executeJavaScript('window.checkResponsiveCreation('+[mode,layered,tone].map(value=>JSON.stringify(value)).join(',')+')');const file=tone+'-'+mode+'-'+(layered?'3d':'2d')+'-'+width+'x'+height+'.png';if(output)await fs.writeFile(path.join(output,file),(await win.webContents.capturePage()).toPNG());manifest.push({...result,requestedWidth:width,requestedHeight:height,file});};
for(const [width,height] of [[1280,800],[1024,800],[760,720],[620,720],[521,720]])for(const tone of ['dark','pureWhite'])for(const mode of ['selection','adjust','studio','workshop'])for(const layered of (mode==='selection'?[false]:[false,true]))await runCase(width,height,tone,mode,layered);

if(output)await fs.writeFile(path.join(output,'page-management-visual-manifest.json'),JSON.stringify(manifest,null,2));await win.webContents.executeJavaScript('window.finishResponsive()');console.log('APPEARANCE_RESPONSIVE_CASES '+manifest.length);console.log('APPEARANCE_CAPABILITIES_OK');win.destroy();app.exit(0)
}catch(e){console.error('APPEARANCE_CASE '+JSON.stringify(currentCase));console.error(e);if(output&&win&&!win.isDestroyed()){await fs.writeFile(path.join(output,'failed-state.png'),(await win.webContents.capturePage()).toPNG());await fs.writeFile(path.join(output,'failed-case.json'),JSON.stringify(currentCase??{phase:'behavior'},null,2));}win?.destroy();app.exit(1)}});
`
