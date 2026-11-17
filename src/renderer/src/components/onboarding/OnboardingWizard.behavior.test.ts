import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('welcome wizard keeps choices, audition and retryable Core-backed saves in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-onboarding-'))
  try {
    const fixture = fileURLToPath(new URL('./onboarding.fixture.mjs', import.meta.url))
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'onboarding-native-boundary',
          enforce: 'pre',
          resolveId(source, importer) {
            if (
              source.endsWith('/useSettingsStore.ts') &&
              importer?.endsWith('onboarding.fixture.mjs')
            )
              return null
            const name = source.match(
              /\/(useSettingsStore|useMusicStore|useAudioOutputDspStore|usePlayerStore|useNcmStore|useProviderStore)(?:\.ts)?$/
            )?.[1]
            return name ? '\0onboarding-store:' + name : null
          },
          load(id) {
            return id.startsWith('\0onboarding-store:')
              ? `export { ${id.split(':')[1]} } from ${JSON.stringify(fixture)}`
              : null
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
        lib: { entry: fixture, name: 'OnboardingTest', formats: ['iife'], fileName: 'runtime' }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}body::before,body::after{display:none!important}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'preload.cjs'),
      `const {ipcRenderer}=require('electron');window.onboardingTestIpc={invoke:(...args)=>ipcRenderer.invoke(...args)}`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');const visible=process.argv.includes('--show');app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('force-device-scale-factor','1');app.whenReady().then(async()=>{const win=new BrowserWindow({title:'Twilight Echo · 欢迎向导预览',show:visible,width:1200,height:900,useContentSize:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:false,backgroundThrottling:false,offscreen:!visible}});ipcMain.handle('onboarding-resize',async(_event,w,h)=>{win.setContentSize(w,h);return true});ipcMain.handle('onboarding-capture',async(_event,label)=>{const dir=process.env.TWILIGHT_ONBOARDING_VISUAL_DIR;if(!dir)return;await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,label+'.png'),(await win.webContents.capturePage()).toPNG())});win.webContents.on('console-message',(_e,_l,message)=>console.error(message));try{await win.loadFile(path.join(__dirname,'index.html'));if(visible){await win.webContents.executeJavaScript('window.previewOnboarding()');return}await win.webContents.executeJavaScript('window.runOnboardingTests()');console.log('ONBOARDING_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}});app.on('window-all-closed',()=>app.quit())`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /ONBOARDING_OK/)
    if (process.env.TWILIGHT_ONBOARDING_PREVIEW_DIR) {
      const destination = resolve(process.env.TWILIGHT_ONBOARDING_PREVIEW_DIR)
      assert.ok(destination.startsWith(resolve(workspace, 'output') + sep))
      await mkdir(destination, { recursive: true })
      await cp(directory, destination, { recursive: true })
    }
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})
