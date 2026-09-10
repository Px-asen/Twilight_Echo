import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const run = promisify(execFile)

async function component(file: string, name: string): Promise<string> {
  const source = await readFile(new URL(file, import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename: file })
  let script = ts.transpileModule(
    compileScript(descriptor, { id: name, inlineTemplate: true }).content,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
  ).outputText
  script = script.replace(
    /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g,
    (_match, bindings: string, path: string) =>
      `const { ${bindings.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')} } = ${path === 'vue' ? 'Vue' : 'window.fixture'};`
  )
  script = script.replace(
    /import\s+(\w+)\s+from\s*['"][^'"]+['"];?/g,
    'const $1 = window.fixture.$1;'
  )
  script = script.replace('export default', `window.fixture.${name} =`)
  assert.doesNotMatch(script, /^import /m)
  return `(() => { ${script} })();`
}

test('real Vue login ignores stale QR replies and list links navigate without playing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'te-issue46-ui-'))
  try {
    const vue = await readFile(require.resolve('vue/dist/vue.global.prod.js'), 'utf8')
    const scripts = await Promise.all([
      component('./TrackInfoDialog.vue', 'TrackInfoDialog'),
      component('./streaming-page/StreamingDetailStage.vue', 'DetailStage'),
      component('./LoginPage.vue', 'LoginPage')
    ])
    const html = join(directory, 'fixture.html')
    const runner = join(directory, 'runner.cjs')
    await writeFile(
      html,
      `<!doctype html><html><body><div id="login"></div><div id="list"></div><script>${vue}</script><script>
      const { ref, computed } = Vue;
      const replies = [];
      const provider = { id: 'ncm', name: 'NetEase', capabilities: ['login'], ui: {} };
      window.fixture = {
        QRCode: { toDataURL: async () => 'data:image/png;base64,AA==' },
        AnimatedInput: { template: '<input />' }, CoverImg: { template: '<img />' },
        useBackHandler: () => {},
        createVisibilityPollingController: () => ({ onVisibilityChange() {} }),
        useNcmStore: () => ({ checkLogin: async () => {} }),
        useProviderStore: () => ({ providers: ref([provider]), syncProviders: async () => {}, hasProvider: () => true, getProvider: () => provider, checkLogin: async () => ({ loggedIn: false, profile: null }), getQrLogin: () => new Promise(resolve => replies.push(resolve)) }),
        useProgressiveList: source => ({ visibleItems: computed(source), visibleStart: ref(0), paddingTop: ref(0), totalHeight: computed(() => source().length * 64), listRef: () => {} })
      };
      ${scripts.join('\n')}
      const tick = async () => { for (let i = 0; i < 6; i++) { await Vue.nextTick(); await new Promise(resolve => requestAnimationFrame(resolve)); } };
      const check = (value, message) => { if (!value) throw Error(message) };
      window.runChecks = async () => {
        let loggedIn = 0;
        const login = Vue.createApp(fixture.LoginPage, { initialProviderId: 'ncm', onLoginSuccess: () => loggedIn++ });
        login.mount('#login'); await tick();
        check(replies.length === 1, 'QR request started');
        const back = [...document.querySelectorAll('#login button')].find(el => el.textContent.includes('全部平台'));
        check(back, 'platform back button'); back.click(); await tick();
        replies[0]({ key: 'expired-session', imageDataUrl: 'data:image/png;base64,AA==' }); await tick();
        check(document.querySelector('#login .stage-title').textContent.includes('选择你的音乐平台'), 'stale QR must not replace platform picker');
        check(loggedIn === 0, 'stale request must not navigate to streaming');
        login.unmount();
        let played = 0, artist = 0, album = 0;
        const track = { id: 'ncm:1', title: 'Song', artist: 'Artist', album: 'Album', duration: 180, cover: null };
        const list = Vue.createApp(fixture.DetailStage, { kind: 'playlist', title: 'Playlist', trackCountLabel: '1', tracks: [track], isSelected: () => false, isTrackLiked: () => false, isLiking: () => false, formatTime: () => '3:00', onTrackClick: () => played++, onPlayTrack: () => played++, onOpenArtist: () => artist++, onOpenAlbum: () => album++ });
        list.mount('#list'); await tick();
        document.querySelector('.row-title').click(); await tick();
        check(document.querySelector('dialog[open]'), 'song title opens information');
        document.querySelector('dialog').close(); await tick();
        document.querySelector('.row-artist').click();
        document.querySelector('.stage-row .col-album button').click();
        document.querySelector('.row-artist').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        check(artist === 1 && album === 1 && played === 0, 'metadata links must not play');
        document.querySelector('.row-play-btn').click(); check(played === 1, 'play button still plays');
        list.unmount(); return 'passed';
      };
    </script></body></html>`
    )
    await writeFile(
      runner,
      `const { app, BrowserWindow } = require('electron'); app.whenReady().then(async () => { const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, backgroundThrottling: false } }); try { await win.loadFile(process.argv.at(-1)); await win.webContents.executeJavaScript('window.runChecks()'); console.error('ISSUE46_UI_OK'); app.exit(0); } catch (error) { console.error(error); app.exit(1); } });`
    )
    const { stderr } = await run(require('electron') as string, ['--no-sandbox', runner, html], {
      windowsHide: true,
      timeout: 60000
    })
    assert.match(stderr, /ISSUE46_UI_OK/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
