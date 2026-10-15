import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../../../../../', import.meta.url))

test('playbar body and artwork use single pixel coverage across DPI', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-contour-'))
  try {
    const source = await readFile(
      process.env.TE_CONTOUR_BASELINE ??
        join(root, 'src/renderer/src/components/player-bar/PlayerBar.css'),
      'utf8'
    )
    const style = compileStyle({
      source,
      filename: 'PlayerBar.css',
      id: 'data-v-contour',
      scoped: true
    })
    assert.deepEqual(style.errors, [])
    const global =
      (await readFile(join(root, 'src/renderer/src/assets/base.css'), 'utf8')) +
      (await readFile(join(root, 'src/renderer/src/assets/materials.css'), 'utf8')) +
      (await readFile(join(root, 'src/renderer/src/assets/bohr.css'), 'utf8'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-platform="win32"><style>
      ${global}\n${style.code}
      *,*::before,*::after{transition:none!important}
      html,body{margin:0;background:black!important}
      .player-bar[data-v-contour]{position:absolute;left:7px;top:28px;width:1088px;max-width:none;height:72px;
        background:white!important;border-color:transparent!important;box-shadow:none!important;backdrop-filter:none!important}
      .player-bar-warp[data-v-contour]{background:transparent!important;backdrop-filter:none!important}
      .player-cover-slot[data-v-contour]{position:absolute;left:7px;top:128px;background:transparent!important;
        --te-standard-cover-size:52px;--te-standard-cover-radius:10px}
      .player-cover[data-v-contour]{box-shadow:none!important;filter:none!important;transform:none!important}
      .reference{position:absolute;box-sizing:border-box;visibility:hidden;pointer-events:none}
      .reference-mode .player-bar,.reference-mode .player-cover-slot{visibility:hidden!important}
      .reference-mode .reference{visibility:visible}
      #reference-bar{background:white}
      #reference-cover{overflow:hidden}
      #reference-cover img{display:block;width:100%;height:100%;border-radius:0}
      .cover-hover .player-cover-slot .player-cover,.cover-hover #reference-cover img{transform:translateY(-2px) scale(1.05)!important}
      </style><body><div class="player-bar" data-v-contour>
      </div><div class="player-cover-slot" data-v-contour>
        <img class="player-cover" data-v-contour src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='52' height='52'%3E%3Cpath fill='white' d='M0 0h52v52H0z'/%3E%3C/svg%3E">
      </div><div class="reference" id="reference-bar"></div><div class="reference" id="reference-cover"></div>
      <script>document.getElementById('reference-cover').append(document.querySelector('.player-cover').cloneNode());</script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs')],
      {
        env,
        windowsHide: true,
        timeout: 90_000
      }
    )
    assert.match(result.stdout, /CONTOUR_PIXEL_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `const {app,BrowserWindow,nativeImage}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const sdf=(x,y,w,h,r)=>{const qx=Math.abs(x)-w/2+r,qy=Math.abs(y)-h/2+r;return Math.min(Math.max(qx,qy),0)+Math.hypot(Math.max(qx,0),Math.max(qy,0))-r};
function checkPixels(image,reference,box,density,ring,label){
 const size=image.getSize(),pixels=image.toBitmap(),expected=reference.toBitmap();
 const errors=[];
 for(const right of [false,true])for(const bottom of [false,true]){
  let sum=0,count=0,max=0;
  const x0=right?box.x+box.width-box.radius-1:box.x-1,y0=bottom?box.y+box.height-box.radius-1:box.y-1;
  for(let y=Math.max(0,Math.floor(y0*density));y<Math.min(size.height,Math.ceil((y0+box.radius+2)*density));y++){
   for(let x=Math.max(0,Math.floor(x0*density));x<Math.min(size.width,Math.ceil((x0+box.radius+2)*density));x++){
    const px=(x+.5)/density-box.x-box.width/2,py=(y+.5)/density-box.y-box.height/2;
    const outer=sdf(px,py,box.width,box.height,box.radius);
    const inner=sdf(px,py,box.width-2,box.height-2,box.radius-1);
    if(Math.abs(outer)>1.5/density&&(!ring||Math.abs(inner)>1.5/density))continue;
    const index=(y*size.width+x)*4;
    const error=Math.abs(pixels[index]-expected[index]);sum+=error;count++;max=Math.max(max,error);
   }
  }
  const mean=sum/count;
  if(!count||mean>3.5||max>18)throw Error(label+' coverage differs from the single-contour reference: '+JSON.stringify({density,right,bottom,count,mean,max}));
  errors.push({right,bottom,mean,max});
 }
 return errors;
}
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 let win;
 const loadDensity=async(density)=>{
  win?.destroy();
  win=new BrowserWindow({show:false,frame:false,width:1112,height:210,useContentSize:true,webPreferences:{offscreen:{deviceScaleFactor:density},backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'index.html'));win.webContents.debugger.attach('1.3');
  if(Math.abs(await win.webContents.executeJavaScript('devicePixelRatio')-density)>.001)throw Error('renderer backing density differs from requested DPI');
 };
 try{
  const results=[];
  for(const density of [1,1.25,1.5,2,2.5,3]){
   await loadDensity(density);
   for(const tone of ['dark','pureWhite'])for(const material of ['regular','glass','liquid'])for(const offset of [0,.375])for(const hover of [false,true]){
    await win.webContents.executeJavaScript('document.body.classList.toggle("cover-hover",'+hover+')');
    const boxes=await win.webContents.executeJavaScript('(()=>{const tone='+JSON.stringify(tone)+',material='+JSON.stringify(material)+',offset='+offset+';document.documentElement.dataset.theme=tone;const bar=document.querySelector(".player-bar");bar.className="player-bar"+(material==="glass"?" player-bar-glass":material==="liquid"?" player-bar-liquid":"");bar.style.left=(7+offset)+"px";bar.style.top=(28+offset)+"px";const cover=document.querySelector(".player-cover-slot");cover.style.left=(7+offset)+"px";cover.style.top=(128+offset)+"px";const box=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,radius:parseFloat(getComputedStyle(element).borderTopLeftRadius)}};return{bar:box(document.querySelector(".player-bar")),cover:box(cover)}})()');
    await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const screenshot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,clip:{x:0,y:0,width:1112,height:210,scale:1}});
    const image=nativeImage.createFromBuffer(Buffer.from(screenshot.data,'base64'));
    const viewport=await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
    const expectedSize={width:Math.round(1112*density),height:Math.round(210*density)};
    const rasterSize=image.getSize();
    if(Math.abs(rasterSize.width-expectedSize.width)>1||Math.abs(rasterSize.height-expectedSize.height)>1)throw Error('pixel probe did not capture the physical DPI raster: '+JSON.stringify({density:density,viewport,expectedSize,actual:rasterSize}));
    if(process.env.TE_CONTOUR_EVIDENCE_DIR){fs.writeFileSync(path.join(process.env.TE_CONTOUR_EVIDENCE_DIR,'contour-latest.png'),image.toPNG());fs.writeFileSync(path.join(process.env.TE_CONTOUR_EVIDENCE_DIR,'contour-latest-boxes.json'),JSON.stringify({density,tone,material,offset,boxes}));}
    // Use Chromium's single native rounded contour as the reference. It accounts
    // for border pixel snapping at fractional heights and fractional placement.
    await win.webContents.executeJavaScript('(()=>{const boxes='+JSON.stringify(boxes)+';for(const name of ["bar","cover"]){const b=boxes[name],style=document.getElementById("reference-"+name).style;style.left=b.x+"px";style.top=b.y+"px";style.width=b.width+"px";style.height=b.height+"px";style.borderRadius=b.radius+"px";}document.body.classList.add("reference-mode");return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()');
    const referenceScreenshot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true,clip:{x:0,y:0,width:1112,height:210,scale:1}});
    const reference=nativeImage.createFromBuffer(Buffer.from(referenceScreenshot.data,'base64'));
    results.push({density,tone,material,offset,hover,bar:checkPixels(image,reference,boxes.bar,density,false,'playbar '+material+' offset '+offset),cover:checkPixels(image,reference,boxes.cover,density,false,'artwork hover '+hover)});
    await win.webContents.executeJavaScript('document.body.classList.remove("reference-mode")');
   }
  }
  console.log('CONTOUR_PIXEL_OK '+results.length+' cases, four corners each');
  if(process.env.TE_CONTOUR_EVIDENCE_DIR)fs.writeFileSync(path.join(process.env.TE_CONTOUR_EVIDENCE_DIR,'contour-pixels.json'),JSON.stringify(results,null,2));
  app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});`
