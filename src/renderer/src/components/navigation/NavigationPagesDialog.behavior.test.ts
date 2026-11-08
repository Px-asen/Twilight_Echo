import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('page editing, hidden-page recovery, focus, dragging and theme geometry work in Electron', async () => {
  // Vite switches realpath implementations asynchronously on Windows. Canonical
  // paths keep the settings stub a single module when TEMP uses an 8.3 alias.
  const temporaryRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(temporaryRoot, 'twilight-navigation-pages-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(
      join(directory, 'settings.ts'),
      `import {shallowRef} from 'vue'
export const settings=shallowRef({navigationPages:{version:1,order:[],hidden:[]}})
export const useSettingsStore=()=>({settings,updateSettings:async patch=>{if(window.failSave)throw new Error('disk failure');window.writes++;settings.value={...settings.value,...patch};window.saved=JSON.stringify(settings.value)}})`
    )
    await writeFile(
      join(directory, 'music.ts'),
      `import {ref} from 'vue';export const useMusicStore=()=>({libraryScanStatus:ref({state:'idle'}),libraryScanProgress:ref(null)})`
    )
    await writeFile(join(directory, 'import.ts'), `export default {render:()=>null}`)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [
        vue(),
        {
          name: 'assert-navigation-settings-singleton',
          generateBundle() {
            const settingsModules = [...this.getModuleIds()].filter((id) =>
              /twilight-navigation-pages-[^/\\]+[/\\]settings\.ts$/.test(id)
            )
            assert.equal(
              settingsModules.length,
              1,
              `Navigation settings stub loaded more than once: ${settingsModules.join(', ')}`
            )
          }
        }
      ],
      resolve: {
        alias: {
          '/icon.png': join(workspace, 'resources/icon.png'),
          '@renderer/stores/useSettingsStore': join(directory, 'settings.ts'),
          '@renderer/stores/useMusicStore': join(directory, 'music.ts'),
          '@renderer/components/ImportDialog.vue': join(directory, 'import.ts'),
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
          name: 'NavigationPagesTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    const shellStyles = parse(await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8'))
      .descriptor.styles.map((style) => style.content)
      .join('\n')
    const playerStyles = compileStyle({
      source: await readFile(
        join(workspace, 'src/renderer/src/components/player-bar/PlayerBar.css'),
        'utf8'
      ),
      filename: 'PlayerBar.css',
      id: 'navigation-player-fixture',
      scoped: false
    }).code
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite" data-te-navigation-style="expanded"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>${playerStyles}</style><style>${shellStyles}</style><style>body{margin:0;font:var(--te-font-size-body,14px) system-ui}#opener{position:fixed;left:250px;top:20px}#app{--te-side-menu-bottom:0px;--te-shell-navigation-display:block;--te-shell-compact-navigation-display:none}.playbar-fixture{height:84px}.player-surface-fixture{width:100%;height:100%;max-width:1180px;margin:0 auto;padding:0;background:var(--te-card-bg);border:1px solid var(--te-card-border);pointer-events:auto}</style></head><body><button id="opener">页面菜单</button><div id="app" class="app-shell"></div><div class="player-bar-shell playbar-fixture" data-te-playbar-mode="standard"><div class="player-bar player-surface-fixture"></div></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1024,height:768,useContentSize:true,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});
const resizeViewport=async (width,height=820)=>{win.setContentSize(width,height);const deadline=Date.now()+3000;while(Date.now()<deadline){const viewport=await win.webContents.executeJavaScript('[innerWidth,innerHeight]');if(viewport[0]===width&&viewport[1]===height)return;await new Promise(resolve=>setTimeout(resolve,20))}throw new Error('navigation viewport did not reach '+width+'x'+height)};try{
await win.loadFile(process.argv.at(-1));await resizeViewport(1280);await win.webContents.executeJavaScript('window.runNavigationTests()');
for(const [width,height] of [[1920,1080],[1480,820],[1280,820],[760,820],[960,820],[1280,720],[1920,1080]]){await resizeViewport(width,height);await win.webContents.executeJavaScript('window.checkSlidingNavigation()')}
for(const tone of ['pureWhite','dark']){await win.webContents.executeJavaScript('window.checkDesktopNavigation('+JSON.stringify({tone})+')');if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS){fs.mkdirSync(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,'desktop-'+tone+'.png'),(await win.webContents.capturePage()).toPNG())}}
if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS){fs.mkdirSync(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,{recursive:true});for(const tone of ['pureWhite','dark'])for(const expanded of [false,true]){await win.webContents.executeJavaScript('window.prepareSidebarPreview('+JSON.stringify({tone,expanded})+')');fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,'grouped-'+tone+'-'+expanded+'.png'),(await win.webContents.capturePage()).toPNG())}}
for(const [width,height] of [[1920,1080],[1480,820],[1280,820],[760,820],[960,820],[1280,720]])for(const tone of ['pureWhite','dark'])for(const bottom of [52,84,124]){await resizeViewport(width,height);await win.webContents.executeJavaScript('window.checkNavigationGeometry('+JSON.stringify({width,tone,bottom})+')');if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS){fs.mkdirSync(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,width+'x'+height+'-'+tone+'-'+bottom+'.png'),(await win.webContents.capturePage()).toPNG())}}
await resizeViewport(1480);await win.webContents.executeJavaScript('window.checkFooterContentBoundary()');if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS)fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,'partial-sidebar-overlap.png'),(await win.webContents.capturePage()).toPNG());
await resizeViewport(760);await win.webContents.executeJavaScript('window.checkNavigationGeometry('+JSON.stringify({width:760,tone:'dark',bottom:124})+')');
await win.webContents.executeJavaScript('window.checkNavigationStyles()');await win.webContents.executeJavaScript('window.openNavigationEditor()');if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS)fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,'editor-760-dark.png'),(await win.webContents.capturePage()).toPNG());await win.webContents.executeJavaScript('window.checkCustomNavigation()');
console.log('NAVIGATION_PAGES_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    await writeFile(join(directory, 'selection-runner.cjs'), selectionRunner)
    const selectionResult = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'selection-runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 30_000 }
    )
    assert.match(selectionResult.stdout, /NAVIGATION_SELECTION_OK/)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /NAVIGATION_PAGES_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(temporaryRoot) + '\\') ||
        target.startsWith(resolve(temporaryRoot) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

// Offscreen rendering fixes DPR at 1 on Windows. Use the native compositor so
// this checks the painted pixels at 150%, not only DOM geometry or emulation.
const selectionRunner = `const {app,BrowserWindow}=require('electron')
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
app.setPath('userData',path.join(__dirname,'selection-profile'))
app.commandLine.appendSwitch('force-device-scale-factor','1.5')
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:1024,height:768,useContentSize:true,webPreferences:{contextIsolation:false,backgroundThrottling:false}})
  try{
    await win.loadFile(process.argv.at(-1))
    const scenarios=['pureWhite','dark'].flatMap(tone=>[
      ...['playlists','artists','albums','allSongs','analytics'].map(id=>({tone,id})),
      {tone,id:'analytics',style:'compact'},{tone,id:'analytics',style:'rail'}
    ])
    for(const scenario of scenarios){
      const {rect,viewport,dpr}=await win.webContents.executeJavaScript('window.prepareSelectionTest('+JSON.stringify(scenario)+')')
      const painted=await win.webContents.capturePage()
      const {width,height}=painted.getSize(),pixels=painted.toBitmap()
      assert.ok(Math.abs(width/viewport.width-dpr)<.01,'capture must retain native device pixels')
      const pixel=(x,y)=>pixels.readUInt32LE((y*width+x)*4),colors=new Map()
      for(let y=Math.ceil((rect.top+4)*dpr);y<(rect.bottom-4)*dpr;y++)for(let x=Math.ceil((rect.left+4)*dpr);x<(rect.right-4)*dpr;x++){
        const color=pixel(x,y);colors.set(color,(colors.get(color)||0)+1)
      }
      const fill=[...colors].sort((a,b)=>b[1]-a[1])[0][0]
      let left=width,top=height,right=-1,bottom=-1
      for(let y=Math.max(0,Math.floor((rect.top-8)*dpr));y<Math.min(height,(rect.bottom+rect.height)*dpr);y++)for(let x=Math.max(0,Math.floor((rect.left-8)*dpr));x<Math.min(width,(rect.right+rect.width)*dpr);x++){
        if(pixel(x,y)===fill){
          left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y)
        }
      }
      const actual={left,top,right:right+1,bottom:bottom+1},name=[scenario.tone,scenario.style||'expanded',scenario.id].join('-')
      if(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS){
        fs.mkdirSync(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,{recursive:true})
        fs.writeFileSync(path.join(process.env.TWILIGHT_NAVIGATION_SCREENSHOTS,'selection-150-'+name+'.png'),painted.toPNG())
      }
      for(const edge of ['left','top','right','bottom'])assert.ok(Math.abs(actual[edge]-rect[edge]*dpr)<=2,'painted selection escapes its button: '+JSON.stringify({name,edge,actual,expected:rect,dpr}))
    }
    console.log('NAVIGATION_SELECTION_OK');app.exit(0)
  }catch(error){console.error(error.stack);app.exit(1)}
})`

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import {BUILTIN_NAVIGATION_PAGES} from '@renderer/app/navigationPages.ts'
import {useSettingsStore} from '@renderer/stores/useSettingsStore'
import {useSideMenuClearance} from '@renderer/app/useSideMenuClearance'
import {useSongListSearch} from '@renderer/components/song-list/useSongListSearch'
import '@renderer/assets/main.css'
import '@renderer/assets/icon-fonts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=(delay=35)=>new Promise(resolve=>setTimeout(resolve,delay))
const button=label=>[...document.querySelectorAll('button')].find(node=>node.getAttribute('aria-label')===label||node.textContent.trim()===label)
const aria=label=>document.querySelector('[aria-label="'+label+'"]')
let visible=ref(true),open=ref(true),selected='',active=ref('local-home'),app,queries,key
const store=useSettingsStore()
const mount=()=>{app=createApp({setup(){key=ref('songs');queries=useSongListSearch(key);return()=>visible.value?h('div',{class:['app-shell-navigation',{'navigation-temporary':open.value}]},h(SideMenu,{open:open.value,activeKey:active.value,onSelectPage:page=>{selected=page.id;active.value=page.id}})):null}});app.mount('#app')}
const dialog=()=>document.querySelector('dialog')
const until=async(predicate,message)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error(message);await nextTick();await pause(10)}}
const openEditor=async opener=>{opener.click();await until(()=>dialog()?.matches(':modal')&&!dialog().inert&&dialog().querySelectorAll('input[type=checkbox]').length===BUILTIN_NAVIGATION_PAGES.length,'native editor did not finish mounting');await nextTick()}
const untilClosed=async()=>{const end=Date.now()+3000;while(dialog()){if(Date.now()>end)throw new Error('native dialog exit did not finish');await pause()}await nextTick()}
window.prepareSelectionTest=async({tone,id='analytics',style='expanded'})=>{
  document.documentElement.dataset.teMotion='off'
  if(!app){
    const ids=['local-home','search','playlists','artists','albums','allSongs','analytics','recent']
    store.settings.value={navigationPages:{version:1,order:ids,hidden:BUILTIN_NAVIGATION_PAGES.filter(page=>!ids.includes(page.id)).map(page=>page.id)}}
    mount()
  }
  document.documentElement.dataset.theme=tone
  document.documentElement.dataset.teNavigationStyle=style
  active.value=id;await nextTick();await document.fonts.ready
  // Let layout observers and the native compositor present the same frame.
  // A fixed delay can capture the preceding indicator size on busy CI hosts.
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
  expect(Math.abs(devicePixelRatio-1.5)<.01,'selection regression must run at 150% display scale: '+devicePixelRatio)
  const marker=document.querySelector('.navigation-indicator'),target=document.querySelector('[data-page-id="'+id+'"]'),rect=target.getBoundingClientRect(),highlight=marker.getBoundingClientRect()
  expect(['top','bottom','left','right'].every(edge=>Math.abs(highlight[edge]-rect[edge])<1),'selection does not match '+tone+' '+id+': '+JSON.stringify({highlight:highlight.toJSON(),button:rect.toJSON()}))
  const label=target.querySelector('.item-label').getBoundingClientRect()
  if(style!=='rail')expect(Math.abs((label.top+label.bottom-rect.top-rect.bottom)/2)<1,'selected label is not vertically centered')
  return {rect:rect.toJSON(),viewport:{width:innerWidth,height:innerHeight},dpr:devicePixelRatio}
}
window.runNavigationTests=async()=>{
  window.writes=0;mount();await pause(350)
  queries.searchQuery.value='moon';await pause(200);key.value='albums';await nextTick();expect(queries.searchQuery.value==='','search leaked to a different page');queries.searchQuery.value='album';await nextTick();key.value='songs';await nextTick();expect(queries.searchQuery.value==='moon'&&queries.debouncedSearchQuery.value==='moon','page search did not restore')
  expect(button('主页')&&button('流媒体音乐')&&button('音乐库'),'primary hierarchy missing')
  expect(document.querySelectorAll('button[aria-label="编辑页面"]').length===1&&button('编辑页面').closest('.menu-bottom')&&!button('全部页面')&&!document.querySelector('.menu-heading button'),'editor must have one footer entry')
  const menu=document.querySelector('.side-menu'),footer=menu.querySelector('.menu-bottom')
  expect(Math.abs(menu.getBoundingClientRect().bottom-footer.getBoundingClientRect().bottom)<=1,'collapsed navigation leaves empty space below tools')
  expect(button('流媒体音乐').getAttribute('aria-expanded')==='false'&&button('音乐库').getAttribute('aria-expanded')==='false','groups should start tucked away on home')
  const previousMotion=document.documentElement.dataset.teMotion
  document.documentElement.dataset.teMotion='full';button('音乐库').click();await pause(100)
  const marker=menu.querySelector('.navigation-indicator'),startTop=marker.getBoundingClientRect().top,songs=button('所有歌曲'),songRect=songs.getBoundingClientRect()
  songs.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,isPrimary:true,button:0,clientX:songRect.left+20,clientY:songRect.top+15}));songs.click();await nextTick();await pause(45)
  const midTop=marker.getBoundingClientRect().top
  expect(midTop>startTop+1&&midTop<songRect.top-1,'sidebar press effects snapped its moving selection')
  await pause(550);expect(Math.abs(marker.getBoundingClientRect().top-songRect.top)<1,'sidebar marker did not land on the selected row')
  document.documentElement.style.setProperty('--te-radius-global','13px');await pause()
  expect(Math.abs(parseFloat(getComputedStyle(marker).borderTopLeftRadius)*new DOMMatrix(getComputedStyle(marker).transform).a-13)<.1,'marker ignored the live corner-radius token')
  document.documentElement.style.removeProperty('--te-radius-global');menu.style.setProperty('--te-lg-context-rim','#fff');menu.classList.add('side-menu-liquid')
  expect(getComputedStyle(songs).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(marker).backgroundColor!=='rgba(0, 0, 0, 0)','liquid selected row obscures the shared marker: '+JSON.stringify({button:getComputedStyle(songs).backgroundColor,marker:getComputedStyle(marker).backgroundColor}))
  const albums=button('专辑'),albumRect=albums.getBoundingClientRect()
  const press=albums.animate([{transform:'scale(.97)'},{transform:'scale(.97)'}],{duration:1000,fill:'both'});press.pause();press.currentTime=100
  albums.click();await nextTick();await pause(550)
  expect(Math.abs(marker.getBoundingClientRect().width-albumRect.width)<1&&Math.abs(marker.getBoundingClientRect().left-albumRect.left)<1,'pressed button left the marker shrunk or displaced')
  press.cancel();songs.click();await nextTick();await pause(550)
  menu.classList.remove('side-menu-liquid');menu.style.removeProperty('--te-lg-context-rim')
  for(const layout of ['aurora-reference','paper-light','obsidian-glass','neon-gradient','studio-split','zen-minimal']){
    document.documentElement.dataset.tePresetLayout=layout
    await until(()=>Math.abs(marker.getBoundingClientRect().top-songs.getBoundingClientRect().top)<1&&Math.abs(marker.getBoundingClientRect().width-songs.getBoundingClientRect().width)<1,'preset marker did not follow the updated geometry: '+layout)
    expect(getComputedStyle(songs).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(songs).backgroundImage==='none','preset selected row obscures the shared marker: '+layout)
    expect(Math.abs(marker.getBoundingClientRect().top-songs.getBoundingClientRect().top)<1,'preset border or disclosure offset the shared marker: '+layout+' '+JSON.stringify({marker:marker.getBoundingClientRect().toJSON(),target:songs.getBoundingClientRect().toJSON(),root:marker.parentElement.getBoundingClientRect().toJSON(),scroll:marker.parentElement.scrollTop,clientTop:marker.parentElement.clientTop,transform:getComputedStyle(marker).transform,offset:marker.offsetTop,position:getComputedStyle(marker).position}))
    if(layout==='zen-minimal')expect(getComputedStyle(marker).backgroundColor==='rgba(0, 0, 0, 0)','minimal navigation acquired an unwanted selection fill')
    if(layout==='neon-gradient')expect(getComputedStyle(marker).backgroundImage.includes('linear-gradient'),'neon navigation lost its selected gradient')
  }
  delete document.documentElement.dataset.tePresetLayout;active.value='local-home';selected='';button('音乐库').click();await pause(550)
  if(previousMotion===undefined)delete document.documentElement.dataset.teMotion;else document.documentElement.dataset.teMotion=previousMotion
  button('流媒体音乐').click();await nextTick();expect(button('音乐云盘').getBoundingClientRect().height>0&&selected==='','expanding streaming navigated or omitted cloud')
  button('发现歌单').click();await nextTick();expect(selected==='discover'&&open.value&&button('流媒体音乐').getAttribute('aria-expanded')==='true','child navigation closed the menu')
  button('流媒体音乐').click();await nextTick();expect(selected==='discover'&&button('流媒体音乐').classList.contains('active'),'collapsed branch loses selected page')
  active.value='library';await nextTick();expect(button('流媒体音乐').getAttribute('aria-expanded')==='true','external navigation did not reveal active child')
  button('音乐库').focus();button('音乐库').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await nextTick();await nextTick();expect(document.activeElement===button('所有歌曲'),'keyboard expansion did not focus first child')
  button('所有歌曲').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await nextTick();expect(document.activeElement===button('音乐库')&&button('音乐库').getAttribute('aria-expanded')==='false','keyboard collapse did not restore branch focus')
  button('导入歌曲').focus();button('导入歌曲').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));expect(document.activeElement===button('编辑页面'),'toolbar arrow navigation failed')
  active.value='local-home';selected='';await nextTick()
  const opener=button('编辑页面');opener.focus();await openEditor(opener)
  expect(dialog().matches(':modal'),'editor is not modal')
  expect(dialog().querySelector('h2').textContent==='编辑页面'&&dialog().querySelectorAll('input[type=checkbox]').length===BUILTIN_NAVIGATION_PAGES.length&&!aria('搜索页面'),'footer did not open editing directly')
  aria('下移主页').click();aria('显示搜索').click();button('取消').click();await untilClosed()
  expect(window.writes===0&&selected==='','cancel wrote settings or navigated')
  expect(document.activeElement===opener,'editor did not restore focus')
  await openEditor(opener);expect(aria('显示搜索').checked,'cancel retained hidden state')
  const first=document.querySelector('[data-reorder-id="local-home"] .drag-handle'),second=document.querySelector('[data-reorder-id="streaming-home"]')
  const a=first.getBoundingClientRect(),b=second.getBoundingClientRect()
  first.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:1,isPrimary:true,bubbles:true,clientX:a.x+3,clientY:a.y+3}))
  document.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,isPrimary:true,bubbles:true,cancelable:true,clientX:b.x+100,clientY:b.y+30}))
  document.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,isPrimary:true,bubbles:true,clientX:b.x+100,clientY:b.y+30}))
  await nextTick();expect(document.querySelector('[data-reorder-id]').dataset.reorderId==='streaming-home','handle drag failed')
  aria('上移主页').focus();aria('上移主页').click();await nextTick();expect(document.querySelector('[data-reorder-id]').dataset.reorderId==='local-home','keyboard-accessible move failed')
  window.failSave=true;button('保存').click();await pause();expect(dialog()&&dialog().querySelector('[role=alert]').textContent.includes('disk failure')&&window.writes===0,'failed save closed the editor or wrote preferences');window.failSave=false
  for(const input of dialog().querySelectorAll('input[type=checkbox]'))if(input.checked)input.click()
  button('保存').click();await untilClosed();expect(window.writes===1&&document.querySelectorAll('.menu-nav [aria-current]').length===0,'hide-all failed')
  const saved=window.saved;app.unmount();store.settings.value=JSON.parse(saved);mount();await pause()
  expect(button('编辑页面')&&button('添加常用页面')&&!button('主页'),'hidden page appeared after remount')
  await openEditor(button('编辑页面'));expect(!aria('显示网络源').checked&&dialog().querySelectorAll('input[type=checkbox]').length===BUILTIN_NAVIGATION_PAGES.length,'editor lost hidden pages');button('取消').click();await untilClosed()
  expect(window.writes===1&&store.settings.value.navigationPages.hidden.length===16,'cancel changed hidden-page configuration')
  await openEditor(button('添加常用页面'));aria('显示网络源').click();await nextTick();expect(aria('显示网络源').checked,'network checkbox did not update');button('保存').click();await untilClosed();await until(()=>button('网络源')?.checkVisibility(),'restored network page did not become visible after saving');button('网络源').click();await nextTick()
  expect(selected==='network'&&window.writes===2&&store.settings.value.navigationPages.hidden.length===15,'editor could not restore a hidden page: '+JSON.stringify({selected,writes:window.writes,hidden:store.settings.value.navigationPages.hidden}))
  active.value='local-home';app.unmount();mount();await pause();expect(button('网络源')?.checkVisibility()&&button('流媒体音乐').getAttribute('aria-expanded')==='true','saved network page was hidden by its group after remount')
  await openEditor(button('编辑页面'));button('恢复默认').click();button('保存').click();await untilClosed();expect(button('主页')&&button('流派')&&button('音乐云盘'),'restore defaults failed')
  open.value=false;await nextTick();expect(document.querySelector('.side-menu').inert,'closed sidebar remains interactive');open.value=true;await pause()
  document.documentElement.dataset.teShellLayout='custom';document.documentElement.dataset.teShellNavigation='persistent';open.value=false;await pause();expect(!document.querySelector('.side-menu').inert,'persistent shell is inert');delete document.documentElement.dataset.teShellLayout;delete document.documentElement.dataset.teShellNavigation;open.value=true
  store.settings.value={navigationPages:{version:1,order:BUILTIN_NAVIGATION_PAGES.map(page=>page.id),hidden:[]}}
  await nextTick();for(const label of ['流媒体音乐','音乐库'])if(button(label).getAttribute('aria-expanded')==='false')button(label).click();await nextTick()
}
window.checkSlidingNavigation=async()=>{
  const host=document.querySelector('#app'),menu=document.querySelector('.side-menu'),bar=document.querySelector('.playbar-fixture')
  bar.classList.add('player-bar-shell');bar.style.left='';bar.style.right='';bar.style.height='84px'
  host.style.setProperty('--te-side-menu-bottom','0px');host.style.setProperty('--te-side-menu-tools-clearance','0px')
  open.value=true;await pause(350)
  const clearance=useSideMenuClearance({showLocalSidebar:visible,hasPlayerBar:ref(true)})
  const measure=async()=>{clearance.measureSideMenuClearance();host.style.setProperty('--te-side-menu-bottom',clearance.sideMenuBottomOffset.value+'px');host.style.setProperty('--te-side-menu-tools-clearance',clearance.sideMenuToolsClearance.value+'px');await nextTick()}
  for(let i=0;i<3;i++)await measure()
  const surface=bar.querySelector('.player-bar').getBoundingClientRect(),contentRight=Math.max(...[...menu.querySelectorAll('.menu-toolbar .item-icon,.menu-toolbar .item-label')].map(node=>node.getBoundingClientRect().right)),expected=surface.left<contentRight+10?Math.ceil(innerHeight-4-surface.top)+10:0
  expect(clearance.sideMenuBottomOffset.value===0&&clearance.sideMenuToolsClearance.value===expected,'window tools reserve the wrong playback band');expect(Math.abs(menu.getBoundingClientRect().bottom-(innerHeight-4))<1,'sidebar surface does not reach the window bottom');expect(Math.abs(button('编辑页面').getBoundingClientRect().bottom-(innerHeight-4-Math.max(12,expected)))<1,'edit entry does not clear the painted player');
  const baseline=menu.getBoundingClientRect(),targets=[...menu.querySelectorAll('.menu-toolbar button')],tops=targets.map(target=>target.getBoundingClientRect().top)
  const sample=async()=>{await new Promise(requestAnimationFrame);await measure();const rect=menu.getBoundingClientRect();expect(Math.abs(rect.height-baseline.height)<1,'sidebar changed height during its horizontal slide');for(let i=0;i<targets.length;i++)expect(Math.abs(targets[i].getBoundingClientRect().top-tops[i])<1,'footer jumped while opening or closing the sidebar')}
  for(const [expanded,frames] of [[false,24],[true,24],[false,6],[true,6],[false,6],[true,24]]){open.value=expanded;await nextTick();for(let i=0;i<frames;i++)await sample()}
  clearance.dispose();bar.style.left='';bar.style.right='';host.style.setProperty('--te-side-menu-tools-clearance','0px')
}
window.checkDesktopNavigation=async({tone})=>{
  document.documentElement.dataset.theme=tone;document.documentElement.style.setProperty('--te-font-size-body','14px')
  const host=document.querySelector('#app'),menu=document.querySelector('.side-menu'),bar=document.querySelector('.playbar-fixture')
  host.style.setProperty('--te-side-menu-bottom','0px');bar.style.left='';bar.style.height='84px';await pause(350)
  expect(getComputedStyle(menu).backgroundColor==='rgba(0, 0, 0, 0)','default sidebar paints a dark overlay in '+tone)
  expect(getComputedStyle(menu).backdropFilter.includes('blur('),'removing the tint disabled sidebar diffusion')
  const clearance=useSideMenuClearance({showLocalSidebar:visible,hasPlayerBar:ref(true)});clearance.measureSideMenuClearance()
  host.style.setProperty('--te-side-menu-bottom',clearance.sideMenuBottomOffset.value+'px');host.style.setProperty('--te-side-menu-tools-clearance',clearance.sideMenuToolsClearance.value+'px');await nextTick()
  expect(clearance.sideMenuBottomOffset.value===0&&clearance.sideMenuToolsClearance.value===0,'desktop playbar reserves empty space under the tools')
  expect(Math.abs(menu.getBoundingClientRect().bottom-(window.innerHeight-4))<=1,'desktop playbar shortens the sidebar')
  expect(Math.abs(window.innerHeight-4-button('编辑页面').getBoundingClientRect().bottom-12)<=1,'edit entry leaves a playback-height gap above the window bottom')
  const target=button('编辑页面').getBoundingClientRect();expect(button('编辑页面').contains(document.elementFromPoint(target.x+target.width/2,target.y+target.height/2)),'wide-window tools are covered by the centred player surface')
  clearance.dispose()
}
window.checkNavigationGeometry=async({width,tone,bottom})=>{
  const host=document.querySelector('#app'),bar=document.querySelector('.playbar-fixture');bar.style.left='';host.style.setProperty('--te-side-menu-tools-clearance','0px')
  document.documentElement.dataset.theme=tone;document.documentElement.style.setProperty('--te-font-size-body','21px');document.querySelector('#app').style.setProperty('--te-side-menu-bottom','0px');document.querySelector('.playbar-fixture').style.height=bottom+'px';await pause(350)
  const clearance=useSideMenuClearance({showLocalSidebar:visible,hasPlayerBar:ref(true)})
  for(let i=0;i<3;i++){clearance.measureSideMenuClearance();host.style.setProperty('--te-side-menu-bottom',clearance.sideMenuBottomOffset.value+'px');host.style.setProperty('--te-side-menu-tools-clearance',clearance.sideMenuToolsClearance.value+'px');await nextTick()}
  const prefs=JSON.stringify(store.settings.value.navigationPages),menu=document.querySelector('.side-menu'),nav=menu.querySelector('.menu-nav'),footer=menu.querySelector('.menu-bottom'),surface=bar.querySelector('.player-bar').getBoundingClientRect(),contentRight=Math.max(...[...menu.querySelectorAll('.menu-toolbar .item-icon,.menu-toolbar .item-label')].map(node=>node.getBoundingClientRect().right)),overlaps=surface.left<contentRight+10,expectedBottom=overlaps?surface.top-10:innerHeight-4-12
  expect(Math.abs(menu.getBoundingClientRect().bottom-(innerHeight-4))<=1,'sidebar surface no longer reaches the window bottom');const action=button('编辑页面'),target=action.getBoundingClientRect();expect(Math.abs(target.bottom-expectedBottom)<=1,'tools do not follow icon and label overlap');const label=action.querySelector('.item-label').getBoundingClientRect();expect(action.contains(document.elementFromPoint(label.x+label.width/2,label.y+label.height/2)),'playbar intercepts the bottom label');if(overlaps)expect(target.bottom<surface.top,'tools paint behind the overlapping player');expect(Number(getComputedStyle(bar).zIndex)>Number(getComputedStyle(menu).zIndex),'player no longer paints above the sidebar surface');if(innerHeight<=820)expect(nav.scrollHeight>nav.clientHeight,'large text directory does not scroll independently');expect(Math.abs(menu.getBoundingClientRect().bottom-footer.getBoundingClientRect().bottom)<=1,'tools are not anchored to the sidebar bottom');expect(button('编辑页面').getBoundingClientRect().top>=menu.getBoundingClientRect().top,'edit action scrolled out of footer')
  for(const label of ['主页','流媒体音乐','音乐库','我的音乐库']){const text=button(label).querySelector('.item-label');expect(text.scrollWidth<=text.clientWidth,'large-text navigation label is truncated: '+label)}
  await openEditor(button('编辑页面'));expect(dialog().getBoundingClientRect().right<=width&&dialog().getBoundingClientRect().bottom<=window.innerHeight,'dialog overflows narrow window');button('取消').click();await untilClosed();expect(JSON.stringify(store.settings.value.navigationPages)===prefs,'theme/layout changed saved preferences')
  clearance.dispose()
}
window.checkFooterContentBoundary=async()=>{
  document.documentElement.dataset.theme='pureWhite';document.documentElement.style.setProperty('--te-font-size-body','14px')
  const host=document.querySelector('#app'),menu=document.querySelector('.side-menu'),bar=document.querySelector('.playbar-fixture'),surface=bar.querySelector('.player-bar')
  const clearance=useSideMenuClearance({showLocalSidebar:visible,hasPlayerBar:ref(true)})
  const measure=async()=>{clearance.measureSideMenuClearance();host.style.setProperty('--te-side-menu-bottom',clearance.sideMenuBottomOffset.value+'px');host.style.setProperty('--te-side-menu-tools-clearance',clearance.sideMenuToolsClearance.value+'px');await nextTick()}
  try{
    await pause(350);const original=surface.getBoundingClientRect(),label=button('编辑页面').querySelector('.item-label').getBoundingClientRect()
    expect(original.left<menu.getBoundingClientRect().right&&original.left>label.right+10,'fixture does not reproduce overlap with only sidebar whitespace')
    for(const expanded of [true,false,true]){open.value=expanded;await pause(350);for(let pass=0;pass<3;pass++)await measure();expect(clearance.sideMenuToolsClearance.value===0,'trailing sidebar whitespace lifts the footer');expect(Math.abs(button('编辑页面').getBoundingClientRect().bottom-(innerHeight-4-12))<1,'partially overlaid sidebar tools leave the window bottom');expect(Math.abs(surface.getBoundingClientRect().left-original.left)<1,'footer adjustment moves the player')}
    const icon=button('编辑页面').querySelector('.item-icon').getBoundingClientRect(),target=button('编辑页面').querySelector('.item-label').getBoundingClientRect()
    for(const rect of [icon,target])expect(button('编辑页面').contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)),'partially overlaid tools are not clickable')
    surface.style.maxWidth='none';await pause(35);await measure();expect(clearance.sideMenuToolsClearance.value>0&&button('编辑页面').getBoundingClientRect().bottom<surface.getBoundingClientRect().top,'actual label coverage does not lift the footer')
    surface.style.maxWidth='';await pause(35);await measure();expect(clearance.sideMenuToolsClearance.value===0,'footer does not return to the window bottom after coverage clears')
  }finally{surface.style.maxWidth='';clearance.dispose()}
  await pause(75)
}
window.prepareSidebarPreview=async({tone,expanded})=>{
  document.documentElement.dataset.theme=tone;document.documentElement.style.setProperty('--te-font-size-body','14px')
  for(const label of ['流媒体音乐','音乐库'])if((button(label).getAttribute('aria-expanded')==='true')!==expanded)button(label).click()
  await pause(350)
}
window.checkNavigationStyles=async()=>{
  for(const style of ['compact','rail']){
    document.documentElement.dataset.teNavigationStyle=style;await pause(350)
    const menu=document.querySelector('.side-menu').getBoundingClientRect()
    for(const target of document.querySelectorAll('.menu-toolbar button')){const rect=target.getBoundingClientRect();expect(rect.left>=menu.left&&rect.right<=menu.right&&rect.bottom<=menu.bottom,'toolbar overflows '+style)}
    button('流媒体音乐').focus();button('流媒体音乐').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await nextTick();button('流媒体音乐').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await nextTick();await nextTick();expect(document.activeElement===button('推荐主页'),'group keyboard navigation fails in '+style)
  }
  document.documentElement.dataset.teNavigationStyle='expanded';await pause(350)
}
window.openNavigationEditor=async()=>{await openEditor(button('编辑页面'))}
window.checkCustomNavigation=async()=>{
  button('取消').click();document.querySelector('#app').style.setProperty('--te-side-menu-bottom','124px');document.documentElement.dataset.teShellLayout='custom'
  for(const mode of ['hidden','persistent']){
    document.documentElement.dataset.teShellNavigation=mode;open.value=false;await pause();expect(getComputedStyle(document.querySelector('.app-shell-navigation')).display==='none','compact shell navigation was not hidden')
    open.value=true;await pause(350);const wrapper=document.querySelector('.app-shell-navigation'),menu=document.querySelector('.side-menu'),rect=menu.getBoundingClientRect()
    expect(getComputedStyle(wrapper).display!=='none'&&getComputedStyle(wrapper).position==='fixed'&&rect.width>100&&rect.right>100,'custom compact shell cannot open temporary navigation')
    expect(rect.bottom<=window.innerHeight-4-124+1,'custom compact navigation overlaps playbar')
  }
  delete document.documentElement.dataset.teShellLayout;delete document.documentElement.dataset.teShellNavigation
}
`
