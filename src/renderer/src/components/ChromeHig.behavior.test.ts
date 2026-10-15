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
      join(directory, 'account-login.vue'),
      '<script setup>defineEmits(["loginSuccess"]);defineExpose({canDismissOutside:()=>true})</script><template><div class="account-login-fixture"><h2>音乐账户</h2><button type="button" @click="$emit(\'loginSuccess\')">进入流媒体</button></div></template>'
    )
    await writeFile(
      join(directory, 'fixtures.ts'),
      `import {ref} from 'vue'
const settings=ref({navigationPages:{version:1,order:[],hidden:[]}})
export const useSettingsStore=()=>({settings,updateSettings:async()=>{}})
export const useMusicStore=()=>({libraryScanStatus:ref({state:'idle'}),libraryScanProgress:ref(null)})
export const useNcmStore=()=>({isLoggedIn:ref(false),profile:ref(null)})
export const useProviderStore=()=>({providers:ref([]),getProvider:()=>null})
export const useAppNoticeStore=()=>({unreadCount:ref(1),activeTaskCount:ref(0),doNotDisturb:ref(false)})
export const useWindowChrome=()=>({maximized:ref(false)})
export const useBackStack=()=>({canGoBack:ref(true),backHint:ref(null)})`
    )
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
            find: /.*\/components\/LoginPage\.vue$/,
            replacement: join(directory, 'account-login.vue')
          },
          { find: './LoginPage.vue', replacement: join(directory, 'account-login.vue') },
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
        try{await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await win.webContents.executeJavaScript('window.runChromeHigTests()');for(const width of [1360,960,640]){win.setContentSize(width,800);await win.webContents.executeJavaScript('(async()=>{await window.checkPageDockViewport();await window.checkAccountChildViewport()})()')}win.setContentSize(1080,800);
          win.webContents.focus();await win.webContents.executeJavaScript('window.prepareLibraryPortal()');
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
          win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
          await new Promise(resolve=>setTimeout(resolve,60));
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
          win.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13)});
          win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
          await new Promise(resolve=>setTimeout(resolve,150));
          await win.webContents.executeJavaScript('window.checkLibraryActivation()');
          if(process.env.TE_CHROME_PREVIEW)require('node:fs').writeFileSync(process.env.TE_CHROME_PREVIEW,(await win.webContents.capturePage()).toPNG());
          console.error('CHROME_HIG_OK');app.exit(0);
        }catch(error){console.error(error);app.exit(1)}});`
    )
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, env: environment }
    )
    assert.match(result.stderr, /CHROME_HIG_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,ref,shallowRef,nextTick} from 'vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import AccountPage from '@renderer/components/AccountPage.vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import SidebarBookmark from '@renderer/components/SidebarBookmark.vue'
import StreamingLibrary from '@renderer/components/StreamingLibrary.vue'
import '@renderer/assets/base.css'
import '@renderer/assets/materials.css'
import '@renderer/assets/bohr.css'
import '@renderer/assets/fonts.css'
import '@renderer/assets/icon-fonts.ts'
const active=ref('streaming-home'),open=ref(true),liquid=ref(false),home=ref(true),selected=[]
const account=ref(false),accountAnchor=shallowRef(null);let noticeTarget=null
const draftValue=ref('原页面编辑内容')
const closeAccount=async(returnFocus=true)=>{account.value=false;if(returnFocus){await nextTick();accountAnchor.value?.focus()}}
let recent=0,ranking=0,homes=0,plugins=0,dockRuns=0,accountLogins=0
const docks=ref([{id:'play',label:'播放全部',icon:'library.play',run:()=>dockRuns++},{id:'shuffle',label:'随机播放',icon:'library.shuffle',run:()=>dockRuns++},{id:'add',label:'添加音乐',icon:'navigation.import',run:()=>dockRuns++}])
createApp({render:()=>h('div',[
 h(TitleBar,{menuOpen:open.value,home:home.value,accountOpen:account.value,pageDockActions:docks.value,preview:true,activeTool:'settings',onHome:()=>{home.value=true;homes++},onToggleMenu:()=>open.value=!open.value,onLogin:(_provider,anchor)=>{accountAnchor.value=anchor;account.value=!account.value}}),
 h(SidebarBookmark,{open:open.value,onToggle:()=>open.value=!open.value}),
 h(SideMenu,{open:open.value,liquidMaterial:liquid.value,activeKey:active.value,onPlugins:()=>plugins++,onSelectPage:page=>{active.value=page.id;selected.push(page.id)}}),
 h('div',{class:'retained-page'},[h('input',{class:'parent-draft',tabindex:-1,value:draftValue.value,onInput:event=>draftValue.value=event.target.value}),h(StreamingLibrary,{isLoggedIn:true,profile:null,profileSignature:'',likedSummary:{name:'喜欢',trackCount:0,cover:null},libraryLoaded:true,userPlaylistEntries:[],showLikedPanel:false,showSocialStats:false,showFeatureCards:true,onOpenRecent:()=>recent++,onOpenRanking:()=>ranking++})]),
 account.value?h(AccountPage,{anchor:accountAnchor.value,onClose:closeAccount,onLoginSuccess:()=>accountLogins++,onNoticeTarget:target=>{noticeTarget=target;if(target)target.textContent='任务与通知'}}):null
])}).mount('#app')
const expect=(condition,message)=>{if(!condition)throw Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,350))}
const visibleGlyph=icon=>[...icon.querySelectorAll('.theme-icon-glyph')].filter(glyph=>getComputedStyle(glyph).display!=='none')
window.checkAccountChildViewport=async()=>{
 const parent=document.querySelector('.retained-page'),draft=parent.querySelector('.parent-draft'),avatar=document.querySelector('.login-btn');draft.value='保留原页面状态';draft.dispatchEvent(new Event('input',{bubbles:true}));avatar.click();await settle();
 const child=document.querySelector('#account-subpage'),rect=child.getBoundingClientRect(),anchor=avatar.getBoundingClientRect();
 expect(document.querySelector('.retained-page')===parent&&draft.value==='保留原页面状态'&&getComputedStyle(parent).display!=='none','avatar replaced or reset its parent page');
 expect(child.getAttribute('role')==='dialog'&&child.getAttribute('aria-modal')==='false'&&rect.width<=440&&rect.width<innerWidth&&rect.left>=12&&rect.right<=innerWidth-11&&rect.top>=anchor.bottom&&rect.bottom<=innerHeight,'nonmodal avatar child is not anchored inside the viewport');
 expect(getComputedStyle(child).borderTopWidth==='0px'&&avatar.getAttribute('aria-expanded')==='true'&&noticeTarget?.isConnected,'avatar child has an outer frame or loses tasks');
 child.querySelector('button').focus();expect(account.value,'focus inside the child dismissed it');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();
 expect(!account.value&&!noticeTarget&&document.activeElement===avatar&&document.querySelector('.retained-page')===parent,'Escape did not return to the avatar and retain the parent');
 avatar.click();await settle();draft.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));draft.focus();await settle();expect(!account.value&&document.activeElement===draft&&draft.value==='保留原页面状态','outside dismissal steals focus or resets the parent');
 avatar.click();await settle();document.querySelector('.appearance-btn').focus();await settle();expect(!account.value,'keyboard navigation outside the child failed to dismiss it');
 const beforeLogin=accountLogins;avatar.click();await settle();document.querySelector('.account-login-fixture button').click();await nextTick();expect(accountLogins===beforeLogin+1,'account child swallows the login/profile continuation');avatar.click();await settle();
}
window.checkPageDockViewport=async()=>{
 await settle();
 const dockStyle=getComputedStyle(document.querySelector('.page-dock'));
 expect(dockStyle.borderTopWidth==='0px'&&dockStyle.backgroundColor==='rgba(0, 0, 0, 0)'&&dockStyle.boxShadow==='none'&&!document.querySelector('.page-dock-label'),'page tools introduce an outer frame or navigation caption');
 const dock=document.querySelector('.page-dock').getBoundingClientRect(),appearance=document.querySelector('.appearance-btn').getBoundingClientRect(),close=document.querySelector('.close').getBoundingClientRect();
 expect(dock.right<=appearance.left+1,'page Dock overlaps appearance');
 expect(dock.left>=document.querySelector('.title-bar-back').getBoundingClientRect().right,'page Dock covers navigation or drag space');
 expect(close.right<=innerWidth+1,'window controls leave the viewport');
 const divider=document.querySelector('.page-dock-divider').getBoundingClientRect();
 expect(divider.width>=1&&divider.height>=14&&Math.abs(divider.top+divider.height/2-dock.top-dock.height/2)<1,'Dock section divider is missing or not centered in its toolbar');
 for(const button of document.querySelectorAll('.page-dock-action')){
  const box=button.getBoundingClientRect(),icon=button.querySelector('.theme-icon').getBoundingClientRect(),label=button.querySelector('.page-dock-action-label');
  expect(Math.abs(icon.top+icon.height/2-box.top-box.height/2)<1,'Dock glyph is not vertically centered');
  if(getComputedStyle(label).display!=='none'){const text=label.getBoundingClientRect();expect(Math.abs(text.top+text.height/2-icon.top-icon.height/2)<1,'Dock label and icon centers differ')}
 }
 for(const button of document.querySelectorAll('.page-dock-action'))expect(button.getBoundingClientRect().width>=28&&button.getAttribute('aria-label')&&button.title,'compact Dock loses its target or hint');
 const actions=document.querySelector('.page-dock-actions');expect(actions.scrollWidth<=actions.clientWidth+1,'standard page actions overflow the Dock');
}
window.runChromeHigTests=async()=>{
 await settle();await document.fonts.ready
 expect(!document.querySelector('.plugins-btn')&&!document.querySelector('.notification-btn'),'relocated caption entries remained');
 expect(!document.querySelector('.side-menu .sidebar-header'),'sidebar repeats the bookmark label as an extra heading');
 const roots=[...document.querySelectorAll('.menu-nav > .menu-item')];
 expect(roots.findIndex(button=>button.getAttribute('aria-label')==='插件市场')===roots.findIndex(button=>button.getAttribute('aria-label')==='搜索')+1,'plugin market is not immediately below Search');
 const bookmark=document.querySelector('.sidebar-bookmark');
 expect(!bookmark.querySelector('.bookmark-body')&&bookmark.getBoundingClientRect().width===32&&bookmark.getBoundingClientRect().height===32,'sidebar toggle regains the protruding tab or loses its hit area');
 expect(getComputedStyle(bookmark,'::before').opacity==='0'&&getComputedStyle(bookmark,'::after').opacity==='0','idle sidebar toggle retains a visible block');
 expect(!bookmark.textContent.trim()&&bookmark.querySelector('.theme-icon'),'sidebar bookmark retains cramped vertical text');
 const bookmarkBox=bookmark.getBoundingClientRect(),titleBox=document.querySelector('.title-bar').getBoundingClientRect();
 expect(bookmarkBox.top>=titleBox.bottom&&bookmarkBox.top-titleBox.bottom<=16,'sidebar toggle is detached from the content edge or overlaps the title bar');
 expect(bookmark.querySelector('[data-theme-icon-slot="navigation.expand"]')&&!bookmark.querySelector('[data-theme-icon-slot="navigation.menu"]'),'sidebar bookmark duplicates the title bar menu glyph');
 expect(bookmark.querySelector('.theme-icon').getBoundingClientRect().top>=titleBox.bottom,'sidebar bookmark glyph overlaps the title bar');
 bookmark.click();await settle();expect(!open.value&&bookmark.getAttribute('aria-expanded')==='false'&&document.querySelector('.side-menu').inert,'bookmark fails to collapse the sidebar');
 bookmark.click();await settle();expect(open.value&&bookmark.getAttribute('aria-expanded')==='true','bookmark fails to reopen the sidebar');
 document.querySelector('.sidebar-plugins').click();expect(plugins===1,'sidebar market entry did not activate');
 expect(document.querySelector('.appearance-btn .ph-t-shirt'),'appearance does not use the shared shirt icon');
 expect(Number(document.querySelector('.maximize rect').getAttribute('rx'))>0,'maximize icon remained square');
 home.value=false;await nextTick();let primary=document.querySelector('.menu-btn');expect(primary.getAttribute('aria-label')==='回到主页'&&!primary.hasAttribute('aria-expanded')&&primary.querySelector('[data-theme-icon-slot="navigation.home"]'),'secondary pages retain the sidebar affordance');
 primary.click();await nextTick();expect(homes===1&&primary.getAttribute('aria-label')==='侧边栏'&&primary.querySelector('[data-theme-icon-slot="navigation.menu"]'),'home navigation did not restore sidebar behavior');
 const action=document.querySelector('[data-dock-action="play"]');action.focus();action.click();expect(dockRuns===1,'Dock command did not invoke its page action');
 docks.value=docks.value.map(item=>({...item,disabled:true}));await nextTick();action.click();expect(dockRuns===1,'disabled Dock command ran');docks.value=docks.value.map(item=>({...item,disabled:false}));await nextTick();
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
 // Attached navigation repeats the outer foundation's neutral wash over the
 // content; without diffusion it still needs an opaque fallback.
 for(const tone of ['pureWhite','dark']){
  document.documentElement.dataset.theme=tone;await settle()
  const nav=document.querySelector('.side-menu'),css=getComputedStyle(nav)
  const alpha=color=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=color;x.fillRect(0,0,1,1);return x.getImageData(0,0,1,1).data[3]/255}
  expect(Math.abs(alpha(css.backgroundColor)-.1)<.01,'navigation loses the outer foundation wash: '+tone+' '+css.backgroundColor)
  expect(css.backdropFilter.includes('blur(20px)'),'navigation loses diffusion')
  document.body.classList.add('te-no-blur');await settle()
  expect(alpha(getComputedStyle(nav).backgroundColor)===1&&getComputedStyle(nav).backdropFilter==='none','navigation remains transparent without diffusion')
  document.body.classList.remove('te-no-blur')
 }
 liquid.value=true;await settle();const materialNav=document.querySelector('.side-menu');expect(getComputedStyle(materialNav).backdropFilter==='none'&&getComputedStyle(materialNav,'::before').backdropFilter.includes('blur('), 'liquid navigation stacks backdrop passes');expect(getComputedStyle(materialNav,'::before').backgroundImage==='none'&&getComputedStyle(materialNav,'::before').boxShadow==='none','navigation regains a competing highlight');
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
window.prepareLibraryPortal=()=>{[...document.querySelectorAll('.side-menu .menu-nav>button')].at(-1).focus()}
window.checkLibraryActivation=()=>{expect(recent===1,'Enter does not activate the actual library portal');expect(document.activeElement.matches(':focus-visible'),'keyboard portal focus is not visible: '+JSON.stringify({active:document.activeElement.outerHTML.slice(0,180),focused:document.hasFocus(),outline:getComputedStyle(document.activeElement).outline}))}
`
