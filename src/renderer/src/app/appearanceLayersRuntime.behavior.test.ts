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

const require = createRequire(import.meta.url)
const { build: buildNode } = createRequire(require.resolve('vite/package.json'))('esbuild')
test('component PNG skins paint behind native foreground and map UV overflow without changing interaction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-control-layers-'))
  try {
    await writeFile(
      join(directory, 'entry.ts'),
      (await readFile(resolve('scripts/fixtures/appearance-layers.mjs'), 'utf8')).replaceAll(
        '__RENDERER__',
        resolve('src/renderer/src').replaceAll('\\', '/')
      )
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [vue()],
      resolve: { alias: { vue: require.resolve('vue/dist/vue.esm-bundler.js') } },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'LayerProbe',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    // Import the production helper without initializing the unrelated music library/settings.
    await buildNode({
      stdin: {
        contents: `export { importBackgroundImageBuffer, resolveBackgroundImageFile } from ${JSON.stringify(resolve('src/main/library/coverCache.ts'))}`,
        resolveDir: process.cwd()
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      outfile: join(directory, 'image-import.cjs'),
      plugins: [
        {
          name: 'unused-cover-cache-isolation',
          setup(builder: {
            onResolve: (
              options: { filter: RegExp },
              callback: () => { path: string; namespace: string }
            ) => void
            onLoad: (
              options: { filter: RegExp; namespace: string },
              callback: () => { contents: string; loader: string }
            ) => void
          }) {
            builder.onResolve({ filter: /[\\/]cache[\\/]ncmCache\.ts$/ }, () => ({
              path: 'unused-cover-cache',
              namespace: 'isolated'
            }))
            builder.onLoad({ filter: /.*/, namespace: 'isolated' }, () => ({
              contents:
                "export function getMusicCacheRoot() { throw Error('The PNG import must not access a music cache or personal settings') }",
              loader: 'js'
            }))
          }
        }
      ]
    })
    const PNG = require('pngjs').PNG
    const source = new PNG({ width: 120, height: 60 })
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const offset = (y * source.width + x) * 4
        source.data.set([240, 32, 96, x < 40 ? 0 : x < 80 ? 128 : 255], offset)
      }
    }
    await writeFile(join(directory, 'transparent-source.png'), PNG.sync.write(source))
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="full"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}
      <style>body{margin:0;background:#101218;color:#eef1f4;font:14px sans-serif}.app-shell{position:absolute;left:24px;top:24px;width:380px;height:320px;background:#20242a}.app-shell-content{position:absolute;inset:16px;background:#27333a;border-radius:8px}.clip{position:absolute;left:32px;top:48px;width:100px;height:60px;overflow:hidden;background:#204030}.clip button{position:relative;display:block;width:100px;height:60px;color:#eef1f4;background:#203040;border:0;border-radius:0;font:inherit;transition:transform .25s linear}.shift .clip{left:80px}.clip button.move{transform:translateX(-20px)}#editor{position:absolute;top:24px;left:450px;width:300px;padding:16px;background:#202226;box-sizing:border-box}#extra{position:absolute;top:380px;left:20px;display:grid;grid-template-columns:repeat(20,26px);gap:2px}#extra button{width:26px;height:24px;padding:0}.outside-bounds{position:absolute;right:-50px;width:20px;height:20px}</style></head><body><div class="app-shell"><div class="app-shell-content"><div class="clip"><button id="target" data-te-appearance-body="prior">Native control</button><button class="outside-bounds">Clipped</button></div><a href="#native" style="position:absolute;top:140px;left:32px">Native link</a><div role="slider" tabindex="0" style="position:absolute;top:190px;left:32px;width:100px;height:30px">Native slider</div></div></div><div id="editor" data-te-appearance-ignore></div><div id="extra"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 45_000 }
    )
    assert.match(result.stdout, /CONTROL_LAYERS_OK/)
    const sample = JSON.parse(result.stdout.match(/CONTROL_LAYERS_SAMPLE (.*)/)![1])
    const png = PNG.sync.read(await readFile(join(directory, 'alpha-outside.png')))
    const x = Math.round((sample.x * png.width) / sample.width)
    const y = Math.round((sample.y * png.height) / sample.height)
    const pixel = [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)]
    assert.deepEqual(
      pixel,
      [255, 0, 136, 255],
      'the alpha effect must be visible beyond its clipping ancestor'
    )
    const evidence = JSON.parse(result.stdout.match(/PNG_LAYERS_RESULT (.*)/)![1])
    assert.match(evidence.handle, /^background:\/\/[a-f0-9]{24}\.png$/)
    assert.equal(evidence.originalBytesPreserved, true)
    assert.equal(evidence.networkRequests, 0)
    assert.deepEqual(evidence.outside.sourceAlpha, [0, 128, 255])
    assert.equal(
      evidence.interaction.clicks,
      2,
      'pointer and Space must activate the native button'
    )
    assert.equal(evidence.interaction.tabToLink, true, 'decoration must not enter the Tab order')
    const home = JSON.parse(result.stdout.match(/HOME_CARD_RESULT (.*)/)![1])
    assert.equal(home.outside.matchingCards, 3)
    assert.equal(home.outside.overflowPlanes, 3)
    assert.deepEqual(home.preview.nativeMarkers, ['card', 'card', 'card'])
    assert.deepEqual(home.preview.cloneMarkers, home.preview.nativeMarkers)
    assert.equal(home.preview.reboundPlanes, 3)
    assert.equal(home.cleanup.removedTargetCleaned, true)
    for (const interaction of home.interactions) {
      assert.equal(interaction.clicks, 2)
      assert.equal(interaction.tabToNext, true)
    }
    let homePixelProbes = 0
    for (const phase of ['outside', 'inside', 'preview']) {
      const image = PNG.sync.read(await readFile(join(directory, `home-card-${phase}.png`)))
      const state = home[phase]
      for (const point of state.samples) {
        const px = Math.floor((point.x * image.width) / state.width)
        const py = Math.floor((point.y * image.height) / state.height)
        const actual = [
          ...image.data.subarray((py * image.width + px) * 4, (py * image.width + px) * 4 + 4)
        ]
        point.actual = actual
        homePixelProbes++
        for (let channel = 0; channel < 4; channel++)
          assert.ok(
            Math.abs(actual[channel] - point.expected[channel]) <= 2,
            `home ${phase}/${point.name} expected ${point.expected}, received ${actual}`
          )
      }
    }
    const homeBefore = PNG.sync.read(await readFile(join(directory, 'home-card-before.png')))
    const homeOutside = PNG.sync.read(await readFile(join(directory, 'home-card-outside.png')))
    home.foreground = home.before.cards.map((card, index) => {
      const after = home.outside.cards[index]
      assert.equal(after.id, card.id)
      assert.equal(after.color, card.color)
      assert.deepEqual(after.textBounds, card.textBounds)
      const sx = homeBefore.width / home.before.width,
        sy = homeBefore.height / home.before.height
      let whiteGlyphPixels = 0,
        opaqueBackgroundGlyphPixels = 0
      for (
        let y = Math.ceil(card.textBounds.top * sy);
        y < Math.floor(card.textBounds.bottom * sy);
        y++
      )
        for (
          let x = Math.ceil(card.textBounds.left * sx);
          x < Math.floor(card.textBounds.right * sx);
          x++
        ) {
          const pixel = (y * homeBefore.width + x) * 4
          if (Math.min(...homeBefore.data.subarray(pixel, pixel + 3)) < 225) continue
          whiteGlyphPixels++
          if (x / sx > card.bounds.left + 140) opaqueBackgroundGlyphPixels++
          for (let channel = 0; channel < 3; channel++)
            assert.ok(
              homeOutside.data[pixel + channel] >= 210 &&
                Math.abs(homeOutside.data[pixel + channel] - homeBefore.data[pixel + channel]) <=
                  32,
              `Home ${card.id} PNG covers its native foreground text`
            )
        }
      assert.ok(
        whiteGlyphPixels >= 10 && opaqueBackgroundGlyphPixels >= 5,
        `Home ${card.id} needs actual readable glyphs over the source's A255 region`
      )
      return { id: card.id, whiteGlyphPixels, opaqueBackgroundGlyphPixels, preserved: true }
    })
    home.pixelProbes = homePixelProbes
    home.networkRequests = evidence.networkRequests
    home.handle = evidence.handle
    const homeReportDirectory = process.env.TWILIGHT_HOME_CARD_REPORT_DIR
    if (homeReportDirectory) {
      await mkdir(homeReportDirectory, { recursive: true })
      for (const phase of ['before', 'outside', 'inside', 'preview'])
        await writeFile(
          join(homeReportDirectory, `home-card-${phase}.png`),
          await readFile(join(directory, `home-card-${phase}.png`))
        )
      await writeFile(
        join(homeReportDirectory, 'home-card-metrics.json'),
        JSON.stringify(home, null, 2) + '\n'
      )
    }
    const combined = JSON.parse(result.stdout.match(/HOME_CARD_COMBINED_RESULT (.*)/)![1])
    const combinedFailures: string[] = []
    let combinedPixelProbes = 0
    const combinedImages = new Map<string, ReturnType<typeof PNG.sync.read>>()
    for (const state of combined.states) {
      const image = PNG.sync.read(await readFile(join(directory, `${state.id}.png`)))
      combinedImages.set(state.id, image)
      const hasSkin = state.mode === 'skin' || state.mode === 'body-skin'
      const hasBody = state.mode === 'body' || state.mode === 'body-skin'
      if (state.overflowPlanes !== (hasSkin ? 3 : 0))
        combinedFailures.push(`${state.id}: duplicate or stale overflow`)
      for (const card of state.cards) {
        if (card.bodyScope !== (hasSkin || hasBody ? 'card' : null))
          combinedFailures.push(`${state.id}/${card.id}: native body scope not restored`)
        if (card.skinScope !== (hasSkin ? 'card' : null))
          combinedFailures.push(`${state.id}/${card.id}: native skin scope not restored`)
        if (
          hasSkin &&
          (!card.backgroundImage.includes(evidence.handle) ||
            JSON.stringify(card.uv) !== '[-60,-30,300,150]' ||
            card.backgroundSize !== '300px 150px' ||
            card.backgroundPosition !== '-60px -30px')
        )
          combinedFailures.push(
            `${state.id}/${card.id}: computed PNG/UV lost (${card.backgroundImage}, ${card.backgroundPosition}, ${card.backgroundSize})`
          )
        if (!hasSkin && card.backgroundImage !== 'none')
          combinedFailures.push(`${state.id}/${card.id}: cleared skin retains an image`)
      }
      for (const point of state.samples) {
        const px = Math.floor((point.x * image.width) / state.width)
        const py = Math.floor((point.y * image.height) / state.height)
        const actual = [
          ...image.data.subarray((py * image.width + px) * 4, (py * image.width + px) * 4 + 4)
        ]
        point.actual = actual
        combinedPixelProbes++
        if (actual.some((channel, index) => Math.abs(channel - point.expected[index]) > 2))
          combinedFailures.push(
            `${state.id}/${point.name}: expected ${point.expected}, received ${actual}`
          )
      }
    }
    combined.foreground = []
    for (const state of combined.states.filter(
      (state) => state.mode === 'skin' || state.mode === 'body-skin'
    )) {
      const baseline = combined.states.find(
        (candidate) =>
          candidate.custom === state.custom &&
          candidate.material === state.material &&
          candidate.mode === 'clear-before'
      )
      const before = combinedImages.get(baseline.id)!,
        after = combinedImages.get(state.id)!
      for (const [index, card] of state.cards.entries()) {
        const original = baseline.cards[index]
        if (
          card.color !== original.color ||
          JSON.stringify(card.textBounds) !== JSON.stringify(original.textBounds)
        )
          combinedFailures.push(
            `${state.id}/${card.id}: skin changes native foreground color/geometry`
          )
        const sx = before.width / state.width,
          sy = before.height / state.height
        let glyphPixels = 0
        for (
          let y = Math.ceil(original.textBounds.top * sy);
          y < Math.floor(original.textBounds.bottom * sy);
          y++
        )
          for (
            let x = Math.ceil(original.textBounds.left * sx);
            x < Math.floor(original.textBounds.right * sx);
            x++
          ) {
            const pixel = (y * before.width + x) * 4
            if (
              Math.min(...before.data.subarray(pixel, pixel + 3)) < 225 ||
              x / sx <= original.bounds.left + 140
            )
              continue
            glyphPixels++
            if (
              [0, 1, 2].some(
                (channel) =>
                  after.data[pixel + channel] < 210 ||
                  Math.abs(after.data[pixel + channel] - before.data[pixel + channel]) > 32
              )
            )
              combinedFailures.push(`${state.id}/${card.id}: opaque skin covers native text`)
          }
        if (glyphPixels < 5)
          combinedFailures.push(`${state.id}/${card.id}: insufficient opaque-area foreground proof`)
        combined.foreground.push({ state: state.id, card: card.id, glyphPixels })
      }
    }
    combined.pixelProbes = combinedPixelProbes
    combined.networkRequests = evidence.networkRequests
    combined.failures = combinedFailures
    const combinedReportDirectory = process.env.TWILIGHT_HOME_CARD_COMBINED_REPORT_DIR
    if (combinedReportDirectory) {
      await mkdir(combinedReportDirectory, { recursive: true })
      const prefix =
        process.env.TWILIGHT_HOME_CARD_COMBINED_REPORT_LABEL === 'red'
          ? 'home-card-combined-red'
          : 'home-card-combined'
      for (const state of combined.states)
        await writeFile(
          join(combinedReportDirectory, `${prefix}-${state.id}.png`),
          await readFile(join(directory, `${state.id}.png`))
        )
      await writeFile(
        join(combinedReportDirectory, `${prefix}-metrics.json`),
        JSON.stringify(combined, null, 2) + '\n'
      )
    }
    assert.equal(combined.states.length, 20)
    assert.equal(combined.cleanup.originalCustomAttributesRestored, true)
    assert.deepEqual(
      combinedFailures,
      [],
      'Explicit component body/skin must survive real card material CSS and restore it after clear'
    )
    const reportDirectory = process.env.TWILIGHT_PANEL_SKIN_REPORT_DIR
    if (reportDirectory) {
      await mkdir(reportDirectory, { recursive: true })
      for (const phase of ['before', 'outside', 'inside', 'opacity', 'body', 'window'])
        await writeFile(
          join(reportDirectory, `panel-skin-${phase}.png`),
          await readFile(join(directory, `png-${phase}.png`))
        )
    }
    let pixelProbes = 0
    for (const phase of ['outside', 'inside', 'opacity', 'body', 'window']) {
      const image = PNG.sync.read(await readFile(join(directory, `png-${phase}.png`)))
      const state = evidence[phase]
      for (const point of state.samples) {
        const px = Math.floor((point.x * image.width) / state.width)
        const py = Math.floor((point.y * image.height) / state.height)
        const actual = [
          ...image.data.subarray((py * image.width + px) * 4, (py * image.width + px) * 4 + 4)
        ]
        point.actual = actual
        pixelProbes++
        for (let channel = 0; channel < 4; channel++)
          assert.ok(
            Math.abs(actual[channel] - point.expected[channel]) <= 2,
            `${phase}/${point.name} expected ${point.expected}, received ${actual}`
          )
      }
    }
    const before = PNG.sync.read(await readFile(join(directory, 'png-before.png')))
    const outside = PNG.sync.read(await readFile(join(directory, 'png-outside.png')))
    const bounds = evidence.before.textBounds
    const scaleX = before.width / evidence.before.width
    const scaleY = before.height / evidence.before.height
    let whiteGlyphPixels = 0
    let opaqueBackgroundGlyphPixels = 0
    for (let py = Math.ceil(bounds.top * scaleY); py < Math.floor(bounds.bottom * scaleY); py++) {
      for (let px = Math.ceil(bounds.left * scaleX); px < Math.floor(bounds.right * scaleX); px++) {
        const index = (py * before.width + px) * 4
        // Windows LCD antialiasing depends on the pixels behind a glyph. Its
        // bright stroke cores must stay bright even over the source's A255 area.
        if (Math.min(...before.data.subarray(index, index + 3)) < 225) continue
        whiteGlyphPixels++
        if (px / scaleX > evidence.before.panel.left + 160) opaqueBackgroundGlyphPixels++
        for (let channel = 0; channel < 3; channel++)
          assert.ok(
            outside.data[index + channel] >= 210 &&
              Math.abs(outside.data[index + channel] - before.data[index + channel]) <= 32,
            'The opaque PNG must remain behind every native foreground glyph'
          )
      }
    }
    if (reportDirectory)
      await writeFile(
        join(reportDirectory, 'panel-skin-runtime-metrics.json'),
        JSON.stringify(
          {
            ...evidence,
            pixelProbes,
            foreground: { whiteGlyphPixels, opaqueBackgroundGlyphPixels }
          },
          null,
          2
        ) + '\n'
      )
    assert.ok(whiteGlyphPixels >= 40, 'The real native foreground must contribute readable glyphs')
    assert.ok(
      opaqueBackgroundGlyphPixels >= 10,
      'Foreground proof must include text over the fully opaque source region'
    )
    assert.equal(evidence.before.color, evidence.outside.color)
    assert.deepEqual(evidence.before.textBounds, evidence.outside.textBounds)
    evidence.foreground = { whiteGlyphPixels, opaqueBackgroundGlyphPixels, preserved: true }
    evidence.pixelProbes = pixelProbes
    if (reportDirectory) {
      await writeFile(
        join(reportDirectory, 'panel-skin-runtime-metrics.json'),
        JSON.stringify(evidence, null, 2) + '\n'
      )
    }
    console.log(`PNG_LAYERS_RESULT ${JSON.stringify(evidence)}`)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-control-layers-'))
    await rm(directory, { recursive: true, force: true })
  }
})
const runner = `
const {app,BrowserWindow,protocol,session}=require('electron'),path=require('node:path'),fs=require('node:fs/promises'),assert=require('node:assert/strict');
protocol.registerSchemesAsPrivileged([{scheme:'background',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:820,height:650,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});let phase='import';try{
const {importBackgroundImageBuffer,resolveBackgroundImageFile}=require('./image-import.cjs');
const source=await fs.readFile(path.join(__dirname,'transparent-source.png'));
const handle=importBackgroundImageBuffer('transparent-source.png',source);
assert.equal(importBackgroundImageBuffer('same-transparent-image.png',source),handle,'import must remain content addressed');
assert.deepEqual(await fs.readFile(resolveBackgroundImageFile(handle.slice('background://'.length))),source,'production import must preserve PNG bytes');
let networkRequests=0;
session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{networkRequests++;callback({cancel:true})});
protocol.handle('background',async request=>{const url=new URL(request.url),file=resolveBackgroundImageFile((url.hostname+url.pathname).replace(/^\\/+/,''));return file?new Response(await fs.readFile(file),{headers:{'Content-Type':'image/png','Access-Control-Allow-Origin':'*'}}):new Response('',{status:404})});
await win.loadFile(path.join(__dirname,'index.html'));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
const sample=await win.webContents.executeJavaScript('window.prepareLayers()');await fs.writeFile(path.join(__dirname,'alpha-outside.png'),(await win.webContents.capturePage()).toPNG());console.log('CONTROL_LAYERS_SAMPLE '+JSON.stringify(sample));
phase='PNG outside';
const before=await win.webContents.executeJavaScript('window.prepareImageLayers('+JSON.stringify(handle)+')');
await fs.writeFile(path.join(__dirname,'png-before.png'),(await win.webContents.capturePage()).toPNG());
const outside=await win.webContents.executeJavaScript('window.enableImageLayers()');
await fs.writeFile(path.join(__dirname,'png-outside.png'),(await win.webContents.capturePage()).toPNG());
const point=await win.webContents.executeJavaScript('window.startImageInteraction()');
phase='native interaction';
for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Space'});
for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Tab'});
await new Promise(resolve=>setTimeout(resolve,80));
const interaction=await win.webContents.executeJavaScript('window.checkImageInteraction()');
phase='PNG inside';
const inside=await win.webContents.executeJavaScript('window.setImagePresentation("inside",100)');
await fs.writeFile(path.join(__dirname,'png-inside.png'),(await win.webContents.capturePage()).toPNG());
phase='PNG opacity';
const opacity=await win.webContents.executeJavaScript('window.setImagePresentation("outside",50)');
await fs.writeFile(path.join(__dirname,'png-opacity.png'),(await win.webContents.capturePage()).toPNG());
phase='PNG body color independence';
const body=await win.webContents.executeJavaScript('window.setImageBodyLayer()');
await fs.writeFile(path.join(__dirname,'png-body.png'),(await win.webContents.capturePage()).toPNG());
phase='PNG geometry and cleanup';
const geometry=await win.webContents.executeJavaScript('window.checkImageGeometry()');
await win.webContents.executeJavaScript('window.finishImageLayers()');
phase='continuous outer skin and title controls';
const windowSkin=await win.webContents.executeJavaScript('window.prepareWholeWindowSkin()');
await fs.writeFile(path.join(__dirname,'png-window.png'),(await win.webContents.capturePage()).toPNG());
await win.webContents.executeJavaScript('window.finishWholeWindowSkin()');
phase='home card backgrounds';
const homeBefore=await win.webContents.executeJavaScript('window.prepareHomeCardSkins()');
await fs.writeFile(path.join(__dirname,'home-card-before.png'),(await win.webContents.capturePage()).toPNG());
const homeOutside=await win.webContents.executeJavaScript('window.enableHomeCardSkins()');
await fs.writeFile(path.join(__dirname,'home-card-outside.png'),(await win.webContents.capturePage()).toPNG());
const homeInteractions=[];
for(let index=0;index<3;index++){
 const point=await win.webContents.executeJavaScript('window.startHomeCardInteraction('+index+')');
 for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,x:Math.round(point.x),y:Math.round(point.y),button:'left',clickCount:1});
 for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Space'});
 for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Tab'});
 await new Promise(resolve=>setTimeout(resolve,60));
 homeInteractions.push(await win.webContents.executeJavaScript('window.checkHomeCardInteraction('+index+')'));
}
const homeInside=await win.webContents.executeJavaScript('window.setHomeCardInside()');
await fs.writeFile(path.join(__dirname,'home-card-inside.png'),(await win.webContents.capturePage()).toPNG());
const homePreview=await win.webContents.executeJavaScript('window.checkHomeCardPreview()');
await fs.writeFile(path.join(__dirname,'home-card-preview.png'),(await win.webContents.capturePage()).toPNG());
const homeCleanup=await win.webContents.executeJavaScript('window.finishHomeCardSkins()');
console.log('HOME_CARD_RESULT '+JSON.stringify({before:homeBefore,outside:homeOutside,inside:homeInside,preview:homePreview,interactions:homeInteractions,cleanup:homeCleanup}));
phase='combined card material and skin';
win.webContents.sendInputEvent({type:'mouseMove',x:0,y:0});
await win.webContents.executeJavaScript('window.prepareHomeCardCombination()');
const combinedStates=[];
for(const custom of [false,true])for(const material of ['standard','transparent'])for(const mode of ['clear-before','body','skin','body-skin','clear-after']){
 const state=await win.webContents.executeJavaScript('window.setHomeCardCombination('+JSON.stringify({custom,material,mode})+')');
 state.id=(custom?'custom-on':'custom-off')+'-'+material+'-'+mode;
 await fs.writeFile(path.join(__dirname,state.id+'.png'),(await win.webContents.capturePage()).toPNG());
 combinedStates.push(state);
}
const combinedCleanup=await win.webContents.executeJavaScript('window.finishHomeCardCombination()');
console.log('HOME_CARD_COMBINED_RESULT '+JSON.stringify({states:combinedStates,cleanup:combinedCleanup}));
console.log('PNG_LAYERS_RESULT '+JSON.stringify({handle,originalBytesPreserved:true,networkRequests,before,outside,inside,opacity,body,window:windowSkin,interaction,geometry}));
phase='color regression';
await win.webContents.executeJavaScript('window.checkLayers()');console.log('CONTROL_LAYERS_OK');win.destroy();app.exit(0)
}catch(error){console.error('CONTROL_LAYERS_FAILURE '+JSON.stringify({phase,message:error?.message??String(error),stack:error?.stack}));win.destroy();app.exit(1)}});
`
