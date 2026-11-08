import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
const require = createRequire(import.meta.url)

test(
  'debug settings handle start, cancelled export, retry and capture selection in the rendered page',
  { timeout: 45000 },
  async () => {
    const parent = resolve('tmp/audio-crash-support')
    await mkdir(parent, { recursive: true })
    const directory = await mkdtemp(join(parent, 'ui-'))
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    const styles = parse(await readFile(join(renderer, 'components/SettingsPage.vue'), 'utf8'))
      .descriptor.styles.filter((style) => !style.src)
      .map((style) => style.content)
      .join('\n')
    await writeFile(join(directory, 'settings.css'), styles)
    await writeFile(
      join(directory, 'entry.js'),
      `
import {createApp,h,nextTick} from 'vue';
import Page from '${renderer}/components/settings-page/DiagnosticsSettingsSection.vue';
import './settings.css';
import '${renderer}/components/settings-page/SettingsLayout.css';
let current=null; window.calls=[]; window.cancelExport=false; window.failExport=false;
window.api={diagnostics:{getStatus:async()=>({bytes:1024,debug:current}),openDirectory:async()=>{},clearHistory:async()=>{},markProblem:async()=>({markerId:'marker'}),
startDebug:async options=>{window.calls.push(options);current={id:'session',startedAt:new Date().toISOString(),state:'active',captureCrashes:options.captureCrashes,bytes:2048,warnings:options.captureCrashes?['采集失败：系统错误 5']:[],crashes:{electron:options.captureCrashes?'failed':'disabled',native:'windows-helper',dumps:1,collectors:[]}};return current},
exportBundle:async options=>{window.calls.push(options);if(window.cancelExport)return {filePath:null};if(window.failExport)throw Error('disk full');current={...current,state:'ended'};return {filePath:'D:/诊断/debug.zip'}}}};
createApp({render:()=>h('main',{class:'settings-preview-page','data-settings-layout':'categories'},[h(Page)])}).mount('#app');
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,50));await nextTick()};
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
const check=(ok,message)=>{if(!ok)throw Error(message)};
window.run=async()=>{await tick();check(button('开始调试'),'start missing');button('开始调试').click();await tick();check(button('结束并导出调试包'),'active missing');
window.cancelExport=true;button('结束并导出调试包').click();await tick();check(button('结束并导出调试包'),'cancel ended capture');
window.cancelExport=false;window.failExport=true;button('结束并导出调试包').click();await tick();check(document.body.textContent.includes('disk full'),'failure hidden');
window.failExport=false;button('结束并导出调试包').click();await tick();check(button('重新导出上次调试包'),'retry missing');
document.querySelector('input[type=checkbox]').click();await tick();button('重启并开始取证').click();await tick();check(window.calls.at(-1).captureCrashes===true,'capture not selected');
check(document.querySelectorAll('input[type=checkbox]').length===1,'dump export selection missing');check(document.body.textContent.includes('启用失败'),'collector failure hidden');check(document.body.textContent.includes('系统错误 5'),'collector error hidden');check(document.body.textContent.includes('已保存 1 份'),'dump count hidden');return true};
`
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [vue()],
      resolve: { alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') } },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.js'),
          name: 'DiagnosticSettings',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><meta charset="utf-8"><head>${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<style>
body{font-family:'Segoe UI','Microsoft YaHei',sans-serif;margin:0;background:#f6f7fb;color:#263047;--te-settings-text:#263047;--te-settings-text-muted:#697386;--te-settings-control-bg:#fff;--te-settings-control-border:#dce1eb;--te-primary-rgb:76,111,215;--te-primary-600:#4667d5;--te-control-radius-md:10px}main{max-width:800px;margin:32px auto;padding:24px}button{cursor:pointer}.section-block{background:white;border-radius:16px;padding:24px}.setting-list{padding:0}.setting-item{padding:14px 0}.setting-copy{display:grid;gap:6px}hr{border:0;border-top:1px solid #edf0f5}.brand-soft-button,.soft-button{font:inherit;font-size:14px;border:0;border-radius:9px;padding:10px 16px;background:#e9edfc;color:#3655b5}.inline-controls{display:flex;gap:8px;align-items:center}
</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    const screenshot = join(parent, 'debug-settings.png')
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path');app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:1100,webPreferences:{offscreen:true,contextIsolation:true,backgroundThrottling:false}});try{await win.loadFile(path.join(__dirname,'index.html'));await win.webContents.executeJavaScript('window.run()');fs.writeFileSync(${JSON.stringify(screenshot)},(await win.webContents.capturePage()).toPNG());console.log('DEBUG_UI_OK');win.destroy();app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 25000 }
    )
    assert.match(result.stdout, /DEBUG_UI_OK/)
  }
)
