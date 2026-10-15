import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle } from '@vue/compiler-sfc'
import { cardCssVariables, defaultCardTheme } from '../../../shared/appAppearance.ts'

const require = createRequire(import.meta.url)

test('homepage cards share optional skin material while preserving layout rules and artwork', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-home-material-'))
  try {
    const styles = await Promise.all(
      ['base.css', 'appearance.css', 'materials.css'].map((name) =>
        readFile(resolve('src/renderer/src/assets', name), 'utf8')
      )
    )
    const home = compileStyle({
      source: await readFile(
        resolve('src/renderer/src/components/local-dashboard/OnlineHome.css'),
        'utf8'
      ),
      filename: 'OnlineHome.css',
      scoped: true,
      id: 'data-v-home-material'
    })
    assert.deepEqual(home.errors, [])
    const profiles = Object.fromEntries(
      ['light', 'dark'].map((tone) => [
        tone,
        cardCssVariables({
          ...defaultCardTheme(tone as 'light' | 'dark'),
          backgroundColor: '#254e77',
          backgroundOpacity: 100,
          borderColor: '#9a6842',
          borderOpacity: 100,
          borderWidth: 2,
          borderRadius: 23,
          hoverEffect: 'lift'
        })
      ])
    )
    await writeFile(join(directory, 'profiles.json'), JSON.stringify(profiles))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8"><style>
      ${styles.join('\n')}\n${home.code}
      .online-home{height:auto}.fixture{display:flex;gap:20px;padding:30px}
      #hero{width:420px;min-height:220px}#playlist,#local,#disabled{width:150px}
      #art{background-image:linear-gradient(red,blue)}
      </style></head><body><main class="online-home" data-v-home-material><div class="fixture">
      <section id="hero" class="online-hero" data-v-home-material><div class="online-hero-copy" data-v-home-material><h2 id="title" data-v-home-material>Sample track</h2><p id="artist" class="online-hero-description" data-v-home-material>Sample artist</p><button id="action" class="online-primary" data-v-home-material>Play</button></div></section>
      <button id="playlist" class="online-playlist" data-v-home-material><span id="art" class="online-playlist-cover" data-v-home-material><span id="online-play" class="online-playlist-play" data-v-home-material>▶</span></span><strong data-v-home-material>Online collection</strong></button>
      <button id="local" class="online-playlist home-local-card" data-v-home-material><span class="online-playlist-cover home-local-art" data-v-home-material><svg id="local-play" class="playback-icon" data-v-home-material viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 4 20 12 6 20Z" /></svg></span><strong data-v-home-material>Local collection</strong></button>
      <button id="disabled" class="online-playlist" disabled data-v-home-material>Unavailable</button>
      </div></main><span id="hover-probe" style="display:none;background:var(--te-library-row-hover)"></span></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, env }
    )
    assert.match(stderr, /HOME_MATERIAL_OK 8 tone\/material combinations; 8 text variants/)
    context.diagnostic(stderr.match(/HOME_MATERIAL_OK[^\r\n]*/)?.[0] ?? '')
  } finally {
    assert.equal(resolve(directory, '..'), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const profiles=require('./profiles.json');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:700,webPreferences:{offscreen:true,backgroundThrottling:false}});
 try{
  await win.loadFile(process.argv.at(-1));
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('DOM.enable');await win.webContents.debugger.sendCommand('CSS.enable');
  const {root}=await win.webContents.debugger.sendCommand('DOM.getDocument');
  const run=code=>win.webContents.executeJavaScript(code);
  const force=async(id,pseudo)=>{const {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'#'+id});await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:pseudo})};
  const snapshot=id=>run('(()=>{const el=document.getElementById('+JSON.stringify(id)+'),s=getComputedStyle(el),r=el.getBoundingClientRect();return {background:s.backgroundColor,image:s.backgroundImage,border:s.borderTopColor,borderWidth:s.borderTopWidth,radius:s.borderRadius,shadow:s.boxShadow,backdrop:s.backdropFilter,transform:s.transform,color:s.color,outline:[s.outlineStyle,s.outlineWidth],size:[r.width,r.height]}})()');
  const luminance=color=>color.match(/[\\d.]+/g).slice(0,3).map(Number).map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const contrast=(a,b)=>{const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05)};
  let combinations=0,textVariants=0,minContrast=Infinity;
  for(const tone of ['pureWhite','dark'])for(const material of ['standard','frosted','liquidGlass','transparent']){
   await run('document.documentElement.dataset.theme='+JSON.stringify(tone)+';document.documentElement.dataset.teSurfaceMaterial='+JSON.stringify(material));
   const defaults=Object.fromEntries(await Promise.all(['hero','playlist','local','disabled','art','action'].map(async id=>[id,await snapshot(id)])));
   await run('document.documentElement.dataset.teCardCustom="on";for(const [key,value] of Object.entries('+JSON.stringify(profiles[tone==='dark'?'dark':'light'])+'))document.documentElement.style.setProperty(key,value)');
   const artwork=await snapshot('art'),action=await snapshot('action');
   assert.equal(artwork.image,defaults.art.image,'card material replaces artwork image');assert.equal(artwork.radius,defaults.art.radius,'card radius leaks into artwork');assert.equal(artwork.borderWidth,defaults.art.borderWidth,'card border leaks into artwork');assert.ok(artwork.size.every((value,index)=>Math.abs(value-defaults.art.size[index])<=4),'artwork changes beyond the explicit outer border width');
   assert.equal(action.radius,defaults.action.radius,'card skin changes nested play button geometry');
   for(const id of ['hero','playlist','local','disabled']){
    const card=await snapshot(id);assert.equal(card.size[0],defaults[id].size[0],'skin changes '+id+' width');assert.ok(Math.abs(card.size[1]-defaults[id].size[1])<=4,'skin changes '+id+' height beyond its explicit border width');
    if(material==='transparent'){assert.equal(card.background,'rgba(0, 0, 0, 0)');assert.equal(card.image,'none');assert.equal(card.backdrop,'none');assert.equal(card.shadow,'none');assert.equal(card.border,'rgba(0, 0, 0, 0)')}
    else{assert.equal(card.background,'rgb(37, 78, 119)');assert.equal(card.image,'none');assert.equal(card.border,'rgb(154, 104, 66)');assert.equal(card.borderWidth,'2px');assert.equal(card.radius,'23px');assert.match(card.backdrop,/blur\\(20px\\)/)}
    await force(id,['hover']);const hover=await snapshot(id);
    if(id==='hero'||id==='disabled')assert.deepEqual(hover,card,'noninteractive or disabled '+id+' gets action feedback');
    else if(material==='transparent'){assert.equal(hover.transform,'none');assert.equal(hover.backdrop,'none');assert.equal(hover.shadow,'none');assert.equal(hover.background,(await snapshot('hover-probe')).background)}
    else assert.notEqual(hover.transform,'none','explicit lift lost on '+id);
    await force(id,[]);
   }
   await force('playlist',['focus-visible']);assert.deepEqual((await snapshot('playlist')).outline,['solid','2px']);await force('playlist',[]);
   await run('delete document.documentElement.dataset.teCardCustom;for(const key of Object.keys('+JSON.stringify(profiles[tone==='dark'?'dark':'light'])+'))document.documentElement.style.removeProperty(key)');
   for(const id of ['hero','playlist','local','disabled','art','action'])assert.deepEqual(await snapshot(id),defaults[id],'turning skin off does not restore '+id);
   if(material==='standard')for(const textTone of ['light','dark'])for(const custom of [false,true]){
    if(custom)await run('document.documentElement.dataset.teCardCustom="on";for(const [key,value] of Object.entries('+JSON.stringify(profiles[tone==='dark'?'dark':'light'])+'))document.documentElement.style.setProperty(key,value)');
    const ink=textTone==='light'?'rgb(243, 244, 245)':'rgb(24, 25, 26)',muted=textTone==='light'?'rgb(198, 199, 200)':'rgb(78, 79, 80)';
    await run('document.documentElement.dataset.teLocalTextTone='+JSON.stringify(textTone)+';document.documentElement.style.setProperty("--te-local-background-text",'+JSON.stringify(ink)+');document.documentElement.style.setProperty("--te-local-background-muted",'+JSON.stringify(muted)+')');
    assert.equal((await snapshot('title')).color,ink);assert.equal((await snapshot('artist')).color,muted);const action=await snapshot('action');const actionContrast=contrast(action.background,action.color);minContrast=Math.min(minContrast,actionContrast);assert.ok(actionContrast>=4.5,'background text tone makes primary action unreadable: '+JSON.stringify(action));assert.deepEqual(action.size,defaults.action.size);textVariants++;
    for(const [badge,parent] of [['online-play','playlist'],['local-play','local']]){const resting=await snapshot(badge);const restingContrast=contrast(resting.background,resting.color);minContrast=Math.min(minContrast,restingContrast);assert.ok(restingContrast>=4.5,'background text tone hides '+badge);await force(parent,['hover']);const hovered=await snapshot(badge);const hoverContrast=contrast(hovered.background,hovered.color);minContrast=Math.min(minContrast,hoverContrast);assert.ok(hoverContrast>=4.5,'hover hides '+badge);await force(parent,[])}
    await run('delete document.documentElement.dataset.teLocalTextTone;document.documentElement.style.removeProperty("--te-local-background-text");document.documentElement.style.removeProperty("--te-local-background-muted")');
    if(custom)await run('delete document.documentElement.dataset.teCardCustom;for(const key of Object.keys('+JSON.stringify(profiles[tone==='dark'?'dark':'light'])+'))document.documentElement.style.removeProperty(key)');
   }
   combinations++;
  }
  console.error('HOME_MATERIAL_OK '+combinations+' tone/material combinations; '+textVariants+' text variants; 40 contrast probes; minimum '+minContrast.toFixed(2)+':1');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});`
