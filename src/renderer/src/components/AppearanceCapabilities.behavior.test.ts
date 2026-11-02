import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
test('current appearance UI connects real settings, draft history, search and theme editing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-appearance-capabilities-'))
  try {
    await writeFile(
      join(directory, 'entry.ts'),
      await readFile(resolve('scripts/fixtures/appearance-capabilities.mjs'), 'utf8')
    )
    const isolatedStores = join(directory, 'preview-stores.ts')
    await writeFile(
      isolatedStores,
      (
        await readFile(resolve('scripts/fixtures/appearance-preview-stores.mjs'), 'utf8')
      ).replaceAll('__SHARED__', resolve('src/shared').replaceAll('\\', '/'))
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'appearance-capability-boundaries',
          enforce: 'pre',
          resolveId(source, importer) {
            if (source.endsWith('/WorkshopPreview.vue')) return '\0capabilities-unused'
            if (/\/(?:EmbeddedExperience|ExperienceView)\.vue$/.test(source))
              return '\0capabilities-unused'
            if (source === '/icon.png') return resolve('resources/icon.png')
            if (/\/extensions\/registry(?:\.ts)?$/.test(source)) return '\0capabilities-registry'
            if (
              /\/stores\/(usePlayerStore|useMusicStore|useListeningStatsStore|useAudioOutputDspStore|useNcmStore|useProviderStore|useAppNoticeStore|playbackBookmarks|lyricsManagement)(?:\.ts)?$/.test(
                source
              ) ||
              /\/providers(?:\/index(?:\.ts)?)?$/.test(source)
            )
              return isolatedStores
            if (
              importer?.includes('ThemeStudioPage.vue') &&
              /\/(SongList|EqualizerPage|LocalHome|PlayingMusic)\.vue$/.test(source)
            )
              return '\0capabilities-unused'
            return null
          },
          load(id) {
            if (id === '\0capabilities-registry')
              return "import {ref} from 'vue';export const fixtureThemes=ref([]);const empty=ref([]);export const syncExtensions=async()=>{};export const useExtensionRegistry=()=>({themeContributions:fixtureThemes,uiContributions:empty,syncExtensions})"
            if (id === '\0capabilities-unused') return 'export default {render:()=>null}'
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          '@main': resolve('src/main'),
          pinia: require.resolve('pinia'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'Capabilities',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<style>body{margin:0;background:var(--te-settings-backplate)}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const output = process.env.TE_CAPABILITIES_EVIDENCE
    if (output) await mkdir(output, { recursive: true })
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /APPEARANCE_CAPABILITIES_REAL_OK/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-appearance-capabilities-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `
const {app,BrowserWindow,protocol}=require('electron'),path=require('node:path'),fs=require('node:fs/promises');
app.setPath('userData',path.join(__dirname,'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'background',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.whenReady().then(async()=>{let win;try{
protocol.handle('background',()=>new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),{headers:{'content-type':'image/png'}}));
win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
await win.loadFile(path.join(__dirname,'index.html'));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
await win.webContents.executeJavaScript('window.runCapabilities()');
await win.webContents.executeJavaScript('window.prepareCapabilityScreenshots()');
for(const [width,height,tone,font] of [[1280,800,'dark',14],[1024,768,'pureWhite',14],[521,720,'dark',22]]){
win.setContentSize(width,height);for(const panel of ['global-font','player-bar','outer-panel','card','general']){
await win.webContents.executeJavaScript('window.inspectCapabilityPanel('+[panel,tone,font].map(JSON.stringify).join(',')+')');
if(process.env.TE_CAPABILITIES_EVIDENCE)await fs.writeFile(path.join(process.env.TE_CAPABILITIES_EVIDENCE,panel+'-'+tone+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
}}
win.setContentSize(1280,800);
await win.webContents.executeJavaScript('window.runAdvancedCapabilities()');
for(const [width,height,tone,font] of [[1280,800,'dark',14],[521,720,'pureWhite',22]]){
win.setContentSize(width,height);for(const panel of ['css','layers','parameters','layout','skin']){
await win.webContents.executeJavaScript('window.inspectAdvancedPanel('+[panel,tone,font].map(JSON.stringify).join(',')+')');
if(process.env.TE_CAPABILITIES_EVIDENCE)await fs.writeFile(path.join(process.env.TE_CAPABILITIES_EVIDENCE,'advanced-'+panel+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
}
await win.webContents.executeJavaScript('window.closeAdvancedPanel()');
if(process.env.TE_CAPABILITIES_EVIDENCE)await fs.writeFile(path.join(process.env.TE_CAPABILITIES_EVIDENCE,'advanced-workspace-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
}
await win.webContents.executeJavaScript('window.runLegacyPlayerSettings()');
console.log('APPEARANCE_CAPABILITIES_REAL_OK');win.destroy();app.exit(0);
}catch(e){console.error(e.stack);if(win&&process.env.TE_CAPABILITIES_EVIDENCE)await fs.writeFile(path.join(process.env.TE_CAPABILITIES_EVIDENCE,'failed.png'),(await win.webContents.capturePage()).toPNG());app.exit(1)}});
`
