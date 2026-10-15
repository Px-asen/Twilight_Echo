import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { parse } from '@vue/compiler-sfc'
import { build } from 'vite'
import { settingsAnchorDisclosurePath, settingsDisclosurePath } from './settings-page/types.ts'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('legacy anchors and single-level callers resolve ordered disclosure paths', () => {
  assert.deepEqual(
    settingsDisclosurePath({
      section: 'library',
      title: '旧入口',
      terms: '',
      disclosureId: 'cache-details'
    }),
    ['cache-details']
  )
  assert.deepEqual(settingsAnchorDisclosurePath('cache'), ['storage'])
  assert.deepEqual(settingsAnchorDisclosurePath('cache-details'), ['storage', 'cache-details'])
  assert.deepEqual(settingsAnchorDisclosurePath('device-profiles'), ['output-advanced'])
  assert.deepEqual(settingsAnchorDisclosurePath('audio-output-device-panel'), [
    'output-advanced',
    'audio-output-device-panel'
  ])
  assert.deepEqual(settingsAnchorDisclosurePath('player-bar-layout-details'), [
    'player-bar',
    'player-bar-layout-details'
  ])
})

test('quick setup hides after configuration, reveals nested targets, and preserves local disclosure preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-settings-quick-setup-'))
  try {
    const fixture = fileURLToPath(new URL('./settingsOrganization.fixture.mjs', import.meta.url))
    await writeFile(join(directory, 'entry.ts'), runtime)
    const app = parse(await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8'))
    await writeFile(
      join(directory, 'app.css'),
      app.descriptor.styles.map((style) => style.content).join('\n')
    )
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'quick-setup-native-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (source === '/icon.png') return '\0quick-icon'
            if (source === 'quick-test-theme') return '\0quick-theme'
            if (
              source.endsWith('/useSettingsStore.ts') &&
              importer?.endsWith('settingsOrganization.fixture.mjs')
            )
              return null
            const name = source.match(
              /\/(useSettingsStore|useMusicStore|useThemeStore|useAudioOutputDspStore|usePlayerStore|useListeningStatsStore|registry)(?:\.ts)?$/
            )?.[1]
            if (name === 'useThemeStore') return '\0quick-theme'
            if (name) return '\0quick-store:' + name
            if (source.endsWith('/AudioDeviceProfilesPanel.vue')) return '\0quick-profiles'
            if (source.endsWith('/AppUpdatePanel.vue')) return '\0quick-update'
            if (source.endsWith('AppearanceWindowPreview.vue')) return '\0quick-unrelated-preview'
            if (/\/(ThemeStudioPage|ThemeWorkshopPage)\.vue$/.test(source))
              return '\0quick-theme-engine'
            return null
          },
          load(id) {
            if (id === '\0quick-unrelated-preview') return 'export default {render:()=>null}'
            if (id === '\0quick-theme-engine')
              return `import {computed,ref} from 'vue';export default {props:['initialKey','initialProjectId'],setup(props,{expose}){const key=ref(props.initialKey??'workshop:'+(props.initialProjectId??'new')),tone=ref('pureWhite');expose({state:computed(()=>({key:key.value,tone:tone.value,busy:false,dirty:false,hasUnsavedChanges:false})),prepareLeave:async()=>true,collapse:async()=>false,selectKey:async value=>{key.value=value},setTone:value=>{tone.value=value}});return ()=>null}}`
            if (id === '\0quick-theme') return themeState
            if (id === '\0quick-icon')
              return 'export default "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII="'
            if (id.startsWith('\0quick-store:')) {
              const name = id.split(':')[1]
              if (name === 'useAudioOutputDspStore')
                return `import {useAudioOutputDspStore as fixtureStore} from ${JSON.stringify(fixture)};export let selectedDevice='';const bound=new WeakSet();export function useAudioOutputDspStore(){const store=fixtureStore();if(!bound.has(store)){bound.add(store);store.setAudioDevice=async id=>{selectedDevice=id;store.audioDevice=id}}return store}`
              return `export { ${name === 'registry' ? 'useExtensionRegistry' : name}${name === 'useListeningStatsStore' ? ', waitForListeningStatsReady' : ''} } from ${JSON.stringify(fixture)}`
            }
            if (id === '\0quick-profiles') return 'export default {render:()=>null}'
            if (id === '\0quick-update')
              return `export default {template:'<div data-setting-id="app-update"><strong>当前版本已是最新</strong><div data-setting-id="app-update-install"><button>检查更新</button></div></div>'}`
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          '@shared': join(workspace, 'src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: resolve(require.resolve('pinia'), '../dist/pinia.mjs')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'QuickSetup',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off" data-theme="pureWhite"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<link rel="stylesheet" href="app.css"><style>body{margin:0;font:14px system-ui}*{box-sizing:border-box}.settings-preview-page{scroll-behavior:auto}</style></head><body><div id="app"></div><script>window.api=new Proxy({}, {get:(target,service)=>Object.hasOwn(target,service)?target[service]:new Proxy({}, {get:(_module,method)=>method.startsWith('on')?()=>()=>{}:async()=>method==='getAutoMixStemCapabilities'?{status:'missing',cpu:false,gpu:false,packs:[]}:method==='getAutoMixStemInstallStatus'?{phase:'idle',completedBytes:0,totalBytes:0}:method==='listInstalled'||method==='getShortcutStatuses'?[]:null})})</script><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    const evidence = process.env.TWILIGHT_SETTINGS_EVIDENCE_DIR
    if (evidence) await mkdir(evidence, { recursive: true })
    await writeFile(
      join(directory, 'runner.cjs'),
      `
const {app,BrowserWindow}=require('electron');const path=require('node:path');const fs=require('node:fs');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1024,height:900,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false}});
try{await win.loadFile(path.join(__dirname,'index.html'));console.log(await win.webContents.executeJavaScript('window.runQuickSetupTests()'));
for(const width of [1024,760]){win.setContentSize(width,900);for(const theme of ['pureWhite','dark']){await win.webContents.executeJavaScript('window.checkQuickSetupLayout('+JSON.stringify(theme)+')');if(${JSON.stringify(evidence || '')})fs.writeFileSync(path.join(${JSON.stringify(evidence || '')},'quick-'+width+'-'+theme+'.png'),(await win.webContents.capturePage()).toPNG())}}
app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      windowsHide: true,
      timeout: 60_000,
      env
    })
    assert.match(result.stdout, /QUICK_SETUP_OK/)
    console.log(result.stdout.trim())
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    assert.ok(directory.includes('twilight-settings-quick-setup-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const themeState = `
import {computed,ref} from 'vue'
export const selection=ref({kind:'builtin',id:'builtin:twilight-echo-default'})
const activeProfile=computed(()=>selection.value.kind==='user'?{name:'夜间阅读'}:null)
const profiles=ref([])
export const useThemeStore=()=>({activeTheme:selection,activeProfile,profiles,load:async()=>{},setActive:async value=>{selection.value=value}})
export const syncThemeSettingsAppearance=()=>{}
export const previewAppearance=async()=>{}
`

const runtime = `
import {createApp,h,nextTick} from 'vue'
import {settings,navigation} from '@renderer/components/settingsOrganization.fixture.mjs'
import {useAudioOutputDspStore,selectedDevice} from '@renderer/stores/useAudioOutputDspStore'
import SettingsQuickSetup from '@renderer/components/settings-page/SettingsQuickSetup.vue'
import {SETTINGS_SEARCH_INDEX} from '@renderer/components/settings-page/types.ts'
import {TWILIGHT_AUTOMIX_AVAILABLE} from '@shared/twilightAutoMix.ts'
import {selection} from 'quick-test-theme'
const expect=(value,message)=>{if(!value)throw Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(resolve));await new Promise(resolve=>setTimeout(resolve,80));await nextTick()}
const waitFor=async (check,label='')=>{const deadline=Date.now()+2000;while(!check()){expect(Date.now()<deadline,'navigation did not settle: '+label+'; target='+document.querySelector('.search-target-flash')?.outerHTML.slice(0,180)+'; active='+document.activeElement.outerHTML.slice(0,300)+'; errors='+window.organizationRendererErrors.join('; '));await settle()}}
const destinationFor=entry=>document.querySelector(entry.section==='appearance'?'.appearance-page':'.settings-preview-page:not(.appearance-page)')
window.runQuickSetupTests=async()=>{
 await settle()
 const page=document.querySelector('.settings-preview-page')
 expect(!page.querySelector('.settings-quick-setup'),'existing music folders must hide quick setup')
 settings.value={...settings.value,onboardingCompleted:false,libraryFolders:[]};await settle()
 const card=page.querySelector('.settings-quick-setup')
 const trigger=card.querySelector(':scope > button')
 const actions=[...card.querySelectorAll('.settings-quick-setup-action')]
 expect(actions.length===3&&trigger.getAttribute('aria-expanded')==='true','three optional quick setup entries must be visible initially')
 for(const id of ['output-advanced','playback-transitions','player-bar','player-bar-behavior-details','player-bar-layout-details','theme-customization','window-transparency-details','storage','shortcut-details','external-connections','network-proxy','lyrics-style-details']){
  const trigger=document.querySelector('#'+id+' > button')
  if(trigger?.closest('.appearance-page'))expect(!trigger.getClientRects().length,'advanced appearance group must start undisclosed: '+id)
  else if(id==='window-transparency-details')expect(!document.querySelector('[data-setting-id="window-transparency"]').getClientRects().length,'native transparency controls must start undisclosed')
  else if(id==='player-bar-layout-details')expect(!document.querySelector('[data-setting-id="player-bar-layout"]').getClientRects().length,'advanced player arrangement must start undisclosed')
  else expect(trigger?.getAttribute('aria-expanded')==='false','advanced group must start collapsed: '+id)
 }
 expect(card.textContent.includes('已添加 0 个文件夹')&&card.textContent.includes('跟随系统默认设备')&&card.textContent.includes('默认主题'),'unconfigured users must retain valid default audio and theme choices')
 const originalSettings=JSON.stringify(settings.value)
 for(const [index,id] of ['library-folders','audio-device','color-mode'].entries()){
  const destination=destinationFor(SETTINGS_SEARCH_INDEX.find(entry=>entry.id===id))
  actions[index].click();await waitFor(()=>destination.querySelector('.search-target-flash')?.dataset.settingId===id)
  const target=destination.querySelector('.search-target-flash')
  await waitFor(()=>target.contains(document.activeElement),'quick focus '+id)
  expect(target.getClientRects().length&&target.contains(document.activeElement)&&!target.closest('[inert]'),'quick setup must focus its visible destination: '+id+'; active='+document.activeElement.outerHTML.slice(0,300))
 }
 expect(JSON.stringify(settings.value)===originalSettings,'navigation must not change business settings')
 navigation.openSettingsPage('general');await settle()
 const output=useAudioOutputDspStore()
 output.audioOutputDeviceOptions=[{id:'usb-dac',label:'USB 解码器'}];output.audioDevice='usb-dac'
 settings.value={...settings.value,libraryFolders:[],theme:'dark'}
 selection.value={kind:'user',id:'user:reading'};await settle()
 expect(card.textContent.includes('已添加 0 个文件夹')&&card.textContent.includes('在线听歌')&&card.textContent.includes('USB 解码器')&&card.textContent.includes('夜间阅读 · 深色'),'live status and optional folder guidance must survive settings changes')
 selection.value={kind:'builtin',id:'builtin:paper-light'};await settle()
 expect(!actions[2].textContent.includes('builtin:'),'built-in theme status must use its display name')
 const device=page.querySelector('[data-setting-id="audio-device"] select')
 device.value='auto';device.dispatchEvent(new Event('change',{bubbles:true}));await settle()
 expect(selectedDevice==='auto','simple device selector must use the existing output handler')
 const reveal=async id=>{const entry=SETTINGS_SEARCH_INDEX.find(entry=>entry.id===id);if(navigation.showAppearancePage.value){navigation.closeAppearancePage();await settle()}const destination=destinationFor(entry);if(entry.section==='appearance'){navigation.openAppearancePage(entry)}else{const input=page.querySelector('#settings-search-input');input.value=entry.title;input.dispatchEvent(new Event('input',{bubbles:true}));await settle();const result=[...page.querySelectorAll('[role="option"]')].find(option=>option.querySelector('.settings-nav-result-title').textContent===entry.title);expect(result,'search option missing: '+id);result.click()}await settle();await waitFor(()=>{const target=destination.querySelector('.search-target-flash');return [id==='theme-workshop'?'plugin-theme':id,entry.fallbackId,entry.disclosureId].filter(Boolean).includes(target?.dataset.settingId||target?.id)},id);return destination.querySelector('.search-target-flash')}
 await reveal('player-bar-layout')
 const playerGroup=document.querySelector('.appearance-page #player-bar')
 expect(playerGroup.querySelector(':scope > button').getAttribute('aria-expanded')==='true'&&playerGroup.closest('.appearance-details-drawer').getClientRects().length,'search must reveal both the appearance drawer and player group')
 expect(playerGroup.querySelector('[data-setting-id="player-bar-layout"]').getClientRects().length,'search must reveal the actual player arrangement controls')
 await reveal('cache-metadata')
 for(const id of ['storage','cache-details'])expect(page.querySelector('#'+id+' > button').getAttribute('aria-expanded')==='true','cache search must reveal both ancestors: '+id)
 const input=page.querySelector('#settings-search-input');input.value='元数据缓存';input.dispatchEvent(new Event('input',{bubbles:true}));await settle()
 expect([...page.querySelectorAll('[role="option"]')].some(option=>option.textContent.includes('歌曲信息缓存')),'old terminology must remain searchable')
 const beforeFallback=JSON.stringify(settings.value)
 const fallback=await reveal('autoMixStemMode')
 if(TWILIGHT_AUTOMIX_AVAILABLE){
  expect(fallback.dataset.settingId==='autoMixStemMode','available stem settings must focus their own resource disclosure')
  expect(fallback.querySelector('[role="status"]').textContent.includes('未检测到分轨器')&&fallback.querySelector('[role="switch"]').disabled&&fallback.querySelector('[role="switch"]').getAttribute('aria-checked')==='false','missing stem packs must explain their dependency and keep the switch unavailable')
 }else expect(fallback.dataset.settingId==='autoMixMode'&&page.textContent.includes('分轨功能暂不可用'),'unavailable stems must explain and focus the main AutoMix item')
 expect(JSON.stringify(settings.value)===beforeFallback,'fallback search must never enable a feature')
 expect(page.querySelectorAll('[data-setting-id="dsd-output-mode"]').length===1&&!page.querySelector('#advanced-engine-parameters [data-setting-id="dsd-output-mode"]'),'DSD must have one editing entry')
 expect(page.querySelector('#dsd-routing [data-setting-id="pcm-to-dsd"]'),'PCM to DSD must belong to DSD playback')
 output.audioEngineError='测试输出失败';await settle()
 expect(page.querySelector('#output-advanced > button').textContent.includes('测试输出失败'),'closed output group must retain error feedback')
 output.audioEngineError=null;output.audioOutputConfigApplyStatus={state:'pending'};await settle()
 expect(page.querySelector('#output-advanced > button').textContent.includes('正在应用输出参数'),'closed output group must retain pending status')
 output.audioOutputConfigApplyStatus={state:'idle'}
 await reveal('cache-usage')
 window.api.settings={clearCache:async()=>{throw Error('测试缓存清理失败')}};window.confirm=()=>true
 page.querySelector('[data-setting-id="cache-usage"] button').click();await settle()
 page.querySelector('#storage > button').click();await settle()
 expect(page.querySelector('#storage > button').textContent.includes('测试缓存清理失败'),'storage must retain cleanup failure feedback after collapse')
 for(const entry of SETTINGS_SEARCH_INDEX.filter(entry=>!entry.appearanceArea)){
  for(const button of [...document.querySelectorAll('.settings-group > button[aria-expanded="true"]')].reverse())button.click()
  for(const detail of document.querySelectorAll('details[open]'))detail.open=false
  await settle()
  const target=await reveal(entry.id)
  expect(target.getClientRects().length&&!target.closest('[inert]'),'fresh search focused hidden content: '+entry.id)
  const exact=destinationFor(entry).querySelector('[data-setting-id="'+entry.id+'"]')
  if(exact){
   let group=exact.closest('.settings-group')
   while(group){expect(group.querySelector(':scope > button').getAttribute('aria-expanded')==='true','fresh search missed an ancestor of '+entry.id+': '+group.id);group=group.parentElement.closest('.settings-group')}
   if(exact.getClientRects().length&&!exact.closest('[inert]'))expect(target===exact||target.id===entry.id&&target.contains(exact),'fresh search failed to focus a visible control: '+entry.id)
  }
 }
 navigation.openSettingsPage('general');await settle()
 actions[0].focus();trigger.click();await settle()
 expect(document.activeElement===trigger&&card.querySelector('#settings-quick-setup-content').inert,'collapse must return focus and deactivate its controls')
 expect(localStorage.getItem('twilight-echo:settings-quick-setup:collapsed')==='true','collapse preference must be local')
 const host=document.createElement('div');document.body.append(host)
 const mount=()=>{const app=createApp({render:()=>h(SettingsQuickSetup,{folderCount:0,deviceName:'默认输出',themeName:'默认主题'})});app.mount(host);return app}
 let app=mount();await settle()
 expect(host.querySelector('button').getAttribute('aria-expanded')==='false','reopening must retain collapsed preference')
 host.querySelector('button').click();await settle();app.unmount();app=mount();await settle()
 expect(host.querySelector('button').getAttribute('aria-expanded')==='true','reopening must also retain expanded preference')
 app.unmount();host.remove();trigger.click();await settle()
 settings.value={...settings.value,libraryFolders:['D:/Music']};await settle()
 expect(!page.querySelector('.settings-quick-setup'),'adding a music folder must hide quick setup immediately')
 settings.value={...settings.value,onboardingCompleted:true,libraryFolders:[]};await settle()
 expect(!page.querySelector('.settings-quick-setup'),'completed onboarding must hide quick setup for streaming users without folders')
 settings.value={...settings.value,onboardingCompleted:false,libraryFolders:[]};await settle()
 expect(page.querySelector('.settings-quick-setup'),'first-run users must still have access to quick setup')
 expect(window.organizationRendererErrors.length===0,'renderer errors: '+window.organizationRendererErrors.join('; '))
 return 'QUICK_SETUP_OK: configured local/streaming users hide quick setup; three focused destinations, live state, saved disclosure preference, every search from collapsed groups, failure summaries, DSD and resource-dependent AutoMix verified'
}
window.checkQuickSetupLayout=async theme=>{
 document.documentElement.dataset.theme=theme;document.documentElement.dataset.teMotion='reduced'
 const page=document.querySelector('.settings-preview-page');page.scrollTo({top:0,behavior:'instant'});await settle()
 const card=page.querySelector('.settings-quick-setup')
 for(const control of card.querySelectorAll('button')){const rect=control.getBoundingClientRect();expect(rect.width&&rect.left>=0&&rect.right<=innerWidth+1,'quick setup overflow at '+innerWidth+'/'+theme)}
}
`
