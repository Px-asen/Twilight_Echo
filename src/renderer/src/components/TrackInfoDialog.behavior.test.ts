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
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('track information delegates native cancellation to the busy tag editor and restores its opener', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-track-info-cancel-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(
      join(directory, 'music-store.ts'),
      'export const useMusicStore = () => ({ applyLocalTagWrite: (...args) => window.trackInfoFixture.applied.push(args) })'
    )
    await writeFile(
      join(directory, 'unused-view.ts'),
      "import {h} from 'vue'; export default {render: () => h('span')}"
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: [
          {
            find: /^@renderer\/stores\/useMusicStore$/,
            replacement: join(directory, 'music-store.ts')
          },
          {
            find: /^@renderer\/components\/(CoverImg\.vue|music-versions\/MusicVersionsHost\.vue)$/,
            replacement: join(directory, 'unused-view.ts')
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') }
        ]
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'TrackInfoCancelTest',
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
        )}</head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /TRACK_INFO_BUSY_CANCEL_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import TrackInfoDialog from '@renderer/components/TrackInfoDialog.vue'

const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,0));await nextTick()}
const state=window.trackInfoFixture={applied:[],writes:[],cancels:[],keys:[],closeCount:0}
const track={id:'D:/fixture/song.flac',filePath:'D:/fixture/song.flac',fileName:'song.flac',source:'local',title:'Before',artist:'Artist',album:'Album',duration:180,cover:null}
let resolveWrite
window.api={library:{writeTags:request=>{
  state.writes.push(request)
  return new Promise(resolve=>{resolveWrite=resolve})
}}}
window.addEventListener('keydown',event=>{
  if(event.key==='Escape')state.keys.push({trusted:event.isTrusted,prevented:event.defaultPrevented})
})
createApp({setup(){
  const open=ref(false)
  return ()=>h('div',[
    h('button',{id:'track-info-opener',onClick:()=>{open.value=true}},'Song information'),
    open.value?h(TrackInfoDialog,{track,onClose:()=>{state.closeCount++;open.value=false}}):null
  ])
}}).mount('#app')
let dialog,editor
const assertBusy=()=>{
  expect(document.querySelector('.tag-manager')===editor,'BUSY_CANCEL_UNMOUNTED_TAG_EDITOR')
  expect(dialog.open&&document.querySelector('dialog')===dialog,'busy cancellation closed the parent dialog: '+JSON.stringify({open:dialog.open,closeCount:state.closeCount,cancels:state.cancels,keys:state.keys}))
  expect(editor.querySelector('[aria-label="关闭标签管理"]').disabled,'busy close control was enabled')
  expect(state.closeCount===0&&state.applied.length===0,'busy cancellation escaped to parent or applied early')
  expect(state.writes.length===1,'cancellation duplicated the pending write')
}
window.beginPendingWrite=async()=>{
  const opener=document.getElementById('track-info-opener')
  opener.focus();opener.click();await tick()
  dialog=document.querySelector('dialog')
  expect(dialog?.open&&dialog.matches(':modal'),'real native modal did not open')
  dialog.addEventListener('cancel',event=>state.cancels.push({trusted:event.isTrusted,bubbles:event.bubbles,cancelable:event.cancelable,prevented:event.defaultPrevented}))
  const edit=[...dialog.querySelectorAll('button')].find(button=>button.textContent.trim()==='编辑歌曲信息')
  edit.focus();edit.click();await tick()
  editor=document.querySelector('.tag-manager')
  expect(editor,'real tag editor did not render')
  expect(dialog.getAttribute('aria-labelledby')==='tag-manager-title'&&document.getElementById('tag-manager-title')?.textContent.trim(),'editing native dialog has no effective accessible-name reference')
  expect(editor.contains(document.activeElement),'tag editor did not receive focus')
  const input=editor.querySelector('input')
  input.value='After';input.dispatchEvent(new Event('input',{bubbles:true}));await tick()
  editor.querySelector('button[type=submit]').click();await tick()
  const confirm=editor.querySelector('.tag-preview .tag-primary-button')
  expect(confirm&&!confirm.disabled,'tag-write preview was not available')
  confirm.focus();confirm.click();await tick()
  assertBusy()
  expect(state.writes[0].items[0].title==='After','write did not use the edited production preview')
  editor.querySelector('#tag-manager-edit-tab').focus()
  expect(editor.contains(document.activeElement),'inside-editor Escape would not reach its handler')
}
window.checkInsideEscape=async()=>{
  await tick();assertBusy()
  expect(state.keys.at(-1)?.trusted&&state.keys.at(-1)?.prevented,'real editor Escape did not prevent its native default')
  expect(state.cancels.length===0,'prevented editor Escape reached native cancel')
}
window.checkNativeCancel=async()=>{
  expect(typeof dialog.requestClose==='function','Electron lacks native dialog.requestClose')
  dialog.requestClose();await tick();assertBusy()
  expect(state.cancels.length===1&&state.cancels[0].trusted,'native close request did not emit a trusted cancel')
  expect(state.cancels[0].prevented&&!state.cancels[0].bubbles,'native cancel was not prevented on its own dialog')
}
window.focusOuterDialog=()=>{
  dialog.focus()
  expect(document.activeElement===dialog,'outer Escape would still be handled by a tag-editor descendant')
}
window.checkOuterEscape=async()=>{
  await tick();assertBusy()
  expect(state.keys.at(-1)?.trusted&&state.keys.at(-1)?.prevented,'outer Escape was not intercepted before native CloseWatcher')
  expect(state.cancels.length===1,'outer Escape reached native cancel despite the editing guard')
}
window.finishWrite=async()=>{
  resolveWrite({items:[{filePath:track.filePath,status:'success'}]});await tick()
  expect(state.applied.length===1,'completed write did not reach the parent store exactly once')
  expect(state.applied[0][0][0]===track.filePath&&state.applied[0][1].title==='After','completed write lost its paths or patch')
  expect(document.querySelector('.tag-manager')===editor,'write completion replaced the editor')
  expect(editor.querySelector('.tag-manager-live').textContent.includes('已成功 1 项'),'write results were lost')
  expect(!editor.querySelector('[aria-label="关闭标签管理"]').disabled,'settled write kept the editor locked')
}
window.checkEditorExit=async()=>{
  await tick()
  expect(!document.querySelector('.tag-manager'),'idle native Escape did not leave the tag editor')
  expect(dialog.open&&document.querySelector('#track-info-title'),'leaving the editor did not preserve song information')
  expect(dialog.getAttribute('aria-labelledby')==='track-info-title'&&document.getElementById('track-info-title')?.matches('h2')&&document.getElementById('track-info-title').textContent.trim(),'returned song information has no effective heading reference')
  expect(state.closeCount===0&&state.applied.length===1&&state.writes.length===1,'leaving the editor closed its parent or repeated the write')
}
window.reopenEditor=async()=>{
  const edit=[...dialog.querySelectorAll('button')].find(button=>button.textContent.trim()==='编辑歌曲信息')
  edit.focus();edit.click();await tick()
  editor=document.querySelector('.tag-manager')
  expect(editor&&editor.contains(document.activeElement),'reopened editor did not receive focus')
}
window.checkInfoExit=async()=>{
  await tick()
  expect(!document.querySelector('dialog'),'second Escape did not close song information')
  expect(state.closeCount===1,'song information emitted duplicate close events')
  expect(document.activeElement===document.getElementById('track-info-opener'),'native dialog did not restore the original opener')
}
`

const runner = `const {app,BrowserWindow}=require('electron')
const path=require('node:path')
app.setPath('userData',path.join(__dirname,'profile'))
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
  win.webContents.on('console-message',event=>console.error(event.message))
  const run=code=>win.webContents.executeJavaScript(code)
  const escape=async()=>{
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'})
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'})
    await new Promise(resolve=>setTimeout(resolve,35))
  }
  try{
    await win.loadFile(process.argv.at(-1))
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    win.webContents.focus()
    await run('window.beginPendingWrite()')
    await escape();await run('window.checkInsideEscape()')
    await run('window.checkNativeCancel()')
    await run('window.focusOuterDialog()')
    await escape();await run('window.checkOuterEscape()')
    await escape();await run('window.checkOuterEscape()')
    await run('window.finishWrite();')
    await run('window.focusOuterDialog()')
    await escape();await run('window.checkEditorExit()')
    await run('window.reopenEditor()')
    await escape();await run('window.checkEditorExit()')
    await escape();await run('window.checkInfoExit()')
    console.log('TRACK_INFO_BUSY_CANCEL_OK')
    app.exit(0)
  }catch(error){console.error(error.stack||error);app.exit(1)}
})
`
