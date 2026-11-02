import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('shared controls scale with typography and stay readable across saved accent colors and tones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-ui-primitives-'))
  try {
    const sources = await Promise.all(
      [
        '../assets/base.css',
        './settings-page/SettingsPage.css',
        './song-list/SongList.css',
        './onboarding/OnboardingWizard.css'
      ].map((file) => readFile(new URL(file, import.meta.url), 'utf8'))
    )
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          '@shared': join(workspace, 'src/shared')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'UiPrimitivesTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8"><style>${sources.join('\n')}</style><style>
body{padding:24px}.settings-preview-page,.onboarding-wizard{position:static;inset:auto;height:auto;padding:16px;z-index:auto}
.settings-preview-layout{display:block}.fixture-card{padding:16px;background:var(--te-card-bg)}
</style></head><body>
<main class="settings-preview-page"><div class="settings-preview-layout"><div class="fixture-card">
<div class="setting-item"><button id="primary" class="primary-button">打开自定义主题</button><button id="brand" class="brand-soft-button">应用设置</button><button id="pill" class="pill-action">管理</button></div>
<div class="setting-item"><div class="segmented-control"><button id="segment">跟随系统</button></div><button id="settings-off" class="toggle-switch inactive" role="switch" aria-checked="false"></button><input id="checkbox" type="checkbox" checked></div>
</div></div></main>
<div class="fixture-card"><div id="menu" class="menu-item">添加到播放队列</div><span id="badge" style="font-size:var(--te-badge-font-size)">Beta</span></div>
<section class="onboarding-wizard"><div class="fixture-card"><button id="onboarding-off" class="onb-toggle" role="switch" aria-checked="false"></button></div></section>
<script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /UI_PRIMITIVES_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `const {app,BrowserWindow}=require('electron')
app.setPath('userData',require('node:path').join(__dirname,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1100,height:760,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}})
 try{
  await win.loadFile(process.argv.at(-1))
  await win.webContents.executeJavaScript('window.runUiPrimitiveTests()')
  console.log('UI_PRIMITIVES_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`

const runtime = `import {bootstrapThemeRuntime,useThemeStore,applyActiveTheme} from '@renderer/stores/useThemeStore.ts'
import {createDefaultThemeLibraryDocument,themeContrastRatio} from '@shared/theme.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
let settingsChanged
window.api={
 settings:{onChanged:listener=>{settingsChanged=listener;return()=>{}}},
 plugins:{onChanged:()=>()=>{}},
 themes:{onChanged:()=>()=>{},onSystemToneChanged:()=>()=>{}}
}
const settings=(tone,accent)=>({theme:tone,accentColor:accent,lightAccentColor:accent,darkAccentColor:accent,uiDensity:'comfortable'})
const store=useThemeStore()
const style=id=>getComputedStyle(document.getElementById(id))
const ratio=(foreground,background,canvas)=>themeContrastRatio(foreground,background,canvas)??0
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,250));for(let i=0;i<3;i++)await new Promise(resolve=>requestAnimationFrame(resolve))}
window.runUiPrimitiveTests=async()=>{
 await bootstrapThemeRuntime({systemTone:'pureWhite',settings:{settings:settings('pureWhite','blue')},themeBootstrap:{library:{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}}})
 for(const tone of ['pureWhite','dark']){
  for(const accent of ['blue','violet','emerald','rose','amber','slate']){
   settingsChanged({settings:settings(tone,accent)})
   await applyActiveTheme(false)
   await settle()
   const primary=style('primary'),brand=style('brand'),canvas=getComputedStyle(document.querySelector('.fixture-card')).backgroundColor
   const primaryRatio=ratio(primary.color,primary.backgroundColor,canvas)
   const brandRatio=ratio(brand.color,brand.backgroundColor,canvas)
   expect(primaryRatio>=4.5,tone+'/'+accent+': primary text contrast '+primaryRatio)
   expect(brandRatio>=4.5,tone+'/'+accent+': soft-button text contrast '+brandRatio)
   const pill=style('pill')
   expect(ratio(pill.color,pill.backgroundColor,canvas)>=4.5,tone+'/'+accent+': pill-action text contrast')
   const hoverBackground='rgba('+getComputedStyle(document.documentElement).getPropertyValue('--te-primary-rgb').trim()+', 0.16)'
   expect(ratio(brand.color,hoverBackground,canvas)>=4.5,tone+'/'+accent+': soft-button hover text contrast')
  }
  for(const size of [12,14,20]){
   document.documentElement.style.setProperty('--te-font-size-body',size+'px','important')
   await settle()
   for(const id of ['segment','menu','badge']){
    const actual=parseFloat(style(id).fontSize),expected=size*12/14
    expect(Math.abs(actual-expected)<0.02,tone+': '+id+' font '+actual+' expected '+expected)
   }
  }
  document.documentElement.style.removeProperty('--te-font-size-body')
  const checkbox=style('checkbox')
  expect(checkbox.appearance==='none'&&checkbox.borderRadius==='3px','retain Pxasen custom checkbox geometry')
  expect(getComputedStyle(document.documentElement).getPropertyValue('--te-dialog-radius').trim()==='8px','retain Pxasen dialog radius default')
  if(tone==='dark'){
   for(const id of ['settings-off','onboarding-off']){
    const track=style(id),thumb=getComputedStyle(document.getElementById(id),'::after')
    expect(ratio(thumb.backgroundColor,track.backgroundColor,'#181818')>=3,id+': dark inactive switch thumb is distinguishable')
   }
  }
 }
}
`
