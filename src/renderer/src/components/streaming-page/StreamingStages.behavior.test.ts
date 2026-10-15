import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('streaming stages preserve keyboard actions, local states and readable bounded content', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-streaming-stages-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      publicDir: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'offline-stage-fixture',
          enforce: 'pre',
          resolveId(id) {
            if (id.endsWith('CoverImg.vue')) return '\0stage-cover'
            if (id.endsWith('NativeDialogTransition.vue')) return '\0stage-transition'
            if (id.endsWith('TrackInfoDialog.vue')) return '\0stage-info'
            return null
          },
          load(id) {
            if (id === '\0stage-cover')
              return `import{defineComponent,h}from'vue';export default defineComponent({inheritAttrs:false,props:['cover','coverSource','identity','alt'],setup(props,{attrs}){return()=>h('img',{...attrs,alt:props.alt||'',src:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>'})}})`
            if (id === '\0stage-transition')
              return `export default{setup(_,{slots}){return()=>slots.default?.()}}`
            if (id === '\0stage-info')
              return `import{h}from'vue';export default{props:['track'],setup(props){return()=>h('div',{role:'dialog'},props.track.title)}}`
            return null
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
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'StreamingStagesProbe',
          formats: ['iife'],
          fileName: () => 'probe.js'
        }
      }
    })
    const cssFile = (await readdir(join(directory, 'bundle'))).find((name) => name.endsWith('.css'))
    assert.ok(cssFile, 'the fixture must load the actual scoped component styles')
    const css = await readFile(join(directory, 'bundle', cssFile), 'utf8')
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite"><meta charset="utf-8"><style>${css}\nhtml,body,#app{height:100%;margin:0}.fixture-viewport{box-sizing:border-box;height:100vh;overflow-y:auto;padding:24px 24px 128px}.fixture-player{position:fixed;bottom:0;left:0;right:0;height:96px;background:var(--te-card-bg);pointer-events:none}</style><div id="app"></div><div class="fixture-player"></div><script>Object.defineProperty(document,'hidden',{configurable:true,get:()=>false})</script><script src="bundle/probe.js"></script></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const environment: NodeJS.ProcessEnv = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const { stdout, stderr } = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, env: environment }
    )
    assert.match(stdout, /STREAMING_STAGES_OK 42 layouts/)
    assert.doesNotMatch(stderr, /STAGES_FAILED/)
    context.diagnostic(stdout.trim())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = String.raw`const {app,BrowserWindow}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{try{
  const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});
  await win.loadFile(process.argv.at(-1));
  win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)});
  const call=async expression=>{const result=await win.webContents.executeJavaScript('Promise.resolve().then(async()=>{try{return {value:await ('+expression+')}}catch(error){return {error:error.stack}}})');if(result.error)throw new Error(expression+'\n'+result.error);return result.value};
  const press=async(keyCode)=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Enter'||keyCode==='Space')win.webContents.sendInputEvent({type:'char',keyCode:keyCode==='Enter'?'\r':' '});win.webContents.sendInputEvent({type:'keyUp',keyCode});await call('window.flushStages()')};
  await call('window.startKeyboardChecks("search")');await press('Enter');await call('window.expectStageEvent("play")');
  await press('Space');await call('window.expectStageSelection()');await press('Down');await call('window.expectStageFocus(1)');
  await call('window.focusStageNested("favorite")');await press('Enter');await call('window.expectStageEvent("favorite")');
  for(const mode of ['detail','social']){
    await call('window.startKeyboardChecks("'+mode+'")');await press('Enter');await call('window.expectStageEvent("play")');
    await press('Space');await call('window.expectStageSelection()');await press('Down');await call('window.expectStageFocus(1)');
    await call('window.focusStageNested("favorite")');await press('Enter');await call('window.expectStageEvent("favorite")');
  }
  await call('window.startKeyboardChecks("cloud")');await press('Enter');await call('window.expectStageEvent("play")');
  await call('window.focusStageNested("download")');await press('Enter');await call('window.expectStageEvent("download")');
  await press('Space');await call('window.expectStageEvent("download")');
  await call('window.prepareStageTabs()');await press('Right');await call('window.expectStageTab("albums")');
  await press('End');await call('window.expectStageTab("playlists")');await press('Home');await call('window.expectStageTab("songs")');
  await call('window.checkStageStates()');
  let layouts=0;
  for(const [width,height,font]of[[1280,720,14],[760,600,20],[480,600,28]]){
    win.setContentSize(width,height);
    for(const theme of ['pureWhite','dark'])layouts+=await call('window.checkStageLayouts('+font+',"'+theme+'")');
  }
  console.log('STREAMING_STAGES_OK '+layouts+' layouts; native Enter/Space/arrows/nested controls/tabs, search favorites, focus recovery, empty/loading/error/retry, transfer progress');app.exit(0);
}catch(error){console.error('STAGES_FAILED',error.stack);app.exit(1)}});`

const runtime = String.raw`import{createApp,h,nextTick,ref}from'vue'
import Search from'@renderer/components/StreamingSearch.vue'
import Detail from'@renderer/components/streaming-page/StreamingDetailStage.vue'
import Social from'@renderer/components/streaming-page/StreamingSocialStage.vue'
import Cloud from'@renderer/components/NcmCloudPanel.vue'
import'@renderer/assets/base.css'
import'@renderer/assets/typography.css'
const expect=(value,message)=>{if(!value)throw new Error(message)};
const flush=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,24));document.body.getBoundingClientRect()};window.flushStages=flush;
const tracks=Array.from({length:80},(_,index)=>({id:'offline:'+index,title:'真实长名称歌曲 '+index+' · 长篇标题保留完整阅读与键盘路径',artist:'歌手名称与合作艺术家',album:'专辑名称与版本信息',duration:185,cover:'',path:'',format:'FLAC',size:12345678}));
const collections=Array.from({length:6},(_,index)=>({id:index,name:'完整的收藏名称 '+index+' · 多语言名称的稳定阅读',trackCount:80,artist:'艺术家',providerName:'受控来源',albumId:index,providerId:'offline',meta:'80 首'}));
const cloudSongs=tracks.map((track,index)=>({cloudSongId:index,track,fileName:'Long audio file '+index+'.flac',addTime:1700000000000}));
const selected=ref(new Set()),mode=ref('search'),props=ref({}),serial=ref(0),events=[];
const record=(name,...args)=>events.push({name,args});
const select=(track,event)=>{expect(event.ctrlKey,'Space must use selection semantics');const set=new Set(selected.value);set.has(track.id)?set.delete(track.id):set.add(track.id);selected.value=set;props.value={...props.value,selectedIds:set,hasSelection:set.size>0,selectedCount:set.size};record('select',track.id)};
const baseDetail=()=>({kind:'playlist',title:'一起听音乐 · 收藏与灵感',description:'独立来源 · 完整播放与收藏能力',intro:'长简介原文。\n'+('一段需要完整阅读的来源内容。'.repeat(60)),trackCountLabel:'80 首',tracks,currentTrackId:null,isSelected:id=>selected.value.has(id),isTrackLiked:()=>false,isLiking:()=>false,formatTime:()=> '3:05',canAddToPlaylist:true});
const defaults={
 search:()=>({searchType:'songs',searchResults:tracks.slice(0,30),searchAlbumsResults:collections,searchPlaylistsResults:collections,searchArtistsResults:collections,searchTotal:80,searchOffset:0,searchLoading:false,searchError:'',currentTrack:null,trackActivationMode:'doubleClick',likingTracks:new Set(),isTrackLiked:()=>false,isTrackFavorited:track=>track.id===tracks[0].id,formatTime:()=> '3:05',selectedIds:selected.value,canAddToPlaylist:true,canOpenTrackArtist:()=>true,canOpenTrackAlbum:()=>true}),
 detail:baseDetail,
 social:()=>({...baseDetail(),kind:'artist',tabs:[{key:'songs',label:'歌曲',count:80},{key:'albums',label:'专辑',count:6},{key:'playlists',label:'歌单',count:6}],activeTab:'songs',collections,people:collections,showFollow:true}),
 cloud:()=>({songs:cloudSongs,total:80,loading:false,loadingMore:false,hasMore:true,error:'',selectedFiles:[],transferTasks:{}})
};
const components={search:Search,detail:Detail,social:Social,cloud:Cloud};
const listeners={onSearchTrackActivate:track=>record('play',track.id),onSearchTrackClick:(track,event)=>select(track,event),onPlayTrack:track=>record('play',track.id),onTrackClick:(track,_index,event)=>select(track,event),onLikeTrack:track=>record('favorite',track.id),onPlay:song=>record('play',song.track.id),onDownload:song=>record('download',song.track.id),onRetry:()=>record('retry'),onRefresh:()=>record('refresh'),onTabChange:key=>{props.value={...props.value,activeTab:key};record('tab',key)},'onUpdate:query':query=>{props.value={...props.value,query}},onCancel:id=>record('cancel',id),onPageChange:value=>record('page',value),onClearSelection:()=>{selected.value=new Set();props.value={...props.value,selectedIds:selected.value,hasSelection:false,selectedCount:0}}};
createApp({setup:()=>()=>h('main',{class:'fixture-viewport'},[h(components[mode.value],{key:serial.value,...props.value,...listeners})])}).mount('#app');
async function mount(name,overrides={}){events.length=0;selected.value=new Set();mode.value=name;props.value={...defaults[name](),...overrides};serial.value++;await flush()}
function rows(){return [...document.querySelectorAll(mode.value==='cloud'?'.cloud-song':mode.value==='search'?'.track-row':'.stage-rows .stage-row')]}
window.startKeyboardChecks=async name=>{await mount(name);rows()[0].focus();events.length=0};
window.expectStageEvent=name=>{expect(events.length===1&&events[0].name===name,'nested/native event triggered wrong action '+JSON.stringify(events));events.length=0};
window.expectStageSelection=()=>{expect(selected.value.has(tracks[0].id),'Space did not select the focused song');window.expectStageEvent('select')};
window.expectStageFocus=index=>expect(document.activeElement===rows().find(row=>Number(row.dataset.trackIndex??rows().indexOf(row))===index),'arrow key lost row focus');
window.focusStageNested=kind=>{const row=document.activeElement.closest('.track-row,.stage-row,.cloud-song')??rows()[0];const target=row.querySelector(kind==='download'?'.song-actions button':mode.value==='search'?'.btn-like':'.row-like');expect(target&&target.getAttribute('aria-label'),'nested action must have a name');target.focus();events.length=0};
window.prepareStageTabs=async()=>{await mount('social');document.querySelector('[role="tab"]').focus()};
window.expectStageTab=key=>{const active=document.activeElement;expect(active?.getAttribute('aria-selected')==='true'&&active.id.endsWith('-'+key),'tab key did not activate/focus target');expect(document.getElementById(active.getAttribute('aria-controls'))?.getAttribute('aria-labelledby')===active.id,'tab and panel association is missing');events.length=0};
window.checkStageStates=async()=>{
 await mount('search',{queryActive:false,searchResults:[],searchTotal:0});expect(document.querySelector('.search-start-hint')?.textContent.includes('输入关键词')&&!document.querySelector('.streaming-placeholder,.search-results-heading'),'initial search must give a short prompt instead of reporting an empty result or drawing a second heading');
 for(const[type,label]of[['songs','单曲'],['albums','专辑'],['playlists','歌单'],['artists','歌手']]){await mount('search',{searchType:type,searchSourceLabel:'本地音乐'});expect(document.querySelector('.search-results-heading')?.textContent===label,'search type has no result heading '+type);const summary=document.querySelector('.search-results-count');expect(summary?.textContent.includes('本地音乐')&&summary.textContent.includes('80'),'current scope and total are missing '+type)}
 await mount('search');document.querySelector('.pager-btn:last-child').click();expect(events.length===1&&events[0].name==='page'&&events[0].args[0].first===30,'search pagination lost its original range');events.length=0;
 await mount('search');const heart=document.querySelector('.btn-like');expect(heart.getAttribute('aria-pressed')==='true'&&heart.querySelector('.pi-heart-fill')&&heart.getAttribute('aria-label')==='移出应用收藏','non-NetEase favorite icon, state and label disagree');
 for(const [patch,text,role]of[[{searchLoading:true,searchResults:[],searchTotal:0},'正在搜索','status'],[{searchError:'来源暂时不可用'},'搜索失败','alert'],[{searchResults:[],searchTotal:0},'无搜索结果','status']]){await mount('search',patch);const state=document.querySelector('[role="'+role+'"]');expect(state?.textContent.includes(text),'search state mislabeled '+text);if(role==='alert'){state.querySelector('button').click();window.expectStageEvent('retry')}}
 await mount('search',{searchLoading:true,searchOffset:30});expect(document.querySelector('[role="status"]')?.textContent.includes('正在加载'),'next page has no loading feedback');expect([...document.querySelectorAll('.pager-btn')].every(button=>button.disabled),'paging remained active while loading');
 await mount('detail',{tracks:[],loading:true});expect(document.querySelector('[role="status"]')?.textContent.includes('正在加载')&&!document.querySelector('.stage-empty'),'detail loading falsely reported empty');
 await mount('detail',{tracks:[],query:'missing'});expect(document.querySelector('.stage-empty[role="status"]')?.textContent.includes('没有匹配'),'detail query empty is ambiguous');
 await mount('detail',{query:'search',followError:'操作失败'});const clear=document.querySelector('[aria-label="清除歌单搜索"]');clear.focus();clear.click();await flush();expect(document.activeElement===document.querySelector('.track-search input')&&props.value.query==='','clear search lost input focus');expect(document.querySelector('[role="alert"]')?.textContent.includes('操作失败'),'follow error has no alert');
 for(const name of ['detail','social']){await mount(name,{showFollow:true,followLoading:true});expect(document.querySelector('.stage-actions button').disabled&&document.querySelector('.stage-actions button').textContent.includes('正在处理'),'follow pending has no guard/feedback');const about=document.querySelector('.stage-about');expect(!about.open,'long intro should be disclosed');about.open=true;expect(about.textContent.includes('一段需要完整阅读')&&getComputedStyle(about.querySelector('p')).webkitLineClamp==='none','expanded intro is still truncated')}
 for(const [patch,text,role]of[[{loading:true,songs:[]},'正在加载云盘歌曲','status'],[{songs:[]},'云盘暂时为空','status'],[{songs:[],error:'读取失败'},'云盘加载失败','alert'],[{error:'刷新失败'},'刷新失败','alert']]){await mount('cloud',patch);const state=document.querySelector('[role="'+role+'"]');expect(state?.textContent.includes(text),'cloud state mislabeled '+text);if(role==='alert'){state.querySelector('button').click();window.expectStageEvent('refresh')}}
 await mount('cloud',{loading:true});expect(document.querySelector('.cloud-header-actions button').disabled&&document.querySelector('.cloud-loading[role="status"]'),'refresh existing songs has no pending feedback');
 await mount('cloud',{selectedFiles:[{handle:'file1',name:'Selected.flac',size:1024}],transferTasks:{one:{transferId:'t1',kind:'upload',handle:'file1',fileName:'Selected.flac',stage:'uploading',message:'正在上传',percent:null,bytesTransferred:100,bytesTotal:1024},two:{transferId:'t2',kind:'download',cloudSongId:0,fileName:'Track.flac',stage:'downloading',message:'正在下载',percent:25,bytesTransferred:256,bytesTotal:1024}}});const progress=document.querySelector('.progress-track');expect(progress?.tagName==='PROGRESS'&&!progress.hasAttribute('value'),'unknown transfer progress was invented');expect(document.querySelector('.song-progress')?.value===25,'download progress did not retain actual value');expect([...document.querySelectorAll('.icon-button')].every(button=>button.getAttribute('aria-label')),'cloud actions lack accessible names');
};
window.checkStageLayouts=async(font,theme)=>{
 document.documentElement.style.setProperty('--te-font-size-body',font+'px');document.documentElement.dataset.theme=theme;
 const variants=[['search',{}],['detail',{}],['social',{}],['cloud',{}],['social',{activeTab:'albums',collections:collections.slice(0,1)}],['social',{activeTab:'albums'}],['search',{searchType:'albums'}]];
 for(const[name,patch]of variants){
  await mount(name,patch);const viewport=document.querySelector('.fixture-viewport');viewport.scrollTop=0;await flush();
  expect(viewport.scrollWidth<=viewport.clientWidth+1,'horizontal overflow '+name+'/'+font+'/'+theme+'/'+innerWidth);
  const root=viewport.firstElementChild,style=getComputedStyle(root);expect(style.boxShadow==='none'&&style.backgroundImage==='none'&&style.backdropFilter==='none','workspace regained independent material');
  for(const control of root.querySelectorAll('button,select,input')){const rect=control.getBoundingClientRect();if(!rect.width||!rect.height)continue;expect(rect.left>=viewport.getBoundingClientRect().left-1&&rect.right<=viewport.getBoundingClientRect().right+1,'unreachable control '+name+'/'+control.className+'/'+font+'/'+innerWidth);expect(control.scrollWidth<=control.clientWidth+2||control.classList.contains('metadata-link'),'control clips large text '+name+'/'+control.className)}
  for(const title of root.querySelectorAll('.stage-title,.track-title,.song-main strong'))expect(!getComputedStyle(title).fontFamily.includes('Georgia'),'interface title kept a separate serif');
  const grid=root.querySelector('.playlist-grid,.stage-collection-grid');if(grid){const cards=[...grid.children],boxes=cards.map(card=>card.getBoundingClientRect()),first=boxes[0],row=boxes.filter(box=>Math.abs(box.top-first.top)<1);expect(first.width<=220.5&&first.width>=Math.min(128,grid.clientWidth)-1,'cover width is unbounded');expect(row.every(box=>Math.abs(box.width-first.width)<1),'same-row cover widths differ');if(cards.length===1)expect(first.width<=220.5,'single cover expanded without limit')}
  viewport.scrollTo({top:viewport.scrollHeight,behavior:'instant'});viewport.dispatchEvent(new Event('scroll'));await flush();viewport.scrollTo({top:viewport.scrollHeight,behavior:'instant'});viewport.dispatchEvent(new Event('scroll'));await flush();
  const items=rows().length?rows():[...root.querySelectorAll('.playlist-grid-card,.stage-collection-card')];const last=items.at(-1).getBoundingClientRect(),player=document.querySelector('.fixture-player').getBoundingClientRect();expect(last.bottom<=player.top-8,'last item hidden by player '+name+'/'+font+'/'+theme+'/'+innerWidth+' '+JSON.stringify({last:last.bottom,player:player.top,scroll:viewport.scrollTop,height:viewport.scrollHeight}));
  if(name==='detail'||(name==='social'&&!patch.activeTab)){const table=root.querySelector('[role="table"]');expect(table?.getAttribute('aria-rowcount')==='81','virtual table lost total row count');expect(root.querySelectorAll('.stage-rows .stage-row').length<40,'virtual list grew to a prefix');expect(Number(items.at(-1).dataset.trackIndex)===79,'end scroll did not mount final virtual row')}
 }
 return variants.length;
};`
