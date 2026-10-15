import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('title search aligns with navigation and preserves native input, composition and caption access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-title-search-'))
  try {
    const sideMenu = parse(
      await readFile(join(workspace, 'src/renderer/src/components/SideMenu.vue'), 'utf8')
    )
    const navigation = compileStyle({
      source: sideMenu.descriptor.styles.map((style) => style.content).join('\n'),
      filename: 'SideMenu.vue',
      id: 'data-v-navigation-search-fixture',
      scoped: true
    })
    assert.deepEqual(navigation.errors, [])
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [
        {
          name: 'controlled-title-search-stores',
          enforce: 'pre',
          load(id) {
            const path = id.replaceAll('\\', '/')
            if (path.endsWith('/stores/useNcmStore.ts'))
              return "import {ref} from 'vue';export const useNcmStore=()=>({isLoggedIn:ref(false),profile:ref(null)})"
            if (path.endsWith('/stores/useProviderStore.ts'))
              return "import {ref} from 'vue';export const useProviderStore=()=>({providers:ref([])})"
            if (path.endsWith('/stores/useAppNoticeStore.ts'))
              return "import {ref} from 'vue';export const useAppNoticeStore=()=>({unreadCount:ref(0),activeTaskCount:ref(0),doNotDisturb:ref(false)})"
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
          name: 'TitleSearchFixture',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-platform="win32" data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<style>${navigation.code}
      html,body{margin:0;width:100%;height:100%;overflow:hidden}body::before{display:none}#expanded-guide{position:fixed;left:0;top:40px;width:var(--te-menu-width);height:1px;pointer-events:none}main{padding:60px 24px;color:var(--te-text)}
    </style></head><body><div id="app"></div><aside id="expanded-guide" aria-hidden="true"></aside><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /TITLEBAR_SEARCH_OK 36 geometry records/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import '@renderer/assets/base.css'
import '@renderer/assets/typography.css'
import '@renderer/assets/materials.css'
import {createApp,h,nextTick,ref} from 'vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import {pushBackHandler} from '@renderer/app/useBackStack'
import {mountAppearanceLayers} from '@renderer/app/appearanceLayersRuntime'
import {defaultAppearanceLayers} from '@shared/appearanceLayers'
const expect=(value,message)=>{if(!value)throw Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await nextTick()}
const events=[],chrome=[],composition=[]
window.api={window:{minimize:()=>chrome.push('minimize'),toggleMaximize:()=>chrome.push('maximize'),close:()=>chrome.push('close'),getState:async()=>({maximized:false}),onStateChanged:()=>()=>{}}}
window.fetch=()=>{throw Error('Unexpected network access')}
pushBackHandler(()=>{},'返回测试页面')
const dock=Array.from({length:3},(_,id)=>({id:'action'+id,label:'页面操作 '+id,icon:'navigation.home',run:()=>events.push({type:'dock',value:id})}))
const values=ref({menuOpen:false,searchQuery:'',pageDockActions:dock}),generation=ref(0),controlled=ref(true)
const log=type=>value=>events.push({type,value})
const handlers={onSearch:log('search'),'onUpdate:searchQuery':value=>{events.push({type:'query',value});if(controlled.value)values.value={...values.value,searchQuery:value}},onToggleMenu:log('menu'),onHome:log('home'),onBack:log('back'),onLogin:log('login'),onDsp:log('dsp'),onSettings:log('settings'),onAppearance:log('appearance')}
createApp({setup:()=>()=>h('div',[h(TitleBar,{...values.value,...handlers,key:generation.value}),h('main','受控标题栏搜索夹具')])}).mount('#app')
const render=async(extra={})=>{values.value={menuOpen:false,searchQuery:'',pageDockActions:dock,...extra};generation.value++;events.length=0;chrome.length=0;composition.length=0;await tick()}
const update=async(extra)=>{values.value={...values.value,...extra};await tick()}
const input=()=>document.querySelector('.title-bar-search input')
const submitted=()=>events.filter(event=>event.type==='search')
const queries=()=>events.filter(event=>event.type==='query')
const setText=async(value)=>{input().value=value;input().dispatchEvent(new Event('input',{bubbles:true}));await tick()}
window.prepareNativeSearch=async()=>{
 controlled.value=true;await render();expect(input().type==='search'&&input().getAttribute('aria-label')==='搜索音乐','search is not a named native search input')
 const r=input().getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}
}
window.checkInputClick=async()=>{
 await tick();expect(document.activeElement===input(),'native pointer did not focus the search input')
 for(const element of [input(),document.querySelector('.title-bar-search'),document.querySelector('.title-search-submit')]){
  expect(getComputedStyle(element).webkitAppRegion==='no-drag','search inherits a caption drag region')
  expect(!element.style.getPropertyValue('--te-lg-press-x')&&!element.style.getPropertyValue('--te-lg-press-y'),'search pointer changed caption-button press geometry')
 }
 expect(document.querySelector('.title-bar').classList.contains('drag-region'),'caption background lost its drag region')
 const focus=getComputedStyle(document.querySelector('.title-bar-search'));expect(focus.outlineStyle==='solid'&&focus.outlineWidth==='2px','quiet search lost its visible keyboard/input focus')
}
window.checkSubmitted=async(expected,value)=>{await tick();expect(submitted().length===expected&&(!expected||submitted().at(-1).value===value),'native search was lost or duplicated '+JSON.stringify(events))}
window.prepareWhitespace=async()=>{await setText('   ');input().focus()}
window.checkClear=async()=>{
 await setText('需要清除的搜索词');const before=queries().length;document.querySelector('.title-search-clear').click();await tick()
 expect(input().value===''&&document.activeElement===input(),'clear did not return an empty focused input')
 expect(queries().length===before+1&&queries().at(-1).value==='','clear did not synchronize the model exactly once')
 expect(submitted().length===2,'clear unexpectedly submitted navigation')
 const beforeExternal=queries().length;await update({searchQuery:'页面内更新的查询'});expect(input().value==='页面内更新的查询'&&queries().length===beforeExternal,'external query synchronization echoed or lost the query')
 controlled.value=false;await render({searchQuery:undefined});await setText('本地独立输入');expect(input().value==='本地独立输入','uncontrolled input lost its draft');input().focus()
}
window.prepareComposition=async()=>{
 controlled.value=true;await render();input().focus();for(const type of ['compositionstart','compositionupdate','compositionend'])input().addEventListener(type,event=>composition.push({type,data:event.data}))
}
window.checkCompositionPending=async()=>{await tick();expect(composition.some(event=>event.type==='compositionstart'),'Chromium did not start the real composition');expect(!submitted().length,'IME confirmation submitted a search')}
window.checkCompositionCommitted=async()=>{await tick();expect(composition.some(event=>event.type==='compositionend')&&input().value==='王菲','Chromium composition did not commit the intended query '+JSON.stringify({composition,value:input().value}));expect(!submitted().length,'composition commit navigated without a new Enter')}
window.checkCompositionGuards=async()=>{
 const before=submitted().length;for(const extra of [{isComposing:true},{keyCode:229}]){const event=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...extra});input().dispatchEvent(event);expect(event.defaultPrevented,'IME Enter was not guarded')}
 expect(submitted().length===before,'guarded composition event submitted')
}
window.checkPreview=async()=>{
 await render({preview:true});await setText('预览输入');document.querySelector('.title-bar-search').requestSubmit();await tick();expect(!submitted().length&&!queries().length,'preview emitted real query/navigation work')
 document.querySelector('.title-search-clear').click();await tick();expect(!queries().length&&input().value==='','preview clear published business state')
 await render({closeOnly:true});expect(!document.querySelector('.title-bar-search')&&document.querySelectorAll('.title-bar button').length===1,'close-only caption gained search or extra commands')
 const close=document.querySelector('.control-btn.close').getBoundingClientRect();expect(Math.abs(close.right-innerWidth)<.5,'close-only window control moved away from the edge')
}
window.prepareCaptionKeyboard=async()=>{
 document.documentElement.dataset.teNavigationStyle='expanded';document.documentElement.style.setProperty('--te-font-size-body','28px');await render();await setText('键盘测试');input().focus()
}
window.checkCaptionFocus=async(selector,index=0)=>{
 await tick();const target=document.querySelectorAll(selector)[index];expect(target&&document.activeElement===target,'native tab order lost '+selector+' '+index+' '+document.activeElement?.outerHTML)
 const r=target.getBoundingClientRect();expect(r.bottom<=40.6&&r.top>=-.5,'caption keyboard target exceeds40px chrome')
 const tools=target.closest('.title-bar-tools');if(tools){const t=tools.getBoundingClientRect();const visible=Math.min(r.right,t.right)-Math.max(r.left,t.left);expect(visible>=Math.min(32,r.width)-.5,'narrow toolbar did not scroll the focused command into view '+JSON.stringify({selector,r:r.toJSON(),tools:t.toJSON()}))}
 const glyph=target.querySelector('.title-bar-icon,.window-control-icon,.theme-icon,.title-bar-label');if(glyph)expect(getComputedStyle(glyph).opacity==='1','quiet caption weakens keyboard focus ink')
}
window.checkCaptionEvents=()=>{expect(['dsp','appearance','settings'].every(type=>events.some(event=>event.type===type))&&events.filter(event=>event.type==='dock').length===3,'existing title tools stopped running their original actions');expect(chrome.join(',')==='minimize,maximize,close','window buttons no longer call their existing controlled interface')}
window.checkQuietSearch=async()=>{
 const appearance=mountAppearanceLayers(document),canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');canvas.width=canvas.height=1
 const alpha=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return ctx.getImageData(0,0,1,1).data[3]/255}
 let cases=0
 try{for(const tone of ['light','dark'])for(const liquid of [false,true])for(const mode of ['theme','solid','frosted','liquidGlass']){
  document.documentElement.dataset.theme=tone==='light'?'pureWhite':'dark';document.documentElement.style.setProperty('--te-lg-context-label',tone==='light'?'#16181b':'#f8fafc');await render({searchQuery:'测试文字',liquidMaterial:liquid})
  const settings=defaultAppearanceLayers(),control=settings.scopes.controls[tone];control.body.enabled=true;control.effect.enabled=true;control.material.mode=mode;appearance.update(settings,tone);await tick()
  const form=document.querySelector('.title-bar-search'),elements=[form,...form.querySelectorAll('input,button,svg')],color=getComputedStyle(form).color
  expect(alpha(color)>.6&&alpha(color)<.86,'search ink is not subdued '+tone+'/'+liquid+'/'+mode+': '+color)
  expect(getComputedStyle(input(),'::placeholder').color===color,'placeholder escapes quiet search ink')
  for(const element of elements){const style=getComputedStyle(element);expect(!element.hasAttribute('data-te-appearance-body'),'generic control body attaches to title search');expect(style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.backgroundImage==='none'&&style.backdropFilter==='none','generic material repaints transparent title search '+element.tagName+'/'+mode);expect(style.color===color,'search glyph or text escapes quiet ink '+element.tagName)}
  for(const button of document.querySelectorAll('.title-bar-controls button')){const style=getComputedStyle(button);expect(!button.hasAttribute('data-te-appearance-body')&&style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.backdropFilter==='none','generic widget material stacks on a caption tool: '+button.className+'/'+mode);const glyph=button.querySelector('.title-bar-icon,.window-control-icon,.theme-icon,.title-bar-label');if(glyph)expect(getComputedStyle(glyph).opacity===(glyph.classList.contains('title-bar-label')?'0.58':'0.46'),'idle caption tool is too prominent: '+button.className);if(button.classList.contains('settings-btn')&&liquid)expect(getComputedStyle(button,'::after').display==='none','liquid press paints a second tool overlay')}
  cases++
 }}finally{appearance.dispose()}
 return cases
}
window.checkAccessibleSearch=async()=>{
 await render({searchQuery:'对比度检查'});input().focus();await tick();const form=document.querySelector('.title-bar-search'),style=getComputedStyle(form),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=style.color;ctx.fillRect(0,0,1,1)
 expect(ctx.getImageData(0,0,1,1).data[3]===255,'accessibility mode retains translucent search ink')
 expect(style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.outlineStyle==='solid'&&style.outlineWidth==='2px','accessible search loses transparent chrome or input focus')
 for(const glyph of document.querySelectorAll('.title-bar-controls :is(.title-bar-icon,.window-control-icon,.theme-icon,.title-bar-label)'))expect(getComputedStyle(glyph).opacity==='1','accessible caption retains subdued ink')
}
window.layoutTitleSearch=async(options)=>{
 const root=document.documentElement;root.dataset.teNavigationStyle=options.navigation;root.dataset.theme=options.tone;root.style.setProperty('--te-font-size-body',options.font+'px')
 await render({menuOpen:true});const title=document.querySelector('.title-bar'),form=document.querySelector('.title-bar-search'),guide=document.getElementById('expanded-guide'),leading=document.querySelector('.title-bar-leading'),tools=document.querySelector('.title-bar-tools')
 const r=form.getBoundingClientRect(),g=guide.getBoundingClientRect(),l=leading.getBoundingClientRect(),windows=[...document.querySelectorAll('.title-bar-window-controls button')].map(element=>element.getBoundingClientRect())
 expect(title.getBoundingClientRect().height===40,'search changed the caption height')
 expect(r.width>=127.5&&r.height===34&&input().getBoundingClientRect().width>0,'search entry has no usable input budget')
 expect(Math.abs(r.left-l.right)<.6,'search is not aligned with its leading reserve')
 expect(r.left>=137.5&&r.left<=Math.max(g.width,138)+.6,'search overlaps commands or wastes extra navigation space')
 if(options.width===1500&&options.font===14&&options.navigation!=='rail')expect(Math.abs(r.left-g.width)<.6,'desktop search does not start at the expanded sidebar boundary')
 if(options.navigation==='rail')expect(Math.abs(r.left-138)<.6,'rail search overlaps the three existing caption commands')
 expect(windows.length===3&&windows.every(window=>window.width===46&&window.height===40&&window.left>=0&&window.right<=innerWidth+.5),'window buttons are clipped or reduced')
 expect(r.right<=tools.getBoundingClientRect().left+.5&&tools.getBoundingClientRect().width>=39.5,'search overlaps or entirely removes existing tools')
 expect(document.documentElement.scrollWidth<=innerWidth+.5,'caption causes horizontal page overflow')
 expect(parseFloat(getComputedStyle(input()).fontSize)>=options.font*13/14-.1,'search text was shrunk to fit')
 await update({menuOpen:false});const closed=form.getBoundingClientRect();expect(Math.abs(closed.left-r.left)<.6&&Math.abs(closed.width-r.width)<.6,'toggling the overlay moves search')
 return {...options,navigationWidth:g.width,searchLeft:r.left,closedSearchLeft:closed.left,searchWidth:r.width,inputWidth:input().getBoundingClientRect().width,toolWidth:tools.getBoundingClientRect().width,reserveCompressed:r.left<g.width-.6,railMinimum:options.navigation==='rail',height:40}
}
`

const runner = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs'),path=require('node:path');
const file=process.argv.at(-1);app.setPath('userData',path.join(path.dirname(file),'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1500,height:500,useContentSize:true,frame:false,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}})
 const external=[];win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,reply)=>{external.push(request.url);reply({cancel:true})})
 const run=code=>win.webContents.executeJavaScript(code)
 const key=async keyCode=>{win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:String.fromCharCode(13)});win.webContents.sendInputEvent({type:'keyUp',keyCode});await new Promise(resolve=>setTimeout(resolve,15))}
 try{
  await win.loadFile(file);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});win.webContents.focus()
  const point=await run('window.prepareNativeSearch()');win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await run('window.checkInputClick()')
  await win.webContents.insertText('  周杰伦  ');await key('Enter');await run("window.checkSubmitted(1,'周杰伦')");await key('Enter');await run("window.checkSubmitted(2,'周杰伦')");await run('window.prepareWhitespace()');await key('Enter');await run("window.checkSubmitted(2,'周杰伦')");await run('window.checkClear()');await key('Enter');await run("window.checkSubmitted(1,'本地独立输入')")
  await run('window.prepareComposition()');await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'王菲',selectionStart:2,selectionEnd:2});await key('Enter');await run('window.checkCompositionPending()');await win.webContents.debugger.sendCommand('Input.insertText',{text:'王菲'});await run('window.checkCompositionCommitted()');await key('Enter');await run("window.checkSubmitted(1,'王菲')");await run('window.checkCompositionGuards()')
  await run('window.checkPreview()')
  win.setContentSize(480,420);await run('window.prepareCaptionKeyboard()');for(const [selector,index] of [['.title-search-clear',0],['.page-dock-action',0],['.page-dock-action',1],['.page-dock-action',2],['.dsp-btn',0],['.appearance-btn',0],['.settings-btn:not(.appearance-btn):not(.dsp-btn)',0],['.control-btn.minimize',0],['.control-btn.maximize',0],['.control-btn.close',0]]){await key('Tab');await run('window.checkCaptionFocus('+JSON.stringify(selector)+','+index+')');if(selector!=='.title-search-clear')await key('Enter')}await run('window.checkCaptionEvents()')
  win.webContents.sendInputEvent({type:'mouseMove',x:10,y:300});const materialCases=await run('window.checkQuietSearch()');if(materialCases!==16)throw Error('missing search material cases')
  for(const [name,value] of [['prefers-contrast','more'],['forced-colors','active']]){await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name,value}]});await run('window.checkAccessibleSearch()');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]})}
  const records=[];for(const width of [1500,900,480]){win.setContentSize(width,420);await new Promise(resolve=>setTimeout(resolve,15));for(const font of [14,28])for(const navigation of ['expanded','compact','rail'])for(const tone of ['pureWhite','dark'])records.push(await run('window.layoutTitleSearch('+JSON.stringify({width,font,navigation,tone})+')'))}
  if(external.length)throw Error('External requests attempted: '+external.join(','))
  if(process.env.TE_TITLE_SEARCH_EVIDENCE)fs.writeFileSync(process.env.TE_TITLE_SEARCH_EVIDENCE,JSON.stringify({records,materialCases,externalRequests:external.length},null,2))
  console.log('TITLEBAR_SEARCH_OK '+records.length+' geometry records; native input, IME, clear, model, inert preview and scrollable caption tools');app.exit(0)
 }catch(error){console.error(error.stack);app.exit(1)}
})`
