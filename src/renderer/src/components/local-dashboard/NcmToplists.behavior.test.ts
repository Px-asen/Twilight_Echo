import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('recommendation charts support browsing, login, playback, dismissal and responsive themes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-toplists-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'fixtures.ts'), fixtures)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: [
          {
            find: '../stores/useSettingsStore',
            replacement: join(directory, 'fixtures.ts')
          },
          {
            find: /^@renderer\/stores\/use(?:Provider|Player)Store$/,
            replacement: join(directory, 'fixtures.ts')
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') },
          {
            find: '@phosphor-icons/web/src/regular/style.css',
            replacement: join(workspace, 'node_modules/@phosphor-icons/web/src/regular/style.css')
          },
          {
            find: '@phosphor-icons/web/src/fill/style.css',
            replacement: join(workspace, 'node_modules/@phosphor-icons/web/src/fill/style.css')
          },
          {
            find: 'primeicons/primeicons.css',
            replacement: require.resolve('primeicons/primeicons.css')
          }
        ]
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'ToplistsTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{margin:0;background:var(--te-bg-primary,#f8f9fc)}#app{height:100vh}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /TOPLISTS_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const fixtures = `import {ref,shallowRef} from 'vue'
export const source={id:'ncm',name:'网易云音乐',capabilities:['playlist','login','playbackUrl'],supportedMethods:['fetchToplists','fetchPlaylistTracks','searchSongs','fetchDiscoveryPlaylists','fetchUserLibrary']}
export const providers=ref([source]),currentTrack=shallowRef(null),isPlaying=ref(false)
export const useSettingsStore=()=>({settings:ref({motionPreference:'off'})})
export const requests=[],played=[]
export let authenticated=false,pending=null,failure=false
export const setAuthenticated=value=>{authenticated=value},setPending=value=>{pending=value},setFailure=value=>{failure=value}
const names=['飙升榜','新歌榜','原创榜','热歌榜','云音乐说唱榜','云音乐民谣榜']
const ids=[19723756,3779629,2884035,3778678,991,992]
const colors=['#65aeb6','#779ec1','#b88091','#bd826c','#648681','#877da6']
const cover=index=>'data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="'+colors[index]+'"/><circle cx="140" cy="20" r="80" fill="white" opacity=".1"/><path d="M20 125L60 85L90 105L140 40" stroke="white" stroke-width="3" opacity=".25" fill="none"/><text x="18" y="62" fill="white" font-size="25" font-family="sans-serif" font-weight="700">'+names[index]+'</text><text x="18" y="83" fill="white" font-size="7" font-family="sans-serif" letter-spacing="2">NETEASE MUSIC</text></svg>')))
export const charts=names.map((name,index)=>({id:ids[index],name,cover:cover(index),trackCount:100,updateFrequency:'每天更新',description:'以音乐记录此刻，发现值得循环的新声音。',previewTracks:['晚风经过你的窗','再听一遍','沿着海岸线'].map((title,rank)=>({title,artist:['陈粒','房东的猫','落日飞车'][rank]}))}))
export const songs=Array.from({length:60},(_,index)=>({id:'ncm:'+index,title:index===1?'长歌名测试'.repeat(20):'晚风经过你的窗 '+(index+1),artist:index===1?'很长的艺术家名字'.repeat(12):'陈粒 / 房东的猫',album:'暮光',duration:180+index,cover:null,source:'ncm',filePath:'',fileName:'',size:0,lyrics:null}))
export const useProviderStore=()=>({providers,checkLogin:async()=>({loggedIn:authenticated,profile:null}),callProvider:async(id,method,args=[])=>{requests.push([id,method,args]);if(failure)throw new Error('网络暂时不可用');if(pending)return pending;return method==='fetchToplists'?charts:songs}})
export const usePlayerStore=()=>({currentTrack,isPlaying,playTrack:(track,queue)=>{played.push({track,queue});currentTrack.value=track;isPlaying.value=true},togglePlay:()=>{isPlaying.value=!isPlaying.value}})
`

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import NcmToplists from '@renderer/components/local-dashboard/NcmToplists.vue'
import StreamingHome from '@renderer/components/StreamingHome.vue'
import '@renderer/assets/base.css'
import '@phosphor-icons/web/src/regular/style.css'
import '@phosphor-icons/web/src/fill/style.css'
import 'primeicons/primeicons.css'
import * as state from './fixtures.ts'
const pause=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await new Promise(resolve=>setTimeout(resolve,20))}
const expect=(value,message)=>{if(!value)throw new Error(message)}
const events=[]
const presentation=ref({requiresLogin:false}),recsLoading=ref(false),recsError=ref('')
const app=createApp({render:()=>h(StreamingHome,{providerLabel:'网易云音乐',presentation:presentation.value,isLoggedIn:false,recsLoading:recsLoading.value,recsError:recsError.value,recSections:[],recommendPlaylists:[]},{rankings:()=>h(NcmToplists,{onLogin:()=>events.push('login')})})})
app.config.errorHandler=error=>{window.runtimeError=error.stack||String(error)}
app.mount('#app')
const click=label=>{const target=[...document.querySelectorAll('button')].find(button=>button.getAttribute('aria-label')===label||button.textContent.trim()===label);expect(target,'Missing button '+label);target.focus();target.click()}
window.runToplistTests=async()=>{
 await pause();expect(!window.runtimeError,window.runtimeError);expect(document.querySelectorAll('.toplist-card').length===4,'Expected four featured charts');expect(state.requests.length===1&&state.requests[0][1]==='fetchToplists','Summary must not eagerly load songs or login')
 for(const mode of ['loading','error','locked','fallback']){presentation.value=mode==='fallback'?undefined:{requiresLogin:mode==='locked'};recsLoading.value=mode==='loading';recsError.value=mode==='error'?'推荐暂时不可用':'';await pause();expect(document.querySelectorAll('.toplist-card').length===4,'Public charts missing in '+mode+' recommendations')}
 presentation.value={requiresLogin:false};recsLoading.value=false;recsError.value='';await pause()
 click('全部榜单');await nextTick();expect(document.querySelectorAll('.toplist-card').length===6,'More charts did not expand');click('收起榜单')
 click('查看飙升榜');await pause();expect(document.querySelectorAll('.toplist-song').length===60,'Complete chart not rendered');expect(state.requests.at(-1)[2][1]===true,'Chart tracks must bypass stale playlist cache');expect(document.querySelector('.toplists-dialog').contains(document.activeElement),'Dialog did not capture focus')
 click('播放全部');await pause();expect(events.length===1&&state.played.length===0,'Guest playback must open login');expect(!document.querySelector('.toplists-dialog'),'Login left a modal above login page')
 state.setAuthenticated(true);click('播放新歌榜');await pause();expect(state.played.length===1&&state.played[0].queue.length===60,'Chart playback lost queue');click('播放全部');await pause();expect(state.played.length===2&&state.isPlaying.value,'Play-all paused the current song instead of replacing the queue');click('暂停 '+state.songs[0].title);await pause();expect(!state.isPlaying.value,'Current track pause did not work');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await pause();expect(!document.querySelector('.toplists-dialog'),'Escape failed');expect(document.activeElement?.getAttribute('aria-label')==='播放新歌榜','Dialog did not restore trigger focus')
 let release;state.setPending(new Promise(resolve=>release=resolve));click('播放热歌榜');await nextTick();click('关闭排行榜');release(state.songs);state.setPending(null);await pause();expect(state.played.length===2,'Closed dialog caused stale autoplay')
 state.setFailure(true);click('刷新网易云排行榜');await pause();expect(document.querySelectorAll('.toplist-card').length===4&&document.querySelector('.toplists-notice'),'Refresh failure must retain usable charts');state.setFailure(false);click('刷新网易云排行榜');await pause();expect(!document.querySelector('.toplists-notice'),'Retry did not recover')
 state.providers.value=[];await nextTick();expect(!document.querySelector('.ncm-toplists'),'Disabled provider left live chart actions');state.providers.value=[state.source];await pause()
}
window.prepareToplistPreview=async({dark,detail})=>{
 document.documentElement.dataset.theme=dark?'dark':'pureWhite'
 if(detail){click('查看飙升榜');await pause()}else{const close=document.querySelector('[aria-label="关闭排行榜"]');close?.click();await pause()}
}
window.toplistGeometry=()=>({overflow:document.querySelector('.music-home').scrollWidth>document.querySelector('.music-home').clientWidth+1,dialogOverflow:!!document.querySelector('.toplists-dialog')&&document.querySelector('.toplists-dialog').scrollWidth>document.querySelector('.toplists-dialog').clientWidth+1,columns:getComputedStyle(document.querySelector('.toplists-grid')).gridTemplateColumns.split(' ').length,cards:[...document.querySelectorAll('.toplist-card')].map(card=>({inset:parseFloat(getComputedStyle(card).paddingInlineStart),radius:parseFloat(getComputedStyle(card).borderTopLeftRadius)}))})
`

const runner = `const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:1100,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
 try{
  await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runToplistTests()')
  for(const [name,width,dark,detail,columns] of [['light',1280,false,false,4],['dark',1280,true,false,4],['narrow',760,false,false,2],['small',390,false,false,1],['detail',1280,false,true,4],['detail-dark',1280,true,true,4],['detail-small',390,false,true,1]]){
   win.setSize(width,1100);await win.webContents.executeJavaScript('window.prepareToplistPreview('+JSON.stringify({dark,detail})+')');await new Promise(resolve=>setTimeout(resolve,100))
   const geometry=await win.webContents.executeJavaScript('window.toplistGeometry()');if(geometry.overflow||geometry.dialogOverflow||geometry.columns!==columns)throw new Error(name+' invalid geometry: '+JSON.stringify(geometry))
   if(geometry.cards.some(card=>card.inset<12||card.radius<8))throw new Error(name+' cards lost shared inset or radius: '+JSON.stringify(geometry.cards))
   if(process.env.TWILIGHT_TOPLIST_SCREENSHOTS){fs.mkdirSync(process.env.TWILIGHT_TOPLIST_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_TOPLIST_SCREENSHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG())}
  }
  console.log('TOPLISTS_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`
