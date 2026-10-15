import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)

test('missing wallpaper preserves the exact fallback color and a later image restores its saved effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-background-fallback-'))
  try {
    await writeFile(
      join(directory, 'entry.ts'),
      runtime.replaceAll('__RENDERER__', resolve('src/renderer/src').replaceAll('\\', '/'))
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [vue()],
      resolve: { alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') } },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'BackgroundFallbackTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    const appearance = await readFile(resolve('src/renderer/src/assets/appearance.css'), 'utf8')
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><style>${appearance}
      :root{--te-appearance-mask:#000;--te-app-bg:#f4f4f7;--te-app-background-blur:5px;--te-app-background-brightness:50%;--te-app-background-dim:.7;--te-app-background-scale:1.3;--te-app-background-position:50% 50%}
      body{margin:0}.app-background-layer,.appearance-window-background{display:block!important;position:absolute;top:0;width:180px;height:180px;z-index:0;overflow:hidden;background:var(--appearance-color)}
      .appearance-window-background{left:200px;--appearance-color:var(--te-app-bg);--appearance-image:var(--te-app-bg-image,none);--appearance-blur:var(--te-app-background-blur);--appearance-brightness:var(--te-app-background-brightness);--appearance-dim:var(--te-app-background-dim);--appearance-scale:var(--te-app-background-scale)}
      </style></head><body><div id="app"></div><div class="appearance-window-background"><div class="app-background-image"></div><div class="app-background-dim"></div></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 45_000 }
    )
    assert.match(result.stdout, /BACKGROUND_FALLBACK_OK/)
    console.info(result.stdout.trim())
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-background-fallback-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue';
import AppBackgroundLayer from '__RENDERER__/components/AppBackgroundLayer.vue';
import {mountBackgroundImageFallback} from '__RENDERER__/app/backgroundImageFallback.ts';
import {readingMaterialTreatment} from '__RENDERER__/../../shared/materials.ts';
const reading=ref(false);const app=createApp({render:()=>h(AppBackgroundLayer,{page:'app',reading:reading.value})});app.mount('#app');
const preview=document.querySelector('.appearance-window-background'),guard=mountBackgroundImageFallback(preview);
const expect=(value,message)=>{if(!value)throw Error(message)};
const layers=()=>[document.querySelector('.app-background-layer'),preview];
const waitFor=async check=>{for(let i=0;i<100&&!check();i++)await new Promise(resolve=>setTimeout(resolve,10));expect(check(),'image fallback never settles')};
const source=value=>document.documentElement.style.setProperty('--te-app-bg-image',value?'url("'+value+'")':'none');
const valid='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><path fill="#4080c0" d="M0 0h180v180H0z"/></svg>');
window.fallbackCase=async kind=>{
 source(kind==='valid'?valid:kind==='missing'?'file:///missing-twilight-background.png':'');await nextTick();
 const state=kind==='valid'?'ready':kind==='missing'?'error':undefined;
 await waitFor(()=>layers().every(layer=>layer.dataset.backgroundImageState===state));
 const root=document.documentElement,marker=kind==='missing'?'dark':undefined;
 expect(root.dataset.teAppImageFallbackTone===marker&&root.dataset.teLocalImageFallbackTone===marker,'image fallback markers do not match the visible color or survive a valid image');
 if(kind==='missing'){
  delete root.dataset.teAppImageFallbackTone;delete root.dataset.teLocalImageFallbackTone;
  await waitFor(()=>root.dataset.teAppImageFallbackTone==='dark'&&root.dataset.teLocalImageFallbackTone==='dark');
 }
 for(const layer of layers()){
  const dim=getComputedStyle(layer.querySelector('.app-background-dim')),image=getComputedStyle(layer.querySelector('.app-background-image'));
  if(kind==='missing')expect(dim.display==='none'&&image.filter==='none'&&image.backgroundImage==='none','failed image still applies its tuning');
  if(kind==='valid')expect(dim.display!=='none'&&image.filter.includes('brightness(0.5)'),'valid image does not restore the configured tuning');
 }
 await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 return layers().map(layer=>layer.dataset.backgroundImageState??'none');
};
window.readingCase=async mode=>{
 const root=document.documentElement,before=root.style.getPropertyValue('--te-app-background-blur');const treatment=readingMaterialTreatment(mode);root.style.setProperty('--te-reading-blur',treatment.blur+'px');root.style.setProperty('--te-reading-fade',String(treatment.fade));reading.value=true;source(valid);await nextTick();await waitFor(()=>layers().every(layer=>layer.dataset.backgroundImageState==='ready'));await new Promise(resolve=>requestAnimationFrame(resolve));
 const main=layers()[0],image=getComputedStyle(main.querySelector('.app-background-image')),wash=getComputedStyle(main.querySelector('.app-background-reading-wash'));expect(image.filter.includes('blur('+(5+treatment.blur)+'px)')&&Number(wash.opacity)===treatment.fade&&wash.display==='block','reading focus does not use selected material');expect(getComputedStyle(preview.querySelector('.app-background-image')).filter.includes('blur(5px)'),'reading focus changes actual preview');
 reading.value=false;await nextTick();expect(getComputedStyle(main.querySelector('.app-background-image')).filter.includes('blur(5px)')&&root.style.getPropertyValue('--te-app-background-blur')===before,'leaving configuration loses saved wallpaper tuning');return treatment;
};
window.disposeFallback=async()=>{guard.dispose();app.unmount();source(valid);await new Promise(resolve=>setTimeout(resolve,30));expect(preview.dataset.backgroundImageState==='error','disposed guard still mutates its layer');expect(!document.documentElement.dataset.teAppImageFallbackTone&&!document.documentElement.dataset.teLocalImageFallbackTone,'disposed guards retain runtime fallback markers');};
`

const runner = `const {app,BrowserWindow}=require('electron'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:400,height:200,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false}});
 try{
  await win.loadFile(path.join(__dirname,'index.html'));
  for(const kind of ['missing','valid','missing']){
   const states=await win.webContents.executeJavaScript('window.fallbackCase('+JSON.stringify(kind)+')');
   const size=await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
   const capture=(await win.webContents.capturePage()).resize(size),bitmap=capture.toBitmap(),expected=kind==='valid'?[10,19,29]:[244,244,247];
   for(const x of [90,290]){const offset=(90*size.width+x)*4,rgb=[bitmap[offset+2],bitmap[offset+1],bitmap[offset]];if(rgb.some((value,index)=>Math.abs(value-expected[index])>2))throw Error('Fallback paint differs from its selected color: '+JSON.stringify({kind,x,rgb,expected}));}
   console.log('BACKGROUND_FALLBACK_CASE',kind,JSON.stringify(states));
  }
  for(const mode of ['solid','frosted','liquidGlass','transparent'])console.log('READING_MATERIAL',mode,JSON.stringify(await win.webContents.executeJavaScript('window.readingCase('+JSON.stringify(mode)+')')));
  await win.webContents.executeJavaScript('window.fallbackCase("missing")');
  await win.webContents.executeJavaScript('window.disposeFallback()');
  console.log('BACKGROUND_FALLBACK_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});`
