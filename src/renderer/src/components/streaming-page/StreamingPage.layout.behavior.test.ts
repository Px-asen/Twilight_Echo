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
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /STREAMING_LAYOUT_OK/)
      assert.match(result.stdout, /STREAMING_LOCATE_OK/)
      assert.match(result.stdout, /STREAMING_PEOPLE_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixtureAccess = `
defineExpose({
  showFixtureDetail(kind: string, tracks: Track[], cover: string) {
    resetDetail({ animate: false })
    beginDetailTransition()
    const view: DetailView = kind === 'liked' ? { type: 'liked' }
      : kind === 'artist' ? { type: 'artist', artist: { id: 'fixture', name: '测试歌手', picUrl: cover, albumSize: 0, musicSize: tracks.length } }
      : kind === 'album' ? { type: 'album', providerId: 'ncm', album: { id: 'fixture', name: '测试专辑', cover, trackCount: tracks.length } }
      : { type: 'playlist', playlist: { id: 'fixture', name: '测试歌单', cover, trackCount: tracks.length } }
    pushDetail(view)
    detailTracks.value = tracks
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
import { coreSnapshot } from '@renderer/stores/coreTestFixtures.ts'
import {installScrollToTopButton} from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
import '@renderer/assets/icon-fonts.ts'
installScrollToTopButton();
const noop=()=>{};
window.api={
 core:{
  connect:async()=>({ok:true,value:{connectionId:'layout',snapshot:coreSnapshot()}}),
  onMessage:()=>noop,onStatus:()=>noop,disconnect:async()=>{},cancel:async()=>{},
  request:async(_id,request)=>{
   const pages={
    'providers.list':[],
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
 providers:{list:async()=>[],call:async()=>[]},
 providerDownloads:{list:async()=>[],onChanged:()=>noop},
 ncmCloud:{onProgress:()=>noop}
};
window.layoutPlayer={currentTrack:ref(null),personalizedStreamSession:ref(null),personalizedStreamRemaining:ref(0),queue:ref([]),playTrack:noop,startPersonalizedStream:noop,appendPersonalizedStreamTracks:noop,formatTime:seconds=>Math.floor(seconds/60)+':00'};
const errors=[];
const page=ref(null),tab=ref('library');
let app;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const expect=(ok,label)=>{if(!ok)throw new Error(label)};
const canvas=document.createElement('canvas');canvas.width=canvas.height=256;const paint=canvas.getContext('2d');paint.fillStyle='#718f9c';paint.fillRect(0,0,256,256);const cover=canvas.toDataURL();
const tracks=Array.from({length:100},(_,i)=>({id:'fixture-'+i,title:'歌曲 '+i,artist:'测试歌手',album:'测试专辑',duration:180,source:'ncm',ncmSongId:i+1,cover}));
const names=['Porter Robinson','C418','Ludicin','ReeK','Ophidian','n-buna','ヨルシカ','重音テト','Betwixt & Between','MIMI','25時、ナイトコードで。','花譜','Sad Keyboard Guy','void (Mournfinale)'];
const portraits=['#c85f92','#527e8a','#bd8c58','#65628a'].map(color=>{paint.fillStyle=color;paint.fillRect(0,0,256,256);paint.fillStyle='#e9dbca';paint.beginPath();paint.ellipse(128,91,41,48,0,0,Math.PI*2);paint.fill();paint.fillStyle='#e1c4ae';paint.beginPath();paint.ellipse(128,248,85,92,0,0,Math.PI*2);paint.fill();return canvas.toDataURL()});
const people=Array.from({length:80},(_,i)=>({id:i+1,name:names[i%names.length],picUrl:i%3===1?null:portraits[i%portraits.length],musicSize:0,userType:0}));
const mount=async()=>{app?.unmount();app=createApp({render:()=>h(StreamingPage,{ref:page,active:true,menuOpen:false,hasPlayer:false,initialTab:tab.value})});app.config.errorHandler=error=>errors.push(String(error));app.mount('#app');await pause(250)};
window.checkStreamingLayout=async(kind,tone,search=false,caption=40,custom=false)=>{
 document.documentElement.dataset.theme=tone;
 if(custom)document.documentElement.dataset.teShellLayout='custom';else delete document.documentElement.dataset.teShellLayout;
 document.documentElement.style.setProperty('--te-titlebar-inset',caption+'px');
 Object.assign(document.querySelector('#app').style,{position:custom?'relative':'static',top:custom?caption+'px':'0',height:custom?'calc(100vh - '+caption+'px)':'100vh'});
 tab.value=search?'search':'library';await mount();
 expect(errors.length===0,errors.join(';'));
 page.value.showFixtureDetail(kind,tracks,cover);await nextTick();await pause(450);
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
 expect(document.querySelectorAll('button.stage-person-card').length===80&&document.querySelector('.stage-title').textContent==='关注','back navigation did not restore the people grid');
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
  page.value.showFixtureDetail(kind,tracks,cover);await nextTick();await pause(500);
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
 page.value.showFixtureDetail('liked',tracks,cover);await nextTick();await pause(500);
 scroll.scrollTop=700;scroll.dispatchEvent(new Event('scroll'));await pause(100);
 expect(shown(),'liked screenshot must show locator');
 expect(errors.length===0,errors.join(';'));
 return 'STREAMING_LOCATE_OK';
};
`

const runner = `
const {app,BrowserWindow}=require('electron');const path=require('node:path');const fs=require('node:fs');
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false,offscreen:true}});
try{await win.loadFile(path.join(directory,'index.html'));
if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE)fs.mkdirSync(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,{recursive:true});
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
if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE){fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,'liked-floating-locator.png'),(await win.webContents.capturePage()).toPNG())}
console.log('STREAMING_LAYOUT_OK');app.exit(0)}catch(error){if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE)fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error.stack);app.exit(1)}});
`
