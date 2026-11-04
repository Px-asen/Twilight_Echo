const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const assert = require('node:assert/strict')
const { installElectronSecurity } = require('./security.cjs')

app.setPath('userData', path.join(__dirname, 'profile'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const id = '1111111111111111'
let ready = false,
  state = { active: false },
  video,
  videoMode = 'ready',
  controlFailure = '',
  propsReads = 0
const writes = [],
  messages = [],
  pendingVideos = []
const props = [
  { name: 'enabled', text: '显示星光', ptype: 'bool', value: false, default: false },
  {
    name: 'speed',
    text: '流动速度',
    ptype: 'slider',
    min: 0,
    max: 10,
    step: 1,
    value: 3,
    default: 3,
    condition: 'enabled.value === true && (2 + 3 * 4) === 14'
  },
  {
    name: 'mode',
    text: '显示模式',
    ptype: 'combo',
    value: 1,
    default: 1,
    options: [
      { value: 1, label: '标准' },
      { value: 2, label: '粒子' }
    ]
  },
  {
    name: 'unsafe',
    text: '条件不执行代码',
    ptype: 'bool',
    value: false,
    default: false,
    condition: 'window.__wallpaperExecuted = true'
  }
]
const items = [
  { id, title: '暮色 · 网页交互', type: 'web' },
  { id: '2222222222222222', title: '蓝色 · 视频', type: 'video' },
  { id: '3333333333333333', title: '星空 · 场景', type: 'scene' }
]
const frameHtml = `<!doctype html><html><head><style>html{height:100%;background:linear-gradient(130deg,#164253,#55384d)}</style></head><body><script>addEventListener('message',e=>{fetch('/observed',{method:'POST',body:JSON.stringify(e.data)})});parent.postMessage({type:'fixture-loaded'},'*')</script></body></html>`
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range')
  let body = ''
  for await (const chunk of req) body += chunk
  const url = new URL(req.url, 'http://127.0.0.1:3100')
  let data = body ? JSON.parse(body) : {}
  const json = (value) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(value))
  }
  if (url.pathname === '/api/state') return json(ready ? state : {})
  if (url.pathname === '/api/wallpapers') return json({ items, selected: state.id || '', state })
  if (url.pathname.startsWith('/api/props/')) {
    propsReads++
    return json({ ok: true, id, props })
  }
  if (url.pathname === '/api/props') {
    writes.push(data)
    return json({ ok: true })
  }
  if (url.pathname === '/api/layout') {
    Object.assign(state, data)
    writes.push(data)
    return json({ ok: true })
  }
  if (url.pathname === '/api/apply') {
    const item = items.find((item) => item.id === data.id)
    state = {
      ...state,
      ...data,
      active: true,
      paused: false,
      type: item.type === 'scene' ? 'web' : item.type,
      scene: item.type === 'scene',
      url:
        item.type === 'scene'
          ? '/scene-live/index.html?sceneFps=60&theme=night'
          : item.type === 'video'
            ? '/media/' + item.id
            : '/web/' + item.id + '/index.html'
    }
    return json({ ok: true, state })
  }
  if (url.pathname === '/api/control') {
    writes.push(data)
    if (['mini-cover', 'playback-bg'].includes(data.action)) {
      if (controlFailure === 'network') return req.socket.destroy()
      if (controlFailure) return json({ ok: false, error: '设置未保存' })
      state[data.action === 'mini-cover' ? 'miniCover' : 'playbackBg'] = data.value
    } else if (data.action === 'stop') state = { ...state, active: false }
    else if (data.action === 'interact') state.interactive = !state.interactive
    else state.paused = data.action === 'pause'
    return json({ ok: true, state })
  }
  if (url.pathname === '/observed') {
    messages.push(data)
    return json({ ok: true })
  }
  if (url.pathname.startsWith('/web/') || url.pathname.startsWith('/scene-live/')) {
    res.setHeader('Content-Type', 'text/html')
    return res.end(frameHtml)
  }
  if (url.pathname.startsWith('/media/')) {
    if (videoMode === 'pending') await new Promise((resolve) => pendingVideos.push(resolve))
    if (videoMode === 'broken') {
      res.writeHead(404)
      return res.end('Missing wallpaper')
    }
    res.setHeader('Content-Type', 'video/webm')
    res.setHeader('Content-Length', video.length)
    return res.end(video)
  }
  if (url.pathname.startsWith('/preview/')) {
    res.setHeader('Content-Type', 'image/svg+xml')
    return res.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path fill="#236daa" d="M0 0h8v8H0z"/></svg>'
    )
  }
  res.writeHead(204)
  res.end()
})

// Keep the real 3100 service untouched, while the renderer still requests the
// exact production origin through both real CSPs. Only this isolated session
// routes those requests to the fixture's ephemeral HTTP listener.
async function fixtureRequest(request) {
  const url = new URL(request.url)
  if (url.origin !== 'http://127.0.0.1:3100') return Response.error()
  url.port = String(server.address().port)
  try {
    return await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer()
    })
  } catch {
    return Response.error()
  }
}

app.whenReady().then(async () => {
  let win
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    session.defaultSession.protocol.handle('http', fixtureRequest)
    installElectronSecurity()
    win = new BrowserWindow({
      show: false,
      width: 1100,
      height: 900,
      useContentSize: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        offscreen: true,
        backgroundThrottling: false
      }
    })
    const run = (code) => win.webContents.executeJavaScript(code)
    const until = async (code, label) => {
      const end = Date.now() + 7000
      while (!(typeof code === 'function' ? await code() : await run(code))) {
        if (Date.now() > end) throw new Error(label)
        await sleep(50)
      }
    }
    await win.loadFile(path.join(__dirname, 'renderer/index.html'))
    await sleep(1800)
    assert.equal(
      await run("!!document.querySelector('#te-we-picker')"),
      false,
      'missing plugin adds controls'
    )
    assert.equal(await run("document.documentElement.dataset.teWeBg === 'on'"), false)
    ready = true
    await until(
      "!!document.querySelector('#te-we-picker')",
      'picker was not inserted at background heading'
    )
    assert.equal(
      await run("document.querySelector('#te-we-picker').nextElementSibling.id"),
      'legacy-background'
    )
    assert.equal(propsReads, 0, 'unapplied candidates load properties')
    assert.deepEqual(
      await run(
        "['te-we-mini-cover','te-we-playback-bg'].map(id=>document.getElementById(id).checked)"
      ),
      [true, true],
      'legacy states without coverage flags must keep the v5 defaults'
    )
    await run("document.querySelector('#te-we-mini-cover').click()")
    await until(
      "!document.querySelector('#te-we-mini-cover').disabled",
      'inactive coverage change did not finish'
    )
    assert.equal(state.miniCover, false)
    assert.equal(await run("document.querySelector('#te-we-mini-cover').checked"), false)
    await run("document.querySelector('#te-we-mini-cover').click()")
    await until(
      "!document.querySelector('#te-we-mini-cover').disabled",
      'inactive coverage could not be restored'
    )
    // Read the real editor surface and shared material inputs before the
    // wallpaper activates. The bridge must clear painters, not these tokens.
    const appearanceState = `(() => {
      const root = getComputedStyle(document.documentElement);
      const editor = document.querySelector('.appearance-editor');
      return {
        background: getComputedStyle(editor).backgroundColor,
        tokens: Object.fromEntries([
          '--te-app-bg', '--te-app-bg-image', '--te-settings-backplate',
          '--te-settings-bg', '--te-tp-base-alpha', '--te-tp-surface-alpha',
          '--te-tp-card-alpha'
        ].map(name => [name, root.getPropertyValue(name).trim()]))
      };
    })()`
    await run(`(() => {
      const editor = document.createElement('section');
      editor.className = 'appearance-editor';
      editor.hidden = true;
      editor.style.display = 'none';
      document.querySelector('#app').append(editor);
      document.documentElement.style.setProperty('--te-app-bg-image', 'linear-gradient(#123456, #654321)');
    })()`)
    const originalAppearance = await run(appearanceState)
    await run(
      "document.querySelector('#te-we-picker-select').value='" +
        id +
        "';document.querySelector('#te-we-picker-select').dispatchEvent(new Event('change'));document.querySelector('#te-we-picker-apply').click()"
    )
    await until(
      "!!document.querySelector('#te-we-widgets input[type=checkbox]')",
      'applied wallpaper properties missing'
    )
    await until(
      "!!document.querySelector('#te-we-bg iframe') && document.documentElement.dataset.teWeBg==='on'",
      'web iframe missing'
    )
    assert.equal(
      await run(
        "getComputedStyle(document.querySelector('.settings-overlay-root'),'::before').display"
      ),
      'none',
      'settings backplate covers wallpaper'
    )
    assert.deepEqual(
      await run(appearanceState),
      originalAppearance,
      'wallpaper makes the editor transparent or replaces shared material inputs'
    )
    for (const [theme, color] of [
      ['pureWhite', 'rgb(245, 246, 248)'],
      ['dark', 'rgb(23, 24, 26)']
    ]) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      assert.equal(
        (await run(appearanceState)).background,
        color,
        `${theme} editor loses its solid backplate`
      )
      await run("document.documentElement.dataset.windowTransparent='on'")
      assert.equal(
        (await run(appearanceState)).background,
        color,
        'transparent windows also need a solid editor'
      )
      assert.equal((await run(appearanceState)).tokens['--te-tp-surface-alpha'], '0.72')
      await run('delete document.documentElement.dataset.windowTransparent')
    }
    await run(`(() => {
      const editor = document.querySelector('.appearance-editor');
      editor.hidden = false;
      editor.style.cssText = 'position:fixed;inset:60px 50px auto;padding:24px;z-index:10030;gap:18px';
      editor.innerHTML = '<h2>背景与界面材质</h2><p>动态壁纸不应穿透编辑面板</p><div class="appearance-mini-window" style="height:180px;--appearance-color:var(--te-app-bg)"><div class="appearance-mini-title" style="--preview-surface:color-mix(in srgb,var(--te-app-bg) var(--fixture-opacity,100%),transparent)">材质底色</div></div>';
    })()`)
    const materialState = () =>
      run(`(() => {
      const surface = document.querySelector('.appearance-mini-title');
      const style = getComputedStyle(surface);
      const pixel = document.createElement('canvas').getContext('2d');
      pixel.fillStyle = style.backgroundColor;
      pixel.fillRect(0, 0, 1, 1);
      return [...pixel.getImageData(0, 0, 1, 1).data];
    })()`)
    assert.equal((await materialState())[3], 255, 'solid material still resolves to transparent')
    await run(
      "document.querySelector('.appearance-editor').style.setProperty('--fixture-opacity','30%')"
    )
    assert.ok(
      Math.abs((await materialState())[3] - 77) <= 1,
      'material opacity cannot be adjusted with wallpaper active'
    )
    if (process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR, { recursive: true })
      fs.writeFileSync(
        path.join(process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR, 'appearance-backplate.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    await run("document.querySelector('.appearance-editor').style.display='none'")
    await run(`(() => {
      const player = document.createElement('section');
      player.id = 'fixture-player';
      player.className = 'playing-music bg-blur';
      player.hidden = true;
      player.style.cssText = '--te-player-bg:rgb(34,51,68);--te-player-bg-image:linear-gradient(#234567,#765432)';
      player.innerHTML = '<div class="backdrop"><div class="backdrop-cover-wrap"><div class="backdrop-cover"></div></div><div class="backdrop-fluid"></div><div class="backdrop-solid"></div><div class="backdrop-scrim"></div><div class="backdrop-accent"></div></div>';
      for (const el of [player, ...player.querySelectorAll('*')]) el.setAttribute('data-v-wallpaper-fixture', '');
      document.querySelector('#app').append(player);
    })()`)
    const playerAppearance = `(() => {
      const style = selector => getComputedStyle(document.querySelector('#fixture-player' + selector));
      return {
        background: style('').backgroundColor,
        image: style('').backgroundImage,
        backdrop: style(' .backdrop').backgroundColor,
        filter: style(' .backdrop').filter,
        cover: style(' .backdrop-cover-wrap').display,
        fluid: style(' .backdrop-fluid').display,
        solid: style(' .backdrop-solid').display,
        accent: style(' .backdrop-accent').display,
        scrimFilter: style(' .backdrop-scrim').backdropFilter
      };
    })()`
    assert.deepEqual(await run(playerAppearance), {
      background: 'rgba(0, 0, 0, 0)',
      image: 'none',
      backdrop: 'rgba(0, 0, 0, 0)',
      filter: 'none',
      cover: 'none',
      fluid: 'none',
      solid: 'none',
      accent: 'none',
      scrimFilter: 'none'
    })
    assert.equal(
      await run(
        "document.querySelector('#te-we-playback-bg').click();document.documentElement.dataset.tePlaybackBg || 'off'"
      ),
      'off',
      'playback toggle must take effect before the service responds'
    )
    await until(
      "!document.querySelector('#te-we-playback-bg').disabled",
      'playback toggle stayed pending'
    )
    assert.equal(state.playbackBg, false)
    const nativePlayer = await run(playerAppearance)
    assert.equal(nativePlayer.background, 'rgb(34, 51, 68)')
    assert.match(nativePlayer.image, /linear-gradient/)
    assert.notEqual(nativePlayer.cover, 'none')
    assert.equal(nativePlayer.scrimFilter, 'blur(10px)')
    await run("document.querySelector('#te-we-playback-bg').click()")
    await until(
      "!document.querySelector('#te-we-playback-bg').disabled",
      'playback coverage did not return'
    )
    for (const failure of ['reject', 'network']) {
      controlFailure = failure
      await run("document.querySelector('#te-we-playback-bg').click()")
      await until(
        "!document.querySelector('#te-we-playback-bg').disabled && document.querySelector('#te-we-picker-status').textContent.includes('设置失败')",
        failure + ' did not report the coverage failure'
      )
      assert.equal(await run("document.querySelector('#te-we-playback-bg').checked"), true)
      assert.equal(await run('document.documentElement.dataset.tePlaybackBg'), 'on')
      assert.equal(state.playbackBg, true, 'failed coverage request changed the saved state')
    }
    controlFailure = ''
    state.playbackBg = false
    await until(
      "!document.querySelector('#te-we-playback-bg').checked",
      'polled coverage did not update the control'
    )
    assert.deepEqual(
      await run(playerAppearance),
      nativePlayer,
      'native player background was not restored'
    )
    state.playbackBg = true
    await until(
      "document.querySelector('#te-we-playback-bg').checked",
      'polled coverage could not be restored'
    )
    await sleep(150)
    assert.equal(
      await run(
        "getComputedStyle(document.querySelector('#te-we-widgets input[type=range]').parentElement).display"
      ),
      'none',
      'CSP prevents property condition evaluation'
    )
    await run("document.querySelector('#te-we-widgets input[type=checkbox]').click()")
    assert.notEqual(
      await run(
        "getComputedStyle(document.querySelector('#te-we-widgets input[type=range]').parentElement).display"
      ),
      'none',
      'live condition stays hidden'
    )
    await run(
      "let s=document.querySelector('#te-we-widgets input[type=range]');s.value=7;s.dispatchEvent(new Event('input'))"
    )
    await sleep(180)
    assert.ok(
      messages.some(
        (message) => message.type === 'te-prop' && message.name === 'speed' && message.value === 7
      ),
      'property is not pushed directly to iframe'
    )
    assert.ok(
      writes.some((write) => write.name === 'speed' && write.value === 7),
      'property is not persisted'
    )
    assert.equal(await run('!!window.__wallpaperExecuted'), false)
    await run(
      "window.originalFrame=document.querySelector('#te-we-bg iframe');let x=document.querySelector('#te-we-x');x.value=24;x.dispatchEvent(new Event('input'))"
    )
    assert.equal(
      await run(
        "document.querySelector('#te-we-bg iframe')===window.originalFrame && window.originalFrame.style.transform.includes('24%')"
      ),
      true,
      'layout must update immediately without reloading iframe'
    )
    await sleep(160)
    assert.ok(writes.some((write) => write.offsetX === '24'))
    await run("document.querySelector('#te-we-picker-interact').click()")
    await until("!!document.querySelector('#te-we-exit')", 'interaction exit missing')
    assert.equal(
      await run(
        "let e=document.querySelector('#te-we-exit'),r=e.getBoundingClientRect();document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e"
      ),
      true,
      'exit is covered by app'
    )
    await run("document.querySelector('#te-we-exit').click()")
    await until("!document.querySelector('#te-we-exit')", 'interaction exit did not restore app')
    // The same bridge follows the new workspace's visible heading, not a
    // retained but hidden legacy settings page. No Vue setting changes.
    await run(
      "document.querySelector('.settings-page').style.display='none';document.querySelector('.appearance-page').classList.remove('hidden')"
    )
    await until(
      "document.querySelector('#te-we-picker').nextElementSibling.id==='new-background'",
      'picker does not follow current appearance host'
    )
    if (process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR, { recursive: true })
      await sleep(400)
      fs.writeFileSync(
        path.join(process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR, 'controls.json'),
        JSON.stringify(
          await run(
            "[...document.querySelectorAll('#te-we-picker, #te-we-picker *')].map(e=>({tag:e.tagName,id:e.id,text:e.childElementCount?'':e.textContent,rect:e.getBoundingClientRect().toJSON(),color:getComputedStyle(e).color,display:getComputedStyle(e).display,opacity:getComputedStyle(e).opacity}))"
          ),
          null,
          2
        )
      )
      fs.writeFileSync(
        path.join(process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR, 'web-properties.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    await run("document.querySelector('#te-we-picker-stop').click()")
    await until(
      "document.documentElement.dataset.teWeBg==='off' && !document.querySelector('#te-we-bg')",
      'stop did not restore native background'
    )
    assert.equal(
      await run(
        "getComputedStyle(document.querySelector('.settings-overlay-root'),'::before').display"
      ),
      'block',
      'stop did not restore native backplate'
    )
    assert.deepEqual(
      await run(appearanceState),
      originalAppearance,
      'stop changes native material inputs'
    )
    await run("document.querySelector('#te-we-picker-apply').click()")
    await until(
      "!!document.querySelector('#te-we-bg iframe')",
      'same wallpaper cannot restart after cleanup'
    )
    // Record a real, tiny VP8 video locally; this exercises media-src and
    // Chromium decoding, rather than merely asserting the video.src string.
    video = Buffer.from(
      await run(
        `new Promise(resolve=>{const c=document.createElement('canvas');c.width=64;c.height=64;const x=c.getContext('2d');const stream=c.captureStream(10),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);const draw=setInterval(()=>{x.fillStyle='#236daa';x.fillRect(0,0,64,64)},50);recorder.onstop=()=>{clearInterval(draw);stream.getTracks().forEach(t=>t.stop());const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(new Blob(chunks,{type:'video/webm'}))};recorder.start();setTimeout(()=>recorder.stop(),600)})`
      ),
      'base64'
    )
    videoMode = 'pending'
    await run(
      "document.querySelector('#te-we-x').value='0';document.querySelector('#te-we-picker-select').value='2222222222222222';document.querySelector('#te-we-picker-apply').click()"
    )
    await until(() => pendingVideos.length > 0, 'video was not requested')
    assert.equal(
      await run('document.documentElement.dataset.teWeBg'),
      'off',
      'loading video hides the original background before its first frame'
    )
    assert.equal(
      await run("document.querySelector('#te-we-picker-status').textContent"),
      '画面加载中…',
      'API acknowledgement is incorrectly reported as visible playback'
    )
    videoMode = 'ready'
    pendingVideos.splice(0).forEach((resolve) => resolve())
    await until(
      "document.querySelector('#te-we-bg video')?.readyState>=2",
      'video is blocked or cannot decode'
    )
    await sleep(500)
    const pixel = (
      await win.webContents.capturePage({ x: 10, y: 850, width: 1, height: 1 })
    ).toBitmap()
    assert.ok(
      [170, 109, 35].every((channel, i) => Math.abs(pixel[i] - channel) < 12),
      'decoded wallpaper is covered: ' + [...pixel]
    )
    assert.equal(
      await run(
        "let v=document.querySelector('#te-we-bg video');v.muted && v.defaultMuted && !v.paused"
      ),
      true,
      'video must play silently'
    )
    await run("document.querySelector('#te-we-picker-pause').click()")
    await until("document.querySelector('#te-we-bg video').paused", 'video did not pause')
    await run("document.querySelector('#te-we-picker-pause').click()")
    await until("!document.querySelector('#te-we-bg video').paused", 'video did not resume')
    await run(
      "document.querySelector('#te-we-picker-select').value='1111111111111111';document.querySelector('#te-we-picker-apply').click()"
    )
    await until("!!document.querySelector('#te-we-bg iframe')", 'switch away from video failed')
    videoMode = 'broken'
    await run(
      "document.querySelector('#te-we-picker-select').value='2222222222222222';document.querySelector('#te-we-picker-apply').click()"
    )
    await until(
      "document.querySelector('#te-we-picker-status').textContent.includes('播放失败')",
      'missing video is still reported as applied'
    )
    assert.equal(await run('document.documentElement.dataset.teWeBg'), 'off')
    assert.equal(
      await run(
        "getComputedStyle(document.querySelector('.settings-overlay-root'),'::before').display"
      ),
      'block',
      'media failure leaves a black wallpaper over the native background'
    )
    // A service-side repair must allow retrying the exact same media URL.
    videoMode = 'ready'
    await run("document.querySelector('#te-we-picker-apply').click()")
    await until(
      "document.querySelector('#te-we-bg video')?.readyState>=2 && document.documentElement.dataset.teWeBg==='on'",
      'same wallpaper cannot retry after a playback error'
    )
    await run(
      "let image=document.createElement('img');image.id='fixture-preview';image.src='http://127.0.0.1:3100/preview/1111111111111111';document.body.append(image)"
    )
    await until(
      "document.querySelector('#fixture-preview').naturalWidth===8",
      'preview image blocked'
    )
    await run(
      "document.querySelector('#te-we-picker-select').value='3333333333333333';document.querySelector('#te-we-picker-apply').click()"
    )
    await until(
      "document.querySelector('#te-we-bg iframe')?.src.includes('/scene-live/')",
      'scene iframe is blocked'
    )
    assert.deepEqual(await run('window.cspViolations'), [], 'loopback resources violate CSP')
    const sceneGeometry = `(() => {
      const layer = document.querySelector('#te-we-bg').getBoundingClientRect();
      const frame = document.querySelector('#te-we-bg iframe').getBoundingClientRect();
      return Math.abs(frame.width / frame.height - 16 / 9) < .001 &&
        frame.width >= layer.width && frame.height >= layer.height &&
        Math.abs((frame.left + frame.right) / 2 - (layer.left + layer.right) / 2) < 1 &&
        Math.abs((frame.top + frame.bottom) / 2 - (layer.top + layer.bottom) / 2) < 1;
    })()`
    assert.equal(
      await run(sceneGeometry),
      true,
      'scene cover must fill the window without stretching'
    )
    assert.equal(
      await run(
        "new URL(document.querySelector('#te-we-bg iframe').src).searchParams.get('sceneFps')"
      ),
      '60',
      'mini player frame-rate limit leaked into the main window'
    )
    state.interactive = true
    const mini = new BrowserWindow({
      show: false,
      width: 640,
      height: 240,
      useContentSize: true,
      transparent: true,
      frame: false,
      webPreferences: { offscreen: true, backgroundThrottling: false }
    })
    const miniRun = (code) => mini.webContents.executeJavaScript(code)
    const miniUntil = (code, label) => until(() => miniRun(code), label)
    await mini.loadFile(path.join(__dirname, 'renderer/index.html'), {
      query: { window: 'mini-player' }
    })
    await miniUntil(
      "!!document.querySelector('#te-we-bg iframe')",
      'mini player did not start the scene'
    )
    await miniRun(`(() => {
      document.body.className = '';
      document.documentElement.style.cssText = 'width:100%;height:100%';
      document.body.style.cssText = 'width:100%;height:100%';
      document.querySelector('#app').style.cssText = 'width:100%;height:100%';
      document.querySelector('#app').innerHTML = '<main class="mini-player-root is-ready" data-layout="wide" style="--mini-window-radius:24px;--mini-text:#fff;--mini-background-fallback:#20242c;--mini-track-accent:#a377bd;--mini-surface-opacity:.6;--mini-background-overlay:rgba(5,7,11,.25)"><div class="mini-window-fill"></div><section class="mini-player-surface"><div class="mini-background-source"></div><div class="mini-background-overlay"></div><div class="mini-grain"></div><div class="mini-artwork-wrap" style="background:linear-gradient(135deg,#b98089,#394c7b)"></div><div class="mini-info"><div class="mini-kicker">TWILIGHT ECHO</div><h1 class="mini-title">暮色回声</h1><p class="mini-artist">Wallpaper Engine</p></div><div class="mini-controls"><button class="mini-play-button">▶</button></div></section></main>';
      window.originalWallpaperFrame = document.querySelector('#te-we-bg iframe');
    })()`)
    await miniUntil(
      "document.querySelector('#te-we-bg').parentElement === document.querySelector('.mini-player-root')",
      'mini wallpaper did not follow the asynchronously mounted Vue root'
    )
    assert.equal(await miniRun(sceneGeometry), true)
    assert.deepEqual(
      await miniRun("[...new URL(document.querySelector('#te-we-bg iframe').src).searchParams]"),
      [
        ['sceneFps', '30'],
        ['theme', 'night']
      ]
    )
    assert.equal(await miniRun("!!document.querySelector('#te-we-picker, #te-we-exit')"), false)
    const miniFill = "getComputedStyle(document.querySelector('.mini-window-fill')).display"
    assert.equal(await miniRun(miniFill), 'none')
    assert.equal(
      await miniRun("getComputedStyle(document.querySelector('.mini-player-root')).overflow"),
      'hidden'
    )
    assert.equal(
      await miniRun("getComputedStyle(document.querySelector('.mini-player-root')).borderRadius"),
      '24px'
    )
    await miniRun("document.querySelector('.mini-player-root').classList.add('is-customizing')")
    assert.notEqual(await miniRun(miniFill), 'none', 'mini customizer lost its own background')
    await miniRun("document.querySelector('.mini-player-root').classList.remove('is-customizing')")
    await miniRun(`(() => {
      const root = document.querySelector('.mini-player-root');
      const replacement = root.cloneNode(false);
      replacement.innerHTML = root.querySelector('.mini-window-fill').outerHTML + root.querySelector('.mini-player-surface').outerHTML;
      window.pendingMiniRoot = replacement;
      root.remove();
    })()`)
    // A polling tick while Vue has no root must retain the detached media,
    // rather than creating an empty replacement with the same signature.
    await sleep(2200)
    assert.equal(await miniRun("!!document.querySelector('#te-we-bg')"), false)
    await miniRun("document.querySelector('#app').append(window.pendingMiniRoot)")
    await miniUntil(
      "document.querySelector('.mini-player-root #te-we-bg iframe') === window.originalWallpaperFrame",
      'mini root remount recreated or lost the wallpaper'
    )
    mini.setContentSize(360, 420)
    await miniUntil(
      'innerWidth === 360 && innerHeight === 420',
      'mini resize did not reach the viewport'
    )
    await miniUntil(sceneGeometry, 'scene cover did not update on mini window resize')
    state.fit = 'contain'
    await miniUntil(
      "document.querySelector('#te-we-bg iframe').style.width === '100%'",
      'scene fit change did not reset cropped dimensions'
    )
    state.fit = 'cover'
    await miniUntil(sceneGeometry, 'scene cover could not be restored')
    await run("document.querySelector('#te-we-mini-cover').click()")
    await miniUntil(
      "document.documentElement.dataset.teWeBg === 'off' && !document.querySelector('#te-we-bg')",
      'mini coverage switch did not stop and release its media'
    )
    assert.notEqual(
      await miniRun(miniFill),
      'none',
      'mini coverage switch did not restore the native fill'
    )
    await run("document.querySelector('#te-we-mini-cover').click()")
    await miniUntil(
      "!!document.querySelector('#te-we-bg.te-we-visible iframe')",
      'mini coverage could not restart'
    )
    state = {
      active: true,
      id: '2222222222222222',
      type: 'video',
      url: '/media/2222222222222222',
      quality: 'original',
      paused: true
    }
    await miniUntil(
      "document.documentElement.dataset.teWeBg === 'on' && document.querySelector('#te-we-bg canvas')?.height === 720 && document.querySelector('#te-we-bg video').paused",
      'mini player did not display the first frame of a paused original-quality video at 720P'
    )
    assert.equal(state.quality, 'original', 'mini player changed the shared quality setting')
    await until(
      "!!document.querySelector('#te-we-bg.te-we-visible > video')",
      'main window was also limited to a scaled canvas'
    )
    state.fit = 'contain'
    await miniUntil(
      "document.querySelector('#te-we-bg canvas').style.objectFit === 'contain'",
      'scaled canvas ignored live fit'
    )
    assert.equal(
      await miniRun("document.querySelector('#te-we-bg').firstElementChild.style.transform"),
      '',
      'identity layout still forces a compositor transform'
    )
    if (process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR) {
      let resizedImage
      const onPaint = (_event, _dirty, image) => {
        const { width, height } = image.getSize()
        if (width === 640 && height === 240) resizedImage = image
      }
      mini.webContents.on('paint', onPaint)
      mini.setContentSize(640, 240)
      await until(() => !!resizedImage, 'mini evidence did not paint the resized surface')
      mini.webContents.removeListener('paint', onPaint)
      fs.writeFileSync(
        path.join(process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR, 'mini-player.png'),
        resizedImage.toPNG()
      )
    }
    state.quality = '1080'
    await miniUntil(
      "document.querySelector('#te-we-bg canvas')?.height === 1080",
      'mini player ignored an explicit quality selection'
    )
    assert.deepEqual(await miniRun('window.cspViolations'), [], 'mini media violates CSP')
    videoMode = 'broken'
    state.url = '/media/missing-mini-video'
    await miniUntil(
      "document.documentElement.dataset.teWeBg === 'off' && !!document.querySelector('#te-we-bg video')?.dataset.teWeError",
      'mini media failure did not restore its native background'
    )
    assert.notEqual(await miniRun(miniFill), 'none')
    videoMode = 'ready'
    mini.destroy()
    // Reproduce the user's failure: updated meta CSP, but an old main-process
    // response header still rejects the media origin. Reloading only the
    // renderer cannot replace the main process's policy.
    const blockedSession = session.fromPartition('wallpaper-stale-header')
    blockedSession.protocol.handle('http', fixtureRequest)
    blockedSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["media-src 'self' blob: twilight-audio: twilight-media:"]
        }
      })
    })
    state = {
      active: true,
      id: '2222222222222222',
      type: 'video',
      url: '/media/2222222222222222'
    }
    const blocked = new BrowserWindow({
      show: false,
      width: 1100,
      height: 900,
      webPreferences: { session: blockedSession, offscreen: true, backgroundThrottling: false }
    })
    await blocked.loadFile(path.join(__dirname, 'renderer/index.html'))
    await until(
      () =>
        blocked.webContents.executeJavaScript(
          "document.querySelector('#te-we-picker-status')?.textContent.includes('安全策略')"
        ),
      'stale CSP header is not identified in the picker'
    )
    assert.equal(
      await blocked.webContents.executeJavaScript('document.documentElement.dataset.teWeBg'),
      'off',
      'CSP rejection replaces the app background with black'
    )
    if (process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR) {
      fs.writeFileSync(
        path.join(process.env.TWILIGHT_WALLPAPER_EVIDENCE_DIR, 'stale-csp.png'),
        (await blocked.webContents.capturePage()).toPNG()
      )
    }
    blockedSession.webRequest.onHeadersReceived(null)
    state.quality = '720'
    state.paused = true
    await blocked.reload()
    await until(
      () =>
        blocked.webContents.executeJavaScript(
          "document.documentElement.dataset.teWeBg==='on' && document.querySelector('#te-we-bg canvas')?.height===720 && document.querySelector('#te-we-bg video')?.paused"
        ),
      'updated policy does not restore a decoded first frame for paused, scaled video'
    )
    blocked.destroy()
    for (const kind of ['desktop-lyrics', 'tray-player', 'dynamic-island']) {
      const satellite = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
      await satellite.loadFile(path.join(__dirname, 'renderer/index.html'), {
        query: { window: kind }
      })
      assert.equal(
        await satellite.webContents.executeJavaScript(
          "!!window.__TE_WE_BG__ || !!document.querySelector('#te-we-bg-style')"
        ),
        false,
        'bridge runs in ' + kind + ' window'
      )
      satellite.destroy()
    }
    await run("fetch('http://127.0.0.1:3101/preview/test').catch(()=>{})")
    await until(
      "window.cspViolations.some(v=>v.directive==='connect-src')",
      'unrelated ports were allowed'
    )
    console.log('WALLPAPER_BRIDGE_OK')
    win.destroy()
    server.close()
    app.exit(0)
  } catch (error) {
    console.error(error.stack)
    win?.destroy()
    server.close()
    app.exit(1)
  }
})
