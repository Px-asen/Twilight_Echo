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

test('queue workspace supports keyboard, 20,000-entry save/restore, undo, CRUD, failure retry and bounded history in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-queue-dialog-'))
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
          name: 'QueueDialogTest',
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
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">管理会话</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:960,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runQueueDialogTests()');if(process.env.TWILIGHT_QUEUE_DIALOG_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_QUEUE_DIALOG_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('QUEUE_DIALOG_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /QUEUE_DIALOG_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref,shallowRef} from 'vue'
import QueueWorkspaceDialog from '@renderer/components/player-bar/QueueWorkspaceDialog.vue'
import {createQueueWorkspaceStore} from '@renderer/stores/player/queueWorkspaceStore.ts'
import {createQueueSessionController} from '@renderer/stores/player/queueSessionController.ts'
import {createQueueCommandController} from '@renderer/stores/player/queueCommandController.ts'
import {toPlaybackQueueSnapshots} from '@renderer/utils/playbackQueueVirtualization.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=(delay=30)=>new Promise(resolve=>setTimeout(resolve,delay))
const song=id=>({id,queueEntryId:'q:'+id,title:id,artist:'测试艺术家',album:'测试专辑',filePath:'C:/music/'+id+'.flac',fileName:id,source:'local',duration:180,size:1,cover:null,lyrics:null})
window.runQueueDialogTests=async()=>{
  let disk=null,fail=false,plays=0,bubbled=0
  const queue=shallowRef(toPlaybackQueueSnapshots(Array.from({length:20000},(_,i)=>song('歌曲 '+i))))
  const library=new Map(queue.value.map(track=>[track.id,track]))
  const originalQueue=shallowRef([...queue.value]),currentTrack=shallowRef(queue.value[19999]),queueIndex=ref(19999),playMode=ref('sequential'),playing=ref(false)
  const workspace=createQueueWorkspaceStore(()=>({loadQueueWorkspace:async()=>disk,saveQueueWorkspace:async(data,revision)=>{if(fail)throw new Error('磁盘已满');disk={version:2,revision:revision+1,savedAt:new Date().toISOString(),data:structuredClone(data)};return disk}}))
  const commands=createQueueCommandController({queue,originalQueue,currentTrack,queueIndex,playMode,getPosition:()=>25,prepareSelection:track=>{currentTrack.value=track;playing.value=false},onMutation:()=>{}})
  const controller=createQueueSessionController({workspace,queue,originalQueue,currentTrack,playMode,revision:commands.revision,getPosition:()=>25,
    getSources:async()=>({localTracks:library,savedStreams:new Map(),availableProviders:new Set(),networkProfiles:new Set(),authorizeFiles:async paths=>paths.map(()=>true)}),
    prepare:result=>{commands.replace(result.queue,result.index,{original:result.original,select:false});currentTrack.value=result.queue[result.index];playing.value=false},play:async()=>{playing.value=true;plays++}})
  const app=createApp({render:()=>controller.open.value?h(QueueWorkspaceDialog,{workspace,controller,queueLength:queue.value.length,canUndo:commands.canUndo.value,undoLabel:commands.undoLabel.value,undo:commands.undo,onClose:()=>controller.open.value=false}):null})
  const opener=document.querySelector('#opener');opener.focus();controller.show();app.mount('#app');await pause()
  const button=text=>[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===text)
  const click=async text=>{const target=button(text);expect(target&&!target.disabled,'missing or disabled button: '+text);target.click();await pause(70)}
  const type=async text=>{const input=document.querySelector('input');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()}
  expect(document.querySelector('dialog').matches(':modal'),'not a modal dialog')
  expect(document.activeElement===document.querySelector('input'),'name input not focused')
  await type('工作');await click('保存为新会话')
  expect(workspace.sessions.value[0]?.entries.length===20000,'large queue save failed')
  expect(document.querySelectorAll('.session-row').length===1,'saved session missing')
  document.querySelector('.session-row').click();await pause()
  commands.replace([], -1);await pause();expect(queue.value.length===0,'clear failed')
  await click('撤销队列操作');expect(queue.value.length===20000&&queueIndex.value===19999&&!playing.value,'undo did not recover paused cursor')
  await click('恢复队列');expect(queueIndex.value===19999&&plays===0&&!playing.value,'restore started playback or reused a wrong index')
  await click('恢复并播放');expect(plays===1&&playing.value,'explicit restore play failed')
  commands.replace([song('歌曲 0')],0);await pause()
  await click('用当前队列覆盖');expect(workspace.sessions.value[0].entries.length===1,'overwrite failed')
  await type('睡前');await click('应用新名称');expect(workspace.sessions.value[0].name==='睡前','rename failed')
  await click('删除会话');await click('确认删除');expect(workspace.sessions.value.length===0,'delete failed')
  fail=true;await type('工作');await click('保存为新会话')
  expect(document.querySelector('[role="alert"]').textContent.includes('磁盘已满'),'write failure hidden')
  fail=false;await click('保存为新会话');expect(workspace.sessions.value.length===1,'save retry failed')
  for(let i=0;i<205;i++)workspace.record(song('实际 '+i),i%2?'shuffle':'heart')
  await click('实际播放顺序')
  expect(document.querySelector('.history-list').textContent.includes('实际 204'),'latest playback order missing')
  expect(document.querySelectorAll('[data-playback-history-row]').length<=12,'history DOM not bounded')
  const history=document.querySelector('.history-list');history.scrollTop=200*54;history.dispatchEvent(new Event('scroll'));await pause()
  expect(history.textContent.includes('实际 5'),'oldest retained playback not reachable')
  window.addEventListener('keydown',()=>bubbled++)
  history.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));expect(bubbled===0,'dialog key reached playback shortcuts')
  history.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await pause()
  expect(!controller.open.value&&document.activeElement===opener,'Escape or focus restore failed')
  await workspace.flush()
  controller.show();await pause()
  document.querySelector('.session-row').click();await pause()
  await click('恢复队列')
  workspace.dispose();commands.dispose()
}
`
