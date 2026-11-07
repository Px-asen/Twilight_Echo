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
import { compileStyle, parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test(
  'album details keep real ratings, metadata editing and track actions in the full application shell',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-album-ui-'))
    try {
      const shared = join(workspace, 'src/shared').replaceAll('\\', '/')
      const shellStores = join(directory, 'shell-stores.mjs')
      await writeFile(
        shellStores,
        (
          await readFile(join(workspace, 'scripts/fixtures/appearance-preview-stores.mjs'), 'utf8')
        ).replaceAll('__SHARED__', shared)
      )
      const filename = join(workspace, 'src/renderer/src/App.vue')
      const { descriptor } = parse(await readFile(filename, 'utf8'), { filename })
      const shellStyles = descriptor.styles
        .map(
          (style) =>
            compileStyle({ source: style.content, filename, id: 'album-shell', scoped: false }).code
        )
        .join('\n')
      await writeFile(join(directory, 'entry.mjs'), runtime)
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'album-playback-boundary',
            enforce: 'pre',
            resolveId(source) {
              if (source === '/icon.png') return join(workspace, 'resources/icon.png')
              if (/\/stores\/(useThemeStore|useNcmStore|lyricsManagement)(?:\.ts)?$/.test(source))
                return shellStores
              if (/(?:^|\/)usePlayerStore(?:\.ts)?$/.test(source)) return '\0album-player'
              if (/(?:^|\/)coreConnection(?:\.ts)?$/.test(source)) return '\0album-core'
              if (/(?:^|\/)useSettingsStore(?:\.ts)?$/.test(source)) return '\0album-settings'
              return null
            },
            load(id) {
              if (id === '\0album-core')
                return 'export const useCoreConnection = () => window.albumCore'
              if (id === '\0album-settings')
                return 'export const useSettingsStore = () => window.albumSettings'
              return id === '\0album-player'
                ? 'export const usePlayerStore = () => window.albumPlayer'
                : null
            }
          },
          vue()
        ],
        resolve: {
          alias: {
            '@renderer': join(workspace, 'src/renderer/src'),
            vue: require.resolve('vue/dist/vue.esm-bundler.js'),
            pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
          }
        },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
        build: {
          outDir: join(directory, 'bundle'),
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: join(directory, 'entry.mjs'),
            name: 'AlbumPageTests',
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
          )}<style>${shellStyles}\nbody{margin:0;font-family:'Microsoft YaHei',system-ui}#app{height:100vh}button,input,select{font:inherit}</style></head><body class="te-local-surface"><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [
          ...(process.env.NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
          join(directory, 'runner.cjs'),
          directory
        ],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /ALBUM_UI_OK/)
      for (const capture of result.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('ALBUM_CAPTURE ')))
        console.info(capture)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runtime = `
import {createApp,h,ref,shallowRef,nextTick} from 'vue'
import {createPinia} from 'pinia'
import SongList from '@renderer/components/SongList.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import PlayerBar from '@renderer/components/PlayerBar.vue'
import {usePlayerStore as shellPlayer,useSettingsStore as shellSettings} from './shell-stores.mjs'
import {buildDerivedCollections} from '@renderer/stores/library/derivedCollections.ts'
import {collectionIndexLetter} from '@renderer/utils/libraryCollectionView.ts'
import {goBack} from '@renderer/app/useBackStack.ts'
import '@renderer/assets/main.css'
const pause = ms => new Promise(r => setTimeout(r,ms))
const expect = (ok,message) => {if(!ok) throw new Error(message)}
const png = (color,end='#23324a') => {const c=document.createElement('canvas');c.width=c.height=320;const x=c.getContext('2d');const gradient=x.createLinearGradient(0,0,320,320);gradient.addColorStop(0,color);gradient.addColorStop(1,end);x.fillStyle=gradient;x.fillRect(0,0,320,320);x.strokeStyle='#ffffff66';x.lineWidth=2;for(let i=0;i<8;i++){x.beginPath();x.arc(160,160,25+i*15,0,Math.PI*2);x.stroke()}return c.toDataURL()}
const blue=png('#64a0d5'), green=png('#62ae95'), red=png('#cc7960')
const errors=[]
window.api={data:{loadPlaybackBookmarks:async()=>null},providers:{list:async()=>[]}}
window.albumPlayer={...shellPlayer(),currentTrack:ref(null),isPlaying:ref(false),plays:[],mode:'order',playTrack(t,q){window.albumPlayer.plays.push({track:t.id,count:q.length})},setPlayMode(mode){window.albumPlayer.mode=mode},playNextTrack(){},appendQueueTracks(){}}
let tracks=Array.from({length:6000},(_,i)=>({id:'track-'+i,title:i===0?'晨光':'Song '+i,artist:i===0?'周末乐队':'Artist '+i,album:i===0?'A 晨光与远方':i===1?'B 一张有着很长很长名称的专辑：那些跨过山海与时间的声音':i===2?'C 合辑 / Various Artists':String.fromCharCode(65+i%26)+' Album '+String(i).padStart(4,'0'),albumId:'album-'+i,filePath:'C:/Music/'+i+'/song.flac',fileName:'song.flac',duration:182,size:1,cover:i===3?null:i===4?'data:image/png;base64,broken':i%3===0?blue:i%3===1?green:red,releaseDate:i===3?undefined:i===2?'1998':i===1?'2019-08':'2020-05-12',genre:'Rock',lyrics:'[00:00]lyrics',source:'local'}))
tracks[1].artist='一位有着很长很长名字的歌手与远方的朋友们 / The Voices Across the Ocean'
tracks[5].cover=png('#fff4df','#e7ceb2');tracks[6].cover=png('#0c1020','#262b3a')
tracks=[...tracks,{...tracks[0],id:'track-extra-0',filePath:'C:/Music/0/second.flac',title:'晚风'},{...tracks[2],id:'track-extra-2',filePath:'C:/Music/2/second.flac',artist:'另一位歌手'}]
const collections=buildDerivedCollections(tracks,[],';')
const matching=q=>tracks.filter(t=>(!q.albumId||'id:'+t.albumId===q.albumId)&&(!q.ids||q.ids.includes(t.id))&&(!q.search||(t.title+' '+t.artist+' '+t.album).includes(q.search)))
window.albumPlayer.playLibraryQuery=async(q,id,options={})=>{window.albumPlayer.plays.push({track:id,count:matching(q).length});if(options.playMode)window.albumPlayer.mode=options.playMode}
window.albumSettings={settings:shallowRef({...shellSettings().settings.value,musicIdentification:{language:'zh-Hans'},libraryFolders:[],genreSeparators:';',trackActivationMode:'doubleClick'})}
const savedRatings=new Map(),savedPreferences=new Map(),savedIntros=new Map(),writes=[]
const favorites=new Set(),leases=new Map(),stages=new Map(),playlists=[]
let nextLease=0,nextStage=0,playlistRevision=1
const browseToken={genresRevision:1,catalogRevision:1,contentRevision:1,metadataRevision:1,asOf:1,expiresAt:null,contextKey:'album-fixture'}
const release=id=>({id,entityId:'physical-'+id,title:'A 晨光与远方',artist:'周末乐队',current:true,identity:'unidentified',metadataTargetId:null,sourceCount:1,playbackVersionCount:0})
const ratingDetail=id=>({entityId:id,kind:'release',scope:'entity',value:{steps:savedRatings.get(id)??null,revision:1,updatedAt:100},token:{ratingsRevision:1,linkRevision:0,targetKey:'entity:'+id}})
window.albumCore={state:shallowRef({phase:'ready',epoch:'album-fixture',libraryRevision:1,catalogRevision:1,entityMetadataRevision:1,ratingsRevision:1,preferencesRevision:1,tagsRevision:1,settingsRevision:1,playlistsRevision:1,versionsRevision:1,statisticsRevision:1,bookmarksRevision:1,pluginsRevision:1}),attach:async()=>{},subscribe:()=>()=>{},command:async(name,q)=>{
 writes.push({name,...q})
 if(name==='ratings.set'){expect(q.entityId.startsWith('physical-'),'rating targeted an album project or playback group');savedRatings.set(q.entityId,q.steps);return}
 if(name==='preferences.set'){savedPreferences.set(q.entityId,q.state);return}
 if(name==='metadata.entity.override'){savedIntros.set(q.entityId,q.mode==='reset'?null:q);return}
 if(name==='catalog.play')return {sourceId:q.sourceId}
 if(name==='library.selection.open'){const items=matching(q.query),selected=items.filter((_t,i)=>q.ranges.some(([start,end])=>i>=start&&i<end));const snapshot={id:'lease-'+(++nextLease),revision:1,total:q.total,selectedCount:selected.length,localTrackCount:selected.length,fileCount:selected.length};leases.set(snapshot.id,{snapshot,rows:selected.map((track,position)=>({position,definitionId:track.id,track,version:1}))});return snapshot}
 if(name==='library.selection.close'){leases.delete(q.id);return}
 if(name==='playlists.submit'){
  if(q.kind==='begin'){const id='stage-'+(++nextStage);stages.set(id,{edit:q.edit,items:[]});return {id,sequence:0}}
  const stage=stages.get(q.id);expect(stage,'playlist stage missing')
  if(q.kind==='append'){stage.items.push(...q.items);return {id:q.id,sequence:q.sequence}}
  if(q.kind==='commit'){if(stage.edit.kind==='favorite')for(const item of stage.items)stage.edit.favorite?favorites.add(item.input.id):favorites.delete(item.input.id);if(stage.edit.kind==='create')playlists.push({id:'created',name:stage.edit.name,kind:'local',count:stage.items.length,isDefault:false,createdAt:1,updatedAt:1});stages.delete(q.id);window.albumCore.state.value={...window.albumCore.state.value,playlistsRevision:++playlistRevision};return {id:q.id,sequence:q.sequence,result:stage.edit.kind==='create'?'created':stage.items.length}}
  throw Error('Unexpected playlist submission '+q.kind)
 }
 throw Error('Unexpected command '+name)
},query:async(name,q={})=>{
 if(name==='library.metadata')return {revision:1,trackCount:tracks.length,folders:[],exclusions:[]}
 if(name==='playlists.state')return {revision:playlistRevision,persistence:{state:'idle',dirty:false}}
 if(name==='playlists.catalog')return {revision:playlistRevision,offset:0,total:playlists.length,items:playlists}
 if(name==='playlists.favorites')return {revision:playlistRevision,contains:q.items.map(item=>favorites.has(item.id))}
 if(name==='library.selection.page')return {...leases.get(q.id),nextCursor:null}
 if(name==='statistics.tracks'||name==='bookmarks.page')return {revision:1,offset:0,total:0,items:[]}
 if(name==='catalog.query')return q.context.id==='id:album-3'?{revision:1,offset:0,total:0,items:[]}:{revision:1,offset:0,total:1,items:[{id:q.kind+':'+q.context.id,kind:q.kind,title:'专辑资料',artist:'周末乐队',identity:'source',sourceCount:1}]}
 if(name==='catalog.sources')return {revision:1,offset:0,total:0,items:[]}
 if(name==='metadata.entity.detail'){const override=savedIntros.get(q.entityId);return {entityId:q.entityId,targetId:null,link:null,revision:1,name:'专辑资料',introduction:override?.mode==='clear'?null:override?.mode==='value'?{value:override.value,language:override.language,origin:'manual'}:{value:'已有专辑介绍，保留发行资料与来源。音乐从清晨的微光开始，在温柔的旋律与细腻的器乐之间展开，记录沿途的风景与日常片刻。让一张唱片陪伴一个安静的下午，也为每一次重新聆听留下新的发现。',language:'zh-Hans',origin:'external',attribution:{provider:'platform.ncm',url:'https://music.163.com/'}},override:override??null,facts:[],artwork:[{handle:blue,scope:q.entityId.startsWith('album_project:')?'album_project':'release',targetRef:{provider:'ncm',kind:'release',idType:'id',value:'42'},attribution:{provider:'platform.ncm',url:'https://music.163.com/'},usage:{display:true,cache:true,crossSource:true,export:false}}],manualArtwork:{dataUrl:green}}}
 if(name==='identification.detail')return {entityId:q.entityId,kind:'release',link:null,references:[]}
 if(name==='identification.candidates')return {revision:1,offset:0,total:0,items:[]}
 if(name==='statistics.overview')return {revision:1,days:{},artists:[],history:{mode:'sqlite',ready:true,pending:false,revision:1,error:null},persistence:{dirty:false,error:null}}
 if(name==='bookmarks.state')return {revision:1,longTrackResumeSeconds:1200}
 if(name==='providers.list')return []
 if(name==='library.artwork')return {revision:1,items:q.ids.map(id=>({id,cover:tracks.find(t=>t.id===id)?.cover??null}))}
 if(name==='library.tracks'){const items=matching(q);return {revision:1,offset:q.offset??0,total:items.length,tracks:items.slice(q.offset??0,(q.offset??0)+(q.limit??200))}}
 if(name==='library.collections'){
  const query=q.query,items=collections[q.kind].filter(a=>(!query.albumId||a.id===query.albumId)&&(!query.search||a.tracks.some(t=>(t.title+' '+t.artist+' '+t.album).includes(query.search))))
  const letterOffsets={};items.forEach((a,i)=>{const l=collectionIndexLetter(a.name);if(!(l in letterOffsets))letterOffsets[l]=i})
  return {revision:1,offset:query.offset??0,total:items.length,letterOffsets,items:items.slice(query.offset??0,(query.offset??0)+(query.limit??200)).map(({tracks,...a})=>({...a,duration:tracks.reduce((s,t)=>s+t.duration,0)}))}
 }
 if(name==='albums.browse')return {token:browseToken,project:null,projectCount:0,currentRelease:release(q.entityId),offset:0,total:1,items:[release(q.entityId)],externalCatalog:'unavailable'}
 if(name==='albums.sources')return {token:browseToken,release:release(q.releaseId),offset:0,total:1,providers:['local'],providerCount:1,items:[{sourceId:'local-track-0',provider:'local',recordingId:'recording-0',title:'晨光',artist:'周末乐队',album:'A 晨光与远方',availability:'indexed',preferred:true,playbackVersion:null,identityConflict:false}]}
 if(name==='ratings.targets')return {revision:1,offset:0,total:1,items:[{id:q.entityId,kind:'release',title:'A 晨光与远方',artist:'周末乐队',identity:'source',sourceCount:1}]}
 if(name==='ratings.detail')return ratingDetail(q.entityId)
 if(name==='preferences.detail')return {entityId:q.entityId,kind:'release',scope:'entity',value:{state:savedPreferences.get(q.entityId)??'none',revision:1,updatedAt:100},token:{preferencesRevision:1,linkRevision:0,targetKey:'entity:'+q.entityId}}
 if(name==='tags.entity')return {entityId:q.entityId,token:{tagsRevision:1,catalogRevision:1,contentRevision:1,linkRevision:0},offset:0,total:0,items:[]}
 throw Error('Unexpected query '+name)
}}
const filter=ref(null)
const albumInstance=ref(0)
const menuOpen=ref(innerWidth>=1000)
const app=createApp({setup:()=>()=>h('div',{class:'app-shell'},[
 h('div',{class:'app-shell-title'},h(TitleBar,{preview:true,menuOpen:menuOpen.value})),
 h('div',{class:'app-shell-navigation'},h(SideMenu,{preview:true,open:menuOpen.value,activeKey:'albums'})),
 h('div',{class:'app-shell-content'},h('main',{class:['main-content',{'menu-open':menuOpen.value}]},h(SongList,{key:albumInstance.value,category:'albums',filter:filter.value,hasPlayer:true,transitionName:filter.value?'page-down':'page-up',onSelectView:(_category,next)=>filter.value=next,returnFromDetail:()=>{filter.value=null}}))),
 h('div',{class:'app-shell-player'},h(PlayerBar,{preview:true,previewTrack:tracks[0],previewState:'idle',glass:false}))
])})
app.use(createPinia());app.config.errorHandler=e=>errors.push(String(e));app.mount('#app')
window.albumCase=async(tone,detail=false,albumIndex=0)=>{document.documentElement.dataset.theme=tone;menuOpen.value=innerWidth>=1000;filter.value=detail?'album:id:album-'+albumIndex:null;await nextTick();await pause(650);expect(errors.length===0,errors.join(';'));return document.body.scrollWidth<=innerWidth}
window.albumTest=async()=>{
 await window.albumCase('pureWhite')
 const cards=[...document.querySelectorAll('.local-album-card')]
 expect(cards.length>0&&cards.length<100,'grid was not virtualized')
 expect(cards[0].textContent.includes('周末乐队'),'artist not shown')
 expect(cards[0].textContent.includes('2020年5月12日'),'date not shown')
 expect(cards.every(c=>Math.abs(c.getBoundingClientRect().height-cards[0].getBoundingClientRect().height)<1),'card metadata shifted row height')
 cards[0].focus();await window.albumKey('Enter');await pause(650)
 expect(document.querySelector('#local-album-title')?.textContent==='A 晨光与远方','native keyboard did not open album')
 expect(document.querySelector('.album-detail-header')?.textContent.includes('2020年5月12日'),'detail date absent')
 expect(getComputedStyle(document.querySelector('.album-detail-header')).getPropertyValue('--album-tint').trim().startsWith('#'),'art tint missing')
 const expectSingleCover=()=>{
  expect(document.querySelectorAll('.album-detail-header .album-artwork img').length===1,'main album cover absent')
  expect(!document.querySelector('.entity-metadata .overview-artwork-col'),'album metadata repeated public or manual artwork')
  expect(document.querySelector('.metadata-introduction')?.textContent.includes('已有专辑介绍'),'album introduction absent')
  expect(document.querySelector('.metadata-attribution')?.textContent.includes('网易云音乐'),'introduction source absent')
 }
 expectSingleCover()
 const overview=document.querySelector('.album-overview-body')
 const rating=document.querySelector('.star-interactive-row')
 expect(rating&&rating.getBoundingClientRect().height>0,'persistent rating control absent from upper summary')
 expect(overview.getBoundingClientRect().bottom<=document.querySelector('.collection-tracks-main').getBoundingClientRect().top,'introduction and ratings not above songs')
 expect(!document.querySelector('.metadata-heading').getBoundingClientRect().height,'full metadata controls leaked into summary')
 document.querySelectorAll('.star-hit')[6].click();await pause(200)
 expect([...savedRatings.values()][0]===7&&rating.getAttribute('aria-valuenow')==='3.5','rating did not save and read back the concrete release')
 rating.focus();await window.albumKey('ArrowRight');await pause(50)
 expect(document.querySelector('.rating-draft').textContent.includes('4 星'),'keyboard half-star adjustment absent')
 document.querySelector('.rating-actions .primary-btn').click();await pause(150)
 document.querySelector('.personal-preferences .favorite-btn').click();await pause(150)
 expect([...savedPreferences.values()][0]==='favorite','release preference did not persist')
 const detailsTrigger=document.querySelector('.album-details-trigger');detailsTrigger.focus();detailsTrigger.click();await pause(150)
 const modal=document.querySelector('.album-metadata-dialog')
 expect(modal?.matches(':modal'),'album information is not a native modal')
 const modalRect=modal.getBoundingClientRect()
 expect(modalRect.left>=16&&modalRect.top>=16&&Math.abs(modalRect.left+modalRect.width/2-innerWidth/2)<2&&Math.abs(modalRect.top+modalRect.height/2-innerHeight/2)<2,'native details dialog is not centered inside the application window')
 await window.albumCapture('album-dialog')
 expect(document.querySelectorAll('.personal-ratings').length===1&&document.querySelector('.star-interactive-row')===rating,'dialog duplicated or remounted rating state')
 expect(document.querySelector('.roon-specs-table')?.getBoundingClientRect().height>0,'full specifications absent from dialog')
 document.querySelector('.album-play-primary').focus();expect(modal.contains(document.activeElement),'background took modal focus')
 await window.albumKey('Tab');expect(modal.contains(document.activeElement),'Tab escaped modal focus constraint')
 const layerButton=label=>[...document.querySelectorAll('.metadata-layers button')].find(b=>b.textContent.trim()===label)
 layerButton('专辑作品').click();await pause(250);expectSingleCover()
 layerButton('具体发行').click();await pause(250);expectSingleCover()
 const button=(root,label)=>[...root.querySelectorAll('button')].find(b=>b.textContent.trim()===label)
 button(modal,'编辑介绍').click();await pause(50)
 const draft=document.querySelector('.introduction-editor textarea');draft.value='为这张唱片写下的手动简介';draft.dispatchEvent(new Event('input',{bubbles:true}))
 await window.albumKey('Escape');await pause(100)
 expect(!document.querySelector('.album-metadata-dialog')&&document.activeElement===detailsTrigger,'Escape did not close and restore opener focus')
 expect(document.querySelector('.star-interactive-row')===rating,'closing dialog remounted ratings')
 detailsTrigger.click();await pause(100)
 expect(document.querySelector('.introduction-editor textarea')===draft&&draft.value.includes('手动简介'),'closing dialog lost the introduction draft')
 button(document.querySelector('.album-metadata-dialog'),'保存介绍').click();await pause(200)
 expect(document.querySelector('.metadata-introduction').textContent.includes('手动简介'),'saved introduction did not read back')
 button(document.querySelector('.album-metadata-dialog'),'恢复自动').click();await pause(50)
 button(document.querySelector('.album-metadata-dialog'),'确认恢复自动').click();await pause(150)
 expectSingleCover()
 const tabs=[...document.querySelectorAll('.metadata-section-tabs button')]
 tabs[0].focus();await window.albumKey('ArrowRight');await pause(100)
 expect(tabs[1].getAttribute('aria-selected')==='true'&&document.activeElement===tabs[1],'metadata tabs lost keyboard navigation')
 expect(document.querySelector('.release-list').getBoundingClientRect().height>0,'release and source view absent')
 const explicitPlay=button(document.querySelector('.source-actions'),'明确播放此音源')
 expect(explicitPlay,'explicit source playback action absent');explicitPlay.click();await pause(100)
 expect(writes.some(w=>w.name==='catalog.play'&&w.sourceId==='local-track-0'),'source play changed its command contract')
 tabs[2].click();await pause(100)
 expect(document.querySelector('.metadata-curation-pane').getBoundingClientRect().height>0,'identity and editing section absent')
 await window.albumKey('Escape');await pause(100)
 expect(rating.getAttribute('aria-valuenow')==='4','metadata navigation changed saved rating')
 const expand=document.querySelector('.album-intro-more');expand.focus();expand.click();await pause(100)
 expect(document.querySelector('.album-metadata-dialog')?.matches(':modal'),'expand full introduction did not open the shared details')
 await window.albumKey('Escape');await pause(100)
 expect(document.activeElement===document.querySelector('.album-intro-more'),'closing full introduction did not return focus to its recreated opener')
 const more=document.querySelector('.album-more-trigger');more.click();await pause(50)
 expect(document.activeElement===document.querySelector('.album-versions-btn'),'more menu did not focus version management')
 await window.albumKey('Escape');expect(document.activeElement===more&&!document.querySelector('.album-more-menu'),'more menu Escape or focus return failed')
 document.querySelector('.album-play-primary').click();document.querySelector('.album-play-secondary').click()
 expect(window.albumPlayer.plays.length===2&&window.albumPlayer.plays.every(p=>p.count===2),'album playback queue incorrect')
 expect(window.albumPlayer.mode==='shuffle','shuffle action lost')
 expect(document.querySelector('.track-table-wrapper'),'track table absent')
 expect(!document.querySelector('.track-row .track-cover-img')&&!document.querySelector('.track-row .col-album'),'album rows repeat artwork or album title')
 const songSearch=document.querySelector('.search-input');expect(songSearch.placeholder==='搜索本专辑歌曲','song search scope unclear')
 songSearch.value='晚风';songSearch.dispatchEvent(new Event('input',{bubbles:true}));await pause(800)
 expect(document.querySelectorAll('.track-row').length===1&&document.querySelector('.track-row').textContent.includes('晚风'),'album song search changed scope')
 document.querySelector('.search-clear').click();await pause(800)
 document.querySelector('.library-filter-trigger').click();await pause(50)
 expect(document.querySelector('.library-filter-panel')?.getBoundingClientRect().height>0,'album filter controls absent')
 document.querySelector('.library-filter-trigger').click();await pause(50)
 const rows=[...document.querySelectorAll('.track-row')];rows[0].focus();await window.albumKey('Space');await pause(50)
 expect(document.querySelector('.selection-count')?.textContent.includes('1'),'keyboard row selection absent')
 document.querySelectorAll('.track-select-checkbox input')[1].click();await pause(50)
 expect(document.querySelector('.selection-count')?.textContent.includes('2'),'multiple selection changed after removing row covers')
 document.querySelector('.selection-btn.ghost').click();await pause(50)
 document.querySelector('.album-favorite-btn').click();await pause(200)
 expect(favorites.size===2&&document.querySelector('.album-favorite-btn').getAttribute('aria-pressed')==='true','album favorite omitted songs or failed to reflect its saved state')
 document.querySelector('.album-playlist-btn').click();await pause(50)
 expect(document.querySelector('.create-playlist-dialog'),'album add-to-playlist entry did not open its existing dialog')
 const playlistName=document.querySelector('.dialog-input');playlistName.value='唱片收藏';playlistName.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
 document.querySelector('.dialog-btn.confirm').click()
 for(let i=0;i<50&&(document.querySelector('.create-playlist-dialog')||!playlists.length);i++)await pause(20)
 expect(playlists.some(p=>p.name==='唱片收藏'&&p.count===2)&&!document.querySelector('.create-playlist-dialog'),'album playlist creation changed its bounded track submission')
 expect(goBack(),'title bar back handler absent');await pause(650)
 filter.value='album:id:album-0';await pause(650)
 expect(document.querySelector('.star-interactive-row')?.getAttribute('aria-valuenow')==='4','saved rating did not survive leaving and reopening the album')
 expect(document.querySelector('.personal-preferences .favorite-btn')?.getAttribute('aria-pressed')==='true','saved preference did not survive reopening')
 expect(document.querySelector('.album-favorite-btn')?.getAttribute('aria-pressed')==='true','saved album favorite was not read on reopening')
 expect(goBack(),'reopened album lost back handler');await pause(650)
 const search=document.querySelector('.search-input');search.value='晨光';search.dispatchEvent(new Event('input',{bubbles:true}));await pause(800)
 expect(document.querySelectorAll('.local-album-card').length===1,'album search broke')
 document.querySelector('.search-clear').click();await pause(800)
 const normalHeight=document.querySelector('.local-album-card').getBoundingClientRect().height
 document.documentElement.style.setProperty('--te-font-size-body','21px');document.documentElement.dataset.teLibraryDensity='compact';await pause(250)
 const resizedCards=[...document.querySelectorAll('.local-album-card')]
 expect(resizedCards[0].getBoundingClientRect().height!==normalHeight,'font and density did not resize cards')
 expect(resizedCards.every(c=>Math.abs(c.getBoundingClientRect().height-resizedCards[0].getBoundingClientRect().height)<1),'resized cards lost alignment')
 const az=[...document.querySelectorAll('.az-index button')].find(b=>b.textContent.trim()==='M')
 expect(az&&!az.disabled,'A-Z index absent');az.click();await pause(100)
 const container=document.querySelector('.song-list');const top=container.scrollTop
 expect(top>1000,'A-Z did not jump into virtual grid')
 expect([...document.querySelectorAll('[data-collection-letter="M"]')].some(c=>c.getBoundingClientRect().bottom>container.getBoundingClientRect().top&&c.getBoundingClientRect().top<container.getBoundingClientRect().bottom),'A-Z missed the letter after font/density change')
 document.querySelector('.local-album-card').click();await pause(650);expect(goBack(),'title bar back handler absent');await pause(650)
 expect(Math.abs(container.scrollTop-top)<3,'return did not restore parent scroll')
 document.documentElement.style.removeProperty('--te-font-size-body');delete document.documentElement.dataset.teLibraryDensity;await pause(250)
 container.scrollTop=0;container.dispatchEvent(new Event('scroll'));await pause(100)
 filter.value='album:id:album-1';await pause(650)
 expect(document.querySelector('#local-album-title').title.includes('山海'),'long title tooltip missing')
 expect(document.querySelector('.album-detail-release').textContent==='2019年8月','month precision lost')
 filter.value='album:id:album-2';await pause(650)
 expect(document.querySelector('.album-detail-artist').textContent.trim()==='群星','compilation artist missing')
 expect(document.querySelector('.album-detail-release').textContent==='1998年','year precision lost')
 filter.value='album:id:album-3';await pause(650)
 const missingArtwork=document.querySelector('.album-artwork img')
 expect(missingArtwork?.complete&&missingArtwork.naturalWidth===1254,'missing album artwork must display the packaged music cover')
 expect(document.querySelector('.album-detail-release').textContent==='发行时间未知','unknown date missing')
 expect(document.querySelector('.album-intro-heading')?.textContent==='简介'&&document.querySelector('.album-rating-unavailable'),'missing metadata needs an introduction label and honest rating empty state')
 filter.value='album:id:album-4';await pause(650)
 const failedArtwork=document.querySelector('.album-artwork img')
 expect(failedArtwork?.complete&&failedArtwork.naturalWidth===1254,'failed album artwork must display the packaged music cover')
 filter.value=null;await pause(650)
 filter.value='album:id:album-0';albumInstance.value++;await nextTick();await pause(650)
 expect(document.querySelector('#local-album-title')?.textContent==='A 晨光与远方','initial album-detail mount failed')
 expect(document.querySelector('.album-detail-release')?.textContent==='2020年5月12日','initial album-detail mount lost its date')
 expect(errors.length===0,errors.join(';'))
 return 'ALBUM_UI_OK'
}
`

const runner = `
const {app,BrowserWindow,ipcMain}=require('electron');const path=require('node:path');const fs=require('node:fs');
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
ipcMain.handle('album:key',async(_event,key)=>{const keyCode=key.replace(/^Arrow/,'');win.webContents.sendInputEvent({type:'keyDown',keyCode});if(key==='Enter'||key==='Space')win.webContents.sendInputEvent({type:'char',keyCode:key==='Enter'?'\\r':' '});win.webContents.sendInputEvent({type:'keyUp',keyCode});await new Promise(r=>setTimeout(r,50))});
ipcMain.handle('album:capture',async(_event,name)=>{if(process.env.TWILIGHT_ALBUM_CAPTURE?.split(',').includes(name))console.log('ALBUM_CAPTURE '+name+' '+(await win.webContents.capturePage()).toJPEG(65).toString('base64'))});
try {await win.loadFile(path.join(directory,'index.html'));await win.webContents.executeJavaScript("window.albumKey=key=>require('electron').ipcRenderer.invoke('album:key',key);window.albumCapture=name=>require('electron').ipcRenderer.invoke('album:capture',name);void 0");console.log(await win.webContents.executeJavaScript('window.albumTest()'));
for(const tone of ['pureWhite','dark'])for(const [width,height] of [[1920,1080],[1440,900],[900,900],[520,900]])for(const detail of [false,true]){
 win.setContentSize(width,height);const fits=await win.webContents.executeJavaScript('window.albumCase('+JSON.stringify(tone)+','+detail+')');if(!fits)throw new Error('overflow '+tone+' '+width);
 if(detail&&width>=1440){const geometry=await win.webContents.executeJavaScript("(()=>{const first=document.querySelector('.track-row').getBoundingClientRect(),player=document.querySelector('.player-bar').getBoundingClientRect(),head=document.querySelector('.track-table thead').getBoundingClientRect();return {first:first.toJSON(),player:player.toJSON(),head:head.toJSON()}})()");if(geometry.first.bottom>geometry.player.top||geometry.head.top<0)throw Error('first song hidden in full shell '+JSON.stringify(geometry))}
 if(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR){fs.mkdirSync(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR,{recursive:true});const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR,tone+'-'+width+'-'+(detail?'detail':'grid')+'.png'),image.toPNG())}
 const key=tone+'-'+width+'-'+(detail?'detail':'grid');if(process.env.TWILIGHT_ALBUM_CAPTURE?.split(',').includes(key))console.log('ALBUM_CAPTURE '+key+' '+(await win.webContents.capturePage()).toJPEG(65).toString('base64'));
 if(detail&&width===520){const reaches=await win.webContents.executeJavaScript("(async()=>{const container=document.querySelector('.song-list');container.scrollTop=container.scrollHeight;container.dispatchEvent(new Event('scroll'));await new Promise(r=>setTimeout(r,100));const row=[...document.querySelectorAll('.track-row')].at(-1).getBoundingClientRect(),player=document.querySelector('.player-bar').getBoundingClientRect();return row.bottom<=player.top&&row.top>=0})()");if(!reaches)throw Error('last song obscured by player in narrow window')}
}
for(const tone of ['pureWhite','dark'])for(const [width,index] of [[1440,1],[520,1],[520,2],[520,3],[520,4],[1440,5],[1440,6]]){
 win.setContentSize(width,900);
 const fits=await win.webContents.executeJavaScript('window.albumCase('+JSON.stringify(tone)+',true,'+index+')');if(!fits)throw new Error('edge-case overflow '+tone+' '+index);
 if(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR,tone+'-'+width+'-album-'+index+'.png'),image.toPNG())}
 const key=tone+'-'+width+'-album-'+index;if(process.env.TWILIGHT_ALBUM_CAPTURE?.split(',').includes(key))console.log('ALBUM_CAPTURE '+key+' '+(await win.webContents.capturePage()).toJPEG(65).toString('base64'));
}app.exit(0)}catch(e){console.error(e.stack);const line=String(e.stack).match(/runtime.iife.js:(\\d+)/)?.[1];if(line)console.error(fs.readFileSync(path.join(directory,'bundle/runtime.iife.js'),'utf8').split('\\n').slice(Number(line)-3,Number(line)+2).join('\\n'));console.error(await win.webContents.executeJavaScript('JSON.stringify({text:document.body.innerText,errors:window.previewErrors})'));app.exit(1)}
});`
