import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve, join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
test('update panel survives navigation, exposes retry/cancel, and gates installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-update-ui-'))
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
          'primeicons.css': require.resolve('primeicons/primeicons.css'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'UpdatePanelTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<style>body{font:14px system-ui;margin:24px;color:var(--te-settings-text);background:var(--te-card-bg)}.soft-button,.brand-soft-button{font:inherit}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:960,height:780,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});try{await win.loadFile(process.argv.at(-1));const failure=await win.webContents.executeJavaScript('window.runUpdatePanelTests().then(()=>null).catch(error=>error.stack)');if(failure)throw new Error(failure);if(process.env.TWILIGHT_UPDATE_SCREENSHOT_PREFIX){for(const theme of ['light','dark']){await win.webContents.executeJavaScript("document.documentElement.dataset.theme='"+theme+"';new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");fs.writeFileSync(process.env.TWILIGHT_UPDATE_SCREENSHOT_PREFIX+'-'+theme+'.png',(await win.webContents.capturePage()).toPNG())}}win.setSize(480,780);await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');if(await win.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth'))throw new Error('panel overflows narrow window');console.log('UPDATE_PANEL_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /UPDATE_PANEL_OK/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-update-ui-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `
import {createApp,h,nextTick,ref} from 'vue'
import Panel from '@renderer/components/settings-page/AppUpdatePanel.vue'
import '@renderer/assets/base.css'
import '@renderer/components/settings-page/SettingsPage.css'
import 'primeicons.css'
import {useAppUpdateStore} from '@renderer/stores/useAppUpdateStore.ts'
import {createInitialAppUpdateSnapshot} from '@shared/appUpdate.ts'
const expect=(ok,message)=>{if(!ok)throw new Error(message)}
const pause=()=>new Promise(resolve=>setTimeout(resolve,15))
window.runUpdatePanelTests=async()=>{
 let state=createInitialAppUpdateSnapshot(),listeners=new Set(),downloadResolve,installCount=0,cancelCount=0,prefCalls=0
 const publish=patch=>{state={...state,...patch,revision:state.revision+1};for(const listener of listeners)listener(structuredClone(state))}
 window.api={app:{getUpdateState:async()=>structuredClone(state),onUpdateState:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},
 checkForUpdates:async()=>state.check,
 downloadUpdate:()=>new Promise(resolve=>{downloadResolve=resolve;publish({progress:{phase:'downloading',taskId:'download',percent:35,receivedBytes:36700160,totalBytes:104857600,bytesPerSecond:2097152,remainingSeconds:33}})}),
 cancelUpdateDownload:async()=>{cancelCount++;publish({progress:{phase:'cancelled',percent:35,receivedBytes:36700160,totalBytes:104857600}});downloadResolve({ok:false,cancelled:true,error:'cancelled'});return true},
 installUpdate:async()=>{installCount++;return {ok:false,error:'模拟保存失败，应用保持打开'}},
 setUpdatePreferences:async patch=>{prefCalls++;publish({preferences:{...state.preferences,...patch}});return state},
 dismissUpdate:async action=>{publish({preferences:{...state.preferences,skippedVersion:action==='skip'?'2.0.0':''}});return state}},shell:{openExternal:async()=>{}}}
 publish({check:{hasUpdate:true,currentVersion:'1.0.0',latestVersion:'2.0.0',hasChecksum:true,assetSize:104857600,releaseNotes:'更新内容：修复播放与下载。\\n<img src=x onerror=alert(1)>',publishedAt:'2026-10-03T00:00:00Z'},checkedAt:Date.now()})
 const updates=useAppUpdateStore(),releaseRoot=updates.connect(),visible=ref(true)
 const app=createApp({render:()=>visible.value?h(Panel):null});app.mount('#app');await pause()
 const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text)
 expect(button('下载更新'),'missing download action')
 document.querySelector('details').open=true
 expect(!document.querySelector('img'),'release notes rendered executable markup')
 button('下载更新').click();await pause()
 expect(button('检查更新').disabled,'check enabled during download')
 expect(document.querySelector('progress').value===35,'progress missing')
 visible.value=false;await nextTick();expect(listeners.size===1,'page leaked its listener')
 visible.value=true;await pause();expect(button('取消下载'),'reopened page lost cancellation')
 button('取消下载').click();await pause();expect(cancelCount===1,'cancel unavailable during pending invoke')
 expect(button('重试 / 继续下载')&&!button('重试 / 继续下载').disabled,'retry unavailable')
 const autoCheck=document.querySelector('[role=switch]');autoCheck.click();await pause();expect(prefCalls===1&&!state.preferences.autoCheck,'preference not saved');expect(autoCheck.getAttribute('aria-checked')==='false','switch state not announced')
 const frequency=document.querySelector('select[aria-labelledby="update-interval-label"]')
 expect(frequency.disabled,'automatic frequency remains editable when checks are off')
 expect(document.getElementById(frequency.getAttribute('aria-describedby')).textContent.includes('开启自动检查'),'disabled frequency has no prerequisite explanation')
 expect(!button('检查更新').disabled,'turning off automatic checks disabled manual checks')
 autoCheck.click();await pause();expect(!frequency.disabled,'frequency did not become available')
 frequency.value='72';frequency.dispatchEvent(new Event('change',{bubbles:true}));await pause()
 expect(state.preferences.checkIntervalHours===72,'frequency change was not saved')
 expect(state.preferences.channel==='stable','frequency change overwrote update channel')
 publish({readyVersion:'2.0.0',progress:{phase:'ready',percent:100,receivedBytes:104857600,totalBytes:104857600,message:'SHA-256 校验通过，可以安装'}});await pause()
 window.confirm=()=>false;button('安装并退出').click();await pause();expect(installCount===0,'declined confirmation installed')
 window.confirm=()=>true;button('安装并退出').click();await pause();expect(installCount===1,'install action missing')
 expect(document.body.textContent.includes('模拟保存失败'),'install failure hidden')
 expect(!button('安装并退出').disabled,'install failure cannot be retried')
 await updates.check();await pause()
 button('跳过此版本').click();await pause();expect(state.preferences.skippedVersion==='2.0.0','skip not persisted')
 visible.value=false;await nextTick();releaseRoot();expect(listeners.size===0,'listeners leaked after app disposal')
 visible.value=true;await pause();expect(button('安装并退出'),'ready installer not restored on reconnect')
 document.querySelector('details').open=true
 window.api.app.getUpdateState=async()=>{throw new Error("No handler registered for 'app:getUpdateState'")}
 window.api.app.checkForUpdates=async()=>{throw new Error("Error invoking remote method 'app:checkForUpdates': No handler registered")}
 await updates.check();await pause()
 expect(document.body.textContent.includes('完全退出并重新启动'),'missing restart guidance')
 expect(!document.body.textContent.includes('No handler registered'),'raw IPC error leaked')
 expect(document.body.textContent.includes('更新操作未完成'),'failure retained idle title')
 expect(document.querySelector('.update-card').dataset.status==='error','failure uses success styling')
}
`
