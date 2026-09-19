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

test('loudness dialog handles scope, progress, cancel, retry, stale queries and a bounded keyboard grid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-loudness-ui-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
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
          name: 'LoudnessTest',
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
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">响度分析</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runLoudnessTests()');if(process.env.TWILIGHT_LOUDNESS_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_LOUDNESS_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('LOUDNESS_UI_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /LOUDNESS_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref,shallowRef} from 'vue'
import Dialog from '@renderer/components/library-loudness/LibraryLoudnessDialog.vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=()=>new Promise(resolve=>setTimeout(resolve,20))
const until=async(predicate,message)=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw new Error(message);await pause()}await nextTick()}
const track=id=>({id,title:'曲目 '+id,artist:'合辑艺术家',album:'示例专辑',albumId:'release',filePath:'D:/music/'+id+'.flac',fileName:id+'.flac',source:'local',duration:180,size:1,cover:null,lyrics:null,replayGainTrackGainDb:8})
const measured=lufs=>({source:'analyzed',available:true,algorithmVersion:2,integratedLufs:lufs,truePeakDb:-1,analyzedAt:'2026-09-14T00:00:00Z'})
window.runLoudnessTests=async()=>{
  const callbacks=new Set(),records=new Map(),starts=[],clears=[]
  let status={revision:0,jobId:null,state:'idle',total:0,processed:0,failed:0,currentTitle:''},items=[],cancelCount=0,failQuery=false,releaseOld
  let holdFirstQuery=true
  const snapshot=()=>({status:{...status},items:items.map(item=>({...item}))})
  const publish=item=>{status.revision++;for(const cb of callbacks)cb({status:{...status},...(item?{item:{...item}}:{})})}
  window.api={loudnessAnalysis:{
    onBatchProgress:cb=>{callbacks.add(cb);return()=>callbacks.delete(cb)},
    getBatch:async()=>snapshot(),
    getResults:async groups=>{
      if(failQuery)throw new Error('fixture offline')
      if(holdFirstQuery){holdFirstQuery=false;return new Promise(resolve=>releaseOld=()=>resolve(groups.map(group=>({id:group.id,status:'measured',measurement:measured(-99)}))))}
      return groups.map(group=>records.get(group.id)||{id:group.id,status:'missing'})
    },
    startBatch:async groups=>{
      starts.push(groups);status={...status,jobId:'job:'+starts.length,state:'running',total:groups.length,processed:0,failed:0,currentTitle:groups[0].title}
      items=groups.map(group=>({id:group.id,title:group.title,trackCount:group.tracks.length,state:'queued'}));items[0].state='analyzing';publish(items[0]);return snapshot()
    },
    cancelBatch:async id=>{expect(id===status.jobId,'cancel used the wrong job');cancelCount++;status.state='cancelled';status.currentTitle='';items=items.map(item=>({...item,state:'cancelled'}));publish()},
    clearResults:async ids=>{clears.push(ids);for(const id of ids)records.delete(id)}
  }}
  const library=shallowRef([track('one'),track('two')]),selection=shallowRef([library.value[0]])
  const albums=shallowRef([{id:'id:release',name:'示例专辑',tracks:library.value,trackCount:2,cover:null}])
  const visible=ref(true),opener=document.querySelector('#opener');opener.focus()
  createApp({render:()=>visible.value?h(Dialog,{libraryTracks:library.value,selectedTracks:selection.value,albums:albums.value,onClose:()=>visible.value=false}):null}).mount('#app')
  const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===text)
  const enabled=text=>button(text)?.disabled===false
  const click=async text=>{button(text).click();await nextTick()}
  await until(()=>releaseOld,'initial query not sent')
  expect(document.querySelector('dialog').matches(':modal'),'dialog is not modal')
  expect(document.activeElement===document.querySelector('input[value="track"]'),'radio did not receive focus')
  document.querySelector('input[value="album"]').click();await pause();releaseOld();await until(()=>enabled('开始分析'),'initial refresh did not finish')
  expect(!document.querySelector('.loudness-results').textContent.includes('-99'),'stale track query leaked into album view')
  expect(document.querySelectorAll('.loudness-row').length===3,'album does not include both members')
  expect(document.querySelector('.loudness-results').textContent.includes('未分析'),'tag gains were treated as measured evidence')
  await click('开始分析');await until(()=>enabled('取消分析'),'start did not settle')
  expect(starts[0][0].tracks.length===2,'selected subset was analyzed as a complete album')
  document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true}));await pause()
  expect(!visible.value&&cancelCount===0,'closing cancelled a background job')
  expect(callbacks.size===0&&document.activeElement===opener,'close leaked the listener or failed focus restore')
  holdFirstQuery=true;releaseOld=undefined;visible.value=true;await until(()=>releaseOld&&enabled('取消分析'),'pending result checks disabled cancellation')
  await click('取消分析');await until(()=>enabled('开始分析'),'cancel did not finish')
  expect(cancelCount===1,'cancel was not sent once')
  releaseOld();await pause()
  document.querySelector('input[value="album"]').click();await pause()
  await click('开始分析');await until(()=>starts.length===2&&enabled('取消分析'),'second start did not finish')
  items[0].state='failed';items[0].reason='fixture decode failed';status.processed=1;status.failed=1;publish(items[0]);status.state='completed';publish();await until(()=>button('重试未完成项'),'retry missing')
  expect(document.querySelector('.loudness-results').textContent.includes('fixture decode failed'),'failure reason missing')
  await click('重试未完成项');await until(()=>starts.length===3&&enabled('取消分析'),'retry did not start')
  expect(starts[2].length===1&&starts[2][0].mode==='album','retry lost the full album scope')
  const group=starts[2][0];records.set(group.id,{id:group.id,status:'measured',measurement:measured(-21),tracks:[measured(-20),measured(-24)]})
  items[0].state='completed';status.processed=1;status.failed=0;publish(items[0]);status.state='completed';publish()
  await until(()=>document.querySelector('.loudness-results').textContent.includes('-21.00'),'measured results missing')
  expect(document.querySelector('.loudness-results').textContent.includes('-24.00'),'album member measurements missing')
  expect(document.querySelector('[aria-label^="综合响度"]').getAttribute('aria-label').includes('-21.00'),'accessible cell name omits the measured value')
  await click('清理此范围结果');await until(()=>clears.length===1&&enabled('刷新结果'),'clear did not finish')
  expect(clears[0][0]===group.id&&!document.querySelector('.loudness-results').textContent.includes('-21.00'),'clear ignored current scope')
  failQuery=true;await click('刷新结果');await until(()=>document.querySelector('[role="alert"]'),'query error missing')
  expect(document.querySelector('[role="alert"]').textContent.includes('fixture offline'),'query failure not explained')
  failQuery=false;await click('重试操作');await until(()=>!document.querySelector('[role="alert"]')&&enabled('开始分析'),'query retry failed')
  document.querySelector('input[value="track"]').click();selection.value=null;library.value=Array.from({length:10000},(_,index)=>track(String(index)));await until(()=>document.querySelector('[role="grid"]').getAttribute('aria-rowcount')==='10000'&&enabled('刷新结果'),'large scope did not load')
  expect(document.querySelectorAll('.loudness-row').length<=12,'large results mounted unbounded rows')
  const grid=document.querySelector('[role="grid"]');grid.focus();grid.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));await pause()
  expect(grid.scrollTop>600000,'End did not reach the virtual tail')
  expect(document.querySelector('[aria-selected="true"]').textContent.includes('曲目 9999'),'keyboard selection lost last row')
  expect(document.querySelectorAll('.loudness-row').length<=12,'tail rendered unbounded rows')
  library.value=[track('one'),track('two')];selection.value=[library.value[0]];albums.value=[{id:'id:release',name:'示例专辑',tracks:library.value,trackCount:2,cover:null}]
  records.set(group.id,{id:group.id,status:'measured',measurement:measured(-21),tracks:[measured(-20),measured(-24)]});document.querySelector('input[value="album"]').click();await until(()=>document.querySelector('.loudness-results').textContent.includes('-21.00'),'final preview did not load')
  await click('开始分析');await until(()=>enabled('取消分析'),'remeasure did not start')
  expect(!document.querySelector('.loudness-results').textContent.includes('-21.00'),'analysis retained a previous measurement')
  items[0].state='failed';items[0].reason='source changed';status.processed=1;status.failed=1;publish(items[0]);status.state='completed';publish();await pause()
  expect(!document.querySelector('.loudness-results').textContent.includes('-21.00'),'failure published a previous complete album')
  await click('刷新结果');await until(()=>document.querySelector('.loudness-results').textContent.includes('-21.00'),'final cache refresh did not finish')
}
`
