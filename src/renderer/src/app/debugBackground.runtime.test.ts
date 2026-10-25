import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { compileStyle } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('wallpapers remain visible and adaptive glass sampling survives duplicate updates and teardown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-background-'))
  try {
    await Promise.all([
      writeFile(
        join(directory, 'global.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><path fill="#123456" d="M0 0h800v600H0z"/></svg>'
      ),
      writeFile(
        join(directory, 'page.svg'),
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><path fill="#654321" d="M0 0h800v600H0z"/></svg>'
      )
    ])
    const [base, home] = await Promise.all([
      readFile(new URL('../assets/base.css', import.meta.url), 'utf8'),
      readFile(new URL('../components/LocalDashboard.css', import.meta.url), 'utf8')
    ])
    const style = compileStyle({
      source: home,
      filename: 'LocalDashboard.css',
      id: 'data-v-test',
      scoped: true
    })
    assert.deepEqual(style.errors, [])
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
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
          name: 'BackgroundTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><style>${base}\n${style.code}</style></head><body><div id="app"><div class="home" data-v-test></div></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,protocol}=require('electron')
const {readFile}=require('node:fs/promises')
const path=require('node:path')
protocol.registerSchemesAsPrivileged([{scheme:'background',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}])
app.setPath('userData',path.join(__dirname,'profile'))
app.whenReady().then(async()=>{
  protocol.handle('background',async request=>{
    const file=path.join(__dirname,new URL(request.url).hostname)
    return new Response(await readFile(file),{headers:{'content-type':'image/svg+xml'}})
  })
  const win=new BrowserWindow({show:false,width:800,height:600,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
  try{
    await win.loadFile(process.argv.at(-1))
    await win.webContents.executeJavaScript('window.runBackgroundTests()')
    // Inspect the actual pixels, as a correctly resolved CSS token can still be covered.
    const image=await win.webContents.capturePage({x:400,y:300,width:1,height:1})
    const pixel=image.toBitmap()
    if(pixel[0]!==86||pixel[1]!==52||pixel[2]!==18)throw new Error('Home wallpaper is obscured: '+[...pixel])
    await win.webContents.executeJavaScript('window.runGlassEnvironmentTests()')
    console.log('APP_BACKGROUND_OK')
    app.exit(0)
  }catch(error){console.error(error.stack);app.exit(1)}
})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /APP_BACKGROUND_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {bootstrapThemeRuntime,syncThemeSettingsAppearance,useThemeStore} from '@renderer/stores/useThemeStore.ts'
import {createDefaultThemeLibraryDocument} from '@shared/theme.ts'
import {LIQUID_GLASS_TUNING_CHANGED_EVENT} from '@shared/liquidGlass.ts'
import {useLiquidGlassEnvironment} from '@renderer/composables/useLiquidGlassEnvironment.ts'
import {createApp,h,ref} from 'vue'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const wallpaper=(color)=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><path fill="'+color+'" d="M0 0h800v600H0z"/></svg>')
const globalImage='background://global.svg'
const pageImage='background://page.svg'
const pair={kind:'image',light:'#f4f4f7',dark:'#0f1114',image:globalImage}
const pages=Object.fromEntries(['local','settings','streaming','player'].map(page=>[page,{...pair,inherit:true}]))
const settings={theme:'pureWhite',accentColor:'blue',uiDensity:'comfortable',surfaceMaterial:'liquidGlass',appBackground:{global:{...pair},pages}}
window.api={
  settings:{onChanged:()=>()=>{}},
  plugins:{onChanged:()=>()=>{}},
  themes:{onChanged:()=>()=>{},onSystemToneChanged:()=>()=>{}}
}
const store=useThemeStore()
const settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
const apply=async(tone)=>{
  syncThemeSettingsAppearance(settings)
  // This awaits the theme application triggered by the current settings snapshot.
  await store.setPreviewTone(tone)
  await settle()
}
const checkImage=(expected,label)=>{const dbg=JSON.stringify({body:getComputedStyle(document.body).backgroundImage,bodyColor:getComputedStyle(document.body).backgroundColor,local:getComputedStyle(document.documentElement).getPropertyValue('--te-local-bg-image'),app:getComputedStyle(document.documentElement).getPropertyValue('--te-app-bg-image'),glass:getComputedStyle(document.documentElement).getPropertyValue('--te-glass-backdrop-image'),material:document.documentElement.dataset.teSurfaceMaterial});
  const actual=getComputedStyle(document.body).backgroundImage
  if(expected){
    const displayed = new URL(expected)
    displayed.searchParams.set('display', 'v1')
    expect(actual.startsWith('url("'+displayed.toString()+'")'),label+': configured image is not the top layer: '+actual)
  }else{
    expect(!actual.includes('url('),label+': removed image is still visible: '+actual)
  }
  expect(getComputedStyle(document.querySelector('.home')).backgroundColor==='rgba(0, 0, 0, 0)',label+': homepage must reveal the shared wallpaper')
}
window.runBackgroundTests=async()=>{
  for(const url of [globalImage,pageImage]){
    const image=new Image();image.src=url;await image.decode()
  }
  await bootstrapThemeRuntime({systemTone:'pureWhite',settings:{settings},themeBootstrap:{library:{version:2,revision:0,savedAt:new Date(0).toISOString(),data:createDefaultThemeLibraryDocument()}}})
  for(const tone of ['pureWhite','dark'])for(const material of ['liquidGlass','standard']){
    settings.surfaceMaterial=material
    for(const page of ['local','streaming']){
      document.body.className='te-'+page+'-surface'
      const label=tone+'/'+material+'/'+page
      pages[page].inherit=true
      await apply(tone)
      checkImage(globalImage,label+' inherited')
      pages[page]={...pair,inherit:false,image:pageImage}
      await apply(tone)
      checkImage(pageImage,label+' override')
      pages[page].kind='color'
      await apply(tone)
      checkImage(null,label+' color override')
      pages[page].inherit=true
      await apply(tone)
      checkImage(globalImage,label+' inheritance restored')
    }
  }
  settings.surfaceMaterial='liquidGlass'
  settings.appBackground.global.image=''
  document.body.className='te-local-surface'
  await apply('pureWhite')
  checkImage(null,'removed global image')
  expect(getComputedStyle(document.body).backgroundImage.includes('radial-gradient'),'default liquid-glass lighting remains available')
  settings.appBackground.global.image=globalImage
  await apply('pureWhite')
  // App.vue retains te-local-surface while showing settings; returning home must restore its image.
  pages.settings={...pair,inherit:false,image:pageImage}
  document.body.classList.add('te-settings-surface')
  await apply('pureWhite')
  checkImage(pageImage,'settings page override')
  document.body.classList.remove('te-settings-surface')
  await settle()
  checkImage(globalImage,'return from settings')
}
window.runGlassEnvironmentTests=async()=>{
  const nativeImage=window.Image
  const nativeCreateElement=document.createElement.bind(document)
  const nativeComputedStyle=window.getComputedStyle.bind(window)
  const pending=[]
  const root=document.documentElement
  const host=document.createElement('div')
  document.body.append(host)
  let samples=0,styleReads=0,app=null
  window.Image=function(){
    const image=new nativeImage()
    let source=''
    Object.defineProperty(image,'src',{configurable:true,get:()=>source,set:value=>{
      source=value
      if(!source)return
      pending.push({image,source})
    }})
    return image
  }
  document.createElement=(tag,...args)=>{
    if(tag==='canvas')samples++
    return nativeCreateElement(tag,...args)
  }
  window.getComputedStyle=(target,...args)=>{
    if(target===root)styleReads++
    return nativeComputedStyle(target,...args)
  }
  const setImage=color=>root.style.setProperty('--te-settings-bg-image','url("'+wallpaper(color)+'")','important')
  const burst=()=>{for(let i=0;i<12;i++)window.dispatchEvent(new Event(LIQUID_GLASS_TUNING_CHANGED_EVENT))}
  const release=async(record,fail=false)=>{
    delete record.image.src
    if(fail){record.image.dispatchEvent(new Event('error'));return}
    const loaded=new Promise((resolve,reject)=>{
      record.image.addEventListener('load',resolve,{once:true})
      record.image.addEventListener('error',reject,{once:true})
    })
    record.image.src=record.source
    await loaded
    await settle()
  }
  const mount=()=>{
    const active=ref(true)
    app=createApp({setup(){useLiquidGlassEnvironment({active,page:ref('settings')});return()=>h('span')}})
    app.mount(host)
    return active
  }
  const expectCleared=label=>{
    expect(!root.dataset.teLiquidGlassSource,label+': context source was restored')
    expect(!root.dataset.teLiquidGlassContext,label+': context was restored')
    expect(!root.style.getPropertyValue('--te-lg-context-luminance'),label+': sample variables were restored')
  }
  try{
    setImage('#080808')
    const active=mount()
    await settle()
    expect(pending.length===1,'initial context image must load once')
    const before=styleReads
    burst()
    await settle()
    expect(styleReads-before===1,'one tuning burst must read its source only once')
    expect(pending.length===1,'repeated source must share the pending image')
    // A separate turn must also preserve the initial in-flight request.
    burst()
    await settle()
    await release(pending[0])
    expect(root.dataset.teLiquidGlassSource==='image','duplicate refresh discarded the loaded image')
    expect(root.dataset.teLiquidGlassContext==='dark','real dark image must select dark glass context')
    expect(root.style.getPropertyValue('--te-lg-context-label-rgb')==='248, 250, 252','dark image must keep readable labels')
    expect(samples===1,'duplicate refresh must sample only once')

    // New wallpaper wins even when the old request finishes last.
    setImage('#222222');await settle()
    expect(pending.length===2,'second wallpaper must start loading: '+pending.length)
    setImage('#fafafa');await settle()
    expect(pending.length===3,'third wallpaper must start loading: '+pending.length)
    await release(pending[2])
    expect(root.dataset.teLiquidGlassContext==='bright','latest wallpaper did not update context')
    const afterLatest=samples
    await release(pending[1])
    expect(root.dataset.teLiquidGlassContext==='bright','old wallpaper overwrote the latest context')
    expect(samples===afterLatest,'stale wallpaper must not incur canvas sampling')

    setImage('#121212');await settle()
    active.value=false;await settle()
    expectCleared('disabled material')
    const beforeDisabled=samples
    await release(pending[3])
    expectCleared('disabled material load')
    expect(samples===beforeDisabled,'disabled material must not sample late images')
    active.value=true;await settle()
    expect(pending.length===5,'re-enabled material must retry the same wallpaper')
    await release(pending[4])
    expect(root.dataset.teLiquidGlassContext==='dark','re-enabled material did not apply its image')

    // Unmount both queued refreshes and a genuinely in-flight request.
    setImage('#777777');await settle()
    burst();app.unmount();app=null
    await settle()
    expectCleared('unmounted context')
    const beforeUnmounted=samples
    await release(pending[5])
    expectCleared('unmounted context load')
    expect(samples===beforeUnmounted,'unmounted context must not sample late images')
    const loadsBeforeImmediateUnmount=pending.length
    mount();app.unmount();app=null
    await settle()
    expect(pending.length===loadsBeforeImmediateUnmount,'queued mount refresh must stop at unmount')
    expectCleared('immediate unmount')

    // A late failure is equally forbidden from restoring fallback variables.
    setImage('#333333');mount();await settle()
    const failed=pending.at(-1)
    app.unmount();app=null
    await release(failed,true);await settle()
    expectCleared('late failure after unmount')
  }finally{
    app?.unmount()
    window.Image=nativeImage
    document.createElement=nativeCreateElement
    window.getComputedStyle=nativeComputedStyle
    root.style.removeProperty('--te-settings-bg-image')
    host.remove()
  }
}
`
