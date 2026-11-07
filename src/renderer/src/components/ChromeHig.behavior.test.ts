import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('caption and sidebar share fonts and icon families, rail entries and library portals remain accessible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-chrome-hig-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(
      join(directory, 'fixtures.ts'),
      `import {ref} from 'vue'
const settings=ref({navigationPages:{version:1,order:[],hidden:[]}})
export const useSettingsStore=()=>({settings,updateSettings:async()=>{}})
export const useMusicStore=()=>({libraryScanStatus:ref({state:'idle'}),libraryScanProgress:ref(null)})
export const useNcmStore=()=>({isLoggedIn:ref(false),profile:ref(null)})
export const useProviderStore=()=>({providers:ref([]),getProvider:()=>null})
export const useAppNoticeStore=()=>({unreadCount:ref(1),activeTaskCount:ref(0),doNotDisturb:ref(false)})
export const windowChrome={maximized:ref(false),fullScreen:ref(false),maximizeBehavior:ref('maximize')}
export const useWindowChrome=()=>windowChrome
export const useBackStack=()=>({canGoBack:ref(true),backHint:ref(null)})`
    )
    await writeFile(join(directory, 'import.ts'), `export default {render:()=>null}`)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [vue()],
      resolve: {
        alias: [
          { find: '/icon.png', replacement: join(workspace, 'resources/icon.png') },
          {
            find: '@renderer/components/ImportDialog.vue',
            replacement: join(directory, 'import.ts')
          },
          {
            find: /^(?:.*\/stores\/use(?:Ncm|Provider|AppNotice|Settings|Music)Store|.*\/app\/use(?:WindowChrome|BackStack))(?:\.ts)?$/,
            replacement: join(directory, 'fixtures.ts')
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
          name: 'ChromeHigTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">
      ${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}
      <style>html,body{margin:0;height:100%;overflow:hidden}#app{height:100%}.library-view{position:absolute;left:280px;right:24px;top:80px}.side-menu{--te-side-menu-bottom:20px}</style>
      </head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');
      app.setPath('userData',require('node:path').join(__dirname,'profile'));
      app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:800,useContentSize:true,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});
        win.webContents.on('console-message',event=>console.error(event.message));
        try{await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await win.webContents.executeJavaScript('window.runChromeHigTests()');
          win.webContents.focus();await win.webContents.executeJavaScript('window.prepareLibraryPortal()');
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
          win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
          await new Promise(resolve=>setTimeout(resolve,60));
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
          win.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13)});
          win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
          await new Promise(resolve=>setTimeout(resolve,150));
          await win.webContents.executeJavaScript('window.checkLibraryActivation()');
          if(process.env.TE_CHROME_PREVIEW){
            const fs=require('node:fs'),target=process.env.TE_CHROME_PREVIEW;
            fs.writeFileSync(target,(await win.webContents.capturePage()).toPNG());
            for(const fullScreen of [false,true]){
              await win.webContents.executeJavaScript('window.prepareMacFullscreenPreview('+fullScreen+')');
              fs.writeFileSync(target.replace(/\\.png$/,'-mac-'+(fullScreen?'exit':'enter')+'.png'),(await win.webContents.capturePage()).toPNG());
            }
          }
          console.error('CHROME_HIG_OK');app.exit(0);
        }catch(error){console.error(error);app.exit(1)}});`
    )
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, env: environment }
    )
    assert.match(result.stderr, /CHROME_HIG_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,ref,nextTick} from 'vue'
import {windowChrome} from './fixtures'
import TitleBar from '@renderer/components/TitleBar.vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import StreamingLibrary from '@renderer/components/StreamingLibrary.vue'
import '@renderer/assets/base.css'
import '@renderer/assets/bohr.css'
import '@renderer/assets/fonts.css'
import '@renderer/assets/icon-fonts.ts'
const active=ref('streaming-home'),open=ref(true),liquid=ref(false),selected=[],activeTool=ref('settings')
let dspRequests=0
let recent=0,ranking=0
createApp({render:()=>h('div',[
 h(TitleBar,{menuOpen:open.value,preview:true,activeTool:activeTool.value,onDsp:()=>{dspRequests++;activeTool.value=activeTool.value==='dsp'?'settings':'dsp'},onToggleMenu:()=>open.value=!open.value}),
 h(SideMenu,{open:open.value,liquidMaterial:liquid.value,activeKey:active.value,onSelectPage:page=>{active.value=page.id;selected.push(page.id)}}),
 h(StreamingLibrary,{isLoggedIn:true,profile:null,profileSignature:'',likedSummary:{name:'喜欢',trackCount:0,cover:null},libraryLoaded:true,userPlaylistEntries:[],showLikedPanel:false,showSocialStats:false,showFeatureCards:true,onOpenRecent:()=>recent++,onOpenRanking:()=>ranking++})
])}).mount('#app')
const expect=(condition,message)=>{if(!condition)throw Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,350))}
const visibleGlyph=icon=>[...icon.querySelectorAll('.theme-icon-glyph')].filter(glyph=>getComputedStyle(glyph).display!=='none')
window.prepareMacFullscreenPreview=async(fullScreen)=>{
 windowChrome.maximizeBehavior.value='fullscreen';windowChrome.fullScreen.value=fullScreen;await settle()
}
window.runChromeHigTests=async()=>{
 await settle();await document.fonts.ready
 const expand=document.querySelector('.title-bar .control-btn.maximize')
 expect(expand.getAttribute('aria-label')==='最大化窗口','Windows caption lost maximize')
 windowChrome.maximized.value=true;await nextTick()
 expect(expand.title==='还原窗口','maximized caption does not offer restore')
 windowChrome.maximizeBehavior.value='fullscreen';await nextTick()
 expect(expand.title==='进入全屏'&&expand.querySelector('path'),'Mac maximized window does not offer native fullscreen')
 windowChrome.fullScreen.value=true;windowChrome.maximized.value=false;await nextTick()
 expect(expand.getAttribute('aria-label')==='退出全屏','native fullscreen state does not update the caption')
 windowChrome.fullScreen.value=false;await nextTick()
 expect(expand.title==='进入全屏','leaving native fullscreen does not reset the caption')
 windowChrome.maximizeBehavior.value='maximize';await nextTick()
 const dspButton=document.querySelector('.title-bar [aria-label="DSP 工作台"]')
 expect(dspButton.nextElementSibling?.getAttribute('aria-label')==='声区'&&dspButton.nextElementSibling.nextElementSibling?.getAttribute('aria-label')==='外观','audio tools are not adjacent to appearance')
 expect(dspButton.querySelector('[data-theme-icon-slot="playback.equalizer"]'),'DSP tool is missing its audio adjustment icon')
 dspButton.click();await nextTick();expect(dspRequests===1&&dspButton.getAttribute('aria-pressed')==='true','DSP button does not emit or show its active state')
 dspButton.click();await nextTick();expect(dspRequests===2&&dspButton.getAttribute('aria-pressed')==='false','DSP button cannot return to its inactive state')
 for(const font of ['Inter, MiSans, sans-serif','Georgia, MiSans, serif']){
  document.documentElement.style.setProperty('--te-font-sans',font)
  for(const tone of ['dark','pureWhite'])for(const family of ['outline','rounded','filled']){
   document.documentElement.dataset.theme=tone;document.documentElement.dataset.teIconFamily=family;await nextTick()
   const title=document.querySelector('.title-bar'),label=document.querySelector('.item-label')
   expect(getComputedStyle(title).fontFamily===getComputedStyle(label).fontFamily,'caption and sidebar font selection drift')
   const icons=[...document.querySelectorAll('.title-bar .title-bar-icon,.side-menu .theme-icon')]
   for(const icon of icons.filter(icon=>getComputedStyle(icon).display!=='none')){
    const glyphs=visibleGlyph(icon);expect(glyphs.length===1,'icon does not resolve exactly one family')
    const glyph=glyphs[0],style=getComputedStyle(glyph)
    expect(glyph.classList.contains('theme-icon-family-'+family),'caption and sidebar use different icon families')
    expect(style.fontFamily.includes('Phosphor'),'chrome glyph uses a different font: '+style.fontFamily)
    await document.fonts.load(style.fontSize+' '+style.fontFamily)
    expect(document.fonts.check(style.fontSize+' '+style.fontFamily),'chrome icon font did not load')
   }
  }
 }
 document.documentElement.style.removeProperty('--te-font-sans')
 for(const mode of ['expanded','compact','rail']){
  document.documentElement.dataset.teNavigationStyle=mode;await settle()
  const group=document.querySelector('[aria-controls="sidebar-group-streaming"]')
  if(group.getAttribute('aria-expanded')!=='true'){group.click();await settle()}
  const children=[...document.querySelectorAll('#sidebar-group-streaming button')]
  expect(children.length>=4,'missing stream navigation children')
  for(const button of children){
   const label=button.querySelector('.item-label'),icon=button.querySelector('.item-icon')
   const box=button.getBoundingClientRect()
   expect(box.width>0&&box.height>=32,'navigation target is too small or hidden')
   if(mode==='rail')expect(getComputedStyle(label).display==='none'&&getComputedStyle(icon).display!=='none'&&visibleGlyph(icon).length===1,'rail renders a blank child entry')
   else expect(getComputedStyle(label).display!=='none'&&getComputedStyle(icon).display==='none','expanded navigation adds unnecessary child icons')
   expect(button.getAttribute('aria-label')&&button.title,'compact navigation loses its accessible name or hint')
  }
  group.focus();group.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));await nextTick()
  group.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));await nextTick();await nextTick()
  expect(document.activeElement===children[0],'disclosure arrow keys fail')
  children[1].click();await nextTick();expect(selected.at(-1)==='discover'&&children[1].getAttribute('aria-current')==='page','navigation loses its selected destination')
 }
 // Persistent navigation needs a visible, translucent substrate and an opaque
 // fallback. Assert rendered alpha, not the serialization of color-mix().
 for(const tone of ['pureWhite','dark']){
  document.documentElement.dataset.theme=tone;await settle()
  const nav=document.querySelector('.side-menu'),css=getComputedStyle(nav)
  const alpha=color=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,1,1);return x.getImageData(0,0,1,1).data[3]/255}
  const caption=getComputedStyle(document.querySelector('.title-bar-background'))
  expect(alpha(css.backgroundColor)>.7&&alpha(css.backgroundColor)<.81,'navigation loses its material substrate: '+tone+' '+css.backgroundColor)
  expect(css.backgroundColor===caption.backgroundColor&&css.backdropFilter===caption.backdropFilter,'navigation and caption materials differ: '+tone)
  expect(css.backdropFilter.includes('blur(24px)'),'navigation loses diffusion')
  document.body.classList.add('te-no-blur');await settle()
  expect(alpha(getComputedStyle(nav).backgroundColor)===1&&getComputedStyle(nav).backdropFilter==='none','navigation remains transparent without diffusion')
  document.body.classList.remove('te-no-blur')
 }
 liquid.value=true;await settle();const materialNav=document.querySelector('.side-menu');expect(getComputedStyle(materialNav).backdropFilter==='none'&&getComputedStyle(materialNav,'::before').backdropFilter.includes('blur(24px)'), 'liquid navigation stacks backdrop passes');expect(getComputedStyle(materialNav,'::before').backgroundImage==='none'&&getComputedStyle(materialNav,'::before').boxShadow==='none','navigation regains a competing highlight');
 for(const source of ['wallpaper','solid']){
  document.documentElement.dataset.teLiquidGlassSource=source
  document.documentElement.style.setProperty('--te-lg-context-surface-solid','rgb(22 24 26)')
  document.documentElement.style.setProperty('--te-lg-context-material','rgb(20 22 24 / 42%)')
  await settle()
  const substrate=getComputedStyle(materialNav,'::before')
  expect(substrate.backgroundColor!=='rgba(0, 0, 0, 0)','liquid navigation has no stable substrate')
  expect(getComputedStyle(materialNav).transitionProperty==='transform','navigation animates material properties while sliding')
  document.body.classList.add('te-no-blur');await settle()
  expect(getComputedStyle(materialNav,'::before').backgroundColor==='rgb(22, 24, 26)'&&getComputedStyle(materialNav,'::before').backdropFilter==='none','liquid navigation loses its opaque reduced-effects fallback: '+source)
  document.body.classList.remove('te-no-blur')
 }
 delete document.documentElement.dataset.teLiquidGlassSource
 liquid.value=false;await settle();
 open.value=false;await settle();expect(document.querySelector('.side-menu').inert,'hidden navigation remains focusable')
 open.value=true;document.documentElement.dataset.teNavigationStyle='expanded';await settle()
 const portals=[...document.querySelectorAll('.feature-card')]
 expect(portals.length===2&&portals.every(button=>button.tagName==='BUTTON'&&button.type==='button'),'library portals are not semantic buttons')
 portals[1].click();expect(ranking===1&&recent===0,'library portal emits the wrong action')
}
window.prepareLibraryPortal=()=>{document.querySelector('.side-menu [aria-label="编辑页面"]').focus()}
window.checkLibraryActivation=()=>{expect(recent===1,'Enter does not activate the actual library portal');expect(document.activeElement.matches(':focus-visible'),'keyboard portal focus is not visible: '+JSON.stringify({active:document.activeElement.outerHTML.slice(0,180),focused:document.hasFocus(),outline:getComputedStyle(document.activeElement).outline}))}
`
