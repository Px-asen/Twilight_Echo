const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')
const test = require('node:test')
const { build } = require('esbuild')
const { compileStyle, parse } = require('@vue/compiler-sfc')

const root = path.resolve(__dirname, '..')

test(
  'Wallpaper Engine bridge uses both CSPs and preserves playback, live controls and host windows',
  { timeout: 120_000 },
  async () => {
    await fs.mkdir(path.join(root, 'tmp'), { recursive: true })
    const directory = await fs.mkdtemp(path.join(root, 'tmp', 'wallpaper-bridge-'))
    try {
      const renderer = path.join(directory, 'renderer')
      await fs.mkdir(renderer)
      const html = await fs.readFile(path.join(root, 'src/renderer/index.html'), 'utf8')
      const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)[1]
      const app = await fs.readFile(path.join(root, 'src/renderer/src/App.vue'), 'utf8')
      const css = await Promise.all(
        [
          'src/renderer/src/assets/base.css',
          'src/renderer/src/assets/appearance.css',
          'src/renderer/src/assets/materials.css',
          'src/renderer/src/mini-player/MiniPlayer.css',
          'src/renderer/src/components/settings-page/SettingsPage.css',
          'src/renderer/src/components/settings-page/BackgroundAppearanceCustomizer.css'
        ].map((file) => fs.readFile(path.join(root, file), 'utf8'))
      )
      const player = await fs.readFile(
        path.join(root, 'src/renderer/src/components/PlayingMusic.vue'),
        'utf8'
      )
      const { descriptor } = parse(player)
      const compiled = compileStyle({
        source: descriptor.styles[0].content,
        filename: 'PlayingMusic.vue',
        id: 'data-v-wallpaper-fixture',
        scoped: true
      })
      assert.deepEqual(compiled.errors, [])
      const noise = await fs.readFile(
        path.join(root, 'src/renderer/src/assets/images/playback-dither.svg')
      )
      css.push(
        compiled.code.replaceAll(
          '../assets/images/playback-dither.svg',
          `data:image/svg+xml;base64,${noise.toString('base64')}`
        )
      )
      await fs.writeFile(
        path.join(renderer, 'host.css'),
        css.join('\n') +
          '\n' +
          [...app.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/g)]
            .map((match) => match[1])
            .join('\n')
      )
      await fs.copyFile(
        path.join(root, 'resources/we-background.js'),
        path.join(renderer, 'we-background.js')
      )
      await fs.writeFile(
        path.join(renderer, 'observe.js'),
        "window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push({directive:e.effectiveDirective,url:e.blockedURI}));"
      )
      await fs.writeFile(
        path.join(renderer, 'index.html'),
        `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="host.css"><style>body{margin:0;font:14px system-ui;background:#141820}*{box-sizing:border-box}.settings-preview-page{padding:28px 48px;scroll-behavior:auto}.glass-card{padding:24px;border-radius:20px;background:rgba(25,29,39,.8);color:#f4f5fa}.hidden{display:none}.appearance-page{padding:20px}.appearance-details-body{padding:18px}</style><script src="observe.js"></script><script type="module" src="./we-background.js"></script></head><body class="te-local-surface"><div id="app"><div class="app-background-layer"><div class="app-background-image"></div></div><div class="settings-overlay-root settings-overlay-root--active"><main class="settings-preview-page settings-page"><section id="appearance" class="glass-card"><h2>外观</h2><div class="section-block" id="legacy-background"><h3>背景与材质</h3><p>背景编辑器</p></div></section></main><main class="settings-preview-page appearance-page hidden"><div class="appearance-details-body"><div class="section-block" id="new-background"><h3>背景与材质</h3></div></div></main></div></div></body></html>`
      )
      await build({
        entryPoints: [path.join(root, 'src/main/security/electronSecurity.ts')],
        outfile: path.join(directory, 'security.cjs'),
        bundle: true,
        platform: 'node',
        external: ['electron'],
        logLevel: 'silent'
      })
      await fs.copyFile(
        path.join(root, 'scripts/fixtures/wallpaper-bridge.cjs'),
        path.join(directory, 'runner.cjs')
      )
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        ['--no-sandbox', path.join(directory, 'runner.cjs')],
        {
          env,
          windowsHide: true,
          timeout: 110_000,
          maxBuffer: 2_000_000
        }
      )
      assert.match(result.stdout, /WALLPAPER_BRIDGE_OK/)
    } finally {
      assert.ok(path.resolve(directory).startsWith(path.join(root, 'tmp') + path.sep))
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
)
