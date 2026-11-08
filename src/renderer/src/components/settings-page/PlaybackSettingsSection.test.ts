import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const source = readFileSync(new URL('./PlaybackSettingsSection.vue', import.meta.url), 'utf8')
const settingsCss = readFileSync(new URL('./SettingsPage.css', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)

test('automatic exclusive release uses the persisted setting and an accessible dependent switch', () => {
  assert.match(source, /setExclusiveAutoRelease\(!settings\.value\.audioExclusiveAutoRelease\)/)
  assert.match(source, /aria-label="独占模式自动启停"/)
  assert.match(source, /:aria-checked="settings\.audioExclusiveAutoRelease"/)
  assert.match(
    source,
    /:disabled="!exclusiveAvailable \|\| !exclusiveMode \|\| exclusiveAutoReleaseApplying"/
  )
  assert.match(source, /outputInfo\?\.outputReleased && playbackInfo\?\.state === 'paused'/)
})

test('playback diagnostics expose the active PCM provider implementation', () => {
  assert.match(
    source,
    /const outputProviderImplementation = computed\(\s*\(\) => outputInfo\.value\?\.providerImplementation \?\? ''\s*\)/
  )
  assert.match(
    source,
    /<span v-if="outputProviderImplementation">[\s\S]*Provider \{\{ outputProviderImplementation \}\}/
  )
})

test('playback diagnostics expose ASIO helper underrun rate and warn above 1%', () => {
  assert.match(source, /const outputUnderrunRatePercent = computed<number \| null>\(\(\) => \{/)
  assert.match(source, /diagnostics\?\.asioHelperCallbackCount \?\? 0/)
  assert.match(source, /if \(rate === null \|\| rate <= 1\) return ''/)
  assert.match(source, /t\('diagnostics\.panel\.underrunRateWarning'/)
  assert.match(source, /class="diagnostic-reason-fix diagnostic-underrun-warning"/)
})

test('released output replaces playback proof and the HiFi occupancy label', () => {
  const playerBar = readFileSync(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../player-bar/HiFiSidebar.vue', import.meta.url), 'utf8')
  assert.match(playerBar, /if \(outputInfo\.value\?\.outputReleased\) \{\s*return \[/)
  assert.match(playerBar, /:output-released="outputInfo\?\.outputReleased"/)
  assert.match(sidebar, /if \(props\.outputReleased\) return `\$\{backend\} · RELEASED`/)
})

test('production playback policies and exclusive auto release apply and survive settings reload and component reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playback-policy-'))
  try {
    await writeFile(join(directory, 'entry.ts'), policyRuntime)
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [
        {
          name: 'playback-policy-native-boundary',
          enforce: 'pre',
          resolveId(id) {
            if (id === 'policy-state') return '\0policy-state'
            if (/\/useSettingsStore$/.test(id)) return '\0policy-settings'
            if (/\/usePlayerStore$/.test(id)) return '\0policy-player'
            if (/\/useAudioOutputDspStore$/.test(id)) return '\0policy-dsp'
            if (/\/coreConnection\.ts$/.test(id)) return '\0policy-core'
            if (id.endsWith('/AudioDeviceProfilesPanel.vue')) return '\0policy-profiles'
            return null
          },
          load(id) {
            if (id === '\0policy-state')
              return policyState
            if (id === '\0policy-settings') return "export {useSettingsStore} from 'policy-state'"
            if (id === '\0policy-player') return "export {usePlayerStore} from 'policy-state'"
            if (id === '\0policy-dsp') return "export {useAudioOutputDspStore} from 'policy-state'"
            if (id === '\0policy-core') return "export {useCoreConnection} from 'policy-state'"
            if (id === '\0policy-profiles') return 'export default {render:()=>null}'
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          '@core': resolve('src/core'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: resolve(require.resolve('pinia'), '../dist/pinia.mjs')
        }
      },
      define: {
        'process.env.NODE_ENV': '"production"',
        __TWILIGHT_AUTOMIX_EVALUATION__: 'false'
      },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'PolicyTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}${settingsCss}</style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{offscreen:true,backgroundThrottling:false}});win.webContents.on('console-message',(_event,_level,message)=>console.error(message));try{await win.loadFile(require('node:path').join(__dirname,'index.html'));const result=await win.webContents.executeJavaScript('window.runPolicyTests().catch(error=>error.stack)');if(!result.startsWith('PLAYBACK_POLICY_OK'))throw Error(result);console.log(result);app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      // Electron 43.7 crashes at sandbox startup on some Windows builds; the
      // project's other Electron runners already disable it for this reason.
      ['--no-sandbox', join(directory, 'runner.cjs')],
      {
        windowsHide: true,
        timeout: 60_000,
        env
      }
    )
    assert.match(result.stdout, /PLAYBACK_POLICY_OK/)
    console.log(result.stdout.trim())
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    assert.ok(directory.includes('twilight-playback-policy-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const policyState = `
import {ref,watch} from 'vue'
import {defineStore} from 'pinia'
import {normalizeOutputConfig} from '@shared/audioOutputConfig.ts'
import {DEFAULT_DSP_OUTPUT_STAGE} from '@shared/dspGraph.ts'
import {DEFAULT_AUDIO_PROCESSING} from '@core/audio/audioEngineHelpers.ts'
import {createCorePlayerAudio} from '@renderer/stores/player/corePlayerAudio.ts'
import {validCorePayload} from '@shared/coreRequestValidation.ts'
export const persisted=ref(normalizeOutputConfig({pcmToDsdMode:'dsd128',dsdMutePreRollFrames:1024}))
export const engine=ref({...persisted.value})
export const appSettings=ref({autoMixMode:'off',autoMixStemMode:'auto',autoMixStemDevice:'auto',autoMixStemCacheMiB:512,audioExclusiveAutoRelease:false,audioOutputConfig:{...persisted.value},sleepTimer:{defaultMinutes:30,fadeSeconds:0}})
export const stemCapabilities=ref({status:'missing',cpu:false,gpu:false,packs:[]})
export const rejectSettings=ref(false)
export const audioOutputConfig=ref(normalizeOutputConfig())
watch(()=>appSettings.value.audioOutputConfig,value=>{audioOutputConfig.value=normalizeOutputConfig(value)},{immediate:true})
const audioProcessing=ref(structuredClone(DEFAULT_AUDIO_PROCESSING))
export const exclusiveMode=ref(false)
export const exclusiveAvailable=ref(true)
export const releasePolicy={persisted:false,applied:false,revision:7,edits:[],fail:false,hold:null}
const releaseClient={state:ref({epoch:'test',settingsRevision:0,audioRevision:0}),query:async(name,payload)=>{
 if(!validCorePayload(name,payload))throw Error('Unknown or malformed Core operation')
 if(name==='audio.output')return {revision:releasePolicy.revision,output:{output:'wasapi',device:'auto',exclusiveMode:exclusiveMode.value,exclusiveAvailable:exclusiveAvailable.value,outputOptions:[],deviceOptions:[]},config:{...audioOutputConfig.value},applyStatus:{state:'idle'},exclusiveAutoRelease:releasePolicy.persisted}
 return null
},command:async(name,payload)=>{
 if(!validCorePayload(name,payload))throw Error('Unknown or malformed Core operation')
 if(name!=='audio.output.edit'||payload.edit.kind!=='autoRelease')throw Error('Unexpected audio command')
 if(payload.revision!==releasePolicy.revision)throw Error('STALE_REVISION')
 releasePolicy.edits.push(payload.edit.enabled)
 if(releasePolicy.hold)await releasePolicy.hold
 if(releasePolicy.fail)throw Error('exclusive policy rejected')
 releasePolicy.applied=payload.edit.enabled;releasePolicy.persisted=payload.edit.enabled;releasePolicy.revision++
 appSettings.value={...appSettings.value,audioExclusiveAutoRelease:releasePolicy.persisted}
}}
const audioOutputConfigApplyStatus=ref({state:'idle',requestedRevision:0,appliedRevision:0,failedRevision:0,error:''})
const controller={setAudioOutputConfig:async patch=>{engine.value=normalizeOutputConfig({...audioOutputConfig.value,...patch});persisted.value={...engine.value};audioOutputConfig.value={...engine.value};appSettings.value={...appSettings.value,audioOutputConfig:{...engine.value}}},setAudioProcessing:async patch=>{audioProcessing.value={...audioProcessing.value,...patch}},toggleExclusiveMode:async()=>{},setAudioOutput:async()=>{},setAudioDevice:async()=>{},toggleGapless:async()=>{}}
export const useAudioOutputDspStore=defineStore('policy-output',()=>{
 const audio=createCorePlayerAudio(releaseClient,error=>{throw error})
 return {exclusiveMode,audioOutput:ref('wasapi'),audioDevice:ref('auto'),audioOutputOptions:ref([{id:'wasapi',label:'WASAPI',get supportsExclusive(){return exclusiveAvailable.value}}]),audioDeviceOptions:ref([]),audioOutputDeviceOptions:ref([]),audioProcessing,audioOutputConfig,audioOutputConfigApplyStatus,dspOutputStage:ref(structuredClone(DEFAULT_DSP_OUTPUT_STAGE)),dspGraphStatus:ref(null),playbackInfo:ref(null),outputInfo:ref(null),audioEngineError:ref(null),...controller,setExclusiveAutoRelease:enabled=>audio.setExclusiveAutoRelease(enabled),refreshAudioOutputState:async()=>{}}
})
export const useSettingsStore=()=>({settings:appSettings,updateSettings:async patch=>{if(!validCorePayload('settings.edit',{revision:0,patch}))throw Error('Unknown or malformed Core operation');if(rejectSettings.value)throw Error('settings failure');appSettings.value={...appSettings.value,...patch}}})
export const usePlayerStore=()=>({volume:ref(.7),setVolume:()=>{},setUnityVolume:()=>{}})
export const useCoreConnection=()=>({state:ref(null),query:(...args)=>window.policyCore.query(...args),command:(...args)=>window.policyCore.command(...args)})
export const reload=()=>{appSettings.value={...appSettings.value,audioExclusiveAutoRelease:releasePolicy.persisted,audioOutputConfig:JSON.parse(JSON.stringify(persisted.value))}}
`

const policyRuntime = `
import {createApp,h,nextTick,ref} from 'vue'
import {createPinia} from 'pinia'
import {setLanguagePreference} from '@renderer/app/useLocale.ts'
import PlaybackSettingsSection from '@renderer/components/settings-page/PlaybackSettingsSection.vue'
import {reload,audioOutputConfig,persisted,engine,appSettings,stemCapabilities,rejectSettings,exclusiveMode,exclusiveAvailable,releasePolicy} from 'policy-state'
const expect=(value,message)=>{if(!value)throw Error(message)}
const settle=async()=>{await nextTick();await new Promise(resolve=>requestAnimationFrame(resolve));await nextTick()}
window.runPolicyTests=async()=>{
 setLanguagePreference('zh-CN')
 let detectionCalls=0
 let installStatus={phase:'idle',completedBytes:0,totalBytes:0},installResult={phase:'cancelled',completedBytes:0,totalBytes:0},finishInstall=()=>{},holdInstall=false
 window.policyCore={query:async name=>{
  if(name==='audio.recovery')return null
  if(name==='automix.capabilities'){detectionCalls++;return JSON.parse(JSON.stringify(stemCapabilities.value))}
  if(name==='automix.install.status')return {...installStatus}
  throw Error('Unexpected Core query '+name)
 },command:async(name,input)=>{
  if(name==='automix.install.start'){
   expect(Object.keys(input).length===1&&typeof input.enableAfterInstall==='boolean','install intent must be sent to Core without filesystem paths')
   const complete=status=>{installStatus={...status};if(status.phase==='ready')appSettings.value={...appSettings.value,...(input.enableAfterInstall?{autoMixStemMode:'auto',autoMixStemDevice:'auto'}:{autoMixStemMode:'off'})}}
   if(holdInstall){installStatus={phase:'extracting',completedBytes:50,totalBytes:100,fileName:'pack.zip'};finishInstall=complete;return {...installStatus}}
   installStatus={...installResult};if(installStatus.phase==='ready')complete(installStatus);return {...installStatus}
  }
  expect(Object.keys(input).length===0,'renderer must not pass filesystem paths')
  if(name==='automix.install.cancel'){installStatus={phase:'cancelled',completedBytes:0,totalBytes:0};finishInstall(installStatus);return {...installStatus}}
  throw Error('Unexpected Core command '+name)
 }}
 const open=ref(true)
 const app=createApp({render:()=>open.value?h(PlaybackSettingsSection):null})
 app.use(createPinia());app.mount('#app');await settle()
 const policy=()=>document.querySelector('select[aria-label="连续播放策略"]')
 const rate=()=>document.querySelector('select[aria-label="连续播放目标采样率"]')
 const autoMix=()=>document.querySelector('select[aria-label="Twilight AutoMix 模式"]')
 const stemCache=()=>document.querySelector('select[aria-label="分轨缓存容量"]')
 const stemSwitch=()=>document.querySelector('button[role="switch"][aria-label="分轨增强"]')
 const stemDevice=()=>document.querySelector('select[aria-label="分轨计算设备"]')
 const refreshStems=async()=>{[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='重新检测').click();await settle()}
 const change=async(select,value)=>{select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));await settle()}
 expect(autoMix()&&!autoMix().disabled&&autoMix().value==='off','production must expose an opt-in AutoMix selector that defaults to off')
 expect(document.body.textContent.includes('开放试用'),'production must explain AutoMix availability')
 expect(!document.body.textContent.includes('人工验收版本'),'production must not describe the package as an evaluation build')
 expect(stemSwitch().disabled&&stemSwitch().getAttribute('aria-checked')==='false','missing pack must disable stem switch')
 expect(stemDevice().disabled&&document.body.textContent.includes('未检测到分轨器'),'missing pack must explain installation')
 expect(appSettings.value.autoMixStemMode==='auto','missing pack must retain saved enable preference')
 stemCapabilities.value={status:'ready',cpu:true,gpu:false,packs:[{directory:'cpu',cpu:true,gpu:false}]}
 await refreshStems()
 expect(detectionCalls===2&&!stemSwitch().disabled,'manual detection must discover newly installed pack')
 expect(stemDevice().querySelector('option[value="gpu"]').disabled&&!stemDevice().querySelector('option[value="cpu"]').disabled,'CPU-only runtime must disable GPU choice')
 await change(stemDevice(),'cpu')
 expect(appSettings.value.autoMixStemDevice==='cpu','CPU choice must reach settings')
 stemSwitch().click();await settle()
 expect(appSettings.value.autoMixStemMode==='off'&&stemSwitch().getAttribute('aria-checked')==='false','switch must persist Off')
 open.value=false;await settle();reload();open.value=true;await settle()
 expect(stemDevice().value==='cpu'&&stemSwitch().getAttribute('aria-checked')==='false','device and Off must survive reopen')
 stemSwitch().click();await settle()
 expect(appSettings.value.autoMixStemMode==='auto','switch must enable stem preparation')
 stemCapabilities.value={status:'ready',cpu:true,gpu:true,packs:[{directory:'gpu',cpu:true,gpu:true,gpuName:'Test GPU'}]}
 await refreshStems()
 expect(!stemDevice().querySelector('option[value="gpu"]').disabled&&document.body.textContent.includes('Test GPU'),'GPU detection must expose GPU name and choice')
 await change(stemDevice(),'gpu')
 open.value=false;await settle();reload();open.value=true;await settle()
 expect(stemDevice().value==='gpu'&&stemSwitch().getAttribute('aria-checked')==='true','GPU and On must survive reopen')
 rejectSettings.value=true
 await change(stemDevice(),'cpu')
 expect(appSettings.value.autoMixStemDevice==='gpu'&&stemDevice().value==='gpu','failed device update must restore saved selection')
 stemSwitch().click();await settle()
 expect(stemSwitch().getAttribute('aria-checked')==='true','failed switch update must retain saved state')
 rejectSettings.value=false
 stemCapabilities.value={status:'ready',cpu:true,gpu:false,packs:[{directory:'cpu',cpu:true,gpu:false}]}
 await refreshStems()
 expect(stemSwitch().disabled&&stemSwitch().getAttribute('aria-checked')==='false'&&stemDevice().value==='gpu','unavailable saved GPU must not silently enable CPU')
 expect(appSettings.value.autoMixStemDevice==='gpu','hardware change must retain user preference')
 await change(stemDevice(),'auto')
 expect(!stemSwitch().disabled&&stemSwitch().getAttribute('aria-checked')==='true','Auto choice must restore usable CPU enhancement')
 const installButton=()=>document.querySelector('[data-setting-id="autoMixMode"] [data-action="install-stem-pack"]')
 const chooseInstall=async(enable)=>{
  installButton().click();await settle()
  const dialog=document.querySelector('dialog[aria-labelledby="automix-install-title"]')
  expect(dialog.open&&dialog.textContent.includes('内存')&&dialog.textContent.includes('显存'),'install options must explain RAM / VRAM usage before choosing ZIP')
  const bounds=dialog.getBoundingClientRect()
  expect(Math.abs(bounds.x+bounds.width/2-document.documentElement.clientWidth/2)<2&&Math.abs(bounds.y+bounds.height/2-document.documentElement.clientHeight/2)<2,'install dialog must remain centered under the application margin reset: '+JSON.stringify({x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,viewport:[innerWidth,innerHeight],client:[document.documentElement.clientWidth,document.documentElement.clientHeight]}))
  const checkbox=dialog.querySelector('input[type="checkbox"]')
  if(enable!==undefined){checkbox.checked=enable;checkbox.dispatchEvent(new Event('change',{bubbles:true}));await settle()}
  dialog.querySelector('[data-action="choose-stem-zip"]').click();await settle()
 }
 expect(installButton()?.textContent.includes('安装分轨包'),'installer must appear directly in main AutoMix row')
 const savedPreferences=JSON.stringify(appSettings.value)
 await chooseInstall()
 expect(document.body.textContent.includes('已取消安装'),'picker cancellation must be explained')
 expect(JSON.stringify(appSettings.value)===savedPreferences,'picker cancellation must preserve user preferences')
 installResult={phase:'failed',completedBytes:0,totalBytes:0,reason:'integrity'}
 await chooseInstall()
 expect(document.querySelector('[role="alert"]')?.textContent.includes('文件校验不通过'),'installation failure must have accessible actionable feedback')
 expect(!installButton().disabled,'failed installation must allow retry')
 holdInstall=true
 await chooseInstall();await new Promise(resolve=>setTimeout(resolve,450));await settle()
 expect(installButton().disabled&&document.querySelector('progress')?.value===50,'busy installation must expose byte progress and prevent duplicate requests')
 open.value=false;await settle();open.value=true;await settle()
 expect(document.querySelector('progress')?.value===50&&installButton().disabled,'reopening settings must recover active installation status')
 const cancelButton=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='取消安装')
 expect(cancelButton,'active installation must allow cancellation')
 cancelButton.click();await settle()
 expect(document.body.textContent.includes('已取消安装')&&!installButton().disabled,'cancellation must allow retry')
 await chooseInstall()
 stemCapabilities.value={status:'ready',cpu:true,gpu:true,packs:[{directory:'installed',cpu:true,gpu:true,gpuName:'Installed GPU'}]}
 installStatus={phase:'ready',completedBytes:100,totalBytes:100,capabilities:{cpu:true,gpu:true}}
 finishInstall({...installStatus});await new Promise(resolve=>setTimeout(resolve,450));await settle()
 expect(document.body.textContent.includes('安装完成')&&!stemDevice().querySelector('option[value="gpu"]').disabled,'successful install must refresh GPU / CPU choices immediately')
 expect(JSON.stringify(appSettings.value)===savedPreferences,'installer must preserve mode/device/enable choices')
 holdInstall=false;installResult={...installStatus}
 await chooseInstall(false)
 expect(appSettings.value.autoMixStemMode==='off','unchecked install choice must keep enhancement off after successful install')
 await chooseInstall(true)
 expect(appSettings.value.autoMixStemMode==='auto'&&appSettings.value.autoMixStemDevice==='auto','checked install choice must enable automatic GPU / CPU enhancement')
 expect(document.querySelector('[data-setting-id="autoMixStemMode"]').textContent.includes('显存'),'enabled enhancement must retain resource notice')
 expect(stemCache().value==='512','stem cache default must be 512 MiB')
 for(const capacity of ['0','256','512','1024','2048']){
  await change(stemCache(),capacity)
  expect(appSettings.value.autoMixStemCacheMiB===Number(capacity),'stem cache choice did not persist')
  open.value=false;await settle();reload();await settle();open.value=true;await settle()
  expect(stemCache().value===capacity,'stem cache choice was lost on component reopen')
 }
 for(const desired of ['natural','dj','off']){
  const previousMode=appSettings.value.autoMixMode
  await change(autoMix(),desired)
  if(desired==='dj'){
   const dialog=document.querySelector('dialog[aria-labelledby="automix-dj-title"]')
   expect(dialog.open&&dialog.textContent.includes('大幅跳过')&&dialog.textContent.includes('重叠混音'),'entering DJ must explain skipped content and mixing')
   const bounds=dialog.getBoundingClientRect()
   expect(Math.abs(bounds.x+bounds.width/2-document.documentElement.clientWidth/2)<2&&Math.abs(bounds.y+bounds.height/2-document.documentElement.clientHeight/2)<2,'DJ dialog must appear at viewport center')
   expect(appSettings.value.autoMixMode===previousMode&&autoMix().value===previousMode,'DJ must await confirmation before changing mode')
   Array.from(dialog.querySelectorAll('button')).find(button=>button.textContent.trim()==='取消').click();await settle()
   expect(!dialog.open&&appSettings.value.autoMixMode===previousMode,'cancelled DJ confirmation must retain original mode')
   await change(autoMix(),'dj')
   dialog.querySelector('[data-action="confirm-dj-mode"]').click();await settle()
   expect(!dialog.open,'successful DJ confirmation must dismiss the dialog')
  }
  expect(appSettings.value.autoMixMode===desired,'manual AutoMix choice did not reach the settings boundary')
  open.value=false;await settle();reload();await settle();open.value=true;await settle()
  expect(autoMix().value===desired&&!autoMix().disabled,'manual AutoMix choice was lost on component reopen')
 }
 for(const desired of ['continuity-first','bit-perfect-first','continuity-first']){
  await change(policy(),desired)
  if(desired==='continuity-first')await change(rate(),'96000')
  expect(engine.value.playbackPolicy===desired&&persisted.value.playbackPolicy===desired,'controller did not apply and persist selected policy')
  open.value=false;await settle();reload();await settle();open.value=true;await settle()
  expect(policy().value===desired,'reopened policy differs from persisted engine policy: '+policy().value)
  expect(audioOutputConfig.value.continuitySampleRate===96000,'reload dropped continuity target rate')
  expect(audioOutputConfig.value.pcmToDsdMode==='dsd128'&&audioOutputConfig.value.dsdMutePreRollFrames===1024,'reload dropped other output configuration fields')
  expect((!!rate())===(desired==='continuity-first'),'policy-dependent target selector visibility is stale')
  if(rate())expect(rate().value==='96000','reopened target-rate selector is stale')
 }
 appSettings.value={...appSettings.value,audioOutputConfig:{preferredBufferSize:8192}};await settle()
 expect(audioOutputConfig.value.preferredBufferSize===8192,'reload changed the persisted buffer preference')
 expect(policy().value==='bit-perfect-first'&&audioOutputConfig.value.continuitySampleRate===48000,'legacy configuration defaults changed')
 const releaseSwitch=()=>document.querySelector('button[aria-label="独占模式自动启停"]')
 expect(releaseSwitch().disabled,'auto release must require exclusive mode')
 exclusiveMode.value=true;await settle()
 expect(!releaseSwitch().disabled,'exclusive output must enable the auto release switch')
 releaseSwitch().click();await settle()
 expect(releasePolicy.persisted&&releasePolicy.applied&&releaseSwitch().getAttribute('aria-checked')==='true','auto release click must reach the validated output command, apply and persist')
 open.value=false;await settle();reload();open.value=true;await settle()
 expect(releaseSwitch().getAttribute('aria-checked')==='true','auto release must survive settings reload and component reopen')
 let finishRelease
 releasePolicy.hold=new Promise(resolve=>{finishRelease=resolve})
 releaseSwitch().click();await settle()
 expect(releaseSwitch().disabled&&releaseSwitch().getAttribute('aria-checked')==='true','pending output edit must disable the switch and retain confirmed state')
 releaseSwitch().click();await settle()
 expect(releasePolicy.edits.length===2,'pending auto release must not submit duplicate commands')
 finishRelease();releasePolicy.hold=null;await settle()
 expect(!releasePolicy.persisted&&!releasePolicy.applied&&releaseSwitch().getAttribute('aria-checked')==='false'&&!releaseSwitch().disabled,'turning auto release off must apply and persist')
 releasePolicy.fail=true;releaseSwitch().click();await settle()
 expect(!releasePolicy.persisted&&!releasePolicy.applied&&releaseSwitch().getAttribute('aria-checked')==='false'&&!releaseSwitch().disabled,'failed output edit must retain the saved policy and allow retry')
 expect(document.querySelector('.engine-error')?.textContent.includes('exclusive policy rejected'),'output error must be visible')
 releasePolicy.fail=false;releaseSwitch().click();await settle()
 expect(releasePolicy.persisted&&releasePolicy.applied&&releaseSwitch().getAttribute('aria-checked')==='true','retry must apply auto release')
 expect(!document.querySelector('.engine-error')?.textContent.includes('exclusive policy rejected'),'successful retry must clear the old output error')
 exclusiveAvailable.value=false;await settle()
 expect(releaseSwitch().disabled,'unsupported output must disable auto release')
 app.unmount();return 'PLAYBACK_POLICY_OK: playback policies and exclusive auto release apply, persist, reopen, reject and retry correctly'
}
`
