import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compileStyle } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../../', import.meta.url))

test('content material stays flat while playback optics have bounded work and cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-content-material-'))
  try {
    const base = await readFile(join(root, 'src/renderer/src/assets/base.css'), 'utf8')
    const home = compileStyle({
      source: await readFile(join(root, 'src/renderer/src/components/LocalDashboard.css'), 'utf8'),
      filename: 'Home.css',
      id: 'data-v-content',
      scoped: true
    })
    assert.deepEqual(home.errors, [])
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root,
      plugins: [vue()],
      resolve: {
        alias: { '@renderer': join(root, 'src/renderer/src'), '@shared': join(root, 'src/shared') }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'ContentMaterial',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${base}\n${home.code}
      body{margin:0;background:#17181a}.home{display:block;padding:30px;width:100%}
      .app-shell-player .player-bar-liquid{position:fixed;bottom:14px;left:18px;width:900px;height:80px;border-radius:24px}
      </style></head><body><div id="fixture"></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',require('node:path').join(__dirname,'profile'));
      app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:700,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});
      win.webContents.on('console-message',event=>console.error(event.message));
      try{await win.loadFile(process.argv.at(-1));const result=await win.webContents.executeJavaScript('window.runContentMaterial()');
      console.error('CONTENT_MATERIAL_OK '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error);app.exit(1)}});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, env }
    )
    assert.match(stderr, /CONTENT_MATERIAL_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {h,render,ref,shallowRef,nextTick} from 'vue'
import LiquidGlassDefs from '@renderer/components/LiquidGlassDefs.vue'
import {functionalLiquidGlassSettings,DEFAULT_LIQUID_GLASS,resolveChannelScales,LIQUID_GLASS_TUNING_CHANGED_EVENT} from '@shared/liquidGlass.ts'
import {displacementScaleForRadius} from '@renderer/utils/liquidGlassDisplacement.ts'
const metrics={rasters:0,callbacks:0,liveObservers:0}
const toDataURL=HTMLCanvasElement.prototype.toDataURL
HTMLCanvasElement.prototype.toDataURL=function(...args){metrics.rasters++;return toDataURL.apply(this,args)}
for(const name of ['ResizeObserver','MutationObserver']){
 const Original=window[name]
 window[name]=class extends Original{
  live=false
  constructor(callback){super((...args)=>{metrics.callbacks++;callback(...args)})}
  observe(...args){if(!this.live){this.live=true;metrics.liveObservers++}return super.observe(...args)}
  disconnect(){if(this.live){this.live=false;metrics.liveObservers--}return super.disconnect()}
 }
}
const check=(ok,message)=>{if(!ok)throw Error(message)}
const wait=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,180));await new Promise(requestAnimationFrame)}
const active=ref(false),visible=ref(false)
const host=document.getElementById('fixture')
render(h({setup:()=>()=>h('div',[
 h(LiquidGlassDefs,{active:active.value}),
 h('div',{class:'home','data-v-content':''},Array.from({length:200},(_,index)=>h('article',{class:index===0?'feature-card':'album-card','data-v-content':''},'Music '+index))),
 h('div',{class:'app-shell-player'},visible.value?h('div',{class:'player-bar player-bar-liquid'}):null)
])}),host)
window.runContentMaterial=async()=>{
 await wait()
 check(metrics.rasters===0&&metrics.liveObservers===0,'idle startup must not bake or observe optical surfaces')
 const saved={...DEFAULT_LIQUID_GLASS,coverage:'expanded',homeCards:{...DEFAULT_LIQUID_GLASS.homeCards,enabled:true}}
 const runtime=functionalLiquidGlassSettings(saved)
 check(runtime.coverage==='functional'&&!runtime.homeCards.enabled&&saved.homeCards.enabled,'old settings cannot re-enable content optics or mutate saved preferences')
 for(const tone of ['dark','pureWhite']){
  document.documentElement.dataset.theme=tone
  // Even stale startup attributes cannot restore the retired card recipes.
  document.documentElement.dataset.teHomeLiquidGlass='on';document.documentElement.dataset.teLiquidGlassCoverage='expanded'
  for(const card of document.querySelectorAll('.feature-card,.album-card')){
   const style=getComputedStyle(card),after=getComputedStyle(card,'::after')
   check(style.filter==='none'&&!style.backdropFilter.includes('url(')&&after.filter==='none'&&!after.backdropFilter.includes('url('),'content is distorted')
   check(!after.backgroundImage.includes('radial-gradient')&&after.content==='none','content retains an optical highlight layer')
  }
 }
 active.value=true;await wait()
 check(metrics.rasters===0,'missing playback surface must not bake a nominal raster')
 visible.value=true;await wait()
 check(document.querySelectorAll('filter').length===1&&document.querySelector('#te-lg-playbar'),'only playback optics are mounted')
 check(metrics.rasters===1,'playback activation bakes exactly one map')
 const mutationsBefore={...metrics}
 const cards=document.querySelectorAll('.home article')
 for(let index=0;index<2000;index++){cards[index%200].textContent='Updated '+index;cards[index%200].classList.toggle('selected')}
 document.querySelector('.home').dispatchEvent(new Event('scroll'));window.dispatchEvent(new PointerEvent('pointermove',{clientX:450,clientY:400}))
 await wait()
 check(metrics.rasters===mutationsBefore.rasters&&metrics.callbacks===mutationsBefore.callbacks,'unrelated content/pointer/scroll activity must not touch playback map observers')
 const bar=document.querySelector('.player-bar')
 for(let index=0;index<100;index++)bar.style.width=(800+index)+'px'
 await wait()
 check(metrics.rasters<=3,'resize burst creates unbounded raster work')
 for(let index=0;index<20;index++){active.value=false;await nextTick();active.value=true;await nextTick()}
 await wait()
 check(metrics.liveObservers===2,'material switches duplicate observers')
 active.value=false;await wait()
 check(metrics.liveObservers===0&&!document.querySelector('filter'),'deactivation leaks observers or filter DOM')
 const inactiveRasters=metrics.rasters
 visible.value=false;window.dispatchEvent(new Event('resize'));await wait()
 check(metrics.rasters===inactiveRasters,'inactive surfaces keep generating maps')
 render(null,host);await wait()
 check(metrics.liveObservers===0,'unmount retains optical observers')
 // A teleported preview owns its geometry, tuning, animation frames and window resources.
 const frames=[document.createElement('iframe'),document.createElement('iframe')]
 const documents=frames.map((frame,index)=>{
  document.body.append(frame);const doc=frame.contentDocument
  doc.open();doc.write('<!doctype html><html><head><style>:root{--te-lg-displacement:31;--te-lg-aberration:7}.player-bar{width:'+(413+index*100)+'px;height:64px;border-radius:'+(12+index*8)+'px}</style></head><body><div class="app-shell-player"><div class="player-bar player-bar-liquid"></div></div></body></html>');doc.close()
  return doc
 })
 const windows=documents.map(doc=>doc.defaultView),resources=windows.map(view=>{
  const state={observers:0,listeners:new Map(),frames:new Set()}
  for(const name of ['ResizeObserver','MutationObserver']){
   const Original=view[name];view[name]=class extends Original{
    live=false
    observe(...args){if(!this.live){this.live=true;state.observers++}return super.observe(...args)}
    disconnect(){if(this.live){this.live=false;state.observers--}return super.disconnect()}
   }
  }
  const add=view.addEventListener.bind(view),remove=view.removeEventListener.bind(view),request=view.requestAnimationFrame.bind(view),cancel=view.cancelAnimationFrame.bind(view)
  view.addEventListener=(name,callback,...args)=>{if(name==='resize'||name===LIQUID_GLASS_TUNING_CHANGED_EVENT){if(!state.listeners.has(name))state.listeners.set(name,new Set());state.listeners.get(name).add(callback)}return add(name,callback,...args)}
  view.removeEventListener=(name,callback,...args)=>{state.listeners.get(name)?.delete(callback);return remove(name,callback,...args)}
  view.requestAnimationFrame=callback=>{const handle=request(time=>{state.frames.delete(handle);callback(time)});state.frames.add(handle);return handle}
  view.cancelAnimationFrame=handle=>{state.frames.delete(handle);return cancel(handle)}
  return state
 })
 const targetDocument=shallowRef(documents[0]),theme=ref({...DEFAULT_LIQUID_GLASS.light,displacementScale:68,aberrationIntensity:19})
 const baseline=JSON.stringify(theme.value),parentDisplacement=document.documentElement.style.getPropertyValue('--te-lg-displacement')
 document.documentElement.style.setProperty('--te-lg-displacement','99')
 const parentPlayer=document.createElement('div');parentPlayer.className='app-shell-player';parentPlayer.innerHTML='<div class="player-bar player-bar-liquid" style="width:800px;height:150px;border-radius:50px"></div>';document.body.append(parentPlayer)
 const scale=()=>Number(host.querySelector('feDisplacementMap').getAttribute('scale'))
 const expected=(radius,displacement,aberration)=>resolveChannelScales(displacementScaleForRadius(radius,displacement/100),aberration).red
 const released=state=>state.observers===0&&[...state.listeners.values()].every(listeners=>listeners.size===0)&&state.frames.size===0
 render(h({setup:()=>()=>h(LiquidGlassDefs,{active:true,targetDocument:targetDocument.value,theme:theme.value})}),host);await wait()
 check(scale()===expected(12,68,19)&&host.querySelector('feImage').getAttribute('href').startsWith('data:image/png'),'preview uses host geometry or loses its displacement raster')
 check(resources[0].observers===2&&resources[0].listeners.get(LIQUID_GLASS_TUNING_CHANGED_EVENT)?.size===1&&resources[0].listeners.get('resize')?.size===1&&metrics.liveObservers===0,'preview resources belong to the host window')
 window.dispatchEvent(new Event(LIQUID_GLASS_TUNING_CHANGED_EVENT));await wait()
 check(scale()===expected(12,68,19)&&JSON.stringify(theme.value)===baseline,'host tuning contaminates an explicit preview draft')
 theme.value.displacementScale=31;await wait()
 check(scale()===expected(12,31,19),'reactive draft optics do not update')
 // Leave an old-window frame pending, then move the same instance to another document.
 windows[0].dispatchEvent(new windows[0].Event(LIQUID_GLASS_TUNING_CHANGED_EVENT));targetDocument.value=documents[1];await wait()
 check(released(resources[0])&&resources[1].observers===2&&scale()===expected(20,31,19),'document switch retains old resources or stale geometry')
 const switchedScale=scale();documents[0].querySelector('.player-bar').style.borderRadius='5px';windows[0].dispatchEvent(new windows[0].Event(LIQUID_GLASS_TUNING_CHANGED_EVENT));await wait()
 check(scale()===switchedScale,'detached document still drives preview optics')
 theme.value=undefined;await wait()
 check(scale()===expected(20,31,7),'implicit tuning reads the parent document')
 documents[1].documentElement.style.setProperty('--te-lg-displacement','52');windows[1].dispatchEvent(new windows[1].Event(LIQUID_GLASS_TUNING_CHANGED_EVENT));await wait()
 check(scale()===expected(20,52,7),'target-window tuning event is ignored')
 render(null,host);await wait()
 check(resources.every(released),'cross-document unmount retains observers, listeners or frames')
 parentPlayer.remove();for(const frame of frames)frame.remove();if(parentDisplacement)document.documentElement.style.setProperty('--te-lg-displacement',parentDisplacement);else document.documentElement.style.removeProperty('--te-lg-displacement')
 return {contentCards:200,contentMutations:2000,materialSwitches:40,rasters:metrics.rasters,observersAfterUnmount:metrics.liveObservers,crossDocumentSwitches:1,windowResourcesAfterUnmount:resources.map(state=>state.observers)}
}
`
