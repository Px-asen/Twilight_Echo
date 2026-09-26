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

test('DSP audition panel waits for measurement and ACK, invalidates edits and restores on unmount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-audition-ui-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(
      join(directory, 'player.ts'),
      "import {shallowRef} from 'vue'; export const currentTrack=shallowRef({id:'local',source:'local',filePath:'D:/music/test.wav',title:'Test',duration:120}); export const usePlayerStore=()=>({currentTrack})"
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer/stores/usePlayerStore': join(directory, 'player.ts'),
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
          name: 'VersionsTest',
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
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.webContents.on('console-message',(_e,_l,message)=>console.error(message));try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runAuditionTests()');if(process.env.TWILIGHT_AUDITION_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_AUDITION_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('AUDITION_UI_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /AUDITION_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import '@renderer/assets/base.css'
import {createApp,h,nextTick,ref} from 'vue'
import Panel from '@renderer/components/dsp-rack/DspAuditionPanel.vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,20));await nextTick()}
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim().startsWith(text))
const click=async text=>{const el=button(text);expect(el&&!el.disabled,'button unavailable: '+text);el.click();await tick()}
window.runAuditionTests=async()=>{
  let resolveMeasure,resolveSelect,ends=0,selected=null
  const measured={id:'session',a:{integratedLufs:-14,truePeakDb:-2,processingVersion:1},b:{integratedLufs:-20,truePeakDb:-8,processingVersion:1},gainA:-6,gainB:0,targetLufs:-20,selected:null}
  window.api={audioEngine:{audition:{measure:()=>new Promise(resolve=>resolveMeasure=resolve),select:(_id,side)=>new Promise(resolve=>resolveSelect=()=>{selected=side;resolve({...measured,selected:side})}),end:async()=>{ends++},status:async()=>({...measured,selected})}}}
  const graph=()=>({version:2,nodes:[],outputStage:{targetSampleRate:'device',resamplerQuality:'native',dither:'off',safetyClamp:true}})
  const a=ref(null),b=ref(graph())
  const app=createApp({setup:()=>()=>h(Panel,{a:a.value,b:b.value})});app.mount('#app');await tick()
  expect(button('测量并匹配').disabled,'snapshot A required')
  a.value=graph();await tick();await click('测量并匹配')
  expect(!button('A ·'),'no matched controls before measurement')
  await click('取消 / 退出');resolveMeasure(measured);await tick()
  expect(!button('A ·'),'late cancelled result is ignored')
  await click('测量并匹配');resolveMeasure(measured);await tick()
  expect(document.querySelector('[role=status]').textContent.includes('已匹配'),'show verified match')
  await click('B ·')
  expect(button('B ·').getAttribute('aria-pressed')==='false','selection awaits ACK')
  resolveSelect();await tick()
  expect(button('B ·').getAttribute('aria-pressed')==='true','ACK selects B')
  b.value={...graph(),nodes:[{id:'eq',type:'equalizer',enabled:true,params:{mode:'parametric',preampDb:-3,bands:[]}}]};await tick()
  expect(!button('A ·'),'editing B invalidates old result')
  expect(document.querySelector('[role=status]').textContent.includes('失效'),'explain invalidation')
  await click('测量并匹配');resolveMeasure(measured);await tick()
  const before=ends;app.unmount();await tick();expect(ends>before,'unmount restores original graph')
  createApp({setup:()=>()=>h(Panel,{a:graph(),b:b.value})}).mount('#app');await tick()
}
`
