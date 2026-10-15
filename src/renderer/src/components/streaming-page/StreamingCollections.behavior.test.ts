import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('streaming collections share bounded covers and preserve their keyboard, paging and library actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-streaming-collections-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [
        {
          name: 'controlled-streaming-collection-interfaces',
          enforce: 'pre',
          load(id) {
            const path = id.replaceAll('\\', '/')
            if (path.endsWith('/stores/useSettingsStore.ts'))
              return "import {ref} from 'vue';const settings=ref({motionPreference:'off'});export const useSettingsStore=()=>({settings})"
            if (path.endsWith('/stores/useProviderStore.ts'))
              return 'export const useProviderStore=()=>({getProvider:()=>({supportedMethods:window.collectionMethods.value})})'
            if (path.endsWith('/providers/index.ts'))
              return 'export const useMediaProviders=()=>window.collectionProviders'
            if (path.endsWith('/components/CoverImg.vue'))
              return '<script setup>defineProps(["cover","coverSource"])</script><template><img :src="cover" :data-source="coverSource" alt="" loading="lazy" /></template>'
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
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'StreamingCollectionTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>html,body{margin:0;height:100%;overflow:hidden}body::before{display:none}#collection-host{box-sizing:border-box;height:100vh;overflow:auto;padding:24px 24px calc(var(--te-playbar-bottom-clearance) + 24px)}#player-boundary{position:fixed;inset:auto 0 0;height:var(--te-playbar-bottom-clearance);pointer-events:none}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }
    )
    assert.match(result.stdout, /STREAM_COLLECTIONS_OK 144 geometry records/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import '@renderer/assets/base.css'
import '@renderer/assets/typography.css'
import '@renderer/assets/materials.css'
import {createApp,h,nextTick,ref} from 'vue'
import Home from '@renderer/components/StreamingHome.vue'
import Discovery from '@renderer/components/StreamingDiscovery.vue'
import Library from '@renderer/components/StreamingLibrary.vue'
import ProviderHome from '@renderer/components/streaming-page/ProviderMusicHome.vue'
import Saved from '@renderer/components/streaming-page/SavedMusicCollections.vue'
const expect=(value,message)=>{if(!value)throw Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await nextTick()}
const cover='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#888"/></svg>')
const makePlaylists=count=>Array.from({length:count},(_,id)=>({id:'p'+id,name:'歌单 '+id+' · 漫长的音乐旅程与完整名称',cover,coverSource:'fixture',coverSmall:cover,trackCount:25+id,creatorName:'独立来源 '+id,playCount:10000+id,owned:id%2===0}))
const tracks=Array.from({length:12},(_,id)=>({id:'t'+id,title:'歌曲 '+id+' · 完整作品名称',artist:'演奏者 '+id,album:'测试专辑',cover,coverSource:'fixture',duration:180+id,source:'fixture'}))
const sections=[{key:'daily',title:'每日推荐',icon:'pi pi-calendar',tracks},{key:'fm',title:'私人电台',icon:'pi pi-headphones',tracks:tracks.slice(4)},{key:'radar',title:'雷达推荐',icon:'pi pi-compass',tracks:tracks.slice(7)}]
const events=[]
window.collectionMethods=ref(['fetchSavedAlbums','fetchSavedArtists'])
const savedCalls=[];let savedMode='success';let savedAlbumCount=26;const pendingSaved=[]
const savedItems=(type,provider,count)=>Array.from({length:count},(_,id)=>({id:provider+'-'+type+id,name:provider+' '+type+' '+id+' · 完整收藏名称',cover,picUrl:cover,coverSource:'fixture',picUrlSource:'fixture'}))
window.collectionProviders={get:provider=>({fetchSavedAlbums:()=>loadSaved('albums',provider),fetchSavedArtists:()=>loadSaved('artists',provider)})}
const loadSaved=async(type,provider)=>{savedCalls.push({type,provider});if(savedMode==='error')throw Error('受控收藏失败');if(savedMode==='pending')return new Promise(resolve=>pendingSaved.push({type,provider,resolve}));return savedItems(type,provider,type==='albums'?savedAlbumCount:6)}
const visible=element=>!!element&&getComputedStyle(element).display!=='none'&&element.getBoundingClientRect().width>0
const selectedCollection=()=>document.querySelector('.library-collection-tabs [aria-selected=true]')?.dataset.collection
const visibleSaved=()=>[...document.querySelectorAll('.saved-collection-panel')].find(visible)

let menuRequest=null
window.api={window:{popupContextMenu:async request=>{menuRequest=request;return null},closeContextMenu:async()=>{}}}
window.fetch=()=>{throw Error('Unexpected network access')}
const kind=ref('home'),values=ref({}),generation=ref(0)
const record=name=>(...args)=>events.push({name,args})
const homeProps=count=>({providerLabel:'测试音源',isLoggedIn:true,recsLoading:false,recsError:'',recSections:sections,recommendPlaylists:makePlaylists(count),supportsDiscovery:true,currentTrackId:'t2',onPlayTrack:record('play'),onOpenRecSection:record('section'),onOpenPlaylist:record('playlist'),onRequestLogin:record('login'),onOpenDiscovery:record('discover'),onLoadRecommendations:record('retry')})
const discoveryProps=count=>({providerLabel:'测试音源',supportsSort:true,supportsCategories:true,supportsHighQuality:true,catalogue:{hotTags:['华语','摇滚'],categories:[{name:'语种',tags:[{name:'华语'}]}]},catalogueLoading:false,catalogueError:'',selectedTag:'全部',order:'hot',highQuality:false,panelExpanded:false,playlists:makePlaylists(count),total:94,offset:0,hasMore:true,listLoading:false,listError:'',loadingMore:false,onSelectTag:record('tag'),onSetOrder:record('order'),onToggleHighQuality:record('quality'),onTogglePanel:record('panel'),onPageChange:record('page'),onLoadMore:record('more'),onOpenPlaylist:record('playlist'),onRetry:record('retry')})
const libraryProps=count=>({providerLabel:'测试音源',isLoggedIn:true,showLikedPanel:true,showSocialStats:true,showFeatureCards:true,profile:{userId:'fixture',nickname:'测试听众的音乐库',avatarUrl:cover,follows:4,followeds:8},profileSignature:'',likedSummary:{name:'我喜欢的音乐',trackCount:3215,cover},likedPlaylistOptions:[{id:'like1',name:'收藏夹一',trackCount:20},{id:'like2',name:'收藏夹二',trackCount:30}],selectedLikedPlaylistId:'like1',libraryLoaded:true,userPlaylistEntries:makePlaylists(count),activeProvider:'fixture',availableProviders:[{id:'fixture',name:'测试音源',icon:'pi pi-music',loggedIn:true},{id:'other',name:'另一个独立音源',icon:'pi pi-music',loggedIn:false}],allowPinPlaylists:true,allowPlaylistMutations:true,pinnedPlaylistIds:[],onOpenPlaylist:record('playlist'),onTogglePinnedPlaylist:record('pin'),onDeletePlaylist:record('delete'),onPlayLikedSongs:record('liked'),onSelectLikedPlaylist:record('likedSelection'),onOpenLikedTracks:record('likedOpen'),onOpenRecent:record('recent'),onOpenRanking:record('ranking'),onOpenUserList:record('people'),onCreatePlaylist:record('create'),onSwitchProvider:record('provider'),onOpenAlbum:record('album'),onOpenArtist:record('artist'),'onUpdate:viewState':record('view')})
const defaults=(view,count)=>view==='saved'?{userId:'fixture',providerId:'fixture'}:view==='discovery'?discoveryProps(count):view==='library'?libraryProps(count):homeProps(count)
const components={home:Home,provider:ProviderHome,discovery:Discovery,library:Library,saved:Saved}
createApp({setup:()=>()=>h('div',[h('main',{id:'collection-host'},[h(components[kind.value],{...values.value,key:generation.value},()=>h('p',{'data-ranking-fixture':''},'榜单宿主'))]),h('div',{id:'player-boundary'})])}).mount('#app')
const render=async(view,count=6,extra={})=>{kind.value=view;values.value={...defaults(view,count),...extra};generation.value++;events.length=0;document.getElementById('collection-host').scrollTop=0;await tick()}
const update=async extra=>{values.value={...values.value,...extra};await tick()}
const last=name=>events.filter(e=>e.name===name).at(-1)
const button=(text,scope=document)=>{const found=[...scope.querySelectorAll('button')].find(el=>el.textContent.trim()===text);expect(found,'Missing button '+text+'; found '+[...scope.querySelectorAll('button')].map(el=>el.textContent.trim()).join('|'));return found}
const cards={home:'.shelf-tile',provider:'.music-playlist',discovery:'.disc-card',library:'.playlist-item'}
const covers={home:'.shelf-cover',provider:'.music-playlist-art',discovery:'.disc-card-media',library:'.playlist-item-cover'}
const grids={home:'.shelf-grid',provider:'.music-playlist-grid',discovery:'.disc-mosaic',library:'.playlist-grid'}
const names={home:'.shelf-name',provider:'.music-playlist>strong',discovery:'.disc-card-name',library:'.playlist-item-title'}
window.layoutCollection=async(options)=>{
 const root=document.documentElement
 root.dataset.theme=options.tone;root.dataset.teLibraryDensity=options.density
 root.style.setProperty('--te-font-size-body',options.font+'px');root.style.setProperty('--te-playbar-bottom-clearance',options.clearance+'px')
 await render(options.view,options.count)
 const host=document.getElementById('collection-host'),grid=document.querySelector(grids[options.view]),art=[...document.querySelectorAll(covers[options.view])],card=[...document.querySelectorAll(cards[options.view])]
 const r=grid.getBoundingClientRect(),a=art[0].getBoundingClientRect(),style=getComputedStyle(grid),cols=style.gridTemplateColumns.split(' ').map(parseFloat)
 const narrow=r.width<=640,max=options.density==='compact'?190:narrow?200:220,min=options.density==='compact'?140:narrow?128:160
 expect(Math.abs(r.left-24)<1&&Math.abs(r.right-(host.clientWidth-24))<1,'grid lost the common full-width content boundary '+JSON.stringify({options,r:r.toJSON()}))
 expect(a.width<=max+.6&&a.width>=Math.min(min,r.width)-.6,'cover is outside its readable bounds '+JSON.stringify({options,a:a.toJSON(),max,min}))
 expect(cols.every(width=>Math.abs(width-cols[0])<.6),'cover columns do not share width')
 expect(art.every(el=>Math.abs(el.getBoundingClientRect().width-a.width)<.6),'cover width differs within a collection')
 expect(card.every(el=>el.getBoundingClientRect().right<=r.right+.6),'a card exceeds its content container')
 expect(host.scrollWidth<=host.clientWidth+1,'collection causes horizontal scrolling '+JSON.stringify(options))
 const title=document.querySelector(names[options.view])
 expect(Math.abs(parseFloat(getComputedStyle(title).fontSize)-options.font*15/14)<.2,'collection name was shrunk below the common body role')
 expect(title.title===title.textContent.trim(),'truncated name lost its full title')
 if(options.count<=2)expect(Math.abs(a.left-r.left)<1,'sparse collection is centered')
 if(options.view==='library'){
  expect(getComputedStyle(document.querySelector('.glass-card')).boxShadow==='none','library retained a separate glass shell')
  expect(selectedCollection()==='playlists'&&!document.querySelector('.saved-music'),'library did not default to the playlist task')
  expect(document.querySelectorAll('.library-shortcuts>.glass-card').length===3,'the three real shortcuts were lost')
  for(const shortcut of document.querySelectorAll('.library-shortcuts>.glass-card'))expect(parseFloat(getComputedStyle(shortcut).borderRadius)>0,'shortcut grouping lost its rectangular corner')
  const more=document.querySelector('.playlist-more-button').getBoundingClientRect(),meta=document.querySelector('.playlist-item-count').getBoundingClientRect()
  expect(more.width>=32&&more.height>=32,'playlist menu is not a usable permanent target')
  expect(more.top<meta.bottom&&meta.top<more.bottom,'playlist menu creates a detached action row')
  expect(getComputedStyle(title).webkitLineClamp==='2','playlist title lost the consistent two-line bound')
 }
 if(options.view==='home'||options.view==='provider'){
  const hero=document.querySelector(options.view==='home'?'.hero-stage':'.music-hero').getBoundingClientRect()
  expect(hero.height<Math.max(300,options.font*19),'hero consumes an unnecessary display-height budget')
  const trackGrid=document.querySelector(options.view==='home'?'.chart-grid':'.music-track-grid')
  const trackRows=trackGrid.querySelectorAll(options.view==='home'?'.chart-row':'.music-track')
  const trackColumns=getComputedStyle(trackGrid).gridTemplateColumns.split(' ').length
  const expectedColumns=r.width>=1120?3:r.width>720?2:1
  expect(trackRows.length===9&&trackColumns===expectedColumns,'recommendation quick view no longer fits nine tracks into its adaptive column budget '+JSON.stringify({options,width:r.width,trackColumns,expectedColumns,count:trackRows.length}))
  expect(parseFloat(getComputedStyle(document.querySelector(options.view==='home'?'.hero':'.music-hero')).borderRadius)>0,'primary recommendation lost its grouped rectangular card')
  if(options.width===1500&&options.font===14)expect(trackRows[8].getBoundingClientRect().bottom<=innerHeight-options.clearance,'desktop quick view does not fit all three recommendation rows before the player')
 }
 const final=card.at(-1);final.scrollIntoView({block:'end'});host.scrollTop=host.scrollHeight;await tick()
 expect(final.getBoundingClientRect().bottom<=innerHeight-options.clearance+.6,'last collection action remains behind the player boundary '+JSON.stringify({options,bottom:final.getBoundingClientRect().bottom,scroll:host.scrollTop,height:innerHeight}))
 host.scrollTop=0;await tick()
 return {...options,container:r.width,cover:a.width,columns:cols.length,firstCoverTop:a.top,nameSize:parseFloat(getComputedStyle(title).fontSize),contentHeight:host.scrollHeight,...((options.view==='home'||options.view==='provider')?{trackColumns:getComputedStyle(document.querySelector(options.view==='home'?'.chart-grid':'.music-track-grid')).gridTemplateColumns.split(' ').length,trackCount:9}:{}),...(options.view==='library'?{identityHeight:document.querySelector('.profile-card').getBoundingClientRect().height,shortcutHeight:document.querySelector('.library-shortcuts').getBoundingClientRect().height,menuHeight:document.querySelector('.playlist-more-button').getBoundingClientRect().height,cardHeight:card[0].getBoundingClientRect().height}:{})}
}
window.checkCollectionStates=async()=>{
 await render('home',0,{recsLoading:true,recSections:[]});expect(document.querySelector('[role=status]')&&!document.querySelector('.empty-state'),'home loading became empty')
 await update({recsLoading:false,recsError:'受控加载失败'});expect(document.querySelector('[role=alert]')?.textContent.includes('受控加载失败'),'home failure has no cause');button('再试一次').click();expect(last('retry'),'home retry was lost')
 await update({recsError:'',isLoggedIn:false});button('登录 测试音源').click();expect(last('login'),'home login no longer emits its source host action')
 await render('provider',0,{presentation:{requiresLogin:false},recSections:[],recsLoading:true});expect(document.querySelector('[role=status]'),'provider loading is missing')
 await update({recsLoading:false,recsError:'受控来源失败'});expect(document.querySelector('[role=status]')?.textContent.includes('受控来源失败'),'provider cause is missing')
 await render('provider',0,{isLoggedIn:false,presentation:{requiresLogin:true},recSections:[]});button('登录 测试音源').click();expect(last('login'),'provider required login was lost')
 await render('provider',2,{isLoggedIn:false,presentation:{requiresLogin:false}});document.querySelector('.music-primary').click();expect(last('login')&&!last('play'),'anonymous preview started playback')
 await render('discovery',0,{listLoading:true});expect(document.querySelector('[role=status][aria-label="正在加载歌单"]')&&!document.querySelector('.disc-state'),'discovery loading became empty')
 await update({listLoading:false,listError:'受控发现失败'});expect(document.querySelector('[role=alert]')?.textContent.includes('受控发现失败'),'discovery error missing');button('再试一次').click();expect(last('retry'),'discovery retry lost')
 await update({listError:''});expect(document.querySelector('.disc-state-title')?.textContent==='暂无歌单','discovery settled empty state missing')
 await render('library',0,{libraryLoaded:false});expect(document.querySelector('[role=status]')?.textContent.includes('正在加载歌单')&&!document.querySelector('.empty-state'),'library pending became empty')
 await update({libraryLoaded:true});expect(document.querySelector('.empty-state'),'library settled empty state missing')
}
window.prepareDiscoveryActions=async()=>{
 await render('discovery',30)
 button('华语').click();expect(last('tag')?.args[0]==='华语','category emit changed')
 button('最新').click();expect(last('order')?.args[0]==='new','sort emit changed')
 document.querySelector('[aria-label="下一页"]').click();expect(last('page')?.args[0].first===30&&last('page').args[0].rows===30,'page offset contract changed')
 button('精品').click();expect(last('quality'),'quality toggle missing')
 await update({highQuality:true});expect(!document.querySelector('.disc-order')&&document.querySelector('.disc-hq').getAttribute('aria-pressed')==='true','quality mode semantics changed')
 button('继续发掘精品').click();expect(last('more'),'high quality continuation missing')
 await update({loadingMore:true});expect(document.querySelector('.disc-more-btn').disabled,'loading more permits duplicate action')
 await update({loadingMore:false});events.length=0;document.querySelector('.disc-card').focus()
}
window.checkKeyboardPlaylist=async expected=>{await tick();expect(events.filter(e=>e.name==='playlist').length===expected,'keyboard playlist activation was lost or duplicated '+JSON.stringify({kind:kind.value,expected,events,active:document.activeElement?.outerHTML}))}
window.prepareHomeActions=async view=>{
 await render(view,6)
 document.querySelector(view==='home'?'.hero-play':'.music-primary').click()
 expect(last('play')?.args[0].id==='t0'&&last('play').args[1].length===12,'play all lost its full recommendation queue')
 document.querySelector(view==='home'?'.chart-row':'.music-track').click();expect(last('play')?.args[1].length===12,'track preview replaced its queue')
 for(const [index,selector] of (view==='home'?['.duo-fm','.duo-radar']:['.music-feature-play','.music-feature-play']).entries()){
  const action=view==='home'?document.querySelector(selector):document.querySelectorAll(selector)[index];action.click();expect(last('play')?.args[0].id===(index===0?'t4':'t7')&&last('play').args[1].length===(index===0?8:5),'secondary recommendation did not retain its own playback queue')
 }
 if(view==='provider'){document.querySelector('.music-feature-more').click();expect(last('section')?.args[0].key==='fm','secondary full-section navigation was lost');button('发现更多').click();expect(last('discover'),'provider discovery action missing')}
 events.length=0;document.querySelector(cards[view]).focus()
}
window.prepareLibraryActions=async()=>{
 localStorage.clear();await render('library',694)
 expect(document.querySelectorAll('.playlist-item').length===48,'large library no longer reveals in bounded batches')
 expect([...document.querySelectorAll('img.playlist-item-cover')].every(image=>image.loading==='lazy'&&image.decoding==='async'),'library covers eagerly decode the full visible batch')
 document.querySelector('.playlist-load-more').click();await tick();expect(document.querySelectorAll('.playlist-item').length===96,'show more did not reveal the next batch')
 const filter=text=>[...document.querySelectorAll('.playlist-filters button')].find(el=>el.textContent.includes(text))
 filter('我创建的').click();await tick();expect(document.querySelectorAll('.playlist-item').length===48&&[...document.querySelectorAll('.playlist-item')].every(el=>Number(el.dataset.reorderId.slice(1))%2===0),'owned filter or reveal reset changed')
 filter('我收藏的').click();await tick();expect([...document.querySelectorAll('.playlist-item')].every(el=>Number(el.dataset.reorderId.slice(1))%2===1),'saved filter changed')
 filter('全部').click();await tick()
 document.querySelector('.btn-play').click();expect(last('liked')&&!last('likedOpen'),'nested favorite play activated the parent')
 const select=document.querySelector('.favorites-picker select');select.value='like2';select.dispatchEvent(new Event('change',{bubbles:true}));expect(last('likedSelection')?.args[0]==='like2','favorite selector contract changed')
 button('创建歌单').click();expect(last('create'),'create playlist action missing')
 document.querySelector('.playlist-more-button').click();await tick();expect(menuRequest?.items[0]?.label==='删除歌单'&&!last('playlist'),'more menu activated the parent or lost native menu')
 events.length=0;document.querySelector('.playlist-pin-button').focus()
}
window.checkPinAndFocusCard=async()=>{await tick();expect(events.filter(e=>e.name==='pin').length===1&&!last('playlist'),'nested pin activated the parent');document.querySelector('.playlist-item').focus()}
window.checkReorder=async()=>{await tick();expect(document.querySelector('.playlist-item').dataset.reorderId==='p1','Alt+Down did not use the existing order model');expect(document.activeElement?.dataset.reorderId==='p0','reorder lost the moved card focus');expect(events.filter(e=>e.name==='playlist').length===1,'reorder unexpectedly opened a playlist')}
window.prepareProviderMenu=()=>document.querySelector('.provider-switch-btn').focus()
window.checkProviderMenu=async()=>{await tick();expect(document.querySelector('.provider-menu').matches(':popover-open'),'source selector did not enter the native top layer');expect(document.activeElement===document.querySelector('.provider-menu-item[aria-selected=true]'),'source selector did not focus the selected provider')}
window.checkProviderFocus=async index=>{await tick();expect(document.activeElement===document.querySelectorAll('.provider-menu-item')[index],'source direction/Home/End navigation failed')}
window.checkProviderDismissed=async()=>{await tick();expect(!document.querySelector('.provider-menu').matches(':popover-open')&&document.activeElement===document.querySelector('.provider-switch-btn'),'Escape did not close the source selector and restore its trigger')}
window.checkProviderSelected=async()=>{await tick();expect(last('provider')?.args[0]==='other','library provider switch emit changed');expect(document.activeElement===document.querySelector('.provider-switch-btn'),'source selection did not restore trigger focus')}

window.prepareCollectionTabs=async()=>{
 savedCalls.length=0;savedMode='success';savedAlbumCount=26;window.collectionMethods.value=['fetchSavedAlbums','fetchSavedArtists'];await render('library',694)
 expect(selectedCollection()==='playlists'&&document.querySelectorAll('.playlist-item').length===48,'default collection is not playlists')
 expect(savedCalls.length===0&&!document.querySelector('.saved-music'),'default library eagerly fetched the saved-album collection')
 expect(document.querySelectorAll('.library-collection-tabs [role=tab]').length===3,'supported nondefault collections are hidden')
 for(const tab of document.querySelectorAll('.library-collection-tabs [role=tab]')){const panel=document.getElementById(tab.getAttribute('aria-controls'));expect(panel?.getAttribute('aria-labelledby')===tab.id,'tab is detached from its named panel')}
 const owned=[...document.querySelectorAll('.playlist-filters button')].find(el=>el.textContent.includes('我创建的'));owned.click();await tick();document.querySelector('.playlist-load-more').click();await tick()
 document.querySelector('[data-collection=playlists]').focus()
}
window.checkCollectionTab=async(type)=>{
 await tick();expect(selectedCollection()===type&&document.activeElement===document.querySelector('[data-collection='+type+']'),'collection tab keyboard selection/focus diverged')
 if(type!=='playlists'){
  const panel=visibleSaved();expect(panel&&panel.querySelectorAll('.saved-grid>button').length===(type==='albums'?26:6),'saved collection did not appear in its selected panel')
  expect(!visible(document.querySelector('.playlist-section')),'parallel collections remain stacked')
  expect(savedCalls.filter(call=>call.type===type).length===1,'tab revisit fetched an already loaded collection')
  panel.querySelector('.saved-grid>button').click();expect(last(type==='albums'?'album':'artist'),'saved collection details action was lost')
 }else{
  expect(document.querySelectorAll('.playlist-item').length===96,'switching collections collapsed playlist reveal count')
  expect(document.querySelector('.playlist-filters [aria-pressed=true]')?.textContent.includes('我创建的'),'switching collections discarded the active playlist category')
  expect(last('view')?.args[0].collection==='playlists'&&last('view').args[0].category==='owned'&&last('view').args[0].limit===96,'view state did not describe the actual collection')
 }
}
window.checkCollectionCapabilityRemoval=async()=>{
 document.querySelector('[data-collection=albums]').focus();document.querySelector('[data-collection=albums]').click();await tick()
 window.collectionMethods.value=[];await tick()
 expect(selectedCollection()==='playlists'&&document.activeElement===document.querySelector('[data-collection=playlists]'),'removed collection did not fall back with keyboard focus')
 expect(document.querySelectorAll('.library-collection-tabs [role=tab]').length===1&&!document.querySelector('.saved-music'),'removed capabilities left inaccessible saved panels')
}
window.checkCollectionRestoreAndIsolation=async()=>{
 window.collectionMethods.value=['fetchSavedAlbums','fetchSavedArtists'];savedMode='success';await render('library',694,{viewState:{collection:'albums',category:'saved',limit:96}})
 expect(selectedCollection()==='albums'&&visibleSaved()?.querySelectorAll('.saved-grid>button').length===26,'controlled detail-return collection was not restored')
 document.querySelector('[data-collection=playlists]').click();await tick();expect(document.querySelectorAll('.playlist-item').length===96&&document.querySelector('.playlist-filters [aria-pressed=true]').textContent.includes('我收藏的'),'controlled detail-return category/reveal state was not restored')
 savedMode='pending';await render('library',694,{viewState:{collection:'albums',category:'all',limit:48}});expect(visibleSaved()?.querySelector('[role=status]')?.textContent.includes('正在加载'),'pending saved request became an empty collection')
 const old=pendingSaved.shift();expect(old,'delayed provider request did not start');savedMode='success';await update({activeProvider:'other',profile:{...values.value.profile,userId:'other-user'},viewState:{collection:'playlists',category:'all',limit:48}})
 old.resolve(savedItems('albums','old-account',26));await tick();expect(selectedCollection()==='playlists'&&!document.querySelector('.saved-music'),'late response exposed the former account collection')
 document.querySelector('[data-collection=albums]').click();await tick();expect(visibleSaved()?.querySelector('.saved-grid>button')?.textContent.includes('other albums'),'new account did not receive its own collection')
 window.collectionMethods.value=[];await tick();expect(selectedCollection()==='playlists','controlled unsupported collection did not fall back')
 await render('library',6,{viewState:{collection:'albums',category:'saved',limit:96}});expect(selectedCollection()==='playlists'&&last('view')?.args[0].collection==='playlists'&&last('view').args[0].category==='saved'&&last('view').args[0].limit===96,'initial unsupported restore did not normalize the host state')
 await render('saved',0);expect(document.querySelector('[role=status]')?.textContent.includes('未提供'),'standalone unsupported saved collection lost its state')
 window.collectionMethods.value=['fetchSavedAlbums','fetchSavedArtists'];savedMode='error';await render('saved',0);expect(document.querySelector('[role=alert]')?.textContent.includes('受控收藏失败'),'standalone saved failure lost its cause')
 savedMode='success';savedAlbumCount=86;button('刷新').click();await tick();expect(document.querySelectorAll('.saved-grid>button').length===40,'standalone saved initial batch changed');button('显示更多').click();await tick();expect(document.querySelectorAll('.saved-grid>button').length===80,'standalone saved continuation lost')
 button('歌手').click();await tick();expect(document.querySelectorAll('.saved-grid>button').length===6,'standalone collection switch lost');button('专辑').click();await tick();expect(document.querySelectorAll('.saved-grid>button').length===80,'standalone collection revisit discarded its reveal limit')
 savedAlbumCount=26
}

window.checkLiveGrid=async()=>{
 await render('discovery',1)
 const grid=document.querySelector('.disc-mosaic'),one=document.querySelector('.disc-card-media').getBoundingClientRect().width
 await update({playlists:makePlaylists(2)})
 const pair=[...document.querySelectorAll('.disc-card-media')].map(el=>el.getBoundingClientRect())
 expect(getComputedStyle(grid).gridTemplateColumns.split(' ').length===2&&Math.abs(pair[0].left-grid.getBoundingClientRect().left)<1&&pair[0].width<=220.6,'two sparse covers were centered or stretched')
 await update({playlists:makePlaylists(30)})
 expect(getComputedStyle(grid).gridTemplateColumns.split(' ').length>1,'item count did not update the bounded columns')
 document.getElementById('collection-host').style.width='460px';await tick()
 expect(document.querySelector('.disc-card-media').getBoundingClientRect().width<=200.6,'ResizeObserver did not adapt to the actual container')
 document.documentElement.dataset.teLibraryDensity='compact';await tick()
 expect(document.querySelector('.disc-card-media').getBoundingClientRect().width<=190.6,'density attribute did not update the bounds')
 const host=document.getElementById('collection-host');host.style.width='';expect(one<=220.6,'sparse count exceeded its upper cover bound')
 for(const view of ['home','provider']){host.style.width='1000px';await render(view,6);expect(getComputedStyle(document.querySelector(view==='home'?'.chart-grid':'.music-track-grid')).gridTemplateColumns.split(' ').length===2,'middle content width did not use the two-column recommendation budget');expect(host.scrollWidth<=host.clientWidth+1,'two-column recommendation overflows its container')}
 host.style.width=''
}
`

const runner = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path');
const input=process.argv.at(-1);app.setPath('userData',path.join(path.dirname(input),'user-data'));
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});
const external=[];win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{external.push(details.url);callback({cancel:true})});
const run=code=>win.webContents.executeJavaScript(code);
const key=async(keyCode,modifiers=[])=>{win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});if(keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13),modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await new Promise(resolve=>setTimeout(resolve,15))};
try {
 await win.loadFile(input);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});win.webContents.focus();await run('window.checkCollectionStates()');
 await run('window.prepareDiscoveryActions()');await key('Enter');await run('window.checkKeyboardPlaylist(1)');await key('Space');await run('window.checkKeyboardPlaylist(2)');
 for(const view of ['home','provider']){await run('window.prepareHomeActions('+JSON.stringify(view)+')');await key('Enter');await run('window.checkKeyboardPlaylist(1)');await key('Space');await run('window.checkKeyboardPlaylist(2)')}
 await run('window.prepareLibraryActions()');await key('Space');await run('window.checkPinAndFocusCard()');await key('Enter');await run('window.checkKeyboardPlaylist(1)');await key('Down',['alt']);await run('window.checkReorder()');
 await run('window.prepareProviderMenu()');await key('Enter');await run('window.checkProviderMenu()');await key('Down');await run('window.checkProviderFocus(1)');await key('Home');await run('window.checkProviderFocus(0)');await key('End');await run('window.checkProviderFocus(1)');await key('Escape');await run('window.checkProviderDismissed()');await key('Down');await run('window.checkProviderMenu()');await key('Down');await key('Enter');await run('window.checkProviderSelected()');
 await run('window.prepareCollectionTabs()');await key('Right');await run("window.checkCollectionTab('albums')");await key('Right');await run("window.checkCollectionTab('artists')");await key('Left');await run("window.checkCollectionTab('albums')");await key('Home');await run("window.checkCollectionTab('playlists')");await run('window.checkCollectionCapabilityRemoval()');await run('window.checkCollectionRestoreAndIsolation()');
 await run('window.checkLiveGrid()');
 const records=[];
 for(const [width,height,clearance] of [[1500,1028,112],[760,520,100],[480,420,72]]){
  win.setContentSize(width,height);await new Promise(resolve=>setTimeout(resolve,20));
  for(const view of ['home','provider','discovery','library'])for(const font of [14,20,28])for(const tone of ['pureWhite','dark'])for(const density of ['comfortable','compact']){
   const count=font===14?1:font===20?6:30;records.push(await run('window.layoutCollection('+JSON.stringify({width,height,clearance,view,font,tone,density,count})+')'));
   if(process.env.TE_STREAM_COLLECTIONS_EVIDENCE&&density==='comfortable'&&((width===1500&&font===14&&tone==='pureWhite')||(width===760&&font===28&&tone==='dark'))&&['home','library'].includes(view)){const screenshot=await win.webContents.capturePage();fs.writeFileSync(path.join(path.dirname(process.env.TE_STREAM_COLLECTIONS_EVIDENCE),view+'-'+width+'-'+font+'-'+tone+'.png'),screenshot.toPNG())}
  }
 }
 if(external.length)throw Error('Unexpected external network attempts '+external.join(', '));
 if(process.env.TE_STREAM_COLLECTIONS_EVIDENCE)fs.writeFileSync(process.env.TE_STREAM_COLLECTIONS_EVIDENCE,JSON.stringify({records,externalRequests:external.length},null,2));
 console.log('STREAM_COLLECTIONS_OK '+records.length+' geometry records; controlled states, native keyboard, paging, batch reveal and live container resize');app.exit(0)
}catch(error){console.error(error.stack);app.exit(1)}
})`
