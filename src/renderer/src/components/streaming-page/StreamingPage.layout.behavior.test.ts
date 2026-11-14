import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test(
  'streaming details clear the title bar, people use an aligned spacious grid, and liked songs remain locatable',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-streaming-layout-'))
    try {
      const appSource = await readFile(new URL('../../App.vue', import.meta.url), 'utf8')
      const shellCss = parse(appSource)
        .descriptor.styles.filter((style) => !style.scoped)
        .map((style) => style.content)
        .join('\n')
      await writeFile(
        join(directory, 'entry.mjs'),
        `${runtime}\nconst shellStyle=document.createElement('style');shellStyle.textContent=${JSON.stringify(shellCss)};document.head.appendChild(shellStyle);`
      )
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'streaming-layout-fixture',
            enforce: 'pre',
            resolveId(source) {
              if (/(?:^|[./])usePlayerStore(?:\.ts)?$/.test(source)) return '\0layout-player'
              return null
            },
            load(id) {
              return id === '\0layout-player'
                ? 'export const usePlayerStore = () => window.layoutPlayer'
                : null
            },
            transform(code, id) {
              if (!id.replaceAll('\\', '/').endsWith('/components/StreamingPage.vue')) return null
              // Supply loaded data through the real page's navigation state; all
              // rendering, scrolling, transitions and scoped styles stay real.
              return code.replace('</script>', `${fixtureAccess}\n</script>`)
            }
          },
          vue()
        ],
        resolve: {
          alias: {
            '@renderer': join(workspace, 'src/renderer/src'),
            vue: require.resolve('vue/dist/vue.esm-bundler.js')
          }
        },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
        build: {
          outDir: join(directory, 'bundle'),
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: join(directory, 'entry.mjs'),
            name: 'StreamingLayout',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-theme="pureWhite"><head><meta charset="utf-8">${files
          .filter((f) => f.endsWith('.css'))
          .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
          .join(
            ''
          )}<style>body{margin:0}#caption{position:fixed;inset:0 0 auto;height:var(--te-titlebar-inset);z-index:9999;background:var(--te-app-bg)}#app{height:100vh}</style></head><body><div id="caption">Twilight Echo</div><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')
      buildSync({
        stdin: {
          contents: `import './src/adapters-node/index.ts'; export { CoreBrowseService } from './src/core/browse/service.ts'`,
          resolveDir: workspace
        },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        define: { 'import.meta.url': '__entryUrl' },
        banner: { js: 'const __entryUrl = require("node:url").pathToFileURL(__filename).href;' },
        outfile: join(directory, 'browse.cjs')
      })
      await writeFile(
        join(directory, 'preload.cjs'),
        `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('browseFixture',(name,payload)=>ipcRenderer.invoke('fixture:browse',name,payload))`
      )
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      if (process.env.TWILIGHT_STREAMING_PROVIDER_ONLY) {
        assert.match(result.stdout, /STREAMING_PROVIDER_OK/)
        return
      }
      if (process.env.TWILIGHT_STREAMING_PERSONALIZED_ONLY) {
        assert.match(result.stdout, /STREAMING_PERSONALIZED_OK/)
        return
      }
      if (process.env.TWILIGHT_STREAMING_AUTH_ONLY) {
        assert.match(result.stdout, /STREAMING_AUTH_OK/)
        return
      }
      if (!process.env.TWILIGHT_STREAMING_RESTORE_ONLY) {
        assert.match(result.stdout, /STREAMING_LAYOUT_OK/)
        assert.match(result.stdout, /STREAMING_LOCATE_OK/)
        assert.match(result.stdout, /STREAMING_PEOPLE_OK/)
      }
      assert.match(result.stdout, /STREAMING_RESTORE_OK/)
      assert.match(result.stdout, /STREAMING_AUTH_OK/)
      console.log(result.stdout.split('\n').find((line) => line.startsWith('STREAMING_RESTORE_OK')))
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixtureAccess = `
defineExpose({
  fixtureState() { return { provider: activeProvider.value, tab: activeTab.value, users: detailUsers.value.length, error: detailError.value, loading: restoringPage || detailLoading.value || browseState.value.loading, total: browseState.value.total, resident: detailTracks.value.length, offset: browseState.value.offset, draft: aggregateDraftName.value, stack: detailStack.value.map(entry => ({ type: entry.view.type, saved: !!entry.snapshot })) } },
  fixtureDraft(value: string) { aggregateDraftName.value = value },
  async showFixtureDetail(kind: string, tracks: Track[], cover: string) {
    resetDetail({ animate: false })
    beginDetailTransition()
    const view: DetailView = kind === 'liked' ? { type: 'liked' }
      : kind === 'artist' ? { type: 'artist', artist: { id: 'fixture', name: '测试歌手', picUrl: cover, albumSize: 0, musicSize: tracks.length } }
      : kind === 'album' ? { type: 'album', providerId: 'ncm', album: { id: 'fixture', name: '测试专辑', cover, trackCount: tracks.length } }
      : { type: 'playlist', playlist: { id: 'fixture', name: '测试歌单', cover, trackCount: tracks.length } }
    pushDetail(view)
    await setDetailTracks(tracks)
  },
  showFixturePeople(users: NcmUserSummary[], listType: 'follows' | 'followers' = 'follows', loading = false, error = '') {
    resetDetail({ animate: false })
    beginDetailTransition()
    pushDetail({ type: 'user_list', listType, users, title: listType === 'follows' ? '关注' : '粉丝' })
    detailUsers.value = users
    detailLoading.value = loading
    detailError.value = error
  },
  backFixtureDetail() { goBack() },
  resetFixtureDetail() { resetDetail({ animate: false }) }
})
`

const runtime = `
import {createApp,h,nextTick,ref} from 'vue'
import StreamingPage from '@renderer/components/StreamingPage.vue'
import LoginPage from '@renderer/components/LoginPage.vue'
import {useNcmStore} from '@renderer/stores/useNcmStore.ts'
import {useProviderStore} from '@renderer/stores/useProviderStore.ts'
import {useSettingsStore} from '@renderer/stores/useSettingsStore.ts'
import {useCoreConnection} from '@renderer/stores/coreConnection.ts'
import {useAppNoticeStore} from '@renderer/stores/useAppNoticeStore.ts'
import { coreSnapshot } from '@renderer/stores/coreTestFixtures.ts'
import {installScrollToTopButton} from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
import '@renderer/assets/icon-fonts.ts'
installScrollToTopButton();
const noop=()=>{};
let authMode='guest',authProviders=[],authConnectDelay=0,authConnectCount=0;
let recommendationMode='ready',recommendationCalls=0;
const providerCalls=[],settingsWrites=[];
let fixtureSettings={streamingActiveProvider:'ncm'};
const settingsSnapshot=()=>({settings:fixtureSettings,defaults:{},paths:{},appVersion:'2.0.2',platform:'win32',restartReasons:[]});
const authProfile={userId:42,nickname:'已保存的网易云账号',avatarUrl:'',signature:'',follows:0,followeds:0};
const biliProfile={...authProfile,userId:84,nickname:'Bilibili 测试账号'};
window.api={
 core:{
  connect:async()=>{authConnectCount++;if(authConnectDelay)await new Promise(resolve=>setTimeout(resolve,authConnectDelay));return {ok:true,value:{connectionId:'layout',snapshot:coreSnapshot()}}},
  onMessage:()=>noop,onStatus:()=>noop,disconnect:async()=>{},cancel:async()=>{},
  request:async(_id,request)=>{
   if(request.name==='providers.list')return {ok:true,value:authProviders};
   if(request.name==='providers.call'){
     const {providerId,method}=request.payload;
     providerCalls.push({providerId,method});
     if(method==='fetchUserLibrary')return {ok:true,value:providerId==='bili'?{likedPlaylist:{id:'bili-default',name:'默认收藏夹',trackCount:203},playlists:[]}:{likedPlaylist:null,playlists:[]}};
     if(method==='fetchCloudSongsPage')return {ok:true,value:{items:[],total:0,hasMore:false,nextOffset:0}};
     if(method==='fetchDiscoveryPlaylists'){
       if(providerId!=='ncm')throw Error('Bilibili must not receive discovery requests');
       return {ok:true,value:{items:[{id:'discovery-1',name:'网易云发现测试歌单',cover,trackCount:12}],total:1,offset:0,hasMore:false}};
     }
     if(method==='checkLogin'){
       if(authMode==='offline')throw Error('登录状态检查暂时失败，请重试');
       return {ok:true,value:{loggedIn:authMode==='ready',profile:authMode==='ready'?(providerId==='bili'?biliProfile:authProfile):null}};
     }
     if(method==='openOfficialLogin'){authMode='ready';return {ok:true,value:{loggedIn:true,profile:authProfile}};}
     if(method==='logout'){authMode='guest';return {ok:true,value:undefined};}
     if(method==='fetchRecommendSongs'||method==='fetchRecommendPlaylists'){
       recommendationCalls++;
       if(recommendationMode==='failure')throw Error('推荐服务暂时不可用');
       return {ok:true,value:method==='fetchRecommendSongs'&&recommendationMode!=='empty'?tracks.slice(0,3):[]};
     }
     if(method==='fetchPersonalFm'||method==='fetchPrivateContent')return {ok:true,value:recommendationMode==='empty'?[]:tracks.slice(3,6)};
     return {ok:true,value:[]};
   }
   if(request.name.startsWith('browse.')) {
     try { return {ok:true,value:await window.browseFixture(request.name,request.payload)} }
     catch(error) { errors.push(request.name+': '+String(error)); throw error }
   }
   const pages={
    'providers.list':[],
    'catalog.query':{revision:0,total:0,offset:0,items:[]},
    'playlists.state':{revision:0,ordinary:0,aggregate:0,likedPlaylistId:null},
    'playlists.catalog':{revision:0,total:0,offset:0,items:[]},
    'library.metadata':{revision:0,trackCount:0,folders:[],exclusions:[]},
    'downloads.page':{revision:0,total:0,offset:0,items:[]},
    'statistics.summary':{revision:0,days:{},trackCount:0,totalSeconds:0},
    'statistics.tracks':{revision:0,total:0,offset:0,items:[]}
   };
   if(!(request.name in pages))throw Error('Unexpected layout request: '+request.name);
   return {ok:true,value:pages[request.name]};
  }
 },
 data:{loadPlaybackBookmarks:async()=>null},
 settings:{onChanged:()=>noop,get:async()=>settingsSnapshot(),update:async patch=>{settingsWrites.push(patch);fixtureSettings={...fixtureSettings,...patch};return settingsSnapshot()}},
 providers:{list:async()=>[],call:async()=>[]},
 providerDownloads:{list:async()=>[],onChanged:()=>noop},
 ncmCloud:{onProgress:()=>noop}
};
window.layoutPlayer={currentTrack:ref(null),personalizedStreamSession:ref(null),personalizedStreamRemaining:ref(0),queue:ref([]),playTrack:noop,playTrackPages:async(produce)=>{window.playedCount=0;await produce(async tracks=>{window.playedCount+=tracks.length})},startPersonalizedStream:noop,appendPersonalizedStreamTracks:noop,formatTime:seconds=>Math.floor(seconds/60)+':00'};
const errors=[];
window.addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
const page=ref(null),tab=ref('library'),loginVisible=ref(false),authNavigationRevision=ref(0);
let app;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const expect=(ok,label)=>{if(!ok)throw new Error(label)};
const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const paint=canvas.getContext('2d');paint.fillStyle='#718f9c';paint.fillRect(0,0,256,256);const cover=canvas.toDataURL();
const tracks=Array.from({length:100},(_,i)=>({id:'fixture-'+i,title:'歌曲 '+i,artist:'测试歌手',album:'测试专辑',duration:180,source:'ncm',ncmSongId:i+1,cover}));
const names=['Porter Robinson','C418','Ludicin','ReeK','Ophidian','n-buna','ヨルシカ','重音テト','Betwixt & Between','MIMI','25時、ナイトコードで。','花譜','Sad Keyboard Guy','void (Mournfinale)'];
const portraits=['#c85f92','#527e8a','#bd8c58','#65628a'].map(color=>{paint.fillStyle=color;paint.fillRect(0,0,256,256);paint.fillStyle='#e9dbca';paint.beginPath();paint.ellipse(128,91,41,48,0,0,Math.PI*2);paint.fill();paint.fillStyle='#e1c4ae';paint.beginPath();paint.ellipse(128,248,85,92,0,0,Math.PI*2);paint.fill();return canvas.toDataURL()});
const people=Array.from({length:80},(_,i)=>({id:i+1,name:names[i%names.length],picUrl:i%3===1?null:portraits[i%portraits.length],musicSize:0,userType:0}));
const mount=async(wait=250)=>{app?.unmount();app=createApp({render:()=>loginVisible.value?h(LoginPage,{initialProviderId:'ncm',onLoginSuccess:()=>{loginVisible.value=false}}):h(StreamingPage,{key:tab.value,ref:page,active:true,menuOpen:false,hasPlayer:false,initialTab:tab.value,rootNavigationRevision:authNavigationRevision.value,onLogin:()=>{loginVisible.value=true}})});app.config.errorHandler=error=>errors.push(String(error));app.mount('#app');if(wait)await pause(wait);else await nextTick()};
window.checkStreamingProviderSelection=async stage=>{
 const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await pause(20)}throw Error(label+': '+JSON.stringify(page.value?.fixtureState())+' '+document.body.innerText.slice(-1000)+' '+errors.join(';'))};
 if(stage==='switch-library'){
  app?.unmount();app=null;authNavigationRevision.value++;authMode='ready';recommendationMode='ready';
  authProviders=[
   {id:'ncm',name:'网易云音乐',capabilities:['login','library','playlist'],supportedMethods:['checkLogin','fetchUserLibrary','fetchDiscoveryPlaylists','fetchRecommendSongs','fetchRecommendPlaylists'],ui:{icon:'pi pi-cloud',streamingSections:[{id:'daily',title:'每日推荐',icon:'pi pi-calendar',method:'fetchRecommendSongs'}]}},
   {id:'bili',name:'Bilibili',capabilities:['login','library','playlist'],supportedMethods:['checkLogin','fetchUserLibrary'],ui:{icon:'pi pi-video',streamingLibraryTab:true}}
  ];
  await useSettingsStore().updateSettings({streamingActiveProvider:'ncm'});
  document.documentElement.dataset.teMotion='off';
  await useCoreConnection().attach();await useProviderStore().syncProviders();useNcmStore().setLogin(authProfile);
  tab.value='library';await mount();
  document.querySelector('.streaming-header-provider-switcher .provider-switcher-trigger').click();await nextTick();
  [...document.querySelectorAll('.provider-switcher-option')].find(button=>button.textContent.includes('Bilibili')).click();
  await wait(()=>document.querySelector('.favorites-info h2')?.textContent==='默认收藏夹','Bilibili library loads after explicit selection');
  await wait(()=>useSettingsStore().settings.value.streamingActiveProvider==='bili','explicit selection is saved');
  expect(document.body.innerText.includes('203'),'Bilibili favorite count changed');
 }else{
  tab.value=stage==='return-library'?'library':stage==='home'?'home':stage==='cloud'?'cloud':'discover';await nextTick();
  if(stage==='return-library'){
   await wait(()=>document.querySelector('.favorites-info h2')?.textContent==='默认收藏夹','return restores Bilibili library');
   expect(page.value.fixtureState().provider==='bili','discovery changed the library selection');
  }else if(stage==='home'){
   await wait(()=>document.querySelector('.hero-title'),'homepage selects a supported source');
   expect(page.value.fixtureState().provider==='ncm','homepage retained Bilibili');
  }else if(stage==='cloud'){
   await wait(()=>page.value?.fixtureState().provider==='ncm','cloud selects NetEase');
  }else{
   await wait(()=>document.querySelector('.disc')&&document.body.innerText.includes('网易云发现测试歌单'),'discovery must render the discovery source, not Bilibili favorites');
   expect(page.value.fixtureState().tab==='discover'&&page.value.fixtureState().provider==='ncm','discovery retained library source');
   expect(!document.querySelector('.favorites-info'),'discovery shows library content');
  }
  expect(useSettingsStore().settings.value.streamingActiveProvider==='bili','automatic surface fallback overwrote the saved library preference');
 }
 expect(!providerCalls.some(call=>call.providerId==='bili'&&call.method==='fetchDiscoveryPlaylists'),'discovery dispatched to Bilibili');
 expect(settingsWrites.length===2,'surface fallback persisted an automatic provider selection');
 expect(errors.length===0,errors.join(';'));
};
const streamStarts=[];
let streamResolve,streamReject;
window.layoutPlayer.startPersonalizedStream=(...args)=>{
 streamStarts.push(args);
 return new Promise((resolve,reject)=>{streamResolve=resolve;streamReject=reject});
};
window.setupPersonalizedPlayback=async(empty=false)=>{
 app?.unmount();app=null;authNavigationRevision.value++;
 document.documentElement.dataset.teMotion='off';tab.value='home';authMode='ready';recommendationMode=empty?'empty':'ready';
 useAppNoticeStore().clearNotices();
 authProviders=[{id:'ncm',name:'网易云音乐',capabilities:['login','playbackUrl','library'],supportedMethods:['checkLogin','fetchRecommendSongs','fetchRecommendPlaylists','fetchPersonalFm','fetchPrivateContent'],ui:{streamingSections:[
  {id:'daily',title:'每日推荐',icon:'pi pi-calendar',method:'fetchRecommendSongs'},
  {id:'fm',title:'私人漫游',icon:'pi pi-compass',method:'fetchPersonalFm'},
  {id:'radar',title:'私人雷达',icon:'pi pi-send',method:'fetchPrivateContent'}
 ]}}];
 await useCoreConnection().attach();await useProviderStore().syncProviders();useNcmStore().setLogin(authProfile);await mount();
 expect(document.querySelectorAll('.duo-card').length===2,'both station cards must render');
 if(!empty){
  const before=streamStarts.length;window.playedCount=0;document.querySelector('.hero-play').click();
  for(let i=0;i<100&&window.playedCount!==3;i++)await pause(10);
  expect(window.playedCount===3&&streamStarts.length===before,'daily mix no longer plays its browse queue');
 }
 expect(errors.length===0,errors.join(';'));
};
window.startPersonalizedPlayback=async key=>{
 const before=streamStarts.length,card=document.querySelector('.duo-'+key);
 card.scrollIntoView({block:'center'});card.click();await nextTick();
 expect(streamStarts.length===before+1,'station click did not start playback');
 const args=streamStarts.at(-1);
 expect(args.length===2&&args[0]===key&&args[1]==='ncm','station must start without an obsolete preview track: '+JSON.stringify(args));
 expect(card.getAttribute('aria-busy')==='true'&&card.textContent.includes('正在准备播放'),'station has no loading feedback');
 for(const button of document.querySelectorAll('.duo-card')){expect(button.disabled,'station can be submitted twice');button.click();}
 await nextTick();expect(streamStarts.length===before+1,'repeated click started another station');
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 expect(errors.length===0,errors.join(';'));
};
window.finishPersonalizedPlayback=async(failed=false)=>{
 if(failed)streamReject(new Error('电台服务暂时不可用，请重试'));else streamResolve();
 await pause(20);await nextTick();
 expect([...document.querySelectorAll('.duo-card')].every(button=>!button.disabled&&button.getAttribute('aria-busy')==='false'),'station remained busy after completion');
 if(failed)expect(useAppNoticeStore().notices.value.some(notice=>notice.kind==='error'&&notice.message.includes('电台服务暂时不可用')),'station failure was not shown to the user');
 expect(errors.length===0,errors.join(';'));
};
window.checkStreamingAuthentication=async stage=>{
 const wait=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await pause(30)}throw Error(label+': '+document.body.innerText.slice(-1000)+' '+errors.join(';'))};
 const store=useNcmStore();
 if(stage==='offline'){
   app?.unmount();app=null;
   document.documentElement.dataset.teMotion='off';tab.value='home';authMode='offline';
   authProviders=[{id:'ncm',name:'网易云音乐',capabilities:['login','playbackUrl','library'],supportedMethods:['checkLogin','fetchRecommendSongs','fetchRecommendPlaylists','openOfficialLogin'],ui:{authType:'qr',icon:'pi pi-cloud',loginExtraActions:[{label:'使用官方网页登录',method:'openOfficialLogin',primary:true}],streamingSections:[{id:'daily',title:'每日推荐',icon:'pi pi-calendar',method:'fetchRecommendSongs'}]}}];
   await useCoreConnection().attach();await useProviderStore().syncProviders();await mount();
   await wait(()=>document.body.innerText.includes('暂时无法确认登录状态'),'cold-start status error');
   expect(!document.querySelector('.hero-invite'),'status error asks for another login');
 }else if(stage==='retry'){
   authMode='ready';[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='重试').click();
   await wait(()=>store.isLoggedIn.value&&document.querySelector('.hero-title'),'saved session retry');
   expect(!document.body.innerText.includes('登录后查看推荐'),'saved session still displays login invite');
 }else if(stage==='official'){
   await store.logout();await nextTick();await wait(()=>document.querySelector('.invite-cta'),'logout must clear homepage');
   document.querySelector('.invite-cta').click();
   await wait(()=>document.querySelector('.disclaimer-accept'),'login page');
   document.querySelector('.disclaimer-accept').click();
   await wait(()=>!loginVisible.value&&store.profile.value?.userId===42,'official login returns to streaming');
   await wait(()=>document.querySelector('.hero-title'),'recommendations after login');
   expect(!document.body.innerText.includes('登录后查看推荐'),'successful login returned to signed-out home');
 }else if(stage==='delayed-entry'){
   app?.unmount();app=null;authNavigationRevision.value++;authMode='ready';authConnectDelay=100;
   await pause(150);store.setLogin(authProfile);
   const connected=authConnectCount;
   for(let visit=0;visit<5;visit++){
     if(visit%2===0){app?.unmount();app=null;authNavigationRevision.value++;}
     const before= recommendationCalls;
     await mount();
     await wait(()=>document.querySelector('.hero-title'),'automatic home load during Core attachment, visit '+visit);
     expect(!document.querySelector('.home-error'),'page load requires a manual retry, visit '+visit);
     expect(authConnectCount===connected,'page visit reattached the shared Core connection');
     if(visit%2===1)expect(recommendationCalls===before,'cached recommendations fetched again');
   }
   authConnectDelay=0;
 }else if(stage==='failed-cache'){
   app?.unmount();app=null;authNavigationRevision.value++;recommendationMode='failure';
   await mount();await wait(()=>document.querySelector('.home-error'),'initial recommendation failure');
   recommendationMode='ready';await mount();
   await wait(()=>document.querySelector('.hero-title'),'failed cached home loads automatically on return');
   expect(!document.querySelector('.home-error'),'cached failure still needs manual retry');
   app?.unmount();app=null;authNavigationRevision.value++;recommendationMode='empty';
   await mount();await wait(()=>document.body.innerText.includes('暂无推荐歌单'),'valid empty recommendation result');
   const before=recommendationCalls;await mount();
   expect(recommendationCalls===before,'valid empty recommendations fetched again');
   recommendationMode='ready';
 }else{
   authMode='offline';await store.checkLogin();await mount();
   await wait(()=>document.querySelector('.hero-title'),'revisit preserves verified session');
   expect(store.isLoggedIn.value&&!document.body.innerText.includes('登录后查看推荐'),'transient error lost session on revisit');
 }
 expect(errors.length===0,errors.join(';'));
};
window.checkStreamingRestoration=async()=>{
 document.documentElement.dataset.teMotion='off';tab.value='library';await mount();
 const many=Array.from({length:4201},(_,i)=>({...tracks[i%tracks.length],id:'fixture-'+i,title:'歌曲 '+i,ncmSongId:i+1,cover:null}));
 await page.value.showFixtureDetail('playlist',many,cover);await nextTick();
 const wait=async(predicate,label)=>{const deadline=performance.now()+3000;while(!predicate()){expect(performance.now()<deadline,label+': '+JSON.stringify(page.value?.fixtureState()));await pause(5)}};
 const scroll=document.querySelector('.streaming-content');scroll.scrollTop=64*3000;scroll.dispatchEvent(new Event('scroll'));
 await wait(()=>page.value.fixtureState().offset>2000&&!page.value.fixtureState().loading,'deep page');
 page.value.fixtureDraft('未保存的歌单');
 const offset=scroll.scrollTop,samples=[];
 for(let i=0;i<50;i++){
   const start=performance.now();await mount(0);
   await wait(()=>page.value.fixtureState().total===4201&&!page.value.fixtureState().loading&&page.value.fixtureState().offset>2000,'cached page restore');
   await nextTick();
   expect(page.value.fixtureState().resident<=1000,'page exceeded resident budget');
   expect(page.value.fixtureState().draft==='未保存的歌单','draft was lost');
   expect(Math.abs(document.querySelector('.streaming-content').scrollTop-offset)<2,'scroll anchor was lost');
   samples.push(performance.now()-start);
 }
 document.querySelector('.streaming-content').scrollTop=0;document.querySelector('.streaming-content').dispatchEvent(new Event('scroll'));
 await wait(()=>!page.value.fixtureState().loading,'top page');
 const play=[...document.querySelectorAll('button')].find(button=>button.textContent.includes('播放全部'));expect(play,'play all button');play.click();
 await wait(()=>window.playedCount===4201,'play all must cover 4201 tracks');
 expect(errors.length===0,errors.join(';'));samples.sort((a,b)=>a-b);
 const p95=samples[Math.ceil(samples.length*.95)-1];expect(p95<=300,'cached UI restore p95 exceeded: '+p95);
 return {cycles:50,tracks:4201,p95Ms:p95,played:window.playedCount};
};
window.checkStreamingLayout=async(kind,tone,search=false,caption=40,custom=false)=>{
 document.documentElement.dataset.theme=tone;
 if(custom)document.documentElement.dataset.teShellLayout='custom';else delete document.documentElement.dataset.teShellLayout;
 document.documentElement.style.setProperty('--te-titlebar-inset',caption+'px');
 Object.assign(document.querySelector('#app').style,{position:custom?'relative':'static',top:custom?caption+'px':'0',height:custom?'calc(100vh - '+caption+'px)':'100vh'});
 tab.value=search?'search':'library';await mount();
 expect(errors.length===0,errors.join(';'));
 await page.value.showFixtureDetail(kind,tracks,cover);await nextTick();await pause(450);
 const scroll=document.querySelector('.streaming-content');
 scroll.scrollTop=500;scroll.dispatchEvent(new Event('scroll'));await pause(80);
 scroll.scrollTop=0;scroll.dispatchEvent(new Event('scroll'));await pause(80);
 const ring=document.querySelector('.stage-cover-ring');
 expect(ring,'missing '+kind+' cover');
 const top=ring.getBoundingClientRect().top,bottom=document.querySelector('#caption').getBoundingClientRect().bottom;
 expect(scroll.scrollTop===0,'fixture must be at scroll top');
 expect(top>=bottom+12,kind+' cover overlaps caption: cover '+top+', caption '+bottom);
 expect(!document.querySelector('.detail-back-button'),'duplicate detail back button');
 if(search)expect(document.querySelector('.streaming-search-box'),'detail removed search controls');
 else expect(!document.querySelector('.streaming-content-header'),'detail retained an empty header');
 expect(document.documentElement.scrollWidth<=innerWidth,'horizontal overflow');
 expect(errors.length===0,errors.join(';'));
 return {kind,tone,search,caption,top,bottom};
};
window.checkStreamingPeople=async(tone)=>{
 document.documentElement.dataset.theme=tone;
 delete document.documentElement.dataset.teShellLayout;
 document.documentElement.style.setProperty('--te-titlebar-inset','40px');
 Object.assign(document.querySelector('#app').style,{position:'static',top:'0',height:'100vh'});
 tab.value='library';await mount();
 const show=async(users=people,listType='follows',loading=false,error='')=>{page.value.showFixturePeople(users,listType,loading,error);await nextTick();await pause(450)};
 await show();
 const title=document.querySelector('.stage-title'),count=document.querySelector('.stage-people-count'),grid=document.querySelector('.stage-people-grid');
 const cards=Array.from(grid.querySelectorAll('button.stage-person-card'));
 const rect=element=>element.getBoundingClientRect();
 const columns=getComputedStyle(grid).gridTemplateColumns.split(' ').length;
 expect(title.textContent==='关注'&&count.textContent==='共 80 人','people header must retain the title and loaded count');
 expect(document.querySelector('.stage-people-header').textContent.replaceAll(/\\s/g,'')==='关注共80人','people header contains extra decoration');
 expect(!document.querySelector('.stage-cover-frame')&&!document.querySelector('.stage-kicker'),'people retained the oversized cover or social kicker');
 expect(Math.abs(rect(title).left-rect(grid).left)<1&&Math.abs(rect(count).left-rect(grid).left)<1,'title, count and grid must share a left edge');
 expect(rect(title).top>=rect(document.querySelector('#caption')).bottom+12,'people header overlaps title bar');
 expect(rect(count).top>=rect(title).bottom&&rect(grid).top>=rect(count).bottom+20,'people header spacing is cramped');
 expect(cards.length===80,'people grid dropped loaded users');
 expect(innerWidth<1000?columns===2:columns<=6,'people grid still packs too many people in a row: '+columns);
 const avatar=cards[0].querySelector('.stage-person-avatar'),avatarSize=rect(avatar).width;
 expect(Math.abs(avatarSize-(innerWidth<=640?88:104))<0.5,'people avatar size is incorrect: '+JSON.stringify({avatarSize,width:innerWidth,computed:getComputedStyle(avatar).width,variable:getComputedStyle(grid).getPropertyValue('--stage-person-avatar-size')}));
 expect(rect(cards[0]).height>=(innerWidth<=640?184:212),'people cards did not grow');
 const firstRow=cards.slice(0,columns);
 for(const card of firstRow){const face=card.querySelector('.stage-person-avatar');expect(Math.abs(rect(face).left+rect(face).width/2-(rect(card).left+rect(card).width/2))<1,'avatar is not centered');expect(Math.abs(rect(card.querySelector('.stage-person-name')).top-rect(firstRow[0].querySelector('.stage-person-name')).top)<1,'names are not aligned');}
 expect(document.documentElement.scrollWidth<=innerWidth&&grid.scrollWidth<=grid.clientWidth,'people grid overflows horizontally');
 const loaded={columns,avatarSize,cardHeight:rect(cards[0]).height,gridTop:rect(grid).top};
 await show([], 'follows',true);
 const skeleton=document.querySelector('.skeleton-grid'),skeletonCard=skeleton.querySelector('.skeleton-card');
 expect(getComputedStyle(skeleton).gridTemplateColumns.split(' ').length===columns,'skeleton uses a different column count');
 expect(Math.abs(rect(skeleton.querySelector('.sk-avatar')).width-avatarSize)<0.5,'skeleton avatar differs from loaded avatar');
 expect(Math.abs(rect(skeletonCard).height-loaded.cardHeight)<1&&Math.abs(rect(skeleton).top-loaded.gridTop)<1,'skeleton shifts the grid geometry');
 await show([], 'followers');
 expect(document.querySelector('.stage-title').textContent==='粉丝'&&document.querySelector('.stage-people-count').textContent==='共 0 人','followers empty header is inconsistent');
 expect(document.querySelector('.stage-empty'),'people empty state disappeared');
 await show([], 'follows',false,'加载关注列表失败');
 expect(document.querySelector('.stage-empty').textContent.includes('加载关注列表失败')&&document.querySelector('.stage-mini-btn'),'people error state lost its retry action');
 await show();
 document.querySelector('button.stage-person-card').click();await nextTick();await pause(450);
 expect(document.querySelector('.social-stage').dataset.kind==='user_playlists','person click did not open the user');
 expect(document.querySelector('.stage-title').textContent===people[0].name+' 的歌单','person click opened the wrong user');
 page.value.backFixtureDetail();await nextTick();await pause(450);
 expect(document.querySelectorAll('button.stage-person-card').length===80&&document.querySelector('.stage-title').textContent==='关注','back navigation did not restore the people grid: '+JSON.stringify({state:page.value.fixtureState(),cards:document.querySelectorAll('button.stage-person-card').length,title:document.querySelector('.stage-title')?.textContent,errors,body:document.body.innerText.slice(-800)}));
 expect(errors.length===0,errors.join(';'));
 return {tone,width:innerWidth,...loaded};
};
window.checkStreamingLocate=async()=>{
 await window.checkStreamingLayout('liked','dark');
 document.documentElement.dataset.teMotion='off';
 const scroll=document.querySelector('.streaming-content');
 const locator=()=>document.querySelector('.te-scroll-companion');
 const shown=()=>locator()?.dataset.teScrollTopVisible==='true';
 const bar=document.createElement('div');bar.className='player-bar-shell';bar.style.cssText='position:fixed;bottom:0;left:0;right:0;height:90px;z-index:100;background:#181818';bar.textContent='播放器';document.body.append(bar);
 window.layoutPlayer.currentTrack.value=tracks[80];
 window.layoutPlayer.queue.value=[tracks[80],tracks[81]];
 await nextTick();await pause(250);
 expect(document.querySelector('.stage-title')?.textContent==='我收藏的歌曲','fixture must show the liked detail of 我的音乐库');
 expect(shown(),'liked page did not expose its floating locator for an offscreen cloud track');
 expect(!document.querySelector('.track-tools [aria-label="定位正在播放的歌曲"]'),'old toolbar locator was not removed');
 scroll.scrollTop=700;scroll.dispatchEvent(new Event('scroll'));await pause(100);
 const arrow=document.querySelector('[aria-label="回到开头"]');
 expect(arrow?.dataset.teScrollTopVisible==='true','liked page back-to-top missing');
 expect(arrow.parentElement===locator().parentElement,'liked locator has a different floating anchor');
 expect(getComputedStyle(locator()).position==='absolute','liked locator must be absolute');
 const arrowTop=arrow.getBoundingClientRect().top;
 expect(locator().getBoundingClientRect().top>arrow.getBoundingClientRect().bottom,'liked locator is not below arrow');
 const row=document.querySelector('.stage-row');row.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}));await nextTick();
 const selected=document.querySelector('.stage-selection')?.textContent;expect(selected,'liked multi-selection must be active before locating');
 const before=JSON.stringify({track:window.layoutPlayer.currentTrack.value,queue:window.layoutPlayer.queue.value});
 locator().click();await pause(250);
 const playing=document.querySelector('.stage-row.playing');expect(playing,'liked locator did not mount current row');
 const rect=playing.getBoundingClientRect();
 const top=scroll.getBoundingClientRect().top+(parseFloat(getComputedStyle(scroll).scrollPaddingTop)||0);
 expect(Math.abs((rect.top+rect.bottom)/2-(top+bar.getBoundingClientRect().top)/2)<5,'liked song was not centered above player: '+JSON.stringify({row:rect.toJSON(),top,bar:bar.getBoundingClientRect().top,root:scroll.getBoundingClientRect().toJSON(),list:document.querySelector('.stage-rows').getBoundingClientRect().toJSON(),scroll:scroll.scrollTop}));
 expect(!shown(),'visible liked song should hide locator');
 expect(arrow.getBoundingClientRect().top===arrowTop,'liked arrow jumped when locator hid');
 expect(JSON.stringify({track:window.layoutPlayer.currentTrack.value,queue:window.layoutPlayer.queue.value})===before,'liked locate changed playback');
 expect(document.querySelector('.stage-selection')?.textContent===selected,'liked locate changed multi-selection');
 scroll.scrollTop=700;scroll.dispatchEvent(new Event('scroll'));await pause(100);expect(shown(),'liked locator did not return after scrolling away');
 const input=document.querySelector('[aria-label="搜索当前歌单的歌曲、歌手或专辑"]');input.value='歌曲 1';input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick();await pause(250);
 expect(!shown(),'search-hidden liked song must hide locator');expect(input.value==='歌曲 1','locator changed search');
 input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick();await pause(250);
 window.layoutPlayer.currentTrack.value=null;await nextTick();await pause(100);expect(!shown(),'no current track must hide liked locator');
  window.layoutPlayer.currentTrack.value=tracks[80];
 // Every song-list locator follows the same scrolling preference as back-to-top.
 const waitFor=async(predicate,label)=>{for(let i=0;i<100;i++){if(predicate())return;await pause(20)}throw new Error(label)};
 for(const [kind,mode] of [['liked','full'],['playlist','full'],['album','full'],['artist','full'],['liked','reduced'],['liked','off']]){
  document.documentElement.dataset.teMotion=mode;
  await page.value.showFixtureDetail(kind,tracks,cover);await nextTick();await pause(500);
  const root=document.querySelector('.streaming-content');
  root.style.scrollBehavior='smooth';root.scrollTo({top:700,behavior:'instant'});root.dispatchEvent(new Event('scroll'));await pause(100);
  expect(shown(),kind+' '+mode+' locator missing before click');
  const nativeScrollTo=root.scrollTo.bind(root);let request;
  root.scrollTo=options=>{request=options;nativeScrollTo(options)};
  const state=JSON.stringify({track:window.layoutPlayer.currentTrack.value,queue:window.layoutPlayer.queue.value,selection:document.querySelector('.stage-selection')?.textContent});
  locator().click();
  const locateBehavior=request?.behavior;
  expect(locateBehavior===(mode==='full'?'smooth':'instant'),kind+' '+mode+' locator requested '+locateBehavior);
  if(mode!=='full')expect(Math.abs(root.scrollTop-request.top)<1,'reduced/off locator did not jump immediately');
  await waitFor(()=>Math.abs(root.scrollTop-request.top)<1,kind+' smooth locate did not reach its destination');await pause(100);
  const row=document.querySelector('.stage-row.playing');expect(row,kind+' current row missing after animated locate');
  const rect=row.getBoundingClientRect(),top=root.getBoundingClientRect().top+(parseFloat(getComputedStyle(root).scrollPaddingTop)||0);
  expect(Math.abs((rect.top+rect.bottom)/2-(top+bar.getBoundingClientRect().top)/2)<5,kind+' animated locate did not center current row');
  expect(!shown(),kind+' locator did not hide after animated reveal');
  expect(document.querySelectorAll('.stage-row').length<40,'animated locate defeated virtualization');
  expect(JSON.stringify({track:window.layoutPlayer.currentTrack.value,queue:window.layoutPlayer.queue.value,selection:document.querySelector('.stage-selection')?.textContent})===state,'animated locate changed playback or selection');
  document.querySelector('[aria-label="回到开头"]').click();
  expect(request?.behavior===locateBehavior,'locator and back-to-top use different scroll behavior');
  await waitFor(()=>root.scrollTop===0,'animated back-to-top did not reach top');
  root.scrollTo=nativeScrollTo;root.style.scrollBehavior='auto';
 }
 document.documentElement.dataset.teMotion='off';
 await page.value.showFixtureDetail('liked',tracks,cover);await nextTick();await pause(500);
 scroll.scrollTop=700;scroll.dispatchEvent(new Event('scroll'));await pause(100);
 expect(shown(),'liked screenshot must show locator');
 expect(errors.length===0,errors.join(';'));
 return 'STREAMING_LOCATE_OK';
};
`

const runner = `
const {app,BrowserWindow,ipcMain}=require('electron');const path=require('node:path');const fs=require('node:fs');
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'));
const {CoreBrowseService}=require('./browse.cjs');
const browse=new CoreBrowseService({files:require('node:fs/promises'),root:path.join(directory,'browse-cache'),newId:()=>require('node:crypto').randomUUID(),providerContext:()=> 'fixture-account',callProvider:async()=>[]});
ipcMain.handle('fixture:browse',(_event,name,payload)=>browse.execute('fixture',{name,payload},new AbortController().signal));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false,offscreen:true,preload:path.join(directory,'preload.cjs')}});
try{await win.loadFile(path.join(directory,'index.html'));
if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE)fs.mkdirSync(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,{recursive:true});
async function checkPersonalizedPlayback(){
 for(const empty of [false,true]){
  await win.webContents.executeJavaScript('window.setupPersonalizedPlayback('+empty+')');
  for(const key of ['fm','radar']){
   await win.webContents.executeJavaScript('window.startPersonalizedPlayback('+JSON.stringify(key)+')');
   if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE)fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,'stream-'+key+(empty?'-empty':'')+'.png'),(await win.webContents.capturePage()).toPNG());
   await win.webContents.executeJavaScript('window.finishPersonalizedPlayback(true)');
   await win.webContents.executeJavaScript('window.startPersonalizedPlayback('+JSON.stringify(key)+')');
   await win.webContents.executeJavaScript('window.finishPersonalizedPlayback()');
  }
 }
 console.log('STREAMING_PERSONALIZED_OK');
}
async function checkProviderSelection(){
 for(const stage of ['switch-library','discover','return-library','cached-discover','home','cloud','return-library']){
  await win.webContents.executeJavaScript('window.checkStreamingProviderSelection('+JSON.stringify(stage)+')');
  if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE)fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,'provider-'+stage+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 console.log('STREAMING_PROVIDER_OK');
}
if(process.env.TWILIGHT_STREAMING_PROVIDER_ONLY){await checkProviderSelection();app.exit(0);return;}
if(process.env.TWILIGHT_STREAMING_PERSONALIZED_ONLY){await checkPersonalizedPlayback();app.exit(0);return;}
if(process.env.TWILIGHT_STREAMING_AUTH_ONLY){
 for(const stage of ['offline','retry','delayed-entry','failed-cache','official','revisit']){
  await win.webContents.executeJavaScript('window.checkStreamingAuthentication('+JSON.stringify(stage)+')');
  if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE)fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,'auth-'+stage+'.png'),(await win.webContents.capturePage()).toPNG());
 }
 console.log('STREAMING_AUTH_OK');app.exit(0);return;
}
if(process.env.TWILIGHT_STREAMING_RESTORE_ONLY){console.log('STREAMING_RESTORE_OK '+JSON.stringify(await win.webContents.executeJavaScript('window.checkStreamingRestoration()')));console.log('STREAMING_AUTH_OK '+JSON.stringify(await win.webContents.executeJavaScript("(async()=>{for(const stage of ['offline','retry','delayed-entry','failed-cache','official','revisit'])await window.checkStreamingAuthentication(stage)})()")));app.exit(0);return;}
for(const width of [1480,520,360])for(const tone of ['pureWhite','dark']){
 win.setContentSize(width,900);console.log(JSON.stringify(await win.webContents.executeJavaScript('window.checkStreamingPeople('+JSON.stringify(tone)+')')));
 if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE){fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,tone+'-'+width+'-people.png'),(await win.webContents.capturePage()).toPNG())}
}
console.log('STREAMING_PEOPLE_OK');
for(const width of [1280,520])for(const tone of ['pureWhite','dark'])for(const kind of ['liked','playlist','album','artist']){
 win.setContentSize(width,900);const result=await win.webContents.executeJavaScript('window.checkStreamingLayout('+JSON.stringify(kind)+','+JSON.stringify(tone)+')');console.log(JSON.stringify(result));
 if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE){fs.mkdirSync(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,tone+'-'+width+'-'+kind+'.png'),(await win.webContents.capturePage()).toPNG())}
}
win.setContentSize(1280,900);await win.webContents.executeJavaScript("window.checkStreamingLayout('playlist','pureWhite',true,56)");await win.webContents.executeJavaScript("window.checkStreamingLayout('liked','pureWhite',false,56)");
await win.webContents.executeJavaScript("window.checkStreamingLayout('playlist','pureWhite',false,56,true)");
win.setContentSize(1280,900);
console.log(await win.webContents.executeJavaScript('window.checkStreamingLocate()'));
console.log('STREAMING_RESTORE_OK '+JSON.stringify(await win.webContents.executeJavaScript('window.checkStreamingRestoration()')));
if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE){fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,'liked-floating-locator.png'),(await win.webContents.capturePage()).toPNG())}
await win.webContents.executeJavaScript("(async()=>{for(const stage of ['offline','retry','delayed-entry','failed-cache','official','revisit'])await window.checkStreamingAuthentication(stage)})()");console.log('STREAMING_AUTH_OK');
await checkPersonalizedPlayback();
await checkProviderSelection();
console.log('STREAMING_LAYOUT_OK');app.exit(0)}catch(error){if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE)fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error.stack);app.exit(1)}});
`
