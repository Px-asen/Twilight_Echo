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
  'background track enrichment updates visible rows, covers and collections without blank frames',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-metadata-refresh-'))
    try {
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'metadata-refresh-fixture',
            enforce: 'pre',
            resolveId(source) {
              if (/(?:^|\/)coreConnection(?:\.ts)?$/.test(source)) return '\0refresh-core'
              if (/(?:^|\/)useSettingsStore(?:\.ts)?$/.test(source)) return '\0refresh-settings'
              if (/(?:^|\/)usePlayerStore(?:\.ts)?$/.test(source)) return '\0refresh-player'
              return null
            },
            load(id) {
              if (id === '\0refresh-core')
                return 'export const useCoreConnection=()=>window.refreshCore'
              if (id === '\0refresh-settings')
                return 'export const useSettingsStore=()=>window.refreshSettings'
              if (id === '\0refresh-player')
                return 'export const usePlayerStore=()=>window.refreshPlayer'
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
          minify: false,
          lib: {
            entry: fileURLToPath(new URL('./metadataRefresh.fixture.mjs', import.meta.url)),
            name: 'MetadataRefreshTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">${files
          .filter((f) => f.endsWith('.css'))
          .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
          .join(
            ''
          )}<style>body{margin:0}#app{height:100vh;display:grid;grid-template-columns:minmax(0,1fr) 300px}.song-list{height:100vh}.task-panel{border-left:1px solid var(--te-neutral-200);--notice-border:var(--te-neutral-200)}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', join(directory, 'runner.cjs')],
        {
          windowsHide: true,
          timeout: 45_000,
          env,
          maxBuffer: 1024 * 1024
        }
      )
      assert.match(result.stdout, /METADATA_REFRESH_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runner = `
const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path')
app.setPath('userData',path.join(__dirname,'profile'))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:false,contextIsolation:false,offscreen:true,backgroundThrottling:false}})
 try{
  await win.loadFile(path.join(__dirname,'index.html'))
  for(const theme of ['pureWhite','dark']){
   await win.webContents.executeJavaScript('document.documentElement.dataset.theme='+JSON.stringify(theme))
   await win.webContents.executeJavaScript('window.checkMetadataRefresh()')
   if(process.env.TWILIGHT_METADATA_REFRESH_EVIDENCE_DIR){
    fs.mkdirSync(process.env.TWILIGHT_METADATA_REFRESH_EVIDENCE_DIR,{recursive:true})
    fs.writeFileSync(path.join(process.env.TWILIGHT_METADATA_REFRESH_EVIDENCE_DIR,'metadata-refresh-'+theme+'.png'),(await win.webContents.capturePage()).toPNG())
   }
  }
  console.log('METADATA_REFRESH_OK');app.exit(0)
 }catch(error){console.error(error.stack);console.error(await win.webContents.executeJavaScript('document.body.innerText.slice(0,3000)'));app.exit(1)}
})`
