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
              /\/(useSettingsStore|useMusicStore|useThemeStore|useAudioOutputDspStore|usePlayerStore|useListeningStatsStore|coreConnection|registry)(?:\.ts)?$/
            )?.[1]
            if (name) return '\0organization-store:' + name
            if (source.endsWith('/AudioDeviceProfilesPanel.vue')) return '\0organization-profiles'
            if (source.endsWith('/AppUpdatePanel.vue')) return '\0organization-update'
            return null
          },
          load(id) {
            if (id === '\0organization-icon')
              return 'export default "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII="'
            if (id === '\0organization-store:coreConnection')
              return 'export function useCoreConnection(){return {state:{value:null},status:{value:null},query: async (name) => name === "audio.recovery" ? {kind:null,phase:"idle",engineAvailable:true,windowsServicesAvailable:true,error:null} : null, command: async (name,payload)=>{if(name==="backup.preview")return window.api.data?.previewPersonalBackup?.();if(name==="backup.stage")return window.api.data?.stagePersonalRestore?.(payload?.options);return null}}}'
            if (id.startsWith('\0organization-store:')) {
              const name = id.split(':')[1]
              return `export { ${name === 'registry' ? 'useExtensionRegistry' : name}${name === 'useListeningStatsStore' ? ', waitForListeningStatsReady' : ''} } from ${JSON.stringify(fixture)};${name === 'useThemeStore' ? 'export const syncThemeSettingsAppearance = () => {};' : ''}`
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
    if (evidence) await mkdir(evidence, { recursive: true })
    await writeFile(
      join(directory, 'runner.cjs'),
      `
const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1');
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1024,height:768,useContentSize:true,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,offscreen:true}});
ipcMain.handle('organization:key',async(_event,keyCode)=>{win.webContents.focus();win.webContents.sendInputEvent({type:'keyDown',keyCode});if(keyCode==='Space'||keyCode==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:keyCode==='Space'?' ':String.fromCharCode(13)});win.webContents.sendInputEvent({type:'keyUp',keyCode});await new Promise(resolve=>setTimeout(resolve,60))});
win.webContents.on('console-message',(event)=>{if(String(event.message).includes('Error'))console.error(event.message,'@',JSON.stringify(event.location||null))});
try{await win.loadFile(path.join(__dirname,'index.html'));await win.webContents.executeJavaScript("window.organizationKey=(key)=>require('electron').ipcRenderer.invoke('organization:key',key);void 0");win.setContentSize(1440,900);console.log(await win.webContents.executeJavaScript('window.runSettingsOrganizationTests()'));
for(const width of [1440,1024,760]){win.setContentSize(width,width===760?692:900);await new Promise(resolve=>setTimeout(resolve,80));for(const theme of ['pureWhite','dark'])for(const material of ['solid','image','glass'])for(const section of ['general','appearance','playback','lyrics','library','connections','system']){const overflow=await win.webContents.executeJavaScript('window.prepareSettingsEvidence('+JSON.stringify(theme)+','+JSON.stringify(section)+','+JSON.stringify(material)+')');if(overflow.length)throw Error('overflow at '+width+'/'+theme+'/'+material+'/'+section+': '+JSON.stringify(overflow));if(section==='general')await win.webContents.executeJavaScript('window.checkSettingsSearchPopup()');if(${JSON.stringify(evidence || '')}&&['general','appearance','lyrics','playback','system'].includes(section))fs.writeFileSync(path.join(${JSON.stringify(evidence || '')},width+'-'+theme+'-'+material+'-'+section+'.png'),(await win.webContents.capturePage()).toPNG());}}
app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(require('electron'), ['--no-sandbox', join(directory, 'runner.cjs')], {
      windowsHide: true,
      timeout: 120000,
      env
    })
    assert.match(result.stdout, /SETTINGS_ORGANIZATION_OK/)
    console.log(result.stdout.trim())
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    assert.ok(directory.includes('twilight-settings-organization-'))
    await rm(directory, { recursive: true, force: true })
  }
})
