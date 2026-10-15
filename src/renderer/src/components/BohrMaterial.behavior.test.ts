import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { compileStyle, parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../../', import.meta.url))

test('glass transmission preserves input and DPI geometry without player edge lighting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-bohr-'))
  try {
    const read = (path: string): Promise<string> => readFile(join(root, path), 'utf8')
    const global =
      (await read('src/renderer/src/assets/base.css')) +
      (await read('src/renderer/src/assets/materials.css')) +
      (await read('src/renderer/src/assets/bohr.css')) +
      (await read('src/renderer/src/assets/appearance.css'))
    const styles = [
      process.env.TE_MATERIAL_BASELINE
        ? await readFile(process.env.TE_MATERIAL_BASELINE, 'utf8')
        : await read('src/renderer/src/components/player-bar/PlayerBar.css'),
      await read('src/renderer/src/components/settings-page/SettingsPage.css'),
      await read('src/renderer/src/components/song-list/SongList.css'),
      parse(await read('src/renderer/src/components/TitleBar.vue')).descriptor.styles[0].content,
      parse(await read('src/renderer/src/components/SideMenu.vue')).descriptor.styles[0].content
    ].map((source) => {
      const result = compileStyle({ source, filename: 'Bohr.css', id: 'data-v-bohr', scoped: true })
      assert.deepEqual(result.errors, [])
      return result.code
    })
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root,
      plugins: [vue()],
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: { alias: { '@renderer': join(root, 'src/renderer/src') } },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'BohrTest',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-platform="win32" data-theme="dark"><head><meta charset="utf-8">
      <style>${global}\n${styles.join('\n')}
      *,*::before,*::after{transition:none!important}
      body{margin:0;background:#17181a;padding:100px 40px;color:#eee}
      .backdrop{height:460px;border-radius:24px;background:linear-gradient(125deg,#677773,#805440 44%,#172e4a);padding:28px;font-size:32px}
      .player-bar[data-v-bohr]{position:absolute;top:220px;left:40px;right:40px;width:auto}
      .player-left,.player-center,.player-right{grid-row:1}
      .player-left{grid-column:1}.player-center{grid-column:2}.player-right{grid-column:3}
      .player-center{display:flex;align-items:center;justify-content:center}
      button{border:0;color:inherit;background:#ffffff12;border-radius:16px;padding:8px 24px}
      .settings-preview-nav[data-v-bohr]{top:390px;left:70px;right:auto;bottom:auto;transform:none;width:192px}
      .home .feature-card{position:absolute;top:410px;left:600px;width:180px;height:120px;border-radius:18px}
      .track-row[data-v-bohr]{position:absolute;top:555px;left:640px;width:340px;height:64px;display:flex;align-items:center;justify-content:center}
      </style></head><body>
      <div data-te-material="titlebar" class="title-bar" data-v-bohr><div class="title-bar-background" data-v-bohr></div></div>
      <div class="backdrop">透光的体积<br><small>温润弧面 · 清晰内容 · 柔和光影</small></div>
      <div class="player-bar player-bar-liquid" data-v-bohr>
        <span class="player-bar-warp" data-v-bohr aria-hidden="true"></span>
        <div class="player-left" data-v-bohr>Monsters In The Dark</div>
        <div class="player-center" data-v-bohr><button id="play">▶</button></div>
        <div class="player-right" data-v-bohr>♡  ⇆  ☷</div>
      </div>
      <nav class="settings-preview-nav" data-v-bohr>基础设置<br>播放与音频<br>界面外观</nav>
      <div class="home"><div class="feature-card">玻璃采样</div></div>
      <div class="track-row track-playing" data-v-bohr><button id="row-action">播放歌曲</button></div>
      <div id="defs"></div><script src="bundle/runtime.js"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,nativeImage}=require('electron');const fs=require('node:fs');
app.setPath('userData',require('node:path').join(__dirname,'profile'));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 let win=new BrowserWindow({show:false,width:1100,height:700,webPreferences:{contextIsolation:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>console.error(event.message));
 try{
  await win.loadFile(process.argv.at(-1));
  await win.webContents.executeJavaScript('window.checkNavigationGlassControls()');
  await win.webContents.executeJavaScript('window.runBohrTests()');
  win.webContents.debugger.attach('1.3');
  const captures=[];
  for(const deviceScaleFactor of [1,1.25,1.5,2,2.5,3]){
   win.destroy();
   win=new BrowserWindow({show:false,frame:false,width:1100,height:700,useContentSize:true,webPreferences:{offscreen:{deviceScaleFactor},contextIsolation:false,backgroundThrottling:false}});
   await win.loadFile(process.argv.at(-1));
   win.webContents.debugger.attach('1.3');
   await win.webContents.executeJavaScript('window.runBohrTests()');
   if(Math.abs(await win.webContents.executeJavaScript('devicePixelRatio')-deviceScaleFactor)>.001)throw Error('material backing density differs from requested DPI');
   await win.webContents.executeJavaScript('window.checkPixelRatioUpdate()');
   await win.webContents.executeJavaScript('window.runBohrTests()');
   for(const tone of ['dark','pureWhite'])for(const material of ['regular','glass','liquid']){
    const geometry=await win.webContents.executeJavaScript('window.prepareFullMaterialRaster('+JSON.stringify(tone)+','+JSON.stringify(material)+')');
    // Native Windows client sizes round at fractional display scales. Capture a
    // fixed CSS region so the backing-density assertion does not mix DIP rounding
    // with the offscreen device scale being tested.
    const capture=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,clip:{x:0,y:0,width:1100,height:700,scale:1}});
    const image=nativeImage.createFromBuffer(Buffer.from(capture.data,'base64'));
    const viewport=await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
    const expectedSize={width:Math.round(1100*deviceScaleFactor),height:Math.round(700*deviceScaleFactor)};
    const rasterSize=image.getSize();
    if(Math.abs(rasterSize.width-expectedSize.width)>1||Math.abs(rasterSize.height-expectedSize.height)>1)throw Error('material screenshot did not preserve physical DPI: '+JSON.stringify({density:deviceScaleFactor,viewport,expectedSize,actual:rasterSize}));
    captures.push({deviceScaleFactor,tone,material,geometry,pixels:image.getSize()});
    if(process.env.TE_BOHR_EVIDENCE_DIR)fs.writeFileSync(require('node:path').join(process.env.TE_BOHR_EVIDENCE_DIR,'material-'+tone+'-'+material+'-'+deviceScaleFactor+'.png'),image.toPNG());
   }
  }
  console.error('FULL_MATERIAL_RASTER_OK '+captures.length+' explicit-DPI frames');
  if(process.env.TE_BOHR_EVIDENCE_DIR)fs.writeFileSync(require('node:path').join(process.env.TE_BOHR_EVIDENCE_DIR,'material-raster.json'),JSON.stringify({captures,gpu:app.getGPUFeatureStatus()},null,2));
  await win.webContents.executeJavaScript('window.prepareFullMaterialRaster("dark","liquid")');
  await win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride');
  for(const [name,value] of [['prefers-contrast','more'],['prefers-reduced-transparency','reduce'],['forced-colors','active']]){
   await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name,value}]});
   await win.webContents.executeJavaScript('window.checkBohrAccessibility()');
  }
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
  if(process.env.TE_BOHR_EVIDENCE_DIR){
   for(const tone of ['dark','pureWhite']){
    await win.webContents.executeJavaScript('window.prepareBohrEvidence('+JSON.stringify(tone)+')');
    await new Promise(resolve=>setTimeout(resolve,200));
    fs.writeFileSync(require('node:path').join(process.env.TE_BOHR_EVIDENCE_DIR,'bohr-'+tone+'.png'),Buffer.from((await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true})).data,'base64'));
   }
  }
  await win.webContents.executeJavaScript('window.unmountBohr()');
  console.error('BOHR_MATERIAL_OK');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});`
    )
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 120_000 }
    )
    assert.match(stderr, /BOHR_MATERIAL_OK/)
    assert.match(stderr, /FULL_MATERIAL_RASTER_OK 36 explicit-DPI frames/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {h,render,nextTick} from 'vue'
import LiquidGlassDefs from '@renderer/components/LiquidGlassDefs.vue'
import {resolveRasterSampling,measureSurfaceGeometry} from '@renderer/utils/liquidGlassDisplacement.ts'
const root=document.documentElement
const host=document.getElementById('defs')
const bar=document.querySelector('.player-bar')
const expect=(value,message)=>{if(!value)throw new Error(message)}
const colorPixel=value=>{const context=document.createElement('canvas').getContext('2d');context.fillStyle=value;context.fillRect(0,0,1,1);return context.getImageData(0,0,1,1).data}
const settle=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))}
const mount=async(active)=>{render(h(LiquidGlassDefs,{active}),host);await settle()}
window.checkNavigationGlassControls=async()=>{
 const sidebar=document.createElement('aside')
 sidebar.className='side-menu open';sidebar.setAttribute('data-v-bohr','')
 document.body.append(sidebar)
 const title=document.querySelector('.title-bar'),painter=title.querySelector('.title-bar-background')
 const read=(element,pseudo)=>{const style=getComputedStyle(element,pseudo);return {background:style.backgroundColor,filter:style.backdropFilter}}
 const variables={'--te-lg-context-surface-solid':'#e7edf5','--te-lg-context-material':'#8f9bab','--te-lg-blur':'5px','--te-lg-tint':'.12','--te-lg-saturate':'155%'}
 try{
  for(const tone of ['pureWhite','dark'])for(const source of ['image','solid']){
   root.dataset.theme=tone;root.dataset.teSurfaceMaterial='theme';root.dataset.teLiquidGlassSource=source
   for(const [name,value]of Object.entries(variables))root.style.setProperty(name,value)
   const regularSidebar=read(sidebar),regularTitle=read(painter)
   sidebar.classList.add('side-menu-liquid');title.classList.add('title-bar-liquid');await settle()
   const originalSidebar=read(sidebar,'::before'),originalTitle=read(painter)
   for(const [name,value]of [['sidebar',originalSidebar],['titlebar',originalTitle]]){
    expect(value.filter.includes('blur(5px)')&&value.filter.includes('saturate(1.55)'),name+' receives actual shared blur and saturation: '+value.filter)
    expect(colorPixel(value.background)[3]>0&&colorPixel(value.background)[3]<40,name+' receives the shared twelve-percent tint')
   }
   root.style.setProperty('--te-lg-blur','19px');root.style.setProperty('--te-lg-tint','.52');root.style.setProperty('--te-lg-saturate','190%');await settle()
   const changedSidebar=read(sidebar,'::before'),changedTitle=read(painter)
   for(const [name,original,changed]of [['sidebar',originalSidebar,changedSidebar],['titlebar',originalTitle,changedTitle]]){
    expect(changed.filter.includes('blur(19px)')&&changed.filter.includes('saturate(1.9)'),name+' updates both backdrop parameters')
    expect(changed.background!==original.background&&colorPixel(changed.background)[3]>120,name+' updates the painted tint in '+source+' mode')
   }
   sidebar.classList.remove('side-menu-liquid');title.classList.remove('title-bar-liquid');await settle()
   expect(JSON.stringify(read(sidebar))===JSON.stringify(regularSidebar),'disabling navigation glass restores the local sidebar material independently of shared parameters')
   expect(JSON.stringify(read(painter))===JSON.stringify(regularTitle),'disabling navigation glass restores the local caption material independently of shared parameters')
  }
 }finally{
  sidebar.remove();title.classList.remove('title-bar-liquid');delete root.dataset.teLiquidGlassSource
  for(const name of Object.keys(variables))root.style.removeProperty(name)
 }
}
window.prepareFullMaterialRaster=async(tone,material)=>{
 await window.prepareBohrEvidence(tone)
 bar.className='player-bar'+(material==='liquid'?' player-bar-liquid':material==='glass'?' player-bar-glass':'')
 await settle()
 const r=bar.getBoundingClientRect(),body=getComputedStyle(bar),warp=getComputedStyle(bar.querySelector('.player-bar-warp'))
 const filter=material==='liquid'?warp.backdropFilter:body.backdropFilter
 expect(filter!=='none','complete material probe retains actual backdrop diffusion: '+material)
 if(material==='liquid'){
  expect(filter.includes('te-lg-playbar'),'complete material probe retains the refraction filter')
  expect(warp.backgroundImage==='none','complete material probe has no painted edge sheen')
 }
 return {x:r.x,y:r.y,width:r.width,height:r.height,radius:parseFloat(body.borderTopLeftRadius),filter}
}
window.checkPixelRatioUpdate=async()=>{
 // CDP changes devicePixelRatio without a Windows monitor-change resize event.
 window.dispatchEvent(new Event('resize'))
 await settle()
 await new Promise(resolve=>setTimeout(resolve,250))
 await settle()
 const images=[...document.querySelectorAll('#te-lg-playbar feImage')].slice(0,1)
 expect(images.length===1,'playback filter remains mounted across DPI changes')
 const image=new Image();image.src=images[0].getAttribute('href');await image.decode()
 const density=Math.max(2,Math.min(3,window.devicePixelRatio))
 const raster=resolveRasterSampling(measureSurfaceGeometry(bar),density)
 expect(image.width===raster.width&&image.height===raster.height,'unchanged CSS geometry updates its physical-pixel raster: '+image.width+'x'+image.height+' at '+density)
}
window.runBohrTests=async()=>{
 bar.className='player-bar player-bar-liquid'
 root.setAttribute('data-te-surface-material','liquidGlass')
 root.style.setProperty('--te-lg-specular','0.76')
 await mount(true)
 const barRect=bar.getBoundingClientRect()
 for(const layer of [bar.querySelector('.player-bar-warp')]){
  const r=layer.getBoundingClientRect()
  for(const key of ['x','y','width','height'])expect(Math.abs(r[key]-barRect[key])<.02,'optical layer diverged from outer contour: '+JSON.stringify({dpi:devicePixelRatio,key,bar:barRect[key],layer:r[key]}))
 }
 const button=document.getElementById('play'),rect=button.getBoundingClientRect()
 expect(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)===button,'play target remains above the optical layer: '+JSON.stringify({x:rect.x,y:rect.y,w:rect.width,h:rect.height,hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.outerHTML.slice(0,100)}))
 const row=document.querySelector('.track-row'),outline=getComputedStyle(row,'::after')
 expect(outline.maskImage==='none'&&outline.backgroundImage==='none','playing outline uses one native contour')
 expect(outline.borderTopStyle==='solid'&&parseFloat(outline.borderTopWidth)>0&&parseFloat(outline.borderTopWidth)<=1,'playing state retains a visible border')
 const rowButton=document.getElementById('row-action'),rowRect=rowButton.getBoundingClientRect()
 expect(document.elementFromPoint(rowRect.x+rowRect.width/2,rowRect.y+rowRect.height/2)===rowButton,'row outline never covers or intercepts its actions: '+JSON.stringify({rect:[rowRect.x,rowRect.y,rowRect.width,rowRect.height],hit:document.elementFromPoint(rowRect.x+rowRect.width/2,rowRect.y+rowRect.height/2)?.outerHTML.slice(0,140)}))
 row.classList.add('track-selected')
 expect(getComputedStyle(row,'::after').opacity==='1','selected playing row retains its outline')
 row.classList.remove('track-selected')
 const geometry=bar.getBoundingClientRect()
 await mount(false)
 expect(!root.style.getPropertyValue('--te-bohr-playbar-specular-map'),'disabled material releases the raster reference')
 expect(!root.style.getPropertyValue('--te-bohr-playbar-specular-strength'),'disabled material has no residual highlight')
 await mount(true)
 root.style.setProperty('--te-lg-specular','0')
 window.dispatchEvent(new Event('twilight:liquid-glass-tuning-changed'))
 await settle()
 expect(getComputedStyle(bar.querySelector('.player-bar-warp')).backgroundImage==='none','light settings cannot bring back a painted player rim')
 for(const tone of ['pureWhite','dark']){
  root.setAttribute('data-theme',tone)
  expect(getComputedStyle(document.querySelector('.title-bar-background')).boxShadow==='none','caption material has no dark separator')
  const shadow=getComputedStyle(bar).boxShadow
  const shadowColor=shadow.match(/(?:rgba?|color)[(][^)]+[)]/)?.[0]
  expect(Boolean(shadowColor),'cast shadow retains a real paint color: '+shadow)
  const components=shadowColor.match(/[0-9.]+/g).map(Number)
  const channels=components.slice(0,3).map(value=>shadowColor.startsWith('color(srgb')?value*255:value)
  const expectedChannels=tone==='dark'?[0,0,0]:[18,24,32]
  expect(channels.every((value,index)=>Math.abs(value-expectedChannels[index])<.01),'cast shadow keeps the local dark neutral substrate in each tone: '+shadow+' '+JSON.stringify({dpi:devicePixelRatio,tone,className:bar.className}))
  expect(Math.abs(components[3]-(tone==='dark'?.2:.08))<.001,'elevation strength follows theme tone: '+shadow)
  const after=bar.getBoundingClientRect()
  expect(after.height===geometry.height&&after.width===geometry.width,'material does not change bar geometry')
 }
 for(const disabled of ['class','data-te-effects-mode']){
  if(disabled==='class')document.body.classList.add('te-no-blur');else root.setAttribute(disabled,'reduced')
  window.checkBohrAccessibility()
  if(disabled==='class')document.body.classList.remove('te-no-blur');else root.removeAttribute(disabled)
 }
 root.setAttribute('data-te-surface-material','transparent')
 expect(getComputedStyle(document.querySelector('.player-bar-warp')).display==='none','transparent material removes refraction')
 expect(getComputedStyle(bar).boxShadow==='none','transparent material removes elevation')
 expect(bar.getBoundingClientRect().height===geometry.height,'transparent material preserves controls and layout')
 root.setAttribute('data-te-surface-material','liquidGlass')
 expect(getComputedStyle(bar.querySelector('.player-bar-warp')).display!=='none','switching back restores transmission without edge lighting')
}
window.checkBohrAccessibility=()=>expect(getComputedStyle(bar.querySelector('.player-bar-warp')).backdropFilter==='none','accessibility disables backdrop effects')
window.prepareBohrEvidence=async(tone)=>{
 root.setAttribute('data-theme',tone)
 document.body.style.background=tone==='dark'?'#17181a':'#f4f4f7'
 document.body.style.color=tone==='dark'?'#eeeeee':'#181a20'
 root.style.setProperty('--te-lg-specular','0.76')
 window.dispatchEvent(new Event('twilight:liquid-glass-tuning-changed'))
 await mount(true)
}
window.unmountBohr=async()=>{
 render(null,host);await settle()
 expect(!root.style.getPropertyValue('--te-bohr-playbar-specular-map'),'unmount releases the raster reference')
 expect(!root.style.getPropertyValue('--te-bohr-playbar-specular-strength'),'unmount releases reflection strength')
}
`
