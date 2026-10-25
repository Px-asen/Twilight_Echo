import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileScript, compileStyle, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { THEME_ICON_SLOT_REGISTRY } from '../../../../shared/theme.ts'

const require = createRequire(import.meta.url)

async function component(path: string): Promise<string> {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source, { filename: path })
  assert.deepEqual(errors, [])
  return commonJs(compileScript(descriptor, { id: path, inlineTemplate: true }).content)
}

async function componentStyle(path: string): Promise<string> {
  const { descriptor } = parse(await readFile(new URL(path, import.meta.url), 'utf8'))
  return descriptor.styles
    .map((style) => {
      const result = compileStyle({
        source: style.content,
        filename: path,
        id: 'titlebar-fixture',
        scoped: false
      })
      assert.deepEqual(result.errors, [])
      return result.code
    })
    .join('\n')
}

function commonJs(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
}

test('login and title bar recover from disabled providers in real Electron rendering', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-login-provider-fallback-'))
  try {
    const [
      vue,
      login,
      title,
      serverForm,
      providerStore,
      visibilityPolling,
      titleStyle,
      titleIcon,
      iconStyle,
      iconPaths,
      baseStyle,
      appearanceStyle,
      themeIcon,
      themeIconStyle
    ] = await Promise.all([
      readFile(require.resolve('vue/dist/vue.global.prod.js'), 'utf8'),
      component('../LoginPage.vue'),
      component('../TitleBar.vue'),
      component('./ServerLoginForm.vue'),
      readFile(new URL('../../stores/useProviderStore.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../utils/visibilityPolling.ts', import.meta.url), 'utf8'),
      componentStyle('../TitleBar.vue'),
      component('../icons/TitleBarIcon.vue'),
      componentStyle('../icons/TitleBarIcon.vue'),
      readFile(new URL('../icons/titleBarIconPaths.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../assets/base.css', import.meta.url), 'utf8'),
      readFile(new URL('../../assets/appearance.css', import.meta.url), 'utf8'),
      component('../ThemeIcon.vue'),
      componentStyle('../ThemeIcon.vue')
    ])
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><meta charset="utf-8"><style>${baseStyle}\n${appearanceStyle}\n${await readFile(new URL('../../assets/theme-layouts/obsidian-glass.css', import.meta.url), 'utf8')}\n${await readFile(new URL('../../assets/theme-layouts/paper-light.css', import.meta.url), 'utf8')}\n${titleStyle}\n${iconStyle}\n${themeIconStyle}</style><div id="title"></div><div id="app"></div>
      <script>${vue}</script><script>${runtime}</script>
      <script>
        const load = source => {
          const module = { exports: {} };
          new Function('require', 'exports', 'module', source)(window.fixtureRequire, module.exports, module);
          return module.exports;
        };
        window.visibilityPolling = load(${JSON.stringify(commonJs(visibilityPolling))});
        window.providerStoreModule = load(${JSON.stringify(commonJs(providerStore))});
        window.ServerLoginForm = load(${JSON.stringify(serverForm)}).default;
        window.LoginPage = load(${JSON.stringify(login)}).default;
        window.titleBarIconPaths = load(${JSON.stringify(commonJs(iconPaths))});
        window.themeIconRegistry = ${JSON.stringify(THEME_ICON_SLOT_REGISTRY)};
        window.ThemeIcon = load(${JSON.stringify(themeIcon)}).default;
        window.TitleBarIcon = load(${JSON.stringify(titleIcon)}).default;
        window.TitleBar = load(${JSON.stringify(title)}).default;
      </script>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const { app, BrowserWindow } = require('electron');
      app.setPath('userData', require('node:path').join(require('node:path').dirname(process.argv.at(-1)), 'user-data'));
      app.whenReady().then(async () => {
        const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
        win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
        try {
          await win.loadFile(process.argv.at(-1));
          const cases = await win.webContents.executeJavaScript('window.runProviderFallbackTests()');
          win.webContents.debugger.attach('1.3');
          for (const preference of ['normal', 'reduced-transparency', 'more-contrast']) {
            await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [
              { name: 'prefers-reduced-transparency', value: preference === 'reduced-transparency' ? 'reduce' : 'no-preference' },
              { name: 'prefers-contrast', value: preference === 'more-contrast' ? 'more' : 'no-preference' }
            ] });
            for (const theme of ['pureWhite', 'dark']) for (const menuOpen of [false, true]) for (const light of [false, true]) for (const layout of ['default', 'obsidian-glass', 'paper-light']) {
              const scenario = { preference, theme, menuOpen, light, layout };
              const expected = await win.webContents.executeJavaScript('window.preparePlaybackCaptionCase(' + JSON.stringify(scenario) + ')');
              const capture = await win.webContents.capturePage();
              const pixels = capture.toBitmap(), width = capture.getSize().width;
              for (const [x, y] of [[10, 2], [90, 2], [200, 20], [300, 20], [500, 2]]) {
                const offset = (y * width + x) * 4;
                const actual = [pixels[offset + 2], pixels[offset + 1], pixels[offset]];
                if (actual.some((channel, index) => Math.abs(channel - expected[index]) > 1)) {
                  throw new Error('Playback caption has a separate color block at ' + x + ',' + y + ': ' + JSON.stringify({ scenario, actual, expected }));
                }
              }
            }
          }
          await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
          await win.webContents.executeJavaScript('window.checkForcedColorPlaybackCaption()');
          await win.webContents.executeJavaScript('window.finishPlaybackCaptionCases()');
          console.log('LOGIN_PROVIDER_FALLBACK_OK ' + cases);
          app.exit(0);
        } catch (error) { console.error(error.stack); app.exit(1); }
      });`
    )
    const { stdout } = await promisify(execFile)(
      require('electron') as string,
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(stdout, /LOGIN_PROVIDER_FALLBACK_OK 14/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `
const { createApp, h, nextTick, ref } = Vue;
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const settle = async () => {
  for (let i = 0; i < 12; i++) { await nextTick(); await Promise.resolve(); }
  await new Promise(resolve => setTimeout(resolve, 60));
};
const ncm = { id: 'ncm', name: '网易云音乐', capabilities: ['login'], supportedMethods: [] };
const bili = { id: 'bili', name: '哔哩哔哩', capabilities: ['login'], supportedMethods: [] };
const server = { id: 'jellyfin', name: 'Jellyfin', capabilities: ['login'], supportedMethods: ['loginWithServer'], ui: { authType: 'settings' } };
const settings = { id: 'apple', name: 'Apple Music', capabilities: ['login'], supportedMethods: [], ui: { authType: 'settings' } };
const searchOnly = { id: 'search', name: '搜索', capabilities: ['search'], supportedMethods: [] };
const loggedIn = ref(false), profile = ref(null), canGoBack = ref(false), titleProps = ref({ streaming: true });
let available = [], calls = [], changed, handler, loginApp, titleApp, success = 0, configure = 0;
window.preparePlaybackCaptionCase = async ({ preference, theme, menuOpen, light, layout }) => {
  if (!titleApp) {
    titleApp = createApp({ render: () => h(window.TitleBar, { ...titleProps.value }) });
    titleApp.mount('#title');
    const backdrop = document.createElement('div');
    backdrop.id = 'playback-caption-backdrop';
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:9998';
    document.body.append(backdrop);
  }
  const expected = light ? [244, 244, 247] : [37, 49, 79];
  document.querySelector('#playback-caption-backdrop').style.background = 'rgb(' + expected.join(',') + ')';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.tePresetLayout = layout;
  // The artwork or background filters paint a different color from the base fill.
  document.documentElement.style.setProperty('--te-player-bg', theme === 'dark' ? '#14282b' : '#d0dadb');
  document.documentElement.style.setProperty('--te-app-bg', theme === 'dark' ? '#14282b' : '#d0dadb');
  document.documentElement.style.setProperty('--te-playback-page-text', light ? '#1a202c' : '#f4f7fb');
  canGoBack.value = true;
  titleProps.value = { immersive: true, menuOpen, glass: true, liquidMaterial: true, titleSurface: light ? 'settings' : 'streaming', streaming: true };
  await settle();
  expect(matchMedia('(prefers-reduced-transparency: reduce)').matches === (preference === 'reduced-transparency'), 'transparency preference was not emulated');
  expect(matchMedia('(prefers-contrast: more)').matches === (preference === 'more-contrast'), 'contrast preference was not emulated');
  const frame = document.querySelector('#title .title-bar');
  const expectedColor = light ? 'rgb(26, 32, 44)' : 'rgb(244, 247, 251)';
  expect([...frame.querySelectorAll('button')].every(element => getComputedStyle(element).color === expectedColor), 'caption controls lost playback contrast');
  expect(frame.querySelector('.back-btn') && frame.querySelector('.menu-btn') && frame.querySelector('.login-btn'), 'left playback commands disappeared');
  return expected;
};
window.checkForcedColorPlaybackCaption = async () => {
  await settle();
  expect(matchMedia('(forced-colors: active)').matches, 'forced colors were not emulated');
  const probe = document.createElement('div');
  probe.style.cssText = 'color:CanvasText;background:Canvas';
  document.body.append(probe);
  const frame = document.querySelector('#title .title-bar');
  expect(getComputedStyle(frame).backgroundColor === getComputedStyle(probe).backgroundColor, 'high contrast caption lost its system surface');
  expect([...frame.querySelectorAll('button')].every(element => getComputedStyle(element).color === getComputedStyle(probe).color), 'high contrast caption lost its system foreground');
  probe.remove();
};
window.finishPlaybackCaptionCases = () => {
  titleApp.unmount(); titleApp = null;
  document.querySelector('#playback-caption-backdrop').remove();
};
const timers = new Map();
let timerId = 0;
// Keep stage transitions advancing even when the test window is hidden.
window.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
window.cancelAnimationFrame = clearTimeout;
window.setInterval = (callback, interval) => { const id = ++timerId; timers.set(id, { callback, interval }); return id; };
window.clearInterval = id => timers.delete(id);
window.api = {
  plugins: { onChanged: listener => { changed = listener; } },
  providers: {
    list: async () => available,
    call: async (id, method, args) => {
      calls.push({ id, method, args });
      if (!available.some(provider => provider.id === id)) throw new Error('Provider ' + id + ' 未启用');
      const custom = handler?.(id, method, args);
      if (custom !== undefined) return custom;
      if (method === 'checkLogin') return { loggedIn: false, profile: null };
      if (method === 'getQrLogin') return { key: id + '-key', imageDataUrl: 'data:image/png;base64,fixture' };
      if (method === 'checkQrLogin') return { code: 801 };
    }
  },
  window: { minimize() {}, toggleMaximize() {}, close() {} }
};
window.fixtureRequire = id => {
  if (id === 'vue') return Vue;
  if (id === 'qrcode') return { default: { toDataURL: async () => 'fixture-qr' } };
  if (id.endsWith('.css')) return {};
  if (id.endsWith('/ServerLoginForm.vue')) return { default: window.ServerLoginForm };
  if (id.endsWith('/TitleBarIcon.vue')) return { default: window.TitleBarIcon };
  if (id.endsWith('/ThemeIcon.vue')) return { default: window.ThemeIcon };
  if (id.includes('shared/theme')) return { THEME_ICON_SLOT_REGISTRY: window.themeIconRegistry };
  if (id.includes('titleBarIconPaths')) return window.titleBarIconPaths;
  if (id.endsWith('.vue')) return { default: { render: () => h('span') } };
  if (id.includes('useProviderStore')) return window.providerStoreModule;
  if (id.includes('themeIconRuntime')) return { setThemeIconProfile() {}, observeMiniPlayerThemeIcons: () => () => {}, useThemeIconImage: () => ({ imageUrl: ref(''), customReady: ref(false), failed: ref(false), imageLoaded() {}, imageFailed() {} }) };
  if (id.includes('visibilityPolling')) return window.visibilityPolling;
  if (id.includes('mediaProvider')) return { toProviderIpcArgs: args => args };
  if (id.includes('useNcmStore')) return { useNcmStore: () => ({ isLoggedIn: loggedIn, profile, checkLogin: async () => { calls.push({ id: 'ncm', method: 'ncmCheckLogin' }); } }) };
  if (id.includes('useBackStack')) return { useBackHandler() {}, useBackStack: () => ({ canGoBack, backHint: ref(null) }) };
  if (id.includes('useWindowChrome')) return { useWindowChrome: () => ({ maximized: ref(false) }) };
  if (id.includes('useAppNoticeStore')) return { useAppNoticeStore: () => ({ unreadCount: ref(0), activeTaskCount: ref(0), doNotDisturb: ref(false) }) };
  throw new Error('Unexpected dependency: ' + id);
};
const store = () => window.providerStoreModule.useProviderStore();
const replaceProviders = async providers => { available = providers; changed(); await settle(); };
const mountLogin = async (providers, initialProviderId = 'ncm', forceProfile = false, custom) => {
  loginApp?.unmount();
  available = providers; handler = custom; calls = []; success = 0; configure = 0;
  await store().syncProviders();
  loginApp = createApp({ render: () => h(window.LoginPage, { initialProviderId, forceProfile, onLoginSuccess: () => success++, onConfigure: () => configure++ }) });
  loginApp.mount('#app'); await settle();
};
const text = () => document.querySelector('#app').textContent;
const qrPolls = () => [...timers.values()].filter(timer => timer.interval === 5000);
window.runProviderFallbackTests = async () => {
  // Stale persisted or caller-selected NCM defaults must only call enabled login providers.
  await mountLogin([searchOnly, bili]);
  expect(text().includes('登录 哔哩哔哩'), 'disabled initial NCM did not fall back: ' + text() + JSON.stringify(calls));
  expect(calls.every(call => call.id === 'bili'), 'disabled or non-login provider was called');
  expect(qrPolls().length === 1, 'fallback QR polling did not start');

  // Preserve explicit enabled targets and do not auto-switch when NCM is enabled later.
  await mountLogin([ncm, bili], 'bili');
  await replaceProviders([ncm, bili, server]);
  expect(text().includes('登录 哔哩哔哩'), 'enabled explicit provider was replaced');
  expect(!calls.some(call => call.id === 'ncm' && call.method === 'getQrLogin'), 'NCM QR started for an external account');

  // Runtime disable cancels polling and ignores a scan result already in flight.
  await mountLogin([ncm, bili]);
  let finishScan;
  handler = (id, method) => id === 'ncm' && method === 'checkQrLogin' ? new Promise(resolve => finishScan = resolve) : undefined;
  const oldScan = qrPolls()[0].callback();
  await replaceProviders([bili]);
  const afterDisable = calls.length;
  finishScan({ code: 803 }); await oldScan; await settle();
  expect(text().includes('登录 哔哩哔哩') && success === 0, 'disabled scan result changed the new login');
  expect(calls.slice(afterDisable).every(call => call.id !== 'ncm'), 'disabled provider was called after an old success');
  expect(qrPolls().length === 1, 'old poll survived provider removal');

  // A pending QR request must not replace the fallback or surface its old error.
  let failQr;
  await mountLogin([ncm, bili], 'ncm', false, (id, method) => id === 'ncm' && method === 'getQrLogin' ? new Promise((resolve, reject) => failQr = reject) : undefined);
  await replaceProviders([bili]);
  failQr(new Error('old NCM QR failure')); await settle();
  expect(text().includes('登录 哔哩哔哩') && !text().includes('old NCM QR failure'), 'late QR failure overwrote fallback');

  // No login provider is a useful empty state, and late registration refreshes its cards.
  await mountLogin([searchOnly]);
  expect(text().includes('暂无可用的登录平台') && calls.length === 0, 'empty providers produced an error or request');
  await replaceProviders([searchOnly, bili]);
  expect(text().includes('哔哩哔哩') && !text().includes('暂无可用'), 'new provider did not become selectable');
  document.querySelector('.provider-row').click(); await settle();
  expect(text().includes('登录 哔哩哔哩'), 'late provider card remained unavailable');
  await replaceProviders([]);
  expect(text().includes('暂无可用的登录平台') && qrPolls().length === 0, 'last provider disable did not stop login');

  // Server and settings providers must keep their own authentication flow.
  await mountLogin([server]);
  expect(text().includes('登录 Jellyfin') && !calls.some(call => call.method === 'getQrLogin'), 'server fallback started QR login');
  await mountLogin([settings]);
  expect(configure === 1 && !calls.some(call => call.method === 'getQrLogin'), 'settings fallback did not open configuration');

  // A disabled account request cannot keep the fallback server form busy or release its newer request.
  let failAccount, failServer;
  await mountLogin([ncm, server], 'ncm', false, (id, method) => {
    if (method === 'loginByPhonePassword') return new Promise((resolve, reject) => failAccount = reject);
    if (method === 'loginWithServer') return new Promise((resolve, reject) => failServer = reject);
  });
  [...document.querySelectorAll('.method-tab')].find(button => button.textContent.includes('密码登录')).click(); await settle();
  document.querySelector('.account-form').dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(typeof failAccount === 'function', 'account request did not start');
  await replaceProviders([server]);
  let serverButton = document.querySelector('.server-login-form button');
  expect(serverButton && !serverButton.disabled, 'old account kept fallback server form busy');
  const inputs = document.querySelectorAll('.server-login-form input');
  ['https://fixture.invalid', 'listener', 'password'].forEach((value, index) => { inputs[index].value = value; inputs[index].dispatchEvent(new Event('input', { bubbles: true })); });
  document.querySelector('.server-login-form').dispatchEvent(new Event('submit', { cancelable: true })); await settle();
  expect(typeof failServer === 'function' && serverButton.disabled, 'fallback server login did not start');
  failAccount(new Error('old account failure')); await settle();
  expect(serverButton.disabled && !text().includes('old account failure'), 'old request released or changed the new server login');
  failServer(new Error('server failure')); await settle();
  expect(!serverButton.disabled && text().includes('server failure'), 'current server failure did not release form');

  // Profile mode should choose an already connected alternative when its target is disabled.
  await mountLogin([bili, server], 'ncm', true, (id, method) => method === 'checkLogin' ? { loggedIn: id === 'jellyfin', profile: id === 'jellyfin' ? { userId: 42, nickname: '已连接账号' } : null } : undefined);
  expect(text().includes('已连接账号') && !calls.some(call => call.method === 'getQrLogin'), 'profile fallback ignored connected account');

  // Title bar target and label track plugin availability, ignoring cached NCM profiles.
  let selected;
  loggedIn.value = true; profile.value = { nickname: '旧网易云账号', avatarUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', userId: 1 };
  titleApp = createApp({ render: () => h(window.TitleBar, { menuOpen: false, preview: false, ...titleProps.value, onLogin: id => selected = id }) });
  titleApp.mount('#title'); await replaceProviders([searchOnly, bili]);
  let button = document.querySelector('#title .login-btn');
  expect(button.title === '哔哩哔哩登录' && !button.querySelector('img'), 'disabled NCM still shown in title bar');
  button.click(); expect(selected === 'bili', 'title bar selected disabled NCM');
  await replaceProviders([ncm, bili]); button.click();
  expect(selected === 'ncm' && button.title === '旧网易云账号', 'NCM account entry was not preserved');
  // Navigation, account and tools keep their positions across every main surface.
  const surfaces = [
    { streaming: false },
    { streaming: false, titleSurface: 'settings' },
    { streaming: true, titleSurface: 'streaming' },
    { glass: true },
    { immersive: true },
    { preview: true }
  ];
  for (const surface of surfaces) {
    titleProps.value = surface; await settle();
    button = document.querySelector('#title .login-btn');
    expect(button && button.getBoundingClientRect().width === 46, 'account entry disappeared on ' + JSON.stringify(surface));
    expect(document.querySelector('#title .menu-btn') && document.querySelector('#title .title-bar-tools .settings-btn') && document.querySelector('#title .title-bar-tools .plugins-btn'), 'persistent title commands disappeared');
    const frame = document.querySelector('#title .title-bar').getBoundingClientRect();
    const tools = document.querySelector('#title .title-bar-tools').getBoundingClientRect();
    expect(frame.height === 40 && tools.right > frame.width / 2, 'title height or right tool placement changed');
    button.click(); expect(selected === 'ncm', 'persistent account lost its enabled provider');
  }
  titleProps.value = { streaming: false }; await settle();

  // Check rendered symmetry and separate command/caption icon sizes in both color schemes.
  for (const theme of ['pureWhite', 'dark']) {
    document.documentElement.dataset.theme = theme;
    const bar = document.querySelector('#title .title-bar').getBoundingClientRect();
    const menu = document.querySelector('#title .menu-btn').getBoundingClientRect();
    const close = document.querySelector('#title .close').getBoundingClientRect();
    expect(!document.querySelector('#title .command-palette-trigger') && !document.querySelector('#title [data-icon="search"]'), 'title search entry remains');
    expect(document.querySelector('#title .title-bar-start').children.length === 2, 'left group contains tools or an empty search slot');
    for (const surface of ['default', 'settings', 'streaming']) for (const transparent of [false, true]) {
      titleProps.value = { titleSurface: surface }; await settle();
      document.documentElement.dataset.windowTransparent = transparent ? 'on' : 'off';
      document.documentElement.dataset.teSurfaceMaterial = transparent ? 'transparent' : 'theme';
      const material = getComputedStyle(document.querySelector('#title .title-bar-background'));
      expect(material.display !== 'none' && (material.backgroundColor === 'rgba(0, 0, 0, 0)') === transparent, 'title ignores transparent material preference: ' + theme + '/' + surface + '/' + transparent);
      expect(transparent ? material.backdropFilter === 'none' : material.backdropFilter.includes('blur(24px)'), 'title backdrop does not follow material preference: ' + theme + '/' + surface + '/' + transparent);
      expect(material.pointerEvents === 'none', 'material blocks title commands');
      if(theme === 'dark') expect(material.boxShadow === 'none' && material.backgroundImage === 'none', 'dark caption has a pale rim or wash');
    }
    titleProps.value = { streaming: false }; await settle();
    delete document.documentElement.dataset.windowTransparent;
    delete document.documentElement.dataset.teSurfaceMaterial;
    const normalColor = getComputedStyle(document.querySelector('#title .menu-btn')).color;
    const restingPositions = [...document.querySelectorAll('#title button')].map(element => element.getBoundingClientRect().left);
    for (const playerText of ['rgb(244, 247, 251)', 'rgb(20, 25, 32)']) for (const liquid of [false, true]) for (const preview of [false, true]) {
      document.documentElement.style.setProperty('--te-playback-page-text', playerText);
      titleProps.value = { immersive: true, liquidMaterial: liquid, preview }; await settle();
      const frame = document.querySelector('#title .title-bar');
      const layer = frame.querySelector('.title-bar-background');
      const material = layer && getComputedStyle(layer);
      expect(!frame.classList.contains('title-bar-liquid'), 'liquid material overrides immersive playback');
      expect(!material || (material.backgroundColor === 'rgba(0, 0, 0, 0)' && material.backgroundImage === 'none' && material.boxShadow === 'none' && material.backdropFilter === 'none'), 'playback caption still paints a separate strip: ' + theme + '/' + liquid + '/' + preview);
      expect(frame.getBoundingClientRect().height === 40, 'immersive title changed its height');
      expect([...frame.querySelectorAll('button')].every((element,index) => getComputedStyle(element).color === playerText && element.getBoundingClientRect().left === restingPositions[index]), 'immersive controls lost playback colors or moved: ' + JSON.stringify({theme,liquid,preview,playerText,controls:[...frame.querySelectorAll('button')].map((element,index)=>({name:element.className,color:getComputedStyle(element).color,left:element.getBoundingClientRect().left,expectedLeft:restingPositions[index]}))}));
      expect(!material || material.pointerEvents === 'none', 'immersive backdrop intercepts controls');
    }
    document.documentElement.style.removeProperty('--te-playback-page-text');
    titleProps.value = { streaming: false }; await settle();
    await new Promise(resolve => setTimeout(resolve, 350));
    const restoredMaterial = getComputedStyle(document.querySelector('#title .title-bar-background'));
    expect(restoredMaterial.backgroundColor !== 'rgba(0, 0, 0, 0)' && restoredMaterial.backdropFilter.includes('blur(24px)') && getComputedStyle(document.querySelector('#title .menu-btn')).color === normalColor, 'leaving playback did not restore normal chrome');
    expect(bar.height === 40 && menu.width === close.width && close.width === 46, 'caption geometry differs');
    expect(!document.querySelector('#title .title-bar-back'), 'root page keeps an empty return slot');
    expect(menu.left - bar.left === bar.right - close.right, 'outer margins differ');
    expect(menu.left + menu.width / 2 - bar.left === bar.right - close.left - close.width / 2, 'outer icon centers differ');
    expect(document.querySelector('#title .menu-btn .title-bar-icon').getBoundingClientRect().width === 18, 'left icon size did not grow');
    expect(document.querySelector('#title .settings-btn .title-bar-icon').getBoundingClientRect().width === 18, 'right application icon differs from left application icons');
    expect(document.querySelector('#title .close svg').getBoundingClientRect().width === 16, 'caption icon size changed');
    const controlPositions = [...document.querySelectorAll('#title .plugins-btn, #title .settings-btn, #title .notification-btn, #title .minimize, #title .maximize, #title .close')].map(element => element.getBoundingClientRect().left);
    const tools = document.querySelector('#title .title-bar-tools').getBoundingClientRect();
    const windows = document.querySelector('#title .title-bar-window-controls').getBoundingClientRect();
    expect(windows.left - tools.right >= 12, 'application tools crowd window controls');
    for (const layout of ['default', 'obsidian-glass', 'paper-light']) {
      document.documentElement.dataset.tePresetLayout = layout;
      await settle();
      const frame = document.querySelector('#title .title-bar').getBoundingClientRect();
      const icon = document.querySelector('#title .menu-btn .title-bar-icon').getBoundingClientRect();
      expect(frame.height === 40 && Math.abs(icon.top + icon.height / 2 - frame.top - frame.height / 2) < .6, 'theme changed title height or vertical alignment: ' + layout);
    }
    delete document.documentElement.dataset.tePresetLayout;
    const accountLeft = button.getBoundingClientRect().left;
    canGoBack.value = true; await settle();
    expect(button.getBoundingClientRect().left === accountLeft + 46 && document.querySelector('#title .back-btn'), 'return did not occupy one leading slot');
    expect(document.querySelector('#title .back-btn').getBoundingClientRect().left === document.querySelector('#title .title-bar').getBoundingClientRect().left, 'return is not fixed to the left edge');
    expect([...document.querySelectorAll('#title .plugins-btn, #title .settings-btn, #title .notification-btn, #title .minimize, #title .maximize, #title .close')].every((element, index) => element.getBoundingClientRect().left === controlPositions[index]), 'return shifted right controls');
    canGoBack.value = false; await settle();
    expect(!document.querySelector('#title .title-bar-back') && button.getBoundingClientRect().left === accountLeft, 'root page did not remove the return slot');
  }

  // A failed avatar must keep a usable fallback; a changed profile retries its image.
  let avatar = button.querySelector('img');
  expect(avatar && avatar.getBoundingClientRect().width === 18, 'connected avatar is missing');
  avatar.dispatchEvent(new Event('error')); await settle();
  expect(!button.querySelector('img') && button.querySelector('.title-bar-icon'), 'failed avatar lost its fallback');
  profile.value = { ...profile.value, userId: 2 }; await settle();
  expect(button.querySelector('img'), 'new profile did not retry avatar');
  loggedIn.value = false; await settle();
  expect(button.title === '网易云音乐登录' && !button.querySelector('img') && button.querySelector('.title-bar-icon'), 'logged-out account disappeared');
  await replaceProviders([searchOnly]); button.click();
  expect(selected === null && button.title === '流媒体登录', 'empty title bar selected an unavailable provider');
  titleApp.unmount(); titleApp = null;

  // Unmount during account refresh must not start QR polling or emit configuration.
  let finishCheck;
  await mountLogin([ncm], 'ncm', false, (id, method) => method === 'checkLogin' ? new Promise(resolve => finishCheck = resolve) : undefined);
  loginApp.unmount(); loginApp = null;
  const beforeUnmountedResult = calls.length;
  finishCheck({ loggedIn: false, profile: null }); await settle();
  expect(calls.length === beforeUnmountedResult && qrPolls().length === 0 && configure === 0, 'unmounted login resumed authentication');
  store().stopProviderHealthPolling();
  return 14;
};
`
