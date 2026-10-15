// Real main/preload/renderer proof with an isolated profile. Run after the build:
// node node_modules/electron/cli.js scripts/dsp-editor-window-smoke.cjs
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const root = path.resolve(__dirname, '..')
const buildRoot = path.resolve(process.env.TWILIGHT_DSP_BUILD_DIR || path.join(root, 'out'))
const preview = process.argv.includes('--preview')
const output = path.join(root, '.artifacts', 'dsp-editor-window')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-dsp-window-'))
fs.mkdirSync(output, { recursive: true })
fs.writeFileSync(
  path.join(profile, 'settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    theme: 'pureWhite',
    closeWindowBehavior: 'quit',
    libraryFolders: [],
    startupHomePage: 'local',
    motionPreference: 'reduced'
  })
)
app.setPath('userData', profile)
app.setAppPath(root)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const poll = async (read, label) => {
  for (let i = 0; i < 150; i++) {
    const value = await read()
    if (value) return value
    await sleep(100)
  }
  throw new Error(label)
}
const report = { passed: false, checks: [], profile, errors: [] }
app.on('browser-window-created', (_event, win) => {
  win.webContents.setBackgroundThrottling(false)
  win.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') report.errors.push(details.message)
  })
})
const timeout = setTimeout(() => {
  console.error('DSP_WINDOW_TIMEOUT')
  app.exit(1)
}, 100000)
async function run() {
  require(path.join(buildRoot, 'main', 'index.js'))
  const main = await poll(
    () =>
      BrowserWindow.getAllWindows().find(
        (win) =>
          /renderer\/index.html/.test(win.webContents.getURL()) && !win.webContents.isLoading()
      ),
    'Main renderer did not load'
  )
  const evaluate = async (code) => {
    const result = await main.webContents.executeJavaScript(
      `(async()=>{try{return {ok:true,value:await (${code})}}catch(error){return {ok:false,error:error.stack}}})()`,
      true
    )
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  const screenshot = async (win, name) => {
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
    await sleep(1000)
    // Capture the complete view rather than a partially damaged compositor
    // surface when its opener is minimized.
    win.webContents.debugger.attach('1.3')
    try {
      const capture = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: false
      })
      fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(capture.data, 'base64'))
    } finally {
      win.webContents.debugger.detach()
    }
  }
  await poll(() => evaluate(`!!document.querySelector('.title-bar .dsp-btn')`), 'DSP entry missing')
  await evaluate(`document.querySelector('.title-bar .dsp-btn').click()`)
  await poll(
    () =>
      evaluate(
        `!!document.querySelector('.eq-page .invisible-range') && !document.querySelector('.eq-container').inert`
      ),
    'EQ did not load'
  )
  if (preview) {
    await evaluate(`document.querySelector('.audio-window-button').click()`)
    const editor = await poll(
      () =>
        BrowserWindow.getAllWindows().find(
          (win) => win !== main && win.webContents.getURL() === 'about:blank'
        ),
      'DSP preview missing'
    )
    editor.show()
    editor.focus()
    clearTimeout(timeout)
    console.log('DSP_PREVIEW_READY')
    return
  }
  const engineBefore = await evaluate(
    `JSON.stringify(await window.api.audioEngine.getDspSceneState())`
  )
  await screenshot(main, 'main-equalizer-light')
  await evaluate(`document.querySelector('#audio-workspace-tab-effects').click()`)
  await poll(
    () =>
      evaluate(
        `!!document.querySelector('.scene-toolbar input') && document.querySelector('.dsp-rack-page').getAttribute('aria-busy')==='false'`
      ),
    'Effects did not load'
  )
  await screenshot(main, 'main-effects-light')
  await evaluate(
    `(()=>{const el=document.querySelector('.scene-toolbar input');el.value='窗口草稿验证';el.dispatchEvent(new Event('input',{bubbles:true}))})()`
  )
  const stateBefore = await evaluate(`document.querySelector('.scene-toolbar input').value`)
  await evaluate(
    `(()=>{const open=window.open.bind(window);window.open=(...args)=>{const result=open(...args);if(args[1]==='twilight-dsp-editor')window.__dspSmokeWindow=result;return result};return true})()`
  )
  await evaluate(`document.querySelector('.audio-window-button').click()`)
  const child = await poll(
    () =>
      BrowserWindow.getAllWindows().find(
        (win) => win !== main && win.webContents.getURL() === 'about:blank'
      ),
    'Native DSP window missing'
  )
  const childRead = (expression) =>
    evaluate(`(()=>{const w=window.__dspSmokeWindow;return (${expression})})()`)
  await poll(
    () => childRead(`w.document.querySelector('.scene-toolbar input')?.value==='窗口草稿验证'`),
    'Draft did not move to child'
  )
  assert.equal(
    await evaluate(`JSON.stringify(await window.api.audioEngine.getDspSceneState())`),
    engineBefore
  )
  assert.equal(await childRead(`w.document.querySelector('.rack-audition').open`), false)
  report.checks.push('Native window carries the same unsaved draft without engine writes')
  await screenshot(child, 'effects-window-light')
  const geometry = []
  for (const [width, height] of [
    [1120, 800],
    [900, 640],
    [620, 520]
  ]) {
    child.setSize(width, height)
    await sleep(150)
    const measurement = await childRead(
      `(()=>{const doc=w.document, page=doc.querySelector('.audio-workspace'), rack=doc.querySelector('.dsp-rack-page');const r=page.getBoundingClientRect();return {width:w.innerWidth,height:w.innerHeight,pageHeight:r.height,overflow:doc.documentElement.scrollWidth>w.innerWidth,rackOverflow:rack.scrollWidth>rack.clientWidth+1}})()`
    )
    console.log('GEOMETRY', JSON.stringify(measurement))
    await screenshot(child, `effects-window-${width}x${height}`)
    if (measurement.rackOverflow)
      console.log(
        'OVERFLOW',
        JSON.stringify(
          await childRead(
            `(()=>{const rack=w.document.querySelector('.dsp-rack-page'),bounds=rack.getBoundingClientRect();return {client:rack.clientWidth,scroll:rack.scrollWidth,bounds:bounds.width,children:[...rack.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().right>bounds.left+rack.clientWidth+1).slice(0,10).map(el=>({tag:el.tagName,cls:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right,rootRight:bounds.left+rack.clientWidth}))}})()`
          )
        )
      )
    assert.equal(measurement.overflow, false)
    assert.equal(measurement.rackOverflow, false)
    assert.ok(measurement.pageHeight <= measurement.height + 1)
    geometry.push(measurement)
    await screenshot(child, `effects-window-${width}x${height}`)
  }
  report.geometry = geometry
  report.checks.push('Effects layout fits desktop, short, and narrow native windows')
  await evaluate(`document.querySelector('.title-bar .settings-btn[aria-label="设置"]').click()`)
  await poll(
    () => evaluate(`!document.querySelector('.audio-window-placeholder')`),
    'Main window did not navigate independently'
  )
  assert.equal(
    await childRead(
      `w.document.querySelector('#audio-workspace-tab-effects').getAttribute('aria-selected')`
    ),
    'true'
  )
  assert.equal(
    await childRead(`w.document.querySelector('.scene-toolbar input').value`),
    stateBefore
  )
  report.checks.push('Browsing the main window retains the effects tab and unsaved edits')
  await evaluate(`window.api.settings.update({theme:'dark'})`)
  await poll(
    () =>
      childRead(
        `w.document.documentElement.getAttribute('data-theme')===document.documentElement.getAttribute('data-theme') && w.document.documentElement.className===document.documentElement.className+' dsp-editor-document'`
      ),
    'Theme attributes did not synchronize'
  )
  child.setSize(1120, 800)
  await screenshot(child, 'effects-window-dark')
  report.checks.push('Theme and lazy styles synchronize to the detached document')
  main.minimize()
  child.close()
  await poll(
    () =>
      evaluate(
        `document.querySelector('.scene-toolbar input')?.value==='窗口草稿验证' && !document.querySelector('.audio-window-placeholder')`
      ),
    'Native close did not restore the draft'
  )
  await poll(() => child.isDestroyed(), 'Native close did not complete')
  await poll(
    () => !main.isMinimized() && main.isVisible(),
    'Native close did not restore the main window'
  )
  assert.equal(
    BrowserWindow.getAllWindows().filter((win) => win.webContents.getURL() === 'about:blank')
      .length,
    0
  )
  report.checks.push('Closing the native window returns the unsaved editor to the main window')
  await evaluate(`document.querySelector('.audio-window-button').click()`)
  await poll(
    () => BrowserWindow.getAllWindows().some((win) => win.webContents.getURL() === 'about:blank'),
    'Reopening failed'
  )
  assert.equal(
    await childRead(`w.document.querySelector('.scene-toolbar input').value`),
    stateBefore
  )
  await childRead(
    `(()=>{[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()==='移回主窗口').click();return true})()`
  )
  await poll(
    () =>
      evaluate(
        `document.querySelector('.scene-toolbar input')?.value==='窗口草稿验证' && !document.querySelector('.audio-window-placeholder')`
      ),
    'Dock button did not restore editor'
  )
  report.checks.push('Reopening and docking preserve the same draft')
  await evaluate(
    `(()=>{[...document.querySelectorAll('.rack-header button')].find(b=>b.textContent.trim()==='还原更改').click();return true})()`
  )
  await poll(
    () => evaluate(`document.querySelector('.draft-status')?.textContent.trim()==='更改已保存'`),
    'Test draft did not restore'
  )
  await evaluate(`document.querySelector('#audio-workspace-tab-equalizer').click()`)
  await poll(
    () =>
      evaluate(
        `!!document.querySelector('.eq-page .invisible-range') && !document.querySelector('.eq-container').inert`
      ),
    'EQ did not remount'
  )
  await evaluate(`document.querySelector('.audio-window-button').click()`)
  const eqWindow = await poll(
    () =>
      BrowserWindow.getAllWindows().find(
        (win) => win !== main && win.webContents.getURL() === 'about:blank'
      ),
    'EQ window missing'
  )
  await poll(
    () => childRead(`!!w.document.querySelector('.eq-page .invisible-range')`),
    'EQ did not detach'
  )
  await screenshot(eqWindow, 'equalizer-window-before-minimize')
  assert.equal(
    await childRead(
      `(()=>{const board=w.document.querySelector('.sliders-board');const rect=board.getBoundingClientRect();return rect.top>=0 && rect.bottom<=w.innerHeight})()`
    ),
    true,
    'Primary EQ sliders should fit the initial native window without vertical scrolling'
  )
  report.checks.push('Primary EQ controls fit the initial native window without scrolling')
  main.minimize()
  eqWindow.show()
  eqWindow.focus()
  assert.equal(eqWindow.isVisible(), true)
  assert.equal(eqWindow.isMinimized(), false)
  await childRead(
    `(()=>{const range=w.document.querySelector('.invisible-range');range.value='1.3';range.dispatchEvent(new w.Event('input',{bubbles:true}));return true})()`
  )
  await poll(
    () => childRead(`w.document.querySelector('.slider-gain').textContent.trim()==='+1.3'`),
    'EQ preview stalled when main window minimized'
  )
  await childRead(
    `(()=>{const range=w.document.querySelector('.invisible-range');range.dispatchEvent(new w.Event('change',{bubbles:true}));return true})()`
  )
  await poll(
    () => childRead(`w.document.querySelector('.eq-title p').textContent.includes('已同步')`),
    'EQ commit did not complete'
  )
  await screenshot(eqWindow, 'equalizer-window-dark')
  report.checks.push(
    'Equalizer previews and commits remain responsive with the main window minimized'
  )
  await childRead(
    `(()=>{[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()==='移回主窗口').click();return true})()`
  )
  await poll(
    () => !main.isMinimized() && main.isVisible(),
    'Docking did not restore the main window'
  )
  report.passed = true
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log('DSP_WINDOW_OK', JSON.stringify(report.checks))
  clearTimeout(timeout)
  app.exit(0)
}
run().catch((error) => {
  report.error = error.stack
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.error(error.stack)
  clearTimeout(timeout)
  app.exit(1)
})
