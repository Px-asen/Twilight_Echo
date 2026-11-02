import { createApp, defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import ExternalPlaylistImportDialog from './ExternalPlaylistImportDialog.vue'
import ImportedPlaylistDetail from './ImportedPlaylistDetail.vue'
import PlaylistLibraryPage from './navigation/PlaylistLibraryPage.vue'
import '../assets/base.css'
import '../assets/primeicons.css'

const pause=()=>new Promise(resolve=>setTimeout(resolve,30))
const settle=async()=>{await nextTick();await pause();await nextTick()}
const button=text=>{const found=[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text);expect(found,'button unavailable: '+text);return found}
const expect=(value,message)=>{if(!value)throw new Error(message)}
window.runExternalPlaylistImportTests=async screenshot=>{
  const imported=[]
  const songs=[{title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',duration:180},{title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',duration:180}]
  const importDocument={name:'夜间歌单',songs,source:{kind:'file',label:'mix.m3u8'},warnings:[],complete:true,total:2}
  // The migrated dialog speaks the Core imports protocol; answer it from the
  // same fixture document the old window.api.playlistImport stub provided.
  let importRevision=1
  const importPreview=()=>({id:'preview-1',revision:importRevision,name:importDocument.name,source:importDocument.source,reading:false,saving:false,complete:true,count:songs.length,total:importDocument.total,error:null,warnings:[],columnCount:0,playlistCount:1})
  const importPage=()=>({revision:importRevision,offset:0,total:songs.length,items:songs.map((original,index)=>({id:'entry-'+(index+1),original,track:null,resolution:null,state:'pending'}))})
  window.auditCore={
    state:{value:{versionsRevision:1}},status:{value:null},
    query:async name=>{
      if(name==='imports.preview')return importPreview()
      if(name==='imports.previewPage')return importPage()
      if(name==='imports.previewChoices')return {revision:importRevision,offset:0,total:0,items:[]}
      if(name==='playlists.view')return {viewId:'view-1',page:{revision:'view-revision',tracks:[{id:'local-1'},{id:'ncm:2'}]}}
      return null
    },
    command:async name=>{
      if(name==='imports.previewFile')return importPreview()
      if(name==='imports.previewConfigure'){importRevision++;return importPreview()}
      if(name==='imports.previewSave'){const id=window.auditMusic.createExternalPlaylist(importDocument,false);return{id}}
      return null
    }
  }
  window.auditMusic={
    playlists:shallowRef([]),tracks:ref([]),persistedWrites:0,playlistsRevision:ref(1),loadPlaylists:async()=>{},getPlaylistMembers(id){const playlist=this.playlists.value.find(item=>item.id===id);const entries=playlist&&playlist.imported?playlist.imported.entries:[];return{items:entries.map(entry=>({imported:entry})),total:entries.length}},
    createExternalPlaylist(document,transient=false){const id=`playlist-${imported.length+1}`;const playlist={id,name:document.name,trackIds:[],createdAt:'',...(transient?{transient:true}:{}),imported:{version:1,source:document.source,entries:document.songs.map((original,position)=>({entryId:`entry-${position+1}`,position,original,revision:0,resolution:{state:'pending'}})),generation:'generation',membershipRevision:0,complete:true}};this.playlists.value=[...this.playlists.value,playlist];if(!transient)this.persistedWrites++;imported.push({id,document,transient});return id},
    saveExternalPlaylist(id){const playlist=this.playlists.value.find(item=>item.id===id);delete playlist.transient;this.persistedWrites++;return id},discardExternalPlaylist(id){this.playlists.value=this.playlists.value.filter(item=>item.id!==id)},
    appendExternalPlaylistPage(){return true},setExternalPlaylistReadError(){return true},refreshExternalPlaylist(){return 'copy'},removeExternalEntries(){/* Entry editing is outside this import fixture. */},bindExternalEntry(){/* Source matching is stubbed by the resolved entries below. */},applyExternalResolutions(){return true}
  }
  window.api={
    playlistImport:{chooseFile:async()=>importDocument,readPage:async()=>({songs:[],total:0,nextOffset:0,hasMore:false}),cancelRead:async()=>true},
    library:{getStorageMode:async()=>'json',onChanged:()=>()=>{}},
    plugins:{onChanged:()=>()=>{}},
    fs:{isAudioFileAuthorized:async()=>true},
    core:{onMessage:()=>()=>{},onStatus:()=>()=>{}}
  }
  const show=ref(true),mounted=createApp(defineComponent({setup:()=>()=>h(ExternalPlaylistImportDialog,{show:show.value,onClose:()=>show.value=false,onImported:()=>{}})}))
  mounted.mount(document.body.appendChild(document.createElement('div')))
  await button('选择文件').click();await settle()
  document.querySelector('.file-choice').click();await settle()
  expect(document.body.textContent.includes('2 条'),'import preview should retain both repeated occurrences')
  expect(document.querySelectorAll('.preview ol li').length===2,'both occurrences should be visible in the preview')
  if(screenshot){window.__externalPlaylistPhase='preview';window.dispatchEvent(new CustomEvent('external-playlist-phase',{detail:'preview'}));await new Promise(resolve=>window.__resumeAfterImportPreview=resolve)}
  await button('保存到歌单').click();await settle()
  expect(imported.length===1&&imported[0].document.songs.length===2,'staged import must retain every occurrence; got '+JSON.stringify(imported.map(item=>({name:item.document.name,songs:item.document.songs.length,transient:item.transient}))))
  expect(!imported[0].transient&&window.auditMusic.persistedWrites===1,'the dialog save is the explicit commit in the Core flow')
  mounted.unmount();document.body.innerHTML=''

  const song={title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',duration:180},playCalls=[]
  const track={id:'local-1',title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',filePath:'D:/Music/1.flac',fileName:'1.flac',duration:180,size:1,cover:null,lyrics:null,source:'local'}
  window.auditProviderRegistry={list:()=>[],get:()=>undefined}
  const playlist={id:imported[0].id,name:'夜间歌单',trackIds:[],createdAt:'',imported:{counts:{local:1,streaming:1,missing:1},version:1,source:{kind:'file',label:'mix.m3u8'},complete:true,generation:'view-generation',membershipRevision:0,entries:[
    {entryId:'local-entry',position:0,original:song,resolution:{state:'local',track},revision:0},
    {entryId:'missing-entry',position:1,original:{title:'无法播放',artist:'未知歌手'},resolution:{state:'missing',message:'没有匹配到歌曲'},revision:0},
    {entryId:'remote-entry',position:2,original:{title:'青花瓷',artist:'周杰伦'},resolution:{state:'streaming',track:{...track,id:'ncm:2',source:'ncm',filePath:'ncm:2',fileName:'周杰伦 - 青花瓷',title:'青花瓷'}},revision:0}
  ]}}
  window.auditMusic.playlists.value=[playlist];window.auditMusic.tracks.value=[track]
  window.auditPlayer={playTrack:(item,queue)=>playCalls.push({item,queue}),playLibraryQuery:async(query,trackId)=>playCalls.push({query,trackId})}
  window.auditService={run(){/* Matching results are supplied by the fixture. */},stop(){/* No background matching is started. */},schedule(_source,action){return action()}}
  const detail=createApp(defineComponent({setup:()=>()=>h(ImportedPlaylistDetail,{playlistId:imported[0].id,onBack:()=>{},onNavigate:()=>{}})}))
  detail.mount(document.body.appendChild(document.createElement('div')));await new Promise(resolve=>setTimeout(resolve,320));await settle()
  const visibleRows=document.querySelectorAll('.song-row:not(.table-heading)')
  expect(visibleRows.length===3,`all imported occurrences should be displayed; got ${visibleRows.length}: ${document.querySelector('.external-detail')?.textContent.slice(0,600) || document.body.textContent.slice(0,600)}`)
  const unavailable=document.querySelector('.song-row.unavailable')
  expect(unavailable?.querySelector('.title-button')?.disabled&&unavailable.querySelector('.state')?.getAttribute('title')==='没有匹配到歌曲','unavailable entry must remain disabled and expose its reason')
  expect(!document.querySelector('.actions .primary')?.disabled,'play should stay available when at least one source resolved')
  visibleRows[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:140}));await settle()
  expect(document.querySelector('.match-dialog'),'right-clicking a song row should open source selection')
  document.querySelector('.match-dialog [aria-label="关闭选源"]').click();await settle()
  if(screenshot)document.body.setAttribute('data-capture-preview','imported-detail')
  if(screenshot)document.body.setAttribute('data-capture-staged','true')
  button('▶ 播放可用歌曲').click();await settle()
  expect(playCalls.length===1,'play should start once from the detail page')
  expect(playCalls[0].query.playlistView==='view-1'&&playCalls[0].query.contentRevision==='view-revision','playback must go through the Core playlist view')
  expect(playCalls[0].trackId==='local-1','the Core view starts playback at the first playable occurrence, excluding unavailable entries')
  detail.unmount();document.body.innerHTML=''

  const catalogEvents=[]
  window.auditMusic.getPlaylistTracksById=()=>[]
  window.auditMusic.createPlaylist=()=> 'new-playlist'
  window.auditMusic.setPlaylistPinned=()=>true
  window.auditMusic.deletePlaylist=()=>true
  window.auditMusic.createAggregatePlaylist=()=> 'new-aggregate'
  window.auditMusic.addTracksToPlaylistById=()=>0
  window.auditMusic.playlists.value=[
    {id:'regular',name:'应用歌单',trackIds:[],createdAt:''},
    {id:'aggregate',name:'聚合歌单',trackIds:[],createdAt:'',kind:'aggregate'},
    {id:'staged',name:'暂存歌单',trackIds:[],createdAt:'',transient:true,imported:{source:{label:'文件'},entries:[{entryId:'one'}]}}
  ]
  const catalog=createApp(defineComponent({setup:()=>()=>h(PlaylistLibraryPage,{onSelectView:(...event)=>catalogEvents.push(event),onImportExternal:()=>catalogEvents.push(['import'])})}))
  catalog.mount(document.body.appendChild(document.createElement('div')));await settle()
  expect(document.querySelector('.library-header h1')?.textContent==='歌单'&&!document.querySelector('.library-header p'),'playlist header should show only the title without a description')
  expect(document.querySelectorAll('.playlist-card').length===3,'application, aggregate and staged playlists should share one catalogue')
  document.querySelector('[aria-label="打开聚合歌单"]').click();await settle()
  expect(JSON.stringify(catalogEvents.at(-1))===JSON.stringify(['aggregate','aggregate']),'aggregate card should retain aggregate detail navigation')
  document.querySelector('[aria-label="打开暂存歌单"]').click();await settle()
  expect(JSON.stringify(catalogEvents.at(-1))===JSON.stringify(['playlists','external-playlist:staged']),'staged external card should reopen its detail page')
  button('导入外部歌单').click();await settle()
  expect(catalogEvents.some(event=>event[0]==='import'),'the unified catalogue should retain the external import entry point')
  if(screenshot)document.body.setAttribute('data-capture-preview','unified-playlist-catalogue')
  if(!screenshot)catalog.unmount()
  return {previewOccurrences:2,detailRows:3,playableQueue:playCalls[0].query.playlistView==='view-1'?2:0,imported:imported.length,stagedUntilSaved:false,rightClickSourceSelection:true,unifiedPlaylistCards:3}
}
