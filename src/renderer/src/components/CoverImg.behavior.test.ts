import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('missing, broken and expired artwork uses a packaged fallback without retry loops or stale images', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-cover-fallback-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(
      join(directory, 'core.ts'),
      `import {shallowRef} from 'vue'
export const coreState=shallowRef({phase:'ready',epoch:'covers',libraryRevision:1,sequence:0})
export const artwork={calls:0,hold:false,pending:[],cover:'cover://same.jpg'}
export const useCoreConnection=()=>({state:coreState,attach:async()=>coreState.value,query:async(name,input)=>{
 if(name!=='library.artwork')throw Error('Unexpected query '+name)
 artwork.calls++
 if(artwork.hold)await new Promise(resolve=>artwork.pending.push(resolve))
 return {revision:coreState.value.libraryRevision,items:input.ids.map(id=>({id,cover:artwork.cover}))}
}})`
    )
    await writeFile(
      join(directory, 'ArtworkFrame.vue'),
      `<script setup>import CoverImg from '@renderer/components/CoverImg.vue';defineOptions({inheritAttrs:false})</script>
<template><div class="artwork-frame"><CoverImg v-bind="$attrs"><template v-if="$slots.placeholder" #placeholder><slot name="placeholder"/></template></CoverImg></div></template>
<style scoped>.artwork-frame{width:160px;height:160px;overflow:hidden}.artwork-frame img{display:block;width:100%;height:100%;object-fit:cover}</style>`
    )
    await writeFile(
      join(directory, 'loader.ts'),
      `
export const state={mode:'broken',calls:0,invalidations:0,pending:[]}
const good='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#456"/></svg>')
const updated='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#b86"/></svg>')
export function clearLocalCoverDataCache(){}
export function invalidateRemoteCoverGrant(){state.invalidations++}
export function readCachedCover(){return null}
export async function resolveCover(cover,source){
 state.calls++
 if(state.mode==='core')return cover===null?null:cover==='cover://updated.jpg'?updated:good
 if(state.mode==='reject')throw Error('Grant failed')
 if(state.mode==='pending')return new Promise(resolve=>state.pending.push(resolve))
 if(state.mode==='same')return 'data:image/png;base64,AAAA'
 if(state.mode==='good'||state.mode==='recover'&&state.calls===2)return good
 return 'data:image/png;base64,AAAA#'+state.calls
}
export const validCover=good,updatedCover=updated`
    )
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      publicDir: false,
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [vue()],
      resolve: {
        alias: [
          { find: '../utils/coverLoader.ts', replacement: join(directory, 'loader.ts') },
          { find: /^.*\/coreConnection(?:\.ts)?$/, replacement: join(directory, 'core.ts') },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') }
        ]
      },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        lib: {
          entry: join(directory, 'entry.ts'),
          formats: ['iife'],
          name: 'ArtworkFixture',
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head>${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}</head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});try{await win.loadFile(__dirname+'/index.html');const failure=await win.webContents.executeJavaScript('window.runArtworkTests().then(()=>null).catch(error=>error.message)');if(failure)throw Error(failure);console.log('ARTWORK_OK');app.exit(0)}catch(error){console.error(error);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 30_000 }
    )
    assert.match(result.stdout, /ARTWORK_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,reactive,ref,nextTick} from 'vue'
import CoverImg from './ArtworkFrame.vue'
import {state,validCover,updatedCover} from './loader'
import {coreState,artwork} from './core'
const diagnostics=[];window.api={diagnostics:{record:events=>diagnostics.push(...events)}}
const props=reactive({cover:null,coverSource:null,identity:'empty',loading:'lazy'}),errors=[],custom=ref(false)
createApp({render:()=>h(CoverImg,{...props,onError:event=>errors.push(event)},custom.value?{placeholder:()=>h('span',{'data-custom-placeholder':''},'Custom')}:undefined)}).mount('#app')
const expect=(ok,message)=>{if(!ok)throw Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,100))}
const loaded=async()=>{for(let i=0;i<30;i++){await settle();const img=document.querySelector('img');if(img?.complete&&img.naturalWidth)return img}throw Error('artwork did not load')}
window.runArtworkTests=async()=>{
 const empty=await loaded(),fallback=empty.src
 expect(empty.naturalWidth===512&&empty.loading==='lazy'&&empty.decoding==='async','bundled fallback is absent or loses image hints')
 expect(empty.classList.contains('default-track-cover'),'default art is not theme-aware')
 const lightContent=getComputedStyle(empty).content
 document.documentElement.dataset.theme='dark';await settle()
 expect(getComputedStyle(empty).content!==lightContent,'dark theme keeps the light fallback')
 document.documentElement.dataset.theme='pureWhite';await settle()
 expect(getComputedStyle(empty).content===lightContent,'light theme keeps the dark fallback')
 const size=empty.getBoundingClientRect().toJSON()
 expect(size.width===160&&size.height===160,'fallback does not inherit its parent scoped thumbnail size and gets cropped')
 state.mode='broken';state.calls=0;props.coverSource='https://example.invalid/cover';props.identity='broken'
 const broken=await loaded();await settle()
 expect(broken.src===fallback&&state.calls===2&&state.invalidations===1&&errors.length===1,'broken grant loops or does not fall back')
 expect(diagnostics.some(e=>e.event==='image.failed')&&diagnostics.some(e=>e.event==='retry.resolved')&&diagnostics.some(e=>e.event==='fallback.shown'),'cover failure chain is absent from diagnostics')
 expect(!JSON.stringify(diagnostics).includes('base64,AAAA'),'diagnostics include embedded image payload')
 await settle();expect(state.calls===2,'fallback continues to request remote art')
 state.mode='reject';props.identity='rejected';await settle()
 expect((await loaded()).src===fallback,'rejected grant leaves a broken image')
 state.mode='recover';state.calls=0;props.identity='recover';await settle()
 const recovered=await loaded();expect(recovered.src!==fallback&&state.calls===2,'one expired handle cannot recover')
 expect(!recovered.classList.contains('default-track-cover')&&getComputedStyle(recovered).content==='normal','theme fallback masks real artwork')
 expect(diagnostics.some(e=>e.event==='image.recovered'),'successful recovery is absent from diagnostics')
 expect(recovered.getBoundingClientRect().width===size.width&&recovered.getBoundingClientRect().height===size.height,'fallback changes thumbnail geometry')
 state.mode='same';state.calls=0;props.identity='same-handle';await loaded();await settle()
 expect(diagnostics.some(e=>e.event==='retry.resolved'&&e.details.sameHandle===true),'same-handle retry failure cannot be identified')
 expect(state.calls===2,'same-handle diagnostics changed retry behavior')
 state.mode='pending';props.identity='older';await settle()
 expect(state.pending.length===1,'deferred cover was not requested')
 state.mode='good';props.identity='newer';await settle();expect((await loaded()).src===validCover,'new track did not acquire its cover')
 state.pending.shift()('data:image/png;base64,AAAA');await settle()
 expect(document.querySelector('img').src===validCover,'stale resolve replaces the new track cover')
 props.cover=null;props.coverSource=null;props.identity='custom';custom.value=true;await settle()
 expect(document.querySelector('[data-custom-placeholder]'),'explicit placeholder contract was lost')
 custom.value=false;props.fallback='';await settle();expect(!document.querySelector('img'),'explicit empty fallback was lost')
 props.fallback=validCover;await settle();document.documentElement.dataset.theme='dark';await settle()
 expect((await loaded()).src===validCover&&!document.querySelector('img').classList.contains('default-track-cover'),'theme replaces an explicit fallback')
 props.fallback=undefined;props.identity='core-song';props.coreTrackId='core-song';state.mode='core';await settle()
 const coreImage=await loaded(),coreCalls=artwork.calls,resolves=state.calls
 expect(coreImage.src===validCover&&coreCalls===1,'Core artwork fixture did not load')
 for(let i=0;i<6;i++){
  coreState.value={...coreState.value,sequence:i+1};await settle()
  expect(document.querySelector('img')===coreImage&&coreImage.src===validCover,'a progress-only snapshot remounted the cover')
 }
 expect(artwork.calls===coreCalls&&state.calls===resolves,'progress-only updates re-resolved unchanged artwork')
 artwork.hold=true;coreState.value={...coreState.value,libraryRevision:2};await settle()
 expect(artwork.pending.length===1,'background revision did not revalidate artwork')
 expect(document.querySelector('img')===coreImage&&coreImage.src===validCover,'revalidation flashed the fallback')
 coreState.value={...coreState.value,libraryRevision:3};await settle();artwork.pending.shift()();await settle()
 expect(document.querySelector('img')===coreImage&&coreImage.src===validCover,'a superseded artwork read cleared the image')
 expect(artwork.pending.length===1,'latest revision was not requested after the obsolete read')
 artwork.cover='cover://updated.jpg';artwork.pending.shift()();await settle()
 expect(document.querySelector('img')===coreImage&&coreImage.src===updatedCover,'new artwork was not updated in place')
 props.identity='other-song';props.coreTrackId='other-song';await settle()
 expect(document.querySelector('img').src===fallback,'another track temporarily displayed the previous artwork')
 artwork.pending.shift()();await settle()
 const otherImage=await loaded();coreState.value={...coreState.value,epoch:'restarted'};await settle()
 expect(document.querySelector('img')!==otherImage&&document.querySelector('img').src===fallback,'a Core epoch change retained an old display grant')
 artwork.pending.shift()();await settle()
 coreState.value={...coreState.value,libraryRevision:4};await settle();artwork.cover=null;artwork.pending.shift()();await settle()
 expect(document.querySelector('img').src===fallback,'removed Core artwork never cleared the retained bitmap')
}`
