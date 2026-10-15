import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { cardCssVariables, defaultCardTheme } from '../../../shared/appAppearance.ts'

const require = createRequire(import.meta.url)

test('card hover stays distinct from focus and selection without inverted or duplicate shadows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-card-feedback-'))
  try {
    const globalPaths = [
      'assets/base.css',
      'assets/appearance.css',
      'assets/materials.css',
      'assets/bohr.css',
      'components/onboarding/OnboardingWizard.css'
    ]
    const scopedPaths = [
      'components/song-list/SongList.css',
      'components/LocalDashboard.css',
      'components/StreamingHome.vue',
      'components/settings-page/SettingsPage.css',
      'components/SettingsPage.vue'
    ]
    const globalStyles = await Promise.all(
      globalPaths.map((path) => readFile(resolve('src/renderer/src', path), 'utf8'))
    )
    const scopedStyles = await Promise.all(
      scopedPaths.map(async (path) => {
        const source = await readFile(resolve('src/renderer/src', path), 'utf8')
        const css = path.endsWith('.vue')
          ? parse(source)
              .descriptor.styles.map((style) => style.content)
              .join('\n')
          : source
        const compiled = compileStyle({
          source: css,
          filename: path,
          scoped: true,
          id: 'data-v-feedback'
        })
        assert.deepEqual(compiled.errors, [])
        return compiled.code
      })
    )
    const profiles = Object.fromEntries(
      ['light', 'dark'].map((tone) => [
        tone,
        Object.fromEntries(
          ['none', 'glow', 'lift'].map((hoverEffect) => [
            hoverEffect,
            cardCssVariables({
              ...defaultCardTheme(tone as 'light' | 'dark'),
              shadowStrength: 'medium',
              glassHighlight: false,
              hoverEffect: hoverEffect as 'none' | 'glow' | 'lift'
            })
          ])
        )
      ])
    )
    await writeFile(join(directory, 'profiles.json'), JSON.stringify(profiles))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8"><style>${globalStyles.join('\n')}\n${scopedStyles.join('\n')}
      body{padding:30px}.fixture{display:flex;gap:24px}.home,.home-view,.onboarding-wizard{position:static;width:220px;height:auto;overflow:visible;padding:0;background:none}
      .artist-card,.playlist-card{width:180px;height:240px}.gallery-tile,.shelf-tile{width:180px}.gallery-cover,.shelf-cover{height:180px}
      .feature-card,.chart-card,.device-card,.onb-card{width:180px;min-height:80px}.settings-preview-page{position:static}
      </style></head><body><main class="fixture">
      <button id="library" class="artist-card" data-v-feedback>Artist</button>
      <button id="create" class="playlist-card create-playlist-card" data-v-feedback>Create playlist</button>
      <button id="disabled" class="playlist-card" data-v-feedback disabled>Disabled</button>
      <article id="panel" class="chart-card" data-v-feedback>Read only</article>
      <div class="home" data-v-feedback><button id="gallery" class="gallery-tile" data-v-feedback><div id="gallery-cover" class="gallery-cover" data-v-feedback><div class="gallery-scrim" data-v-feedback></div><span id="gallery-action" class="gallery-play" data-v-feedback>Play</span></div></button></div>
      <div class="home-view" data-v-feedback><button id="shelf" class="shelf-tile" data-v-feedback><div id="shelf-cover" class="shelf-cover" data-v-feedback><span class="shelf-open" data-v-feedback>Open</span></div></button><button id="primary" class="hero-play" data-v-feedback>Play all</button></div>
      <div class="settings-preview-page" data-v-feedback><button id="device" class="device-card active" data-v-feedback aria-pressed="true">Device</button><button id="other-device" class="device-card" data-v-feedback>Other</button></div>
      <div class="onboarding-wizard"><button id="choice" class="onb-card is-selected" aria-checked="true" role="radio"><span class="onb-card-check">✓</span>Choice</button><button id="other-choice" class="onb-card" role="radio">Other</button></div>
      </main></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, env }
    )
    assert.match(stderr, /CARD_FEEDBACK_OK/)
  } finally {
    assert.equal(resolve(directory, '..'), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
const profiles=require('./profiles.json');
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1400,height:700,webPreferences:{offscreen:true,backgroundThrottling:false}});
 try{
  await win.loadFile(process.argv.at(-1));
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('DOM.enable');await win.webContents.debugger.sendCommand('CSS.enable');
  const {root}=await win.webContents.debugger.sendCommand('DOM.getDocument');
  const run=code=>win.webContents.executeJavaScript(code);
  const force=async(id,pseudo)=>{const {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'#'+id});await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:pseudo})};
  const snapshot=id=>run('(()=>{const el=document.getElementById('+JSON.stringify(id)+'),s=getComputedStyle(el),r=el.getBoundingClientRect();return {shadow:s.boxShadow,transform:s.transform,backdrop:s.backdropFilter,background:s.backgroundColor,opacity:s.opacity,outline:[s.outlineStyle,s.outlineWidth],rect:[r.x,r.y,r.width,r.height]}})()');
  const darkShadow=shadow=>{
   const colors=[...shadow.matchAll(/rgba?\\(([\\d.]+), ([\\d.]+), ([\\d.]+)/g)].map(m=>m.slice(1,4).map(Number));
   colors.push(...[...shadow.matchAll(/color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)/g)].map(m=>m.slice(1,4).map(v=>Number(v)*255)));
   assert.ok(colors.length>0,'unrecognized shadow: '+shadow);for(const color of colors)assert.ok(Math.max(...color)<45,'cast shadow becomes a light glow: '+shadow);
  };
  let combinations=0;
  for(const tone of ['pureWhite','dark'])for(const material of ['standard','frosted','liquidGlass']){
   await run('document.documentElement.dataset.theme='+JSON.stringify(tone)+';document.documentElement.dataset.teSurfaceMaterial='+JSON.stringify(material));
   const before=await snapshot('library');await force('library',['hover']);const hover=await snapshot('library');
   assert.deepEqual(hover.rect,before.rect,'default card hover changes geometry');assert.equal(hover.shadow,'none');assert.equal(hover.backdrop,'none');
   await force('library',['focus-visible']);const focus=await snapshot('library');assert.deepEqual(focus.outline,['solid','2px']);assert.equal(focus.shadow,'none');await force('library',[]);
   const create=await snapshot('create');await force('create',['hover']);const createHover=await snapshot('create');assert.deepEqual(createHover.rect,create.rect);assert.equal(createHover.shadow,'none');await force('create',[]);
   for(const [tile,cover] of [['gallery','gallery-cover'],['shelf','shelf-cover']]){
    const resting=await snapshot(cover);if(tile==='shelf')assert.equal(resting.shadow,'none','streaming artwork should stay flat');else darkShadow(resting.shadow);await force(tile,['hover']);const hovered=await snapshot(cover);
    assert.deepEqual(hovered.rect,resting.rect,'artwork moves on hover');assert.equal(hovered.shadow,resting.shadow,'artwork hover adds elevation');
    await force(tile,['focus-visible']);assert.equal(await run('getComputedStyle(document.querySelector("#'+tile+' .'+(tile==='gallery'?'gallery-play':'shelf-open')+'")).opacity'),'1','keyboard focus hides the action');await force(tile,[]);
   }
   assert.equal((await snapshot('primary')).shadow,'none','streaming action should stay flat');darkShadow((await snapshot('gallery-action')).shadow);
   for(const [selected,other] of [['device','other-device'],['choice','other-choice']]){
    const resting=await snapshot(selected);await force(other,['hover']);const hovered=await snapshot(other);
    assert.notEqual(hovered.background,resting.background,'hover is indistinguishable from selection');assert.equal(hovered.shadow,resting.shadow,'selection adds decorative glow');await force(other,[]);
   }
   const toneProfiles=profiles[tone==='dark'?'dark':'light'];
   for(const effect of ['none','glow','lift']){
    await run('document.documentElement.dataset.teCardCustom="on";for(const [key,value] of Object.entries('+JSON.stringify(toneProfiles[effect])+'))document.documentElement.style.setProperty(key,value)');
    const panel=await snapshot('panel'),disabled=await snapshot('disabled'),card=await snapshot('library');
    await force('panel',['hover']);assert.deepEqual(await snapshot('panel'),panel,'read-only panel adopts an action effect');await force('panel',[]);
    await force('disabled',['hover']);assert.deepEqual(await snapshot('disabled'),disabled,'disabled card reacts to hover');await force('disabled',[]);
    await force('library',['hover']);const hovered=await snapshot('library');
    if(effect==='none'){assert.equal(hovered.shadow,card.shadow,'no hover setting paints a duplicate shadow');assert.equal(hovered.transform,'none')}
    if(effect==='glow'){assert.notEqual(hovered.shadow,card.shadow,'explicit custom glow was lost');assert.equal(hovered.transform,'none')}
    if(effect==='lift')assert.notEqual(hovered.transform,'none','explicit custom lift was lost');
    await force('library',[]);await run('delete document.documentElement.dataset.teCardCustom;for(const key of Object.keys('+JSON.stringify(toneProfiles[effect])+'))document.documentElement.style.removeProperty(key)');
   }
   combinations++;
  }
  console.error('CARD_FEEDBACK_OK '+combinations+' theme/material combinations');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}
});`
