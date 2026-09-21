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

test('inbox persists decisions, bounds 10k rows, previews writes and fences stale results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-inbox-ui-'))
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
          name: 'InboxTest',
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
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">曲库整理</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runInboxTests()');if(process.env.TWILIGHT_INBOX_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_INBOX_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('INBOX_UI_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /INBOX_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import '@renderer/assets/base.css'
import {createApp,h,nextTick,ref,shallowRef} from 'vue'
import Dialog from '@renderer/components/library-inbox/LibraryInboxDialog.vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,30));await nextTick()}
const button=text=>[...document.querySelectorAll('button')].find(el=>(el.textContent.trim()||el.getAttribute('aria-label')||'').startsWith(text)&&el.getClientRects().length)
const click=async text=>{const el=button(text);expect(el&&!el.disabled,'button unavailable: '+text);el.click();await tick()}
const setValue=async(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));await tick()}
const track=id=>({id,title:'曲目 '+id,artist:'Artist',album:'Album',source:'local',filePath:'D:/music/'+id+'.flac',fileName:id+'.flac',duration:180,size:100,cover:null,lyrics:null})
window.runInboxTests=async()=>{
  localStorage.clear()
  const tracks=shallowRef(Array.from({length:10000},(_,i)=>track(String(i))))
  const open=ref(true),writes=[],applied=[]
  let resolveDuplicates,resolveWrite,failWrite=false,holdWrite=false,scanCount=0,duplicateCount=0,scanFails=false
  window.api={library:{
    detectDuplicates:()=>{duplicateCount++;return new Promise(resolve=>resolveDuplicates=resolve)},
    writeTags:async request=>{writes.push(request);if(holdWrite)return new Promise(resolve=>resolveWrite=resolve);return {items:request.items.map(item=>({filePath:item.filePath,status:failWrite?'failed':'success',message:failWrite?'fixture failure':undefined}))}},
    restoreTags:async()=>({items:[]})
  }}
  document.getElementById('opener').focus()
  createApp({setup:()=>()=>open.value?h(Dialog,{tracks:tracks.value,scanning:false,rescan:async()=>{scanCount++;if(scanFails)throw new Error('fixture scan failure')},onClose:()=>open.value=false,onApplied:(paths,patch)=>applied.push({paths,patch})}):null}).mount('#app')
  await tick()
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
  expect(duplicateCount===0&&scanCount===0,'opening must not analyze files')
  expect(document.querySelectorAll('.inbox-row').length===50,'10k DOM must be bounded')
  expect(document.querySelector('[role="dialog"]').contains(document.activeElement),'initial focus')
  const dialog=document.querySelector('.inbox-dialog')
  const enabled=[...dialog.querySelectorAll('button:not([disabled]),input,select')]
  enabled.at(-1).focus();enabled.at(-1).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))
  expect(document.activeElement===enabled[0],'focus wraps')
  document.querySelector('.inbox-list').scrollTop=300;await click('下一页');expect(document.querySelector('.inbox-list').scrollTop===0,'page resets scroll');expect(document.querySelector('.inbox-row').textContent.includes('曲目 50'),'page changes')
  await click('上一页');document.querySelector('.inbox-row input').click();await tick();await click('忽略')
  const selects=document.querySelectorAll('.inbox-controls select')
  await setValue(selects[1],'ignored');expect(document.querySelectorAll('.inbox-row').length===1,'ignored filter')
  await click('关闭');expect(document.activeElement.id==='opener','restore focus')
  open.value=true;await tick();await setValue(document.querySelectorAll('.inbox-controls select')[1],'ignored')
  expect(document.querySelectorAll('.inbox-row').length===1,'persisted status on reopen')
  tracks.value=[{...tracks.value[0],album:'Updated'},...tracks.value.slice(1)];await tick()
  expect(document.querySelectorAll('.inbox-row').length===0,'changed issue reopens')
  await setValue(document.querySelectorAll('.inbox-controls select')[1],'pending')
  document.querySelector('.inbox-row input').click();await tick();await click('预览并编辑标签')
  const titleInput=document.querySelector('.tag-form-grid input')
  await setValue(titleInput,'Changed');await setValue(titleInput,'')
  await click('预览 1');expect(writes.length===0,'preview is read-only')
  expect(document.querySelector('.tag-preview').textContent.includes('Artist'),'before/after preview')
  failWrite=true;await click('确认写入');expect(!('title' in writes[0].items[0]),'cleared input must not erase title')
  expect(applied.length===0,'failed write must not apply')
  failWrite=false;await click('预览失败项并重试');await click('确认写入');expect(applied.length===1,'retry confirmed success')
  await click('预览 1');tracks.value=[{...tracks.value[0],artist:'Fresh'},...tracks.value.slice(1)];await tick();await click('确认写入')
  expect(writes.length===2,'stale preview must not write')
  await click('关闭');document.querySelector('.inbox-row input').click();await tick();await click('预览并编辑标签')
  await click('预览 1');holdWrite=true;const submit=button('确认写入');submit.click();await tick()
  tracks.value=[{...tracks.value[0],artist:'Newer'},...tracks.value.slice(1)];await tick()
  resolveWrite({items:[{filePath:'D:/music/0.flac',status:'success'}]});await tick()
  expect(applied.length===1,'late tag result must not overwrite current track')
  await click('关闭')
  document.querySelectorAll('.inbox-row input')[0].click();document.querySelectorAll('.inbox-row input')[1].click();await tick()
  await click('预览并编辑标签');await setValue(document.querySelector('.tag-form-grid input'),'Batch title');await click('预览 2')
  button('确认写入').click();await tick()
  resolveWrite({items:[{filePath:['d:','MUSIC','0.flac'].join(String.fromCharCode(92)),status:'success'},{filePath:'D:/music/1.flac',status:'failed',message:'partial fixture'}]});await tick()
  expect(applied.length===2&&applied.at(-1).paths.length===1,'partial success updates only successful path')
  holdWrite=false;await click('预览失败项并重试');await click('确认写入')
  expect(writes.at(-1).items.length===1&&writes.at(-1).items[0].filePath==='D:/music/1.flac','retry must exclude previous success')
  await click('关闭');await click('检查疑似重复')
  tracks.value=[...tracks.value];await tick();resolveDuplicates({groups:[],suggestions:[],contentHashUnavailableIds:[]});await tick()
  expect(!document.querySelector('.inbox-dialog').textContent.includes('检查完成，'),'late duplicates discarded')
  await click('检查疑似重复');resolveDuplicates({groups:[{key:'g',kind:'metadataCandidate',confidence:'possible',items:tracks.value}],suggestions:[],contentHashUnavailableIds:['0']});await tick()
  expect(document.querySelectorAll('.inbox-row').length===50,'10k duplicate members bounded')
  expect(document.querySelector('[role="status"]').textContent.includes('无法读取'),'unreadable hash feedback')
  scanFails=true;await click('全库后台重扫');expect(document.querySelector('[role=alert]').textContent.includes('fixture scan failure'),'scan failure feedback');scanFails=false;await click('全库后台重扫');expect(scanCount===2,'explicit scan retry')
  document.querySelector('.inbox-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick()
  expect(!document.querySelector('[role="dialog"]'),'escape closes')
  open.value=true;await tick()
}
`
