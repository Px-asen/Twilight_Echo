import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('homepage playback and return geometry remain stable across routes and motion modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-home-transport-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'fixtures.ts'), fixtures)
    const appSource = await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8')
    const appDescriptor = parse(appSource).descriptor
    const template = appDescriptor.template!.content
    const mainTag = template.match(/<div\s+class="main-content"[\s\S]*?>/)![0]
    const localTransition = template.match(/<Transition\s+:name=[\s\S]*?<\/Transition>/)![0]
    const sidebarVisibility = appSource.slice(
      appSource.indexOf('const showLocalSidebar = computed('),
      appSource.indexOf('const sideMenuActiveKey')
    )
    await writeFile(
      join(directory, 'NavigationFixture.vue'),
      `<script setup>
import {computed,defineComponent,h,ref} from 'vue'
import {useAppNavigation} from '@renderer/app/useAppNavigation.ts'
import LocalDashboard from '@renderer/components/local-dashboard/LocalHome.vue'
const navigation=useAppNavigation()
window.homeNavigation=navigation
const {menuOpen,pageTarget,localViewVisible,activeCategory,activeFilter,songlistTransitionName,
 showPlayingPage,showPluginPage,showDspRackPage,showRadioPodcastPage,showLoginPage,
 showSettingsPage,showAppearancePage,showThemeStudioPage,showEqualizerPage,onSelectView}=navigation
const appearanceFullWindowPreview=ref(false)
${sidebarVisibility}
const hasPlayerBar=ref(false), mainContentMinHeight='100vh'
const SongList=defineComponent({render:()=>h('article',{class:'list-fixture'},'Music library')})
const ApplicationPlaylistsPage=SongList, ListeningAnalyticsPage=SongList
const openSettingsPage=()=>{}, enterStreamingMode=()=>{}, handleStreamingLogin=()=>{}
</script><template>${mainTag}${localTransition}</div></template>`
    )
    const baseStyles = await readFile(join(workspace, 'src/renderer/src/assets/base.css'), 'utf8')
    const appStyles = appDescriptor.styles.map((style) => style.content).join('\n')
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [
        vue(),
        {
          name: 'home-transport-test-stores',
          load(id) {
            if (id === '\0home-transport-child-stub')
              return 'import {h} from "vue"; export default { render: () => h("div", {"data-child-stub": ""}) }'
            return null
          }
        }
      ],
      resolve: {
        alias: [
          {
            find: /^(?:(?:\.\.\/)+stores\/use(?:Music|Player|ListeningStats|AudioOutputDsp)Store|@renderer\/stores\/use(?:Music|Theme|Player|ListeningStats|AudioOutputDsp)Store|\.\.\/utils\/unifiedRecentTracks|pinia)$/,
            replacement: join(directory, 'fixtures.ts')
          },
          {
            find: /^\.\/(?:OnlineDashboard|ArchiveDashboard|NightHarborDashboard|SoundFieldDashboard)\.vue$/,
            replacement: '\0home-transport-child-stub'
          },
          {
            find: /^@renderer\/components\/local-dashboard\/(?:Archive|NightHarbor|SoundField)Dashboard\.vue$/,
            replacement: '\0home-transport-child-stub'
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') },
          {
            find: 'primeicons/primeicons.css',
            replacement: require.resolve('primeicons/primeicons.css')
          }
        ]
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'HomeTransportTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>${baseStyles}\n${appStyles}\nbody{margin:0;background:var(--te-bg-primary,#f8f9fc)}#app{height:100vh}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), electronRunner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /HOME_TRANSPORT_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const electronRunner = `const {app,BrowserWindow}=require('electron')
app.setPath('userData',require('node:path').join(__dirname,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)})
 try{
  await win.loadFile(process.argv.at(-1))
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});win.webContents.focus()
  await win.webContents.executeJavaScript('window.runHomeTransportTests()')
  console.log('HOME_TRANSPORT_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`

const fixtures = `import {ref} from 'vue'
const first={id:'one',title:'First',artist:'Artist',album:'Album',duration:100,path:'first.flac'}
const last={id:'two',title:'Last played',artist:'Artist',album:'Album',duration:100,path:'last.flac'}
export const state={tracks:ref([first,last]),recent:ref(last),currentTrack:ref(null),isPlaying:ref(false),calls:[]}
const player={currentTrack:state.currentTrack,isPlaying:state.isPlaying,dominantColor:ref('#aabbcc'),
 currentTime:ref(0),duration:ref(100),progress:ref(0),seek(){},formatTime:seconds=>String(seconds),
 playTrack(track,queue){state.calls.push(['start',track.id,queue.map(item=>item.id)]);state.currentTrack.value=track;state.isPlaying.value=true},
 togglePlay(){state.calls.push(['toggle']);state.isPlaying.value=!state.isPlaying.value},
 next(){state.calls.push(['next'])},prev(){state.calls.push(['previous'])},setPlayMode(mode){state.calls.push(['mode',mode])}}
export const useMusicStore=()=>({tracks:state.tracks,albums:ref([]),artists:ref([])})
export const useThemeStore=()=>({presetLayout:ref('default')})
export const usePlayerStore=()=>player
export const useListeningStatsStore=()=>({listeningStats:ref({days:{}})})
export const getMostListenedTracks=()=>[]
export const getRecentTracks=()=>state.recent.value?[{id:state.recent.value.id,track:state.recent.value}]:[]
export const waitForListeningStatsReady=async()=>{}
export const createUnifiedRecentTrackResolver=tracks=>stat=>tracks.find(track=>track.id===stat.id)||stat.track
export const useAudioOutputDspStore=()=>({audioProcessing:ref({dspEnabled:false}),playbackInfo:ref(null),outputInfo:ref(null)})
export const storeToRefs=store=>store
`

const runtime = `import {createApp,h,nextTick} from 'vue'
import LocalDashboard from '@renderer/components/LocalDashboard.vue'
import NavigationFixture from './NavigationFixture.vue'
import {state} from './fixtures.ts'
window.api={audioEngine:{getDspGraphStatus:async()=>null,getDspSceneState:async()=>null},library:{getStorageMode:async()=>'json',onChanged:()=>()=>{}}}
const expect=(value,message)=>{if(!value)throw new Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,50))}
const app=createApp({render:()=>h(LocalDashboard)})
app.mount('#app')
const controls=()=>[...document.querySelectorAll('.hero-actions button')]
const play=()=>document.querySelector('.transport-play')
window.runHomeTransportTests=async()=>{
 await settle()
 for(let tick=0;tick<30&&!document.querySelector('.fresh-cover img')?.naturalWidth;tick++)await settle()
 const fallback=document.querySelector('.fresh-cover img')
 expect(fallback?.naturalWidth===1254,'recent music is missing the bundled fallback artwork')
 expect(Math.abs(fallback.getBoundingClientRect().width-fallback.parentElement.getBoundingClientRect().width)<1,'fallback cover is cropped at its intrinsic size')
 expect(controls().length===1,'fresh launch must show its regular play control')
 expect(play()?.getAttribute('aria-label')==='开始收听'&&play().querySelector('[data-playback-icon="play"]'),'idle control must have the visible play glyph and matching accessible label')
 expect(play().getBoundingClientRect().width>0,'idle control must occupy visible space')
 expect(play().classList.contains('is-idle')&&play().textContent.includes('开始收听'),'fresh launch must show a labeled listening invitation')
 expect(!document.querySelector('.hero-actions')?.textContent.includes('播放这首'),'no duplicate text CTA')
 const cardHeight=()=>document.querySelector('.feature-card').getBoundingClientRect().height
 const idleHeight=cardHeight()
 expect(!document.querySelector('.hero-progress'),'idle card must not expose a seek control')
 const routeTrigger=document.querySelector('[aria-label="打开实时 DSP 输出线路"]')
 routeTrigger.focus();routeTrigger.click();await settle()
 const routeDialog=document.querySelector('.dsp-route-dialog')
 for(let tick=0;tick<30&&!routeDialog?.contains(document.activeElement);tick++)await new Promise(resolve=>setTimeout(resolve,50))
 expect(routeDialog?.contains(document.activeElement),'DSP modal must take keyboard focus: '+document.activeElement?.outerHTML.slice(0,300))
 const dialogButtons=[...routeDialog.querySelectorAll('button:not(:disabled)')]
 dialogButtons.at(-1).focus()
 dialogButtons.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))
 expect(routeDialog.contains(document.activeElement)&&document.activeElement!==dialogButtons.at(-1),'DSP modal must wrap keyboard focus')
 document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
 await settle()
 expect(!document.querySelector('.home').classList.contains('has-route-dialog')&&document.activeElement===routeTrigger,'DSP modal closes on Escape and restores its trigger')
 play().click();await settle()
 expect(cardHeight()>=idleHeight,'playback progress must fit in the card')
 const playingHeight=cardHeight()
 expect(getComputedStyle(document.querySelector('.hero-progress')).visibility==='visible','active playback must reveal the real progress control')
 expect(document.querySelector('.hero-progress').getBoundingClientRect().bottom<=document.querySelector('.hero-actions').getBoundingClientRect().top,'progress returns above transport')
 expect(JSON.stringify(state.calls[0])===JSON.stringify(['start','two',['one','two']]),'idle control must play the displayed last track with its normal queue')
 expect(controls().length===3&&play().getAttribute('aria-label')==='暂停','starting a track must expose all three regular controls')
 expect(document.querySelector('.hero-actions').classList.contains('is-current')&&!play().classList.contains('is-idle'),'active controls must expose their session transport')
 expect(controls().every(button=>{const r=button.getBoundingClientRect();return r.width>=44&&r.height>=44}),'all transport controls must retain usable hit targets')
 play().click();await settle()
 expect(Math.abs(cardHeight()-playingHeight)<1,'pause must preserve the card height')
 expect(!state.isPlaying.value&&play().getAttribute('aria-label')==='播放','pause must keep an available resume control')
 expect(document.querySelector('.hero-actions').classList.contains('is-current')&&controls().length===3,'pause must retain the grouped transport without returning to the listening invitation')
 play().click();await settle()
 expect(Math.abs(cardHeight()-playingHeight)<1,'resume must preserve the card height')
 expect(state.isPlaying.value&&state.calls.filter(call=>call[0]==='start').length===1,'resume must not replace the queue')
 const originalTrack=state.currentTrack.value
 const originalLibrary=state.tracks.value
 state.tracks.value=[...originalLibrary,...Array.from({length:4},(_,i)=>({...originalTrack,id:'extra-'+i,title:'Music '+i}))]
 for(const font of [14,18])for(const density of ['comfortable','compact'])for(const width of [1100,680,480]){
  document.documentElement.style.setProperty('--te-font-size-body',font+'px')
  document.documentElement.dataset.teLibraryDensity=density
  document.querySelector('#app').style.width=width+'px'
  state.currentTrack.value={...originalTrack,title:'Short title'};await settle()
  const shortHeight=cardHeight()
  const title=document.querySelector('.hero-title'),artist=document.querySelector('.hero-artist')
  const lineHeight=parseFloat(getComputedStyle(title).lineHeight)
  expect(artist.getBoundingClientRect().top-title.getBoundingClientRect().bottom<14,'short title separates its artist at width '+width)
  const grid=document.querySelector('.fresh-grid'),tiles=[...grid.children],host=document.querySelector('.home-inner')
  const image=tiles[0].querySelector('img'),frame=tiles[0].querySelector('.fresh-cover')
  expect(image?.naturalWidth===1254&&Math.abs(image.getBoundingClientRect().width-frame.getBoundingClientRect().width)<1&&Math.abs(image.getBoundingClientRect().height-frame.getBoundingClientRect().height)<1,'fallback cover sizing broke at '+width+'px')
  const gridBox=grid.getBoundingClientRect()
  expect(tiles.length===6&&tiles.every(tile=>{const box=tile.getBoundingClientRect();return box.width>0&&box.left>=gridBox.left-1&&box.right<=gridBox.right+1}),'responsive music shelf must keep its cards in bounds at '+width+' '+density)
  expect(document.querySelector('.signal-card').getBoundingClientRect().bottom<gridBox.top,'signal card returns above recent music')
  expect(host.scrollWidth<=host.clientWidth+1,'homepage content overflows horizontally '+JSON.stringify({width,font,density,client:host.clientWidth,scroll:host.scrollWidth,children:[...host.children].map(el=>({class:el.className,right:el.getBoundingClientRect().right}))}))
  state.currentTrack.value={...originalTrack,title:'A Cielo Abierto (Viaje V) — A long musical journey across the evening sky',album:'A very long album title that must not displace the audio metadata or transport controls'};await settle()
  expect(title.scrollHeight>lineHeight*1.5,'long title must wrap at width '+width)
  expect(cardHeight()>=shortHeight,'wrapped title must fit inside the card at width '+width)
 }
 state.tracks.value=originalLibrary
 document.documentElement.style.removeProperty('--te-font-size-body')
 delete document.documentElement.dataset.teLibraryDensity
 document.querySelector('#app').style.width=''
 state.currentTrack.value=originalTrack;await settle()
 controls()[0].click();controls()[2].click()
 expect(state.calls.at(-2)[0]==='previous'&&state.calls.at(-1)[0]==='next','skip controls retain their actions')
 state.currentTrack.value=null;state.isPlaying.value=false;state.recent.value=null;await settle()
 expect(controls().length===1,'no history must still expose playback for the first library track')
 play().click();await settle()
 expect(state.calls.at(-1)[1]==='one','no-history play must select the displayed first track')
 state.currentTrack.value=null;state.isPlaying.value=false
 state.recent.value={id:'outside',title:'Outside library',artist:'Artist',duration:100};await settle()
 play().click();await settle()
 expect(JSON.stringify(state.calls.at(-1))===JSON.stringify(['start','outside',['outside']]),'available history outside the library must use a single-track queue')
 state.currentTrack.value=null;state.isPlaying.value=false;state.recent.value=null;state.tracks.value=[];await settle()
 expect(!play()&&document.querySelector('.empty-cta'),'empty library must show import instead of an unusable play control')
 app.unmount()
 await runHomeReturnTests()
}
const frame=()=>new Promise(requestAnimationFrame)
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const until=async(predicate)=>{for(let i=0;i<150;i++){if(predicate())return;await sleep(10)}throw Error('homepage did not settle: '+document.querySelector('#app').innerHTML.slice(0,900))}
async function runHomeReturnTests(){
 state.tracks.value=[{id:'one',title:'First',artist:'Artist',album:'Album',duration:100}]
 const routeApp=createApp(NavigationFixture);routeApp.mount('#app')
 const navigation=window.homeNavigation
 navigation.menuOpen.value=true
 await until(()=>document.querySelector('.feature-card'))
 await sleep(400)
 const measure=()=>{const el=document.querySelector('.feature-card');if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}}
 const returns=[
  ['library',()=>navigation.onSelectView('allSongs',null),()=>navigation.selectSidebarPage({kind:'local',category:'dashboard',filter:null})],
  ['recent',()=>navigation.navigate({kind:'recent',scope:'device'}),()=>navigation.goBackPage()],
  ['streaming',()=>navigation.enterStreamingMode(),()=>navigation.returnToLocalMode()],
  ['settings',()=>navigation.openSettingsPage(),()=>navigation.closeSettingsPage()],
  ['plugins',()=>navigation.openPluginPage(),()=>navigation.createTogglePluginHandler()()],
  ['player',()=>navigation.openPlayingPage(),()=>navigation.closePlayingPage()]
 ]
 for(const tone of ['light','dark'])for(const motion of ['full','reduced','off']){
  document.documentElement.dataset.theme=tone
  document.documentElement.dataset.teMotion=motion
  for(const [name,leave,back] of returns){
   const before=measure();leave();await nextTick();await until(()=>!document.querySelector('.feature-card'))
   expect(!document.querySelector('.feature-card'),'home must leave for '+name)
   back();await nextTick()
   const samples=[]
   for(let i=0;i<40;i++){const sample=measure();if(sample)samples.push(sample);await frame()}
   expect(samples.length>5,'homepage did not reappear '+name)
   const final=measure()
   for(const sample of samples)for(const axis of ['x','y','width','height'])
    expect(Math.abs(sample[axis]-final[axis])<0.75,'home return moved '+axis+' from '+name+' in '+tone+'/'+motion+': '+JSON.stringify({sample,final}))
   expect(Math.abs(before.x-final.x)<0.75&&Math.abs(before.width-final.width)<0.75,'return changed the settled sidebar clearance '+name)
   expect(play()?.getBoundingClientRect().width>0,'return lost the play control '+name)
  }
 }
 // Explicit sidebar toggles still animate, unlike restoration of a hidden sidebar.
 document.documentElement.dataset.teMotion='full'
 navigation.menuOpen.value=false;await nextTick();await frame()
 expect(document.querySelector('.main-content').getAnimations().some(a=>a.transitionProperty==='padding-left'),'manual sidebar toggle lost its transition')
 await sleep(350)
 routeApp.unmount()
}
`
