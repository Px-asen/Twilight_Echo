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
    const home = compileStyle({ source: await readFile(join(root, 'src/renderer/src/components/LocalDashboard.css'), 'utf8'), filename: 'Home.css', id: 'data-v-content', scoped: true })
    assert.deepEqual(home.errors, [])
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({ configFile: false, logLevel: 'error', root, plugins: [vue()],
      resolve: { alias: { '@renderer': join(root, 'src/renderer/src'), '@shared': join(root, 'src/shared') } },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: { outDir: join(directory, 'bundle'), emptyOutDir: true,
        lib: { entry: join(directory, 'entry.ts'), name: 'ContentMaterial', formats: ['iife'], fileName: () => 'runtime.js' } } })
    await writeFile(join(directory, 'index.html'), `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><style>${base}\n${home.code}
      body{margin:0;background:#17181a}.home{display:block;padding:30px;width:100%}
      .app-shell-player .player-bar-liquid{position:fixed;bottom:14px;left:18px;width:900px;height:80px;border-radius:24px}
      </style></head><body><div id="fixture"></div><script src="bundle/runtime.js"></script></body></html>`)
    await writeFile(join(directory, 'runner.cjs'), `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',require('node:path').join(__dirname,'profile'));
      app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:700,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});
      win.webContents.on('console-message',event=>console.error(event.message));
      try{await win.loadFile(process.argv.at(-1));const result=await win.webContents.executeJavaScript('window.runContentMaterial()');
      console.error('CONTENT_MATERIAL_OK '+JSON.stringify(result));app.exit(0)}catch(error){console.error(error);app.exit(1)}});`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const { stderr } = await promisify(execFile)(require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')], { windowsHide: true, timeout: 60_000, env })
    assert.match(stderr, /CONTENT_MATERIAL_OK/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

const runtime = `import {h,render,ref,nextTick} from 'vue'
import LiquidGlassDefs from '@renderer/components/LiquidGlassDefs.vue'
import {functionalLiquidGlassSettings,DEFAULT_LIQUID_GLASS} from '@shared/liquidGlass.ts'
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
 return {contentCards:200,contentMutations:2000,materialSwitches:40,rasters:metrics.rasters,observersAfterUnmount:metrics.liveObservers}
}
`
