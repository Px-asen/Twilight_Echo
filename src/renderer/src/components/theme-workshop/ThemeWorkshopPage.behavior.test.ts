import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { parse } from '@vue/compiler-sfc'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('workshop authoring and isolated previews work through Electron DOM interactions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-workshop-ui-'))
  try {
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '/icon.png': join(workspace, 'resources/icon.png'),
          '@renderer': join(workspace, 'src/renderer/src'),
          '@shared': join(workspace, 'src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: fileURLToPath(new URL('./workshopBehavior.fixture.mjs', import.meta.url)),
          name: 'WorkshopTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    const app = parse(
      await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8')
    ).descriptor
    const shellStyles = app.styles.map((style) => style.content).join('\n')
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>${shellStyles}body{margin:0}#app{height:100vh}</style></head><body><div id="app"></div><script>window.addEventListener('unhandledrejection',e=>console.error('UNHANDLED '+e.reason?.stack));window.__businessWrites=[];window.api=new Proxy({}, {get:(_target,domain)=>new Proxy({}, {get:(_object,method)=>String(method).startsWith('on')?()=>()=>{}:async()=>{if(/^(set|save|update|play|pause|seek|loadQueue|next|prev|toggle)/.test(String(method)))window.__businessWrites.push(String(domain)+'.'+String(method));if(domain==='data'&&method==='loadLyricsManagement')return {version:1,revision:0,savedAt:new Date(0).toISOString(),data:{version:1,tracks:{}}};return []}})})</script><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.webContents.on('console-message',event=>console.error(event.message));let inputTimer;try{await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});inputTimer=setInterval(async()=>{const request=await win.webContents.executeJavaScript('window.__workshopPointerQueue?.shift()');if(request){win.webContents.sendInputEvent(request.event);await win.webContents.executeJavaScript('window.__workshopPointerDone('+request.id+')')}},10);await win.webContents.executeJavaScript('window.runWorkshopTests()');if(process.env.TWILIGHT_WORKSHOP_SCREENSHOT)require('node:fs').writeFileSync(process.env.TWILIGHT_WORKSHOP_SCREENSHOT,(await win.webContents.capturePage()).toPNG());clearInterval(inputTimer);console.log('WORKSHOP_UI_OK');app.exit(0)}catch(error){clearInterval(inputTimer);console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /WORKSHOP_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

test('workshop controls use the shared appearance preview without mounting a second canvas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-workshop-shared-preview-'))
  try {
    await writeFile(join(directory, 'entry.mjs'), sharedPreviewRuntime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '/icon.png': join(workspace, 'resources/icon.png'),
          '@renderer': join(workspace, 'src/renderer/src'),
          '@shared': join(workspace, 'src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: require.resolve('pinia')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.mjs'),
          name: 'WorkshopSharedPreviewTest',
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
        )}<style>body{margin:0;background:#17181a}.fixture{width:264px;height:640px;overflow:auto;padding:12px;box-sizing:border-box;--appearance-edit-line:#35383d;--appearance-edit-field:#1f2023;--appearance-edit-focus:#c7c7c7;--appearance-edit-primary:#d0d2d5}</style></head><body><div id="app" class="fixture"></div><script>window.__businessWrites=[];window.api=new Proxy({}, {get:(_target,domain)=>new Proxy({}, {get:(_object,method)=>String(method).startsWith('on')?()=>()=>{}:async()=>{if(/^(set|save|update|play|pause|seek|loadQueue|next|prev|toggle)/.test(String(method)))window.__businessWrites.push(String(domain)+'.'+String(method));if(domain==='data'&&method==='loadLyricsManagement')return {version:1,revision:0,savedAt:new Date(0).toISOString(),data:{version:1,tracks:{}}};return []}})})</script><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), sharedPreviewRunner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /WORKSHOP_SHARED_OK/)
    const metrics = JSON.parse(result.stdout.match(/WORKSHOP_SHARED_METRICS (.*)/)![1])
    assert.equal(metrics.isolatedCanvases, 0)
    assert.equal(metrics.scenes, 224)
    assert.equal(metrics.nativeKeyboard, true)
    assert.equal(metrics.switchInputsProtected, true)
    assert.equal(metrics.failedSaveRetainsDraft, true)
    assert.equal(metrics.hiddenDraftDeferred, true)
    assert.equal(metrics.hiddenCheckCancelled, true)
    console.info('Shared workshop preview:', JSON.stringify(metrics))
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

test('contextual workshop retains editor buffers and exposes resources in one compact bar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-workshop-contextual-'))
  try {
    await writeFile(join(directory, 'entry.mjs'), sharedPreviewRuntime + contextualRuntime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '/icon.png': join(workspace, 'resources/icon.png'),
          '@renderer': join(workspace, 'src/renderer/src'),
          '@shared': join(workspace, 'src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: require.resolve('pinia')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.mjs'),
          name: 'WorkshopContextTest',
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
        )}<style>body{margin:0;background:#17181a;color:#d8dadd}.fixture{width:calc(100vw - 48px);max-width:660px;margin:80px 24px 0;--appearance-edit-line:#35383d;--appearance-edit-field:#1f2023;--appearance-edit-focus:#c7c7c7;--appearance-edit-primary:#d0d2d5;--te-settings-backplate:#191b1e;--te-settings-text:#dedfe2}html[data-theme="pureWhite"] body{background:#f5f6f8;color:#24262a}html[data-theme="pureWhite"] .fixture{--appearance-edit-line:#c7c9ce;--appearance-edit-field:#f1f2f4;--appearance-edit-focus:#35373b;--appearance-edit-primary:#35373b;--te-settings-backplate:#ffffff;--te-settings-text:#24262a}</style></head><body><div id="app" class="fixture"></div><script>window.__workshopContextFixture=true;window.__businessWrites=[];window.api=new Proxy({}, {get:(_target,domain)=>new Proxy({}, {get:(_object,method)=>String(method).startsWith('on')?()=>()=>{}:async()=>{if(/^(set|save|update|play|pause|seek|loadQueue|next|prev|toggle)/.test(String(method)))window.__businessWrites.push(String(domain)+'.'+String(method));return []}})})</script><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), contextualRunner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /WORKSHOP_CONTEXT_OK/)
    const metrics = JSON.parse(result.stdout.match(/WORKSHOP_CONTEXT_METRICS (.*)/)![1])
    assert.equal(metrics.nativeKeyboard, true)
    assert.equal(metrics.metadataPreserved, true)
    assert.equal(metrics.parameterBufferPreserved, true)
    assert.equal(metrics.scenesPreserved, true)
    assert.equal(metrics.busyProtected, true)
    assert.equal(metrics.newProjectReady, true)
    assert.equal(metrics.pendingCreateRestored, true)
    assert.equal(metrics.busyCreateProtected, true)
    assert.equal(metrics.staleCreateCanceled, true)
    assert.equal(metrics.directControls, true)
    assert.equal(metrics.floatingToolbar, true)
    assert.equal(metrics.isolatedCanvases, 0)
    assert.equal(metrics.responsiveStates, 12)
    console.info('Contextual workshop:', JSON.stringify(metrics))
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const contextualRunner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1024,height:720,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',async event=>{
  if(!event.message.startsWith('CONTEXT_NATIVE_TEXT ')){console.error(event.message);return}
  try{await win.webContents.debugger.sendCommand('Input.insertText',{text:JSON.parse(event.message.slice(20))});await win.webContents.executeJavaScript('window.__contextTextDone()')}
  catch(error){await win.webContents.executeJavaScript('window.__contextTextDone('+JSON.stringify(error.message)+')')}
 });
 try{
  await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await win.webContents.executeJavaScript('window.prepareContextWorkshopKeyboard()');
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,...(type==='keyDown'?{text:'\\r',unmodifiedText:'\\r'}:{})});
  await win.webContents.executeJavaScript('window.verifyContextWorkshopKeyboard(true)');
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await win.webContents.executeJavaScript('window.verifyContextWorkshopKeyboard(false)');
  await win.webContents.executeJavaScript('window.openContextOutsideTest()');
  win.webContents.sendInputEvent({type:'mouseDown',x:900,y:650,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:900,y:650,button:'left',clickCount:1});
  await win.webContents.executeJavaScript('window.verifyContextOutsideTest()');
  const metrics=await win.webContents.executeJavaScript('window.runContextWorkshopTests()');
  const output=process.env.TE_WORKSHOP_CONTEXT_QA_OUTPUT;if(output)fs.mkdirSync(output,{recursive:true});const shots=[];
  for(const width of [1280,760,521])for(const tone of ['dark','pureWhite']){
   win.setSize(width,800);await win.webContents.executeJavaScript('window.prepareContextScreenshot('+JSON.stringify(tone)+',false)');metrics.responsiveStates++;
   if(output){const name='context-'+tone+'-'+width+'.png';fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());shots.push(name)}
   await win.webContents.executeJavaScript('window.prepareContextScreenshot('+JSON.stringify(tone)+',true)');metrics.responsiveStates++;
   if(output){const name='context-color-'+tone+'-'+width+'.png';fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());shots.push(name)}
  }
  Object.assign(metrics,await win.webContents.executeJavaScript('window.verifyContextWorkshopCreation()'));
  if(output)fs.writeFileSync(path.join(output,'contextual-manifest.json'),JSON.stringify({metrics,shots},null,2));
  console.log('WORKSHOP_CONTEXT_METRICS',JSON.stringify(metrics));console.log('WORKSHOP_CONTEXT_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});
`

const sharedPreviewRunner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1024,height:720,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>console.error(event.message));
 try{
  await win.loadFile(process.argv.at(-1));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await win.webContents.executeJavaScript('window.prepareWorkshopKeyboard()');
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\\r',unmodifiedText:'\\r'});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await win.webContents.executeJavaScript('window.verifyWorkshopKeyboard()');
  const result=await win.webContents.executeJavaScript('window.runSharedWorkshopTests()');
  for(const phase of ['save','get']){
    await win.webContents.executeJavaScript('window.prepareWorkshopBusy('+JSON.stringify(phase)+')');
    await win.webContents.debugger.sendCommand('Input.insertText',{text:'must not replace this draft'});
    await win.webContents.executeJavaScript('window.finishWorkshopBusy('+JSON.stringify(phase)+')');
  }
  Object.assign(result,{switchInputsProtected:true,failedSaveRetainsDraft:true});
  console.log('WORKSHOP_SHARED_METRICS',JSON.stringify(result));
  console.log('WORKSHOP_SHARED_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});
`

const sharedPreviewRuntime = `
import {createApp,h,nextTick,ref,shallowRef} from 'vue';
import {createPinia} from 'pinia';
import Page from '@renderer/components/theme-workshop/ThemeWorkshopPage.vue';
import {workshopTemplate} from '@shared/themeWorkshopTemplates.ts';
import {copyWorkshopDraft,workshopProjectSummary} from '@shared/themeWorkshop.ts';
import {createWorkshopLayer} from '@shared/themeWorkshopLayers.ts';
import {diagnoseWorkshopProject} from '@shared/themeWorkshopDiagnostics.ts';
import '@renderer/assets/main.css';
const expect=(value,message)=>{if(!value)throw Error(message)};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tick=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(resolve));await nextTick()};
const settle=async(predicate,message)=>{for(let i=0;i<180;i++){await tick();if(predicate())return}throw Error(message+' '+document.body.innerText.slice(0,2400))};
let stored=workshopTemplate('00000000-0000-0000-0000-000000000001',window.__workshopContextFixture?'wallpaper':'minimal');
if(window.__workshopContextFixture){stored.base.editor.controls.push({id:'context-material',label:'卡片材质',group:'卡片',type:'select',variable:'--context-material',defaults:{pureWhite:'none',dark:'none'},options:['none','blur(12px)']});stored.base.css+='\\n.dashboard-card{backdrop-filter:var(--context-material,none)}'}
stored.revision=1;
const nextProject=workshopTemplate('00000000-0000-0000-0000-000000000002','minimal');
nextProject.name='Next project';nextProject.revision=1;
const layer=createWorkshopLayer('shared-layer','gradient');layer.x=40;
stored.layers={pureWhite:{app:[layer]},dark:{}};
let saves=0;const exports=[],preflights=[];
let saveBarrier,getBarrier;
const api={
 list:async()=>[workshopProjectSummary(stored),workshopProjectSummary(nextProject)],sources:async()=>[],get:async id=>{if(getBarrier&&id===nextProject.id){const barrier=getBarrier;getBarrier=undefined;barrier.started=true;await barrier.promise}return copyWorkshopDraft(id===nextProject.id?nextProject:stored)},
 save:async project=>{if(saveBarrier){const barrier=saveBarrier;saveBarrier=undefined;barrier.started=true;await barrier.promise}expect(project.revision===stored.revision,'shared editor loses revision protection');saves++;stored={...copyWorkshopDraft(project),revision:project.revision+1};return copyWorkshopDraft(stored)},
 onPrepareDisable:()=>()=>{},preflight:async(id,revision)=>{preflights.push({id,revision});return diagnoseWorkshopProject(stored)},
 exportProject:async(id,format,revision)=>{exports.push({id,format,revision});return 'shared.'+format}
};
window.api=new Proxy(window.api,{get:(target,domain)=>domain==='themeWorkshop'?api:target[domain]});
const page=ref(),adapter=shallowRef(),group=ref('项目'),active=ref(true),contextual=ref(false),part=ref('navigation');
createApp({setup(){return()=>h(Page,{ref:page,embedded:true,unified:true,controlsOnly:true,contextual:contextual.value,part:part.value,active:active.value,initialProjectId:stored.id,initialGroup:group.value,previewAdapter:adapter.value,onGroupChange:value=>group.value=value})}}).use(createPinia()).mount('#app');
const model=()=>page.value.previewModel;
const details=()=>document.querySelector('.workshop-shared-preview-options');
const button=label=>[...document.querySelectorAll('button')].find(element=>element.textContent.trim()===label);
const click=async label=>{expect(button(label),'missing '+label);button(label).click();await nextTick()};
const choose=async(label,value)=>{const element=document.querySelector('[aria-label="'+label+'"]');expect(element,'missing '+label);element.value=String(value);element.dispatchEvent(new Event('change',{bubbles:true}));await tick()};
const input=async(element,value)=>{expect(element,'missing input');element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}));await tick()};
window.prepareWorkshopKeyboard=async()=>{await settle(()=>model()?.project,'valid preview model not exposed');expect(!document.querySelector('iframe,.workshop-preview,.workshop-canvas-overlay'),'controls-only mounts another preview');expect(!details().open,'preview options default expanded');expect(!document.querySelector('[aria-label="预览缩放"]'),'private zoom survives common toolbar');details().querySelector('summary').focus()};
window.verifyWorkshopKeyboard=async()=>{await tick();expect(details().open,'Enter cannot open preview options');const style=getComputedStyle(document.activeElement);expect(style.outlineStyle==='solid'&&style.outlineWidth==='2px','summary has no visible native focus');const rgb=style.outlineColor.match(/[\\d.]+/g).slice(0,3).map(Number);expect(Math.max(...rgb)-Math.min(...rgb)<=4,'shared controls use a blue focus');for(const element of details().querySelectorAll('select,button'))expect(element.getBoundingClientRect().height>=32,'shared preview controls too small')};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject,started:false}};
let pendingSwitch,switchBarrier,protectedInput,protectedValue,protectedName;
window.prepareWorkshopBusy=async phase=>{
 active.value=true;group.value='项目';await tick();await settle(()=>!page.value.state.busy,'editor never releases initialization busy');
 protectedInput=document.querySelector('[data-workshop-field="name"] input');
 if(phase==='save')await input(protectedInput,'Protected draft');
 protectedInput.focus();protectedValue=protectedInput.value;protectedName=model().project.name;
 switchBarrier=deferred();
 if(phase==='save'){saveBarrier=switchBarrier;pendingSwitch=page.value.prepareLeave()}
 else{getBarrier=switchBarrier;pendingSwitch=page.value.selectKey(nextProject.id)}
 await settle(()=>switchBarrier.started&&page.value.state.busy,'deferred '+phase+' leaves fields active');
 expect([...document.querySelectorAll('[data-workshop-field] input,[data-workshop-field] textarea')].every(element=>element.disabled),'project inputs enabled during '+phase);
 expect([...details().querySelectorAll('button,select')].every(element=>element.disabled)&&!model().canvasEditing,'shared view remains editable during '+phase);
 protectedInput.focus();expect(document.activeElement!==protectedInput,'disabled '+phase+' input accepts keyboard focus');
 expect(await page.value.prepareLeave()===false,'busy editor permits reentrant leaving');
 await page.value.perform('undo');expect(model().project.name===protectedName,'busy undo mutates the pending draft');
};
window.finishWorkshopBusy=async phase=>{
 await tick();expect(protectedInput.value===protectedValue&&model().project.name===protectedName,'native typing changed a draft awaiting '+phase);
 if(phase==='save'){
  switchBarrier.reject(Error('Delayed save failed'));
  expect(await pendingSwitch===false,'failed save allows project switch');await tick();
  expect(!page.value.state.busy&&model().project.name===protectedName&&document.querySelector('[data-workshop-field="name"] input').value===protectedValue,'failed save loses draft or busy lock');
  expect(page.value.state.error==='Delayed save failed','failed save discards its error');
  expect(await page.value.prepareLeave()===true,'failed save cannot be retried');
 }else{
  switchBarrier.resolve();await pendingSwitch;await settle(()=>model().project.id===nextProject.id&&!page.value.state.busy,'loaded project remains locked');
  const name=document.querySelector('[data-workshop-field="name"] input');expect(!name.disabled&&name.value===nextProject.name,'next project metadata is stale or disabled');
  expect(stored.name==='Protected draft','switch failed to retain the old saved draft');
 }
};
window.runSharedWorkshopTests=async()=>{
 await settle(()=>document.body.textContent.includes('共享预览尚未就绪'),'absent adapter pretends diagnostics pass');
 await click('完整检查');await settle(()=>document.body.textContent.includes('完整检查未完成')&&!button('取消检查'),'unavailable full check declares success');
 let inspections=0,highlights=[];
 adapter.value={inspect:async()=>{inspections++;return [{id:'adapter-warning',code:'adapter-warning',severity:'warning',message:'共同画布上的实际问题',location:{kind:'preview',id:'.actual-target'}}]},highlight:selector=>highlights.push(selector)};
 await settle(()=>inspections>0&&!document.body.textContent.includes('共享预览尚未就绪'),'ready adapter does not recover runtime inspection');
 await click('查看问题');const issue=[...document.querySelectorAll('.workshop-diagnostic-location')].find(element=>element.textContent.includes('共同画布上的实际问题'));expect(issue,'shared warning is not discoverable');issue.click();await tick();
 expect(highlights[0]==='.actual-target','diagnostic highlight bypasses the common document');
 await choose('页面','streaming-list');await choose('预览宽度',760);await choose('预览状态','selected');
 expect(model().scene.surface==='streaming-list'&&model().scene.width===760&&model().scene.state==='selected','shared page/width/state not exposed');
 await click('画布编辑');expect(!model().canvasEditing,'experience controls cannot disable the layer overlay');await click('体验控件');
 expect(model().canvasEditing&&saves===0,'view controls edit or save project content');
 adapter.value={inspect:async()=>{inspections++;throw Error('not ready')},highlight:()=>{}};
 await settle(()=>document.body.textContent.includes('共享预览尚未就绪'),'failed adapter is silently treated as a valid preview');
 const scenes=[];let releaseFirst;const firstCheck=new Promise(resolve=>releaseFirst=resolve);let held=false;
 adapter.value={inspect:async()=>{inspections++;await nextTick();if(model().checking){scenes.push({...model().scene});if(!held){held=true;await firstCheck}}return []},highlight:()=>{}};
 await settle(()=>!document.body.textContent.includes('共享预览尚未就绪'),'recovered adapter stays unavailable');
 await click('完整检查');await settle(()=>held,'full check never reaches shared source');
 expect([...details().querySelectorAll('button,select')].every(element=>element.disabled)&&!model().canvasEditing,'checking leaves shared view/layer controls active');
 releaseFirst();await settle(()=>!model().checking&&document.body.textContent.includes('已检查 224 个场景'),'full scenario matrix is not preserved');
 expect(scenes.length===224&&new Set(scenes.map(scene=>JSON.stringify(scene))).size===224,'full check skips or duplicates a source scene');
 expect(new Set(scenes.map(scene=>scene.surface)).size===6&&new Set(scenes.map(scene=>scene.tone)).size===2&&new Set(scenes.map(scene=>scene.width)).size===4,'full check drops pages, tones, or widths');
 expect(scenes.some(scene=>scene.surface==='streaming'&&scene.state==='loading')&&scenes.some(scene=>scene.surface==='library'&&scene.state==='selected'),'loading/selected preview states dropped');
 expect(model().scene.surface==='streaming-list'&&model().scene.width===760&&model().scene.state==='selected','full check does not restore the chosen view');
 page.value.chooseLayer('shared-layer','app');await tick();expect(model().selectedLayer==='shared-layer'&&button('复制图层'),'layer selection not routed to its properties');
 page.value.gesture('begin');page.value.editLayer('shared-layer','app',{x:65});page.value.editLayer('shared-layer','app',{x:80});page.value.gesture('end');
 await settle(()=>model().project.layers.pureWhite.app[0].x===80,'shared drag does not update last valid preview');
 await page.value.perform('undo');await settle(()=>model().project.layers.pureWhite.app[0].x===40,'shared drag is not one undo');
 page.value.gesture('begin');page.value.editLayer('shared-layer','app',{x:70});page.value.gesture('cancel');await settle(()=>model().project.layers.pureWhite.app[0].x===40,'shared gesture cancel loses the project snapshot');
 group.value='项目';await tick();await input(document.querySelector('[data-workshop-field="name"] input'),'');
 expect(await page.value.prepareLeave()===false,'invalid project metadata allows leaving the combined editor');
 group.value='高级 CSS';await tick();group.value='项目';await tick();expect(document.querySelector('[data-workshop-field="name"] input').value==='','property switching drops metadata buffer');
 await input(document.querySelector('[data-workshop-field="name"] input'),'Shared theme');
 group.value='高级 CSS';await tick();const oldCss=model().css;
 await input(document.querySelector('[aria-label="高级 CSS"]'),'.card{color red;}');
 await settle(()=>document.body.textContent.includes('最近有效预览'),'invalid CSS clears valid project preview');expect(model().css===oldCss&&model().project.css!=='.card{color red;}','preview model leaks invalid draft CSS');
 await input(document.querySelector('[aria-label="高级 CSS"]'),'.card{border-width:2px}');await settle(()=>model().project.css==='.card{border-width:2px}','fixed CSS does not resume the shared model');
 await page.value.perform('export');await page.value.perform('export-plugin');
 expect(exports.map(item=>item.format).join(',')==='project,tep'&&preflights.length===1&&exports.every(item=>item.revision===stored.revision),'shared controls change project/installer export validation');
 group.value='高级 CSS';await tick();const beforeHidden=model().css;
 const cssInput=document.querySelector('[aria-label="高级 CSS"]');cssInput.value='.card{border-width:3px}';cssInput.dispatchEvent(new Event('input',{bubbles:true}));active.value=false;await tick();
 expect(!model().canvasEditing,'inactive editor leaves its canvas editable');const inactiveInspections=inspections;await delay(350);expect(inspections===inactiveInspections&&model().css===beforeHidden,'inactive properties inspect another active canvas or compile a queued draft');
 active.value=true;await settle(()=>model().project.css==='.card{border-width:3px}','resume fails to compile the latest paused draft');await delay(300);
 group.value='项目';await tick();let releaseHidden;const hiddenCheck=new Promise(resolve=>releaseHidden=resolve);let hiddenStarted=false,hiddenScans=0;
 adapter.value={inspect:async()=>{inspections++;if(model().checking){hiddenScans++;hiddenStarted=true;await hiddenCheck}return []},highlight:()=>{}};
 await click('完整检查');await settle(()=>hiddenStarted,'hidden cancellation test never reaches its first scene');active.value=false;await tick();expect(!model().checking&&!model().canvasEditing,'hidden scene scan retains busy or edit state');const hiddenInspections=inspections;releaseHidden();await delay(350);
 expect(hiddenScans===1&&inspections===hiddenInspections&&!document.body.textContent.includes('已检查 224 个场景'),'hidden scene scan continues or publishes a stale completion');
 expect(!document.querySelector('iframe,.workshop-preview,.workshop-canvas-overlay'),'old preview returns during shared operations');
 expect(window.__businessWrites.length===0,'shared properties wrote settings or playback');
 return {isolatedCanvases:0,scenes:scenes.length,nativeKeyboard:true,metadataProtected:true,lastValidCss:true,hiddenDraftDeferred:true,hiddenCheckCancelled:true,gestureUndo:true,exports:exports.map(item=>item.format),saves};
};
`

const contextualRuntime = `
const popup=()=>document.querySelector('.workshop-workspace[popover]');
const shown=element=>!!element&&element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden';
const contextButton=label=>[...document.querySelectorAll('.workshop-context-bar button')].find(element=>element.textContent.trim()===label);
const visibleButton=label=>[...document.querySelectorAll('button')].find(element=>element.textContent.trim()===label&&shown(element));
const contextClick=async label=>{const target=visibleButton(label);expect(target&&!target.disabled,'missing enabled contextual action '+label);target.click();await tick()};
const open=async tool=>{await page.value.openTools(tool);await tick();expect(popup().matches(':popover-open'),'contextual popup failed to open '+tool)};
const nativeText=text=>new Promise((resolve,reject)=>{window.__contextTextDone=error=>error?reject(Error(error)):resolve();console.log('CONTEXT_NATIVE_TEXT '+JSON.stringify(text))});
window.prepareContextWorkshopKeyboard=async()=>{
 await settle(()=>model()?.project&&!page.value.state.busy,'initial contextual model never ready');
 adapter.value={inspect:async()=>[],highlight:()=>{}};contextual.value=true;group.value='导航';await tick();
 expect(!shown(popup())&&!document.querySelector('iframe,.workshop-preview,.workshop-canvas-overlay'),'contextual mode mounts another workspace');
 expect([...popup().querySelectorAll('input,select,textarea')].every(element=>!shown(element)),'closed contextual details are visible');
 expect(shown(document.querySelector('[data-workshop-direct-color]'))&&shown(document.querySelector('[aria-label="当前颜色对象"]')),'floating toolbar hides actual color controls');
 expect(document.querySelector('.workshop-context-unavailable')?.textContent.includes('无独立材质参数')&&!document.querySelector('[data-workshop-direct-material]'),'unsupported part has a fake material selector');
 contextButton('更多').focus();
};
window.verifyContextWorkshopKeyboard=async opened=>{
 await tick();expect(popup().matches(':popover-open')===opened,'native keyboard failed to '+(opened?'open':'close')+' contextual popover');
 if(opened){expect(popup().contains(document.activeElement),'opened editor has no focus '+JSON.stringify({tag:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label'),text:document.activeElement.textContent.slice(0,80)}));expect(contextButton('更多').getAttribute('aria-expanded')==='true','more anchor has no expanded state');const style=getComputedStyle(document.activeElement);expect(style.outlineStyle==='solid'&&style.outlineWidth==='2px','contextual native focus is not visible');const rgb=style.outlineColor.match(/[\\d.]+/g).slice(0,3).map(Number);expect(Math.max(...rgb)-Math.min(...rgb)<=4,'contextual focus uses a theme blue')}
 else expect(document.activeElement===contextButton('更多')&&contextButton('更多').getAttribute('aria-expanded')==='false','Escape does not restore the trigger focus');
};
window.openContextOutsideTest=()=>open('layers');
window.verifyContextOutsideTest=async()=>{await tick();expect(!popup().matches(':popover-open'),'native outside click does not dismiss tools')};
window.runContextWorkshopTests=async()=>{
 await choose('当前颜色对象','token:navigation.surface');await input(document.querySelector('[data-workshop-direct-color]'),'#234567');
 await settle(()=>model().project.tokens.pureWhite['navigation.surface']?.replace(/\\s/g,'')==='rgba(35,69,103,0.94)','floating native color is not bound to the selected token');
 expect(!popup().matches(':popover-open'),'editing floating color opens a category pane');await page.value.perform('undo');await tick();
 await open('color');expect(document.querySelectorAll('[data-studio-setting]').length===1,'color tool exposes many unrelated controls');
 const selection=document.querySelector('[aria-label="颜色对象"]');expect([...selection.options].every(option=>option.value.startsWith('token:navigation.')),'navigation color choices leak other components');
 await choose('颜色对象','token:navigation.surface');const colorsBefore=JSON.stringify(model().project.tokens.pureWhite);
 await input(document.querySelector('[data-studio-setting="navigation.surface"] input[type="color"]'),'#234567');
 await settle(()=>model().project.tokens.pureWhite['navigation.surface']?.replace(/\\s/g,'')==='rgba(35,69,103,0.94)','selected navigation color does not update the draft while preserving opacity');
 expect(model().project.tokens.pureWhite['surface.card']===undefined&&colorsBefore!=='','navigation color mutates card');
 part.value='background';await tick();expect(!popup().matches(':popover-open'),'changing selected part leaves stale properties open');
 expect(document.querySelector('[aria-label="当前颜色对象"]').value==='control:paper','floating color prioritizes a token overridden by actual source CSS');
 await input(document.querySelector('[data-workshop-direct-color]'),'#345678');await settle(()=>model().project.values.pureWhite.paper==='#345678','floating color bypasses the source binding');
 await open('color');await choose('颜色对象','control:paper');await input(document.querySelector('[data-workshop-control="paper"] input[type="color"]'),'#345678');
 await settle(()=>model().project.values.pureWhite.paper==='#345678','source color is not bound to selected background');
 expect(model().project.tokens.pureWhite['navigation.surface'].replace(/\\s/g,'')==='rgba(35,69,103,0.94)','source color overwrites another component');
 part.value='card';await tick();const material=document.querySelector('[data-workshop-direct-material]');expect(material&&material.getAttribute('aria-label')==='卡片材质','source material is not directly selectable');material.value='blur(12px)';material.dispatchEvent(new Event('change',{bubbles:true}));await settle(()=>model().project.values.pureWhite['context-material']==='blur(12px)'&&model().css.includes('--context-material:blur(12px)'),'direct material does not compile its source value');
 await open('more');expect(!document.querySelector('[data-workshop-control="radius"]')&&!document.querySelector('[data-studio-setting*="radius"]'),'paused corner structure remains adjustable');
 expect(model().project.base.editor.controls.some(control=>control.id==='radius'),'compact mode destroys public radius declarations');
 await open('project');const name=document.querySelector('[data-workshop-field="name"] input');const beforeName=model().project.name;await input(name,'');
 page.value.closeTools(true);await tick();expect(name.isConnected&&!shown(name),'closing tools destroys or paints the metadata buffer');
 await open('project');expect(document.querySelector('[data-workshop-field="name"] input')===name&&name.value==='','reopening loses invalid metadata buffer');
 expect(await page.value.prepareLeave()===false&&model().project.name===beforeName,'invalid metadata escapes leave protection');
 await input(name,beforeName);await settle(()=>!page.value.state.busy,'metadata validation remains locked');
 await open('more');page.value.selectGroup('参数设计器');await tick();await contextClick('＋ 新增参数');
 const form=document.querySelector('.workshop-designer-form');const label=[...form.querySelectorAll('label')].find(element=>element.textContent.trim()==='名称').querySelector('input');await input(label,'');
 page.value.closeTools(true);await tick();await open('more');page.value.selectGroup('参数设计器');await tick();
 expect(document.querySelector('.workshop-designer-form')===form&&label.value==='','closing tools discards parameter declaration buffer');
 expect(await page.value.prepareLeave()===false,'invalid parameter buffer bypasses draft protection');
 await input(label,'Context color');await contextClick('取消');
 api.importAsset=async()=>({id:'context-image',name:'Context image',type:'image',license:'CC0',source:'fixture',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII='});
 await open('assets');await contextClick('＋ 图片');await settle(()=>model().project.assets?.some(asset=>asset.id==='context-image'),'on-demand image import is lost');
 await open('images');expect(document.querySelector('[data-workshop-control="image"]'),'source image parameter is undiscoverable');await choose('使用素材库图片','context-image');
 await settle(()=>model().project.values.pureWhite.image?.includes('data:image/png'),'source image cannot reuse imported resources');
 part.value='background';await tick();const directImage=document.querySelector('[data-workshop-direct-image]');expect(directImage&&directImage.value==='context-image','floating image selector loses the chosen asset');directImage.value='none';directImage.dispatchEvent(new Event('change',{bubbles:true}));await settle(()=>model().project.values.pureWhite.image==='none','floating image removal is disconnected');directImage.value='context-image';directImage.dispatchEvent(new Event('change',{bubbles:true}));await settle(()=>model().project.values.pureWhite.image?.includes('data:image/png'),'floating image selection does not reuse imported resource');
 await open('layers');page.value.chooseLayer('shared-layer','app');await tick();expect(visibleButton('复制图层'),'selected layer has no editor');
 page.value.gesture('begin');page.value.editLayer('shared-layer','app',{x:88});page.value.gesture('end');await settle(()=>model().project.layers.pureWhite.app[0].x===88,'contextual drag loses layer edit');
 await page.value.perform('undo');await settle(()=>model().project.layers.pureWhite.app[0].x===40,'contextual layer gesture is not one undo');
 await open('preview');await choose('页面','settings');await choose('预览宽度',760);await choose('预览状态','loading');
 expect(model().scene.surface==='settings'&&model().scene.width===760&&model().scene.state==='loading','on-demand preview settings are disconnected');
 let releaseCheck;const held=new Promise(resolve=>releaseCheck=resolve);let started=false;
 adapter.value={inspect:async()=>{if(model().checking&&!started){started=true;await held}return []},highlight:()=>{}};
 await open('diagnostics');await contextClick('完整检查');await settle(()=>started,'contextual check never reaches common canvas');
 expect([...document.querySelectorAll('.workshop-context-bar input,.workshop-context-bar select,.workshop-context-bar button:not([aria-haspopup])')].every(element=>element.disabled)&&!model().canvasEditing,'checking permits floating edit');
 page.value.closeTools(true);await tick();await open('diagnostics');expect(visibleButton('取消检查'),'closed diagnostics cannot be reopened to cancel');await contextClick('取消检查');releaseCheck();await settle(()=>!model().checking,'contextual cancellation remains busy');
 await open('project');await input(document.querySelector('[data-workshop-field="name"] input'),'Context saved');const barrier=deferred();saveBarrier=barrier;const pending=page.value.prepareLeave();
 await settle(()=>barrier.started&&page.value.state.busy,'contextual save not held');
 expect([...document.querySelectorAll('.workshop-context-bar button,.workshop-context-bar input,.workshop-context-bar select')].every(element=>element.disabled),'saving leaves floating actions available');
 const protectedName=model().project.name;const protectedField=document.querySelector('[data-workshop-field="name"] input');expect(protectedField.disabled,'contextual field remains enabled during save');protectedField.focus();expect(document.activeElement!==protectedField,'disabled contextual field takes focus');await nativeText('must not replace');await tick();await page.value.perform('undo');
 await page.value.openTools('assets');expect(model().project.name===protectedName&&popup().getAttribute('aria-label')==='项目与版本','saving mutates draft or switches properties');
 barrier.reject(Error('Context save failed'));expect(await pending===false,'failed contextual save permits leave');await tick();
 expect(document.querySelector('[data-workshop-field="name"] input').value===protectedName,'failed contextual save loses typed draft');
 expect(await page.value.prepareLeave()===true,'contextual save cannot retry');
 await page.value.perform('export');await page.value.perform('export-plugin');expect(exports.map(item=>item.format).join(',')==='project,tep'&&preflights.length===1,'on-demand export validation changed');
 await open('assets');active.value=false;await tick();expect(!popup().matches(':popover-open')&&!model().canvasEditing,'inactive contextual editor remains open or editable');
 active.value=true;await tick();expect(!popup().matches(':popover-open'),'resuming reopens old tools');
 expect(!document.querySelector('iframe,.workshop-preview,.workshop-canvas-overlay')&&window.__businessWrites.length===0,'contextual properties mount private canvas or write playback/settings');
 return {nativeKeyboard:true,metadataPreserved:true,parameterBufferPreserved:true,scenesPreserved:true,busyProtected:true,directControls:true,floatingToolbar:true,isolatedCanvases:0,exports:exports.map(item=>item.format),responsiveStates:0};
};
window.prepareContextScreenshot=async(toneValue,expanded)=>{
 page.value.closeTools();document.documentElement.dataset.theme=toneValue;page.value.setTone(toneValue);part.value='background';document.querySelector('.fixture').style.setProperty('--te-font-size-body',expanded?'20px':'14px');await tick();await tick();
 if(expanded)await open('color');
 const bar=document.querySelector('.workshop-context-bar'),rect=bar.getBoundingClientRect();const children=[...bar.children].map(child=>child.getBoundingClientRect());
 expect(bar.scrollWidth<=bar.clientWidth+1&&children.every(child=>child.left>=rect.left&&child.right<=rect.right)&&document.documentElement.scrollWidth<=innerWidth,'floating toolbar exceeds its available width '+innerWidth+' '+toneValue);
 expect(rect.width<=440&&rect.width<document.querySelector('.fixture').clientWidth&&rect.height<=(expanded?104:60),'floating workshop expands into a full-width or tall panel');
 for(const control of bar.querySelectorAll('input,select,button'))expect(control.getBoundingClientRect().height>=34,'floating control loses its 34px hit area');
 const style=getComputedStyle(bar);expect(style.borderTopWidth==='0px'&&getComputedStyle(contextButton('更多')).borderTopWidth==='0px','floating toolbar uses heavy outlined chrome');
 if(expanded){const panel=popup().getBoundingClientRect();expect(panel.left>=0&&panel.right<=innerWidth&&panel.top>=0&&panel.bottom<=innerHeight&&popup().scrollWidth<=popup().clientWidth+1,'contextual popup exceeds viewport');expect(Math.abs(parseFloat(getComputedStyle(popup()).fontSize)-20*15/14)<.1,'contextual popup suppresses accessible text size')}
};
window.verifyContextWorkshopCreation=async()=>{
 active.value=false;await tick();const originalList=api.list,originalCreate=api.create,originalSave=api.save;const initialization=deferred();api.list=async()=>{initialization.started=true;await initialization.promise;return []};
 let createCalls=0;api.create=async template=>{createCalls++;return workshopTemplate('00000000-0000-0000-0000-000000000003',template)};
 const host=document.createElement('div');host.className='fixture';document.body.append(host);const newcomer=ref(),newActive=ref(false),newSource=ref(),newPart=ref('appearance-theme');
 const newApp=createApp({setup(){return()=>h(Page,{ref:newcomer,embedded:true,unified:true,controlsOnly:true,contextual:true,part:newPart.value,active:newActive.value,initialSourceKey:newSource.value,startCreating:true,previewAdapter:{inspect:async()=>[],highlight:()=>{}}})}}).use(createPinia());
 newApp.mount(host);
 let mounted=true;
 try{
  const newPopup=()=>host.querySelector('.workshop-workspace[popover]');
  await settle(()=>newcomer.value&&newcomer.value.state.busy&&initialization.started,'initial new editor never holds initialization');
  let opens=0;newPopup().addEventListener('toggle',event=>{if(event.newState==='open')opens++});
  await newcomer.value.perform('create');await newcomer.value.perform('create');initialization.resolve();
  await settle(()=>!newcomer.value.state.busy,'new inactive editor remains busy after initialization');
  expect(!newPopup().matches(':popover-open')&&createCalls===0,'inactive initialization opens or creates a project');
  newActive.value=true;
  await settle(()=>newPopup().matches(':popover-open')&&opens===1,'new inactive project loses its guide when Root activates it');
  await tick();await tick();expect(opens===1&&createCalls===0,'duplicate pending creation reopens the guide or creates a draft');
  expect(newPopup().getAttribute('aria-label')==='新建项目'&&host.querySelectorAll('.workshop-template-grid button').length===6,'new project templates are hidden');
  host.querySelector('.workshop-template-grid button').click();await settle(()=>newcomer.value.previewModel.project&&!newcomer.value.state.busy,'new template cannot initialize a draft');
  expect(createCalls===1,'one template choice creates multiple projects');
  newcomer.value.closeTools();await tick();await newcomer.value.perform('create');await tick();
  expect(newPopup().matches(':popover-open')&&host.querySelectorAll('.workshop-template-grid button').length===6,'unified create action leaves the guide hidden');
  newcomer.value.closeTools();newPart.value='navigation';newActive.value=false;await tick();await newcomer.value.perform('create');await newcomer.value.perform('create');
  const previousOpens=opens;newPart.value='appearance-theme';await tick();newActive.value=true;
  await settle(()=>newPopup().matches(':popover-open')&&opens===previousOpens+1,'same-workshop new request is lost during Root switching');
  expect(createCalls===1,'same-workshop pending request creates instead of opening the guide');
  newcomer.value.closeTools();await newcomer.value.openTools('project');await tick();
  const name=host.querySelector('[data-workshop-field="name"] input');await input(name,'');const protectedProject=newcomer.value.previewModel.project;
  newActive.value=false;await tick();await newcomer.value.perform('create');newActive.value=true;await settle(()=>newPopup().matches(':popover-open'),'invalid metadata drops the explicit create request');
  host.querySelector('.workshop-template-grid button').click();await settle(()=>!newcomer.value.state.busy&&!!newcomer.value.state.error,'invalid metadata allows template creation');
  expect(createCalls===1&&name.value===''&&host.querySelector('[data-workshop-field="name"] input')===name&&newcomer.value.previewModel.project.id===protectedProject.id,'failed creation replaces the protected raw metadata or draft');
  newcomer.value.closeTools();await newcomer.value.openTools('project');await input(name,'Protected pending create');
  const saving=deferred();api.save=async()=>{saving.started=true;await saving.promise;throw Error('unreachable')};
  const leave=newcomer.value.prepareLeave();await settle(()=>saving.started&&newcomer.value.state.busy,'save is not held for pending-create regression');
  const beforeBusyOpens=opens;await newcomer.value.perform('create');await newcomer.value.perform('create');
  expect(newPopup().getAttribute('aria-label')==='项目与版本'&&name.disabled,'busy create switches tools or enables raw inputs');
  saving.reject(Error('Pending create save failed'));expect(await leave===false,'failed pending-create save allows leaving');
  await settle(()=>newPopup().getAttribute('aria-label')==='新建项目'&&newPopup().matches(':popover-open'),'busy create is lost after failed save unlocks');
  expect(opens===beforeBusyOpens&&createCalls===1&&name.value==='Protected pending create'&&host.querySelector('[data-workshop-field="name"] input')===name&&newcomer.value.previewModel.project.id===protectedProject.id,'pending guide loses the failed-save buffer or opens twice');
  newcomer.value.closeTools();newActive.value=false;await tick();await newcomer.value.perform('create');newSource.value='other:theme';await tick();newActive.value=true;await tick();await tick();
  expect(!newPopup().matches(':popover-open'),'source change revives a stale creation request');
  newActive.value=false;await tick();await newcomer.value.perform('create');
  let unavailable=false;try{await newcomer.value.selectKey('missing-project')}catch{unavailable=true}
  newActive.value=true;await tick();await tick();expect(unavailable&&!newPopup().matches(':popover-open')&&name.value==='Protected pending create','project switch keeps a stale guide or discards raw text');
  newActive.value=false;await tick();await newcomer.value.perform('create');const detached=newPopup();newApp.unmount();mounted=false;newActive.value=true;await tick();await tick();
  expect(!detached.isConnected&&!detached.matches(':popover-open')&&createCalls===1,'unmounted editor fulfills an obsolete creation request');
  expect(!host.querySelector('iframe,.workshop-preview'),'new project creates another canvas');
  return {newProjectReady:true,pendingCreateRestored:true,busyCreateProtected:true,staleCreateCanceled:true};
 }finally{if(mounted)newApp.unmount();host.remove();api.list=originalList;api.create=originalCreate;api.save=originalSave}
};
`
