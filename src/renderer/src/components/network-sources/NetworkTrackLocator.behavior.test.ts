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
  'network, radio and podcast rows locate the current track in Electron',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-network-track-locator-'))
    try {
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'network-locator-player-boundary',
            enforce: 'pre',
            resolveId(source) {
              return /\/stores\/usePlayerStore(?:\.ts)?$/.test(source) ? '\0locator-player' : null
            },
            load(id) {
              return id === '\0locator-player'
                ? 'export const usePlayerStore = () => window.locatePlayer'
                : null
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
            entry: fileURLToPath(new URL('./networkTrackLocator.fixture.mjs', import.meta.url)),
            name: 'NetworkTrackLocatorTests',
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
          )}<style>body{margin:0}#app{height:100vh}.window-caption{position:fixed;inset:0 0 auto;height:36px;pointer-events:none}.player-bar-shell{position:fixed;bottom:0;height:76px;left:0;right:0;pointer-events:none}</style></head><body><div id="app"></div><div class="window-caption"></div><div class="player-bar-shell"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /NETWORK_TRACK_LOCATOR_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runner = `const {app,BrowserWindow}=require('electron');const path=require('node:path');app.setPath('userData',path.join(process.argv.at(-1),'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{nodeIntegration:false,contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(path.join(process.argv.at(-1),'index.html'));console.log(await win.webContents.executeJavaScript('window.runNetworkLocatorChecks()'));app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}});`
