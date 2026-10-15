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
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('account panel keeps an overview, explicit login links, readable activity and keyboard paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-account-panel-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'mocks.ts'), mocks)
    await writeFile(
      join(directory, 'icon.ts'),
      "import {h} from 'vue'; export default {render:()=>h('span',{class:'theme-icon','aria-hidden':'true'})}"
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: [
          {
            find: /^(?:\.\.\/|@renderer\/)stores\/(?:useProviderStore|useNcmStore|useDownloadTasks|useMusicStore|useAppUpdateStore)$/,
            replacement: join(directory, 'mocks.ts')
          },
          { find: '../app/useWindowChrome', replacement: join(directory, 'mocks.ts') },
          {
            find: /^\.\/(?:ThemeIcon|icons\/TitleBarIcon|PageDock)\.vue$/,
            replacement: join(directory, 'icon.ts')
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
          name: 'AccountPanelTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{margin:0;overflow:hidden}#outside-control{position:absolute;left:650px;top:180px}#playbar-fixture{position:fixed;inset:auto 0 0;height:var(--te-playbar-bottom-clearance);pointer-events:none}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /ACCOUNT_PANEL_OK 144 layout cases/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const mocks = `import {computed,ref} from 'vue'
const avatar='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#888"/></svg>')
export const providers=[
 {id:'ncm',name:'网易云音乐',capabilities:['login'],supportedMethods:[],ui:{description:'连接自己的音乐收藏'}},
 {id:'bili',name:'哔哩哔哩',capabilities:['login'],supportedMethods:[],ui:{description:'保留独立来源能力'}},
 {id:'server',name:'Jellyfin / Emby',capabilities:['login'],supportedMethods:['loginWithServer'],ui:{authType:'settings'}},
 {id:'settings',name:'配置型音乐来源',capabilities:['login'],supportedMethods:[],ui:{authType:'settings'}}
]
export const fixture={providers:ref(providers),logged:ref(['bili']),calls:[],openRequests:[],configure:0,scan:ref({state:'running',current:4,total:12,error:''})}
const profile=id=>({userId:id==='ncm'?42:73,nickname:id==='ncm'?'测试听众':'另一来源的听众',avatarUrl:avatar,follows:3,followeds:4,signature:'保留账号详情与退出入口'})
const forbidden=()=>{throw Error('FORBIDDEN_AUTH_SUBMISSION_OR_TASK_WRITE')}
const providerStore={providers:fixture.providers,syncProviders:async()=>{},hasProvider:id=>fixture.providers.value.some(p=>p.id===id),getProvider:id=>fixture.providers.value.find(p=>p.id===id),checkLogin:async id=>{
 fixture.calls.push({id,method:'checkLogin'});return {loggedIn:fixture.logged.value.includes(id),profile:fixture.logged.value.includes(id)?profile(id):null}
},getQrLogin:async id=>{fixture.calls.push({id,method:'getQrLogin'});return {key:'fixture-'+id,imageDataUrl:avatar}},checkQrLogin:async id=>{fixture.calls.push({id,method:'checkQrLogin'});return {code:801}},callProvider:forbidden,logout:forbidden}
export const useProviderStore=()=>providerStore
export const useNcmStore=()=>({isLoggedIn:computed(()=>fixture.logged.value.includes('ncm')),profile:computed(()=>fixture.logged.value.includes('ncm')?profile('ncm'):null),checkLogin:async()=>{}})
const downloads={tasks:ref([]),error:ref(''),connect:()=>()=>{},refresh:async()=>{}}
export const useDownloadTasks=()=>downloads
export const useMusicStore=()=>({libraryScanStatus:fixture.scan,libraryMetadataEnrichmentStatus:ref({state:'idle'}),cancelLibraryScan:forbidden,pauseLibraryScan:forbidden,resumeLibraryScan:forbidden,startFullLibraryScan:forbidden,cancelLibraryMetadataEnrichment:forbidden})
const update={state:ref({checking:false,progress:{phase:'idle'}}),error:ref(''),connectionError:ref(''),connect:()=>()=>{},cancel:forbidden,download:forbidden,install:forbidden}
export const useAppUpdateStore=()=>update
export const useWindowChrome=()=>({maximized:ref(false)})
`

const runtime = `import '@renderer/assets/base.css'
import '@renderer/assets/typography.css'
import '@renderer/assets/materials.css'
import '@renderer/assets/appearance.css'
import {createApp,h,nextTick,ref,shallowRef,watch} from 'vue'
import AccountPage from '@renderer/components/AccountPage.vue'
import AppNoticeHost from '@renderer/components/AppNoticeHost.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import {useAppNoticeStore} from '@renderer/stores/useAppNoticeStore'
import {goBack,useBackHandler} from '@renderer/app/useBackStack'
import {fixture,providers} from './mocks.ts'
const expect=(condition,message)=>{if(!condition)throw Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,10));await nextTick()}
const until=async(check,message)=>{for(let i=0;i<150;i++){if(check())return;await tick()}throw Error(message)}
const notices=useAppNoticeStore()
window.api={window:{minimize(){},toggleMaximize(){},close(){}},loudnessAnalysis:{onBatchProgress:()=>()=>{},getBatch:async()=>({status:{state:'idle',revision:1}})}}
const open=ref(false),initial=ref(null),anchor=shallowRef(null),target=ref(null)
watch([open,target],([visible,mount])=>{notices.centerOpen.value=visible&&!!mount})
const close=(returnFocus=true)=>{open.value=false;if(returnFocus)nextTick(()=>anchor.value?.focus())}
const show=(id=null)=>{initial.value=id;anchor.value=document.querySelector('.login-btn');open.value=true}
createApp({setup:()=>{useBackHandler(open,()=>close(),'收起我的');return()=>h('div',[
 h(TitleBar,{menuOpen:false,accountOpen:open.value,onBack:goBack,onLogin:(id,el)=>{fixture.openRequests.push(id);anchor.value=el;if(open.value)close();else show(id)}}),
 h('button',{id:'outside-control'},'Outside'),h('div',{id:'playbar-fixture'}),
 open.value?h(AccountPage,{anchor:anchor.value,initialProviderId:initial.value,onClose:close,onNoticeTarget:el=>target.value=el,onConfigure:()=>fixture.configure++}):null,
 h(AppNoticeHost,{historyEmbedded:true,historyTarget:target.value})
])}}).mount('#app')
const button=(text,root=document)=>[...root.querySelectorAll('button')].find(el=>el.textContent.trim()===text)
const seed=()=>{notices.noticeHistory.value=Array.from({length:5},(_,id)=>({id:id+1,kind:id===4?'error':id===3?'warning':'success',message:id===4?'测试任务失败：保留原因和恢复入口':'测试任务已完成 '+id,createdAt:1760000000000+id*1000,read:false,presentation:'center'}))}
window.prepareAccount=async(options={})=>{
 close(false);await tick()
 fixture.providers.value=options.empty?[]:providers
 fixture.logged.value=options.logged?['ncm','bili']:['bili']
 fixture.calls.length=0;fixture.openRequests.length=0
 seed()
 const root=document.documentElement
 root.dataset.theme=options.tone||'pureWhite'
 root.dataset.teMotion='off'
 root.style.setProperty('--te-motion-panel','0ms')
 root.style.setProperty('--te-font-size-body',(options.font||14)+'px')
 root.style.setProperty('--te-playbar-bottom-clearance',(options.clearance||100)+'px')
 await tick()
 document.querySelector('.login-btn').focus()
}
window.waitOverview=async()=>{
 await until(()=>document.querySelectorAll('.provider-row').length===4&&document.querySelector('.notice-record'),'overview or activity did not arrive')
 expect(fixture.openRequests.at(-1)===null,'avatar passed a default provider as an explicit login link')
 expect(!document.querySelector('.qr-frame')&&!fixture.calls.some(call=>call.method==='getQrLogin'),'default avatar unexpectedly started QR login')
 const panel=document.querySelector('#account-subpage'),title=document.querySelector('#account-page-title')
 expect(panel.getAttribute('role')==='dialog'&&panel.getAttribute('aria-modal')==='false','account panel is not a named nonmodal dialog')
 expect(panel.getAttribute('aria-labelledby')===title.id&&title.getBoundingClientRect().height>10&&getComputedStyle(title).clipPath==='none','My title is hidden or its name reference is broken')
 expect(document.querySelector('.login-btn').getAttribute('aria-haspopup')==='dialog','avatar does not identify its popup')
 expect([...document.querySelectorAll('.notice-record .notice-label')].some(el=>el.textContent==='需要处理'),'activity lost its explicit error label')
 expect(document.querySelector('.task-meta').textContent.includes('进行中'),'active task state was lost')
}
window.prepareProviderKeyboard=()=>{document.querySelector('.provider-row').focus()}
window.checkOrdinaryDismissal=async()=>{
 const outside=document.getElementById('outside-control')
 outside.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));outside.focus()
 await until(()=>!document.querySelector('#account-subpage'),'overview did not dismiss on an outside click')
 expect(document.activeElement===outside,'outside dismissal stole focus from the new control')
 const avatar=document.querySelector('.login-btn')
 avatar.click();await window.waitOverview();avatar.focus();avatar.click()
 await until(()=>!document.querySelector('#account-subpage'),'avatar did not toggle the overview closed')
 expect(document.activeElement===avatar,'avatar toggle lost trigger focus')
 avatar.click();await window.waitOverview();document.querySelector('.account-collapse').click()
 await window.checkClosed()
 avatar.click();await window.waitOverview()
}
window.waitLogin=async()=>{
 await until(()=>document.querySelectorAll('[role=tab]').length===3,'NCM login methods did not arrive')
 await until(()=>document.activeElement?.matches('.stage-title'),'login navigation lost focus instead of naming the new stage')
 const tabs=[...document.querySelectorAll('[role=tab]')]
 expect(tabs.filter(tab=>tab.tabIndex===0).length===1,'login methods have more than one tab stop')
 for(const tab of tabs)expect(document.getElementById(tab.getAttribute('aria-controls'))?.getAttribute('role')==='tabpanel','login tab has no linked panel')
 tabs[0].focus()
}
window.checkSms=async()=>{
 await tick()
 const selected=document.querySelector('[role=tab][aria-selected=true]'),panel=document.querySelector('[role=tabpanel]')
 expect(selected.textContent.trim()==='短信登录'&&document.activeElement===selected,'ArrowRight did not activate and focus the next login method')
 expect(panel.getAttribute('aria-labelledby')===selected.id,'selected method and panel are disconnected')
 const phone=document.getElementById('lp-phone')
 phone.value='fixture-draft';phone.dispatchEvent(new Event('input',{bubbles:true}));await tick()
 const outside=document.getElementById('outside-control')
 outside.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));outside.focus();await tick()
 expect(document.querySelector('#account-subpage')&&document.getElementById('lp-phone').value==='fixture-draft','outside dismissal discarded an unsubmitted in-memory form')
 selected.focus()
}
window.checkPassword=async()=>{
 await tick()
 const selected=document.querySelector('[role=tab][aria-selected=true]')
 expect(selected.textContent.trim()==='密码登录'&&document.activeElement===selected,'End did not activate the final method')
 const group=document.querySelector('[aria-label="账号类型"]')
 expect(group.getAttribute('role')==='group'&&group.querySelectorAll('[aria-pressed=true]').length===1,'account type buttons have incomplete selection semantics')
 button('邮箱',group).focus()
}
window.checkEmail=async()=>{
 await tick()
 expect(document.querySelector('[aria-label="账号类型"] [aria-pressed=true]').textContent.trim()==='邮箱','keyboard activation did not select email login')
 expect(document.getElementById('lp-email')&&document.querySelector('label[for=lp-email]'),'email field lost its visible label')
 document.getElementById('lp-email').focus()
}
window.checkClosed=async()=>{
 await until(()=>!document.querySelector('#account-subpage'),'Escape did not close the account panel')
 expect(document.activeElement===document.querySelector('.login-btn'),'closing did not return focus to the avatar')
}
window.focusTitleBack=()=>document.querySelector('.title-bar .back-btn').focus()
window.checkInnerBack=async()=>{
 await until(()=>document.querySelectorAll('.provider-row').length===4,'title-bar back skipped the inner provider view')
 expect(document.querySelector('#account-subpage'),'title-bar back closed the account panel before its inner layer')
 expect(document.activeElement===document.querySelector('.title-bar .back-btn'),'returning to the overview displaced the stable title-bar return control')
}
window.checkDeepLinks=async()=>{
 await window.prepareAccount();show('ncm')
 await until(()=>document.querySelector('.qr-frame img'),'explicit provider login link did not reach its QR view')
 expect(fixture.calls.filter(call=>call.method==='getQrLogin').length===1,'explicit QR link did not use the selected provider exactly once')
 close(false);await tick();show('server')
 await until(()=>document.querySelector('.server-login-form'),'server capability did not preserve its independent form')
 expect(document.querySelectorAll('.server-login-form input').length===3,'server URL, username or password form was removed')
 expect(!document.querySelector('.method-tabs'),'NCM-only login methods leaked into the server provider')
 close(false);await tick();show('settings');await until(()=>fixture.configure>0,'configuration-only provider lost its configuration entry')
 close(false);await tick()
}
window.checkProfile=async()=>{
 await window.prepareAccount({logged:true})
 document.querySelector('.login-btn').click();await window.waitOverview()
 expect(document.querySelector('.login-btn .user-avatar')&&document.querySelector('.login-btn').getAttribute('aria-label').includes('测试听众'),'logged-in avatar or nickname was removed')
 document.querySelector('.provider-row').focus();document.querySelector('.provider-row').click()
 await until(()=>document.querySelector('.id-name'),'logged-in identity did not arrive')
 expect(document.querySelector('.id-name').textContent.includes('测试听众')&&document.querySelector('.id-avatar'),'profile nickname or avatar was removed')
 document.querySelector('.profile-details summary').focus()
}
window.checkProfileDetails=async()=>{
 await tick()
 expect(document.querySelector('.profile-details').open&&button('退出登录',document.querySelector('.profile-details')),'keyboard disclosure lost the logout entry')
 expect(document.querySelector('.profile-details').textContent.includes('UID'),'account details lost the UID')
}
window.checkEmpty=async()=>{
 await window.prepareAccount({empty:true});document.querySelector('.login-btn').click()
 await until(()=>button('管理音乐来源'),'empty provider state has no recovery entry')
 expect(!fixture.calls.some(call=>call.method==='getQrLogin'),'empty provider state started authentication')
}
window.checkLayout=async scenario=>{
 await window.prepareAccount(scenario)
 if(scenario.view==='overview')document.querySelector('.login-btn').click()
 else show(scenario.view==='server'?'server':'ncm')
 await until(()=>scenario.view==='overview'?document.querySelector('.provider-row'):scenario.logged?document.querySelector('.id-name'):scenario.view==='server'?document.querySelector('.server-login-form'):document.querySelector('.qr-frame img'),'layout state did not arrive')
 if(['sms','password','email'].includes(scenario.view)){
  const method=scenario.view==='sms'?'短信登录':'密码登录'
  button(method).click();await until(()=>document.getElementById(scenario.view==='sms'?'lp-captcha':'lp-password'),'account form did not arrive')
  if(scenario.view==='email'){button('邮箱').click();await until(()=>document.getElementById('lp-email'),'email account form did not arrive')}
 }
 if(scenario.view==='profile-details'){document.querySelector('.profile-details').open=true;await tick()}
 await until(()=>document.querySelector('.notice-record'),'embedded activity did not arrive')
 const panel=document.querySelector('#account-subpage'),scroll=panel.querySelector('.account-page-sections'),header=panel.querySelector('.account-page-header')
 const rect=panel.getBoundingClientRect(),headerTop=header.getBoundingClientRect().top
 const inset=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--te-titlebar-inset'))
 expect(rect.left>=11&&rect.right<=innerWidth-11,'account panel escaped horizontal window bounds: '+JSON.stringify(scenario))
 expect(rect.top>=inset&&rect.bottom<=innerHeight-scenario.clearance-23,'account panel overlaps title bar or actual player clearance: '+JSON.stringify({...scenario,rect:{top:rect.top,bottom:rect.bottom},inset}))
 expect(scroll.clientHeight>30&&scroll.scrollWidth<=scroll.clientWidth+1,'account scrollport is inaccessible or overflows horizontally')
 for(const selector of ['.provider-copy','.provider-name','.id-identity','.profile-details','.method-tabs','.method-tab','.login-method-content','.account-form','.field-row','.server-login-form','.notice-content','.task-record','.notice-filters'])for(const el of panel.querySelectorAll(selector))expect(el.scrollWidth<=el.clientWidth+1,'content clipped horizontally: '+selector+' '+JSON.stringify(scenario))
 const name=panel.querySelector('.provider-name,.id-name,.stage-title')
 expect(parseFloat(getComputedStyle(name).fontSize)>=scenario.font,'account identity did not respect the text size')
 expect(parseFloat(getComputedStyle(panel.querySelector('.notice-message')).fontSize)>=scenario.font*13/14-0.1,'activity text shrank below the caption role')
 scroll.scrollTop=scroll.scrollHeight;await tick()
 const footer=panel.querySelector('.notice-history-footer').getBoundingClientRect(),viewport=scroll.getBoundingClientRect()
 expect(footer.bottom<=viewport.bottom+1&&footer.top>=viewport.top-1,'last activity controls cannot be reached by scrolling')
 expect(Math.abs(header.getBoundingClientRect().top-headerTop)<1,'scrolling activity displaced the panel close control')
 return {...scenario,panel:{left:rect.left,top:rect.top,width:rect.width,height:rect.height,bottom:rect.bottom},scrollHeight:scroll.scrollHeight,clientHeight:scroll.clientHeight}
}
window.assertNoSubmissions=()=>{
 expect(fixture.calls.every(call=>['checkLogin','getQrLogin','checkQrLogin'].includes(call.method)),'test invoked a login submission')
 expect(!localStorage.length,'account draft was persisted')
}
`

const runner = `const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path')
app.setPath('userData',path.join(__dirname,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:800,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}})
 const external=[]
 win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{external.push(details.url);callback({cancel:true})})
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)})
 const run=code=>win.webContents.executeJavaScript(code)
 const key=async code=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:code});if(code==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13)});win.webContents.sendInputEvent({type:'keyUp',keyCode:code});await new Promise(resolve=>setTimeout(resolve,35))}
 const results=[]
 try{
  await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});win.webContents.focus()
  await run('window.prepareAccount()');await key('Enter');await run('window.waitOverview()');await run('window.checkOrdinaryDismissal()')
  await run('window.prepareProviderKeyboard()');await key('Enter');await run('window.waitLogin()')
  await key('Right');await run('window.checkSms()')
  await key('End');await run('window.checkPassword()')
  await key('Enter');await run('window.checkEmail()')
  await key('Escape');await run('window.checkClosed()')
  await run('window.prepareAccount()');await key('Enter');await run('window.waitOverview()')
  await run('window.prepareProviderKeyboard()');await key('Enter');await run('window.waitLogin()')
  await run('window.focusTitleBack()');await key('Enter');await run('window.checkInnerBack()')
  await key('Enter');await run('window.checkClosed()')
  await run('window.checkDeepLinks()');await run('window.checkProfile()')
  await key('Enter');await run('window.checkProfileDetails()')
  await run('window.checkEmpty()')
  for(const [width,height] of [[1280,800],[760,520],[480,420]]){
   win.setContentSize(width,height)
   for(const font of [14,20,28])for(const tone of ['pureWhite','dark'])for(const view of ['overview','qr','sms','password','email','server','profile','profile-details']){
    const scenario={width,height,font,tone,view,logged:view.startsWith('profile'),clearance:width===480?72:112}
    results.push(await run('window.checkLayout('+JSON.stringify(scenario)+')'))
   }
  }
  await run('window.assertNoSubmissions()')
  if(external.length)throw Error('Unexpected external network requests: '+external.join(', '))
  if(process.env.TE_ACCOUNT_PANEL_EVIDENCE)fs.writeFileSync(process.env.TE_ACCOUNT_PANEL_EVIDENCE,JSON.stringify({cases:results,externalRequests:external.length},null,2))
  console.log('ACCOUNT_PANEL_OK '+results.length+' layout cases');app.exit(0)
 }catch(error){console.error(error.stack||error);if(process.env.TE_ACCOUNT_PANEL_EVIDENCE)fs.writeFileSync(process.env.TE_ACCOUNT_PANEL_EVIDENCE,JSON.stringify({cases:results,error:String(error)},null,2));app.exit(1)}
})
`
