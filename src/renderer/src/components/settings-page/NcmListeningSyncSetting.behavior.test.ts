import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readdir, rm, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
test('listening sync settings render saved state, upload errors and submission receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-ncm-listening-ui-'))
  const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))
  const fixture = fileURLToPath(new URL('./ncmListeningSync.fixture.mjs', import.meta.url))
  try {
    await build({
      configFile: false,
      root: workspace,
      logLevel: 'error',
      plugins: [
        {
          name: 'listening-ui-boundary',
          enforce: 'pre',
          resolveId(source) {
            const name = source.match(/\/(useSettingsStore|coreConnection)\.ts$/)?.[1]
            return name ? '\0listening:' + name : null
          },
          load(id) {
            if (!id.startsWith('\0listening:')) return null
            return `export { ${id.endsWith('coreConnection') ? 'useCoreConnection' : 'useSettingsStore'} } from ${JSON.stringify(fixture)}`
          }
        },
        vue()
      ],
      resolve: { alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') } },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: { entry: fixture, name: 'ListeningSyncUi', formats: ['iife'], fileName: 'runtime' }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">
      ${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join('')}
      <style>body{margin:0;font:14px system-ui;background:#f5f6f8;color:#20242b}*{box-sizing:border-box}
      .settings-preview-page{min-height:100vh;--te-settings-text:#20242b;--te-font-sans:system-ui;--te-settings-muted:#656b75;--te-accent:#6959d5}
      .preview-section{max-width:850px;margin:auto;background:white;border-radius:20px;padding:28px}
      .preview-section>h2{margin:0 0 22px;font-size:24px}</style></head><body><div id="app"></div>
      <script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    const evidence = process.env.TWILIGHT_NCM_LISTENING_EVIDENCE_DIR
    if (evidence) await mkdir(evidence, { recursive: true })
    await writeFile(
      join(directory, 'runner.cjs'),
      `
      const { app, BrowserWindow } = require('electron'); const fs = require('node:fs'); const path = require('node:path');
      app.setPath('userData', path.join(__dirname, 'profile')); app.commandLine.appendSwitch('force-device-scale-factor', '1');
      app.whenReady().then(async () => { const win = new BrowserWindow({ show: false, width: 900, height: 380, useContentSize: true,
        webPreferences: { offscreen: true, backgroundThrottling: false } });
        try { await win.loadFile(path.join(__dirname, 'index.html'));
          console.log(await win.webContents.executeJavaScript('window.runListeningSyncUi()'));
          for (const width of [900, 440]) { win.setContentSize(width, 420); await new Promise(r => setTimeout(r, 250));
            await win.webContents.executeJavaScript('window.checkListeningSyncLayout().then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
            if (${JSON.stringify(evidence || '')}) fs.writeFileSync(path.join(${JSON.stringify(evidence || '')}, width+'.png'), (await win.webContents.capturePage()).toPNG()); }
          app.exit(0);
        } catch (error) { console.error(error.stack); app.exit(1); }
      });`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      {
        windowsHide: true,
        timeout: 30000,
        env
      }
    )
    assert.match(result.stdout, /NCM_LISTENING_UI_OK/)
  } finally {
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
        directory.includes('twilight-ncm-listening-ui-')
    )
    await rm(directory, { recursive: true, force: true })
  }
})
