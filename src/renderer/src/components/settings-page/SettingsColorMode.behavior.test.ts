import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

test('general color mode persists all three choices, follows native changes and commits its image palette atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-color-mode-'))
  const require = createRequire(import.meta.url)
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [vue()],
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'ColorModeTest',
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
        )}</head><body class="te-settings-surface"><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{let win;try{win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{offscreen:true,backgroundThrottling:false}});await win.loadFile(__dirname+'/index.html');await win.webContents.executeJavaScript('window.runColorModeTests()');console.log('SETTINGS_COLOR_MODE_OK');app.exit(0)}catch(error){console.error(error.stack);win?.destroy();app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      env,
      windowsHide: true,
      timeout: 30_000
    })
    assert.match(result.stdout, /SETTINGS_COLOR_MODE_OK/)
    console.info(
      'SETTINGS_COLOR_MODE_OK: native light/dark, preview override, save failure, reopen and palette frames'
    )
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `
import {createApp,h,nextTick} from 'vue'
import General from '@renderer/components/settings-page/GeneralSettingsSection.vue'
import {useSettingsStore} from '@renderer/stores/useSettingsStore.ts'
import {bootstrapThemeRuntime,useThemeStore,previewAppearance} from '@renderer/stores/useThemeStore.ts'
import {createDefaultThemeLibraryDocument} from '@shared/theme.ts'
import {backgroundCssVariables,normalizeAppBackgroundSettings} from '@shared/appAppearance.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/appearance.css'
import '@renderer/assets/materials.css'
import '@renderer/components/settings-page/SettingsPage.css'
const expect=(ok,message)=>{if(!ok)throw Error(message)};
const settle=async()=>{await nextTick();for(let i=0;i<4;i++)await new Promise(resolve=>requestAnimationFrame(resolve))};
const settingsListeners=new Set(),nativeToneListeners=new Set(),writes=[];let failSave=false;
const snapshot=()=>({settings:confirmed,defaults:confirmed,paths:{},appVersion:'test',platform:'win32',windowTransparencySupported:false,restartReasons:[]});
window.api={settings:{get:async()=>snapshot(),onChanged:listener=>{settingsListeners.add(listener);return()=>settingsListeners.delete(listener)},update:async patch=>{if(failSave)throw Error('保存失败');writes.push(patch);confirmed={...confirmed,...patch};const result=snapshot();for(const listener of settingsListeners)listener(result);return result}},themes:{onChanged:()=>()=>{},onSystemToneChanged:listener=>{nativeToneListeners.add(listener);return()=>nativeToneListeners.delete(listener)}},plugins:{onChanged:()=>()=>{},onNotice:()=>()=>{}},extensions:{list:async()=>[]}};
const settingsStore=useSettingsStore(),theme=useThemeStore();
let confirmed={...settingsStore.settings.value,theme:'dark',appBackground:normalizeAppBackgroundSettings({global:{kind:'image',image:'background://palette.png',imagePalette:{image:'background://palette.png',average:'#640d1e',accent:'#c44868'}}})};
window.runColorModeTests=async()=>{
 const startup={systemTone:'dark',settings:snapshot(),themeBootstrap:{library:{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}}};
 settingsStore.hydrateStartupSnapshot(startup);await bootstrapThemeRuntime(startup);await previewAppearance(null);await theme.setPreviewTone(null);await settle();
 const host=document.querySelector('#app');
 const mount=()=>createApp({setup:()=>()=>h(General,{startupHomePageOptions:[],toggleSetting:()=>{},setStartupHomePage:()=>{},setCloseBehavior:()=>{}})});
 let app=mount();app.mount(host);await settle();
 const selected=()=>[...host.querySelectorAll('[aria-label="配色模式"] button')].filter(button=>button.getAttribute('aria-pressed')==='true').map(button=>button.textContent.trim());
 const choose=async label=>{const button=[...host.querySelectorAll('[aria-label="配色模式"] button')].find(button=>button.textContent.trim()===label);expect(button&&!button.disabled,'missing usable '+label);button.focus();button.click();await settle();expect(document.activeElement===button,'saving color mode drops its keyboard focus')};
 const mixedFrames=[];const observer=new MutationObserver(()=>{const tone=document.documentElement.dataset.theme;const expected=backgroundCssVariables(confirmed.appBackground.global,tone==='dark'?'dark':'light')['--appearance-control-surface'];const actual=getComputedStyle(document.documentElement).getPropertyValue('--te-settings-background-control-surface').trim();if(actual!==expected)mixedFrames.push({tone,actual,expected})});
 observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
 try{
  expect(host.querySelectorAll('[aria-label="配色模式"] button').length===3,'color mode choices missing');
  for(const nativeTone of ['pureWhite','dark']){
   for(const listener of nativeToneListeners)listener(nativeTone);await settle();
   await theme.setPreviewTone('dark');await choose('浅色模式');
   expect(confirmed.theme==='pureWhite'&&document.documentElement.dataset.theme==='pureWhite'&&selected().join()==='浅色模式','light preference stays stuck in preview');
   await choose('深色模式');expect(confirmed.theme==='dark'&&document.documentElement.dataset.theme==='dark'&&selected().join()==='深色模式','dark preference not applied');
   await choose('跟随系统');expect(confirmed.theme==='system'&&document.documentElement.dataset.theme===nativeTone&&selected().join()==='跟随系统','system mode does not resolve native tone');
  }
  for(const listener of nativeToneListeners)listener('pureWhite');await settle();expect(document.documentElement.dataset.theme==='pureWhite','live native change ignored');
  const before=writes.length;failSave=true;await choose('深色模式');expect(confirmed.theme==='system'&&writes.length===before&&selected().join()==='跟随系统'&&host.querySelector('[role="alert"]')?.textContent.includes('保存失败'),'failed preference is not restored or explained');
  failSave=false;await choose('深色模式');app.unmount();app=mount();app.mount(host);await settle();expect(selected().join()==='深色模式','reopened settings forget the confirmed preference');
  expect(mixedFrames.length===0,'tone commits before its adaptive palette: '+JSON.stringify(mixedFrames));
 }finally{observer.disconnect();failSave=false;app.unmount()}
};
`
