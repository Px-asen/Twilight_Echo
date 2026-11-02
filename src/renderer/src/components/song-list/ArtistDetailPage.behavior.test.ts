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

test(
  'local artist page: real song table, full playback, metadata management, participation and responsive themes',
  { timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-artist-page-'))
    try {
      await writeFile(join(directory, 'entry.mjs'), runtime)
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'artist-core-boundary',
            enforce: 'pre',
            resolveId(source) {
              if (/(?:^|\/)coreConnection(?:\.ts)?$/.test(source)) return '\0artist-core'
              if (/(?:^|\/)useSettingsStore(?:\.ts)?$/.test(source)) return '\0artist-settings'
              if (/(?:^|\/)usePlayerStore(?:\.ts)?$/.test(source)) return '\0artist-player'
              return null
            },
            load(id) {
              if (id === '\0artist-core')
                return 'export const useCoreConnection=()=>window.artistCore'
              if (id === '\0artist-settings')
                return 'export const useSettingsStore=()=>window.artistSettings'
              if (id === '\0artist-player')
                return 'export const usePlayerStore=()=>window.artistPlayer'
              return null
            }
          },
          vue()
        ],
        resolve: {
          alias: {
            '@renderer': join(workspace, 'src/renderer/src'),
            '@phosphor-icons/web/regular': require.resolve('@phosphor-icons/web/regular'),
            vue: require.resolve('vue/dist/vue.esm-bundler.js'),
            pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
          }
        },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
        build: {
          outDir: join(directory, 'bundle'),
          minify: false,
          lib: {
            entry: join(directory, 'entry.mjs'),
            name: 'ArtistPageTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">${files
          .filter((f) => f.endsWith('.css'))
          .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
          .join(
            ''
          )}<style>body{margin:0;font-family:'Microsoft YaHei',system-ui}#app{height:100vh}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
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
        { windowsHide: true, timeout: 100_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /ARTIST_PAGE_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runtime = `
import {createApp,h,nextTick,ref,shallowRef} from 'vue'
import {createPinia} from 'pinia'
import SongList from '@renderer/components/SongList.vue'
import {installScrollToTopButton} from '@renderer/utils/scrollToTopButton.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
import '@phosphor-icons/web/regular'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const expect=(ok,message)=>{if(!ok)throw Error(message)}
const errors=[],reads=[],writes=[],plays=[],menus=[]
const wait=async(predicate,message)=>{for(let i=0;i<150;i++){await nextTick();await pause(20);if(predicate())return}throw Error(message+'; '+errors.join(';'))}
const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text)
const click=async(text)=>{await wait(()=>button(text)&&!button(text).disabled,'unavailable button '+text);button(text).click();await nextTick()}
const input=(element,value,type='input')=>{element.value=value;element.dispatchEvent(new Event(type,{bubbles:true}))}
const canvas=document.createElement('canvas');canvas.width=640;canvas.height=720
const ctx=canvas.getContext('2d'),gradient=ctx.createLinearGradient(0,0,640,720)
gradient.addColorStop(0,'#526c76');gradient.addColorStop(1,'#192d35');ctx.fillStyle=gradient;ctx.fillRect(0,0,640,720)
ctx.fillStyle='#bfc4bd';ctx.beginPath();ctx.ellipse(330,265,100,126,0,0,Math.PI*2);ctx.fill()
ctx.fillStyle='#243b40';ctx.beginPath();ctx.ellipse(330,600,225,230,0,0,Math.PI*2);ctx.fill()
const defaultPortrait=canvas.toDataURL()
const logoCanvas=document.createElement('canvas');logoCanvas.width=logoCanvas.height=500
const logoCtx=logoCanvas.getContext('2d');logoCtx.fillStyle='#fff';logoCtx.fillRect(0,0,500,500)
logoCtx.fillStyle='#e97887';logoCtx.fillRect(170,20,55,180);logoCtx.fillRect(275,20,55,180)
logoCtx.beginPath();logoCtx.arc(250,260,115,0,Math.PI*2);logoCtx.fill()
logoCtx.fillStyle='#17232c';logoCtx.textAlign='center';logoCtx.font='bold 64px sans-serif';logoCtx.fillText('LOGO',250,475)
const squareLogo=logoCanvas.toDataURL()
let portrait=defaultPortrait
const covers=Array.from({length:25},(_,i)=>{const c=document.createElement('canvas');c.width=c.height=200;const p=c.getContext('2d');p.fillStyle=['#454b57','#578975','#ba8960','#b4c0b3','#596d91'][i%5];p.fillRect(0,0,200,200);p.strokeStyle='#e7ddc4';p.lineWidth=2;for(let j=0;j<7;j++){p.beginPath();p.arc(100,100,20+j*13,0,Math.PI*2);p.stroke()}return c.toDataURL()})
const artist=ref('周末乐队'),category=ref('artists'),filter=ref('artist:周末乐队')
const albums=Array.from({length:25},(_,i)=>({id:'album-'+i,name:String(i+1).padStart(2,'0')+' · '+['晨光与远方','让风带走回声','夜航日记','山海之间','给未来的一封信'][i%5],artist:'周末乐队',trackCount:16,duration:2880,cover:covers[i],releaseDate:'2020-05-12'}))
const tracks=Array.from({length:850},(_,i)=>({id:'track-'+i,title:'歌曲 '+String(i).padStart(4,'0'),artist:'周末乐队',album:albums[i%25].name,albumId:albums[i%25].id,duration:180,size:1,format:'FLAC',sampleRate:48000,bitDepth:24,source:'local'}))
let attribution={provider:'wikipedia',externalId:'Artist',url:'https://zh.wikipedia.org/wiki/音乐',license:'CC BY-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',attribution:'Wikipedia 贡献者',revision:'1',retrievedAt:1}
let usage={display:true,cache:true,crossSource:true,export:true}
let biographyLanguage='zh-Hans',artworkAttribution=null,artworkReference=null
const mbid='a223958d-5c56-4b2c-a30a-87e357bc121b'
let revision=1,override=null,artworkOverride=null,broken=false,missing=false,denied=false,homonym=false,confirmedC=false,delay=0,fail=false,jobs=[]
let biography='周末乐队以细腻的人声与层次丰富的器乐，记录城市生活中短暂而明亮的瞬间。最初的创作来自几位朋友在周末的排练，随后逐渐发展出融合独立摇滚、民谣与环境音乐的声音。\\n\\n'+('从清晨的街道到深夜的灯火，他们的作品始终围绕记忆、远行与人与人之间的联系展开。吉他的纹理和缓慢铺开的节奏，让每一次聆听都能发现新的细节。'.repeat(5))
const entity=(id='source-a')=>({id,kind:'artist',title:artist.value,artist:'',identity:'source',sourceCount:1})
const identity=id=>({entityId:id,kind:'artist',references:id==='source-c'&&!confirmedC?[]:[{provider:'musicbrainz',kind:'artist',idType:'mbid',value:id==='source-b'?'b223958d-5c56-4b2c-a30a-87e357bc121b':mbid}],link:id==='source-c'&&!confirmedC?null:{id:'link-'+id,entityId:id,kind:'artist',state:'confirmed',targetId:id==='source-b'?'another':'person',revision:1,confirmation:id==='source-a'?{mode:'automatic',rule:'artist_recordings'}:id==='source-c'?{mode:'manual'}:{mode:'legacy'}}})
const detail=id=>({entityId:id,targetId:identity(id).link?.targetId??null,name:artist.value,revision,
 link:identity(id).link?{state:'confirmed',revision:1,mbid:identity(id).references[0].value}:null,override,artworkOverride,manualArtwork:null,sourceOptions:['wikipedia'],sourcePreference:{provider:null,available:true},
 introduction:override?.mode==='clear'?null:override?.mode==='value'?{value:override.value,language:'zh-Hans',origin:'manual',attribution:null}:{value:id==='source-b'?'另一位同名人物的简介。':biography,language:biographyLanguage,origin:'external',attribution},
 facts:denied?[]:[{field:'introduction',value:id==='source-b'?'另一位同名人物的简介。':biography,language:biographyLanguage,attribution,usage}],
 artwork:missing||denied?[]:[{scope:'artist',handle:broken?'data:image/png;base64,invalid':portrait,attribution:artworkAttribution??{...attribution,provider:'commons',attribution:'测试人物插画 · 界面夹具'},usage,targetRef:artworkReference??{provider:'musicbrainz',kind:'artist',idType:'mbid',value:mbid}}]})
const candidate=()=>({id:'candidate-c',entityId:'source-c',kind:'artist',provider:'musicbrainz',name:artist.value,summary:'核对当前曲目对应的人物',references:[{provider:'musicbrainz',kind:'artist',idType:'mbid',value:mbid}],evidence:{origin:'search',matches:['name'],missing:[],conflicts:[],incomplete:false,provenance:'测试曲目'},matcherVersion:'1',inputVersion:'1',linkRevision:0,revision:1,state:confirmedC?'confirmed':'candidate',suppressed:false,createdAt:1,updatedAt:1})
const token={revision:1,libraryRevision:1,catalogRevision:1,entityMetadataRevision:1,expiresAt:null}
const explorationArtist={id:'person',kind:'artist',title:'周末乐队',artist:'',inLibrary:true,sourceCount:850}
const work={id:'work',kind:'work',title:'风中的回声',artist:'周末乐队',inLibrary:true,sourceCount:2}
const state=shallowRef({phase:'ready',epoch:'artist-fixture',libraryRevision:1,catalogRevision:1,entityMetadataRevision:1,entityMetadataContentRevision:1,settingsRevision:1,playlistsRevision:1,versionsRevision:1,statisticsRevision:1,bookmarksRevision:1,pluginsRevision:1,preferencesRevision:1,tagsRevision:1})
const bump=()=>{revision++;state.value={...state.value,entityMetadataRevision:state.value.entityMetadataRevision+1,entityMetadataContentRevision:revision}}
window.api={window:{popupContextMenu:async request=>{menus.push(request);return null},closeContextMenu:async()=>{}}}
window.artistSettings={settings:shallowRef({musicIdentification:{language:'zh-Hans'},libraryFolders:[],genreSeparators:';',trackActivationMode:'doubleClick'})}
window.artistCore={state,attach:async()=>{},subscribe:()=>()=>{},query:async(name,q={},signal)=>{
 reads.push({name,q});const nameAtRead=artist.value;if(delay)await pause(delay);signal?.throwIfAborted()
 if(name==='library.metadata')return {revision:1,trackCount:850,folders:[],exclusions:[],historyRevision:1}
 if(name==='playlists.state')return {revision:1,persistence:{state:'idle',dirty:false},repair:null}
 if(name==='playlists.catalog')return {revision:1,offset:0,total:0,items:[]}
 if(name==='providers.list')return []
 if(name==='bookmarks.state')return {revision:1,longTrackResumeSeconds:1200}
 if(name==='bookmarks.page')return {revision:1,offset:0,total:0,items:[]}
 if(name==='statistics.overview')return {revision:1,days:{},artists:[],history:{mode:'sqlite',ready:true,pending:false,revision:1,error:null},persistence:{dirty:false,error:null}}
 if(name==='statistics.tracks')return {revision:1,offset:0,total:0,items:[]}
 if(name==='library.tracks'){
  const items=tracks.filter(t=>(!q.search||t.title.includes(q.search))&&(!q.ids||q.ids.includes(t.id)))
  const anchorIndex=q.anchorId?items.findIndex(t=>t.id===q.anchorId):undefined
  const offset=anchorIndex>=0?Math.floor(anchorIndex/200)*200:(q.offset??0)
  return {revision:1,offset,total:items.length,tracks:items.slice(offset,offset+(q.limit??200)),anchorIndex}
 }
 if(name==='library.artwork')return {revision:1,items:q.ids.map(id=>({id,cover:null}))}
 if(name==='library.collections'){
  if(q.kind==='artists')return {revision:1,offset:0,total:1,letterOffsets:{Z:0},items:[{id:artist.value,name:artist.value,trackCount:850,cover:covers[0]}]}
  let items=q.query.albumId?albums.filter(a=>a.id===q.query.albumId):albums
  return {revision:1,offset:q.query.offset??0,total:items.length,items:items.slice(q.query.offset??0,(q.query.offset??0)+(q.query.limit??200))}
 }
 if(name==='catalog.query'){if(fail)throw Error('fixture read failed');const items=homonym?[entity('source-c'),entity('source-b'),entity()]:[entity()];return {revision,offset:q.offset??0,total:items.length,items:items.slice(q.offset??0,(q.offset??0)+(q.limit??200))}}
 if(name==='catalog.sources')return {revision,offset:0,total:1,items:[{track:{id:'track',title:q.entityId==='source-b'?'同名人物的另一首歌':q.entityId==='source-c'?'待核对的曲目':'晨光',album:'晨光与远方'}}]}
 if(name==='metadata.entity.detail')return {...detail(q.entityId),name:nameAtRead}
 if(name==='identification.detail')return identity(q.entityId)
 if(name==='identification.candidates'){const items=q.entityId==='source-c'&&q.state===(confirmedC?'confirmed':'candidate')?[candidate()]:[];return {revision:1,offset:0,total:items.length,items}}
 if(name==='identification.preview')return {candidate:candidate(),current:identity('source-c'),proposedTargetId:'person',action:'link',stale:false,conflicts:[],canConfirm:true}
 if(name==='identification.history')return {revision:1,offset:0,total:0,items:[]}
 if(name==='metadata.entity.policy')return {enabled:false,identity:!denied,introduction:!denied,reason:denied?'permission_denied':null,sources:[{provider:'musicbrainz',identification:[],enrichment:[{provider:'musicbrainz-details',kind:'artist',reason:denied?'permission_denied':null},{provider:'public-artwork',kind:'artist',reason:denied?'permission_denied':null}]}]}
 if(name==='metadata.entity.jobs')return {items:jobs,total:jobs.length}
 if(name==='preferences.detail')return {entityId:q.entityId,revision:1,scope:'source',value:null,impact:{},token}
 if(name==='tags.entity')return {entityId:q.entityId,revision:1,tags:[],intent:null,token}
 if(name==='tags.list')return {revision:1,total:0,items:[],offset:0,token}
 if(name==='exploration.lookup'||name==='exploration.detail')return {entity:q.entityId==='work'?work:explorationArtist,token,providerTruncated:false}
 if(name==='exploration.participation')return {token,offset:0,total:1,items:[{entity:{...work,inLibrary:q.scope==='library'},relation:{id:'relation',kind:'credit',order:0,origin:'external',from:explorationArtist,to:work,credit:{role:q.roles?.[0]??'composer',attributes:[]}}}]}
 if(name==='exploration.relations')return {token,offset:0,total:0,items:[]}
 if(name==='albums.browse')return {token:{expiresAt:null},project:null,projectCount:0,currentRelease:null,offset:0,total:0,items:[],externalCatalog:'unavailable'}
 throw Error('Unexpected query '+name)
},command:async(name,q)=>{
 writes.push({name,q})
 if(name==='identification.decide'){expect(q.candidateId==='candidate-c'&&q.decision==='confirm','wrong identity decision');confirmedC=true;return identity('source-c')}
 if(name==='metadata.entity.override'){override=q.mode==='reset'?null:q;bump();return detail(q.entityId)}
 if(name==='metadata.entity.artworkOverride'){artworkOverride=q.mode==='reset'?null:q;bump();return detail(q.entityId)}
 if(name==='metadata.entity.enrich'){const j={id:q.provider,provider:q.provider,type:'enrich',state:'queued',generation:1,updatedAt:1};jobs=[...jobs.filter(x=>x.id!==j.id),j];return j}
 throw Error('Unexpected command '+name)
}}
window.artistPlayer={currentTrack:ref(tracks[720]),queue:ref([]),isPlaying:ref(false),mode:'order',
 playLibraryQuery:async(query,index,options)=>{plays.push({query,index,options})},playTrack(){},playTrackFromPosition(){},playNextTrack(){},setPlayMode(){},appendQueueTracks(){}}
const app=createApp({setup:()=>()=>h(SongList,{category:category.value,filter:filter.value,hasPlayer:false,transitionName:'page-up',onSelectView:(c,f)=>{category.value=c;filter.value=f}})})
app.use(createPinia());app.config.errorHandler=e=>errors.push(e.stack||String(e));app.mount('#app')
installScrollToTopButton()
window.artistReady=()=>wait(()=>document.querySelectorAll('.artist-album-grid .local-album-card').length===6&&document.querySelector('.artist-biography-text'),'artist overview not ready')
window.artistTest=async()=>{
 await window.artistReady();expect(writes.length===0,'opening page submitted metadata work')
 expect(document.querySelector('.artist-library-stats').textContent.includes('25')&&document.querySelector('.artist-library-stats').textContent.includes('850'),'full totals missing')
 expect(document.querySelector('.artist-portrait img')?.alt.includes('人物照片'),'portrait missing')
 const bio=document.querySelector('.artist-biography-text');expect(bio.classList.contains('collapsed'),'long biography not collapsed')
 await click('展开全文');expect(!bio.classList.contains('collapsed'),'biography failed to expand');await click('收起简介')
 document.querySelector('#artist-tab-overview').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))
 await wait(()=>document.querySelectorAll('.artist-album-grid .local-album-card').length===12,'keyboard tab did not open album page')
 expect(document.activeElement.id==='artist-tab-albums','tab focus lost')
 await click('下一页专辑');await wait(()=>document.querySelector('.local-album-name')?.textContent.startsWith('13'),'album pagination wrong')
 document.querySelector('.local-album-card').click();await wait(()=>document.querySelector('#local-album-title'),'album navigation failed')
 expect(filter.value==='album:album-12','album ID was not retained')
 category.value='artists';filter.value='artist:周末乐队';await window.artistReady()
 document.querySelector('#artist-tab-songs').click();await wait(()=>document.querySelectorAll('.track-row:not(.track-row-pending)').length>0,'song table missing')
 const search=document.querySelector('.search-input');input(search,'歌曲 000');await wait(()=>reads.some(r=>r.name==='library.tracks'&&r.q.search==='歌曲 000'),'search did not reach library query')
 await wait(()=>document.querySelectorAll('.track-row:not(.track-row-pending)').length===10,'song search wrong')
 const rows=[...document.querySelectorAll('.track-row')];rows[0].dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));rows[1].dispatchEvent(new MouseEvent('click',{ctrlKey:true,bubbles:true}))
 await wait(()=>document.querySelectorAll('.track-selected').length===2,'song multiselect broke')
 rows[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:250,clientY:200}));await wait(()=>menus.length>0,'native song context menu missing');expect(menus[0].items.length>0,'native menu actions missing')
 await click('播放全部');await click('随机播放')
 expect(plays.length===2&&plays.every(p=>p.query.artist==='周末乐队'&&!p.query.search&&!p.query.ids),'artist playback was narrowed by table search')
 expect(plays[1].options.randomStart&&plays[1].options.playMode==='shuffle','shuffle contract lost')
 input(search,'');await pause(500)
 const scroll=document.querySelector('.song-list');scroll.dispatchEvent(new PointerEvent('pointermove',{bubbles:true}));scroll.scrollTop=1400;scroll.dispatchEvent(new Event('scroll'));await pause(150)
 await wait(()=>document.querySelector('.te-scroll-companion'),'current-playing locator unavailable')
 document.querySelector('.te-scroll-companion').click();await wait(()=>[...document.querySelectorAll('.track-playing')].some(r=>r.textContent.includes('0720')),'locator did not reveal playing song')
 document.querySelector('#artist-tab-overview').click();await window.artistReady()
 const disclosure=document.querySelector('.artist-manage-disclosure');disclosure.open=true
 await wait(()=>button('编辑介绍')&&!button('编辑介绍').disabled,'management unavailable')
 expect(writes.length===0,'opening management submitted a task')
 await click('编辑介绍');input(document.querySelector('textarea'),'这是保存后立即显示的手工介绍。');await click('保存介绍')
 await wait(()=>document.querySelector('.artist-biography-text')?.textContent.includes('立即显示'),'saved biography not echoed')
 await click('清空介绍');await click('确认清空');await wait(()=>document.querySelector('.artist-empty-copy')?.textContent.includes('已隐藏介绍'),'clear not echoed')
 await click('恢复自动');await click('确认恢复自动');await wait(()=>document.querySelector('.artist-biography-text')?.textContent.includes('周末乐队'),'reset not echoed')
 await click('隐藏资料图片');await click('确认隐藏');await wait(()=>document.querySelector('.artist-portrait-placeholder')?.textContent.includes('已隐藏'),'image hide not echoed')
 await click('恢复自动图片');await click('确认恢复自动图片');await wait(()=>document.querySelector('.artist-portrait img')?.naturalWidth>0,'image reset failed')
 await click('更新资料');await wait(()=>document.querySelectorAll('.artist-update-jobs li').length===2,'durable queue not displayed')
 expect(writes.filter(w=>w.name==='metadata.entity.enrich').length===2,'explicit update incorrect')
 jobs=jobs.map(j=>({...j,state:'completed'}));bump();await wait(()=>document.querySelector('.artist-update-jobs')?.textContent.includes('已完成'),'completed jobs missing')
 disclosure.open=false;document.querySelector('#artist-tab-participation').click()
 await wait(()=>document.querySelectorAll('.music-exploration select').length>=2,'participation filters missing')
 const selects=[...document.querySelectorAll('.music-exploration .filters select')];input(selects[1],'composer','change')
 await wait(()=>reads.some(r=>r.name==='exploration.participation'&&r.q.roles?.[0]==='composer'),'role filter not applied')
 input(selects[0],'catalog','change');await wait(()=>document.querySelector('.music-exploration')?.textContent.includes('仅浏览已缓存目录'),'cache scope not labeled')
 document.querySelector('.entity-link').click();await wait(()=>button('返回上一层'),'participation drilldown missing');await click('返回上一层')
 document.querySelector('#artist-tab-overview').click();await window.artistReady()
 denied=true;state.value={...state.value,settingsRevision:2};await wait(()=>!document.querySelector('.artist-biography-text')&&!document.querySelector('.artist-portrait img'),'revoked permission remained visible')
 denied=false;homonym=true;bump();await window.artistReady()
 expect(!document.querySelector('.artist-identity-entries')&&!document.body.textContent.includes('选择资料条目'),'overview still requires source selection')
 expect(document.querySelector('.artist-biography-text').textContent.includes('周末乐队'),'automatic profile did not use confirmed evidence')
 expect(document.querySelector('.artist-portrait img')?.naturalWidth>0,'automatic confirmed portrait missing')
 document.querySelector('#artist-tab-songs').click();await nextTick()
 document.querySelector('#artist-tab-identity').click()
 await wait(()=>document.querySelectorAll('.artist-identity-entries li').length===3&&document.querySelector('.identity-current'),'identity page not ready')
 expect(document.querySelector('.artist-identity-entries [aria-pressed="true"]').textContent.includes('晨光'),'confidence ranking selected the first unconfirmed member')
 const writesBeforeChoice=writes.length
 document.querySelectorAll('.artist-identity-entries button')[1].click()
 await wait(()=>document.querySelector('.current-source')?.textContent.includes('同名人物的另一首歌')&&document.querySelector('.identity-current'),'homonym selection not applied')
 expect(writes.length===writesBeforeChoice,'selecting a source confirmed identities without review')
 document.querySelector('#artist-tab-overview').click()
 await wait(()=>document.querySelector('.artist-biography-text')?.textContent.includes('另一位同名人物'),'selected homonym biography not displayed')
 document.querySelector('#artist-tab-identity').click()
 await wait(()=>document.querySelectorAll('.artist-identity-entries button').length===3,'identity entries missing on return')
 document.querySelectorAll('.artist-identity-entries button')[2].click()
 await wait(()=>document.querySelector('.current-source')?.textContent.includes('晨光')&&button('用于艺术家资料')&&!button('用于艺术家资料').disabled,'confirmed source not ready')
 await click('用于艺术家资料');await wait(()=>button('恢复自动选择'),'profile choice was not saved')
 expect(JSON.parse(localStorage.getItem('twilight-echo:artist-profile-choices:v1'))[0][1].entityId==='source-a','source choice not persisted')
 document.querySelector('[aria-label="返回艺术家列表"]').click()
 await wait(()=>document.querySelector('.artist-card img')?.naturalWidth>0,'saved artist portrait did not replace track cover on card')
 expect(document.querySelector('.artist-card img').src===portrait,'artist card is using album artwork')
 document.querySelector('.artist-card').click();await window.artistReady()
 document.querySelector('#artist-tab-identity').click();await wait(()=>document.querySelector('.artist-identity-page'),'identity page not restored')
 expect(button('恢复自动选择'),'return to artist lost saved profile')
 await click('恢复自动选择')
 await wait(()=>document.querySelector('.artist-identity-entries [aria-pressed="true"] em')?.textContent==='自动采用','automatic profile was not restored')
 document.querySelectorAll('.artist-identity-entries button')[0].click()
 await wait(()=>document.querySelector('.identity-current')?.textContent.includes('尚未确认')&&button('复核此候选'),'unresolved source cannot be reviewed')
 await click('复核此候选');await click('确认关联')
 await wait(()=>document.querySelector('.identity-current')?.textContent.includes('已确认')&&document.querySelector('.artist-identity-entries [aria-pressed="true"]')?.textContent.includes('身份已确认'),'manual identity confirmation did not refresh the page')
 expect(writes.filter(w=>w.name==='identification.decide').length===1,'confirmation was missing or replayed')
 homonym=false;document.querySelector('#artist-tab-overview').click();bump();await window.artistReady()
 homonym=false;fail=true;bump();await wait(()=>document.querySelector('.artist-inline-status')?.textContent.includes('读取失败'),'read failure not shown');fail=false
 await click('重试');await window.artistReady()
 expect(errors.length===0,errors.join(';'))
 return {queries:reads.length,writes:writes.length,plays:plays.length}
}
window.artistBackgroundTest=async()=>{
 // Mixed identities no longer block the profile; its separate identity page stays usable.
 homonym=true;confirmedC=false;missing=true;denied=false;fail=false;delay=0;override=null;bump()
 await window.artistReady()
 document.querySelector('#artist-tab-identity').click()
 await wait(()=>document.querySelector('.artist-identity-entries [aria-pressed="true"]'),'automatic identity page not ready')
 const choice=document.querySelector('.artist-identity-entries [aria-pressed="true"]')
 choice.focus()
 const photo=document.querySelector('.artist-portrait'),references=document.querySelector('.artist-identity-entries')
 const photoText=photo.textContent,choicesText=references.textContent,photoHeight=photo.getBoundingClientRect().height
 const catalogReads=()=>reads.filter(r=>r.name==='catalog.query').length
 const before=catalogReads()
 for(let i=0;i<12;i++){
  state.value={...state.value,entityMetadataRevision:state.value.entityMetadataRevision+1,sequence:i}
  await nextTick()
  expect(photo.textContent===photoText&&references.textContent===choicesText,'task progress changed unresolved content')
  expect(!choice.disabled&&document.activeElement===choice,'task progress interrupted source selection')
 }
 const taskOnlyCatalogReads=catalogReads()-before
 expect(taskOnlyCatalogReads===0,'task progress unnecessarily reloaded artist content')
 delay=80;bump();await nextTick()
 expect(photo.textContent===photoText&&!choice.disabled,'background content read flashed loading state')
 expect(photo.getBoundingClientRect().height===photoHeight,'background read shifted portrait frame')
 await pause(650);delay=0
 expect(photo.textContent===photoText&&document.activeElement===choice,'background read replaced focused choices')
 homonym=false;missing=false;document.querySelector('#artist-tab-overview').click();bump();await window.artistReady()
 await click('展开全文')
 const bio=document.querySelector('.artist-biography-text')
 delay=80;bump();await nextTick();await pause(650);delay=0
 expect(document.querySelector('.artist-biography-text')===bio&&!bio.classList.contains('collapsed'),'background refresh collapsed the biography')
 const disclosure=document.querySelector('.artist-manage-disclosure');disclosure.open=true
 await wait(()=>button('编辑介绍')&&!button('编辑介绍').disabled,'editor unavailable')
 await click('编辑介绍')
 const textarea=document.querySelector('textarea'),draft='正在输入的介绍，不应被后台补全打断。'
 input(textarea,draft);textarea.focus();textarea.setSelectionRange(4,9)
 const scroll=document.querySelector('.song-list'),scrollTop=scroll.scrollTop
 delay=80;bump();await nextTick();await pause(650);delay=0
 expect(document.querySelector('textarea')===textarea&&textarea.value===draft,'background metadata replaced the draft host or value')
 expect(document.activeElement===textarea&&textarea.selectionStart===4&&textarea.selectionEnd===9,'background metadata stole focus or text selection')
 expect(scroll.scrollTop===scrollTop,'background metadata moved the reader scroll position')
 await click('取消');disclosure.open=false
 expect(errors.length===0,errors.join(';'))
 return {taskOnlyCatalogReads,focusPreserved:true,draftPreserved:true}
}
window.artistCase=async(tone,variant='normal')=>{
 document.documentElement.dataset.theme=tone;missing=variant==='missing';broken=variant==='broken';homonym=false;denied=false
 portrait=variant==='logo'?squareLogo:defaultPortrait
 artist.value=variant==='long'?'这是一位名字特别长的艺术家与山海之间的回声 AC/DC':'周末乐队'
 category.value='artists';filter.value='artist:'+artist.value;bump();await nextTick()
 document.querySelector('#artist-tab-overview').click();await window.artistReady();await pause(160)
 const scroll=document.querySelector('.song-list');scroll.scrollTop=0;await pause(50)
 expect(document.body.scrollWidth<=innerWidth,'horizontal overflow')
 const hero=document.querySelector('.artist-hero-copy').getBoundingClientRect(),photo=document.querySelector('.artist-portrait').getBoundingClientRect()
 const narrow=scroll.clientWidth-64<900
 if(narrow)expect(hero.top>=photo.bottom-1,'narrow hero did not stack')
 else expect(hero.left<photo.left&&Math.abs(hero.top-photo.top)<2,'wide hero did not align')
 if(missing||broken)expect(document.querySelector('.artist-portrait-placeholder')&&!document.querySelector('.artist-portrait img'),'missing portrait used album art')
 else{
  await wait(()=>document.querySelector('.artist-portrait img')?.naturalWidth>0,'portrait did not decode')
  const image=document.querySelector('.artist-portrait img'),style=getComputedStyle(image)
  expect(style.objectFit==='contain'&&style.objectPosition==='50% 50%','artist portrait is cropped or off-center at '+innerWidth+'px ('+variant+')')
  const bitmap=image.getBoundingClientRect()
  expect(Math.abs(bitmap.width/bitmap.height-image.naturalWidth/image.naturalHeight)<0.01,'rounded image box does not follow the bitmap aspect ratio')
  expect(bitmap.width<=photo.width+1&&bitmap.height<=photo.height+1,'rounded portrait exceeds its stable frame')
  expect(Math.abs(bitmap.left+bitmap.width/2-photo.left-photo.width/2)<1&&Math.abs(bitmap.top+bitmap.height/2-photo.top-photo.height/2)<1,'rounded portrait is not centered')
  expect(['borderTopLeftRadius','borderTopRightRadius','borderBottomLeftRadius','borderBottomRightRadius'].every(key=>parseFloat(style[key])>0),'artist portrait is missing a rounded corner')
  if(variant==='logo')expect(image.naturalWidth===500&&image.naturalHeight===500,'square logo fixture missing')
 }
 expect(errors.length===0,errors.join(';'));return true
}
window.artistScrollTest=async()=>{
 document.documentElement.dataset.theme='dark';missing=false;broken=false;homonym=false;denied=false;fail=false
 artist.value='窄窗口导航测试';category.value='artists';filter.value='artist:'+artist.value;bump();await window.artistReady()
 await wait(()=>document.querySelector('#local-artist-title')?.textContent===artist.value,'narrow artist transition not ready');await pause(320)
 const scroll=document.querySelector('.song-list'),nav=document.querySelector('.artist-navigation-row')
 const top=nav.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop-scroll.clientTop
 scroll.scrollTop=top-24;scroll.dispatchEvent(new Event('scroll'));await pause(100)
 document.querySelector('#artist-tab-songs').click()
 await wait(()=>document.querySelectorAll('.track-row:not(.track-row-pending)').length>0,'narrow songs not ready');await pause(120)
 const visible=element=>{const rect=element.getBoundingClientRect(),box=scroll.getBoundingClientRect();return rect.top>=box.top&&rect.bottom<=box.bottom}
 expect(visible(nav),'tab change hid navigation behind the artist hero '+JSON.stringify({scrollTop:scroll.scrollTop,nav:nav.getBoundingClientRect().toJSON(),viewport:scroll.getBoundingClientRect().toJSON(),top}))
 const search=document.querySelector('.search-input');search.focus();input(search,'歌曲 007')
 await wait(()=>document.querySelectorAll('.track-row:not(.track-row-pending)').length===10,'narrow search wrong');await pause(120)
 expect(visible(nav)&&visible(search),'search hid controls behind the artist hero')
 expect(document.activeElement===search,'search lost keyboard focus')
 expect(getComputedStyle(document.querySelector('.artist-portrait img')).objectFit==='contain','narrow portrait is cropped')
 input(search,'');await pause(500)
 expect(errors.length===0,errors.join(';'));return true
}
window.artistAlbumsEvidence=async()=>{
 document.querySelector('#artist-tab-albums').click()
 await wait(()=>document.querySelectorAll('.artist-album-grid .local-album-card').length===12,'album evidence not ready')
 const scroll=document.querySelector('.song-list')
 scroll.scrollTop=document.querySelector('.artist-discography').offsetTop-16
 await pause(100)
 expect(document.body.scrollWidth<=innerWidth,'album grid horizontal overflow')
 return true
}
window.artistIdentityEvidence=async(tone,section)=>{
 document.documentElement.dataset.theme=tone
 homonym=true;confirmedC=false;missing=false;broken=false;denied=false;fail=false;override=null;artworkOverride=null
 artist.value='周末乐队';category.value='artists';filter.value='artist:'+artist.value;bump();await nextTick()
 document.querySelector('#artist-tab-overview').click();await window.artistReady();await pause(150)
 expect(!document.querySelector('.artist-identity-entries'),'identity picker leaked into overview')
 if(section==='identity'){
  document.querySelector('#artist-tab-identity').click()
  await wait(()=>document.querySelector('.identity-current')&&document.querySelectorAll('.artist-identity-entries li').length===3,'identity evidence not ready')
 }
 const scroll=document.querySelector('.song-list')
 scroll.scrollTop=section==='identity'?document.querySelector('.artist-navigation-row').offsetTop:0
 await pause(100)
 expect(document.body.scrollWidth<=innerWidth,'identity page overflow')
 return true
}
window.artistSourceEvidence=async(sample,tone)=>{
 portrait=sample.portrait;biography=sample.biography;attribution=sample.attribution
 biographyLanguage=sample.language??'und';artworkAttribution=sample.artworkAttribution??sample.attribution
 artworkReference=sample.targetRef??{provider:'ncm',kind:'artist',idType:'native',value:sample.attribution.externalId}
 usage={display:true,cache:true,crossSource:true,export:false}
 override=null;artworkOverride=null;missing=false;broken=false;homonym=false;denied=false;fail=false
 document.documentElement.dataset.theme=tone
 artist.value=sample.name;category.value='artists';filter.value='artist:'+sample.name
 bump();await window.artistReady()
 document.querySelector('#artist-tab-overview').click();await pause(180)
 document.querySelector('.song-list').scrollTop=0;await pause(60)
 expect(document.querySelector('.artist-portrait img')?.naturalWidth>0,'source portrait did not decode')
 expect(document.querySelector('.artist-biography-text')?.textContent.includes(sample.biography.slice(0,20)),'source biography missing')
 expect(document.querySelector('.artist-biography-attribution')?.textContent.includes('网易云音乐'),'source attribution missing')
 expect(!document.body.textContent.includes('CC BY-SA'),'invented an open license for platform data')
 expect(document.body.scrollWidth<=innerWidth,'source content overflow')
 return true
}
`

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs')
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}})
 win.webContents.on('paint',()=>{})
 try{
  await win.loadFile(path.join(directory,'index.html'))
  console.log('ARTIST_PAGE_OK',JSON.stringify(await win.webContents.executeJavaScript('window.artistTest()')))
  console.log('ARTIST_BACKGROUND_OK',JSON.stringify(await win.webContents.executeJavaScript('window.artistBackgroundTest()')))
  if(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR){
   fs.mkdirSync(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR,{recursive:true})
   for(const tone of ['pureWhite','dark'])for(const width of [1280,520])for(const section of ['overview','identity']){
    win.setContentSize(width,1000)
    await win.webContents.executeJavaScript('window.artistIdentityEvidence('+JSON.stringify(tone)+','+JSON.stringify(section)+')')
    fs.writeFileSync(path.join(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR,'auto-'+section+'-'+tone+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG())
   }
  }
  for(const tone of ['pureWhite','dark'])for(const width of [1280,900,520])for(const variant of ['normal','logo','long','missing','broken']){
   win.setContentSize(width,1000);await win.webContents.executeJavaScript('window.artistCase('+JSON.stringify(tone)+','+JSON.stringify(variant)+')')
   if(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR){
    fs.mkdirSync(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR,{recursive:true})
    fs.writeFileSync(path.join(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR,tone+'-'+width+'-'+variant+'.png'),(await win.webContents.capturePage()).toPNG())
    if(variant==='normal'){
     await win.webContents.executeJavaScript('window.artistAlbumsEvidence()')
     fs.writeFileSync(path.join(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR,tone+'-'+width+'-albums.png'),(await win.webContents.capturePage()).toPNG())
    }
   }
  }
  win.setContentSize(900,700);await win.webContents.executeJavaScript('window.artistScrollTest()')
  if(process.env.TWILIGHT_ARTIST_METADATA_SAMPLE&&process.env.TWILIGHT_ARTIST_EVIDENCE_DIR){
   const sample=JSON.parse(fs.readFileSync(process.env.TWILIGHT_ARTIST_METADATA_SAMPLE,'utf8'))
   for(const tone of ['pureWhite','dark'])for(const width of [1280,520]){
    win.setContentSize(width,1000)
    await win.webContents.executeJavaScript('window.artistSourceEvidence('+JSON.stringify(sample)+','+JSON.stringify(tone)+')')
    fs.writeFileSync(path.join(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR,'ncm-'+tone+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG())
   }
  }
  app.exit(0)
 }catch(e){
  console.error(e.stack)
  if(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR){fs.mkdirSync(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_ARTIST_EVIDENCE_DIR,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(-5000)'))}
  app.exit(1)
 }
})
`
