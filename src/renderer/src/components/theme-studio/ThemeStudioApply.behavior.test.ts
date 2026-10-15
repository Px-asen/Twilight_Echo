import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('real theme store and editor keep the applied variant across IPC broadcasts and restore preference on leave', async () => {
  const temporaryRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(temporaryRoot, 'twilight-dark-apply-'))
  const reportDirectory = process.env.TWILIGHT_DARK_APPLY_REPORT_DIR
  try {
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    const editorFile = resolve('src/renderer/src/components/theme-studio/useThemeStudioEditor.ts')
    const storeFile = resolve('src/renderer/src/stores/useThemeStore.ts')
    const compiled: Record<string, string[]> = {}
    await writeFile(join(directory, 'entry.ts'), runtime.replaceAll('__RENDERER__', renderer))
    for (const variant of ['without-tone-restore', 'current']) {
      const seen = new Set<string>()
      let removed = 0
      await build({
        root: directory,
        configFile: false,
        logLevel: 'error',
        plugins: [
          {
            name: 'actual-theme-apply-boundaries',
            enforce: 'pre',
            resolveId(source) {
              const id = source.replace(/\.ts$/, '')
              if (id.endsWith('/extensions/registry')) return '\0dark-apply-registry'
              if (id.endsWith('/stores/useSettingsStore')) return '\0dark-apply-settings'
              return null
            },
            load(id) {
              if (id === '\0dark-apply-registry') return registryBoundary
              if (id === '\0dark-apply-settings') return settingsBoundary
              return null
            },
            transform(source, id) {
              if (id.replaceAll('\\', '/') === editorFile.replaceAll('\\', '/')) {
                seen.add('useThemeStudioEditor')
                if (variant === 'without-tone-restore') {
                  // A negative control changes only this compiled copy. Never edit product source.
                  const start = source.indexOf('  async function applySelected()')
                  const end = source.indexOf('  async function deleteSelected()', start)
                  assert.ok(start >= 0 && end > start)
                  const body = source.slice(start, end)
                  const statement = 'await themeStore.setPreviewTone(tone.value)'
                  assert.equal(body.split(statement).length - 1, 1)
                  removed++
                  return source.slice(0, start) + body.replace(statement, '') + source.slice(end)
                }
              }
              if (id.replaceAll('\\', '/') === storeFile.replaceAll('\\', '/'))
                seen.add('useThemeStore')
              return null
            }
          }
        ],
        resolve: {
          alias: {
            '@renderer': renderer,
            '@shared': resolve('src/shared'),
            vue: require.resolve('vue/dist/vue.runtime.esm-bundler.js')
          }
        },
        define: { 'process.env.NODE_ENV': '"production"' },
        build: {
          outDir: variant,
          minify: false,
          lib: {
            entry: join(directory, 'entry.ts'),
            name: 'DarkApply',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      assert.deepEqual([...seen].sort(), ['useThemeStore', 'useThemeStudioEditor'])
      assert.equal(removed, variant === 'without-tone-restore' ? 1 : 0)
      compiled[variant] = [...seen].sort()
      const files = await readdir(join(directory, variant))
      await writeFile(
        join(directory, variant, 'index.html'),
        `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8"></head><body><div id="mount"></div><div id="paint" style="width:80px;height:40px;background:var(--te-app-bg)">Theme surface</div><script src="${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
      )
    }
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      {
        env,
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024
      }
    )
    const evidence = JSON.parse(result.stdout.match(/DARK_APPLY_RESULT (.*)/)![1])
    assert.equal(evidence.networkRequests, 0)
    assert.equal(evidence.negativeControl.reproduced, true)
    assert.match(evidence.negativeControl.message, /^DARK_APPLY_TONE /)
    assert.equal(evidence.negativeControl.actualTone, 'pureWhite')
    assert.equal(evidence.scenarios.length, 4)
    for (const scenario of evidence.scenarios) {
      assert.equal(scenario.settingsWrites, 0)
      assert.equal(scenario.savedProfiles, 2)
      assert.equal(scenario.sameProfileSavedTwice, true)
      assert.equal(scenario.sameRevisionPreservesTone, true)
      assert.equal(scenario.leaveRestoresPreference, true)
      assert.equal(scenario.failedSaveKeepsDraftAndTone, true)
      assert.equal(scenario.failedActivationKeepsDraftAndTone, true)
    }
    evidence.realModules = compiled
    evidence.sourceSha256 = Object.fromEntries(
      await Promise.all(
        [editorFile, storeFile].map(async (file) => [
          file.replaceAll('\\', '/'),
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex')
        ])
      )
    )
    if (reportDirectory) {
      await mkdir(reportDirectory, { recursive: true })
      await writeFile(
        join(reportDirectory, 'dark-apply-result.json'),
        JSON.stringify(evidence, null, 2) + '\n'
      )
    }
    console.log(`DARK_APPLY_RESULT ${JSON.stringify(evidence)}`)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(temporaryRoot))
    assert.ok(basename(directory).startsWith('twilight-dark-apply-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const registryBoundary = `
import {ref} from 'vue';
const themeContributions=ref([]);
export const useExtensionRegistry=()=>({themeContributions,syncExtensions:async()=>{}});
`
const settingsBoundary = `
import {ref} from 'vue';
export const useSettingsStore=()=>({settings:ref(window.fixtureSettings),updateSettings:async()=>{window.settingsWrites++;throw Error('Unexpected settings write')}});
`

const runtime = String.raw`
import {createApp,h,nextTick} from 'vue';
import {useThemeStore} from '__RENDERER__/stores/useThemeStore.ts';
import {useThemeStudioEditor} from '__RENDERER__/components/theme-studio/useThemeStudioEditor.ts';
import {storeThemeStudioRecovery} from '__RENDERER__/components/theme-studio/themeStudioRecovery.ts';
import {createDefaultThemeLibraryDocument,normalizeThemeProfile,THEME_TOKEN_DEFINITIONS,TWILIGHT_DEFAULT_THEME,TWILIGHT_DEFAULT_THEME_ID} from '__RENDERER__/../../shared/theme.ts';
import {normalizeAppBackgroundSettings,defaultCardAppearance} from '__RENDERER__/../../shared/appAppearance.ts';
import {DEFAULT_LIQUID_GLASS} from '__RENDERER__/../../shared/liquidGlass.ts';

const expect=(value,message)=>{if(!value)throw Error(message)};
const copy=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,15));await nextTick()};
const until=async(predicate,message)=>{for(let i=0;i<150;i++){if(predicate())return;await settle()}throw Error(message)};
const token=THEME_TOKEN_DEFINITIONS.find(value=>value.id==='surface.app');
const paint=()=>getComputedStyle(document.getElementById('paint')).backgroundColor;
const color=value=>{const node=document.createElement('i');node.style.color=value;document.body.append(node);const result=getComputedStyle(node).color;node.remove();return result};
const listeners=new Set(),systemListeners=new Set(),settingsListeners=new Set(),pluginListeners=new Set();
const timeline=[],saved=[],activations=[],deferred=[];
let library,configuration,failSave=false,failActive=false;
window.settingsWrites=0;
const snapshot=()=>copy(library);
const broadcast=next=>{timeline.push({event:'broadcast',revision:next.revision,active:next.data.activeTheme});for(const listener of listeners)listener(copy(next))};
const publish=async(kind,next)=>{if(configuration.order==='before'){broadcast(next);await Promise.resolve();await Promise.resolve()}else deferred.push(copy(next));timeline.push({event:kind+'-return',revision:next.revision});return copy(next)};
const drain=async()=>{while(deferred.length)broadcast(deferred.shift());await settle()};
const revision=expected=>expect(expected===library.revision,'Fixture CAS mismatch '+expected+'/'+library.revision);
window.api={
 app:{getStartupSnapshot:async()=>null},
 settings:new Proxy({get:async()=>({settings:copy(window.fixtureSettings)}),onChanged:callback=>{settingsListeners.add(callback);return()=>settingsListeners.delete(callback)}},{get:(target,key)=>key in target?target[key]:(()=>{window.settingsWrites++;throw Error('Unexpected settings IPC write '+String(key))})}),
 plugins:{onChanged:callback=>{pluginListeners.add(callback);return()=>pluginListeners.delete(callback)}},
 themes:{
  getBootstrap:async()=>({library:snapshot(),defaultTheme:TWILIGHT_DEFAULT_THEME}),getSystemTone:async()=>configuration.preference,
  onChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},onSystemToneChanged:callback=>{systemListeners.add(callback);return()=>systemListeners.delete(callback)},validateAssets:async()=>true,
  save:async(profile,expected)=>{timeline.push({event:'save-call',revision:expected});revision(expected);if(failSave){failSave=false;throw Error('fixture save failed')}const normalized=normalizeThemeProfile(copy(profile));expect(normalized,'Invalid saved theme');library={...library,revision:library.revision+1,savedAt:new Date().toISOString(),data:{...library.data,profiles:[...library.data.profiles.filter(item=>item.id!==profile.id),normalized]}};saved.push(copy(normalized));return publish('save',snapshot())},
  setActive:async(selection,expected)=>{timeline.push({event:'active-call',revision:expected});revision(expected);if(failActive){failActive=false;throw Error('fixture activate failed')}library={...library,revision:library.revision+1,savedAt:new Date().toISOString(),data:{...library.data,activeTheme:copy(selection)}};activations.push(copy(selection));return publish('active',snapshot())}
 }
};

window.runDarkApply=async options=>{
 configuration=options;sessionStorage.clear();storeThemeStudioRecovery(null);
 library={version:2,revision:0,savedAt:'2026-10-15T00:00:00.000Z',data:createDefaultThemeLibraryDocument()};
 window.fixtureSettings={theme:options.preference,accentColor:'blue',lightAccentColor:'blue',darkAccentColor:'blue',fontFamily:'system',fontRendering:'auto',uiDensity:'comfortable',appBackground:normalizeAppBackgroundSettings(),cardAppearance:defaultCardAppearance(),surfaceMaterial:'standard',liquidGlass:copy(DEFAULT_LIQUID_GLASS)};
 document.documentElement.dataset.theme=options.preference;
 let editor;
 const app=createApp({setup(){editor=useThemeStudioEditor({editable:true,initialKey:'preset:'+TWILIGHT_DEFAULT_THEME_ID,onBack:()=>{}});return()=>h('div','Real editor/store lifecycle')}});
 app.mount('#mount');await until(()=>editor.ready.value,'Editor did not finish real bootstrap');
 const store=useThemeStore();expect(listeners.size===1,'Real theme store did not subscribe to broadcasts');expect(!editor.localError.value,'Editor bootstrap error '+editor.localError.value);
 const baselineSettings=JSON.stringify(window.fixtureSettings);
 const target=options.preference==='pureWhite'?'dark':'pureWhite';
 const colors={dark:'#172a43',pureWhite:'#eee3ce'};
 await editor.setTone('dark');editor.updateToken(token,colors.dark);
 await editor.setTone('pureWhite');editor.updateToken(token,colors.pureWhite);
 await editor.setTone(target);await until(()=>paint()===color(colors[target]),'Unsaved variant is not visibly previewed');
 const profileId=editor.draft.value.id;
 const toneIs=(wanted,stage)=>{
  if(document.documentElement.dataset.theme!==wanted)throw Error('DARK_APPLY_TONE '+JSON.stringify({stage,wanted,actual:document.documentElement.dataset.theme,editorTone:editor.tone.value,paint:paint(),order:options.order,preference:options.preference}));
  expect(paint()===color(colors[wanted]),'Saved variant did not paint its own surface at '+stage+': '+paint());
 };
 const correctSaved=(profile,stage)=>{
  expect(profile.id===profileId&&profile.overrides.dark['surface.app']===colors.dark&&profile.overrides.pureWhite['surface.app']===colors.pureWhite,'Tone overrides crossed or were lost at '+stage);
 };
 await editor.applySelected();await settle();
 expect(!editor.localError.value,'First apply failed '+editor.localError.value);
 toneIs(target,'first-apply');
 expect(saved.length===1&&activations.length===1&&!editor.isDirty.value,'First apply is not one clean saved activation');correctSaved(saved[0],'first-save');
 await drain();toneIs(target,'late-first-broadcast');
 const firstRevision=library.revision;broadcast(snapshot());await settle();toneIs(target,'same-revision-broadcast');expect(store.snapshot.value.revision===firstRevision,'Duplicate broadcast changes accepted revision');

 colors[target]=target==='dark'?'#243d56':'#f3e5d7';editor.updateToken(token,colors[target]);
 expect(editor.isDirty.value,'Second edit is not dirty');await editor.applySelected();await settle();await drain();
 toneIs(target,'same-profile-second-save');expect(!editor.localError.value&&!editor.isDirty.value&&saved.length===2&&activations.length===2,'Repeat save did not settle cleanly');correctSaved(saved[1],'second-save');
 expect(store.activeProfile.value.id===profileId&&store.activeProfile.value.overrides[target]['surface.app']===colors[target],'Store active profile does not contain the saved variant');
 await editor.applySelected();await settle();await drain();toneIs(target,'clean-repeat-apply');expect(saved.length===2&&activations.length===3,'Clean apply unexpectedly saved another copy');

 const cleanDraft=JSON.stringify(editor.draft.value),committed=JSON.stringify(library);
 failActive=true;await editor.applySelected();await settle();
 expect(editor.localError.value.includes('fixture activate failed')&&JSON.stringify(editor.draft.value)===cleanDraft&&JSON.stringify(library)===committed,'Failed activation changes the confirmed theme or draft');toneIs(target,'failed-activation');
 editor.updateToken(token,target==='dark'?'#0b1f2d':'#f0e8d5');const dirtyDraft=JSON.stringify(editor.draft.value);
 failSave=true;await editor.applySelected();await settle();
 expect(editor.localError.value.includes('fixture save failed')&&editor.isDirty.value&&JSON.stringify(editor.draft.value)===dirtyDraft&&JSON.stringify(library)===committed,'Failed save discards draft, clears dirty state or partially commits');toneIs(target,'failed-save');
 window.confirm=()=>false;expect(!await editor.prepareLeave(),'Denied leave succeeded');expect(editor.isDirty.value&&JSON.stringify(editor.draft.value)===dirtyDraft,'Denied leave discards the failed draft');toneIs(target,'denied-leave');
 window.confirm=()=>true;expect(await editor.prepareLeave(),'Approved leave failed');await settle();
 expect(document.documentElement.dataset.theme===options.preference&&paint()===color(colors[options.preference]),'Leaving preview did not restore stored tone and active theme');
 expect(store.previewProfile.value===null&&store.previewSelection.value===null,'Leaving retains a theme preview selection');
 app.unmount();await settle();expect(document.documentElement.dataset.theme===options.preference,'Unmount restores the preview tone instead of stored preference');
 expect(window.settingsWrites===0&&JSON.stringify(window.fixtureSettings)===baselineSettings,'Editor persists or mutates stored settings');
 expect(saved.every(profile=>profile.id===profileId)&&library.data.profiles.length===1,'Repeat saves created duplicate profiles');
 const activeReturn=timeline.findIndex(entry=>entry.event==='active-return');const activeBroadcast=timeline.findIndex(entry=>entry.event==='broadcast'&&entry.revision===2);
 expect(activeReturn>=0&&activeBroadcast>=0&&(options.order==='before'?activeBroadcast<activeReturn:activeBroadcast>activeReturn),'Requested IPC/broadcast ordering was not exercised');
 return {order:options.order,storedPreference:options.preference,appliedTone:target,hostToneAfterLeave:document.documentElement.dataset.theme,savedProfiles:saved.length,sameProfileSavedTwice:true,cleanApplyDidNotSave:true,sameRevisionPreservesTone:true,failedActivationKeepsDraftAndTone:true,failedSaveKeepsDraftAndTone:true,deniedLeavePreservesDraft:true,leaveRestoresPreference:true,settingsWrites:window.settingsWrites,colors,timeline};
};
`

const runner = String.raw`
const {app,BrowserWindow,session}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.setPath('sessionData',path.join(__dirname,'session'));
app.whenReady().then(async()=>{
 let win;try{
  let networkRequests=0;session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{networkRequests++;callback({cancel:true})});
  win=new BrowserWindow({show:false,width:960,height:640,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});
  await win.loadFile(path.join(__dirname,'without-tone-restore/index.html'));
  let negativeControl;
  try{await win.webContents.executeJavaScript('window.runDarkApply('+JSON.stringify({order:'before',preference:'pureWhite'})+')');throw Error('Negative control did not detect the original dark apply regression')}
  catch(error){if(!error.message.startsWith('DARK_APPLY_TONE '))throw error;negativeControl={reproduced:true,message:error.message,actualTone:await win.webContents.executeJavaScript('document.documentElement.dataset.theme')};}
  const scenarios=[];
  for(const order of ['before','after'])for(const preference of ['pureWhite','dark']){
   await win.loadFile(path.join(__dirname,'current/index.html'));
   scenarios.push(await win.webContents.executeJavaScript('window.runDarkApply('+JSON.stringify({order,preference})+')'));
  }
  console.log('DARK_APPLY_RESULT '+JSON.stringify({negativeControl,scenarios,networkRequests}));win.destroy();app.exit(0);
 }catch(error){console.error(error.stack);win?.destroy();app.exit(1)}
});
`
