import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('inset progress preserves panel clearance, pointer preview and keyboard focus', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-edge-seek-'))
  try {
    const style = compileStyle({
      source: await readFile(new URL('./PlayerBar.css', import.meta.url), 'utf8'),
      filename: 'PlayerBar.css',
      id: 'data-v-test',
      scoped: true
    })
    assert.deepEqual(style.errors, [])
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          vue: require.resolve('vue/dist/vue.runtime.esm-bundler.js'),
          '@renderer': join(workspace, 'src/renderer/src')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'SeekTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="full"><head><style>body{margin:0}.player-bar{margin-top:50px;--te-player-progress-track:#888;--te-player-progress-fill:#ccc;--te-player-time-opacity:0;--te-player-time-surface:transparent}${style.code}</style></head><body><div id="app"></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /EDGE_SEEK_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep))
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `
import {createApp,h,ref,nextTick} from 'vue'
import SeekProgress from '${join(workspace, 'src/renderer/src/components/player-bar/PlayerSeekProgress.vue').replaceAll('\\', '/')}'
const position=ref(30),live=ref(false),duration=ref(150),track=ref(1),seeks=[],events=[]
for(const kind of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture','blur','change'])document.addEventListener(kind,e=>events.push([kind,e.target.className]),true)
const check=(value,message)=>{if(!value)throw Error(message)}
const scoped=(tag,props,children)=>h(tag,{'data-v-test':'',...props},children)
createApp({render:()=>scoped('div',{class:'player-bar'},[
 scoped('div',{class:'player-left'},[scoped('div',{class:'player-cover-slot'},'')]),
 scoped('div',{class:'player-center'},[
  scoped('div',{class:'player-controls'},[scoped('button',{class:'ctrl-btn btn-play'},'Play')]),
  h(SeekProgress,{'data-v-test':'',key:track.value,position:position.value,duration:duration.value,live:live.value,abStart:20,abEnd:50,formatTime:s=>s.toFixed(1),onSeek:s=>{seeks.push(s);position.value=s}})
 ]),scoped('div',{class:'player-right'},'Tools')
])}).mount('#app')
const slider=()=>document.querySelector('.progress-slider')
const frame=()=>document.querySelector('.player-bar').getBoundingClientRect()
window.prepareSeek=async(tone,glass)=>{
 document.documentElement.dataset.theme=tone
 document.querySelector('.player-bar').classList.toggle('player-bar-liquid',glass)
 live.value=false;duration.value=150;position.value=30;track.value++;seeks.length=0
 await nextTick();await new Promise(requestAnimationFrame)
 const rail=slider().getBoundingClientRect(),bar=frame(),line=document.querySelector('.progress-track').getBoundingClientRect()
 const art=document.querySelector('.player-cover-slot').getBoundingClientRect()
 check(bar.bottom-line.bottom>=8,'rail clears the rounded panel bottom')
 check(rail.left-art.right>=12,'seek target clears artwork')
 check(rail.right<bar.right-20,'seek target clears the right rounded corner')
 const controls=document.querySelector('.player-controls').getBoundingClientRect()
 check(Math.abs((rail.left+rail.right)/2-(controls.left+controls.right)/2)<1,'seek rail stays centered below transport')
 check(line.top-controls.bottom>=8,'seek rail has breathing room below transport')
 check(rail.height>=20,'thin visual retains a large hit area')
 check(line.height<=3.1,'idle rail is thin')
 window.startFrame={top:bar.top,height:bar.height}
 return {x:rail.left+rail.width*.4,y:rail.top+rail.height/2,left:rail.left,width:rail.width}
}
window.checkHover=()=>{
 const bar=frame(),line=document.querySelector('.progress-track').getBoundingClientRect()
 check(line.height>=4.9&&line.height<=5.1,'hover expands the rail without an oversized line')
 check(bar.bottom-line.bottom>=8,'hover preserves bottom clearance')
 check(Math.abs(bar.height-window.startFrame.height)<.1&&Math.abs(bar.top-window.startFrame.top)<.1,'hover causes no layout shift')
}
window.checkDrag=async()=>{
 check(seeks.length===0,'pointer moves must not repeatedly seek the engine')
 const input=slider(),value=Number(input.value)
 check(value>59&&value<66,'native thumb follows the small pointer movement')
 position.value=31;await nextTick()
 check(Number(input.value)===value,'playback tick cannot rewind a dragged thumb')
 const fill=document.querySelector('.progress-fill'),scale=new DOMMatrix(getComputedStyle(fill).transform).a
 check(Math.abs(scale-value/150)<.001,'drag fill follows immediately without playback smoothing')
 check(Math.abs(frame().height-window.startFrame.height)<.1,'drag preserves bar geometry')
 check(!document.querySelector('.progress-area').classList.contains('is-keyboard-focus'),'pointer drag has no keyboard focus frame')
 check(getComputedStyle(input).outlineStyle==='none','pointer drag has no rectangular outline')
 return value
}
window.checkCommit=async(value)=>{
 await nextTick();check(seeks.length===1,'release commits exactly one seek: '+JSON.stringify({seeks,events}))
 check(Math.abs(seeks[0]-value)<.2,'release commits the final pointer value')
 slider().focus()
}
window.checkKeyboard=()=>{
 check(seeks.length===2,'keyboard seek remains available')
 check(document.querySelector('.progress-area').classList.contains('is-keyboard-focus'),'keyboard focus remains discoverable')
 check(getComputedStyle(document.querySelector('.progress-track')).outlineStyle==='solid','keyboard focus marks the rounded track')
}
window.checkDisabled=async()=>{
 live.value=true;await nextTick();check(slider().disabled,'live stream disables seeking')
 live.value=false;duration.value=0;await nextTick();check(slider().disabled,'unknown duration disables seeking')
 duration.value=150;await nextTick();const input=slider()
 input.value='80';input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
 input.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));await nextTick()
 check(seeks.length===2,'canceled drag must not seek')
 input.value='90';input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()
 track.value++;position.value=0;await nextTick();check(Number(slider().value)===0,'track switch discards old preview')
 document.documentElement.dataset.teMotion='off'
 check(getComputedStyle(document.querySelector('.progress-track')).transitionDuration==='0s','reduced motion disables rail animation')
 document.documentElement.dataset.teMotion='full'
}
`

const runner = `const {app,BrowserWindow}=require('electron')
const wait=ms=>new Promise(r=>setTimeout(r,ms))
app.setPath('userData',require('node:path').join(__dirname,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:500,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)})
 try{
  await win.loadFile(process.argv.at(-1))
  const run=script=>win.webContents.executeJavaScript(script)
  for(const width of [1380,760])for(const tone of ['light','dark'])for(const glass of [false,true]){
   win.setSize(width,500);win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0});await wait(180)
   const rail=await run('window.prepareSeek('+JSON.stringify(tone)+','+glass+')')
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rail.x),y:Math.round(rail.y)});await wait(300)
   await run('window.checkHover()')
   win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(rail.x),y:Math.round(rail.y)});await wait(20)
   for(const fraction of [.401,.404,.409,.417,.425]){
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rail.left+rail.width*fraction),y:Math.round(rail.y)});await wait(16)
   }
   win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rail.left+rail.width*.425),y:Math.round(rail.y-100)});await wait(20)
   const value=await run('window.checkDrag()')
   win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(rail.left+rail.width*.425),y:Math.round(rail.y-100)});await wait(30)
   await run('window.checkCommit('+value+')')
   win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait(30)
   await run('window.checkKeyboard()');await run('window.checkDisabled()')
  }
  console.log('EDGE_SEEK_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`
