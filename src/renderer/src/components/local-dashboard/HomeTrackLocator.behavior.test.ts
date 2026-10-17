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
  'home song rows share one locator and track only the active rendered rows',
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-home-locator-'))
    try {
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'home-locator-store-fixtures',
            enforce: 'pre',
            resolveId(source) {
              if (/\/stores\/usePlayerStore(?:\.ts)?$/.test(source)) return '\0home-player'
              if (/\/stores\/useMusicStore(?:\.ts)?$/.test(source)) return '\0home-music'
              if (/\/stores\/useListeningStatsStore(?:\.ts)?$/.test(source))
                return '\0home-listening-stats'
              if (/\/stores\/useAudioOutputDspStore(?:\.ts)?$/.test(source))
                return '\0home-audio-dsp'
              if (/\/stores\/useSettingsStore(?:\.ts)?$/.test(source)) return '\0home-settings'
              if (source === 'pinia') return '\0home-pinia'
              return null
            },
            load(id) {
              const fixtures = {
                '\0home-player': `export const usePlayerStore=()=>window.homePlayer`,
                '\0home-music': `export const useMusicStore=()=>window.homeMusic`,
                '\0home-listening-stats': `export const useListeningStatsStore=()=>window.homeStats;export const getMostListenedTracks=()=>[];export const getRecentTracks=()=>[]`,
                '\0home-audio-dsp': `export const useAudioOutputDspStore=()=>window.homeDsp`,
                '\0home-settings': `export const useSettingsStore=()=>window.homeSettings`,
                '\0home-pinia': `export const storeToRefs=value=>value`
              }
              return fixtures[id] ?? null
            }
          },
          vue()
        ],
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
            entry: fileURLToPath(new URL('./HomeTrackLocator.fixture.mjs', import.meta.url)),
            name: 'HomeTrackLocatorTests',
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
          .join('')}<style>
html,body,#app{height:100%;margin:0}#app{padding:0}.home-test-scroll{height:100%;overflow:auto;position:relative;scroll-behavior:auto}.home-test-spacer{height:760px}.home-test-pages>*{min-height:500px}.player-bar-shell{position:fixed;bottom:0;left:0;right:0;height:72px;background:#ddd;z-index:100}.home-test-pages .home,.home-test-pages main,.home-test-pages .music-home,.home-test-pages .home-view,.home-test-pages .rankings-panel{max-width:none!important}
</style></head><body><div id="app"></div><div class="player-bar-shell"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 80_000, env, maxBuffer: 1024 * 1024 }
      )
      assert.match(result.stdout, /HOME_LOCATOR_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runner = `
const {app,BrowserWindow}=require('electron');const path=require('node:path');
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1280,height:520,useContentSize:true,focusable:false,skipTaskbar:true,webPreferences:{backgroundThrottling:false,offscreen:true}});try{await win.loadFile(path.join(directory,'index.html'));console.log(await win.webContents.executeJavaScript('window.runHomeLocatorChecks()'));app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}});`
