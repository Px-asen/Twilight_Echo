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
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

// Keep the rendered components real while excluding playback and library I/O.
const serviceStubs = `import {ref} from 'vue'
const radio={error:ref(''),stations:ref([{id:'fixture-station',name:'Fixture radio',streamUrl:'https://example.invalid/stream'}]),ensureLoaded:async()=>{}}
const podcast={error:ref(''),busy:ref(false),subscriptions:ref([]),ensureLoaded:async()=>{}}
export const useRadioStore=()=>radio
export const radioStationToTrack=station=>station
export const usePodcastStore=()=>podcast
export const podcastEpisodeToTrack=episode=>episode
export const usePlayerStore=()=>({playTrack:async()=>{},playTrackFromPosition:async()=>{}})
export const useAppNoticeStore=()=>({pushNotice:()=>{}})
`

const focusFixture = `<script setup lang="ts">
import AlbumDetailHeader from '@renderer/components/song-list/AlbumDetailHeader.vue'
import RadioPodcastPage from '@renderer/components/RadioPodcastPage.vue'
import PlayerSeekProgress from '@renderer/components/player-bar/PlayerSeekProgress.vue'
const album={id:'focus-album',name:'Keyboard focus album',artist:'Fixture artist',trackCount:1}
const variants=['default','mini','compact']
const formatTime=(value:number)=>Math.floor(value/60)+':'+String(Math.floor(value%60)).padStart(2,'0')
</script>
<template>
 <AlbumDetailHeader :album="album" duration-text="3:00" :can-play="true" />
 <RadioPodcastPage />
 <div v-for="variant in variants" :key="variant" class="player-bar fixture-player-bar" :class="variant==='default'?'':('player-bar-'+variant)">
  <PlayerSeekProgress :id="'focus-seek-'+variant" :variant="variant" :position="30" :duration="180" :live="false" :ab-start="null" :ab-end="null" :format-time="formatTime" />
 </div>
</template>
<style scoped src="__PLAYER_BAR_STYLE__"></style>
<style scoped>
.fixture-player-bar{position:relative!important;inset:auto!important;display:block!important;width:520px!important;max-width:100%!important;height:auto!important;min-height:64px;margin:24px!important;padding:20px!important;background:var(--te-card-bg)!important}
.fixture-player-bar :deep(.player-seek-progress){position:relative!important;inset:auto!important;display:flex;width:100%;height:32px}
</style>
`

test('real controls preserve readable accent text and stable keyboard focus across covers and tones', async () => {
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
    await writeFile(
      join(directory, 'FocusFixture.vue'),
      focusFixture.replace(
        '__PLAYER_BAR_STYLE__',
        join(workspace, 'src/renderer/src/components/player-bar/PlayerBar.css').replaceAll(
          '\\',
          '/'
        )
      )
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [
        {
          name: 'ui-primitives-services',
          enforce: 'pre',
          resolveId(source) {
            if (/\/stores\/use(Radio|Podcast|Player|AppNotice)Store(?:\.ts)?$/.test(source)) {
              return '\0ui-primitives-' + source.match(/use(\w+)Store/)![1]
            }
            return null
          },
          load(id) {
            if (id.startsWith('\0ui-primitives-')) return serviceStubs
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          '@shared': join(workspace, 'src/shared'),
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
          name: 'UiPrimitivesTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    const cssFiles = (await readdir(join(directory, 'bundle'))).filter((file) =>
      file.endsWith('.css')
    )
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8"><style>${sources.join('\n')}</style><style>
body{padding:24px}.settings-preview-page,.onboarding-wizard{position:static;inset:auto;height:auto;padding:16px;z-index:auto}
.settings-preview-layout{display:block}.fixture-card{padding:16px;background:var(--te-card-bg)}
</style>${cssFiles.map((file) => `<link rel="stylesheet" href="bundle/${file}">`).join('')}</head><body>
<main class="settings-preview-page"><div class="settings-preview-layout"><div class="fixture-card">
<div class="setting-item"><button id="primary" class="primary-button">打开主题创意工坊</button><button id="brand" class="brand-soft-button">应用设置</button><button id="pill" class="pill-action">管理</button></div>
<div class="setting-item"><div class="segmented-control"><button id="segment">跟随系统</button></div><button id="settings-off" class="toggle-switch inactive" role="switch" aria-checked="false"></button><input id="checkbox" type="checkbox" checked></div>
</div></div></main>
<div class="fixture-card"><div id="menu" class="menu-item">添加到播放队列</div><span id="badge" style="font-size:var(--te-badge-font-size)">Beta</span></div>
<section class="onboarding-wizard"><div class="fixture-card"><button id="onboarding-off" class="onb-toggle" role="switch" aria-checked="false"></button></div></section>
<div id="component-fixtures"></div>
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
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'})
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'})
  await win.webContents.executeJavaScript('window.runUiPrimitiveTests()')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]})
  await win.webContents.executeJavaScript('window.runForcedFocusTests()')
  console.log('UI_PRIMITIVES_OK');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`

const runtime = `import {bootstrapThemeRuntime,useThemeStore,applyActiveTheme} from '@renderer/stores/useThemeStore.ts'
import {createApp,nextTick} from 'vue'
import FocusFixture from './FocusFixture.vue'
import {hasDismissLayer} from '@renderer/app/useDismissLayer.ts'
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
const color=value=>{const probe=document.createElement('i');probe.style.color=value;document.body.append(probe);const result=getComputedStyle(probe).color;probe.remove();return result}
const focusTargets=()=>[
 {name:'shared primary',element:document.getElementById('primary')},
 {name:'album play',element:document.querySelector('.album-play-primary')},
 {name:'radio active tab',element:document.querySelector('.radio-podcast-page .tabs button.active')},
 {name:'radio add',element:document.getElementById('radio-tool-add')},
 ...['default','mini','compact'].map(variant=>{
  const root=document.getElementById('focus-seek-'+variant)
  return {name:variant+' seek',element:root.querySelector('input'),ring:root.querySelector(variant==='default'?'.progress-track':'.'+variant+'-progress-track')}
 })
]
async function checkFocus(tone,label,forced=false){
 const expected=color(forced?'Highlight':tone==='dark'?'#60cdff':'#0067c0')
 for(const target of focusTargets()){
  target.element.focus({preventScroll:true})
  await nextTick()
  expect(document.activeElement===target.element,label+': '+target.name+' did not receive focus')
  expect(target.element.matches(':focus-visible'),label+': '+target.name+' has no keyboard focus state')
  const actual=getComputedStyle(target.ring??target.element)
  expect(actual.outlineStyle==='solid'&&parseFloat(actual.outlineWidth)>=2,label+': '+target.name+' has no visible focus outline')
  expect(actual.outlineColor===expected,label+': '+target.name+' focus '+actual.outlineColor+' expected '+expected)
  if(!forced){
   const canvas=getComputedStyle(document.querySelector('.fixture-card')).backgroundColor
   expect(ratio(actual.outlineColor,canvas,canvas)>=3,label+': '+target.name+' focus contrast below 3')
  }
 }
}
window.runUiPrimitiveTests=async()=>{
 await bootstrapThemeRuntime({systemTone:'pureWhite',settings:{settings:settings('pureWhite','blue')},themeBootstrap:{library:{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}}})
 createApp(FocusFixture).mount('#component-fixtures')
 await nextTick()
 let pageBackCount=0
 const pageBack=event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!hasDismissLayer())pageBackCount++}
 window.addEventListener('keydown',pageBack)
 for(const id of ['add','import','discover']){
  const trigger=document.getElementById('radio-tool-'+id)
  trigger.click()
  await nextTick()
  expect(hasDismissLayer(),'radio '+id+': open disclosure must intercept page back')
  document.activeElement?.blur()
  document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
  await nextTick()
  expect(trigger.getAttribute('aria-expanded')==='false','radio '+id+': Escape did not close disclosure')
  expect(document.activeElement===trigger,'radio '+id+': focus did not return to trigger')
  expect(!hasDismissLayer(),'radio '+id+': dismissed disclosure retained Escape ownership')
 }
 document.querySelectorAll('.radio-podcast-page .tabs button')[1].click()
 await nextTick()
 const subscribe=document.getElementById('podcast-tool-subscribe')
 subscribe.click()
 await nextTick()
 document.getElementById('podcast-feed-url').focus()
 document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))
 await nextTick()
 expect(subscribe.getAttribute('aria-expanded')==='false','podcast: Escape did not close subscription form')
 expect(document.activeElement===subscribe,'podcast: focus did not return to subscription trigger')
 expect(!hasDismissLayer()&&pageBackCount===0,'disclosure Escape unexpectedly navigated away')
 window.removeEventListener('keydown',pageBack)
 document.querySelectorAll('.radio-podcast-page .tabs button')[0].click()
 await nextTick()
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
   for(const selector of ['.album-play-primary','.radio-podcast-page .tabs button.active','.radio-podcast-page .wide-action','.radio-podcast-page .station-actions .primary']){
    const button=document.querySelector(selector)
    expect(button&&!button.disabled,tone+'/'+accent+': actual button missing '+selector)
    const actual=getComputedStyle(button)
    expect(ratio(actual.color,actual.backgroundColor,canvas)>=4.5,tone+'/'+accent+': actual '+selector+' text contrast')
   }
   const hoverBackground='rgba('+getComputedStyle(document.documentElement).getPropertyValue('--te-primary-rgb').trim()+', 0.16)'
   expect(ratio(brand.color,hoverBackground,canvas)>=4.5,tone+'/'+accent+': soft-button hover text contrast')
   await checkFocus(tone,tone+'/'+accent)
  }
  const coverProfile=store.createProfile('Focus cover fixture')
  coverProfile.modes={appearance:{accentSource:'cover'}}
  await store.preview(coverProfile)
  const indicators=new Set()
  for(const cover of ['#ffff00','#0000ff','#ff0000','#00ff00']){
   document.querySelectorAll('.fixture-player-bar').forEach(element=>element.style.setProperty('--accent-color',cover))
   await store.setAdaptiveMedia({identity:'focus:'+tone+':'+cover,accentColor:cover,coverUrl:''})
   await settle()
   indicators.add(getComputedStyle(document.documentElement).getPropertyValue('--te-navigation-indicator').trim())
   await checkFocus(tone,tone+'/cover '+cover)
  }
  expect(indicators.size>1,tone+': cover fixture did not exercise changing accent colors')
  await store.preview(null)
  for(const size of [12,14,20]){
   document.documentElement.style.setProperty('--te-font-size-body',size+'px','important')
   await settle()
   for(const [id,roleSize] of [['segment',15],['menu',15],['badge',12]]){
    const actual=parseFloat(style(id).fontSize),expected=size*roleSize/14
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
window.runForcedFocusTests=async()=>{
 expect(matchMedia('(forced-colors: active)').matches,'forced-colors emulation was not active')
 for(const tone of ['pureWhite','dark']){
  settingsChanged({settings:settings(tone,'amber')})
  await applyActiveTheme(false)
  await settle()
  await checkFocus(tone,tone+'/forced-colors',true)
 }
}
`
