import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'esbuild'
import { themeContrastRatio } from '../../../shared/theme.ts'

test('decoded local images supply their own control tint and accent in both modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echora-image-palette-'))
  try {
    const bundle = await build({
      stdin: {
        contents: `import {analyzeBackgroundImage} from './src/renderer/src/utils/backgroundImagePalette.ts';
import {normalizeAppBackgroundSettings,resolveBackgroundPalette} from './src/shared/appAppearance.ts';
window.prepare=()=>Object.fromEntries(['#ec002c','#1e50c8','#2a995b','#777777'].map((color,index)=>{
 const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const context=canvas.getContext('2d');
 context.fillStyle=color;context.fillRect(0,0,64,64);context.fillStyle='#f5f5f5';context.fillRect(0,0,16,64);
 return ['sample-'+index+'.png',canvas.toDataURL('image/png').split(',')[1]];
}));
window.check=async()=>{
 const samples=[];
 for(let index=0;index<4;index++){
  const image='background://sample-'+index+'.png';
  const sample=await analyzeBackgroundImage(image,{createImage:()=>new Image(),createCanvas:()=>document.createElement('canvas')});
  const background=normalizeAppBackgroundSettings({global:{kind:'image',image,imagePalette:sample}}).global;
  samples.push({sample,modes:['light','dark'].map(tone=>({tone,...resolveBackgroundPalette(background,tone)}))});
 }
 return samples;
};`,
        resolveDir: resolve('.')
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022'
    })
    await writeFile(join(directory, 'index.html'), `<script>${bundle.outputFiles[0].text}</script>`)
    await writeFile(
      join(directory, 'runner.cjs'),
      `
const {app,BrowserWindow,protocol}=require('electron');
app.setPath('userData',__dirname+'/profile');
protocol.registerSchemesAsPrivileged([{scheme:'background',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.whenReady().then(async()=>{
 let win;
 try{
  const images={};
  protocol.handle('background',request=>{
   const name=new URL(request.url).hostname;
   return new Response(Buffer.from(images[name]||'','base64'),{status:images[name]?200:404,headers:{'Content-Type':'image/png','Access-Control-Allow-Origin':'*'}});
  });
  win=new BrowserWindow({show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
  await win.loadFile(__dirname+'/index.html');Object.assign(images,await win.webContents.executeJavaScript('window.prepare()'));
  console.log('PALETTE_DECODE',JSON.stringify(await win.webContents.executeJavaScript('window.check()')));
  win.destroy();app.exit(0);
 }catch(error){console.error(error);win?.destroy();app.exit(1)}
});`
    )
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 30_000 }
    )
    const samples = JSON.parse(result.stdout.match(/PALETTE_DECODE (.+)/)![1])
    assert.deepEqual(
      samples.map((item) => item.sample.accent),
      ['#ec002c', '#1e50c8', '#2a995b', '#979797']
    )
    for (const sample of samples) {
      assert.equal(sample.sample.opacity, 1)
      for (const mode of sample.modes) {
        for (const surface of [mode.controlBackground, mode.controlHover, mode.controlActive])
          assert.ok((themeContrastRatio(mode.controlForeground, surface) ?? 0) >= 4.5)
        assert.ok((themeContrastRatio(mode.onAccent, mode.accent) ?? 0) >= 4.5)
      }
    }
    for (const index of [0, 1]) {
      assert.equal(new Set(samples.map((item) => item.modes[index].controlBackground)).size, 4)
      assert.equal(new Set(samples.map((item) => item.modes[index].accent)).size, 4)
    }
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})
