import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('database drawer renders stable progress snapshots, 300k/million-entry windows and queue actions in real Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-library-drawer-'))
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
          name: 'LibraryDrawerTest',
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
        )}<style>body{margin:0;background:#ebeef4}#app{position:absolute;right:24px;bottom:24px}.caption{color:var(--te-neutral-500);margin:0 0 16px;font-size:14px}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:760,height:650,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});const capture=async()=>{if(process.env.TWILIGHT_LIBRARY_DRAWER_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_LIBRARY_DRAWER_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}};try{await win.loadFile(process.argv.at(-1));const result=await win.webContents.executeJavaScript('window.runLibraryDrawerTests()');await capture();console.log('LIBRARY_DRAWER_OK '+JSON.stringify(result));app.exit(0)}catch(error){await capture();console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      // Match the other Windows renderer gates: its Electron sandbox can stall at startup.
      [...(process.platform === 'win32' ? ['--no-sandbox'] : []), join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /LIBRARY_DRAWER_OK/)
    console.log(result.stdout.trim())
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref,shallowRef} from 'vue'
import LibraryQueueDrawer from '@renderer/components/player-bar/LibraryQueueDrawer.vue'
import '@renderer/assets/base.css'
import '@renderer/assets/primeicons.css'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=(delay=40)=>new Promise(resolve=>setTimeout(resolve,delay))
const song=i=>({id:'track:'+Math.floor(i/2),title:'月光奏鸣曲 · 第 '+(i+1)+' 乐章',artist:'路德维希·范·贝多芬',album:'钢琴奏鸣曲',filePath:'D:/Music/disc.flac',duration:180,cover:null})
const entry=i=>({queueEntryId:'entry:'+i,track:song(i)})
window.runLibraryDrawerTests=async()=>{
  const snapshot=shallowRef({id:'queue',total:300000,index:299999,revision:0,selectedEntryId:'entry:299999',order:'original'})
  const content=ref(1),busy=ref(false),playing=ref(true)
  let small=null,serial=0,fail=false,failAction=false,reads=0,active=0,peakReads=0,plays=[],edits=[],added=[]
  const expected=version=>expect(version.id===snapshot.value.id&&version.revision===snapshot.value.revision,'command used a stale version')
  const change=selected=>{const old=snapshot.value;const index=small.findIndex(item=>item.queueEntryId===selected);snapshot.value={...old,total:small.length,index,selectedEntryId:index<0?null:selected,revision:old.revision+1}}
  const readPage=async page=>{reads++;active++;peakReads=Math.max(peakReads,active);const captured={...snapshot.value},revision=content.value;await pause(5);active--;if(fail){fail=false;throw new Error('数据库暂时离线')}const offset=page*200;return {offset,total:captured.total,revision:captured.revision,libraryRevision:revision,items:Array.from({length:Math.max(0,Math.min(200,captured.total-offset))},(_,i)=>({...small?.[offset+i]??entry(offset+i),position:offset+i}))}}
  const playEntry=async(id,version)=>{expected(version);plays.push(id);change(id)}
  const editQueue=async(edit,version)=>{expected(version);if(failAction){failAction=false;throw new Error('写入失败，请重试')}edits.push(edit);const selected=snapshot.value.selectedEntryId;
    if(edit.kind==='clear')small=[];
    if(edit.kind==='remove')small=small.filter(item=>!edit.entryIds.includes(item.queueEntryId));
    if(edit.kind==='move'){const index=small.findIndex(item=>item.queueEntryId===edit.entryId);const [row]=small.splice(index,1);const before=edit.beforeEntryId===null?small.length:small.findIndex(item=>item.queueEntryId===edit.beforeEntryId);small.splice(before,0,row)}
    if(edit.kind==='insert'){const at=edit.afterEntryId?small.findIndex(item=>item.queueEntryId===edit.afterEntryId)+1:small.length;small.splice(at,0,...edit.trackIds.map(id=>({queueEntryId:'insert:'+serial++,track:{...song(0),id}})))}
    change(small.some(item=>item.queueEntryId===selected)?selected:small[0]?.queueEntryId)
  }
  const app=createApp({render:()=>h('div',[h('p',{class:'caption'},'SQLite 曲库 · 按需读取播放队列'),h(LibraryQueueDrawer,{snapshot:snapshot.value,contentRevision:content.value,busy:busy.value,isPlaying:playing.value,readPage,playEntry,editQueue,duplicateEntry:async(id,next,version)=>{expected(version);const row=small.find(item=>item.queueEntryId===id);const selected=snapshot.value.selectedEntryId;const at=next?small.findIndex(item=>item.queueEntryId===selected)+1:small.length;small.splice(at,0,{...row,queueEntryId:'insert:'+serial++});change(selected)},refreshQueue:async()=>{},onAddToPlaylist:track=>added.push(track)})])})
  app.mount('#app');await pause(150)
  const rows=()=>[...document.querySelectorAll('[data-queue-index]')]
  const row=i=>document.querySelector('[data-queue-index="'+i+'"]')
  const click=async target=>{expect(target&&!target.disabled,'missing or disabled button');target.click();await pause(80)}
  expect(document.querySelector('.playlist-count').textContent.includes('300,000'),'header used a visible page as the total')
  expect(row(299999),'300k tail not reachable on mount')
  expect(rows().length<=22,'queue DOM unbounded')
  const geometry=()=>{const list=document.querySelector('.playlist-list'),tail=rows().at(-1),window=document.querySelector('.playlist-virtual-window');return {list:list.getBoundingClientRect().toJSON(),tail:tail.getBoundingClientRect().toJSON(),clientHeight:list.clientHeight,scrollHeight:list.scrollHeight,scrollTop:list.scrollTop,padding:getComputedStyle(list).padding,transform:window.style.transform}}
  expect(row(299999).getBoundingClientRect().bottom<=document.querySelector('.playlist-list').getBoundingClientRect().bottom+1,'tail outside viewport '+JSON.stringify(geometry()))
  const list=document.querySelector('.playlist-list');list.scrollTop=0;list.dispatchEvent(new Event('scroll'));await pause(80)
  expect(row(0),'top not reachable')
  // Progress snapshots are new objects even when the queue has not changed.
  // They must not replace rows/images, expose loading placeholders or pull the scroll position.
  const stableRows=rows(),stableCovers=stableRows.map(item=>item.querySelector('.playlist-cover'))
  const readsBeforeProgress=reads,scrollBeforeProgress=list.scrollTop
  const rowMutations=[]
  const mutationObserver=new MutationObserver(records=>rowMutations.push(...records))
  mutationObserver.observe(document.querySelector('.playlist-virtual-window'),{childList:true,subtree:true})
  for(let tick=0;tick<20;tick++){
    snapshot.value={...snapshot.value};await nextTick();await pause(10)
    expect(reads===readsBeforeProgress,'progress re-read the queue page')
    expect(list.scrollTop===scrollBeforeProgress,'progress reset the manual scroll position')
    expect(!list.textContent.includes('正在读取歌曲'),'progress flashed loading rows')
    expect(stableRows.every((item,index)=>rows()[index]===item&&item.querySelector('.playlist-cover')===stableCovers[index]),'progress replaced a row or cover')
  }
  mutationObserver.disconnect()
  expect(rowMutations.length===0,'progress mutated queue row contents')
  fail=true;content.value++;await pause(80)
  expect(document.querySelector('[role="alert"]').textContent.includes('数据库暂时离线'),'read error hidden')
  expect(!document.querySelector('.playlist-empty'),'read error mistaken for empty queue')
  await click([...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='重试'))
  expect(!document.querySelector('[role="alert"]'),'retry did not recover')
  small=Array.from({length:5},(_,i)=>entry(i));snapshot.value={...snapshot.value,total:5,index:0,selectedEntryId:'entry:0',revision:1};await pause(80)
  await click(row(1).querySelector('.library-queue-play'))
  expect(plays[0]==='entry:1'&&snapshot.value.index===1,'duplicate identity lost')
  row(1).querySelector('button').focus();row(1).querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true,cancelable:true}));await pause(80)
  expect(small[2].queueEntryId==='entry:1'&&edits.at(-1).beforeEntryId==='entry:3','keyboard reorder wrong')
  const transfer=new DataTransfer();row(2).dispatchEvent(new DragEvent('dragstart',{dataTransfer:transfer,bubbles:true}));snapshot.value={...snapshot.value};await nextTick();expect(row(2).classList.contains('dragging'),'progress cancelled a queue drag');row(0).dispatchEvent(new DragEvent('dragover',{dataTransfer:transfer,bubbles:true,cancelable:true}));row(0).dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));await pause(80)
  expect(small[0].queueEntryId==='entry:1','drag reorder lost occurrence')
  await click(row(0).querySelector('[title="下一首播放"]'));expect(small[1].track.id==='track:0'&&small.length===6,'next insert failed')
  await click(row(0).querySelector('[title="添加到队尾"]'));expect(small.at(-1).track.id==='track:0'&&small.length===7,'append failed')
  await click(row(0).querySelector('[title="添加到歌单"]'));expect(added[0].id==='track:0'&&added[0].queueEntryId==='entry:1','single playlist add not authoritative')
  failAction=true;await click(row(0).querySelector('[title="从队列移除"]'));expect(document.querySelector('[role="alert"]').textContent.includes('写入失败'),'command failure hidden')
  await click(row(0).querySelector('[title="从队列移除"]'));expect(!small.some(item=>item.queueEntryId==='entry:1')&&small.length===6,'failed action left controls blocked')
  small[0].track=null;content.value++;await pause(80)
  expect(row(0).querySelector('.library-queue-play').disabled,'SQL missing row playable')
  await click(row(0).querySelector('[title="从队列移除"]'));expect(small.length===5,'SQL hole not removable')
  await click([...document.querySelectorAll('.playlist-tools button')].find(button=>button.textContent.trim()==='清空'));expect(document.querySelector('.playlist-empty')&&snapshot.value.total===0,'clear not shown as real empty')
  // Verify browser scroll-height clamping does not hide millions of CUE occurrences.
  small=null;snapshot.value={...snapshot.value,id:'millions',total:5000000,index:4999999,selectedEntryId:'entry:4999999',revision:0};await pause(120)
  expect(row(4999999),'million-entry tail not reachable')
  expect(rows().length<=22&&peakReads<=2,'page reads or rendered rows unbounded')
  expect(row(4999999).getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom+1,'million-entry tail outside viewport')
  // Leave a representative large-library render for inspection.
  snapshot.value={...snapshot.value,id:'large',total:300000,index:179999,selectedEntryId:'entry:179999',revision:0};await pause(120)
  expect(row(179999),'current entry not centered')
  return {reads,peakReads,rows:rows().length,total:snapshot.value.total}
}
`
