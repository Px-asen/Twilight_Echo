import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('actual theme editor restores draft and baseline without commits and clears recovery after success or approved leave', async () => {
  const temporaryRoot = await realpath(tmpdir())
  const directory = await mkdtemp(join(temporaryRoot, 'twilight-theme-recovery-'))
  try {
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    await writeFile(join(directory, 'entry.ts'), runtime.replaceAll('__RENDERER__', renderer))
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'theme-recovery-store-boundaries',
          enforce: 'pre',
          resolveId(source) {
            if (source.endsWith('/stores/useThemeStore')) return '\0recovery-theme-store'
            if (source.endsWith('/stores/useSettingsStore')) return '\0recovery-settings'
            if (source.endsWith('/extensions/registry')) return '\0recovery-registry'
            return null
          },
          load(id) {
            if (id === '\0recovery-registry')
              return "import {ref} from 'vue';export const useExtensionRegistry=()=>({themeContributions:ref([]),syncExtensions:async()=>{}})"
            if (id === '\0recovery-settings')
              return "import {ref} from 'vue';export const useSettingsStore=()=>({settings:ref({}),updateSettings:async()=>{window.commits.settings++}})"
            if (id === '\0recovery-theme-store') return themeStoreFixture
            return null
          }
        }
      ],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'ThemeRecoveryFixture',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html data-theme="dark"><body><script src="bundle/' +
        files.find((file) => file.endsWith('.js')) +
        '"></script></body></html>'
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /THEME_RECOVERY_OK/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(temporaryRoot))
    assert.ok(basename(directory).startsWith('twilight-theme-recovery-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const themeStoreFixture = `
import {ref,computed} from 'vue';
import {normalizeThemeProfile,TWILIGHT_DEFAULT_THEME_ID,isBuiltInThemePresetId} from '@renderer/../../shared/theme.ts';
const profiles=ref([]),activeTheme=ref({kind:'builtin',id:TWILIGHT_DEFAULT_THEME_ID}),saving=ref(false),error=ref('');
const snapshot=computed(()=>({data:{profiles:profiles.value,activeTheme:activeTheme.value,profileHistory:{},windowInheritance:{}}}));
const store={profiles,activeTheme,saving,error,snapshot,effectiveVariables:ref({}),
load:async()=>{},
setPreviewTone:async value=>{window.previews.tones.push(value)},
previewTheme:async value=>{window.previews.selections.push(value)},
preview:async value=>{window.previews.drafts.push(value?JSON.parse(JSON.stringify(value)):null)},
createProfile:(name,source)=>normalizeThemeProfile({schemaVersion:2,id:'user:'+crypto.randomUUID(),name,description:'',baseThemeId:source?.baseThemeId??source?.id??TWILIGHT_DEFAULT_THEME_ID,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString(),overrides:{pureWhite:{},dark:{}},modes:{},...(source&&isBuiltInThemePresetId(source.id)?{source:{kind:'builtin-preset',presetId:source.id}}:{})}),
saveProfile:async profile=>{window.commits.saveAttempts++;if(window.failSave)throw new Error('disk write failed');const persisted=normalizeThemeProfile(JSON.parse(JSON.stringify(profile)));if(!persisted)throw new Error('invalid profile fixture');profiles.value=[...profiles.value.filter(value=>value.id!==persisted.id),persisted];window.commits.saved.push(persisted);return snapshot.value},
setActive:async selection=>{window.commits.activations.push(JSON.parse(JSON.stringify(selection)));activeTheme.value=selection;return snapshot.value}
};
export const useThemeStore=()=>store;
`

const runtime = `
import {createApp,h,nextTick} from 'vue';
import {useThemeStudioEditor} from '__RENDERER__/components/theme-studio/useThemeStudioEditor.ts';
import {readThemeStudioRecovery,storeThemeStudioRecovery} from '__RENDERER__/components/theme-studio/themeStudioRecovery.ts';
import {THEME_TOKEN_DEFINITIONS} from '__RENDERER__/../../shared/theme.ts';
window.commits={saveAttempts:0,saved:[],activations:[],settings:0};window.previews={tones:[],selections:[],drafts:[]};
const key='twilightecho.appearance-recovery',initialKey='preset:builtin:twilight-echo-default';
const token=THEME_TOKEN_DEFINITIONS.find(value=>value.id==='color.primary.500');
const expect=(value,message)=>{if(!value)throw Error(message)};
const json=value=>JSON.stringify(value);
const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,15));await nextTick()};
const until=async(predicate,message)=>{const deadline=Date.now()+3000;while(!predicate()){if(Date.now()>deadline)throw Error(message);await settle()}};
const footprint=()=>json(window.commits);
async function mount(){
  const host=document.createElement('div');document.body.append(host);let editor;
  const app=createApp({setup(){editor=useThemeStudioEditor({editable:true,initialKey,onBack:()=>{}});return()=>h('div')}});
  app.mount(host);await until(()=>editor.ready.value,'theme editor did not become ready');
  return {editor,unmount:async()=>{app.unmount();host.remove();await settle()}};
}
window.fixture=async()=>{
  storeThemeStudioRecovery(null);
  let session=await mount();const baseline=json(session.editor.draft.value);
  expect(session.editor.draft.value&&!session.editor.isDirty.value&&!readThemeStudioRecovery(),'fresh editable theme must start clean without recovery');
  const untouched=footprint();
  await session.editor.setTone('pureWhite');
  session.editor.changeName({target:{value:'Retained custom theme'}});
  session.editor.updateToken(token,'#123456');
  session.editor.setPlayerLayout('split');
  await nextTick();
  const retained=json(session.editor.draft.value),selectedKey=session.editor.selectedKey.value;
  expect(session.editor.isDirty.value&&session.editor.canUndo.value,'theme edits lack a dirty reversible draft');
  await session.unmount();
  const recovery=readThemeStudioRecovery();
  expect(recovery?.dirty&&json(recovery.draft)===retained&&recovery.savedDraft===baseline&&recovery.selectedKey===selectedKey&&recovery.tone==='pureWhite','unmount must preserve complete draft, source, tone and confirmed baseline before debounce');
  expect(footprint()===untouched,'unmount/HMR recovery committed or activated a theme');
  session=await mount();
  expect(json(session.editor.draft.value)===retained&&session.editor.isDirty.value&&session.editor.selectedKey.value===selectedKey&&session.editor.tone.value==='pureWhite','remount loses the dirty draft or tone');
  expect(footprint()===untouched&&readThemeStudioRecovery()?.savedDraft===baseline,'remount changes confirmed baseline or writes settings/themes');
  session.editor.changeName({target:{value:'Further edit'}});session.editor.undo();await nextTick();
  expect(json(session.editor.draft.value)===retained&&session.editor.isDirty.value,'post-recovery undo treats recovered draft as confirmed baseline');
  window.failSave=true;await session.editor.applySelected();
  expect(session.editor.localError.value.includes('disk write failed')&&session.editor.isDirty.value&&json(session.editor.draft.value)===retained,'failed save loses or mutates restored draft');
  expect(window.commits.saveAttempts===1&&window.commits.saved.length===0&&window.commits.activations.length===0&&window.commits.settings===0&&readThemeStudioRecovery()?.savedDraft===baseline,'failed save clears recovery or partially activates settings/theme');
  await session.unmount();session=await mount();
  expect(json(session.editor.draft.value)===retained&&session.editor.isDirty.value&&footprint()===json({saveAttempts:1,saved:[],activations:[],settings:0}),'failed-save recovery changes draft or commits automatically');
  window.failSave=false;await session.editor.applySelected();await nextTick();
  expect(window.commits.saveAttempts===2&&window.commits.saved.length===1&&window.commits.activations.length===1&&window.commits.settings===0&&!session.editor.isDirty.value&&!readThemeStudioRecovery(),'successful retry must apply once and clear cache');
  await session.unmount();expect(!readThemeStudioRecovery(),'clean applied theme reappears as dirty cache after unmount');

  session=await mount();const afterApply=footprint();
  session.editor.updateToken(token,'#234567');await until(()=>readThemeStudioRecovery()?.dirty,'dirty theme was not cached after debounce');
  session.editor.undo();await nextTick();
  expect(!session.editor.isDirty.value&&!readThemeStudioRecovery(),'undo to clean baseline does not clear cached draft');
  session.editor.updateToken(token,'#345678');await until(()=>readThemeStudioRecovery()?.dirty,'second draft was not cached');
  const confirm=window.confirm;window.confirm=()=>false;
  expect(!await session.editor.prepareLeave()&&session.editor.isDirty.value&&readThemeStudioRecovery()?.dirty,'denied discard loses draft or cache');
  window.confirm=()=>true;expect(await session.editor.prepareLeave()&&!readThemeStudioRecovery(),'approved discard does not clear cache');window.confirm=confirm;
  await session.unmount();expect(!readThemeStudioRecovery()&&footprint()===afterApply,'approved discard re-caches or commits discarded theme');

  for(const invalid of ['not json',json({dirty:true,draft:{schemaVersion:99},selectedKey:'profile:invalid'}),json({draft:recovery.draft,selectedKey:recovery.selectedKey,dirty:false})]){
    window.sessionStorage.setItem(key,invalid);expect(!readThemeStudioRecovery(),'invalid session payload was accepted');
    const before=footprint();session=await mount();expect(session.editor.draft.value&&!session.editor.isDirty.value&&!session.editor.localError.value&&footprint()===before,'invalid recovery prevents editing or commits');await session.unmount();storeThemeStudioRecovery(null);
  }

  const prototype=Object.getPrototypeOf(window.sessionStorage),get=Object.getOwnPropertyDescriptor(prototype,'getItem'),set=Object.getOwnPropertyDescriptor(prototype,'setItem');
  try{
    Object.defineProperty(prototype,'getItem',{...get,value:()=>{throw new DOMException('storage blocked','SecurityError')}});
    Object.defineProperty(prototype,'setItem',{...set,value:()=>{throw new DOMException('storage full','QuotaExceededError')}});
    const before=footprint();session=await mount();session.editor.updateToken(token,'#456789');await nextTick();
    storeThemeStudioRecovery({...recovery,draft:JSON.parse(json(session.editor.draft.value))});
    expect(session.editor.ready.value&&session.editor.isDirty.value&&!session.editor.localError.value&&!readThemeStudioRecovery()&&footprint()===before,'blocked/full storage interrupts editing or commits theme');
    await session.unmount();
  }finally{Object.defineProperty(prototype,'getItem',get);Object.defineProperty(prototype,'setItem',set);storeThemeStudioRecovery(null)}
};
`

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{let win;try{win=new BrowserWindow({show:false,width:960,height:640,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));await win.webContents.executeJavaScript('window.fixture()');console.log('THEME_RECOVERY_OK');win.destroy();app.exit(0)}catch(error){console.error(error.stack);win?.destroy();app.exit(1)}});
`
