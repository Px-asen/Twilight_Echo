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

test('anchored popovers preserve momentum, origins, focus and native menu behavior', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-popover-motion-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          'primeicons/primeicons.css': require.resolve('primeicons/primeicons.css')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'PopoverMotion',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="full" data-theme="pureWhite"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<style>body{margin:0;font:14px system-ui;background:#f5f4f8;color:#20212b}#app{padding:64px}.preview{padding:24px;border-radius:20px;background:#eee9f7;width:340px;height:260px}.preview h1{font-size:24px}button{font:inherit;cursor:pointer}.anchor{position:fixed;left:130px;top:360px;width:80px;height:38px}.appearance-popover{--te-settings-backplate:#fff;--te-settings-text:#20212b}.appearance-popover-content{display:grid;gap:12px}.appearance-popover-content h2{margin:0;font-size:15px}.appearance-popover-content button{min-height:36px;border:0;border-radius:8px;background:#eee9f7}.provider{position:fixed;right:100px;top:94px}.overlay{position:fixed;inset:0;background:rgb(20 30 60 / .3);display:grid;place-items:center}.overlay-panel{background:white;border-radius:18px;padding:30px;width:320px}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs/promises'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1040,height:720,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:true,contextIsolation:false}});ipcMain.handle('capture-popover',async(_e,name)=>{const dir=process.env.TWILIGHT_POPOVER_CAPTURE_DIR;if(dir){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,name+'.png'),(await win.webContents.capturePage()).toPNG())}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runPopoverMotion()');console.log('POPOVER_MOTION_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /POPOVER_MOTION_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import AppearancePopover from '@renderer/components/AppearancePopover.vue'
import ProviderSwitcher from '@renderer/components/streaming-page/StreamingProviderSwitcher.vue'
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import '@renderer/assets/base.css'
import 'primeicons/primeicons.css'
const expect=(ok,message)=>{if(!ok)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}
const pause=(ms=25)=>new Promise(r=>setTimeout(r,ms))
const finish=async()=>{await nextTick();for(const a of document.getAnimations())a.finish();await tick()}
const pointer=element=>element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))
const click=async element=>{pointer(element);element.click();await tick()}
const freeze=(element,time)=>{const animations=element.getAnimations();expect(animations.length,'missing motion on '+element.className);for(const a of animations){a.pause();a.currentTime=time}return animations}
const capture=async name=>{await tick();await window.require('electron').ipcRenderer.invoke('capture-popover',name)}
const anchor=ref(null),shown=ref(false),overlay=ref(false),provider=ref('ncm')
const options=[{id:'ncm',name:'网易云音乐',icon:'pi pi-cloud',color:'#df5266'},{id:'local',name:'本地曲库',icon:'pi pi-folder',color:'#8362ce'}]
const app=createApp({render:()=>[
 h('section',{class:'preview'},[h('h1','外观与音源'),h('p','调整表面颜色与圆角，保留清晰的层次。')]),
 h('button',{ref:anchor,class:'anchor',onClick:()=>shown.value=!shown.value},'编辑外观'),
 h(AppearancePopover,{open:shown.value,anchor:anchor.value,label:'表面设置',onClose:()=>shown.value=false},()=>[h('h2','表面设置'),h('button','浅色磨砂'),h('button','柔和圆角'),h('label',['背景强度 ',h('input',{type:'range',value:65})])]),
 h('div',{class:'provider'},[h(ProviderSwitcher,{modelValue:provider.value,options,onChange:value=>provider.value=value})]),
 h(NativeDialogTransition,{overlay:true,restoreFocus:anchor.value},()=>overlay.value?h('div',{class:'overlay'},[h('section',{class:'overlay-panel','data-dialog-panel':'',role:'dialog'},[h('h2','保存外观'),h('p','仅面板轻轻展开，背景保持固定。'),h('button',{onClick:()=>overlay.value=false},'完成')])]):null)
]});app.mount('#app')
const panel=()=>document.querySelector('.appearance-popover')
window.runPopoverMotion=async()=>{
 await tick();await click(anchor.value);freeze(panel(),35);
 const origin=getComputedStyle(panel()).transformOrigin.split(' ').map(parseFloat);
 expect(panel().dataset.side==='top'&&origin[1]===0,'popover did not grow from its trigger edge');
 expect(Math.abs(origin[0]-(anchor.value.offsetLeft+anchor.value.offsetWidth/2-panel().offsetLeft))<1,'popover origin drifted away from anchor');
 expect(panel().contains(document.activeElement),'popover did not focus a control');await capture('appearance-enter');await finish();
 shown.value=false;await nextTick();const old=panel();freeze(old,29);const previous=new DOMMatrix(getComputedStyle(old).transform).a;freeze(old,30);const current=new DOMMatrix(getComputedStyle(old).transform).a,alpha=Number(getComputedStyle(old).opacity);
 shown.value=true;await nextTick();freeze(panel(),0);expect(Math.abs(new DOMMatrix(getComputedStyle(panel()).transform).a-current)<.0001&&Math.abs(Number(getComputedStyle(panel()).opacity)-alpha)<.01,'reopened appearance popover snapped');freeze(panel(),1);const velocity=new DOMMatrix(getComputedStyle(panel()).transform).a-current;
 expect(velocity<0&&Math.abs(velocity-(current-previous))<Math.abs(current-previous)*.4,'appearance reversal lost velocity');await finish();await capture('appearance-open');
 panel().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();expect(!panel()&&document.activeElement===anchor.value,'keyboard dismissal delayed or lost anchor focus');
 anchor.value.click();await tick();expect(panel()&&!panel().getAnimations().length,'keyboard popover opening animated');shown.value=false;await tick();
 for(const mode of ['reduced','off']){document.documentElement.dataset.teMotion=mode;await tick();await click(anchor.value);if(mode==='reduced')freeze(panel(),35);expect(getComputedStyle(panel()).transform==='none','reduced/off popover moved');if(mode==='off')expect(!panel().getAnimations().length,'off popover animated');await finish();shown.value=false;await finish()}
 document.documentElement.dataset.teMotion='full';await tick();await click(anchor.value);shown.value=false;await nextTick();document.documentElement.dataset.teVisibility='hidden';await tick();expect(!panel(),'hidden window retained popover');delete document.documentElement.dataset.teVisibility;
 const trigger=document.querySelector('.provider-switcher-trigger'),menu=document.querySelector('.provider-switcher-menu');await click(trigger);expect(menu.matches(':popover-open')&&!menu.inert,'provider native menu did not open');
 freeze(menu,45);expect(menu.getAnimations().every(a=>a.effect.getTiming().duration<=180),'provider menu exceeded small surface duration');const menuAlpha=Number(getComputedStyle(menu).opacity);expect(menuAlpha>0&&menuAlpha<1,'provider entry did not fade');await capture('provider-enter');await finish();
 await click(menu.querySelectorAll('button')[1]);expect(provider.value==='local'&&!menu.matches(':popover-open')&&menu.inert,'provider selection lost native close behavior');await finish();
 document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));trigger.click();await tick();expect(menu.matches(':popover-open')&&!menu.getAnimations().length,'keyboard provider menu animated');trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();expect(!menu.matches(':popover-open')&&!menu.getAnimations().length,'keyboard provider menu delayed close');
 pointer(anchor.value);anchor.value.focus();overlay.value=true;await nextTick();const backdrop=document.querySelector('.overlay'),content=document.querySelector('.overlay-panel');freeze(backdrop,35);freeze(content,35);const rect=backdrop.getBoundingClientRect();expect(rect.left===0&&rect.top===0&&rect.width===innerWidth&&rect.height===innerHeight,'legacy overlay backdrop scaled');expect(new DOMMatrix(getComputedStyle(content).transform).a<1,'legacy overlay panel did not move');await capture('overlay-enter');await finish();content.querySelector('button').focus();overlay.value=false;await finish();expect(!document.querySelector('.overlay')&&document.activeElement===anchor.value,'legacy overlay lost focus restoration');
 app.unmount();expect(!document.getAnimations().length,'popover teardown left animations')
}
`
