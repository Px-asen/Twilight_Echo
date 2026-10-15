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
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('online home preserves source/playback behavior and refresh geometry; discovery results stay immediate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-online-home-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'fixtures.ts'), fixtures)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [
        vue(),
        {
          name: 'online-home-test-stores',
          load(id) {
            if (id === '\0local-dashboard-stub')
              return 'import {h} from "vue"; export default { render: () => h("div", {"data-local-home": ""}, "Local library") }'
            return null
          }
        }
      ],
      resolve: {
        alias: [
          {
            find: /^@renderer\/(stores\/use(?:Provider|Settings|Player|Music|ListeningStats|Theme)Store|utils\/(unifiedRecentTracks|logicalTrackModel))$/,
            replacement: join(directory, 'fixtures.ts')
          },
          {
            find: /^@renderer\/components\/(?:LocalDashboard|local-dashboard\/(?:Archive|NightHarbor|SoundField)Dashboard)\.vue$/,
            replacement: '\0local-dashboard-stub'
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') },
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
          name: 'OnlineHomeTest',
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
    await writeFile(join(directory, 'runner.cjs'), electronRunner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /ONLINE_HOME_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const electronRunner = `const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:980,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
 const capture=async name=>{if(process.env.TWILIGHT_HOME_SCREENSHOTS){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await new Promise(resolve=>setTimeout(resolve,50));fs.mkdirSync(process.env.TWILIGHT_HOME_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_HOME_SCREENSHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG())}}
 try{
  await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runOnlineHomeTests()')
  for(const [name,width,dark,mode] of [['ready',1200,false,'ready'],['dark',1200,true,'ready'],['mobile',390,false,'ready'],['local',1200,false,'local'],['local-dark',1200,true,'local'],['local-mobile',390,false,'local'],['guest',1200,false,'guest'],['no-provider',1200,false,'none']]){
   win.setSize(width,980);await win.webContents.executeJavaScript('window.previewOnlineHome('+JSON.stringify({dark,mode})+')');await new Promise(resolve=>setTimeout(resolve,150))
   const overflow=await win.webContents.executeJavaScript('document.querySelector(".online-home").scrollWidth > document.querySelector(".online-home").clientWidth + 1')
   if(overflow)throw new Error('Horizontal overflow: '+name);await capture(name)
  }
  for(const width of [1200,390])for(const motion of ['full','reduced','off']){
   win.setSize(width,980);await win.webContents.executeJavaScript('window.prepareRefreshProbe('+JSON.stringify(motion)+')');await capture('refresh-'+width+'-'+motion+'-before')
   await win.webContents.executeJavaScript('window.beginRefreshProbe()');await capture('refresh-'+width+'-'+motion+'-pending')
   await win.webContents.executeJavaScript('window.finishRefreshProbe()');await capture('refresh-'+width+'-'+motion+'-after')
  }
  for(const width of [1200,390]){
   win.setSize(width,980);await win.webContents.executeJavaScript('window.prepareInitialProbe()');await capture('initial-'+width+'-loading')
   await win.webContents.executeJavaScript('window.finishInitialProbe()');await capture('initial-'+width+'-ready')
  }
  await win.webContents.executeJavaScript('window.runDiscoveryMotionTests()')
  console.log('ONLINE_HOME_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`

const fixtures = `import {ref,shallowRef} from 'vue'
export const song=(id,title='晚风经过你的窗')=>({id,source:id.split(':')[0],title,artist:'测试艺术家',album:'暮色回响',duration:180,cover:null,lyrics:null,filePath:'',fileName:'',size:0})
export const source=id=>({id,name:id==='ncm'?'网易云音乐':'独立音乐',capabilities:['playbackUrl','login','library'],supportedMethods:['daily','fetchRecommendPlaylists','fetchDiscoveryPlaylists','fetchPlaylistTracks','searchSongs','fetchUserLibrary'],ui:{icon:'pi pi-cloud',authType:'qr',streamingSections:[{id:'daily',title:'每日推荐',icon:'pi pi-music',method:'daily'}]}})
export const providers=ref([source('ncm'),source('other')]),tracks=shallowRef([]),recent=shallowRef([]),authenticated=ref(false),settings=ref({streamingActiveProvider:'ncm'}),currentTrack=shallowRef(null),isPlaying=ref(false),preview=ref(false),layout=ref('default')
export const played=[],requests=[]
export let pending=null,failPlaylist=false,homePending=null
export const setPending=value=>{pending=value},setFailure=value=>{failPlaylist=value},setHomePending=value=>{homePending=value}
const playlists=()=>['适合一个人散步的旋律','在城市里，听见晚风','把好心情放进耳机','缓慢生活的背景音乐','今天也要好好听歌','日落之后的温柔'].map((name,index)=>({id:index,name,cover:null,trackCount:12+index}))
export const useProviderStore=()=>({providers,getProvider:id=>providers.value.find(item=>item.id===id),checkLogin:async()=>({loggedIn:authenticated.value,profile:null}),callProvider:async(id,method)=>{requests.push([id,method]);if(homePending)await homePending;return method==='daily'?Array.from({length:8},(_,index)=>song(id+':'+index,['晚风经过你的窗','日落之前','沿着海岸线','写给明天的歌','缓慢降落','再听一遍'][index%6])):method==='fetchDiscoveryPlaylists'?{items:playlists()}:playlists()},fetchPlaylistTracks:async(id,playlistId)=>{if(failPlaylist)throw new Error('歌单加载失败');if(pending)return pending;return [song(id+':playlist:'+playlistId),song(id+':playlist:next')]}})
export const useSettingsStore=()=>({settings,updateSettings:async patch=>{settings.value={...settings.value,...patch}}})
export const useMusicStore=()=>({tracks})
export const usePlayerStore=()=>({currentTrack,isPlaying,playTrack:(track,queue)=>{played.push({track,queue});currentTrack.value=track;isPlaying.value=true},togglePlay:()=>{isPlaying.value=!isPlaying.value}})
export const getRecentTracks=()=>recent.value
export const resolveUnifiedRecentTracks=()=>recent.value
export const getTrackSource=track=>track.source
export const useThemeStore=()=>({presetLayout:layout})
`

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import LocalHome from '@renderer/components/local-dashboard/LocalHome.vue'
import StreamingDiscovery from '@renderer/components/StreamingDiscovery.vue'
import '@renderer/assets/base.css'
import 'primeicons/primeicons.css'
import * as state from './fixtures.ts'
const pause=()=>new Promise(resolve=>setTimeout(resolve,60))
const expect=(value,message)=>{if(!value)throw new Error(message)}
const events=[],visible=ref(true)
const discovery=ref(null)
const app=createApp({render:()=>discovery.value?h(StreamingDiscovery,{...discovery.value,onOpenPlaylist:item=>events.push('playlist:'+item.id)}):visible.value?h(LocalHome,{preview:state.preview.value,onOpenStreaming:tab=>events.push(tab),onLogin:id=>events.push('login:'+id),onOpenPlugins:()=>events.push('plugins'),onOpenRadio:()=>events.push('radio'),onSelectView:(category)=>events.push(category),onOpenLibrarySettings:()=>events.push('local-settings')}):null})
app.config.errorHandler=error=>{window.runtimeError=error.stack||String(error)}
app.mount('#app')
const click=text=>{const button=[...document.querySelectorAll('button')].find(button=>button.textContent.includes(text));expect(button,'Missing button: '+text);button.click()}
const remount=async()=>{visible.value=false;await nextTick();visible.value=true;await pause()}
window.runOnlineHomeTests=async()=>{
 await pause();expect(document.querySelector('.online-home'),'No online home for empty library: '+(window.runtimeError||document.body.innerHTML.slice(0,500)))
 expect(document.querySelector('.home-local-empty')&&document.querySelectorAll('.home-library-switch button').length===2,'Empty local library lost equal library entrances');expect(document.querySelectorAll('.online-discovery .online-playlist').length===6,'Guest discovery not shown')
 expect(!state.requests.some(([,method])=>method==='daily'),'Guest requested personalized data')
 click('发现歌单');expect(events.at(-1)==='discover','Discovery navigation failed')
 click('添加本地音乐');expect(events.at(-1)==='local-settings','Import entry failed')
 document.querySelector('.online-playlist').click();await pause();expect(events.at(-1)==='login:ncm'&&state.played.length===0,'Guest playback bypassed login')
 state.authenticated.value=true;await remount();expect(document.querySelectorAll('.online-recommendations .online-track').length===6,'Signed-in recommendations missing')
 document.querySelector('.online-recommendations .online-track').click();await pause();expect(state.played.length===1&&state.played[0].queue.length===8,'Track playback did not preserve queue')
 click('暂停播放');expect(!state.isPlaying.value,'Hero pause failed')
 document.querySelector('.online-playlist').click();await pause();expect(state.played.at(-1).queue.length===2,'Playlist playback failed')
 state.setFailure(true);document.querySelectorAll('.online-playlist')[1].click();await pause();expect(document.querySelector('.online-notice')?.textContent.includes('歌单加载失败'),'Playlist error missing');state.setFailure(false)
 let release;state.setPending(new Promise(resolve=>release=resolve));document.querySelector('.online-playlist').click();await pause()
 expect(document.querySelector('.online-playlist').disabled,'Pending playlist can be repeatedly clicked')
 expect(document.querySelector('.online-playlist .pi-spinner.pi-spin'),'Pending playlist indicator is static')
 const count=state.played.length;const select=document.querySelector('select');select.value='other';select.dispatchEvent(new Event('change',{bubbles:true}));await pause()
 release([state.song('ncm:stale')]);state.setPending(null);await pause();expect(state.played.length===count,'Old provider request started playback');expect(state.settings.value.streamingActiveProvider==='other','Source preference not persisted')
 state.tracks.value=[state.song('local:import')];await pause();expect(document.querySelector('.online-home')&&document.querySelectorAll('.home-local-card').length===1,'Import must populate local shelf without replacing homepage');document.querySelector('.home-library-switch button').click();expect(events.at(-1)==='allSongs','Local library navigation failed');const playedBefore=state.played.length;document.querySelector('.home-local-card').click();await pause();expect(state.played.length===playedBefore+1&&state.played.at(-1).track.id==='local:import','Local shelf playback failed')
 const requestsBeforePreview=state.requests.length;state.tracks.value=[];state.preview.value=true;await pause();expect(document.querySelector('.home-local-empty')&&state.requests.length===requestsBeforePreview,'Theme preview must retain local section without provider requests')
 state.preview.value=false;state.providers.value=[];state.currentTrack.value=null;await pause();click('接入在线音源');expect(events.at(-1)==='plugins','No-provider setup failed');click('电台与播客');expect(events.at(-1)==='radio','Radio navigation failed')
}
window.previewOnlineHome=async({dark,mode})=>{document.documentElement.dataset.theme=dark?'dark':'light';state.providers.value=mode==='none'?[]:[state.source('ncm'),state.source('other')];state.settings.value={streamingActiveProvider:'ncm'};state.authenticated.value=mode==='ready'||mode==='local';state.tracks.value=mode==='local'?Array.from({length:6},(_,i)=>({...state.song('local:collection:'+i,['黄昏的海岸','一张旧唱片','窗边的旋律','缓慢时光','回家的路','属于你的声音'][i]),source:'local'})):[];state.currentTrack.value=null;state.recent.value=mode==='ready'?[state.song('ncm:recent','把今天的心情，留给音乐')]:[];await remount()}
let refreshProbe=null
window.prepareRefreshProbe=async motion=>{
 document.documentElement.dataset.teMotion=motion
 await window.previewOnlineHome({dark:false,mode:'ready'});await new Promise(resolve=>setTimeout(resolve,220))
 const results=document.querySelector('.online-results'),first=document.querySelector('.online-recommendations .online-track'),footer=document.querySelector('.online-footer')
 refreshProbe={results,first,height:results.getBoundingClientRect().height,footerTop:footer.getBoundingClientRect().top,motion}
 document.querySelector('.online-home').scrollTop=document.querySelector('.online-discovery').offsetTop-24
 refreshProbe.footerTop=footer.getBoundingClientRect().top
}
window.beginRefreshProbe=async()=>{
 state.setHomePending(new Promise(resolve=>{refreshProbe.release=resolve}))
 document.querySelector('[aria-label="刷新在线推荐"]').click();await nextTick()
 expect(document.querySelector('.online-results')===refreshProbe.results,'Refresh remounted recommendation container')
 expect(document.querySelector('.online-recommendations .online-track')===refreshProbe.first,'Refresh remounted song row')
 expect(!document.querySelector('.online-loading-content'),'Refresh replaced loaded content with skeleton')
 expect(document.querySelector('.online-discovery').getAttribute('aria-busy')==='true','Refresh is missing busy semantics')
 const styles=getComputedStyle(refreshProbe.results),hover=getComputedStyle(document.documentElement).getPropertyValue('--te-motion-hover').trim()
 const sharedHover=hover.endsWith('ms')?parseFloat(hover)/1000+'s':hover
 const expected=refreshProbe.motion==='off'?'0s':refreshProbe.motion==='reduced'?'0.12s':sharedHover
 expect(styles.transitionDuration===expected,'Wrong refresh duration for '+refreshProbe.motion+': '+styles.transitionDuration)
 expect(styles.transform==='none','Refresh moves the result container')
 expect(document.querySelector('.online-sr-only[role="status"]').textContent.includes('正在刷新'),'Refresh status missing')
 await pause()
 const opacity=Number(getComputedStyle(refreshProbe.results).opacity)
 expect(opacity>=0.65&&opacity<1,'Refresh opacity did not respond')
 expect(Math.abs(refreshProbe.results.getBoundingClientRect().height-refreshProbe.height)<1,'Pending refresh collapsed result geometry')
 expect(Math.abs(document.querySelector('.online-footer').getBoundingClientRect().top-refreshProbe.footerTop)<1,'Pending refresh moved footer')
}
window.finishRefreshProbe=async()=>{
 state.setHomePending(null);refreshProbe.release();await pause()
 expect(document.querySelector('.online-results')===refreshProbe.results,'Successful refresh remounted container')
 expect(document.querySelector('.online-recommendations .online-track')===refreshProbe.first,'Successful refresh remounted stable row')
 expect(document.querySelector('.online-discovery').getAttribute('aria-busy')==='false','Refresh remained busy')
 expect(Math.abs(refreshProbe.results.getBoundingClientRect().height-refreshProbe.height)<1,'Successful refresh changed stable geometry')
 expect(Math.abs(document.querySelector('.online-footer').getBoundingClientRect().top-refreshProbe.footerTop)<1,'Successful refresh moved footer')
 await new Promise(resolve=>setTimeout(resolve,180));expect(getComputedStyle(refreshProbe.results).opacity==='1','Refresh did not settle visibly')
}
let initialProbe=null
window.prepareInitialProbe=async()=>{
 document.documentElement.dataset.teMotion='full';state.currentTrack.value=state.song('ncm:recent');state.settings.value={streamingActiveProvider:'ncm'}
 state.setHomePending(new Promise(resolve=>{initialProbe={release:resolve}}));await remount()
 const skeleton=document.querySelector('.online-loading-content');expect(skeleton,'Initial loading skeleton missing')
 initialProbe.height=skeleton.getBoundingClientRect().height
 expect(skeleton.querySelectorAll('.online-track').length===6&&skeleton.querySelectorAll('.online-playlist').length===6,'Initial loading does not reserve both content sections')
 document.querySelector('.online-home').scrollTop=document.querySelector('.online-discovery').offsetTop-24
}
window.finishInitialProbe=async()=>{
 state.setHomePending(null);initialProbe.release();await new Promise(resolve=>setTimeout(resolve,220))
 const height=document.querySelector('.online-results').getBoundingClientRect().height
 expect(Math.abs(height-initialProbe.height)<Math.max(64,height*0.1),'Initial skeleton does not approximate loaded content: '+initialProbe.height+' -> '+height)
}
window.runDiscoveryMotionTests=async()=>{
 const items=seed=>Array.from({length:30},(_,index)=>({id:seed+index,name:'Playlist '+(seed+index),trackCount:10,cover:null}))
 discovery.value={providerLabel:'Music',supportsSort:true,supportsCategories:true,supportsHighQuality:true,catalogue:{hotTags:['华语'],groups:[]},catalogueLoading:false,catalogueError:'',selectedTag:'全部',order:'hot',highQuality:false,panelExpanded:false,playlists:items(0),total:90,offset:0,hasMore:true,listLoading:false,listError:'',loadingMore:false}
 await new Promise(resolve=>setTimeout(resolve,650))
 for(const motion of ['full','reduced','off']){
  document.documentElement.dataset.teMotion=motion
  for(const [index,patch] of [{offset:30},{selectedTag:'华语',offset:0},{order:'new'}].entries()){
   const seed=(index+1)*100;discovery.value={...discovery.value,...patch,playlists:items(seed)};await nextTick()
   const cards=[...document.querySelectorAll('.disc-feature,.disc-card')]
   expect(cards.length===30,'Discovery result count changed')
   for(const card of cards){const style=getComputedStyle(card);expect(style.opacity==='1'&&style.animationName==='none','Discovery result is delayed in '+motion);expect(card.getAnimations().length===0,'Discovery card restarts choreography')}
   cards.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));expect(events.at(-1)==='playlist:'+(seed+29),'New result is not immediately keyboard actionable')
  }
 }
 document.documentElement.dataset.teMotion='full'
 expect(getComputedStyle(document.querySelector('.disc-card-media')).transitionProperty!=='none','Discovery lost hover feedback')
}
`
