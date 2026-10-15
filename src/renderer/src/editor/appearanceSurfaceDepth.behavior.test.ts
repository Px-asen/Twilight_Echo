import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'

test('every visible card retains its native glass pixels while cards and nested buttons acquire separate depth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'echora-surface-depth-'))
  try {
    await build({
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: resolve('src/renderer/src/editor/appearanceLayerView.ts'),
          name: 'Layers',
          formats: ['iife'],
          fileName: 'layers'
        }
      }
    })
    const bundle = (await readdir(join(directory, 'bundle'))).find((file) => file.endsWith('.js'))!
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><style>
    html,body{margin:0;width:1000px;height:700px}*{box-sizing:border-box}
    .appearance-preview-scene,.appearance-window-background,.app-shell-content{position:absolute;inset:0;width:1000px;height:700px}
    .appearance-preview-scene{isolation:isolate}.appearance-window-background{z-index:-1;background:repeating-linear-gradient(90deg,#ed3360 0px 12px,#1b36a1 12px 24px,#e9edf8 24px 36px)}
    .home{position:absolute;inset:0}.card{position:absolute;top:100px;width:240px;height:180px;border:1px solid #ffffff30;border-radius:18px;background:rgba(25,28,38,.42);backdrop-filter:blur(12px) saturate(110%)}
    .card button{position:absolute;left:24px;bottom:20px;width:110px;height:36px;border:1px solid #ffffff30;border-radius:10px;background:rgba(250,250,255,.26);backdrop-filter:blur(8px);color:white}
    </style><div class="app-shell appearance-preview-scene"><div class="appearance-window-background"></div><div class="app-shell-content"><main class="main-content"><section class="home">
    <article class="card feature-card" style="left:80px"><button>Play</button></article><article class="card fresh-tile" style="left:380px"><button>Open</button></article><article class="card gallery-tile" style="left:680px"><button>More</button></article>
    </section></main></div></div><script src="bundle/${bundle}"></script><script>
    const source=document.querySelector('.appearance-preview-scene'),cards=[...source.querySelectorAll('.card')],button=cards[0].querySelector('button');let view;
    const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}};
    const nodes=[{id:'inner-panel',rect:rect(source)},{id:'card',rect:rect(cards[0])},{id:'controls',rect:rect(button)}];
    const baseline=source.outerHTML;
    window.surfaceFrame=async mode=>{
      if(mode==='native'){view?.dispose();view=undefined;source.style.visibility=''}else{
        view??=Layers.createAppearanceLayerView(document);view.sync({scene:source,size:{width:1000,height:700},nodes,spacing:mode==='folded'?0:56,angles:{x:0,y:0}});source.style.visibility='hidden';
      }
      await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);
      const root=view?.element??source,shown=mode==='native'?cards:[...root.querySelectorAll('[data-appearance-detail="card"] .card:not([data-appearance-detail-branch])')].filter(card=>!card.closest('[data-appearance-material-context]'));
      if(shown.length!==3)throw Error('visible card family coverage: '+shown.length);
      const pixels=shown.map(card=>{const r=card.getBoundingClientRect();return {x:Math.ceil(r.left+24),y:Math.ceil(r.top+24),width:80,height:48}});
      if(mode==='raised'){
        const planes=[...root.querySelectorAll('[data-appearance-detail]')],card=planes.find(p=>p.dataset.appearanceDetail==='card'),control=planes.find(p=>p.dataset.appearanceDetail==='controls');
        if(!card||!control||card.style.transform===control.style.transform)throw Error('card and button share a flat depth');
        if(root.querySelectorAll('[data-appearance-detail="card"] [data-appearance-material-context]').length!==3)throw Error('a card lost its native sampling context');
      }
      return pixels;
    };
    window.finishSurfaces=()=>{view.dispose();source.style.visibility='';const restored=source.cloneNode(true);if(!restored.getAttribute('style'))restored.removeAttribute('style');if(restored.outerHTML!==baseline)throw Error('preview mutates its native source');};
    </script>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:700,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});try{await win.loadFile(require('node:path').join(__dirname,'index.html'));const frames={};for(const mode of ['native','folded','raised']){const regions=await win.webContents.executeJavaScript('window.surfaceFrame('+JSON.stringify(mode)+')');frames[mode]=[];for(const region of regions)frames[mode].push((await win.webContents.capturePage(region)).toBitmap());}const differences=[];for(const mode of ['folded','raised'])for(let c=0;c<3;c++){let delta=0;for(let i=0;i<frames.native[c].length;i+=4)for(let k=0;k<3;k++)delta+=Math.abs(frames.native[c][i+k]-frames[mode][c][i+k]);delta/=frames.native[c].length/4*3;differences.push({mode,card:c,delta});if(delta>5)throw Error('glass pixels diverge '+JSON.stringify(differences));}const failure=await win.webContents.executeJavaScript('(()=>{try{window.finishSurfaces();return null}catch(e){return e.stack}})()');if(failure)throw Error(failure);console.log('SURFACE_DEPTH '+JSON.stringify(differences));app.exit(0);}catch(e){console.error(e);app.exit(1)}});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron'),
      [join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 30_000, env }
    )
    assert.match(result.stdout, /SURFACE_DEPTH/)
    console.info(result.stdout.trim())
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
