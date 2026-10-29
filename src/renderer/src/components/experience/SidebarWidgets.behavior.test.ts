import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('sidebar widgets render custom HTML, bridge securely, adapt to rail, and release disabled sessions', async () => {
  const temporaryRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(temporaryRoot, 'twilight-sidebar-widgets-'))
  const screenshots = process.env.TWILIGHT_WIDGET_SCREENSHOTS
    ? resolve(process.env.TWILIGHT_WIDGET_SCREENSHOTS)
    : undefined
  try {
    if (screenshots) await mkdir(screenshots, { recursive: true })
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'fixture.ts'), fixture)
    await writeFile(join(directory, 'unused.ts'), 'export default {render:()=>null}')
    const source = resolve('sdk/examples/sidebar-widget')
    const manifest = JSON.parse(await readFile(join(source, 'plugin.json'), 'utf8'))
    const sample = {
      ...manifest.contributes.experiences[0],
      pluginId: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      url: `plugin-ui://${manifest.id}/${manifest.version}/ui/index.html`
    }
    await writeFile(join(directory, 'sample.json'), JSON.stringify(sample))
    await build({
      configFile: false,
      root: directory,
      publicDir: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'sidebar-fixture-boundaries',
          enforce: 'pre',
          resolveId(id) {
            if (
              /\/(?:stores\/(?:useMusicStore|usePlayerStore|useProviderStore|useSettingsStore)|stores\/coreConnection)(?:\.ts)?$/.test(
                id
              )
            )
              return join(directory, 'fixture.ts').replaceAll('\\', '/')
            if (id.endsWith('/experienceServices')) return '\0unused-widget-services'
            if (
              id.endsWith('/ImportDialog.vue') ||
              id.endsWith('/navigation/NavigationPagesDialog.vue')
            )
              return join(directory, 'unused.ts').replaceAll('\\', '/')
            return null
          },
          load(id) {
            if (id === '\0unused-widget-services')
              return 'export const createExperienceServices=()=>async()=>{throw Error("Unexpected service call")} '
            return null
          },
          generateBundle() {
            const fixtures = [...this.getModuleIds()].filter((id) =>
              /twilight-sidebar-widgets-[^/\\]+[/\\]fixture\.ts$/.test(id)
            )
            assert.equal(fixtures.length, 1, `Duplicate fixture modules: ${fixtures.join(', ')}`)
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '/icon.png': resolve('resources/icon.png'),
          '@renderer': resolve('src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'SidebarWidgetTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="off" data-te-navigation-style="expanded"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<style>
    *{box-sizing:border-box}body{margin:0;background:var(--te-app-bg);font:14px system-ui;color:var(--te-navigation-text)}
    html{--te-font-sans:system-ui,sans-serif;--te-font-size-body:14px;--te-side-menu-tools-clearance:16px;--te-titlebar-inset:40px}
    .fixture-titlebar{position:fixed;inset:0 0 auto;height:40px;display:flex;align-items:center;gap:28px;padding:0 20px;border-bottom:1px solid var(--te-navigation-border);font-size:13px}
    .fixture-stage{margin:140px 50px 0 280px;max-width:480px}.fixture-stage p{color:var(--te-navigation-icon);line-height:1.8}.fixture-stage h1{font-size:28px;font-weight:600}
    </style></head><body><header class="fixture-titlebar"><span>←</span><span>☰</span><span>Twilight Echo</span></header><main class="fixture-stage"><p>插件开发示例</p><h1>让小组件留在侧边栏</h1><p>设备电量显示在导航下方。内容由插件自己的 HTML、CSS 和 JavaScript 渲染。</p></main><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.TWILIGHT_WIDGET_SAMPLE = source
    env.TWILIGHT_WIDGET_SCREENSHOTS = screenshots ?? ''
    await mkdir(join(directory, 'profile'), { recursive: true })
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), source, screenshots ?? ''],
      { env, windowsHide: true, timeout: 70_000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /SIDEBAR_WIDGETS_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(target.startsWith(resolve(temporaryRoot) + sep))
    await rm(target, { recursive: true, force: true })
  }
})

const fixture = `import {ref} from 'vue'
import sample from './sample.json'
export const experiences=ref([sample,{...sample,id:'full',name:'现有插件页面',launch:'page',sidebar:undefined},{...sample,id:'assistant',name:'Assistant',launch:'panel',sidebar:undefined}])
export const coreListeners=new Set()
export const commands=[]
const state=ref({epoch:'widgets',pluginsRevision:0})
const core={state,query:async name=>name==='extensions.experiences'?experiences.value:name==='extensions.list'?[{pluginId:'com.example.legacy',ui:[{id:'legacy',kind:'sidebarPage',title:'原有命令页面',command:'legacy.open'}],themes:[]}]:[],command:async(name,args)=>{commands.push({name,args});if(name==='extensions.pluginRequest')return {level:86};throw Error('Unexpected command: '+name)},subscribe:listener=>{coreListeners.add(listener);return()=>coreListeners.delete(listener)}}
export const useCoreConnection=()=>core
const settings=ref({navigationPages:{version:1,order:[],hidden:[]}})
export const useSettingsStore=()=>({settings,updateSettings:async()=>{}})
const music={libraryScanStatus:ref({state:'idle'}),libraryScanProgress:ref(null)}
export const useMusicStore=()=>music
export const usePlayerStore=()=>({})
export const useProviderStore=()=>({})
`

const runtime = `import {createApp,h,ref,computed,nextTick} from 'vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import ExperienceFlyout from '@renderer/components/ExperienceFlyout.vue'
import {useExtensionRegistry} from '@renderer/extensions/registry.ts'
import {buildNavigationPages} from '@renderer/app/navigationPages.ts'
import {TWILIGHT_DEFAULT_THEME,themeTokensToCssVariables} from '@renderer/../../shared/theme.ts'
import {experiences,coreListeners,commands} from './fixture.ts'
import sample from './sample.json'
import '@renderer/assets/main.css'
import '@renderer/assets/icon-fonts'
const registry=useExtensionRegistry(),open=ref(true),preview=ref(false)
const pages=computed(()=>buildNavigationPages(registry.uiContributions.value))
window.widgetErrors=[];window.addEventListener('error',e=>window.widgetErrors.push(e.message))
function tone(tone){document.documentElement.dataset.theme=tone;for(const [key,value] of Object.entries(themeTokensToCssVariables(TWILIGHT_DEFAULT_THEME.variants[tone].tokens)))document.documentElement.style.setProperty(key,value)}
tone('dark')
createApp({setup(){return()=>[h(SideMenu,{open:open.value,preview:preview.value,activeKey:'local-home',pages:pages.value,widgets:registry.sidebarExperiences.value}),h(ExperienceFlyout)]}}).mount('#app')
window.widgets={sample,open:async value=>{open.value=value;await nextTick()},preview:async value=>{preview.value=value;await nextTick()},tone,commands,
set:async value=>{experiences.value=value;await registry.syncExtensions();await nextTick()},
subscribers:()=>coreListeners.size,
emit:message=>{for(const listener of coreListeners)listener(message)},
registry:()=>({pages:registry.uiContributions.value.map(e=>e.id),widgets:registry.sidebarExperiences.value.map(e=>e.id)})}
registry.syncExtensions()
`

const probeScript = `let port,id=0;const pending=new Map();window.events=[];
window.call=(method,args={})=>new Promise(resolve=>{const key=++id;pending.set(key,resolve);port.postMessage({id:key,method,args})});
window.addEventListener('message',event=>{if(event.source!==parent||event.data?.type!=='twilight-experience-connect')return;port=event.ports[0];port.onmessage=({data})=>{if(data.event)window.events.push(data);else{pending.get(data.id)?.(data);pending.delete(data.id)}};port.start();window.connected=true});
parent.postMessage({type:'twilight-experience-ready',bridgeVersion:BRIDGE_VERSION},'*');`

const runner = `const assert=require('node:assert/strict'),{app,BrowserWindow,protocol}=require('electron'),fs=require('node:fs/promises'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'plugin-ui',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const source=process.env.TWILIGHT_WIDGET_SAMPLE,output=process.env.TWILIGHT_WIDGET_SCREENSHOTS;let probeLoads=0,win;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{try{
 const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
 protocol.handle('plugin-ui',async request=>{const url=new URL(request.url),name=path.posix.basename(url.pathname);let body;
 if(url.hostname==='com.example.probe')body=name==='probe.js'?${JSON.stringify(probeScript)}.replace('BRIDGE_VERSION',++probeLoads===1?'1':'2'):'<!doctype html><script src="probe.js" defer></script>';
 else if(url.hostname==='com.example.sidebar-battery'&&['index.html','widget.js','widget.css'].includes(name))body=await fs.readFile(path.join(source,'ui',name));else return new Response(null,{status:404});
 return new Response(body,{headers:{'Content-Type':mime[path.extname(name)],'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"}})});
 win=new BrowserWindow({show:false,width:960,height:800,webPreferences:{contextIsolation:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error('RENDERER '+event.message)});
 await win.loadFile(path.join(__dirname,'index.html'));
 win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
 const main=code=>win.webContents.executeJavaScript(code,true);
 const press=async(key,virtualKey,text)=>{await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:virtualKey,...(text?{text,unmodifiedText:text}:{})});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:virtualKey})};
 const until=async(code,label)=>{for(let i=0;i<160;i++){if(await main(code))return;await pause(30)}throw Error('Timed out: '+label)};
 const child=()=>win.webContents.mainFrame.frames.find(frame=>frame.url.startsWith('plugin-ui:'));
 const connected=()=>until('!!document.querySelector("iframe")&&!document.querySelector(".embedded-experience[aria-busy=true]")&&!document.querySelector(".embedded-status[role=alert]")','iframe connection');
 const capture=async name=>{if(output){await main('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(300);await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG())}};
 await connected();
 assert.deepEqual(await main('window.widgets.registry()'),{pages:['full','legacy'],widgets:['battery']});
 assert.equal(await main('window.widgets.subscribers()'),2);
 assert.deepEqual(await child().executeJavaScript('[...document.querySelectorAll("progress")].map(el=>el.value)'),[100,44,86]);
 assert.equal(await child().executeJavaScript('typeof require+":"+typeof window.api'),'undefined:undefined');
 assert.equal(await child().executeJavaScript('(()=>{try{parent.document.body;return false}catch{return true}})()'),true);
 await main('document.querySelector(".menu-nav").scrollTop=10000');await capture('expanded-dark');
 const point=await child().executeJavaScript('(()=>{const r=document.querySelector("#refresh").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
 const offset=await main('(()=>{const r=document.querySelector("iframe").getBoundingClientRect();return{x:r.x,y:r.y}})()');
 const position={x:Math.round(offset.x+point.x),y:Math.round(offset.y+point.y)};
 assert.equal(await main('document.elementFromPoint('+position.x+','+position.y+')?.tagName'),'IFRAME','widget must receive pointer input');
 assert.equal(await main('document.querySelector("iframe").inert||!!document.querySelector("iframe").closest("[inert]")'),false);
 await child().executeJavaScript('window.pointerEvents=[];document.addEventListener("pointerdown",e=>window.pointerEvents.push({type:e.type,target:e.target.id,x:e.clientX,y:e.clientY}),true)');
 for(const type of ['mouseMoved','mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1,...position});await pause(80);
 const clicked=await child().executeJavaScript('({level:document.querySelectorAll("progress")[1].value,events:window.pointerEvents,focus:document.hasFocus()})');
 assert.equal(clicked.level,43,JSON.stringify({point,offset,position,clicked}));
 await main('window.widgets.tone("pureWhite")');await pause(80);
 assert.equal(await child().executeJavaScript('document.documentElement.style.colorScheme'),'light');await capture('expanded-light');
 await main('document.querySelector(".sidebar-widget-toggle").focus()');
 await press('Enter',13,'\\r');
 await until('!document.querySelector("iframe")','keyboard collapse');assert.equal(await main('window.widgets.subscribers()'),1);
 await main('document.querySelector(".sidebar-widget-toggle").click()');await connected();
 await main('window.widgets.open(false)');await until('!document.querySelector("iframe")','closed sidebar');assert.equal(await main('window.widgets.subscribers()'),1);
 await main('window.widgets.open(true)');await connected();
 await main('window.widgets.preview(true)');await until('!document.querySelector("iframe")','theme preview isolation');
 await main('window.widgets.preview(false)');await connected();
 await main('document.documentElement.dataset.teNavigationStyle="rail"');await until('!document.querySelector("iframe")','rail unmount');
 await main('document.querySelector(".sidebar-widget-toggle").focus();document.querySelector(".sidebar-widget-toggle").click()');await connected();
 assert.equal(await main('document.querySelector(".experience-flyout-title").textContent'),'设备电量');await capture('rail-flyout');
 await main('document.querySelector(".experience-flyout-close").focus()');await press('Escape',27);
 await until('!document.querySelector("iframe")','flyout Escape');
 await main('document.querySelector(".sidebar-widget-toggle").click()');await connected();
 await main('window.widgets.set([])');await until('!document.querySelector(".experience-flyout")','disabled rail widget');assert.equal(await main('window.widgets.subscribers()'),1);
 await main('window.widgets.set([window.widgets.sample])');await until('!!document.querySelector(".sidebar-widget-toggle")','re-enabled rail widget');
 assert.equal(await main('document.querySelectorAll("iframe").length'),0,'re-enabling a widget must not reopen its retired flyout');
 await main('document.querySelector(".sidebar-widget-toggle").click()');await connected();
 await main('document.documentElement.dataset.teNavigationStyle="compact"');await until('!document.querySelector(".experience-flyout")','leaving rail closes flyout');await connected();
 assert.equal(await main('document.querySelectorAll("iframe").length'),1);
 await main('window.widgets.set([{...window.widgets.sample,version:"2.0.0",url:window.widgets.sample.url.replace("/1.0.0/","/2.0.0/")}])');await connected();
 assert.ok(child().url.includes('/2.0.0/'));assert.equal(await main('window.widgets.subscribers()'),2);
 win.setContentSize(640,420);await main('window.widgets.set([{...window.widgets.sample,sidebar:{height:480}}])');await connected();
 await main('document.querySelector(".menu-nav").scrollTop=10000');
 assert.equal(await main('document.querySelector(".menu-bottom").getBoundingClientRect().bottom<=innerHeight'),true);
 assert.equal(await main('document.querySelector("iframe").getBoundingClientRect().height<=innerHeight*.55+1'),true);await capture('compact-short');
 await main('window.widgets.set([])');await until('!document.querySelector("iframe")','disabled widget');assert.equal(await main('window.widgets.subscribers()'),1);
 win.setContentSize(960,800);
 await main('window.widgets.set([{...window.widgets.sample,pluginId:"com.example.probe",id:"probe",url:"plugin-ui://com.example.probe/1.0.0/ui/probe.html",sidebar:{height:64},permissions:["ui:inject","network"]}])');
 await until('document.querySelector(".embedded-status[role=alert]")?.textContent.includes("版本不匹配")','bridge mismatch');assert.equal(await main('window.widgets.subscribers()'),1);
 await main('document.querySelector(".menu-nav").scrollTop=10000');
 assert.equal(await main('(()=>{const status=document.querySelector(".embedded-status");return status.querySelector("span").getBoundingClientRect().top>=status.getBoundingClientRect().top})()'),true,'minimum-height errors start within the scrollable surface');
 await main('document.querySelector(".embedded-status").scrollTop=10000');
 assert.equal(await main('(()=>{const status=document.querySelector(".embedded-status"),button=status.querySelector("button").getBoundingClientRect(),surface=status.getBoundingClientRect();return button.top>=surface.top&&button.bottom<=surface.bottom})()'),true,'minimum-height errors keep retry reachable');await capture('minimum-height-error');
 await main('document.querySelector(".embedded-status button").click()');await connected();
 const probe=child();await until('window.widgets.subscribers()===2','probe bridge');
 assert.deepEqual(await probe.executeJavaScript('window.call("plugin.request",{request:{kind:"battery"}})'),{id:1,value:{level:86}});
 assert.match((await probe.executeJavaScript('window.call("player.play")')).error,/denied/);
 assert.match((await probe.executeJavaScript('window.call("host.panel",{name:"settings"})')).error,/denied/);
 await main('window.widgets.emit({kind:"plugin-experience",pluginId:"com.example.other",event:"battery",value:{level:1}});window.widgets.emit({kind:"plugin-experience",pluginId:"com.example.probe",event:"battery",value:{level:85}})');await pause(50);
 assert.deepEqual(await probe.executeJavaScript('window.events.filter(e=>e.event==="plugin").map(e=>e.value)'),[{event:'battery',value:{level:85}}]);
 await main('(()=>{const f=document.querySelector("iframe");for(const [source,origin] of [[window,"plugin-ui://com.example.probe"],[f.contentWindow,"plugin-ui://com.example.other"]])window.dispatchEvent(new MessageEvent("message",{source,origin,data:{type:"twilight-experience-ready",bridgeVersion:1}}))})()');
 assert.equal(await main('!!document.querySelector(".embedded-status[role=alert]")'),false);
 await main('window.widgets.tone("dark")');await pause(50);assert.equal(await probe.executeJavaScript('window.events.filter(e=>e.event==="appearance").at(-1).value.theme'),'dark');
 await probe.executeJavaScript('void window.call("host.exit");true');await until('!document.querySelector("iframe")','widget host.exit');assert.equal(await main('window.widgets.subscribers()'),1);
 assert.deepEqual(await main('window.widgets.commands.map(c=>c.name)'),['extensions.pluginRequest']);
 assert.deepEqual(await main('window.widgetErrors'),[]);
 console.log('SIDEBAR_WIDGETS_OK');win.destroy();app.exit(0);
}catch(error){console.error(error.stack);if(win&&!win.isDestroyed())console.error('STATE '+await win.webContents.executeJavaScript('JSON.stringify({errors:window.widgetErrors,fixture:!!window.widgets,subscribers:window.widgets?.subscribers(),frames:document.querySelectorAll("iframe").length,status:document.querySelector(".embedded-status")?.textContent})'));if(output&&win&&!win.isDestroyed()){await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG())}win?.destroy();app.exit(1)}});`
