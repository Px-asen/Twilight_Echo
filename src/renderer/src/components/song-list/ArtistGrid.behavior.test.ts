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
  'artist grid reuses loaded portraits and opens individual collaboration artists with complete songs',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-artist-grid-'))
    try {
      await writeFile(join(directory, 'entry.mjs'), runtime)
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'artist-grid-fixture',
            enforce: 'pre',
            resolveId(source) {
              if (/(?:^|\/)coreConnection(?:\.ts)?$/.test(source)) return '\0grid-core'
              if (/(?:^|\/)useSettingsStore(?:\.ts)?$/.test(source)) return '\0grid-settings'
              if (/(?:^|\/)usePlayerStore(?:\.ts)?$/.test(source)) return '\0grid-player'
              return null
            },
            load(id) {
              if (id === '\0grid-core') return 'export const useCoreConnection=()=>window.gridCore'
              if (id === '\0grid-settings')
                return 'export const useSettingsStore=()=>window.gridSettings'
              if (id === '\0grid-player') return 'export const usePlayerStore=()=>window.gridPlayer'
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
            name: 'ArtistGridTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">${files
          .filter((f) => f.endsWith('.css'))
          .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
          .join(
            ''
          )}<style>body{margin:0;font-family:system-ui}#app{height:100vh}.song-list{height:100vh;padding-top:28px}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', join(directory, 'runner.cjs')],
        {
          windowsHide: true,
          timeout: 45_000,
          env,
          maxBuffer: 1024 * 1024
        }
      )
      assert.match(result.stdout, /ARTIST_GRID_OK/)
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
import TrackArtistLinks from '@renderer/components/TrackArtistLinks.vue'
import {buildDerivedCollections} from '@renderer/stores/library/derivedCollections.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
import '@phosphor-icons/web/regular'
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const expect=(ok,message)=>{if(!ok)throw Error(message)}
const wait=async(check,message)=>{for(let i=0;i<100;i++){if(check())return;await pause(30)}throw Error(message)}
const canvas=document.createElement('canvas');canvas.width=canvas.height=180
const paint=canvas.getContext('2d');paint.fillStyle='#425666';paint.fillRect(0,0,180,180)
paint.fillStyle='#c2cfca';paint.beginPath();paint.ellipse(90,64,29,34,0,0,Math.PI*2);paint.fill()
paint.fillStyle='#91a9a0';paint.beginPath();paint.ellipse(90,164,63,60,0,0,Math.PI*2);paint.fill()
const portrait=canvas.toDataURL()
const songCanvas=document.createElement('canvas');songCanvas.width=songCanvas.height=240
const songPaint=songCanvas.getContext('2d');songPaint.fillStyle='#173f4b';songPaint.fillRect(0,0,240,240)
songPaint.fillStyle='#e7a15e';songPaint.beginPath();songPaint.arc(120,120,78,0,Math.PI*2);songPaint.fill()
songPaint.strokeStyle='#fff0d3';songPaint.lineWidth=3;for(let i=0;i<7;i++){songPaint.beginPath();songPaint.moveTo(30,55+i*23);songPaint.lineTo(210,30+i*23);songPaint.stroke()}
const songCover=songCanvas.toDataURL()
let artists=Array.from({length:600},(_,i)=>({id:'artist-'+i,name:'Artist '+String(i).padStart(3,'0'),trackCount:1,cover:null}))
let collaborationTracks=null
const category=ref('artists'),filter=ref(null),plays=[]
const members=name=>name?artists.find(artist=>artist.name===name)?.tracks??[]:collaborationTracks??[]
const state=shallowRef({phase:'ready',epoch:'grid',libraryRevision:1,catalogRevision:1,entityMetadataRevision:1,entityMetadataContentRevision:1,settingsRevision:1,playlistsRevision:1,versionsRevision:1,statisticsRevision:1,bookmarksRevision:1,pluginsRevision:1})
let delay=150,metadataReads=0,coverReads=0,withdrawn=false,brokenArtist=null,hiddenArtist=null
const errors=[]
window.api={data:{getCover:async()=>{coverReads++;await pause(delay);return portrait}},providers:{list:async()=>[]}}
window.gridSettings={settings:shallowRef({musicIdentification:{language:'zh-Hans'},libraryFolders:[],genreSeparators:';',trackActivationMode:'doubleClick'})}
window.gridPlayer={currentTrack:ref(null),isPlaying:ref(false),playTrack(){},setPlayMode(){},playNextTrack(){},appendQueueTracks(){},playLibraryQuery:async query=>{plays.push(query)}}
window.gridCore={state,attach:async()=>{},subscribe:()=>()=>{},command:async()=>{throw Error('Unexpected write')},query:async(name,q={},signal)=>{
 if(name==='library.metadata')return {revision:1,trackCount:600,folders:[],exclusions:[]}
 if(name==='playlists.state')return {revision:1,persistence:{state:'idle',dirty:false}}
 if(name==='playlists.catalog'||name==='statistics.tracks'||name==='bookmarks.page')return {revision:1,offset:0,total:0,items:[]}
 if(name==='statistics.overview')return {revision:1,days:{},artists:[],history:{mode:'sqlite',ready:true,pending:false,revision:1,error:null},persistence:{dirty:false,error:null}}
 if(name==='bookmarks.state')return {revision:1,longTrackResumeSeconds:1200}
 if(name==='providers.list')return []
 if(name==='library.collections'){
  const query=q.query,items=q.kind==='albums'?buildDerivedCollections(members(query.artist),[],'').albums:artists
  return {revision:state.value.libraryRevision,offset:query.offset??0,total:items.length,letterOffsets:{A:0},items:items.slice(query.offset??0,(query.offset??0)+(query.limit??200))}
 }
 if(name==='library.tracks'){
  const tracks=members(q.artist)
  return {revision:state.value.libraryRevision,offset:q.offset??0,total:tracks.length,tracks:tracks.slice(q.offset??0,(q.offset??0)+(q.limit??200))}
 }
 if(name==='library.artwork')return {revision:state.value.libraryRevision,items:[]}
 if(name==='catalog.sources')return {revision:1,offset:0,total:1,items:[{track:members(q.entityId)[0]}]}
 if(name==='identification.detail')return {entityId:q.entityId,kind:'artist',references:[],link:null}
 if(name==='catalog.query'){
  metadataReads++;await pause(delay);signal?.throwIfAborted()
  return {revision:state.value.catalogRevision,offset:0,total:1,items:[{id:q.artistName,kind:'artist',title:q.artistName,artist:'',identity:'source',sourceCount:1}]}
 }
 if(name==='metadata.entity.detail'){
  await pause(delay);signal?.throwIfAborted()
  return {entityId:q.entityId,targetId:q.entityId,revision:state.value.entityMetadataRevision,name:q.entityId,link:{state:'confirmed',revision:1,mbid:''},introduction:null,override:null,artworkOverride:q.entityId===hiddenArtist?{mode:'clear'}:null,facts:[],artwork:withdrawn?[]:[{scope:'artist',handle:q.entityId===brokenArtist?'data:image/png;base64,invalid':'cover://'+q.entityId.replaceAll(' ','-')+'.png',targetRef:{provider:'musicbrainz',kind:'artist',idType:'mbid',value:q.entityId},usage:{display:true,cache:true,crossSource:true,export:true},attribution:{provider:'commons',externalId:q.entityId,url:'https://commons.wikimedia.org/wiki/File:Artist.jpg',license:'CC-BY-SA-4.0',attribution:'测试插画',revision:'1',retrievedAt:1}}]}
 }
 throw Error('Unexpected query '+name)
}}
const app=createApp({render:()=>h(SongList,{category:category.value,filter:filter.value,hasPlayer:false,transitionName:'page-up',onSelectView:(c,f)=>{category.value=c;filter.value=f}})})
app.use(createPinia());app.config.errorHandler=e=>errors.push(e.stack||String(e));app.mount('#app')
const contentUpdates=setInterval(()=>{state.value={...state.value,entityMetadataContentRevision:state.value.entityMetadataContentRevision+1}},40)
const cards=()=>[...document.querySelectorAll('.artist-card')]
const container=()=>document.querySelector('.song-list')
const rendered=()=>cards().length>0&&cards().every(c=>c.querySelector('img.artist-cover')?.complete&&c.querySelector('img.artist-cover').naturalWidth>0)
const scroll=async(top)=>{container().scrollTop=top;container().dispatchEvent(new Event('scroll'));await nextTick();await nextTick();await new Promise(requestAnimationFrame)}
window.gridTest=async()=>{
 try{await wait(rendered,'initial portraits starved during background metadata commits: '+errors.join(';'))}
 finally{clearInterval(contentUpdates)}
 await pause(400);delay=25
 const initial=cards().map(c=>c.dataset.collectionIndex)
 expect(cards().length<100,'artist grid lost virtualization')
 for(const top of [800,1600,2400,3200]){await scroll(top);await pause(180);await wait(rendered,'downward portraits did not load')}
 expect(!cards().some(c=>initial.includes(c.dataset.collectionIndex)),'scroll did not unmount initial cards')
 const before={metadataReads,coverReads};delay=300
 for(const top of [1600,0,2400,800,0]){
  await scroll(top)
  for(let frame=0;frame<6;frame++){
   expect(rendered(),'loaded artist portrait flashed or became blank on reverse scroll')
   await new Promise(requestAnimationFrame)
  }
 }
 expect(metadataReads===before.metadataReads,'reverse scroll queried loaded artist metadata again')
 expect(coverReads===before.coverReads,'reverse scroll materialized loaded portraits again')
 await wait(rendered,'returned portraits failed to decode')
 const images=cards().map(c=>c.querySelector('img.artist-cover'))
 state.value={...state.value,entityMetadataRevision:2}
 await pause(80)
 expect(cards().every((c,i)=>c.querySelector('img.artist-cover')===images[i]),'background revision blanked unchanged photos')
 await pause(650)
 expect(cards().every((c,i)=>c.querySelector('img.artist-cover')===images[i]),'unchanged metadata remounted all images')
 expect(errors.length===0,errors.join(';'))
}
window.gridWithdraw=async()=>{
 withdrawn=true;state.value={...state.value,settingsRevision:2};await nextTick()
 expect(cards().every(c=>!c.querySelector('img.artist-cover')),'permission change kept cached photos visible')
 await pause(650)
 await scroll(2400);await pause(650);await scroll(0);await pause(650)
 expect(cards().every(c=>!c.querySelector('img.artist-cover')),'revoked photo returned from the old cache')
 expect(errors.length===0,errors.join(';'))
}
window.gridCollaborations=async()=>{
 delay=0
 const track=(id,artist,extra={})=>({id,title:id,artist,album:'Collaboration',filePath:'D:/Music/'+id+'.flac',fileName:id+'.flac',source:'local',duration:180,size:1,cover:songCover,lyrics:null,...extra})
 const joined='40mP/かぐや(cv.夏吉ゆうこ)'
 const ampersand='打打だいず & Ashrount'
 collaborationTracks=[track('Solo','*Luna'),track('Duet','*Luna/初音ミク'),track('Tagged duet',joined,{artists:[{name:joined}],identityTags:{version:1,scope:'audio_file',artists:{value:[joined],origin:'audio_tag'}}}),...['Ampersand one','Ampersand two','Ampersand three'].map(id=>track(id,ampersand,{artists:[{name:ampersand}],identityTags:{version:1,scope:'audio_file',artists:{value:[ampersand],origin:'audio_tag'}}}))]
 artists=buildDerivedCollections(collaborationTracks,[],'').artists
 state.value={...state.value,libraryRevision:2,catalogRevision:2}
 await wait(()=>cards().length===6&&cards().some(c=>c.querySelector('.artist-name')?.textContent==='打打だいず'),'individual artist cards did not render')
 for(const [name,count] of [['*Luna',2],['初音ミク',1],['40mP',1],['かぐや(cv.夏吉ゆうこ)',1],['打打だいず',3],['Ashrount',3]]){
  const card=cards().find(c=>c.querySelector('.artist-name').textContent===name)
  expect(card?.querySelector('.artist-count').textContent===count+' 首','wrong collaboration count for '+name)
 }
 await wait(rendered,'song covers did not replace unidentified portraits')
 expect(cards().every(c=>c.querySelector('img.artist-cover').src===songCover),'artist card did not use its own song cover')
 expect(!document.querySelector('.artist-card .artist-image-credit'),'song covers were attributed as artist portraits')
 expect(errors.length===0,errors.join(';'))
}
window.gridCollaborationDetails=async()=>{
 for(const [name,titles] of [['*Luna',['Solo','Duet']],['初音ミク',['Duet']],['40mP',['Tagged duet']],['かぐや(cv.夏吉ゆうこ)',['Tagged duet']],['打打だいず',['Ampersand one','Ampersand two','Ampersand three']],['Ashrount',['Ampersand one','Ampersand two','Ampersand three']]]){
  cards().find(c=>c.querySelector('.artist-name').textContent===name).click()
  await wait(()=>document.querySelector('#local-artist-title')?.textContent===name&&!document.querySelector('.artist-play-primary')?.disabled,'artist detail did not open for '+name)
  expect(document.querySelector('.artist-library-stats').textContent.includes(titles.length+' 首歌曲'),'wrong detail count for '+name)
  document.querySelector('.artist-play-primary').click();await nextTick()
  expect(plays.at(-1)?.artist===name,'play all used a composite artist for '+name)
  document.querySelector('#artist-tab-songs').click()
  await wait(()=>document.querySelectorAll('.track-row:not(.track-row-pending) .track-title').length===titles.length,'wrong songs for '+name)
  const actual=[...document.querySelectorAll('.track-row .track-title')].map(t=>t.textContent.trim()).sort()
  expect(JSON.stringify(actual)===JSON.stringify([...titles].sort()),'collaborations missing from '+name)
  document.querySelector('.artist-back').click()
  await wait(()=>cards().filter(card=>!card.closest('[inert]')).length===6,'back to artist grid failed')
 }
 const host=document.createElement('div');document.body.append(host)
 const opened=[]
 const links=createApp({render:()=>h('div',collaborationTracks.slice(1,4).map(track=>h(TrackArtistLinks,{track,onOpenArtist:artist=>opened.push(artist.name)})))})
 links.mount(host)
 expect(JSON.stringify([...host.querySelectorAll('.artist-link')].map(link=>link.textContent.trim()))===JSON.stringify(['*Luna','初音ミク','40mP','かぐや(cv.夏吉ゆうこ)','打打だいず','Ashrount']),'artist links did not use individual credits')
 host.querySelectorAll('.artist-link')[1].click()
 expect(opened[0]==='初音ミク','artist link opened a composite name')
 links.unmount();host.remove()
 expect(errors.length===0,errors.join(';'))
}
window.gridArtworkFallbacks=async()=>{
 withdrawn=false;brokenArtist='打打だいず';hiddenArtist='Ashrount'
 state.value={...state.value,entityMetadataContentRevision:state.value.entityMetadataContentRevision+1}
 const card=name=>cards().find(c=>c.querySelector('.artist-name').textContent===name)
 await wait(()=>card('*Luna')?.querySelector('img.artist-cover')?.src===portrait,'recognized portrait did not replace song art')
 await wait(()=>card('打打だいず')?.querySelector('img.artist-cover')?.src===songCover,'broken portrait did not fall back to its song cover')
 expect(!card('Ashrount')?.querySelector('img.artist-cover'),'manual image hide was replaced by song artwork')
 expect(!card('打打だいず')?.querySelector('.artist-image-credit'),'fallback retained portrait attribution')
 await pause(150)
 expect(card('打打だいず')?.querySelector('img.artist-cover')?.src===songCover,'failed portraits entered a reload loop')
 expect(errors.length===0,errors.join(';'))
}
`

const runner = `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path')
app.setPath('userData',path.join(__dirname,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:false,contextIsolation:false,offscreen:true,backgroundThrottling:false}})
 try{
  await win.loadFile(path.join(__dirname,'index.html'))
  await win.webContents.executeJavaScript('window.gridTest()')
  if(process.env.TWILIGHT_ARTIST_GRID_EVIDENCE_DIR){fs.mkdirSync(process.env.TWILIGHT_ARTIST_GRID_EVIDENCE_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_ARTIST_GRID_EVIDENCE_DIR,'reverse-scroll.png'),(await win.webContents.capturePage()).toPNG())}
  await win.webContents.executeJavaScript('window.gridWithdraw()')
  await win.webContents.executeJavaScript('window.gridCollaborations()')
  if(process.env.TWILIGHT_ARTIST_GRID_EVIDENCE_DIR){
   for(const tone of ['pureWhite','dark']){
    await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(tone))
    await new Promise(resolve=>setTimeout(resolve,80))
    fs.writeFileSync(path.join(process.env.TWILIGHT_ARTIST_GRID_EVIDENCE_DIR,'collaborations-'+tone+'.png'),(await win.webContents.capturePage()).toPNG())
   }
  }
  await win.webContents.executeJavaScript('window.gridCollaborationDetails()')
  await win.webContents.executeJavaScript('window.gridArtworkFallbacks()')
  console.log('ARTIST_GRID_OK');app.exit(0)
 }catch(error){console.error(error.stack);console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(0,2000)'));app.exit(1)}
})
`
