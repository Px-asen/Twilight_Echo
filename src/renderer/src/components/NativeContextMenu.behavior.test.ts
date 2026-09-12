import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))

test('native menu actions and top-layer source menus work inside clipped containers without login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-native-menu-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'MenuRuntime',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}</head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:720,height:560,webPreferences:{contextIsolation:false}});
      try {await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runMenuTests()');console.log('MENU_OK');app.exit(0)}
      catch(e){console.error(e.stack);app.exit(1)}
    })`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60000 }
    )
    assert.match(result.stdout, /MENU_OK/)
  } finally {
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + '\\') ||
        resolve(directory).startsWith(resolve(tmpdir()) + '/')
    )
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick} from 'vue'
import NativeMenu from '@renderer/components/NativeContextMenu.vue'
import Library from '@renderer/components/StreamingLibrary.vue'
import Header from '@renderer/components/streaming-page/StreamingContentHeader.vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=()=>new Promise(r=>setTimeout(r,60))
window.runMenuTests=async()=>{
  let request,complete,clicked=0,closed=0,cancelled
  window.api={window:{popupContextMenu:value=>{request=value;return new Promise(r=>complete=r)},closeContextMenu:async id=>{cancelled=id}}}
  let app=createApp({render:()=>h(NativeMenu,{onClose:()=>closed++},()=>[
    h('div',{class:'menu-item'},['添加到歌单',h('div',{class:'submenu'},[
      h('button',{onClick:()=>clicked++},'R&B 歌单'),h('button',{disabled:true},'不可用')])])])})
  app.mount('#app');await nextTick()
  expect(request.items[0].label==='添加到歌单','submenu labels polluted the parent: '+JSON.stringify(request))
  expect(request.items[0].submenu[0].label==='R&B 歌单','submenu missing')
  expect(request.items[0].submenu[1].enabled===false,'disabled action lost')
  expect(document.querySelector('#app > div').getBoundingClientRect().height===0,'native definition became an HTML menu')
  complete(request.items[0].submenu[0].id);await pause()
  expect(clicked===1 && closed===1,'native selection was not dispatched once')
  app.unmount()
  app=createApp({render:()=>h(NativeMenu,{},()=>h('button',{onClick:()=>clicked++},'播放'))});app.mount('#app');await nextTick()
  const pending=request.requestId;app.unmount();expect(cancelled===pending,'unmount did not cancel native menu')
  complete(request.items[0].id);await pause();expect(clicked===1,'late native selection ran after unmount')
  const options=Array.from({length:25},(_,i)=>({id:String(i),name:'音源 '+i,icon:'pi pi-music',loggedIn:false}))
  let selected
  app=createApp({render:()=>h('div',{style:'height:150px;overflow:hidden;transform:translateZ(0)'},[
    h(Library,{isLoggedIn:false,profile:null,profileSignature:'',likedSummary:{name:'喜欢',trackCount:0,cover:null},libraryLoaded:false,userPlaylistEntries:[],showLikedPanel:false,availableProviders:options,activeProvider:'0',onSwitchProvider:id=>selected=id})])})
  app.mount('#app');await nextTick()
  const events=[];window.addEventListener('scroll',e=>events.push('scroll:'+e.target.nodeName),true);document.querySelector('.provider-menu').addEventListener('beforetoggle',e=>events.push(e.oldState+'>'+e.newState));
  await pause();document.querySelector('.provider-switch-btn').focus();document.querySelector('.provider-switch-btn').click();await pause()
  let menu=document.querySelector('.provider-menu')
  expect(menu.matches(':popover-open'),'library menu is not in the top layer: '+events.join(','))
  expect(menu.scrollHeight>menu.clientHeight,'long source menu cannot scroll')
  menu.scrollTop=menu.scrollHeight;await pause()
  expect(menu.matches(':popover-open') && menu.scrollTop>0,'scroll closes the menu')
  const last=menu.querySelector('button:last-child'),rect=last.getBoundingClientRect()
  expect(document.elementFromPoint(rect.x+20,rect.y+10) && last.contains(document.elementFromPoint(rect.x+20,rect.y+10)),'source menu clipped by profile card')
  last.click();await pause();expect(selected==='24','last source not selectable')
  app.unmount()
  app=createApp({render:()=>h(Header,{isDetail:false,isSearching:false,showSubtitle:true,title:'主页',subtitle:'未登录',showUnifiedSearch:false,searchQuery:'',searchLoading:false,providerId:'0',providerOptions:options,onSelectProvider:id=>selected=id})})
  app.mount('#app');await nextTick()
  await pause();document.querySelector('.provider-switcher-trigger').focus();document.querySelector('.provider-switcher-trigger').click();await pause()
  menu=document.querySelector('.provider-switcher-menu');expect(menu.matches(':popover-open'),'logged out header has no source switcher')
  menu.scrollTop=menu.scrollHeight;await pause()
  expect(menu.matches(':popover-open'),'header menu closes on its own scroll')
  menu.querySelector('button:last-child').click();await pause();expect(selected==='24','header source selection failed')
  app.unmount()
}
`
