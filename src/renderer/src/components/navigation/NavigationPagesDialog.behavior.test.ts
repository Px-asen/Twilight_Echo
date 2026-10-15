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
      `import {ref} from 'vue';const libraryScanStatus=ref({state:'idle'}),libraryScanProgress=ref(null);window.navigationScan={libraryScanStatus,libraryScanProgress};export const useMusicStore=()=>({libraryScanStatus,libraryScanProgress})`
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

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import NavigationPagesDialog from '@renderer/components/navigation/NavigationPagesDialog.vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
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
let visible=ref(true),open=ref(true),editing=ref(false),selected='',active=ref('local-home'),app,queries,key
const store=useSettingsStore()
const mount=()=>{app=createApp({setup(){key=ref('songs');queries=useSongListSearch(key);return()=>[
visible.value?h('div',{class:['app-shell-navigation',{'navigation-temporary':open.value}]},h(SideMenu,{open:open.value,activeKey:active.value,onSelectPage:page=>{selected=page.id;active.value=page.id}})):null,
h(NativeDialogTransition,null,()=>editing.value?h(NavigationPagesDialog,{pages:BUILTIN_NAVIGATION_PAGES,edit:true,onClose:()=>editing.value=false}):null)
]}});app.mount('#app')}
// The user removed the sidebar footer actions. Exercise the editor independently.
const editorOpener=()=>document.querySelector('#opener')
document.querySelector('#opener').onclick=()=>editing.value=true
const dialog=()=>document.querySelector('dialog')
const until=async(predicate,message)=>{const end=Date.now()+3000;while(!predicate()){if(Date.now()>end)throw new Error(message);await nextTick();await pause(10)}}
const openEditor=async opener=>{opener.click();await until(()=>dialog()?.matches(':modal')&&!dialog().inert&&dialog().querySelectorAll('input[type=checkbox]').length===BUILTIN_NAVIGATION_PAGES.length,'native editor did not finish mounting');await nextTick()}
const untilClosed=async()=>{const end=Date.now()+3000;while(dialog()){if(Date.now()>end)throw new Error('native dialog exit did not finish');await pause()}await nextTick()}
window.runNavigationTests=async()=>{
  window.writes=0;mount();await pause(350)
  queries.searchQuery.value='moon';await pause(200);key.value='albums';await nextTick();expect(queries.searchQuery.value==='','search leaked to a different page');queries.searchQuery.value='album';await nextTick();key.value='songs';await nextTick();expect(queries.searchQuery.value==='moon'&&queries.debouncedSearchQuery.value==='moon','page search did not restore')
  expect(button('主页')&&button('流媒体音乐')&&button('音乐库'),'primary hierarchy missing')
  expect(!button('编辑页面')&&!button('导入歌曲')&&!button('全部页面')&&!document.querySelector('.menu-heading button'),'removed sidebar actions returned')
  expect(!document.querySelector('.menu-bottom'),'idle sidebar reserves a removed toolbar')
  expect(button('流媒体音乐').getAttribute('aria-expanded')==='false'&&button('音乐库').getAttribute('aria-expanded')==='false','groups should start tucked away on home')
  button('流媒体音乐').click();await nextTick();expect(button('音乐云盘').getBoundingClientRect().height>0&&selected==='','expanding streaming navigated or omitted cloud')
  button('发现歌单').click();await nextTick();expect(selected==='discover'&&open.value&&button('流媒体音乐').getAttribute('aria-expanded')==='true','child navigation closed the menu')
  button('流媒体音乐').click();await nextTick();expect(selected==='discover'&&button('流媒体音乐').classList.contains('active'),'collapsed branch loses selected page')
  active.value='library';await nextTick();expect(button('流媒体音乐').getAttribute('aria-expanded')==='true','external navigation did not reveal active child')
  button('音乐库').focus();button('音乐库').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await nextTick();await nextTick();expect(document.activeElement===button('所有歌曲'),'keyboard expansion did not focus first child')
  button('所有歌曲').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await nextTick();expect(document.activeElement===button('音乐库')&&button('音乐库').getAttribute('aria-expanded')==='false','keyboard collapse did not restore branch focus')
  active.value='local-home';selected='';await nextTick()
  const opener=editorOpener();opener.focus();await openEditor(opener)
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
  expect(editorOpener()&&button('添加常用页面')&&!button('主页'),'hidden page appeared after remount')
  await openEditor(editorOpener());expect(!aria('显示网络源').checked&&dialog().querySelectorAll('input[type=checkbox]').length===BUILTIN_NAVIGATION_PAGES.length,'editor lost hidden pages');button('取消').click();await untilClosed()
  expect(window.writes===1&&store.settings.value.navigationPages.hidden.length===16,'cancel changed hidden-page configuration')
  await openEditor(button('添加常用页面'));aria('显示网络源').click();await nextTick();expect(aria('显示网络源').checked,'network checkbox did not update');button('保存').click();await untilClosed();await until(()=>button('网络源')?.checkVisibility(),'restored network page did not become visible after saving');button('网络源').click();await nextTick()
  expect(selected==='network'&&window.writes===2&&store.settings.value.navigationPages.hidden.length===15,'editor could not restore a hidden page: '+JSON.stringify({selected,writes:window.writes,hidden:store.settings.value.navigationPages.hidden}))
  await openEditor(editorOpener());button('恢复默认').click();button('保存').click();await untilClosed();expect(button('主页')&&button('流派')&&button('音乐云盘'),'restore defaults failed')
  open.value=false;await nextTick();expect(document.querySelector('.side-menu').inert,'closed sidebar remains interactive');open.value=true;await pause()
  document.documentElement.dataset.teShellLayout='custom';document.documentElement.dataset.teShellNavigation='persistent';open.value=false;await pause();expect(!document.querySelector('.side-menu').inert,'persistent shell is inert');delete document.documentElement.dataset.teShellLayout;delete document.documentElement.dataset.teShellNavigation;open.value=true
  store.settings.value={navigationPages:{version:1,order:BUILTIN_NAVIGATION_PAGES.map(page=>page.id),hidden:[]}}
  await nextTick();for(const label of ['流媒体音乐','音乐库'])if(button(label).getAttribute('aria-expanded')==='false')button(label).click();await nextTick()
}
window.checkSlidingNavigation=async()=>{
  const host=document.querySelector('#app'),menu=document.querySelector('.side-menu'),bar=document.querySelector('.playbar-fixture')
  bar.style.left='';bar.style.right='';bar.style.height='84px'
  host.style.setProperty('--te-side-menu-bottom','0px');host.style.setProperty('--te-side-menu-tools-clearance','0px')
  open.value=true;await pause(350)
  const clearance=useSideMenuClearance({showLocalSidebar:visible,hasPlayerBar:ref(true)})
  const measure=async()=>{clearance.measureSideMenuClearance();host.style.setProperty('--te-side-menu-bottom',clearance.sideMenuBottomOffset.value+'px');host.style.setProperty('--te-side-menu-tools-clearance',clearance.sideMenuToolsClearance.value+'px');await nextTick()}
  for(let i=0;i<3;i++)await measure()
  expect(clearance.sideMenuBottomOffset.value===0&&clearance.sideMenuToolsClearance.value===0,'idle navigation reserves space for removed toolbar actions')
  expect(Math.abs(menu.getBoundingClientRect().bottom-(innerHeight-4))<1,'sidebar material loses its retained window inset')
  const baseline=menu.getBoundingClientRect(),contentHeight=menu.querySelector('.menu-nav').clientHeight
  const sample=async()=>{await new Promise(requestAnimationFrame);await measure();expect(Math.abs(menu.getBoundingClientRect().height-baseline.height)<1,'sidebar changed height during its horizontal slide');expect(menu.querySelector('.menu-nav').clientHeight===contentHeight,'navigation scrolling area changed during its horizontal slide')}
  for(const [expanded,frames] of [[false,24],[true,24],[false,6],[true,6],[false,6],[true,24]]){open.value=expanded;await nextTick();for(let i=0;i<frames;i++)await sample()}
  clearance.dispose();bar.style.left='';bar.style.right='';host.style.setProperty('--te-side-menu-tools-clearance','0px')
}
window.checkDesktopNavigation=async({tone})=>{
  document.documentElement.dataset.theme=tone;document.documentElement.style.setProperty('--te-font-size-body','14px')
  const host=document.querySelector('#app'),menu=document.querySelector('.side-menu'),bar=document.querySelector('.playbar-fixture')
  host.style.setProperty('--te-side-menu-bottom','0px');bar.style.left='';bar.style.height='84px';await pause(350)
  const clearance=useSideMenuClearance({showLocalSidebar:visible,hasPlayerBar:ref(true)});clearance.measureSideMenuClearance()
  host.style.setProperty('--te-side-menu-bottom',clearance.sideMenuBottomOffset.value+'px');host.style.setProperty('--te-side-menu-tools-clearance',clearance.sideMenuToolsClearance.value+'px');await nextTick()
  expect(clearance.sideMenuBottomOffset.value===0&&clearance.sideMenuToolsClearance.value===0,'desktop playbar reserves empty space under removed tools')
  expect(Math.abs(menu.getBoundingClientRect().bottom-(innerHeight-4))<=1,'desktop player shortens the retained sidebar material')
  expect(!menu.querySelector('.menu-bottom'),'idle sidebar restores removed actions')
  clearance.dispose()
}
window.checkNavigationGeometry=async({width,tone,bottom})=>{
  const host=document.querySelector('#app'),bar=document.querySelector('.playbar-fixture');bar.style.left='';host.style.setProperty('--te-side-menu-tools-clearance','0px')
  document.documentElement.dataset.theme=tone;document.documentElement.style.setProperty('--te-font-size-body','21px');host.style.setProperty('--te-side-menu-bottom','0px');bar.style.height=bottom+'px';await pause(350)
  const clearance=useSideMenuClearance({showLocalSidebar:visible,hasPlayerBar:ref(true)})
  for(let i=0;i<3;i++){clearance.measureSideMenuClearance();host.style.setProperty('--te-side-menu-bottom',clearance.sideMenuBottomOffset.value+'px');host.style.setProperty('--te-side-menu-tools-clearance',clearance.sideMenuToolsClearance.value+'px');await nextTick()}
  const prefs=JSON.stringify(store.settings.value.navigationPages),menu=document.querySelector('.side-menu'),nav=menu.querySelector('.menu-nav')
  expect(Math.abs(menu.getBoundingClientRect().bottom-(innerHeight-4))<=1,'sidebar loses its full-height inset surface')
  expect(clearance.sideMenuToolsClearance.value===0&&!menu.querySelector('.menu-bottom'),'idle navigation reserves removed footer actions')
  if(innerHeight<=820)expect(nav.scrollHeight>nav.clientHeight,'large text directory does not scroll independently')
  for(const label of ['主页','流媒体音乐','音乐库','我的音乐库']){const text=button(label).querySelector('.item-label');expect(text.scrollWidth<=text.clientWidth,'large-text navigation label is truncated: '+label)}
  await openEditor(editorOpener());expect(dialog().getBoundingClientRect().right<=width&&dialog().getBoundingClientRect().bottom<=innerHeight,'dialog overflows narrow window');button('取消').click();await untilClosed();expect(JSON.stringify(store.settings.value.navigationPages)===prefs,'theme/layout changed saved preferences')
  clearance.dispose()
}
window.checkFooterContentBoundary=async()=>{
  document.documentElement.dataset.theme='pureWhite';document.documentElement.style.setProperty('--te-font-size-body','14px')
  const host=document.querySelector('#app'),menu=document.querySelector('.side-menu'),bar=document.querySelector('.playbar-fixture'),surface=bar.querySelector('.player-bar')
  open.value=true;window.navigationScan.libraryScanStatus.value={state:'running',total:12,current:4};await nextTick();await pause(350)
  const clearance=useSideMenuClearance({showLocalSidebar:visible,hasPlayerBar:ref(true)})
  const measure=async()=>{clearance.measureSideMenuClearance();host.style.setProperty('--te-side-menu-bottom',clearance.sideMenuBottomOffset.value+'px');host.style.setProperty('--te-side-menu-tools-clearance',clearance.sideMenuToolsClearance.value+'px');await nextTick()}
  try{
    const footer=menu.querySelector('.menu-bottom'),label=footer?.querySelector('.scanning-label');expect(label&&label.textContent.includes('4/12')&&!footer.querySelector('button'),'scan footer must show one status without duplicate actions')
    for(const expanded of [true,false,true]){open.value=expanded;await pause(350);for(let i=0;i<3;i++)await measure();expect(clearance.sideMenuToolsClearance.value===0,'centred player lifts uncovered scanning status')}
    surface.style.maxWidth='none';await pause(35);for(let i=0;i<3;i++)await measure();expect(clearance.sideMenuToolsClearance.value>0&&label.getBoundingClientRect().bottom<surface.getBoundingClientRect().top,'painted player covers scanning status')
    surface.style.maxWidth='';await pause(35);for(let i=0;i<3;i++)await measure();expect(clearance.sideMenuToolsClearance.value===0,'scan footer fails to return after coverage clears')
  }finally{surface.style.maxWidth='';window.navigationScan.libraryScanStatus.value={state:'idle'};await nextTick();await measure();expect(!menu.querySelector('.menu-bottom')&&clearance.sideMenuToolsClearance.value===0,'finished scan reserves empty footer');clearance.dispose()}
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
window.openNavigationEditor=async()=>{await openEditor(editorOpener())}
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
