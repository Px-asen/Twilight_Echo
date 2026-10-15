import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('disclosed playlist and listening tools remain keyboard reachable and preserve actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-density-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'stores.ts'), stores)
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [vue()],
      resolve: {
        alias: [
          {
            find: /.*\/stores\/use(?:Radio|Podcast|Player|AppNotice)Store(?:\.ts)?$/,
            replacement: join(directory, 'stores.ts')
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') }
        ]
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'DensityTest',
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
        )}<style>body{margin:0;font-family:system-ui;background:var(--te-bg-primary);color:var(--te-neutral-900)}#menu{padding:24px}#menu button{display:inline-flex}html[data-theme=dark]{--te-card-bg:#222;--te-bg-primary:#181818;--te-neutral-900:#eee;--te-subtle-bg:#292929;--te-card-border:#444}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), directory],
      { windowsHide: true, timeout: 90_000 }
    )
    assert.match(result.stdout, /PAGE_DENSITY_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `const {app,BrowserWindow}=require('electron'),path=require('path'),fs=require('fs');
app.setPath('userData',path.join(process.argv.at(-1),'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});
try{await win.loadFile(path.join(process.argv.at(-1),'index.html'));await win.webContents.executeJavaScript('window.verifyDensity()');
await win.webContents.executeJavaScript('window.prepareDensityKeyboard()');
const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Space')win.webContents.sendInputEvent({type:'char',keyCode:' '});win.webContents.sendInputEvent({type:'keyUp',keyCode});await new Promise(r=>setTimeout(r,60))};
await key('Space');await win.webContents.executeJavaScript('window.checkDensityKeyboard("open")');
await key('Tab');await win.webContents.executeJavaScript('window.checkDensityKeyboard("tab")');
await key('Escape');await win.webContents.executeJavaScript('window.checkDensityKeyboard("closed")');
const out=process.env.TWILIGHT_DENSITY_EVIDENCE_DIR;
for(const dark of [false,true])for(const width of [1200,390]){win.setContentSize(width,850);await win.webContents.executeJavaScript('window.previewDensity('+dark+')');
await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await new Promise(r=>setTimeout(r,180));if(await win.webContents.executeJavaScript('document.documentElement.scrollWidth>innerWidth+1'))throw Error('Horizontal overflow');
if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'radio-'+width+'-'+(dark?'dark':'light')+'.png'),(await win.webContents.capturePage()).toPNG())}}
console.log('PAGE_DENSITY_OK');app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}})`

const stores = `import {ref} from 'vue'
export const stations=ref([{id:'first',name:'晚风电台',streamUrl:'https://radio.test/live'}]),subscriptions=ref([]),error=ref(''),busy=ref(false),actions=[];
export const useRadioStore=()=>({stations,error,ensureLoaded:async()=>{},addStation:async station=>{actions.push(['add',station]);stations.value.push({...station,id:'added'})},removeStation:async id=>{actions.push(['remove',id])},importPlaylistText:async(text,options)=>{actions.push(['import',text,options]);return 1},searchDirectory:async()=>[{stationuuid:'found',name:'Jazz',url:'https://radio.test/jazz'}]});
export const radioStationToTrack=station=>({id:'radio:'+station.id,title:station.name,source:'radio'});
export const usePodcastStore=()=>({subscriptions,error,busy,ensureLoaded:async()=>{},subscribe:async url=>{actions.push(['subscribe',url]);return {id:'podcast'}},refreshAll:async()=>{actions.push(['refresh'])},podcastEpisodeProgressRatio:()=>0});
export const podcastEpisodeToTrack=()=>null;
export const usePlayerStore=()=>({playTrack:(track,queue)=>actions.push(['play',track,queue]),playTrackFromPosition:()=>{}});
export const useAppNoticeStore=()=>({pushNotice:()=>{}});`

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import Radio from '@renderer/components/RadioPodcastPage.vue'
import Toolbar from '@renderer/components/song-list/PlaylistLifecycleToolbar.vue'
import '@renderer/assets/typography.css'
import '@renderer/assets/base.css'
import {actions} from './stores'
const format=ref('m3u'),repair=ref(false),page=ref('menu'),events=[];
window.api={themeOverrides:{load:async()=>({})}};
createApp({render:()=>page.value==='radio'?h(Radio):h('section',{id:'menu'},[h(Toolbar,{exportFormat:format.value,'onUpdate:exportFormat':v=>format.value=v,repairPending:repair.value,...Object.fromEntries(['Rename','Copy','Cover','Import','Export','Repair'].map(n=>['on'+n,()=>events.push(n)]))})])}).mount('#app');
const pause=async()=>{await nextTick();await new Promise(r=>setTimeout(r,30))};
const expect=(x,m)=>{if(!x)throw Error(m)},visible=el=>el&&el.getBoundingClientRect().height>0;
const click=(root,text)=>{const el=[...document.querySelectorAll(root+' button')].find(b=>b.textContent.trim()===text);expect(el,'Missing '+text);el.click()};
const input=(selector,value)=>{const el=document.querySelector(selector);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}))};
window.verifyDensity=async()=>{
 await pause();expect(document.querySelectorAll('#menu button').length===7,'Lost playlist actions');expect(!visible(document.querySelector('.page-action-panel')),'Playlist tools expanded by default');
 for(const [label,event]of [['重命名歌单','Rename'],['复制歌单','Copy'],['设置歌单封面','Cover'],['导入歌单','Import'],['重新定位缺失文件','Repair']]){click('#menu','管理歌单');await pause();expect(document.querySelector('.page-action-trigger').getAttribute('aria-expanded')==='true','Menu state missing');click('.page-action-panel',label);await pause();expect(events.at(-1)===event&&!visible(document.querySelector('.page-action-panel')),'Action did not dispatch or dismiss')}
 click('#menu','管理歌单');await pause();const select=document.querySelector('select');select.value='pls';select.dispatchEvent(new Event('change',{bubbles:true}));await pause();expect(format.value==='pls'&&visible(document.querySelector('.page-action-panel')),'Format change closed menu');click('.page-action-panel','导出 PLS 歌单');expect(events.at(-1)==='Export','Export failed');
 repair.value=true;await pause();click('#menu','管理歌单');await pause();expect(document.querySelector('.page-action-panel button:last-child').disabled,'Busy repair can restart');document.querySelector('.page-action-panel').hidePopover();
 page.value='radio';await pause();expect(!visible(document.querySelector('.radio-tools'))&&visible(document.querySelector('.station-grid')),'Radio form hides collection');
 click('.station-actions','播放');expect(actions.at(-1)[0]==='play','Station playback failed');
 click('.listening-tools','添加电台');await pause();input('.tool-card input[type=text]','My station');input('.tool-card input[type=url]','https://radio.test/new');
 click('.listening-tools','导入列表');await pause();input('textarea','#EXTM3U');click('.listening-tools','添加电台');await pause();expect(document.querySelector('.tool-card input[type=text]').value==='My station','Switching tools lost draft');click('.tool-card','添加到我的电台');await pause();expect(actions.at(-1)[0]==='add','Add failed');
 click('.listening-tools','导入列表');await pause();click('.tool-card-muted','导入列表');await pause();expect(actions.at(-1)[0]==='import','Import failed');
 click('.listening-tools','发现电台');await pause();input('.inline-search input','jazz');await pause();click('.inline-search','搜索');await pause();expect(document.querySelector('.directory-results').textContent.includes('Jazz'),'Directory results missing');
 click('.tabs','播客');await pause();expect(!visible(document.querySelector('.podcast-subscribe-card')),'Podcast subscription form starts expanded');click('.listening-tools','订阅播客');await pause();input('#podcast-feed-url','https://feed.test/rss');click('.podcast-subscribe-form','订阅');await pause();expect(actions.at(-1)[0]==='subscribe','Subscribe failed');click('.listening-tools','刷新全部');await pause();expect(actions.at(-1)[0]==='refresh','Refresh failed');
};
window.prepareDensityKeyboard=async()=>{page.value='menu';await pause();document.querySelector('.page-action-trigger').focus()};
window.checkDensityKeyboard=state=>{const panel=document.querySelector('.page-action-panel'),trigger=document.querySelector('.page-action-trigger');
if(state==='open')expect(visible(panel)&&trigger.getAttribute('aria-expanded')==='true','Space failed to open menu');
if(state==='tab')expect(panel.contains(document.activeElement),'Tab did not reach management actions');
if(state==='closed')expect(!visible(panel)&&document.activeElement===trigger,'Escape did not restore trigger focus')};
window.previewDensity=async dark=>{document.documentElement.dataset.theme=dark?'dark':'pureWhite';page.value='menu';await pause();page.value='radio';await pause()};`
