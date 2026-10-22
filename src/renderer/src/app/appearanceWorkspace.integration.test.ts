import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import ts from 'typescript'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('production shell connects the title button, draft guard and full-window layer preview', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-appearance-shell-'))
  try {
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    const source = await readFile(join(renderer, 'App.vue'), 'utf8')
    const { descriptor } = parse(source)
    const template = descriptor.template!.content
    const fragments = ['AppearanceLayersHost', 'TitleBar', 'AppearancePage'].map((tag) => {
      const fragment = template.match(new RegExp(`<${tag}\\b[\\s\\S]+?/>`))?.[0]
      assert.ok(fragment, `missing production ${tag} wiring`)
      return fragment
    })
    const setup = source.slice(
      source.indexOf('const appearancePageRef ='),
      source.indexOf('const navigationPersistence =')
    )
    assert.ok(setup.includes('guardAppearanceNavigation'), 'exercise the actual App guard setup')
    const store = await readFile(join(renderer, 'stores/useThemeStore.ts'), 'utf8')
    const preview = store
      .slice(
        store.indexOf('export async function previewAppearance('),
        store.indexOf('/**', store.indexOf('export async function previewAppearance('))
      )
      .replace('export async function', 'async function')
    const compile = (code: string) =>
      ts.transpileModule(code, {
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext }
      }).outputText
    await writeFile(
      join(directory, 'entry.js'),
      runtime
        .replaceAll('__RENDERER__', renderer)
        .replace('__SETUP__', compile(setup))
        .replace('__PREVIEW__', compile(preview))
        .replace('__TEMPLATE__', JSON.stringify(fragments.join('\n')))
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'appearance-shell-business-boundary',
          enforce: 'pre',
          resolveId(source) {
            return /\/(useNcmStore|useProviderStore|useAppNoticeStore)(?:\.ts)?$/.test(source)
              ? '\0shell-stores'
              : null
          },
          load(id) {
            if (id !== '\0shell-stores') return null
            return `import {ref} from 'vue';
            export const useNcmStore=()=>({isLoggedIn:ref(false),profile:ref(null)});
            export const useProviderStore=()=>({providers:ref([])});
            export const useAppNoticeStore=()=>({unreadCount:ref(0),activeTaskCount:ref(0),doNotDisturb:ref(false)});`
          }
        },
        vue()
      ],
      resolve: {
        alias: { '@renderer': renderer, vue: require.resolve('vue/dist/vue.esm-bundler.js') }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.js'),
          name: 'AppearanceShell',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}</head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `
      const {app,BrowserWindow}=require('electron'),path=require('node:path');
      app.setPath('userData',path.join(__dirname,'profile'));
      app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});
      try{await win.loadFile(path.join(__dirname,'index.html'));await win.webContents.executeJavaScript('window.runShellTests()');console.log('APPEARANCE_SHELL_OK');win.destroy();app.exit(0)}catch(error){console.error(error.stack);win.destroy();app.exit(1)}});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 45_000 }
    )
    assert.match(result.stdout, /APPEARANCE_SHELL_OK/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-appearance-shell-'))
    await rm(directory, { recursive: true, force: true })
  }
})

// The workspace is a leave-decision probe; title bar, navigation, guard, runtime
// host and preview forwarding above are production code, not copied substitutes.
const runtime = `
import {createApp,compile,computed,defineComponent,h,nextTick,ref} from 'vue';
import TitleBar from '__RENDERER__/components/TitleBar.vue';
import AppearanceLayersHost from '__RENDERER__/components/AppearanceLayersHost.vue';
import {useAppNavigation} from '__RENDERER__/app/useAppNavigation.ts';
import {guardAppearanceNavigation} from '__RENDERER__/app/appearanceNavigationGuard.ts';
import {guardDspNavigation} from '__RENDERER__/app/dspNavigationGuard.ts';
import {providePageDock} from '__RENDERER__/app/pageDock.ts';
import {appearanceChromePreview,appearanceFullWindowPreview,appearanceEditorOpen} from '__RENDERER__/composables/appearanceEditorState.ts';
import {cloneAppearance} from '__RENDERER__/../../shared/appAppearance.ts';
import '__RENDERER__/assets/appearance-layers.css';
let leaveAllowed=false,leaveRequests=0,mounts=0;
window.api={window:{getState:async()=>({maximized:false}),onStateChanged:()=>()=>{}}};
let appearancePreview=null,savedAppearance=null;
const modes=[],applyActiveTheme=async(_persist,mode)=>modes.push(mode),cacheSettingsAppearance=()=>{};
__PREVIEW__
const settings=ref(cloneAppearance({})),effectiveThemeLayers=ref(null);
const AppearancePage=defineComponent({props:['active'],setup(_props,{expose,emit}){
 mounts++;const requestLeave=async()=>{leaveRequests++;return leaveAllowed};
 expose({requestLeave,requestClose:async()=>{if(await requestLeave())emit('back')}});
 return()=>h('section',{id:'workspace'},'Workspace');
}});
let workspaceRetained;
createApp({components:{TitleBar,AppearanceLayersHost,AppearancePage},setup(){
 __SETUP__
 const noop=()=>{};
 window.shellNavigation=navigation;workspaceRetained=appearancePageRetained;
 return {...navigation,navigation,appearancePageRef,appearancePageRetained,pageDock,
 appearanceFullWindowPreview,appearanceEditorOpen,appearanceChromePreview,settings,effectiveThemeLayers,
 showOnboarding:false,liquidGlassChromeActive:false,showPlayingPage:navigation.showPlayingPage,
 titleSurface:'default',titleMenuOpen:false,toggleMenu:navigation.createToggleMenuHandler(),
 collapseMenu:navigation.collapseMenu,handleTitleBack:noop,handleTitleLogin:noop,
 toggleSettingsPage:navigation.createToggleSettingsHandler(),togglePluginPage:navigation.createTogglePluginHandler(),
 selectSidebarPage:navigation.selectSidebarPage,noticeHostRef:null,navigationPages:[]};
},render:compile('<div class="app-shell"><div class="app-shell-content"><button id="probe">Native control</button></div></div>'+__TEMPLATE__)}).mount('#app');
const expect=(value,message)=>{if(!value)throw Error(message)};
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,70));await nextTick()};
const waitForLayers=async()=>{
 const deadline=performance.now()+2000;
 while(document.querySelector('#probe').dataset.teAppearanceBody!=='controls'){
  expect(performance.now()<deadline,'appearance layers did not reach the control: '+JSON.stringify({hidden:document.hidden,theme:document.documentElement.dataset.theme,sheet:!!document.querySelector('style[data-appearance-layers]'),preview:appearanceFullWindowPreview.value}));
  await new Promise(resolve=>setTimeout(resolve,16));await nextTick();
 }
};
window.runShellTests=async()=>{
 const nav=window.shellNavigation;
 document.querySelector('.appearance-btn').click();await settle();
 expect(nav.showAppearancePage.value&&document.querySelector('#workspace'),'title button did not mount workspace');
 expect(document.querySelector('.appearance-btn').getAttribute('aria-pressed')==='true','title active state missing');
 expect(!document.querySelector('style[data-appearance-layers]'),'idle editor retained live shell runtime');
 nav.openLibraryPlaylist({id:'one',name:'One'});await settle();
 expect(leaveRequests===1&&nav.showAppearancePage.value,'playlist bypassed rejected leave');
 const draft=cloneAppearance(settings.value);
 draft.appearanceLayers.scopes.controls.dark.body={enabled:true,color:'#ee2255',opacity:100};
 await previewAppearance(draft);appearanceFullWindowPreview.value=true;await settle();
 await waitForLayers();
 expect(appearancePreview===draft&&modes.at(-1)==='preview','store did not use transient preview');
 expect(appearanceChromePreview.value.appearanceLayers===draft.appearanceLayers,'layers lost in chrome forwarding');
 expect(document.querySelector('#probe').dataset.teAppearanceBody==='controls','full-window host not mounted with draft layers');
 const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
 ctx.fillStyle=getComputedStyle(document.querySelector('#probe')).backgroundColor;ctx.fillRect(0,0,1,1);
 expect([...ctx.getImageData(0,0,1,1).data].join()==='238,34,85,255','draft body did not paint');
 expect(!settings.value.appearanceLayers.scopes.controls.dark.body.enabled,'preview wrote confirmed settings');
 appearanceFullWindowPreview.value=false;await previewAppearance(null);await settle();
 expect(!document.querySelector('style[data-appearance-layers]'),'return from preview left runtime mounted');
 nav.openEqualizerPage();await settle();
 expect(workspaceRetained.value&&document.querySelector('#workspace').style.display==='none'&&mounts===1,'tool switch destroyed workspace');
 nav.closeEqualizerPage();await settle();
 expect(nav.showAppearancePage.value&&mounts===1,'tool return remounted workspace');
 leaveAllowed=true;document.querySelector('.appearance-btn').click();await settle();
 expect(!nav.showAppearancePage.value&&!document.querySelector('#workspace'),'confirmed close did not release workspace');
 expect(!appearanceChromePreview.value&&modes.at(-1)==='apply','discard did not restore confirmed runtime');
 expect(!document.querySelector('#probe').hasAttribute('data-te-appearance-body'),'discard retained draft decoration');
 settings.value=cloneAppearance(draft);await settle();
 await waitForLayers();
 expect(document.querySelector('#probe').dataset.teAppearanceBody==='controls','applied layers do not survive leaving editor');
 nav.openAppearancePage();await settle();nav.navigate({kind:'network'});await settle();
 expect(nav.pageTarget.value.kind==='network'&&!workspaceRetained.value,'approved navigation failed to release workspace');
};
`
