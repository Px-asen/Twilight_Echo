import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('3D rulers retain readable editor colors across matching and opposite preview tones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-view-angle-chrome-'))
  try {
    const pagePath = resolve('src/renderer/src/components/AppearancePage.vue')
    const { descriptor } = parse(await readFile(pagePath, 'utf8'), { filename: pagePath })
    const pageStyle = compileStyle({
      source: descriptor.styles.find((style) => style.scoped)!.content,
      filename: pagePath,
      id: 'data-v-ruler-chrome',
      scoped: true
    })
    assert.deepEqual(pageStyle.errors, [])
    await writeFile(join(directory, 'page.css'), pageStyle.code)
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
          name: 'ViewAngleChromeTest',
          formats: ['iife'],
          cssFileName: 'runtime',
          fileName: () => 'runtime.js'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<link rel="stylesheet" href="page.css"><style>
      body{margin:0;background:var(--te-app-bg);font-family:Arial}
      .appearance-page[data-v-ruler-chrome]{padding:0;height:400px}
      .appearance-editor{position:relative;width:640px;height:400px;max-height:none;border:0;border-radius:0;background:transparent;box-shadow:none}
      .preview-surface{position:absolute;inset:30px 20px 15px 100px;background:var(--fixture-preview-bg)}
      .appearance-editor .appearance-view-angles{inset:24px}
      </style></head><body><main data-v-ruler-chrome class="appearance-page" data-appearance-workspace="customize"><section class="appearance-editor appearance-editor--character"><div class="preview-surface"></div><div id="app"></div></section></main><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    if (process.env.TE_RULER_QA_OUTPUT)
      await mkdir(resolve(process.env.TE_RULER_QA_OUTPUT), { recursive: true })
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 45_000 }
    )
    assert.match(result.stdout, /VIEW_ANGLE_CHROME_OK/)
    console.info(result.stdout.trim())
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-view-angle-chrome-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue';
import ViewAngleControl from '__RENDERER__/components/AppearanceViewAngleControl.vue';
import '__RENDERER__/assets/base.css';
import '__RENDERER__/assets/materials.css';
import '__RENDERER__/components/settings-page/BackgroundAppearanceCustomizer.css';
const angles=ref({x:0,y:0}),zoom=ref(1);let restored=false;
createApp({render:()=>h(ViewAngleControl,{modelValue:angles.value,zoom:zoom.value,'onUpdate:modelValue':value=>angles.value=value,'onUpdate:zoom':value=>zoom.value=value,onRestore:()=>restored=true})}).mount('#app');
const expect=(value,message)=>{if(!value)throw Error(message)};
const settle=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))};
const rgb=value=>{const context=document.createElement('canvas').getContext('2d');context.fillStyle=value;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data].slice(0,3)};
const luminance=values=>values.map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
const contrast=(a,b)=>{const first=luminance(a),second=luminance(b);return(Math.max(first,second)+.05)/(Math.min(first,second)+.05)};
window.rulerCase=async(hostTone,previewTone)=>{
 const root=document.documentElement,editor=document.querySelector('.appearance-editor');
 root.dataset.theme=hostTone==='light'?'pureWhite':'dark';
 root.style.setProperty('--te-app-bg',hostTone==='light'?'#f4f4f7':'#17181a');
 editor.style.setProperty('--appearance-selection-color',previewTone==='dark'?'#dedede':'#4d5056');
 editor.style.setProperty('--fixture-preview-bg',previewTone==='dark'?'#17181a':'#f4f4f7');
 await settle();
 const ruler=document.querySelector('.appearance-view-angles'),rulerStyle=getComputedStyle(ruler),editorText=getComputedStyle(document.querySelector('.appearance-page')).color;
 for(const control of ruler.querySelectorAll('.appearance-angle-reading,.appearance-camera-controls')){const rect=control.getBoundingClientRect();expect(rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,'ruler QA fixture clips a control')}
 expect(rulerStyle.color===editorText,'rulers inherited the preview selection color instead of the host editor text: '+JSON.stringify({hostTone,previewTone,actual:rulerStyle.color,editorText}));
 const readings=[...document.querySelectorAll('.appearance-angle-reading,.appearance-camera-controls')],textContrasts=readings.map(element=>{const style=getComputedStyle(element);expect(style.backgroundColor!=='rgba(0, 0, 0, 0)','cross-preview ruler text has no editor surface');return contrast(rgb(style.color),rgb(style.backgroundColor))});
 expect(textContrasts.every(value=>value>=4.5),'ruler text contrast below 4.5: '+JSON.stringify(textContrasts));
 const surface=rgb(getComputedStyle(document.querySelector('.appearance-camera-controls')).backgroundColor);
 const strokes=[...document.querySelectorAll('.appearance-angle-axis path,.appearance-angle-axis line,.appearance-camera-scale path,.appearance-camera-scale line')],strokeContrasts=strokes.map(element=>{const style=getComputedStyle(element),opacity=Number(style.opacity),color=rgb(style.stroke),paint=color.map((value,index)=>value*opacity+surface[index]*(1-opacity));return contrast(paint,surface)});
 expect(strokeContrasts.every(value=>value>=3),'ruler tracks or ticks have contrast below 3: '+JSON.stringify(strokeContrasts));
 for(const svg of document.querySelectorAll('.appearance-angle-axis svg,.appearance-camera-scale svg'))expect(getComputedStyle(svg).filter.includes('drop-shadow'),'ruler track lacks a host-surface outline over the preview');
 for(const marker of document.querySelectorAll('.appearance-angle-marker')){const style=getComputedStyle(marker);expect(contrast(rgb(style.backgroundColor),surface)>=3,'ruler handle contrast below 3');expect(style.boxShadow!=='none','ruler handle lacks a host-surface outline over the preview')}
 const yaw=document.querySelector('[aria-label="左右视角"]');yaw.value='23';yaw.dispatchEvent(new Event('input',{bubbles:true}));await settle();expect(yaw.getAttribute('aria-valuetext')==='23°','ruler angle interaction no longer updates');
 const scale=document.querySelector('[aria-label="相机缩放"]');scale.value='1.8';scale.dispatchEvent(new Event('input',{bubbles:true}));await settle();expect(zoom.value===1.8,'ruler zoom interaction no longer updates');
 document.querySelector('.appearance-camera-restore').click();expect(restored,'ruler restore action no longer emits');
 return{hostTone,previewTone,textContrast:Math.min(...textContrasts),trackContrast:Math.min(...strokeContrasts),color:rulerStyle.color};
};`

const runner = `const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:640,height:400,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false}});
 try{
  await win.loadFile(path.join(__dirname,'index.html'));
  for(const hostTone of ['light','dark'])for(const previewTone of ['light','dark']){
   const result=await win.webContents.executeJavaScript('window.rulerCase('+JSON.stringify(hostTone)+','+JSON.stringify(previewTone)+')');
   console.log('VIEW_ANGLE_CHROME_CASE',JSON.stringify(result));
   if(process.env.TE_RULER_QA_OUTPUT){const size=await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');fs.writeFileSync(path.join(process.env.TE_RULER_QA_OUTPUT,'ruler-host-'+hostTone+'-preview-'+previewTone+'.png'),(await win.webContents.capturePage()).resize(size).toPNG())}
  }
  console.log('VIEW_ANGLE_CHROME_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});`
