import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'
import { THEME_ICON_SLOTS } from '../../../shared/theme.ts'

const require = createRequire(import.meta.url)
const { build: buildNode } = createRequire(require.resolve('vite/package.json'))('esbuild')

test('real theme icons retain default shapes, image alpha, state, fallback and isolated satellite updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-theme-icons-'))
  try {
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    // Previous native paths and style are an independent default-geometry oracle.
    for (const [file, component] of Object.entries(defaultComponentSnapshots))
      await writeFile(join(directory, file), component)
    await writeFile(
      join(directory, 'entry.ts'),
      fixture
        .replaceAll('__RENDERER__', renderer)
        .replace('__ICON_TEMPLATE__', JSON.stringify(iconTemplate))
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: directory,
      plugins: [vue()],
      resolve: {
        alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js'), '@renderer': renderer }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'IconProbe',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>html,body{margin:0;background:#102030;color:#eef1f4;font:14px sans-serif}#app{padding:20px}button{display:inline-flex;align-items:center;justify-content:center;width:60px;height:44px;margin:4px;padding:0;border:0;color:inherit;background:transparent;font-size:24px}button:focus-visible{outline:2px solid #fff}.row{display:flex;align-items:center;gap:12px;min-height:60px}.gallery{display:grid;grid-template-columns:repeat(16,28px);gap:4px;margin-top:20px}.sample{font-size:24px}a{color:inherit} .mini-glyph{font-size:24px}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await buildNode({
      stdin: {
        contents: `export {importThemeAsset,resolveThemeAssetFile} from ${JSON.stringify(resolve('src/main/themes/themeArchive.ts'))}`,
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: join(directory, 'assets.cjs')
    })
    const PNG = require('pngjs').PNG
    for (const [name, color] of [
      ['pink', [240, 32, 96]],
      ['blue', [32, 160, 240]],
      ['slow', [40, 230, 90]]
    ] as const) {
      const image = new PNG({ width: 24, height: 24 })
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++)
          image.data.set([...color, x < 8 ? 0 : x < 16 ? 128 : 255], (y * image.width + x) * 4)
      await writeFile(join(directory, `${name}.png`), PNG.sync.write(image))
    }
    await writeFile(join(directory, 'bad.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 }
    )
    const evidence = JSON.parse(result.stdout.match(/THEME_ICONS_RESULT (.*)/)![1])
    assert.equal(evidence.networkRequests, 0)
    assert.equal(evidence.defaultMatrices.length, 18)
    assert.equal(evidence.slots, THEME_ICON_SLOTS.length)
    const capture = PNG.sync.read(await readFile(join(directory, 'alpha.png')))
    const expected = [
      [16, 32, 48, 255],
      [128, 32, 72, 255],
      [240, 32, 96, 255]
    ]
    evidence.pixels = evidence.samples.map((point: { x: number; y: number }, index: number) => {
      const x = Math.floor((point.x * capture.width) / evidence.viewport.width)
      const y = Math.floor((point.y * capture.height) / evidence.viewport.height)
      const actual = [
        ...capture.data.subarray((y * capture.width + x) * 4, (y * capture.width + x) * 4 + 4)
      ]
      for (let channel = 0; channel < 4; channel++)
        assert.ok(
          Math.abs(actual[channel] - expected[index][channel]) <= 2,
          `PNG alpha ${index}: expected ${expected[index]}, actual ${actual}`
        )
      return { expected: expected[index], actual }
    })
    const reportDirectory = process.env.TWILIGHT_ICON_REPORT_DIR
    if (reportDirectory) {
      await mkdir(reportDirectory, { recursive: true })
      await writeFile(
        join(reportDirectory, 'icons-core-render-result.json'),
        JSON.stringify(evidence, null, 2) + '\n'
      )
      await writeFile(
        join(reportDirectory, 'icons-core-alpha.png'),
        await readFile(join(directory, 'alpha.png'))
      )
    }
    console.log(`THEME_ICONS_RESULT ${JSON.stringify(evidence)}`)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-theme-icons-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const defaultComponentSnapshots = {
  'BaselinePlayback.vue':
    '<script setup lang="ts">\ndefineProps<{\n  name: \'play\' | \'pause\' | \'previous\' | \'next\'\n}>()\n</script>\n\n<template>\n  <svg\n    class="playback-icon"\n    :data-playback-icon="name"\n    viewBox="0 0 24 24"\n    fill="currentColor"\n    aria-hidden="true"\n  >\n    <g v-if="name === \'play\'" transform="scale(0.046875)">\n      <path\n        d="M133 440a35.37 35.37 0 0 1-17.5-4.67c-12-6.8-19.46-20-19.46-34.33V111c0-14.37 7.46-27.53 19.46-34.33a35.13 35.13 0 0 1 35.77.45l247.85 148.36a36 36 0 0 1 0 61l-247.89 148.4A35.5 35.5 0 0 1 133 440"\n      />\n    </g>\n    <template v-else-if="name === \'pause\'">\n      <rect x="6" y="3" width="4" height="18" rx="1" />\n      <rect x="14" y="3" width="4" height="18" rx="1" />\n    </template>\n    <g v-else :transform="name === \'previous\' ? \'translate(24 0) scale(-1 1)\' : undefined">\n      <path\n        d="M4.6 6.1v11.8c0 .78.86 1.26 1.52.84l8.95-5.9a1 1 0 0 0 0-1.68L6.12 5.26c-.66-.42-1.52.06-1.52.84Z"\n      />\n      <rect x="16.8" y="5.2" width="2.6" height="13.6" rx="1.3" />\n    </g>\n  </svg>\n</template>\n\n<style scoped>\n.playback-icon {\n  display: inline-block;\n  vertical-align: -0.125em;\n  pointer-events: none;\n  width: 1em;\n  height: 1em;\n  flex-shrink: 0;\n}\n</style>\n',
  'BaselineControl.vue':
    '<script setup lang="ts">\ndefineProps<{\n  name: \'volume\' | \'muted\' | \'queue\' | \'hifi\' | \'equalizer\' | \'miniPlayer\' | \'favorite\'\n  filled?: boolean\n}>()\n</script>\n\n<template>\n  <svg\n    class="player-control-icon"\n    viewBox="0 0 24 24"\n    fill="none"\n    stroke="currentColor"\n    stroke-width="1.8"\n    stroke-linecap="round"\n    stroke-linejoin="round"\n    aria-hidden="true"\n  >\n    <template v-if="name === \'volume\' || name === \'muted\'">\n      <path d="M11 5 6 9H3v6h3l5 4Z" />\n      <path v-if="name === \'volume\'" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />\n      <path v-else d="m16 9 6 6m0-6-6 6" />\n    </template>\n    <path v-else-if="name === \'queue\'" d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />\n    <template v-else-if="name === \'hifi\' || name === \'equalizer\'">\n      <path d="M5 3v5m0 4v9M12 3v10m0 4v4M19 3v3m0 4v11" />\n      <path d="M2 8h6v4H2Zm7 5h6v4H9Zm7-7h6v4h-6Z" />\n    </template>\n    <template v-else-if="name === \'miniPlayer\'">\n      <rect x="2" y="4" width="20" height="16" rx="2" />\n      <rect x="12" y="11" width="7" height="6" rx="1" />\n    </template>\n    <path\n      v-else\n      d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"\n      :fill="filled ? \'currentColor\' : \'none\'"\n    />\n  </svg>\n</template>\n\n<style scoped>\n.player-control-icon {\n  width: 1em;\n  height: 1em;\n  display: block;\n  flex-shrink: 0;\n}\n</style>\n'
}

const iconTemplate =
  '<div class="row"><button id="transport" :aria-label="playback===\'play\'?\'播放\':\'暂停\'" @click="clicks++;playback=playback===\'play\'?\'pause\':\'play\'"><PlaybackIcon :name="playback" /></button><button id="favorite" :aria-pressed="filled" aria-label="收藏" @click="filled=!filled"><PlayerControlIcon name="favorite" :filled="filled" /></button><button id="volume" aria-label="音量" @click="muted=!muted"><PlayerControlIcon :name="muted?\'muted\':\'volume\'" /></button><a id="after" href="#after">Next action</a></div><div class="row sample"><PlaybackIcon id="new-default" name="play" default-only/><BaselinePlayback id="old-default" name="play"/><PlayerControlIcon id="new-control" name="volume" default-only/><BaselineControl id="old-control" name="volume"/><ThemeIcon id="default-glyph" icon-slot="navigation.home" default-only/><MiniGlyph id="mini" name="play"/><ThemeIcon id="slotted-favorite" icon-slot="playback.favorite"><i class="ph ph-heart" style="display:inline-block;width:1em;height:1em"></i></ThemeIcon><ThemeIcon id="slotted-volume" icon-slot="playback.volume"><i class="ph ph-speaker-simple-high" style="display:inline-block;width:1em;height:1em"></i></ThemeIcon></div><div class="row player-bar-glass player-bar-transport-grouped"><button class="mode-btn-right" v-for="value in modes" :key="value"><PlaybackModeIcon :mode="value" /></button><button id="font-mode" style="font-size:16px"><PlaybackModeIcon :mode="mode" variant="font" /></button></div><div class="gallery"><ThemeIcon v-for="slot in slots" :key="slot" :icon-slot="slot" /></div>'

const fixture = String.raw`
import {createApp,ref,nextTick} from 'vue';
import ThemeIcon from '__RENDERER__/components/ThemeIcon.vue';
import PlaybackIcon from '__RENDERER__/components/icons/PlaybackIcon.vue';
import PlayerControlIcon from '__RENDERER__/components/player-bar/PlayerControlIcon.vue';
import PlaybackModeIcon from '__RENDERER__/components/icons/PlaybackModeIcon.vue';
import MiniGlyph from '__RENDERER__/mini-player/MiniGlyph.vue';
import BaselinePlayback from './BaselinePlayback.vue';
import BaselineControl from './BaselineControl.vue';
import {useThemeStore} from '__RENDERER__/stores/useThemeStore.ts';
import {observeMiniPlayerThemeIcons} from '__RENDERER__/app/themeIconRuntime.ts';
import {THEME_ICON_SLOTS,normalizeThemeProfile,createDefaultThemeLibraryDocument} from '__RENDERER__/../../shared/theme.ts';

const listeners=new Set();let library,resolveList;let deferList=false;
window.api={themes:{validateAssets:async()=>true,list:()=>deferList?new Promise(resolve=>resolveList=resolve):Promise.resolve(library),onChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)}}};
const store=useThemeStore();const playback=ref('play'),filled=ref(false),muted=ref(false),mode=ref('sequential'),clicks=ref(0);
const modes=['sequential','listLoop','repeat','shuffle','heart'];
const app=createApp({components:{ThemeIcon,PlaybackIcon,PlayerControlIcon,PlaybackModeIcon,MiniGlyph,BaselinePlayback,BaselineControl},setup:()=>({playback,filled,muted,mode,clicks,slots:THEME_ICON_SLOTS,modes}),template:__ICON_TEMPLATE__});app.mount('#app');
const expect=(value,message)=>{if(!value)throw Error(message)};
const wait=async(predicate,message)=>{for(let i=0;i<100;i++){await nextTick();await new Promise(resolve=>setTimeout(resolve,20));if(predicate())return;}throw Error(message)};
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,40));await nextTick()};
let assets,profile;
const makeProfile=id=>normalizeThemeProfile({schemaVersion:2,id:'user:icon-probe',name:'Icon probe',overrides:{},modes:{},assets:Object.values(assets),iconBindings:Object.fromEntries(THEME_ICON_SLOTS.map(slot=>[slot,id]))});
const shape=node=>{const rect=node.getBoundingClientRect();return {width:rect.width,height:rect.height}};
const checkSlottedGeometry=()=>['#slotted-favorite','#slotted-volume'].map(selector=>{const root=document.querySelector(selector),outer=root.getBoundingClientRect();for(const child of root.querySelectorAll('i,.theme-icon-image')){const inner=child.getBoundingClientRect();for(const edge of ['left','top','right','bottom'])expect(Math.abs(inner[edge]-outer[edge])<.1,'Slotted fallback/image creates an implicit track or overflows at '+selector+'/'+edge+': '+JSON.stringify({outer:outer.toJSON(),inner:inner.toJSON()}));}return {slot:root.dataset.themeIconSlot,...shape(root)}});
window.prepareIcons=async(imported)=>{assets=imported;profile=makeProfile(assets.pink.id);for(const slot of ['playback.pause','playback.favoriteActive','playback.muted','playback.shuffle'])profile.iconBindings[slot]=assets.blue.id;const matrices=[];
  for(const tone of ['pureWhite','dark'])for(const size of [14,20,28])for(const family of ['outline','filled','rounded']){
    document.documentElement.dataset.theme=tone;document.documentElement.dataset.teIconFamily=family;document.querySelector('.sample').style.fontSize=size+'px';await settle();
    for(const [a,b]of [['#new-default','#old-default'],['#new-control','#old-control']])expect(JSON.stringify(shape(document.querySelector(a)))===JSON.stringify(shape(document.querySelector(b))),'Default icon bounds changed at '+tone+'/'+size+'/'+family);
    const actual=document.querySelector('#new-default g path').getAttribute('d');const prior=document.querySelector('#old-default g path').getAttribute('d');expect(actual===prior,'A transport default path was replaced');
    expect(getComputedStyle(document.querySelector('#default-glyph .theme-icon-family-'+family)).display!=='none','Default font family lost');
    checkSlottedGeometry();matrices.push({tone,size,family,...shape(document.querySelector('#new-default'))});
  }
  document.documentElement.dataset.theme='dark';document.documentElement.dataset.tePlayerLayout='standard';document.querySelector('.sample').style.fontSize='24px';await settle();
  const container=shape(document.querySelector('.player-bar-transport-grouped'));expect(container.width>500,'Icon CSS collapsed the transport container');
  const imageModes=[...document.querySelectorAll('.mode-btn-right .playback-mode-icon')].map(shape);for(const value of imageModes)expect(value.width===20&&value.height===20,'Standard mode icon changed its authored size');
  await store.preview(profile);await wait(()=>document.querySelectorAll('.gallery [data-theme-icon-custom]').length===THEME_ICON_SLOTS.length,'Bound gallery images did not decode');
  const slottedIcons=checkSlottedGeometry();expect(document.querySelectorAll('#slotted-favorite[data-theme-icon-custom],#slotted-volume[data-theme-icon-custom]').length===2,'Slotted custom images did not decode');
  expect(!document.querySelector('#new-default image')&&!document.querySelector('#new-control image')&&!document.querySelector('#default-glyph img'),'Default-only samples inherit custom images');
  expect(document.querySelector('#transport svg').tagName.toLowerCase()==='svg','Transport native SVG root was replaced');
  expect(document.querySelector('#mini').dataset.themeIconSlot==='playback.play','Satellite transport misses shared slot');
  const rect=document.querySelector('#transport svg').getBoundingClientRect();
  return {transportContainer:container,modeIconBounds:imageModes,slottedIcons,defaultMatrices:matrices,slots:THEME_ICON_SLOTS.length,viewport:{width:innerWidth,height:innerHeight},samples:[6,12,20].map(x=>({x:rect.left+x*rect.width/24,y:rect.top+rect.height/2})),point:{x:rect.left+rect.width/2,y:rect.top+rect.height/2}};
};
window.checkPointerPause=async()=>{await wait(()=>playback.value==='pause'&&document.querySelector('#transport svg').hasAttribute('data-theme-icon-custom'),'Pointer did not activate native transport');expect(document.querySelector('#transport svg').dataset.themeIconSlot==='playback.pause','Pointer pause binding lost');expect(document.querySelector('#transport image').getAttribute('href').endsWith(assets.blue.path),'Pause kept the play asset');return true};
window.checkSpacePlay=async()=>{await wait(()=>playback.value==='play'&&clicks.value===2,'Space did not activate native transport');return true};
window.checkIconState=async()=>{
  await wait(()=>document.activeElement.id==='after','Native Tab did not reach the action after icons');expect(clicks.value===2,'Pointer/Space did not preserve native activation');
  expect(document.activeElement.id==='after','Icons entered the Tab order');
  expect(document.querySelector('#transport svg').dataset.themeIconSlot==='playback.play','Play/pause does not follow state');
  document.querySelector('#favorite').click();document.querySelector('#volume').click();await settle();
  expect(document.querySelector('#favorite svg').dataset.themeIconSlot==='playback.favoriteActive','Favorite active binding lost');
  expect(document.querySelector('#volume svg').dataset.themeIconSlot==='playback.muted','Mute binding lost');
  for(const selector of ['#favorite','#volume'])expect(document.querySelector(selector+' image').getAttribute('href').endsWith(assets.blue.path),'State changed the label but kept the prior asset');
  for(const value of modes){mode.value=value;await settle();expect(document.querySelector('#font-mode [data-theme-icon-slot]').dataset.themeIconSlot==='playback.'+value,'Mode did not follow state');expect(document.querySelector('#font-mode .theme-icon-image').getAttribute('src').endsWith(assets[value==='shuffle'?'blue':'pink'].path),'Mode asset did not follow state');}
  return {pointerAndSpace:2,tabSkipsIcons:true,playPause:true,favorite:true,mute:true,modes:5};
};
window.clearIcons=async()=>{await store.preview({...profile,iconBindings:undefined});await settle();expect(!document.querySelector('[data-theme-icon-custom]'),'Unbinding leaves custom images');expect(!document.querySelector('#transport image'),'Unbinding leaves image node');expect(getComputedStyle(document.querySelector('#transport svg > g')).visibility==='visible','Unbinding fails to restore original SVG');return true};
window.failIcons=async(kind)=>{await store.preview(makeProfile(assets[kind].id));await wait(()=>!document.querySelector('.gallery img')&&!document.querySelector('#transport image'),'Image failure did not return to defaults');expect(!document.querySelector('[data-theme-icon-custom]'),'Broken image remains custom');expect(getComputedStyle(document.querySelector('#transport svg > g')).visibility==='visible','Broken image hides default SVG');return true};
window.startSlowIcons=async()=>{await store.preview(makeProfile(assets.slow.id));await settle()};
window.useFastIcons=async()=>{profile=makeProfile(assets.blue.id);await store.preview(profile);await wait(()=>document.querySelectorAll('.gallery [data-theme-icon-custom]').length===THEME_ICON_SLOTS.length,'Fast binding did not load');return document.querySelector('#transport image').getAttribute('href')};
window.checkLateIcons=async(expected)=>{await settle();expect(document.querySelector('#transport image').getAttribute('href')===expected,'Late previous image replaced current binding');expect(document.querySelector('#transport svg').hasAttribute('data-theme-icon-custom'),'Late load cleared ready state');return true};
const snapshot=(revision,enabled=true,custom=true)=>({version:2,revision,savedAt:'2026-10-14T00:00:00.000Z',data:{...createDefaultThemeLibraryDocument(custom?{kind:'user',id:profile.id}:undefined,{miniPlayer:enabled,desktopLyrics:true}),profiles:[profile]}});
const emit=next=>{library=next;for(const callback of listeners)callback(next)};
window.checkSatelliteIcons=async()=>{
  await store.preview(null);deferList=true;library=snapshot(1);const sheet=document.getElementById('twilight-theme-runtime').textContent;const stop=observeMiniPlayerThemeIcons();
  emit(snapshot(3));await wait(()=>document.querySelector('#mini').hasAttribute('data-theme-icon-custom'),'Satellite theme update missing');
  resolveList(snapshot(1,false));await settle();expect(document.querySelector('#mini').hasAttribute('data-theme-icon-custom'),'Older bootstrap overwrote newer satellite theme');
  emit(snapshot(4,false));await settle();expect(!document.querySelector('#mini image'),'Independent mini window kept inherited image');
  emit(snapshot(5,true));await wait(()=>document.querySelector('#mini').hasAttribute('data-theme-icon-custom'),'Re-enabling mini inheritance failed');
  emit(snapshot(6,true,false));await settle();expect(!document.querySelector('#mini image'),'Changing to built-in theme leaves old icon');
  emit(snapshot(7));await wait(()=>document.querySelector('#mini').hasAttribute('data-theme-icon-custom'),'Satellite did not rebind after built-in');
  expect(document.getElementById('twilight-theme-runtime').textContent===sheet,'Icon-only subscription changed satellite CSS');
  stop();await settle();expect(!document.querySelector('#mini image'),'Stopping satellite subscription leaves custom image');expect(listeners.size===0,'Satellite listener was not cleaned');emit(snapshot(8));await settle();expect(!document.querySelector('#mini image'),'Stopped subscription accepts late theme');
  app.unmount();return {libraryUpdates:true,staleBootstrapIgnored:true,inheritanceToggle:true,builtinClears:true,noMainStyles:true,unsubscribed:true};
};
`

const runner = String.raw`
const {app,BrowserWindow,protocol,session}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'user-data'));protocol.registerSchemesAsPrivileged([{scheme:'theme-asset',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.whenReady().then(async()=>{let networkRequests=0;session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{networkRequests++;callback({cancel:true})});
  const {importThemeAsset,resolveThemeAssetFile}=require('./assets.cjs');const assets={};for(const name of ['pink','blue','slow','bad'])assets[name]=await importThemeAsset('user:icon-probe',path.join(__dirname,name+'.png'),'image');assets.missing={id:'missing',path:'missing.png',type:'image'};
  let releaseSlow,slowRequested=false;
  protocol.handle('theme-asset',async request=>{const url=new URL(request.url);const parts=url.pathname.slice(1).split('/').map(decodeURIComponent);const profileId=parts.shift();const file=resolveThemeAssetFile(profileId,parts.join('/'));if(!file)return new Response('',{status:404});if(parts.join('/')===assets.slow.path){slowRequested=true;await new Promise(resolve=>releaseSlow=resolve)}try{return new Response(await fs.readFile(file),{headers:{'content-type':'image/png'}})}catch{return new Response('',{status:404})}});
  const win=new BrowserWindow({width:900,height:620,show:false,webPreferences:{offscreen:true,contextIsolation:false,nodeIntegration:false}});await win.loadFile(path.join(__dirname,'index.html'));
  const evidence=await win.webContents.executeJavaScript('window.prepareIcons('+JSON.stringify(assets)+')');await fs.writeFile(path.join(__dirname,'alpha.png'),(await win.webContents.capturePage()).toPNG());
  win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(evidence.point.x),y:Math.round(evidence.point.y),button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(evidence.point.x),y:Math.round(evidence.point.y),button:'left',clickCount:1});
  evidence.pointerPause=await win.webContents.executeJavaScript('window.checkPointerPause()');
  await win.webContents.executeJavaScript('document.querySelector("#transport").focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
  evidence.spacePlay=await win.webContents.executeJavaScript('window.checkSpacePlay()');
  await win.webContents.executeJavaScript('document.querySelector("#volume").focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
  evidence.interaction=await win.webContents.executeJavaScript('window.checkIconState()');
  evidence.unboundRestores=await win.webContents.executeJavaScript('window.clearIcons()');
  evidence.missingFallback=await win.webContents.executeJavaScript('window.failIcons("missing")');evidence.decodeFallback=await win.webContents.executeJavaScript('window.failIcons("bad")');
  await win.webContents.executeJavaScript('window.startSlowIcons()');if(!slowRequested)throw Error('Late image request not exercised');const expected=await win.webContents.executeJavaScript('window.useFastIcons()');releaseSlow();evidence.lateImageIgnored=await win.webContents.executeJavaScript('window.checkLateIcons('+JSON.stringify(expected)+')');
  evidence.satellite=await win.webContents.executeJavaScript('window.checkSatelliteIcons()');evidence.networkRequests=networkRequests;console.log('THEME_ICONS_RESULT '+JSON.stringify(evidence));win.destroy();app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`
