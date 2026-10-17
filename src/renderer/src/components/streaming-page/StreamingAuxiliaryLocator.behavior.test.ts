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
  'streaming search and cloud rows share a real scroll locator without changing user actions',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-aux-locator-'))
    try {
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [vue()],
        resolve: {
          alias: {
            '@renderer': join(workspace, 'src/renderer/src'),
            vue: require.resolve('vue/dist/vue.esm-bundler.js')
          }
        },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
        build: {
          outDir: join(directory, 'bundle'),
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: fileURLToPath(
              new URL('./streamingAuxiliaryLocator.fixture.mjs', import.meta.url)
            ),
            name: 'StreamingAuxiliaryLocatorTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8">${files
          .filter((file) => file.endsWith('.css'))
          .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
          .join(
            ''
          )}<style>html,body{margin:0}#shell{height:600px;overflow-y:auto;position:relative;padding:16px;box-sizing:border-box}#app{height:auto!important;min-height:1500px}.player-bar-shell{position:fixed;bottom:0;height:70px;left:0;right:0;pointer-events:none}</style></head><body><div id="shell"><div id="app"></div></div><div class="player-bar-shell"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', join(directory, 'runner.cjs'), directory],
        {
          windowsHide: true,
          timeout: 80_000,
          env,
          maxBuffer: 1024 * 1024
        }
      )
      assert.match(result.stdout, /AUX_LOCATOR_OK/)
    } finally {
      const target = resolve(directory)
      assert.ok(target.startsWith(resolve(tmpdir()) + sep))
      await rm(target, { recursive: true, force: true })
    }
  }
)

const runner = `const {app,BrowserWindow}=require('electron'),path=require('node:path');
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false,offscreen:true}});try{await win.loadFile(path.join(directory,'index.html'));console.log(await win.webContents.executeJavaScript('window.runAuxLocatorChecks()'));app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}});`
