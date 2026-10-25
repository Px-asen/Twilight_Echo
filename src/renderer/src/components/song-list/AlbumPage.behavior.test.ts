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
  'local albums render, play, search and restore virtual scroll across themes and window sizes',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-album-ui-'))
    try {
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
              if (/\/stores\/usePlayerStore(?:\.ts)?$/.test(source)) return '\0album-player'
              return null
            },
            load(id) {
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
          )}<style>body{margin:0;font-family:'Microsoft YaHei',system-ui}#app{height:100vh}.song-list{height:100vh;padding-top:28px}button,input,select{font:inherit}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /ALBUM_UI_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runtime = `
import {createApp,h,ref,nextTick} from 'vue'
import {createPinia} from 'pinia'
import SongList from '@renderer/components/SongList.vue'
import {useMusicStore} from '@renderer/stores/useMusicStore.ts'
import {goBack} from '@renderer/app/useBackStack.ts'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
const pause = ms => new Promise(r => setTimeout(r,ms))
const expect = (ok,message) => {if(!ok) throw new Error(message)}
const png = color => {const c=document.createElement('canvas');c.width=c.height=320;const x=c.getContext('2d');const gradient=x.createLinearGradient(0,0,320,320);gradient.addColorStop(0,color);gradient.addColorStop(1,'#23324a');x.fillStyle=gradient;x.fillRect(0,0,320,320);x.strokeStyle='#ffffff66';x.lineWidth=2;for(let i=0;i<8;i++){x.beginPath();x.arc(160,160,25+i*15,0,Math.PI*2);x.stroke()}return c.toDataURL()}
const blue=png('#64a0d5'), green=png('#62ae95'), red=png('#cc7960')
const errors=[]
window.api={data:{loadPlaybackBookmarks:async()=>null},library:{getStorageMode:async()=>'json',onChanged:()=>()=>{}},providers:{list:async()=>[]}}
window.albumPlayer={currentTrack:ref(null),isPlaying:ref(false),plays:[],mode:'order',playTrack(t,q){window.albumPlayer.plays.push({track:t.id,count:q.length})},setPlayMode(mode){window.albumPlayer.mode=mode},playNextTrack(){},appendQueueTracks(){}}
const music=useMusicStore()
music.tracks.value=Array.from({length:6000},(_,i)=>({id:'track-'+i,title:i===0?'晨光':'Song '+i,artist:i===0?'周末乐队':'Artist '+i,album:i===0?'A 晨光与远方':i===1?'B 一张有着很长很长名称的专辑：那些跨过山海与时间的声音':i===2?'C 合辑 / Various Artists':String.fromCharCode(65+i%26)+' Album '+String(i).padStart(4,'0'),albumId:'album-'+i,filePath:'C:/Music/'+i+'/song.flac',fileName:'song.flac',duration:182,size:1,cover:i===3?null:i===4?'data:image/png;base64,broken':i%3===0?blue:i%3===1?green:red,releaseDate:i===3?undefined:i===2?'1998':i===1?'2019-08':'2020-05-12',genre:'Rock',lyrics:'[00:00]lyrics',source:'local'}))
music.tracks.value[1].artist='一位有着很长很长名字的歌手与远方的朋友们 / The Voices Across the Ocean'
music.tracks.value=[...music.tracks.value,{...music.tracks.value[0],id:'track-extra-0',filePath:'C:/Music/0/second.flac',title:'晚风'},{...music.tracks.value[2],id:'track-extra-2',filePath:'C:/Music/2/second.flac',artist:'另一位歌手'}]
music.refreshLibraryIndex()
const filter=ref(null)
const app=createApp({setup:()=>()=>h(SongList,{category:'albums',filter:filter.value,hasPlayer:false,transitionName:filter.value?'page-down':'page-up',onSelectView:(_category,next)=>filter.value=next,returnFromDetail:()=>{filter.value=null}})})
app.use(createPinia());app.config.errorHandler=e=>errors.push(String(e));app.mount('#app')
window.albumCase=async(tone,detail=false,albumIndex=0)=>{document.documentElement.dataset.theme=tone;filter.value=detail?'album:id:album-'+albumIndex:null;await nextTick();await pause(650);expect(errors.length===0,errors.join(';'));return document.body.scrollWidth<=innerWidth}
window.albumTest=async()=>{
 await window.albumCase('pureWhite')
 const cards=[...document.querySelectorAll('.local-album-card')]
 expect(cards.length>0&&cards.length<100,'grid was not virtualized: '+cards.length+' cards; grid children='+document.querySelector('.card-grid')?.children.length+'; scroll viewport='+document.querySelector('.song-list')?.clientHeight)
 expect(cards[0].textContent.includes('周末乐队'),'artist not shown')
 expect(cards[0].textContent.includes('2020年5月12日'),'date not shown')
 expect(cards.every(c=>Math.abs(c.getBoundingClientRect().height-cards[0].getBoundingClientRect().height)<1),'card metadata shifted row height')
 cards[0].focus();await window.albumKey('Enter');await pause(650)
 expect(document.querySelector('#local-album-title')?.textContent==='A 晨光与远方','native keyboard did not open album')
 expect(document.querySelector('.album-detail-header')?.textContent.includes('2020年5月12日'),'detail date absent')
 expect(getComputedStyle(document.querySelector('.album-detail-header')).getPropertyValue('--album-tint').trim().startsWith('#'),'art tint missing')
 document.querySelector('.album-play-primary').click();document.querySelector('.album-play-secondary').click()
 expect(window.albumPlayer.plays.length===2&&window.albumPlayer.plays.every(p=>p.count===2),'album playback queue incorrect')
 expect(window.albumPlayer.mode==='shuffle','shuffle action lost')
 expect(document.querySelector('.track-table-wrapper'),'track table absent')
 expect(goBack(),'title bar back handler absent');await pause(650)
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
 expect(document.querySelector('.album-detail-artist').textContent==='群星','compilation artist missing')
 expect(document.querySelector('.album-detail-release').textContent==='1998年','year precision lost')
 filter.value='album:id:album-3';await pause(650)
 const missingArtwork=document.querySelector('.album-artwork img')
 expect(missingArtwork?.complete&&missingArtwork.naturalWidth===1254,'missing album artwork must display the packaged music cover')
 expect(document.querySelector('.album-detail-release').textContent==='发行时间未知','unknown date missing')
 filter.value='album:id:album-4';await pause(650)
 const failedArtwork=document.querySelector('.album-artwork img')
 expect(failedArtwork?.complete&&failedArtwork.naturalWidth===1254,'failed album artwork must display the packaged music cover')
 filter.value=null;await pause(650)
 expect(errors.length===0,errors.join(';'))
 return 'ALBUM_UI_OK'
}
`

const runner = `
const {app,BrowserWindow,ipcMain}=require('electron');const path=require('node:path');const fs=require('node:fs');
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{
const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
ipcMain.handle('album:key',async(_event,key)=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:key});win.webContents.sendInputEvent({type:'char',keyCode:key==='Enter'?'\\r':' '});win.webContents.sendInputEvent({type:'keyUp',keyCode:key});await new Promise(r=>setTimeout(r,50))});
try {await win.loadFile(path.join(directory,'index.html'));await win.webContents.executeJavaScript("window.albumKey=key=>require('electron').ipcRenderer.invoke('album:key',key);void 0");console.log(await win.webContents.executeJavaScript('window.albumTest()'));
for(const tone of ['pureWhite','dark'])for(const width of [1280,900,520])for(const detail of [false,true]){
 win.setContentSize(width,900);const fits=await win.webContents.executeJavaScript('window.albumCase('+JSON.stringify(tone)+','+detail+')');if(!fits)throw new Error('overflow '+tone+' '+width);
 if(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR){fs.mkdirSync(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR,{recursive:true});const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR,tone+'-'+width+'-'+(detail?'detail':'grid')+'.png'),image.toPNG())}
}
win.setContentSize(520,900);
for(const tone of ['pureWhite','dark'])for(const index of [1,2,3,4]){
 const fits=await win.webContents.executeJavaScript('window.albumCase('+JSON.stringify(tone)+',true,'+index+')');if(!fits)throw new Error('edge-case overflow '+tone+' '+index);
 if(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR){const image=await win.webContents.capturePage();fs.writeFileSync(path.join(process.env.TWILIGHT_ALBUM_EVIDENCE_DIR,tone+'-520-album-'+index+'.png'),image.toPNG())}
}app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}
});`
