import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
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
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))
test('real settings groups reveal stable search targets, preserve drafts, and remain usable across themes and sizes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-settings-organization-'))
  try {
    const app = parse(await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8'))
    await writeFile(
      join(directory, 'app.css'),
      app.descriptor.styles.map((style) => style.content).join('\n')
    )
    const fixture = fileURLToPath(new URL('./settingsOrganization.fixture.mjs', import.meta.url))
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'settings-organization-native-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (source === '/icon.png') return '\0organization-icon'
            if (
              source.endsWith('/useSettingsStore.ts') &&
              importer?.endsWith('settingsOrganization.fixture.mjs')
            )
              return null
            const name = source.match(
              /\/(useSettingsStore|useMusicStore|useThemeStore|useAudioOutputDspStore|usePlayerStore|useListeningStatsStore|registry)(?:\.ts)?$/
            )?.[1]
            if (name) return '\0organization-store:' + name
            if (source.endsWith('/AudioDeviceProfilesPanel.vue')) return '\0organization-profiles'
            if (source.endsWith('/AppUpdatePanel.vue')) return '\0organization-update'
            if (source.endsWith('AppearanceWindowPreview.vue')) return '\0organization-window'
            if (/\/(ThemeStudioPage|ThemeWorkshopPage)\.vue$/.test(source))
              return '\0organization-theme-engine'
            return null
          },
          load(id) {
            if (id === '\0organization-theme-engine')
              return `import {computed,ref} from 'vue';export default {props:['initialKey','initialProjectId'],setup(props,{expose}){const key=ref(props.initialKey??'workshop:'+(props.initialProjectId??'new')),tone=ref('pureWhite');expose({state:computed(()=>({key:key.value,tone:tone.value,busy:false,dirty:false,hasUnsavedChanges:false})),prepareLeave:async()=>true,collapse:async()=>false,selectKey:async value=>{key.value=value},setTone:value=>{tone.value=value}});return ()=>null}}`
            if (id === '\0organization-window')
              return `import {computed,ref,onMounted,onBeforeUnmount} from 'vue';export default {props:['draft','tone','focusedRegion'],emits:['region'],setup(props,{expose}){const size=ref({width:innerWidth,height:innerHeight});const resize=()=>{size.value={width:innerWidth,height:innerHeight}};onMounted(()=>window.addEventListener('resize',resize));onBeforeUnmount(()=>window.removeEventListener('resize',resize));expose({zoomIn:()=>{},zoomOut:()=>{},fitPart:()=>{}});return {size,style:computed(()=>({'--appearance-color':props.draft.appBackground.global[props.tone]}))}},template:${JSON.stringify('<div class="appearance-window-preview" :style="style" :data-source-width="size.width" :data-source-height="size.height" :data-selected="focusedRegion"><button aria-label="调整标题栏材质" @click="$emit(\'region\',\'material\',$event)">标题栏</button><slot name="context-tools"></slot></div>')} }`
            if (id === '\0organization-icon')
              return 'export default "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII="'
            if (id.startsWith('\0organization-store:')) {
              const name = id.split(':')[1]
              return `export { ${name === 'registry' ? 'useExtensionRegistry, syncExtensions' : name}${name === 'useListeningStatsStore' ? ', waitForListeningStatsReady' : ''} } from ${JSON.stringify(fixture)};${name === 'useThemeStore' ? 'export const syncThemeSettingsAppearance = () => {}; export const previewAppearance = async () => {};' : ''}`
            }
            if (id === '\0organization-profiles')
              return `export default { template: '<details id="device-profiles"><summary>设备档案</summary><p>一次应用设备与输出策略</p></details>' }`
            if (id === '\0organization-update')
              return `export default { template: '<div class="update-card" data-setting-id="app-update"><strong>当前版本已是最新</strong><div data-setting-id="app-update-install"><button>检查更新</button></div></div>' }`
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: resolve(require.resolve('pinia'), '../dist/pinia.mjs')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: fixture,
          name: 'SettingsOrganization',
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
        )}<link rel="stylesheet" href="app.css"><style>body{margin:0;font:14px system-ui}*{box-sizing:border-box}.settings-preview-page{scroll-behavior:auto}.glass-card{background:var(--te-card-bg,#fff);border:1px solid var(--te-card-border,#e4e8ef);border-radius:20px}</style></head><body><div id="app"></div><script>window.api=new Proxy({}, {get:(target,service)=>Object.hasOwn(target,service)?target[service]:new Proxy({}, {get:(_module,method)=>method.startsWith('on')?()=>()=>{}:async()=>method==='getAutoMixStemCapabilities'?{status:'missing',cpu:false,gpu:false,packs:[]}:method==='getAutoMixStemInstallStatus'?{phase:'idle',completedBytes:0,totalBytes:0}:method==='listInstalled'||method==='getShortcutStatuses'?[]:null})});window.api=Object.assign(window.api,{})</script><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    const evidence = process.env.TWILIGHT_SETTINGS_EVIDENCE_DIR
    const metricsPath = process.env.TWILIGHT_SETTINGS_METRICS_PATH
    if (evidence) await mkdir(evidence, { recursive: true })
    await writeFile(
      join(directory, 'runner.cjs'),
      `
const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1024,height:768,useContentSize:true,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
ipcMain.handle('organization:key',async(_event,keyCode)=>{win.webContents.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Space'||keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:keyCode==='Space'?' ':String.fromCharCode(13)});win.webContents.sendInputEvent({type:'keyUp',keyCode});await new Promise(resolve=>setTimeout(resolve,60))});
ipcMain.handle('organization:pointer',(_event,x,y)=>win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(x),y:Math.round(y)}));
ipcMain.handle('organization:resize',async(_event,width,height)=>{win.setContentSize(width,height);await new Promise(resolve=>setTimeout(resolve,80))});
// Hidden Electron windows otherwise suppress :focus-visible even for trusted key events.
const enableKeyboardFocus=async()=>{win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})};
win.webContents.on('console-message',(_event,_level,message)=>{if(message.includes('Error'))console.error(message)});
try{await win.loadFile(path.join(__dirname,'index.html'));await win.webContents.executeJavaScript("window.organizationKey=(key)=>require('electron').ipcRenderer.invoke('organization:key',key);window.organizationPointer=(x,y)=>require('electron').ipcRenderer.invoke('organization:pointer',x,y);window.organizationResize=(width,height)=>require('electron').ipcRenderer.invoke('organization:resize',width,height);void 0");
if(${process.env.TWILIGHT_SETTINGS_INTERACTION_ONLY === '1'}){await enableKeyboardFocus();for(const theme of ['pureWhite','dark']){console.log(await win.webContents.executeJavaScript('window.runSettingsInteractionTests('+JSON.stringify(theme)+')'));if(${JSON.stringify(evidence || '')})fs.writeFileSync(path.join(${JSON.stringify(evidence || '')},'interaction-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());}app.exit(0);return;}
const layoutMetrics=[];for(const [width,height,fontSize] of [[1366,768,14],[760,692,14],[1100,600,14],[760,692,20],[760,692,28],[1100,600,28]]){win.setContentSize(width,height);await new Promise(resolve=>setTimeout(resolve,80));for(const theme of ['pureWhite','dark'])for(const section of ['general','playback','audio','lyrics','library','connections','system','about'])layoutMetrics.push(await win.webContents.executeJavaScript('window.inspectSettingsLayout('+JSON.stringify(theme)+','+JSON.stringify(section)+','+fontSize+')'));}
if(${JSON.stringify(metricsPath || '')})fs.writeFileSync(${JSON.stringify(metricsPath || '')},JSON.stringify({fixture:'real SettingsPage and ordinary sections; native services mocked',cases:layoutMetrics},null,2));
const layoutIssues=layoutMetrics.flatMap(item=>item.issues.map(issue=>({width:item.width,height:item.height,fontSize:item.fontSize,section:item.section,theme:item.theme,...issue})));console.log('SETTINGS_LAYOUT: '+layoutMetrics.length+' cases; '+layoutIssues.length+' issues');if(layoutIssues.length)throw Error('settings layout issues: '+JSON.stringify(layoutIssues.slice(0,12)));
if(${process.env.TWILIGHT_SETTINGS_LAYOUT_ONLY === '1'}){console.log('SETTINGS_LAYOUT_OK');app.exit(0);return;}
await win.webContents.executeJavaScript("document.documentElement.style.setProperty('--te-font-size-body','14px')");win.setContentSize(1440,900);console.log(await win.webContents.executeJavaScript('window.runSettingsOrganizationTests()'));
await enableKeyboardFocus();for(const theme of ['pureWhite','dark']){console.log(await win.webContents.executeJavaScript('window.runSettingsInteractionTests('+JSON.stringify(theme)+')'));if(${JSON.stringify(evidence || '')})fs.writeFileSync(path.join(${JSON.stringify(evidence || '')},'interaction-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());}
for(const width of [1440,1024,760]){win.setContentSize(width,width===760?692:900);await new Promise(resolve=>setTimeout(resolve,80));for(const theme of ['pureWhite','dark'])for(const material of ['solid','image','glass'])for(const section of ['general','playback','audio','lyrics','library','connections','system','about']){const overflow=await win.webContents.executeJavaScript('window.prepareSettingsEvidence('+JSON.stringify(theme)+','+JSON.stringify(section)+','+JSON.stringify(material)+')');if(overflow.length)throw Error('overflow at '+width+'/'+theme+'/'+material+'/'+section+': '+JSON.stringify(overflow));if(section==='general')await win.webContents.executeJavaScript('window.checkSettingsSearchPopup()');if(${JSON.stringify(evidence || '')}&&['general','audio','lyrics','playback','system','about'].includes(section))fs.writeFileSync(path.join(${JSON.stringify(evidence || '')},width+'-'+theme+'-'+material+'-'+section+'.png'),(await win.webContents.capturePage()).toPNG());}}
win.setContentSize(1440,900);console.log(await win.webContents.executeJavaScript('window.runAppearanceWorkspaceTests()'));
for(const theme of ['pureWhite','dark'])for(const fontSize of [14,18,28])console.log(await win.webContents.executeJavaScript('window.checkUnifiedTypography('+JSON.stringify(theme)+','+fontSize+')'));
for(const [width,height] of [[1440,900],[1024,640],[760,692],[520,600]]){win.setContentSize(width,height);for(const theme of ['pureWhite','dark']){const overflow=await win.webContents.executeJavaScript('window.prepareAppearanceWorkspaceEvidence('+JSON.stringify(theme)+')');if(overflow.length)throw Error('appearance overflow at '+width+'/'+height+'/'+theme+': '+JSON.stringify(overflow));if(${JSON.stringify(evidence || '')})fs.writeFileSync(path.join(${JSON.stringify(evidence || '')},'workspace-'+width+'-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());}}
app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      windowsHide: true,
      timeout: 180000,
      env
    })
    assert.match(
      result.stdout,
      process.env.TWILIGHT_SETTINGS_INTERACTION_ONLY === '1'
        ? /SETTINGS_INTERACTION_OK/
        : process.env.TWILIGHT_SETTINGS_LAYOUT_ONLY === '1'
          ? /SETTINGS_LAYOUT_OK/
          : /SETTINGS_ORGANIZATION_OK/
    )
    console.log(result.stdout.trim())
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    assert.ok(directory.includes('twilight-settings-organization-'))
    await rm(directory, { recursive: true, force: true })
  }
})
