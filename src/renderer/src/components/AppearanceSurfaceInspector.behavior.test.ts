import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { compileStyle, parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)

test('appearance inspector keeps part materials independent and usable with keyboard and small windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-inspector-'))
  const artifactDirectory = process.env.TWILIGHT_INSPECTOR_ARTIFACT_DIR
    ? resolve(process.env.TWILIGHT_INSPECTOR_ARTIFACT_DIR)
    : undefined
  try {
    if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true })
    const pagePath = resolve('src/renderer/src/components/AppearancePage.vue')
    const { descriptor } = parse(await readFile(pagePath, 'utf8'), { filename: pagePath })
    const pageStyle = compileStyle({
      source: descriptor.styles.find((style) => style.scoped)!.content,
      filename: pagePath,
      id: 'data-v-property-probe',
      scoped: true
    })
    assert.deepEqual(pageStyle.errors, [])
    await writeFile(join(directory, 'page-properties.css'), pageStyle.code)
    await writeFile(
      join(directory, 'entry.ts'),
      await readFile(resolve('scripts/fixtures/component-material-inspector.mjs'), 'utf8')
    )
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [vue()],
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          'primeicons/primeicons.css': require.resolve('primeicons/primeicons.css')
        }
      },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'InspectorTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<link rel="stylesheet" href="page-properties.css"><style>
      body{margin:0;background:var(--te-settings-backplate)}
      .fixture{width:264px;height:540px;margin:24px;padding:12px;box-sizing:border-box;background:var(--editor-bg)}
      #inspector-mount{height:100%}
      .fixture:not(.horizontal-fixture) .appearance-inspector{max-height:min(460px,100%)}
      .horizontal-fixture{padding:0;height:220px!important;overflow:hidden;background:transparent}
      .horizontal-fixture #inspector-mount{height:auto}
      .appearance-selection-probe{position:fixed;top:160px;left:320px}
      .popup-probe{position:fixed;top:80px;left:320px;width:200px}
      .settings-preview-nav.material-scope-probe{position:fixed;top:20px;left:320px;transform:none}
      .advanced-property-probe{position:fixed;top:230px;left:300px;width:324px;height:340px}

      </style></head><body><section class="fixture appearance-editor appearance-editor--embedded appearance-editor--character"><div id="inspector-mount"></div><nav class="appearance-part-tools appearance-selection-probe"><button data-part="background" aria-pressed="false">背景</button><button data-part="navigation" aria-pressed="true">侧边栏</button></nav></section><section class="appearance-editor popup-probe"><button aria-pressed="true">普通设置窗口</button></section><nav class="settings-preview-nav material-scope-probe">设置导航</nav><section class="appearance-editor--character advanced-property-probe"><div class="appearance-character-advanced"><div class="appearance-editor-controls"><nav class="appearance-section-links"><button>背景</button></nav><p>详细属性</p></div></div></section><script src="bundle/${files.find(
        (file) => file.endsWith('.js')
      )}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /INSPECTOR_OK/)
    console.info(result.stdout.match(/MATERIAL_CASES (.*)/)?.[0])
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-inspector-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1024,height:700,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 try{
  await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  console.log('MATERIAL_CASES',JSON.stringify(await win.webContents.executeJavaScript('window.runMaterialTests()')));
  const frames={};for(const mode of ['theme','solid','frosted','liquidGlass']){const rect=await win.webContents.executeJavaScript('window.prepareMaterialPixels('+JSON.stringify(mode)+')');frames[mode]=(await win.webContents.capturePage(rect)).toBitmap()}
  for(const mode of ['solid','frosted','liquidGlass']){let changed=0;for(let i=0;i<frames.theme.length;i+=4)if(Math.abs(frames[mode][i]-frames.theme[i])+Math.abs(frames[mode][i+1]-frames.theme[i+1])+Math.abs(frames[mode][i+2]-frames.theme[i+2])>8)changed++;if(changed<200)throw new Error(mode+' has no actual pixel effect: '+changed)}
  for(const [width,height] of [[1280,720],[760,480],[521,400]]){win.setContentSize(width,height);await win.webContents.executeJavaScript('window.verifyLayout()')}
  await win.webContents.executeJavaScript('window.prepareKeyboard()');
  for(const [key,code,text] of [['Enter',13,'\\r'],['Escape',27,undefined]]){await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode:code,...(text?{text}:{})});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode:code});await win.webContents.executeJavaScript(key==='Enter'?'window.verifyKeyboardOpen()':'window.verifyKeyboardClosed()')}
  for(const feature of ['prefers-reduced-transparency','prefers-contrast','forced-colors']){await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:feature,value:feature==='forced-colors'?'active':feature==='prefers-contrast'?'more':'reduce'}]});await win.webContents.executeJavaScript('window.verifyFallback('+JSON.stringify(feature)+')')}
  win.webContents.debugger.detach();console.log('INSPECTOR_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});
`
