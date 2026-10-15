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

test('listening journal keeps real statistics, bounded rankings, keyboard inspection and playback routing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-listening-journal-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'music.ts'), musicFixture)
    await writeFile(join(directory, 'player.ts'), playerFixture)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: [
          { find: '@renderer/stores/useMusicStore', replacement: join(directory, 'music.ts') },
          { find: '@renderer/stores/usePlayerStore', replacement: join(directory, 'player.ts') },
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
          name: 'JournalTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>html,body,#app{height:100%;margin:0}body{--te-neutral-900:#111827;--te-neutral-700:#374151;--te-neutral-500:#6b7280;--te-primary-500:#7c4dff;--te-card-bg:#fff;--te-card-border:#e5e7eb;--te-subtle-bg:#f3f4f6;font-family:system-ui}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1450,height:1000,webPreferences:{contextIsolation:false,backgroundThrottling:false}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runJournalTests()');console.log('JOURNAL_UI_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90_000 }
    )
    assert.match(result.stdout, /JOURNAL_UI_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const musicFixture = `import {shallowRef} from 'vue'
export const tracks=shallowRef([]),artists=shallowRef([])
export const useMusicStore=()=>({tracks,artists})
`
const playerFixture = `import {shallowRef} from 'vue'
export const currentTrack=shallowRef(null),calls=[]
export const usePlayerStore=()=>({currentTrack,playTrack:(track,queue)=>{calls.push({track,queue});currentTrack.value=track}})
`
const runtime = `import {createApp,h,nextTick,triggerRef} from 'vue'
import Page from '@renderer/components/ListeningAnalyticsPage.vue'
import {tracks,artists} from './music'
import {calls} from './player'
import {useListeningStatsStore,resetListeningStatsForTest,recordListeningForTest,waitForListeningStatsReady} from '@renderer/stores/useListeningStatsStore'
import {ListeningStatsDatabase} from '@renderer/stores/listeningStatsDatabase'
import {getUnifiedRecentResolverRebuildCount} from '@renderer/utils/unifiedRecentTracks'
const expect=(ok,message)=>{if(!ok)throw new Error(message)}
const tick=async()=>{await nextTick();await nextTick()}
const untilClosed=async()=>{const end=Date.now()+3000;while(document.querySelector('.stats-clear-dialog')){if(Date.now()>end)throw new Error('native clear dialog exit did not finish');await new Promise(resolve=>setTimeout(resolve,20))}await tick()}
const text=selector=>document.querySelector(selector)?.textContent
const button=(scope,label)=>[...document.querySelectorAll(scope+' button')].find(el=>el.textContent.trim()===label)
const key=async(el,value)=>{el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));await tick()}
const track=id=>({id:'local-'+id,title:'旋律 '+id,artist:'本地艺人',album:'曲集 '+id,filePath:'D:/fixture/'+id+'.wav',fileName:id+'.wav',duration:180,size:1,cover:null,lyrics:null,source:'local',format:'WAV'})
const stat=(track,seconds,plays)=>({title:track.title,artist:track.artist,seconds,plays,skips:0,completions:0,lastPlayed:Date.now(),cover:null,track,sourceIds:[{source:track.source,trackId:track.id}]})
window.runJournalTests=async()=>{
  await waitForListeningStatsReady()
  resetListeningStatsForTest()
  const {listeningStats,persistenceStatus}=useListeningStatsStore(),views=[],artistViews=[]
  const app=createApp({render:()=>h(Page,{'onSelect-view':(...args)=>views.push(args),'onOpen-artist':value=>artistViews.push(value)})})
  app.mount('#app');await tick()
  expect(document.querySelector('.journal-empty'),'empty state missing')
  document.querySelector('.journal-empty button').click();await tick()
  expect(views.at(-1)[0]==='allSongs','empty state does not open library')
  tracks.value=Array.from({length:250},(_,index)=>track(index));artists.value=[{name:'本地艺人'}]
  const today=new Date().toISOString().slice(0,10),yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10)
  const rows={}
  for(let index=0;index<12;index++)rows['s'+index]=stat(tracks.value[index],(12-index)*3600,index+1)
  rows.missing=stat(track(999),1000,2)
  listeningStats.value={days:{[today]:3600,[yesterday]:1800},tracks:rows};await tick()
  expect(!document.querySelector('.journal-empty'),'recorded history did not replace empty state')
  expect(text('.hero-duration').includes('78.3'),'hero did not sum exact seconds')
  expect(document.querySelector('.formats-panel').getBoundingClientRect().height===0&&document.querySelector('.ranking-list').getBoundingClientRect().height===0,'Overview exposes technical distribution or rankings')
  expect(document.querySelectorAll('.ranking-list li').length===5,'rankings are not initially bounded')
  expect(document.querySelectorAll('.calendar-day:not(:disabled)').length===365,'calendar is not exactly 365 days')
  expect(document.querySelectorAll('.calendar-day[tabindex="0"]').length===1,'calendar has multiple keyboard entrypoints')
  expect(text('.rhythm-total').includes('1.5'),'period time did not use daily records')
  for(const days of [7,90,30]){button('.an-segments',days+' 天').click();await tick();expect(document.querySelector('.rhythm-plot').getAttribute('aria-valuemax')===String(days),'range did not change chart')}
  const builds=getUnifiedRecentResolverRebuildCount()
  listeningStats.value.days[today]+=3600;listeningStats.value.tracks.s0.seconds+=3600;triggerRef(listeningStats);await tick()
  expect(text('.rhythm-total').includes('2.5'),'shallowRef tick did not update child chart')
  expect(text('.calendar-readout').includes('2小时'),'shallowRef tick did not update child calendar')
  expect(getUnifiedRecentResolverRebuildCount()===builds,'playback tick rebuilt the library resolver')
  const rankBefore=text('.ranking-list')
  button('.an-segments','7 天').click();await tick();expect(text('.ranking-list')===rankBefore,'date range changed the cumulative ranking')
  const plot=document.querySelector('.rhythm-plot');await key(plot,'Home');expect(plot.getAttribute('aria-valuenow')==='1','chart Home key failed');await key(plot,'ArrowRight');expect(plot.getAttribute('aria-valuenow')==='2','chart arrow key failed');await key(plot,'Escape');expect(!document.querySelector('.rhythm-tooltip'),'Escape did not dismiss tooltip')
  button('.an-segments','90 天').click();await tick()
  const plotRect=plot.getBoundingClientRect()
  for(const index of [0,3,43,88,89]){plot.dispatchEvent(new PointerEvent('pointermove',{clientX:plotRect.left+(8+index/89*624)/640*plotRect.width,clientY:plotRect.top+80,bubbles:true}));await tick();expect(Number(plot.getAttribute('aria-valuenow'))===index+1,'pointer did not snap to the drawn date')}
  button('.an-segments','7 天').click();await tick()
  expect(document.querySelector('.analytics-page').getBoundingClientRect().height<=innerHeight+1,'page escaped viewport instead of scrolling')
  await key(document.querySelector('.calendar-day[tabindex="0"]'),'Home');expect(document.activeElement.dataset.day===document.querySelector('.calendar-day:not(:disabled)').dataset.day,'calendar Home failed')
  await key(document.activeElement,'End');expect(document.activeElement.dataset.day===today,'calendar End failed');await key(document.activeElement,'ArrowUp');expect(document.activeElement.dataset.day===yesterday,'calendar arrow failed')
  document.querySelector('.footprint-footer button').click();await tick();expect(document.querySelectorAll('#calendar-data tbody tr').length===31,'calendar table is not paginated')
  document.querySelector('.an-data-details').open=true;await tick();expect(document.querySelectorAll('.an-data-details tbody tr').length===7,'daily table does not follow range')
  button('.analytics-view-switch','歌曲与歌手').click();await tick();expect(document.querySelector('.ranking-list').getBoundingClientRect().height>0,'Rankings did not open');document.querySelector('.ranking-row:not(:disabled)').click();await tick();expect(calls.at(-1).queue.length===200&&calls.at(-1).track.id==='local-0','single track lost bounded queue')
  const select=document.querySelector('.ranking-sort select');select.value='plays';select.dispatchEvent(new Event('change',{bubbles:true}));await tick();expect(text('.ranking-meta strong')==='旋律 11','play-count sorting only sorted an old top-five subset')
  document.querySelector('.ranking-expand').click();await tick();expect(document.querySelectorAll('.ranking-list li').length===10,'expanded ranking should be capped at ten')
  document.querySelector('.ranking-play-all').click();await tick();expect(calls.at(-1).queue.length===10&&calls.at(-1).track.id==='local-11','play ranking lost order')
  button('.ranking-tabs','艺人').click();await tick();document.querySelector('.ranking-row:not(:disabled)').click();await tick();expect(views.at(-1)[0]==='artists'&&views.at(-1)[1]==='artist:本地艺人','local artist route changed')
  const remote={...track('remote'),id:'provider:1',title:'远方',artist:'远程艺人',source:'test-provider',filePath:''}
  tracks.value=[];artists.value=[];listeningStats.value={days:{[today]:3600},tracks:{remote:stat(remote,7200,8),gone:stat(track(999),3600,3)}};await tick()
  document.querySelector('.ranking-row:not(:disabled)').click();await tick();expect(artistViews.at(-1).providerId==='test-provider','provider artist route changed')
  button('.ranking-tabs','歌曲').click();await tick();expect(document.querySelectorAll('.ranking-row:disabled').length===1,'deleted local snapshot became playable')
  document.querySelector('.ranking-row:not(:disabled)').click();await tick();expect(calls.at(-1).track.source==='test-provider','empty local library blocked remote history')
  persistenceStatus.value={state:'error',dirty:true,failureCount:1,lastError:'fixture'};await tick();expect(document.querySelector('.journal-notice'),'persistence failure missing')
  resetListeningStatsForTest();await tick()
  const todayStart=Date.parse(today+'T00:00:00Z'),earlier=new Date(todayStart-10*86400000).toISOString().slice(0,10)
  recordListeningForTest(track('clear'),60,todayStart-10*86400000)
  recordListeningForTest(track('clear'),120,todayStart)
  await tick()
  const before=JSON.stringify(listeningStats.value),clearEntry=document.querySelector('.journal-clear')
  expect(!clearEntry.disabled,'clear entry unavailable with data')
  clearEntry.focus();clearEntry.click();await tick()
  let dialog=document.querySelector('.stats-clear-dialog')
  expect(dialog.open&&dialog.matches(':modal'),'clear dialog must trap focus with showModal')
  expect(document.activeElement.textContent.trim()==='取消','destructive action received initial focus')
  expect(text('.stats-clear-preview').includes('2分钟'),'clear preview did not use the selected period')
  expect(JSON.stringify(listeningStats.value)===before,'opening clear dialog deleted records')
  button('.stats-clear-actions','取消').click();await untilClosed()
  expect(!document.querySelector('.stats-clear-dialog')&&document.activeElement===clearEntry,'cancel failed to close and restore focus')
  expect(JSON.stringify(listeningStats.value)===before,'cancel deleted data')
  clearEntry.click();await tick()
  const setPreset=async(value)=>{const input=document.querySelector('.stats-clear-field select');input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));await tick()}
  for(const value of ['1','7','30','90','all']){await setPreset(value);expect(!document.querySelector('.stats-clear-confirm').disabled,'preset cannot clear matching records')}
  await setPreset('custom')
  const setDate=async(label,value)=>{const input=document.querySelector('input[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));await tick()}
  await setDate('开始日期',today);await setDate('结束日期',yesterday)
  expect(document.querySelector('.stats-clear-error')&&document.querySelector('.stats-clear-confirm').disabled,'reversed date range allowed deletion')
  await setDate('开始日期',earlier);await setDate('结束日期',earlier)
  expect(text('.stats-clear-preview').includes('1分钟'),'custom range preview is incorrect')
  document.querySelector('.stats-clear-confirm').click();await untilClosed()
  expect(!document.querySelector('.stats-clear-dialog'),'clear did not close dialog')
  expect(listeningStats.value.days[earlier]===undefined&&listeningStats.value.days[today]===120,'custom clearing affected dates outside range')
  expect(text('.hero-duration').includes('2')&&text('.rhythm-total').includes('2'),'clearing failed to update hero and child chart')
  expect(text('.journal-notice').includes('已清除'),'clear success feedback missing')
  const durable=new ListeningStatsDatabase(indexedDB);expect((await durable.load()).days[earlier]===undefined,'clear was not saved immediately');await durable.close()
  clearEntry.click();await tick();await setPreset('custom');await setDate('开始日期',earlier);await setDate('结束日期',earlier)
  expect(document.querySelector('.stats-clear-confirm').disabled&&text('.stats-clear-preview').includes('没有可清除'),'empty range can be cleared')
  dialog=document.querySelector('.stats-clear-dialog');dialog.dispatchEvent(new Event('cancel',{cancelable:true}));await untilClosed()
  expect(!document.querySelector('.stats-clear-dialog'),'Escape cancel did not close dialog')
  listeningStats.value.tracks.legacy=stat(track('legacy'),3600,5);triggerRef(listeningStats);await tick()
  clearEntry.click();await tick();expect(document.querySelector('.stats-clear-legacy'),'undated history limitation is hidden')
  await setPreset('all');expect(!document.querySelector('.stats-clear-legacy'),'all-data clearing still claims to retain legacy history')
  document.querySelector('.stats-clear-confirm').click();await untilClosed()
  expect(document.querySelector('.journal-empty')&&document.querySelector('.journal-clear').disabled,'full clear did not restore empty state')
  expect(Object.keys(listeningStats.value.days).length===0&&Object.keys(listeningStats.value.tracks).length===0,'full clear retained historical data')
  app.unmount();resetListeningStatsForTest()
}
`
