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
  'streaming details clear the title bar and the liked page locates its current song below back-to-top',
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
        [join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /STREAMING_LAYOUT_OK/)
      assert.match(result.stdout, /STREAMING_LOCATE_OK/)
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
  resetFixtureDetail() { resetDetail({ animate: false }) }
})
`

const runtime = `
import {createApp,h,nextTick,ref} from 'vue'
import StreamingPage from '@renderer/components/StreamingPage.vue'
import {installScrollToTopButton} from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
import '@renderer/assets/icon-fonts.ts'
installScrollToTopButton();
const noop=()=>{};
window.api={
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
for(const width of [1280,520])for(const tone of ['pureWhite','dark'])for(const kind of ['liked','playlist','album','artist']){
 win.setContentSize(width,900);const result=await win.webContents.executeJavaScript('window.checkStreamingLayout('+JSON.stringify(kind)+','+JSON.stringify(tone)+')');console.log(JSON.stringify(result));
 if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE){fs.mkdirSync(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,tone+'-'+width+'-'+kind+'.png'),(await win.webContents.capturePage()).toPNG())}
}
win.setContentSize(1280,900);await win.webContents.executeJavaScript("window.checkStreamingLayout('playlist','pureWhite',true,56)");await win.webContents.executeJavaScript("window.checkStreamingLayout('liked','pureWhite',false,56)");
await win.webContents.executeJavaScript("window.checkStreamingLayout('playlist','pureWhite',false,56,true)");
console.log(await win.webContents.executeJavaScript('window.checkStreamingLocate()'));
if(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE){fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_LAYOUT_EVIDENCE,'liked-floating-locator.png'),(await win.webContents.capturePage()).toPNG())}
console.log('STREAMING_LAYOUT_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}});
`
