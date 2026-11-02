import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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

test(
  'library pages keep unified history and aligned, single-count folder, artist, and album grids in Electron',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-recent-track-locator-'))
    try {
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'recent-locator-boundaries',
            enforce: 'pre',
            resolveId(source) {
              if (/(?:^|\/)coreConnection(?:\.ts)?$/.test(source)) return '\0recent-core'
              if (/(?:^|\/)useSettingsStore(?:\.ts)?$/.test(source)) return '\0recent-settings'
              if (/(?:^|\/)usePlayerStore(?:\.ts)?$/.test(source)) return '\0recent-player'
              return null
            },
            load(id) {
              if (id === '\0recent-core')
                return 'export const useCoreConnection=()=>window.locateCore'
              if (id === '\0recent-settings')
                return 'export const useSettingsStore=()=>window.locateSettings'
              if (id === '\0recent-player')
                return 'export const usePlayerStore=()=>window.locatePlayer'
              return null
            }
          },
          vue()
        ],
        resolve: {
          alias: {
            '@renderer': join(workspace, 'src/renderer/src'),
            vue: require.resolve('vue/dist/vue.esm-bundler.js'),
            pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
          }
        },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
        build: {
          outDir: join(directory, 'bundle'),
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: fileURLToPath(new URL('./recentTrackLocator.fixture.mjs', import.meta.url)),
            name: 'RecentTrackLocatorTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">${files
          .filter((file) => file.endsWith('.css'))
          .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
          .join(
            ''
          )}<style>body{margin:0}#app{height:100vh}.window-caption{position:fixed;inset:0 0 auto;height:40px;pointer-events:none}.player-bar-shell{position:fixed;bottom:0;left:0;right:0;height:76px;pointer-events:none}</style></head><body><div id="app"></div><div class="window-caption"></div><div class="player-bar-shell"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', '--enable-logging=stderr', join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /RECENT_TRACK_LOCATOR_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs')
app.setPath('userData',path.join(process.argv.at(-1),'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}})
 const evidence=process.env.TWILIGHT_LIBRARY_UI_EVIDENCE_DIR
 const capture=async name=>{if(evidence){fs.mkdirSync(evidence,{recursive:true});await new Promise(resolve=>setTimeout(resolve,100));fs.writeFileSync(path.join(evidence,name+'.png'),(await win.webContents.capturePage()).toPNG())}}
 try{
  await win.loadFile(path.join(process.argv.at(-1),'index.html'))
  console.log(await win.webContents.executeJavaScript('window.runRecentLocatorChecks()'))
  await win.webContents.executeJavaScript('window.checkRecentLayout()');await capture('recent-wide')
  win.setContentSize(620,800);await win.webContents.executeJavaScript('window.checkRecentLayout()');await capture('recent-narrow')
  await win.webContents.executeJavaScript('(async()=>{await window.openFolderChecks();await window.checkFolderLayout()})()');await capture('folders-narrow')
  win.setContentSize(1200,800);await win.webContents.executeJavaScript('window.checkFolderLayout()');await capture('folders-wide')
  for(const kind of ['artists','albums']){
   win.setContentSize(1440,900);await win.webContents.executeJavaScript('(async()=>{await window.openCollectionChecks("'+kind+'");await window.checkCollectionLayout("'+kind+'")})()');await capture(kind+'-wide')
   win.setContentSize(620,900);await win.webContents.executeJavaScript('window.checkCollectionLayout("'+kind+'")');await capture(kind+'-narrow')
  }
  await win.webContents.executeJavaScript('window.finishLibraryChecks()');app.exit(0)
 }catch(e){console.error(e.stack);console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(0,1800)'));app.exit(1)}
})`
