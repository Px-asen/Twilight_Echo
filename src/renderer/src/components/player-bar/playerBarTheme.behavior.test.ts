import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('saved theme colors reach the dashboard and player controls across tones and bar modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-player-theme-'))
  try {
    const dashboardProgress = await readFile(
      new URL('../local-dashboard/DashboardPlaybackProgress.vue', import.meta.url),
      'utf8'
    )
    const baseStyles = await readFile(new URL('../../assets/base.css', import.meta.url), 'utf8')
    const sources = [
      await readFile(new URL('./PlayerBar.css', import.meta.url), 'utf8'),
      await readFile(new URL('../LocalDashboard.css', import.meta.url), 'utf8'),
      await readFile(new URL('../streaming-page/ProviderMusicHome.css', import.meta.url), 'utf8'),
      parse(dashboardProgress).descriptor.styles[0].content,
      parse(await readFile(new URL('../TitleBar.vue', import.meta.url), 'utf8')).descriptor
        .styles[0].content,
      parse(await readFile(new URL('../icons/PlaybackIcon.vue', import.meta.url), 'utf8'))
        .descriptor.styles[0].content,
      parse(await readFile(new URL('../SideMenu.vue', import.meta.url), 'utf8')).descriptor
        .styles[0].content,
      ...parse(
        await readFile(new URL('../../App.vue', import.meta.url), 'utf8')
      ).descriptor.styles.map((style) => style.content)
    ]
    const styles = sources.map((source) => {
      const style = compileStyle({
        source: source.replace(/^\uFEFF/, ''),
        filename: 'Playback.css',
        id: 'data-v-test',
        scoped: true
      })
      assert.deepEqual(style.errors, [])
      return style.code
    })
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          vue: require.resolve('vue/dist/vue.runtime.esm-bundler.js'),
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
          name: 'PlayerThemeTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyles}\n${styles.join('\n')}</style></head><body><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron')
app.setPath('userData',require('node:path').join(__dirname,'profile'))
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
  win.webContents.on('console-message',event=>console.error(event.message))
  try{
    await win.loadFile(process.argv.at(-1))
    await win.webContents.executeJavaScript('window.runPlayerThemeTests()')
    for(const width of [1380,900,760]){
      win.setSize(width,900)
      await win.webContents.executeJavaScript('window.checkStandardPlayerGeometry()')
    }
    for(const width of [760,960,1380,1920]){
      win.setSize(width,900)
      await new Promise(resolve=>setTimeout(resolve,100))
      await win.webContents.executeJavaScript('window.checkNavigationProportions()')
    }
    win.setSize(1380,900)
    for(const tone of ['pureWhite','dark'])for(const mode of ['standard','mini','compact','dashboard'])for(const glass of [false,true]){
      const rect=await win.webContents.executeJavaScript('window.preparePlayerThemeHover('+JSON.stringify(tone)+','+JSON.stringify(mode)+','+glass+')')
      win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rect.x),y:Math.round(rect.y)})
      await new Promise(resolve=>setTimeout(resolve,300))
      await win.webContents.executeJavaScript('window.checkPlayerThemeHover()')
      win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0})
    }
    win.setSize(1380,900)
    await win.webContents.executeJavaScript('window.checkSharedPlaybackGlyphs()')
    await win.webContents.executeJavaScript('window.checkSidebarTransition()')
    for(const kind of ['settings','plugins','menu','close']){
      const rect=await win.webContents.executeJavaScript('window.prepareDarkTitlebarControl('+JSON.stringify(kind)+')')
      win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(rect.x),y:Math.round(rect.y)})
      await new Promise(resolve=>setTimeout(resolve,200))
      await win.webContents.executeJavaScript('window.checkDarkTitlebarControl('+JSON.stringify(kind)+')')
      win.webContents.sendInputEvent({type:'mouseMove',x:300,y:200})
    }
    await win.loadFile(process.argv.at(-1))
    await win.webContents.executeJavaScript('window.checkReloadedPlayerTheme()')
    console.log('PLAYER_THEME_COLORS_OK')
    app.exit(0)
  }catch(error){console.error(error.stack);app.exit(1)}
})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /PLAYER_THEME_COLORS_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {h,render} from 'vue'
import PlaybackIcon from '@renderer/components/icons/PlaybackIcon.vue'
import {bootstrapThemeRuntime,useThemeStore} from '@renderer/stores/useThemeStore.ts'
import {createDefaultThemeLibraryDocument,normalizeThemeProfile} from '@shared/theme.ts'
const storageKey='player-theme-test-library'
let library=JSON.parse(localStorage.getItem(storageKey)||'null')||{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}
const expect=(value,message)=>{if(!value)throw new Error(message)}
const commit=(data,revision)=>{
  expect(revision===library.revision,'write uses the current library revision')
  library={...library,revision:revision+1,savedAt:new Date().toISOString(),data}
  localStorage.setItem(storageKey,JSON.stringify(library))
  return structuredClone(library)
}
window.api={
  settings:{onChanged:()=>()=>{}},
  plugins:{onChanged:()=>()=>{}},
  themes:{
    onChanged:()=>()=>{},onSystemToneChanged:()=>()=>{},
    save:async(profile,revision)=>{
      const normalized=normalizeThemeProfile(structuredClone(profile))
      expect(normalized,'saved theme profile is valid')
      return commit({...library.data,profiles:[normalized]},revision)
    },
    setActive:async(activeTheme,revision)=>commit({...library.data,activeTheme},revision)
  }
}
const boot=()=>bootstrapThemeRuntime({systemTone:'pureWhite',settings:{settings:{theme:'pureWhite',accentColor:'blue',lightAccentColor:'blue',darkAccentColor:'blue',uiDensity:'comfortable'}},themeBootstrap:{library}})
const store=useThemeStore()
const colors={
  pureWhite:{'playback.progress.track':'rgba(37, 99, 235, 0.16)','playback.progress.fill':'linear-gradient(270deg, rgba(37, 99, 235, 0.58), rgba(240, 128, 230, 0.73))','playback.control.surface':'#654321','playback.control.hoverSurface':'#abcdef','playback.control.text':'#ffffff','playback.control.hoverText':'#112233'},
  dark:{'playback.progress.track':'#345678','playback.progress.fill':'linear-gradient(90deg, #0000ff, #ff00ff)','playback.control.surface':'#876543','playback.control.hoverSurface':'#fedcba','playback.control.text':'#fafafa','playback.control.hoverText':'#223344'}
}
let bar,button,stripButton,hoverTarget,track,fill
const iconHosts=[]
const mountIcon=(host,name)=>{render(null,host);host.replaceChildren();render(h(PlaybackIcon,{name}),host);host.firstElementChild?.setAttribute('data-v-test','');iconHosts.push(host)}
const clear=()=>{
  for(const host of iconHosts)render(null,host)
  iconHosts.length=0
  document.querySelector('.player-bar-shell')?.remove()
  document.querySelector('.home')?.remove()
}
const mount=(mode,glass=false,live=false)=>{
  clear()
  const shell=document.createElement('div')
  shell.className='player-bar-shell'
  shell.dataset.tePlaybarMode=mode
  shell.innerHTML='<div class="player-bar '+(mode==='standard'?'':'player-bar-'+mode)+(glass?' player-bar-glass':'')+'" style="--accent-color:#cc9900;--play-button-color:#cc9900"><div class="player-left"><button class="mini-play-button">Play</button></div><div class="player-center"><div class="player-controls"><button class="ctrl-btn btn-play">Play</button></div><div class="'+(mode==='standard'?'progress-slider-wrap':mode+'-progress-rail')+'"><div class="'+(mode==='standard'?'':mode+'-')+'progress-track"><div class="'+(mode==='standard'?'':mode+'-')+'progress-fill'+(live?' live':'')+'"></div></div></div></div><div class="player-right"></div></div>'
  if(mode==='standard'){
    shell.querySelector('.player-left').innerHTML='<div class="player-cover-slot"><img class="player-cover" alt="" /></div>'
    const rail=shell.querySelector('.progress-slider-wrap')
    rail.outerHTML='<div class="progress-area"><span class="time-label">0:24</span>'+rail.outerHTML+'<span class="time-label">2:41</span></div>'
  }
  mountIcon(shell.querySelector('.btn-play'),'play')
  if(mode!=='standard')mountIcon(shell.querySelector('.mini-play-button'),'play')
  for(const element of [shell,...shell.querySelectorAll('*')])element.setAttribute('data-v-test','')
  document.body.append(shell)
  bar=shell.querySelector('.player-bar')
  button=shell.querySelector('.btn-play')
  stripButton=shell.querySelector('.mini-play-button')
  track=shell.querySelector('[class$="progress-track"]')
  fill=track.firstElementChild
}
const mountDashboard=(glass=false)=>{
  clear()
  document.documentElement.dataset.teHomeLiquidGlass=glass?'on':'off'
  const home=document.createElement('div')
  home.className='home'
  home.style.setProperty('--play-button-color','#cc9900')
  home.innerHTML='<div class="hero-progress"><button class="hero-progress-track"><span style="transform:scaleX(0.42)"></span></button></div><div class="hero-actions"><button class="transport-button transport-play">Play</button></div>'
  mountIcon(home.querySelector('.transport-play'),'play')
  for(const element of [home,...home.querySelectorAll('*')])element.setAttribute('data-v-test','')
  document.body.append(home)
  bar=home
  button=home.querySelector('.transport-play')
  track=home.querySelector('.hero-progress-track')
  fill=track.firstElementChild
}
const background=(element,pseudo)=>{
  const style=getComputedStyle(element,pseudo)
  return [style.backgroundColor,style.backgroundImage].join('|')
}
const checkBackground=(element,value,label,pseudo)=>{
  const probe=document.createElement('div')
  probe.style.background=value
  document.body.append(probe)
  expect(background(element,pseudo)===background(probe),label+': '+background(element,pseudo)+' expected '+background(probe))
  probe.remove()
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,250))
const checkIconColor=(element,value)=>{
  const probe=document.createElement('span');probe.style.color=value;document.body.append(probe)
  expect(getComputedStyle(element.querySelector('svg')).color===getComputedStyle(probe).color,'explicit transport icon color reaches the glyph')
  probe.remove()
}
const checkColors=async(overrides)=>{
  for(const tone of ['pureWhite','dark']){
    await store.setPreviewTone(tone)
    for(const glass of [false,true]){
      mountDashboard(glass)
      await settle()
      checkBackground(track,overrides[tone]['playback.progress.track'],tone+' dashboard track','::before')
      checkBackground(fill,overrides[tone]['playback.progress.fill'],tone+' dashboard fill')
      checkBackground(button,overrides[tone]['playback.control.surface'],tone+' dashboard play')
      checkIconColor(button,overrides[tone]['playback.control.text'])
      bar.style.setProperty('--home-accent','#0000aa')
      checkBackground(fill,overrides[tone]['playback.progress.fill'],tone+' dashboard accent change')
    }
    for(const mode of ['standard','mini','compact'])for(const glass of [false,true])for(const live of [false,true]){
      mount(mode,glass,live)
      await settle()
      const label=[tone,mode,glass,live].join('/')
      checkBackground(track,overrides[tone]['playback.progress.track'],label+' track')
      checkBackground(fill,overrides[tone]['playback.progress.fill'],label+' fill')
      checkBackground(button,overrides[tone]['playback.control.surface'],label+' play')
      if(mode==='standard')checkIconColor(button,overrides[tone]['playback.control.text'])
      if(mode!=='standard')checkBackground(stripButton,overrides[tone]['playback.control.surface'],label+' standalone play')
      bar.style.setProperty('--accent-color','#0000aa')
      bar.style.setProperty('--play-button-color','#0000aa')
      checkBackground(track,overrides[tone]['playback.progress.track'],label+' cover track change')
      checkBackground(fill,overrides[tone]['playback.progress.fill'],label+' cover fill change')
      checkBackground(button,overrides[tone]['playback.control.surface'],label+' cover change')
    }
  }
}
const checkDashboardDefaults=()=>{
  mountDashboard()
  const style=getComputedStyle(bar)
  const ink=style.getPropertyValue('--home-ink')
  checkBackground(track,'color-mix(in srgb, '+ink+' 12%, transparent)','reset restores dashboard track','::before')
  checkBackground(fill,'linear-gradient(90deg, '+style.getPropertyValue('--home-accent')+', '+style.getPropertyValue('--te-accent-cyan')+')','reset restores dashboard fill')
  checkBackground(button,'var(--te-transport-play-surface)','reset restores quiet dashboard play surface')
}
window.runPlayerThemeTests=async()=>{
  await boot()
  for(const tone of ['pureWhite','dark']){
    await store.setPreviewTone(tone)
    for(const cover of ['#cc9900','#7c4dff']){
      mount('standard')
      bar.style.setProperty('--play-button-color',cover)
      await settle()
      const rect=button.getBoundingClientRect()
      expect(rect.width>=rect.height*1.6&&rect.height>=44,'standard transport is a capsule with a usable hit target')
      checkBackground(button,'var(--te-transport-play-surface)','default standard play surface stays neutral across covers')
      const expected=background(button)
      const expectedIcon=getComputedStyle(button).color
      mountDashboard()
      bar.style.setProperty('--play-button-color',cover)
      await settle()
      const homeRect=button.getBoundingClientRect()
      expect(Math.abs(homeRect.width-rect.width)<0.6&&Math.abs(homeRect.height-rect.height)<0.6,'dashboard and standard capsule dimensions match')
      expect(background(button)===expected,tone+' dashboard and standard play colors match after cover changes')
      expect(getComputedStyle(button).color===expectedIcon,tone+' dashboard and standard play icon colors match')
    }
  }
  const profile=store.createProfile('Player colors')
  profile.overrides=structuredClone(colors)
  await store.preview(profile)
  await checkColors(colors)
  await store.saveProfile(profile)
  await store.setActive({kind:'user',id:profile.id})
  await checkColors(colors)
  const preview=structuredClone(profile)
  preview.overrides.dark['playback.progress.track']='#aa00aa'
  await store.preview(preview)
  mountDashboard()
  checkBackground(track,'#aa00aa','dashboard preview uses edited track','::before')
  mount('compact',true)
  checkBackground(track,'#aa00aa','preview uses edited track')
  await store.preview(null)
  checkBackground(track,colors.dark['playback.progress.track'],'cancel restores saved track')
  mountDashboard()
  checkBackground(track,colors.dark['playback.progress.track'],'dashboard cancel restores saved track','::before')
  const reset=structuredClone(profile)
  reset.overrides={pureWhite:{},dark:{}}
  await store.saveProfile(reset)
  await store.setActive({kind:'user',id:profile.id})
  checkDashboardDefaults()
  mount('mini')
  checkBackground(fill,'#cc9900','reset restores cover progress color')
  checkBackground(button,'#cc9900','reset restores cover play color')
  checkBackground(stripButton,'transparent','reset restores standalone play surface')
  await store.saveProfile(profile)
  await store.setActive({kind:'user',id:profile.id})
  await store.setActive({kind:'builtin',id:'builtin:twilight-echo-default'})
  checkDashboardDefaults()
  mount('compact')
  checkBackground(fill,'#cc9900','switching theme clears progress override')
  checkBackground(button,'#cc9900','switching theme clears play override')
  await store.setActive({kind:'user',id:profile.id})
}
window.checkStandardPlayerGeometry=async()=>{
  for(const tone of ['pureWhite','dark'])for(const glass of [false,true])for(const fontSize of [14,18])for(const placeholder of [false,true]){
    await store.setPreviewTone(tone)
    mount('standard',glass)
    bar.style.setProperty('--te-font-size-body',fontSize+'px')
    const slot=bar.querySelector('.player-cover-slot')
    if(placeholder)slot.innerHTML='<div class="player-cover-placeholder" data-v-test></div>'
    const frame=bar.getBoundingClientRect()
    const art=slot.getBoundingClientRect()
    const insetX=art.left-frame.left
    const insetY=art.top-frame.top
    const radius=parseFloat(getComputedStyle(bar).borderTopLeftRadius)
    const innerRadius=parseFloat(getComputedStyle(slot).borderTopLeftRadius)
    expect(Math.abs(insetX-insetY)<0.6,'cover has equal horizontal and vertical insets: '+insetX+'/'+insetY)
    expect(Math.abs(insetX+innerRadius-radius)<0.6,'cover and bar corner centers align')
    const innerArt=slot.firstElementChild.getBoundingClientRect()
    expect(Math.abs(innerArt.width-art.width)<0.6&&Math.abs(innerArt.height-art.height)<0.6,'image and fallback fill the same artwork frame')
    expect(Math.abs(parseFloat(getComputedStyle(slot.firstElementChild).borderTopLeftRadius)-innerRadius)<0.6,'image and fallback use the frame radius')
    const controls=bar.querySelector('.player-controls').getBoundingClientRect()
    const progress=bar.querySelector('.progress-track').getBoundingClientRect()
    expect(controls.top-frame.top>=15.9,'transport has at least 16px top clearance: '+(controls.top-frame.top))
    expect(frame.bottom-progress.bottom>=7.9,'progress has at least 8px bottom clearance')
    const play=button.getBoundingClientRect(),glyph=button.querySelector('svg').getBoundingClientRect()
    expect(play.width>=play.height*1.6,'play capsule remains horizontal at every width and font size')
    expect(Math.abs(glyph.x+glyph.width/2-play.x-play.width/2)<0.6&&Math.abs(glyph.y+glyph.height/2-play.y-play.height/2)<0.6,'transport glyph stays centered in the capsule: '+JSON.stringify({tone,glass,fontSize,width:innerWidth,play:play.toJSON(),glyph:glyph.toJSON(),display:getComputedStyle(button).display,align:getComputedStyle(button).alignItems}))
  }
}
window.checkNavigationProportions=async()=>{
  clear()
  const host=document.createElement('div')
  host.innerHTML='<aside class="side-menu open" data-v-test><nav class="menu-items" data-v-test><div class="menu-nav" data-v-test><button class="menu-item" data-v-test><span class="item-icon" data-v-test>+</span><span class="item-label" data-v-test>流媒体音乐</span><i class="group-chevron" data-v-test>›</i></button></div></nav></aside><main class="main-content menu-open" data-v-test></main>'
  document.body.append(host)
  const menu=host.querySelector('.side-menu'),item=host.querySelector('.menu-item'),icon=host.querySelector('.item-icon'),label=host.querySelector('.item-label'),main=host.querySelector('.main-content')
  for(const tone of ['pureWhite','dark'])for(const style of ['expanded','compact','rail'])for(const size of [14,18]){
    const profile=store.createProfile('Navigation proportions')
    profile.modes={...profile.modes,navigation:{...profile.modes?.navigation,style}}
    await store.preview(profile);await store.setPreviewTone(tone)
    document.documentElement.dataset.teMotion='off'
    document.documentElement.style.setProperty('--te-font-size-body',size+'px','important')
    await new Promise(requestAnimationFrame)
    const frame=menu.getBoundingClientRect(),row=item.getBoundingClientRect(),glyph=icon.getBoundingClientRect()
    expect(Math.abs(frame.top-45)<0.6,'sidebar begins below the fixed 45px title bar')
    const expected=style==='rail'?72:style==='compact'?size*192/14:Math.max(size*224/14,Math.min(innerWidth*.18,size*260/14))
    expect(Math.abs(frame.width-expected)<1,'navigation mode width survives inline theme tokens: '+style+' '+frame.width+'/'+expected)
    expect(Math.abs(parseFloat(getComputedStyle(main).paddingLeft)-(innerWidth>900?frame.width:0))<1,'content reserves sidebar width on desktop and overlays at narrow widths: '+JSON.stringify({style,width:frame.width,padding:getComputedStyle(main).paddingLeft,window:innerWidth}))
    expect(glyph.left>=frame.left+8&&glyph.right<=frame.right-8,'navigation icon stays inside sidebar padding')
    expect(row.left>=frame.left+7&&row.right<=frame.right-7,'navigation row has balanced inset')
    if(style!=='rail')expect(label.scrollWidth<=label.clientWidth+1,'normal navigation label remains readable')
    expect(frame.width<innerWidth*.4,'navigation leaves room for main content')
  }
  host.remove();document.documentElement.style.removeProperty('--te-font-size-body')
  await store.preview(null)
}
window.checkSharedPlaybackGlyphs=async()=>{
  for(const tone of ['pureWhite','dark']){
    await store.setPreviewTone(tone)
    for(const name of ['play','pause','previous','next']){
      mount('standard')
      mountIcon(button,name)
      const standard=button.querySelector('svg').innerHTML
      const foreground=getComputedStyle(button.querySelector('svg')).color
      expect(foreground===getComputedStyle(button).color,'standard glyph inherits the transport foreground')
      mountDashboard()
      mountIcon(button,name)
      expect(button.querySelector('svg').innerHTML===standard,'dashboard '+name+' has the standard bar shape')
      expect(getComputedStyle(button.querySelector('svg')).color===foreground,'dashboard glyph uses the same transport foreground')
    }
    const tile=document.createElement('button')
    tile.className='fresh-tile'
    tile.innerHTML='<span class="fresh-play"></span><span class="gallery-play"></span>'
    for(const e of [tile,...tile.querySelectorAll('*')])e.setAttribute('data-v-test','')
    bar.append(tile)
    for(const plate of tile.children){
      mountIcon(plate,'play')
      expect(getComputedStyle(plate.querySelector('svg')).color==='rgb(17, 24, 39)',tone+' white overlay keeps a dark play glyph')
    }
    const row=document.createElement('button')
    row.className='music-track'
    row.innerHTML='<span class="music-track-cover"><span class="music-track-play"></span></span>'
    for(const e of [row,...row.querySelectorAll('*')])e.setAttribute('data-v-test','')
    bar.append(row)
    const cover=row.firstElementChild
    mountIcon(cover.firstElementChild,'play')
    const frame=cover.getBoundingClientRect(),overlay=cover.firstElementChild.getBoundingClientRect(),glyph=cover.querySelector('svg').getBoundingClientRect()
    expect(Math.abs(frame.width-45)<0.6&&Math.abs(frame.height-45)<0.6,'provider artwork fixture retains its real flex layout')
    expect(Math.abs(frame.width-overlay.width)<0.6&&Math.abs(frame.height-overlay.height)<0.6,'provider hover overlay still covers the whole artwork')
    expect(Math.abs(glyph.left+glyph.width/2-frame.left-frame.width/2)<0.6&&Math.abs(glyph.top+glyph.height/2-frame.top-frame.height/2)<0.6,'provider play glyph stays centered inside the overlay: '+JSON.stringify({frame:{x:frame.x,y:frame.y,w:frame.width,h:frame.height},glyph:{x:glyph.x,y:glyph.y,w:glyph.width,h:glyph.height}}))

  }
}
window.checkSidebarTransition=async()=>{
  for(const tone of ['pureWhite','dark'])for(const mode of ['standard','mini','compact']){
    await store.setPreviewTone(tone)
    mount(mode)
    document.documentElement.dataset.teMotion='full'
    const shell=bar.parentElement
    const duration=parseFloat(getComputedStyle(shell).transitionDuration)*1000
    expect(duration>0,'sidebar has a position transition in full motion: '+mode+' '+getComputedStyle(shell).transition+' / '+getComputedStyle(shell).getPropertyValue('--te-motion-panel')+' / '+getComputedStyle(shell).getPropertyValue('--te-ease-soft'))
    for(const open of [true,false,true,false]){
      const before=bar.getBoundingClientRect()
      shell.classList.toggle('menu-open',open)
      const immediate=bar.getBoundingClientRect()
      expect(Math.abs(immediate.left-before.left)<1&&Math.abs(immediate.width-before.width)<1,mode+' sidebar toggle must not instantly change max width or margins')
      const started=performance.now()
      do{
        await new Promise(requestAnimationFrame)
        const rect=bar.getBoundingClientRect()
        expect(Math.abs(rect.top-before.top)<0.6&&Math.abs(rect.height-before.height)<0.6,mode+' sidebar toggle preserves vertical position and height')
      }while(performance.now()-started<duration+40)
    }
  }
}
window.prepareDarkTitlebarControl=async(kind)=>{
  await store.setPreviewTone('dark')
  clear()
  document.querySelector('.title-bar')?.remove()
  const title=document.createElement('div')
  title.className='title-bar'
  title.style.setProperty('--te-active-bg','rgba(180, 80, 0, 0.2)')
  title.style.setProperty('--te-shell-control-hover','rgba(180, 80, 0, 0.2)')
  title.innerHTML='<div class="title-bar-start"><button class="menu-btn">Menu</button><button class="settings-btn" aria-pressed="true">Settings</button><button class="plugins-btn" aria-pressed="true">Plugins</button></div><div class="title-bar-controls"><button class="control-btn close">Close</button></div>'
  for(const e of [title,...title.querySelectorAll('*')])e.setAttribute('data-v-test','')
  document.body.append(title)
  hoverTarget=title.querySelector(kind==='close'?'.close':'.'+kind+'-btn')
  const rect=hoverTarget.getBoundingClientRect()
  return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
}
window.checkDarkTitlebarControl=(kind)=>{
  expect(hoverTarget.matches(':hover'),'titlebar '+kind+' receives the real pointer')
  const selected=kind==='settings'||kind==='plugins'
  checkBackground(hoverTarget,kind==='close'?'#e81123':'color-mix(in srgb, var(--te-shell-control-text) '+(selected?'11%':'6%')+', transparent)','dark titlebar '+kind+' avoids the album wash')
  if(selected){
    const probe=document.createElement('span')
    probe.style.color='var(--te-primary-400)'
    document.body.append(probe)
    expect(getComputedStyle(hoverTarget).color===getComputedStyle(probe).color,'selected dark titlebar glyph uses the lighter accent')
    probe.remove()
  }
}
window.preparePlayerThemeHover=async(tone,mode,glass)=>{
  await store.setPreviewTone(tone)
  if(mode==='dashboard')mountDashboard(glass)
  else mount(mode,glass)
  hoverTarget=mode==='standard'||mode==='dashboard'?button:stripButton
  const rect=hoverTarget.getBoundingClientRect()
  return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}
}
window.checkPlayerThemeHover=()=>{
  const hoverRect=hoverTarget.getBoundingClientRect()
  expect(hoverTarget.matches(':hover'),'play button receives hover: '+document.documentElement.dataset.theme+' '+bar.className+' '+JSON.stringify({x:hoverRect.x,y:hoverRect.y,w:hoverRect.width,h:hoverRect.height,hit:document.elementFromPoint(hoverRect.x+hoverRect.width/2,hoverRect.y+hoverRect.height/2)?.outerHTML.slice(0,200)}))
  checkBackground(hoverTarget,colors[document.documentElement.dataset.theme]['playback.control.hoverSurface'],'custom play hover '+bar.className+' '+getComputedStyle(hoverTarget).getPropertyValue('--te-player-bar-play-hover-surface'))
  if(bar.classList.contains('home')||(!bar.classList.contains('player-bar-mini')&&!bar.classList.contains('player-bar-compact')))checkIconColor(hoverTarget,colors[document.documentElement.dataset.theme]['playback.control.hoverText'])
}
window.checkReloadedPlayerTheme=async()=>{
  await boot()
  await checkColors(colors)
  expect(store.error.value==='','theme runtime applies without errors')
}
`
