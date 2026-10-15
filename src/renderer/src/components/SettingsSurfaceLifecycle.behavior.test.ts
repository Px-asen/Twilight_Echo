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

test('leaving either settings workspace removes its wallpaper from the rendered home surface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-settings-surface-'))
  try {
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    const { descriptor } = parse(await readFile(resolve('src/renderer/src/App.vue'), 'utf8'))
    const overlay = descriptor.template!.ast!.children.find(
      (node) =>
        node.type === 1 &&
        node.tag === 'div' &&
        node.loc.source.includes('class="settings-overlay-root"')
    )
    assert.ok(overlay, 'the test must use the production settings overlay template')
    await writeFile(
      join(directory, 'app.css'),
      descriptor.styles.map((style) => style.content).join('\n')
    )
    await writeFile(
      join(directory, 'entry.js'),
      entry
        .replaceAll('__RENDERER__', renderer)
        .replace('__OVERLAY__', JSON.stringify(overlay.loc.source))
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [vue()],
      resolve: {
        alias: { '@renderer': renderer, vue: require.resolve('vue/dist/vue.esm-bundler.js') }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        lib: {
          entry: join(directory, 'entry.js'),
          name: 'SettingsSurfaceLifecycle',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="full" data-te-settings-custom-background="on"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<link rel="stylesheet" href="app.css"><style>
        :root{--te-settings-bg:#cf2048;--te-settings-bg-image:none;--te-local-bg:#123456;--te-app-bg:#123456}
        body{margin:0} .home-probe{position:absolute;inset:120px 200px auto;height:240px;background:#00ff00;color:#000}
        </style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 45_000 }
    )
    assert.match(result.stdout, /SETTINGS_SURFACE_LIFECYCLE_OK: 12/)
    console.info(result.stdout.trim())
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-settings-surface-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const entry = `
import {createApp,compile,computed,h,nextTick,ref} from 'vue';
import AppBackgroundLayer from '__RENDERER__/components/AppBackgroundLayer.vue';
import {useAppNavigation} from '__RENDERER__/app/useAppNavigation.ts';
import '__RENDERER__/assets/main.css';
const navigation=useAppNavigation(),appearanceFullWindowPreview=ref(false);
const {showSettingsPage,showAppearancePage}=navigation;
const painters=new WeakMap();let painterCount=0;
const page={render:()=>h('div',{class:'settings-preview-page'},'Workspace')};
const overlay=__OVERLAY__;
createApp({components:{AppBackgroundLayer,SettingsPage:page,AppearancePage:page},setup:()=>({
 ...navigation,appearanceFullWindowPreview,navigationPages:[],settingsPageRetained:computed(()=>showSettingsPage.value||showAppearancePage.value),appearancePageRetained:computed(()=>showSettingsPage.value||showAppearancePage.value),
 themeStudioInitialDomain:'presets',openEqualizerPage:()=>{},openDspRackPage:()=>{},openThemeStudioPage:()=>{},openThemeWorkshop:()=>{},handleReopenOnboarding:()=>{},openPluginPage:()=>{},navigation,
}),render:compile('<div class="app-shell"><div class="app-shell-content"><main class="main-content"><div class="local-home-layout"><section class="home-probe" aria-label="Homepage content">Home remains rendered</section></div></main></div></div>'+overlay)}).mount('#app');
window.showSurface=async(value,theme,motion)=>{
 document.documentElement.dataset.theme=theme;document.documentElement.dataset.teMotion=motion;
 if(value==='settings')navigation.openSettingsPage();else if(value==='appearance')navigation.openAppearancePage();else navigation.goHome();
 await nextTick();await new Promise(resolve=>setTimeout(resolve,400));await nextTick();
 const probe=document.querySelector('.home-probe'),bounds=probe.getBoundingClientRect();
 const painter=document.querySelector('.settings-overlay-root > [data-background-page="settings"]');if(painter&&!painters.has(painter))painters.set(painter,++painterCount);
 return {point:{x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2},viewport:{width:innerWidth,height:innerHeight},present:probe.textContent.includes('Home remains rendered'),opacity:getComputedStyle(probe).opacity,workspaces:document.querySelectorAll('.settings-overlay-root--active').length,painterId:painter?painters.get(painter):0};
};
`

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));
 let count=0;for(const theme of ['pureWhite','dark'])for(const motion of ['full','reduced','off'])for(const workspace of ['settings','appearance']){
  const opened=await win.webContents.executeJavaScript('window.showSurface('+[workspace,theme,motion].map(JSON.stringify).join(',')+')');
  const switched=await win.webContents.executeJavaScript('window.showSurface('+[workspace==='settings'?'appearance':'settings',theme,motion].map(JSON.stringify).join(',')+')');
  if(!opened.painterId||switched.painterId!==opened.painterId||switched.workspaces!==1)throw Error('switching workspaces remounted or removed the shared wallpaper: '+JSON.stringify({workspace,theme,motion,opened,switched}));
  const state=await win.webContents.executeJavaScript('window.showSurface('+['home',theme,motion].map(JSON.stringify).join(',')+')');
  if(!state.present||state.opacity!=='1'||state.workspaces!==0||state.painterId!==0)throw Error('home state not restored: '+JSON.stringify(state));
  const image=await win.webContents.capturePage(),size=image.getSize(),pixels=image.toBitmap(),x=Math.round(state.point.x*size.width/state.viewport.width),y=Math.round(state.point.y*size.height/state.viewport.height),offset=(y*size.width+x)*4;
  const color=[pixels[offset+2],pixels[offset+1],pixels[offset]];
  if(color.some((value,index)=>Math.abs(value-[0,255,0][index])>1))throw Error('settings wallpaper covers accessible home content: '+JSON.stringify({workspace,theme,motion,color,state}));
  count++;
 }
 console.log('SETTINGS_SURFACE_LIFECYCLE_OK: '+count);win.destroy();app.exit(0);
}catch(error){console.error(error.stack);win?.destroy();app.exit(1)}});
`
