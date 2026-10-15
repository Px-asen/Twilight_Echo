import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

test('DSP nodes support native keyboard selection, reordering and nested controls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-graph-keyboard-'))
  try {
    const page = await readFile(
      join(workspace, 'src/renderer/src/components/DspRackPage.vue'),
      'utf8'
    )
    const move = page.slice(
      page.indexOf('function moveNode('),
      page.indexOf('async function refreshDiagnostics(')
    )
    await writeFile(join(directory, 'entry.ts'), runtime.replace('/* MOVE_NODE */', move))
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
          name: 'GraphKeyboard',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}</head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `
const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:960,height:720,webPreferences:{offscreen:true,backgroundThrottling:false}})
 const run=code=>win.webContents.executeJavaScript(code)
 const key=async(keyCode,modifiers=[])=>{for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode,modifiers});await run('window.tick()')}
 try {await win.loadFile(__dirname+'/index.html');win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});win.webContents.focus()
  await run('window.prepareGraph()');await key('Enter');await run('window.assertGraph("selected")')
  await key('Down');await run('window.assertGraph("focus-only")');await key('Space');await run('window.assertGraph("second-selected")')
  await key('Up',['alt']);await run('window.assertGraph("reordered")')
  await key('Up',['alt']);await run('window.assertGraph("first-boundary")')
  await run('document.activeElement.querySelector("button").focus()');await key('Space');await run('window.assertGraph("nested")')
  console.log('GRAPH_KEYBOARD_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      env,
      windowsHide: true,
      timeout: 60_000
    })
    assert.match(result.stdout, /GRAPH_KEYBOARD_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import '@renderer/assets/base.css'
import {createApp,h,nextTick,ref} from 'vue'
import Canvas from '@renderer/components/dsp-rack/DspGraphCanvas.vue'
const selectedScene=ref({id:'test',name:'Test',enabled:true,priority:0,rules:{},graph:{version:2,nodes:[{id:'one',type:'replayGain',enabled:true,params:{}},{id:'two',type:'equalizer',enabled:true,params:{}}],outputStage:{targetSampleRate:'device',resamplerQuality:'native',dither:'off',safetyClamp:true}}})
const selected=ref(null);let selections=0
/* MOVE_NODE */
const check=(value,message)=>{if(!value)throw Error(message)}
window.tick=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(resolve))}
createApp({setup:()=>()=>h(Canvas,{scene:selectedScene.value,nodeTypeToAdd:'equalizer',selectedNodeId:selected.value,busy:false,isPinned:false,snapshotA:false,state:null,vst3HelpersNotice:'',soxrFallbackActive:false,onSelectNode:id=>{selected.value=id;selections++},onMoveNode:moveNode})}).mount('#app')
window.prepareGraph=async()=>{await window.tick();document.querySelector('.graph-node').focus()}
window.assertGraph=async state=>{await window.tick();const active=document.activeElement,nodes=selectedScene.value.graph.nodes
 if(state==='selected')check(selected.value==='one'&&selections===1,'Enter selects the focused node once')
 if(state==='focus-only')check(active.getAttribute('aria-label').includes('参数均衡器')&&selected.value==='one','arrows move focus without changing selected parameters')
 if(state==='second-selected')check(selected.value==='two'&&selections===2,'Space selects the focused node')
 if(state==='reordered')check(nodes[0].id==='two'&&active===document.querySelector('.graph-node')&&document.querySelector('[role=status]').textContent.includes('第 1'),'Alt+Up moves the same node and preserves focus and announcement')
 if(state==='first-boundary')check(nodes[0].id==='two'&&selections===2,'boundary navigation is safe')
 if(state==='nested')check(!nodes[0].enabled&&selections===2&&active.tagName==='BUTTON','nested bypass button works without reselecting its row')
}
`
