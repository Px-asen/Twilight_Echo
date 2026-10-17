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
  'local song lists locate only offscreen current tracks without altering playback or selection',
  {
    timeout: 90_000
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-locate-playing-'))
    try {
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'locate-playback-boundary',
            enforce: 'pre',
            resolveId(source) {
              return /\/stores\/usePlayerStore(?:\.ts)?$/.test(source) ? '\0locate-player' : null
            },
            load(id) {
              return id === '\0locate-player'
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
            entry: fileURLToPath(new URL('./locatePlayingTrack.fixture.mjs', import.meta.url)),
            name: 'LocatePlayingTrackTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html>
<html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">
${files
  .filter((f) => f.endsWith('.css'))
  .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
  .join('')}
<style>
body{margin:0}#app{height:100vh}
.song-list{scroll-padding-top:44px}
.window-caption{position:fixed;inset:0 0 auto;height:44px;background:#eee;z-index:50;pointer-events:none}
.player-bar-shell{position:fixed;bottom:0;left:0;right:0;height:90px;background:#ddd;z-index:50}
.player-bar-shell[data-te-playbar-hidden='true']{visibility:hidden}
</style></head><body><div id="app"></div><div class="window-caption"></div><div class="player-bar-shell"></div>
<script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), runner)
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), directory],
        {
          windowsHide: true,
          timeout: 80_000,
          env,
          maxBuffer: 1024 * 1024
        }
      )
      assert.match(result.stdout, /LOCATE_PLAYING_OK/)
      assert.match(result.stdout, /AGGREGATE_LOCATE_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const runner = `
const {app,BrowserWindow}=require('electron');const path=require('node:path');const fs=require('node:fs');
const directory=process.argv.at(-1);app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:900,useContentSize:true,opacity:0,focusable:false,skipTaskbar:true,webPreferences:{contextIsolation:false,nodeIntegration:false,backgroundThrottling:false}});
 win.showInactive();
 win.webContents.on('console-message',(_event,_level,message)=>console.error(message));
 try {
  await win.loadFile(path.join(directory,'index.html'));
  console.log(await win.webContents.executeJavaScript('window.runLocateChecks()'));
  for(const theme of ['pureWhite','dark'])for(const width of [1280,520]){
   win.setContentSize(width,900);
   await win.webContents.executeJavaScript('window.locateAppearance('+JSON.stringify(theme)+')');
   if(process.env.TWILIGHT_LOCATE_EVIDENCE_DIR){
    fs.mkdirSync(process.env.TWILIGHT_LOCATE_EVIDENCE_DIR,{recursive:true});
    fs.writeFileSync(path.join(process.env.TWILIGHT_LOCATE_EVIDENCE_DIR,theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
   }
  }
  await win.webContents.executeJavaScript('window.disposeLocateChecks()');
  console.log(await win.webContents.executeJavaScript('window.runAggregateLocateChecks()'));
  app.exit(0);
 }catch(e){console.error(e.stack);app.exit(1)}
});`
