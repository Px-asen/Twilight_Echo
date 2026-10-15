import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileScript, compileStyle, parse } from '@vue/compiler-sfc'
import typescript from 'typescript'
import { pathToFileURL } from 'node:url'
import { THEME_ICON_SLOT_REGISTRY } from '../../../shared/theme.ts'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

// 这个用例在真实 Electron 窗口里挂载真实的 SFC，而不是用简化替身断言：
// 「设置 → 常规 → 开发者选项」的开关与插件页侧栏开关必须是同一个持久化设置，
// 且只有开启后插件页才出现「从文件夹安装（开发）」并以 'directory' 调用 IPC。
test('插件市场保持开发者安装、筛选更新反馈与自适应工作区', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-developer-mode-'))
  try {
    const themeIcon =
      (await compileComponent('./ThemeIcon.vue', 'ThemeIconComponent', 'market-icon')) +
      '\nwindow.ThemeIconComponent.__scopeId="data-v-market-icon";'
    const backgroundLayer = await compileComponent(
      './AppBackgroundLayer.vue',
      'BackgroundLayerComponent',
      'market-background'
    )
    const pluginPage = await compileComponent(
      './PluginPage.vue',
      'PluginPageComponent',
      'twilight-plugin-page-devmode'
    )
    const generalSection = await compileComponent(
      './settings-page/SystemSettingsSection.vue',
      'GeneralSectionComponent',
      'twilight-general-section-devmode'
    )
    const vueRuntime = await readFile(require.resolve('vue/dist/vue.global.prod.js'), 'utf8')
    const marketSearch = typescript.transpileModule(
      (await readFile(new URL('../utils/pluginMarketSearch.ts', import.meta.url), 'utf8')).replace(
        /^export /gm,
        ''
      ),
      { compilerOptions: { target: typescript.ScriptTarget.ES2022 } }
    ).outputText
    const htmlPath = join(directory, 'developer-mode.html')
    const runnerPath = join(directory, 'developer-mode-runner.cjs')
    const shellStyle = await Promise.all(
      [
        'base.css',
        'typography.css',
        'materials.css',
        'appearance.css',
        'bohr.css',
        'main.css',
        'overlay-sidebars.css'
      ].map((name) => readFile(new URL(`../assets/${name}`, import.meta.url), 'utf8'))
    )
    const { descriptor } = parse(
      await readFile(new URL('./PluginPage.vue', import.meta.url), 'utf8')
    )
    const pageStyle = descriptor.styles
      .map((style) => {
        const compiled = compileStyle({
          source: style.content,
          filename: 'PluginPage.vue',
          id: 'plugin-fixture',
          scoped: false
        })
        assert.deepEqual(compiled.errors, [])
        return compiled.code
      })
      .join('\n')
    const iconDescriptor = parse(
      await readFile(new URL('./ThemeIcon.vue', import.meta.url), 'utf8')
    ).descriptor
    const iconStyle = iconDescriptor.styles
      .map(
        (style) =>
          compileStyle({
            source: style.content,
            filename: 'ThemeIcon.vue',
            id: 'data-v-market-icon',
            scoped: true
          }).code
      )
      .join('\n')
    const iconFontStyle = (
      await Promise.all(
        ['regular', 'bold', 'fill'].map(async (family) => {
          const file = require.resolve('@phosphor-icons/web/' + family)
          return (await readFile(file, 'utf8')).replace(
            /url\((['"]?)(\.\/[^)'"\s]+)\1\)/g,
            (_match, _quote, relative) =>
              'url("' + new URL(relative, pathToFileURL(file)).href + '")'
          )
        })
      )
    ).join('\n')
    await writeFile(
      htmlPath,
      createFixture(
        vueRuntime,
        [themeIcon, backgroundLayer, pluginPage, generalSection],
        shellStyle.join('\n') + '\n' + pageStyle + '\n' + iconStyle + '\n' + iconFontStyle,
        marketSearch
      ),
      'utf8'
    )
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      timeout: 60_000,
      windowsHide: true
    })
    assert.match(stderr, /MARKET_LAYOUT_OK 120 scenarios/)
    assert.match(stderr, /DEVELOPER_MODE_OK/)
    assert.doesNotMatch(stderr, /DEVELOPER_MODE_FAILED/)
    context.diagnostic(stderr.match(/^MARKET_LAYOUT_OK.*$/m)?.[0] ?? '')
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

async function compileComponent(
  relativePath: string,
  globalName: string,
  id: string
): Promise<string> {
  const source = await readFile(new URL(relativePath, import.meta.url), 'utf8')
  const parsed = parse(source, { filename: relativePath })
  assert.equal(parsed.errors.length, 0, `SFC parse errors: ${parsed.errors.join(', ')}`)

  let compiled = compileScript(parsed.descriptor, { id, inlineTemplate: true }).content
  compiled = compiled.replace(
    /import\s+\{([^}]*)\}\s+from\s+['"]vue['"]\s*/g,
    (_match, bindings: string) => {
      const destructured = bindings.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')
      return `const {${destructured}} = Vue\n`
    }
  )
  compiled = compiled.replace(/import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"]\s*/g, '')
  compiled = compiled.replace(
    /import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]*shared\/theme\.ts['"]\s*/g,
    'const { THEME_ICON_SLOT_REGISTRY } = window.__iconRegistry\n'
  )
  compiled = compiled.replace(
    /import\s+ThemeIcon\s+from\s+['"][^'"]+\.vue['"]\s*/g,
    'const ThemeIcon = window.ThemeIconComponent\n'
  )
  // This fixture exercises built-in glyphs; custom-image loading has its own tests.
  compiled = compiled.replace(
    /import\s+\{\s*useThemeIconImage\s*\}\s+from\s+['"][^'"]*themeIconRuntime['"]\s*/g,
    'const useThemeIconImage = () => ({ imageUrl: Vue.ref(null), customReady: Vue.ref(false), failed: Vue.ref(false), imageLoaded() {}, imageFailed() {} })\n'
  )
  compiled = compiled.replace(
    /import\s+AppBackgroundLayer\s+from\s+['"][^'"]+\.vue['"]\s*/g,
    'const AppBackgroundLayer = window.BackgroundLayerComponent\n'
  )
  // Asset loading/fallback is covered by appBackground.behavior; this is a layout fixture.
  compiled = compiled.replace(
    /import\s+\{\s*mountBackgroundImageFallback\s*\}\s+from\s+['"][^'"]*backgroundImageFallback['"]\s*/g,
    'const mountBackgroundImageFallback = () => ({ refresh() {}, dispose() {} })\n'
  )
  compiled = compiled.replace(
    /import\s+\{\s*usePageDock\s*\}\s+from\s+['"][^'"]+['"]\s*/g,
    'const usePageDock = (_key, actions) => { window.__marketDock = actions }\n'
  )
  compiled = compiled.replace(
    /import\s+\{\s*useSettingsStore\s*\}\s+from\s+['"][^'"]+['"]\s*/g,
    'const useSettingsStore = window.__useSettingsStore\n'
  )
  compiled = compiled.replace(
    /import\s+(\w+)\s+from\s+['"][^'"]+\.vue['"]\s*/g,
    'const $1 = window.__stubComponent\n'
  )
  compiled = compiled.replace(
    /import\s+\{[\s\S]*?\}\s+from\s+['"]@renderer\/utils\/pluginTrustPresentation['"]\s*/g,
    'const { pluginIndexLoadedFromLabel, pluginIndexSourceLabel, presentPluginTrust } = window.__trustPresentation\n'
  )
  compiled = compiled.replace(
    /import\s+\{[\s\S]*?\}\s+from\s+['"]@renderer\/utils\/pluginTrustRefresh['"]\s*/g,
    'const { createPluginTrustRefreshController } = window.__trustRefresh\n'
  )
  compiled = compiled.replace(
    /import\s+\{[\s\S]*?\}\s+from\s+['"]@renderer\/utils\/pluginMarketSearch['"]\s*/g,
    'const { createPluginMarketIndex, searchPluginMarket } = window.__marketSearch\n'
  )
  // 语言选择器带进来的 i18n 依赖：这个 fixture 是纯脚本，没有模块解析，
  // 所以按既有范式换成 window 上的替身。本测试断言的是开发者模式贯通，
  // 语言选择器只需要能渲染出来、不炸。
  compiled = compiled.replace(
    /import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]*shared\/i18n\/locale\.ts['"]\s*/g,
    'const { APP_LOCALES, normalizeLanguagePreference } = window.__i18nLocale\n'
  )
  compiled = compiled.replace(
    /import\s+\{\s*useLocale\s*\}\s+from\s+['"][^'"]*app\/useLocale\.ts['"]\s*/g,
    'const useLocale = window.__useLocale\n'
  )
  assert.doesNotMatch(compiled, /^import\s/m, `${relativePath} fixture must not keep imports`)
  compiled = compiled.replace('export default', `window.${globalName} =`)
  const transpiled = typescript.transpileModule(compiled, {
    compilerOptions: { target: typescript.ScriptTarget.ES2022 }
  }).outputText
  // 每个组件都会声明自己的 Vue 渲染助手常量，两段脚本共享全局作用域会撞名，
  // 所以各自包进 IIFE，只把组件本身挂到 window 上。
  return `;(function () {\n${transpiled}\n})();`
}

function createFixture(
  vueRuntime: string,
  components: string[],
  style: string,
  marketSearch: string
): string {
  const componentScripts = components.map((component) => `<script>${component}</script>`).join('\n')
  return `<!doctype html>
<html><head><style>${style}
  :root { --te-window-content-top:44px; --te-window-content-bottom:4px; --te-window-surface-inset:4px; --te-window-inner-radius:8px; --te-playbar-bottom-clearance:100px; }
  #player-fixture { position:fixed; bottom:16px; left:80px; right:80px; height:80px; z-index:1002; }
</style></head><body>
  <div class="app-shell"><div class="app-shell-content"><div class="main-content"><div id="plugin-page"></div></div></div><button id="player-fixture">播放器</button></div>
  <div id="general-section"></div>
  <script>${vueRuntime}</script>
  <script>window.__iconRegistry = {THEME_ICON_SLOT_REGISTRY: ${JSON.stringify(THEME_ICON_SLOT_REGISTRY)}};</script>
  <script>${stubScript()}</script>
  <script>${marketSearch}\nwindow.__marketSearch = { createPluginMarketIndex, searchPluginMarket };</script>
  ${componentScripts}
  <script>${checksScript()}</script>
</body></html>`
}

function stubScript(): string {
  return (
    `
    const chooseAndInstallCalls = []
    const toggleCalls = []
    const pluginActions = []
    const patches = []
    const settings = Vue.ref({
      developerMode: false,
      libraryFolders: [],
      genreSeparators: '',
      watchLibrary: false,
      onlineLyricsFallback: false,
      autoCheckLogin: false,
      smtcEnabled: false,
      discordRpcEnabled: false,
      remoteControlEnabled: false,
      remoteControlPort: 0,
      launchAtLogin: false,
      closeWindowBehavior: 'quit',
      closeToTray: false,
      taskbarThumbarButtonsEnabled: false,
      miniPlayer: { showInTaskbar: false },
      trackActivationMode: 'singleClick',
      startupHomePage: 'local',
      language: 'system',
      proxyMode: 'auto',
      proxyHost: '',
      proxyPort: 0,
      proxyAllowDirectFallback: false
    })
    async function updateSettings(patch) {
      patches.push(patch)
      if (window.__marketControls?.devGate) await window.__marketControls.devGate
      settings.value = Object.assign({}, settings.value, patch)
      return settings.value
    }
    window.__store = { settings, updateSettings, patches, toggleCalls, chooseAndInstallCalls, pluginActions }
    window.__failedPlugin = {
      id: 'com.example.failed-tool', name: '失败的后台工具', version: '1.0.0',
      type: ['tool'], author: 'Fixture', description: '', builtIn: true,
      enabled: false, requestedEnabled: true, status: 'failed', error: 'activation failed'
    }
    window.__useSettingsStore = () => ({ settings, updateSettings })
    window.__stubComponent = { name: 'FixtureStub', props: ['id', 'title'], template: '<details :id="id" class="fixture-stub"><summary>{{ title }}</summary><slot /></details>' }
    // i18n 替身：t() 回显 key，语言选择器因此能渲染且断言仍只看结构。
    window.__i18nLocale = {
      APP_LOCALES: ['zh-CN', 'en-US'],
      normalizeLanguagePreference: (value) =>
        value === 'zh-CN' || value === 'en-US' ? value : 'system'
    }
    window.__useLocale = () => ({
      locale: Vue.computed(() => 'zh-CN'),
      t: (key) => key,
      errorText: (_error, fallbackKey) => fallbackKey || '',
      errorDetail: (_error, fallbackKey) => ({
        display: fallbackKey || '',
        code: null,
        developerMessage: '',
        params: {}
      })
    })
  ` + stubApiScript()
  )
}

function stubApiScript(): string {
  return `
    window.__trustPresentation = {
      pluginIndexSourceLabel: () => '固定索引',
      pluginIndexLoadedFromLabel: () => '本地快照',
      presentPluginTrust: () => ({ label: '索引声明', icon: 'pi pi-info-circle', tone: 'declared', official: false, detail: '发布者仅由目录声明\\n签名状态：missing\\n公钥 SHA-256：无' })
    }
    window.__trustRefresh = {
      createPluginTrustRefreshController: () => ({
        schedule() {},
        stop() {},
        refreshNow: async () => {}
      })
    }
    window.__marketEntry={id:'com.example.provider',name:'示例音源',author:'Fixture',version:'1.0.0',type:['provider','ui'],tags:['provider'],description:'搜索和播放音乐，浏览收藏的专辑与歌单。',installState:'not-installed',repository:'https://github.com/example/plugin',verification:{level:'index-declared',official:false,officialSource:true,indexClaimed:true,signatureStatus:'missing',keyId:null,keyFingerprintSha256:null,revalidateAt:null,reason:'发布者仅由目录声明'}}
    window.__marketControls = { entries: null, installed: null, indexError: '', indexGate: null, installGate: null, localGate: null, devGate: null, installCalls: [] }
    const readFixtureIndex = async () => {
      const controls = window.__marketControls
      if (controls.indexGate) await controls.indexGate
      if (controls.indexError) throw new Error(controls.indexError)
      return controls.entries ?? [{...window.__marketEntry},{...window.__marketEntry,id:'com.example.theme',name:'示例主题',type:['theme'],tags:['theme'],installState:'update-available',installedVersion:'0.9.0'}]
    }
    window.api = {
      plugins: {
        list: async () => window.__marketControls.installed ?? [{ ...window.__failedPlugin }],
        listIndex: readFixtureIndex,
        refreshIndex: readFixtureIndex,
        getIndexStatus: async () => ({sourceUrl:'https://example.com/plugins.json',configuredSourceUrl:'https://example.com/plugins.json',loadedFrom:'cache',lastFetchedAt:'2026-10-14T00:00:00Z',expiresAt:'2026-10-15T00:00:00Z',stale:true,expired:false,originVerified:true,officialSource:false,trustStoreError:null,error:null}),
        installFromIndex: async (id) => {
          window.__marketControls.installCalls.push(id)
          if (window.__marketControls.installGate) await window.__marketControls.installGate
          return null
        },
        enable: async () => { pluginActions.push('enable'); return {} },
        disable: async () => {
          pluginActions.push('disable')
          window.__failedPlugin.requestedEnabled = false
          window.__failedPlugin.status = 'disabled'
          window.__failedPlugin.error = null
          return { ...window.__failedPlugin }
        },
        uninstall: async () => {},
        openLog: async () => {},
        getLog: async () => '',
        chooseAndInstall: async (kind) => {
          chooseAndInstallCalls.push(kind)
          if (window.__marketControls.localGate) await window.__marketControls.localGate
          return null
        },
        onChanged: () => () => {}
      }
    }
  `
}

function checksScript(): string {
  return (
    `
    const { createApp, h, nextTick } = Vue
    const store = window.__store
    const tick = () => nextTick().then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    const generalProps = {
      libraryWatcherStatus: null,
      libraryScanStatus: { state: 'idle', current: 0, total: 0 },
      libraryScanIsActive: false,
      libraryScanProgressText: '',
      libraryMetadataEnrichmentText: '',
      libraryMetadataEnrichmentIsActive: false,
      libraryResetMessage: '',
      libraryScanCommandError: '',
      libraryResetPending: false,
      pluginSettingsPanels: [],
      pluginSettingsResult: {},
      pluginSettingsError: {},
      pluginSettingsForms: {},
      pluginSettingsValues: {},
      runningPluginSettingsCommand: '',
      pluginPanelStateKey: () => 'panel',
      trackActivationModeOptions: [{ value: 'singleClick', label: '单击播放', icon: 'pi pi-bolt' }],
      startupHomePageOptions: [{ value: 'local', label: '本地音乐主页', icon: 'pi pi-home' }],
      updateSettings: store.updateSettings,
      addLibraryFolder: () => {},
      removeLibraryFolder: () => {},
      // 与 SettingsPage.toggleSetting 同构：翻转当前布尔值后走 updateSettings。
      toggleSetting: (key) => {
        store.toggleCalls.push(key)
        void store.updateSettings({ [key]: !store.settings.value[key] })
      },
      setGenreSeparators: () => {},
      setTrackActivationMode: () => {},
      setStartupHomePage: () => {},
      setCloseBehavior: () => {},
      watcherStateLabel: () => '',
      watcherModeLabel: () => '',
      formatWatcherTime: () => '',
      runFullLibraryScan: () => {},
      pauseActiveLibraryScan: () => {},
      resumeActiveLibraryScan: () => {},
      cancelActiveLibraryScan: () => {},
      resetLocalLibrary: () => {},
      cancelActiveLibraryMetadataEnrichment: () => {},
      exportSettingsBackup: () => {},
      importSettingsBackup: () => {},
      resetSettingsGroup: () => {},
      runPluginSettingsPanel: () => {},
      setPluginSettingsField: () => {},
      submitPluginSettingsForm: () => {}
    }
  ` + checksRunnerScript()
  )
}

function checksRunnerScript(): string {
  return `
    const settingRow = (label) =>
      [...document.querySelectorAll('#general-section .setting-item')].find(
        (item) => item.querySelector('strong') && item.querySelector('strong').textContent.trim() === label
      )
    const installButtons = () => [...document.querySelectorAll('#plugin-page .top-actions button')]
    const folderButton = () => installButtons().find((button) => button.textContent.includes('从文件夹安装'))
    const packageButton = () => installButtons().find((button) => button.textContent.includes('安装本地插件'))
    const fail = (message) => { throw new Error(message) }

    window.runDeveloperModeChecks = async () => {
      const checks = []
      createApp({ render: () => h(window.PluginPageComponent) }).mount('#plugin-page')
      createApp({ render: () => h(window.GeneralSectionComponent, generalProps) }).mount('#general-section')
      await tick()

      window.checkPluginShellLayout = () => {
        const page = document.querySelector('.plugin-page'), pageBox = page.getBoundingClientRect(), header = document.querySelector('.plugin-page-header').getBoundingClientRect();
        const search = document.querySelector('.search-box').getBoundingClientRect(), scroll = document.querySelector('.scroll-area'), scrollBox = scroll.getBoundingClientRect();
        const scroller = document.querySelector('.plugin-window');
        if (getComputedStyle(page).position !== 'relative' || pageBox.top < 40 || pageBox.bottom > innerHeight) fail('插件市场没有留在主窗口内容框架内');
        if (search.top < header.bottom || search.top > header.bottom + 32 || search.bottom >= scrollBox.top + 1) fail('搜索栏受主内容样式影响，无法保持在分类下方');
        if (getComputedStyle(scroller).overflowY !== 'auto' || parseFloat(getComputedStyle(scroller).paddingBottom) < 100 || getComputedStyle(scroll).overflowY === 'auto') fail('插件市场必须用单一工作区滚动并保留播放栏尾部空间');
        const player = document.querySelector('#player-fixture').getBoundingClientRect();
        if (document.elementFromPoint(player.left+player.width/2, player.top+player.height/2)?.id !== 'player-fixture') fail('插件页遮挡播放控件');
        if (!document.querySelector('.search-box input').getAttribute('aria-label') || document.querySelector('.nav-item').tagName !== 'BUTTON') fail('插件页分类和搜索缺少键盘或读屏入口');
      }
      window.checkPluginVisualTone = async () => {
        for (const size of [14, 18, 28]) {
          document.documentElement.style.setProperty('--te-font-size-body', size + 'px');await tick();
          const page = document.querySelector('.plugin-page'), family = getComputedStyle(page).fontFamily;
          for (const [selector, expected] of [['.plugin-heading h1',size*2],['.nav-item',size*15/14],['.search-box input',size*15/14]]) {
            const element=page.querySelector(selector), style=getComputedStyle(element), box=element.getBoundingClientRect();
            if(Math.abs(parseFloat(style.fontSize)-expected)>.1||style.fontFamily!==family)fail('插件文字没有遵循统一字号：'+selector+'/'+size);
            if(box.left<0||box.right>innerWidth+1||box.height<parseFloat(style.fontSize))fail('插件文字放大后控件被裁切：'+selector+'/'+size);
          }
        }
        document.documentElement.style.removeProperty('--te-font-size-body');
        const root = document.documentElement;
        root.style.setProperty('--te-settings-bg-image', 'linear-gradient(90deg, #654321, #123456)');
        root.style.setProperty('--te-settings-background-blur', '8px');
        root.dataset.teSettingsCustomBackground = 'on';
        await tick();
        const background = document.querySelector('.plugin-page > .app-background-layer[data-background-page="settings"]');
        if (!background || getComputedStyle(background).display === 'none') fail('独立插件市场丢失设置背景层');
        const image = background.querySelector('.app-background-image');
        if (getComputedStyle(image).backgroundImage === 'none' || !getComputedStyle(image).filter.includes('blur(8px)')) fail('插件市场没有复用背景图片及模糊参数');
        const windowSurface = document.querySelector('.plugin-window');
        if (getComputedStyle(background).pointerEvents !== 'none' || Number(getComputedStyle(background).zIndex) >= Number(getComputedStyle(windowSurface).zIndex) || getComputedStyle(windowSurface).filter !== 'none') fail('插件背景层影响前景命中或清晰度');
        document.documentElement.style.setProperty('--te-app-bg-image', 'linear-gradient(90deg, #654321, #123456)');
        for (const tone of ['pureWhite', 'dark']) {
          document.documentElement.dataset.theme = tone;
          // Inspect the final text palette independently of a hidden window's
          // throttled transition timeline. Motion is covered by its own tests.
          for (const item of document.querySelectorAll('.nav-item')) item.style.transition = 'none';
          for (const ink of ['dark', 'light']) {
            root.dataset.teSettingsTextTone = ink;
            root.style.setProperty('--te-settings-background-text', ink === 'dark' ? '#172033' : '#f4f6fa');
            root.style.setProperty('--te-settings-background-muted', ink === 'dark' ? '#475569' : '#cbd5e1');
            document.querySelectorAll('.nav-item')[1].click();await tick();
            for (const selector of ['.plugin-heading h1', '.page-title', '.plugin-name', '.plugin-author', '.plugin-desc', '.nav-item']) {
              const nodes = document.querySelectorAll(selector);
              if (!nodes.length) fail('背景文字检查缺少实际市场内容：' + selector);
              for (const node of nodes) {
                const channels = getComputedStyle(node).color.match(/[\\d.]+/g).slice(0,3).map(Number);
                if (ink === 'dark' ? channels.some(value => value > 110) : channels.some(value => value < 190)) fail('插件文字没有遵循独立背景文字颜色：' + tone + '/' + ink + '/' + selector + '/' + getComputedStyle(node).color);
              }
            }
          }
          delete root.dataset.teSettingsTextTone;
          root.style.removeProperty('--te-settings-background-text');
          root.style.removeProperty('--te-settings-background-muted');
          for (const item of document.querySelectorAll('.nav-item')) item.style.removeProperty('transition');
          for (const tab of [0, 1, 2]) {
            document.querySelectorAll('.nav-item')[tab].click();await tick();
            window.checkPluginShellLayout();
            for (const surface of document.querySelectorAll('.plugin-page, .plugin-window, .plugin-main, .topbar')) {
              if (getComputedStyle(surface).backgroundImage !== 'none') fail('插件市场重复绘制窗口背景：' + tone);
            }
            const banner = document.querySelector('.discover-banner');
            if (banner && (getComputedStyle(banner).backgroundImage !== 'none' || getComputedStyle(banner).backgroundColor !== 'rgba(0, 0, 0, 0)')) fail('深浅主题重新引入装饰性市场横幅：' + tone);
            for (const card of document.querySelectorAll('.plugin-card')) {
              if (getComputedStyle(card).boxShadow !== 'none') fail('插件条目重新出现重复阴影：' + tone);
            }
            if(tab === 1){
              const classifications=[...document.querySelectorAll('.market-classification')];
              if(classifications.length!==6||document.querySelector('.dev-mode-toggle'))fail('发现页重新堆放重复分类或开发者设置');
              const filters=document.querySelector('.market-filters');
              if(filters.open)fail('额外筛选没有默认折叠');
              filters.querySelector('summary').click();await tick();
              const tagFilter=filters.querySelector('[aria-label="插件标签"]');
              if(!tagFilter||!filters.querySelector('[aria-label="插件开发者"]')||tagFilter.getBoundingClientRect().height<=0)fail('折叠筛选丢失标签或开发者控件');
              tagFilter.value='provider';tagFilter.dispatchEvent(new Event('change',{bubbles:true}));await tick();
              if(!filters.querySelector('summary').textContent.includes('1'))fail('收起筛选后无法识别当前标签状态');
              filters.querySelector('.market-filter-reset').click();await tick();
              filters.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();
              if(filters.open||tagFilter.value!=='')fail('筛选无法清除或用 Escape 收起');
              const all=classifications.find(button=>button.textContent.trim()==='全部'),tool=classifications.find(button=>button.textContent.trim()==='工具');
              tool.click();await tick();
              if(tool.getAttribute('aria-pressed')!=='true'||all.getAttribute('aria-pressed')!=='false')fail('插件分类切换没有更新选中状态');
              const selectedFill=getComputedStyle(tool).backgroundColor,unselectedFill=getComputedStyle(all).backgroundColor;
              if(selectedFill===unselectedFill||selectedFill==='rgba(0, 0, 0, 0)')fail('插件标签选中状态没有在主题中显现：'+tone);
              all.click();await tick();
              const source=document.querySelector('.market-source'),detail=document.querySelector('.plugin-details');
              if(!source||source.open||!detail||detail.open)fail('目录来源和插件信息没有按需展开');
              const card=document.querySelector('.plugin-card--catalog'),box=card.getBoundingClientRect();
              if(box.height>320||getComputedStyle(card).backgroundImage!=='none'||getComputedStyle(card).backgroundColor!=='rgba(0, 0, 0, 0)')fail('发现条目超出文字预算或重新出现独立背景材质');
              source.querySelector('summary').click();await tick();
              if(!source.open||source.querySelector('.source-url').getBoundingClientRect().height<=0)fail('来源信息展开后丢失目录 URL');
              source.querySelector('summary').click();detail.querySelector('summary').click();await tick();
              if(!detail.open||!detail.querySelector('.signature-evidence').textContent.trim())fail('插件详情丢失签名与来源证据');
              detail.querySelector('summary').click();
              for(const family of ['outline','rounded','filled']){
                document.documentElement.dataset.teIconFamily=family;await tick();
                const glyphs=[...card.querySelectorAll('.theme-icon-glyph')].filter(icon=>getComputedStyle(icon).display!=='none');
                if(glyphs.length!==1||!glyphs[0].classList.contains('theme-icon-family-'+family))fail('插件图标没有使用统一的图标系列');
                const glyphStyle=getComputedStyle(glyphs[0]);await document.fonts.load(glyphStyle.fontSize+' '+glyphStyle.fontFamily);
                if(!document.fonts.check(glyphStyle.fontSize+' '+glyphStyle.fontFamily)||!glyphStyle.fontFamily.includes('Phosphor'))fail('插件图标字体没有实际加载');
              }
            }
          }
        }
      }

      const row = settingRow('开发者模式')
      if (!row) fail('设置页「常规」缺少开发者模式设置项')
      const settingsSwitch = row.querySelector('[role="switch"]')
      if (!settingsSwitch) fail('开发者模式设置项没有渲染 switch 控件')
      const pluginSwitch = document.querySelector('#plugin-page .dev-mode-toggle [role="switch"]')
      if (!pluginSwitch) fail('插件页侧栏缺少开发者模式开关')
      if (settingsSwitch.getAttribute('aria-checked') !== 'false') fail('开发者模式默认应为关闭')
      if (!settingsSwitch.classList.contains('inactive')) fail('关闭态缺少 inactive 样式')
      if (pluginSwitch.getAttribute('aria-checked') !== 'false') fail('插件页开关默认应为关闭')
      if (folderButton()) fail('未开启开发者模式时不应出现目录安装入口')
      if (!packageButton()) fail('已安装页缺少 .tep 安装入口')
      checks.push('default-off')

      settingsSwitch.click()
      await tick()
      if (store.toggleCalls[0] !== 'developerMode') fail('设置开关未调用 toggleSetting(developerMode)')
      if (store.settings.value.developerMode !== true) fail('设置开关未写入 developerMode: true')
      if (settingsSwitch.getAttribute('aria-checked') !== 'true') fail('设置开关未反映开启状态')
      if (!settingsSwitch.classList.contains('active')) fail('开启态缺少 active 样式')
      if (pluginSwitch.getAttribute('aria-checked') !== 'true') fail('插件页开关未跟随设置页')
      if (!folderButton()) fail('开启开发者模式后插件页未出现目录安装入口')
      checks.push('settings-unlocks-plugin-page')

      folderButton().click()
      await tick()
      packageButton().click()
      await tick()
      const calls = JSON.stringify(store.chooseAndInstallCalls)
      if (calls !== JSON.stringify(['directory', 'package'])) fail('安装入口传入的来源类型不对：' + calls)
      checks.push('ipc-source-kinds')

      pluginSwitch.click()
      await tick()
      if (store.settings.value.developerMode !== false) fail('插件页开关未写回 developerMode: false')
      if (folderButton()) fail('关闭开发者模式后目录安装入口未隐藏')
      if (settingsSwitch.getAttribute('aria-checked') !== 'false') fail('设置页开关未跟随插件页')
      checks.push('plugin-page-writes-back')

      const failedSwitch = document.querySelector('#plugin-page .plugin-card [role="switch"]')
      if (!failedSwitch || failedSwitch.getAttribute('aria-checked') !== 'true')
        fail('失败插件的开关必须保留启用意愿')
      if(failedSwitch.tagName!=='BUTTON'||failedSwitch.getBoundingClientRect().height<28)fail('插件开关没有使用键盘可用的标准按钮或足够的点击区域')
      if (!failedSwitch.textContent.includes('启动失败')) fail('失败插件没有显示失败状态')
      failedSwitch.click()
      await tick()
      if (JSON.stringify(store.pluginActions) !== JSON.stringify(['disable']))
        fail('点击失败插件开关必须停用，不能再次尝试启用')
      if (failedSwitch.getAttribute('aria-checked') !== 'false' || !failedSwitch.textContent.includes('已停用'))
        fail('失败插件停用后未刷新开关状态')
      checks.push('failed-plugin-can-disable-retry')
      return checks.join(',')
    }

    const marketControls = window.__marketControls
    const marketEntries = (count) => Array.from({length:count},(_,index)=>({
      ...window.__marketEntry,id:'com.example.market.'+index,
      name:'插件 '+String(index+1).padStart(2,'0')+' · 用于检查完整名称与中英文混排的扩展',
      author:index%2?'第二位开发者':'Fixture',
      description:'浏览并整理音乐收藏，保留来源、安装状态和详细说明。Music tools for your library.',
      type:[index%2?'tool':'provider'],tags:[index%2?'tool':'provider']
    }))
    const refreshFixtureMarket = async () => { await window.__marketDock()[0].run();await tick() }
    const selectMarketView = async (index) => {
      document.querySelectorAll('.nav-item')[index].click();await tick();
      document.querySelector('.plugin-window').scrollTop=0;await tick()
    }
    const searchMarket = async (value) => {
      const input=document.querySelector('.search-box input');input.value=value;
      input.dispatchEvent(new Event('input',{bubbles:true}));await tick()
    }
    window.runMarketStateChecks = async () => {
      const fail=(message)=>{throw new Error(message)}
      await selectMarketView(1)
      marketControls.entries=marketEntries(50);await refreshFixtureMarket()
      if(document.querySelectorAll('.plugin-card').length!==40)fail('市场分页没有保留首批40项')
      document.querySelector('.market-load-more').click();await tick()
      if(document.querySelectorAll('.plugin-card').length!==50)fail('加载更多丢失末项')
      await searchMarket('not-in-this-fixture')
      const empty=document.querySelector('.empty-state')
      if(!empty||empty.getAttribute('role')!=='status'||!empty.textContent.includes('没有匹配'))fail('搜索空结果缺少明确状态')
      empty.querySelector('button').click();await tick()
      if(document.querySelectorAll('.plugin-card').length!==40||document.activeElement!==document.querySelector('.search-box input'))fail('清除搜索和筛选没有恢复列表及搜索焦点')

      marketControls.entries=marketEntries(3).map((entry)=>({...entry,installState:'update-available',installedVersion:'0.9.0'}))
      await refreshFixtureMarket();await selectMarketView(2);await searchMarket('插件 02')
      if(document.querySelectorAll('.plugin-card').length!==1||!document.querySelector('.updates-summary').textContent.includes('3 个插件可更新'))fail('更新搜索未筛选或丢失全部更新的操作范围')
      let finishInstall
      marketControls.installGate=new Promise((resolve)=>{finishInstall=resolve})
      marketControls.installCalls.length=0
      const all=document.querySelector('.updates-summary button');all.click();await tick();all.click();await tick()
      if(!all.disabled||all.getAttribute('aria-busy')!=='true'||!all.textContent.includes('正在更新')||[...document.querySelectorAll('.plugin-card button')].some(button=>!button.disabled))fail('全部更新没有保持忙碌反馈或防止重复操作')
      finishInstall();marketControls.installGate=null
      for(let index=0;index<12&&all.disabled;index++)await tick()
      if(marketControls.installCalls.length!==3||new Set(marketControls.installCalls).size!==3)fail('全部更新漏项或重复安装')
      await searchMarket('not-in-this-fixture')
      if(!document.querySelector('.empty-state').textContent.includes('没有匹配的更新')||document.querySelector('.empty-state').textContent.includes('均为最新'))fail('搜索无更新误报为所有插件最新')
      document.querySelector('.search-clear').click();await tick()
      if(document.querySelectorAll('.plugin-card').length!==3)fail('更新搜索清除没有恢复')

      let finishIndex
      marketControls.entries=[]
      marketControls.indexGate=new Promise((resolve)=>{finishIndex=resolve})
      const pendingRefresh=window.__marketDock()[0].run();await tick()
      if(!document.querySelector('.page-status[role="status"]')||document.querySelector('.empty-state'))fail('加载时错误呈现空或最新状态')
      finishIndex();marketControls.indexGate=null;await pendingRefresh;await tick()
      if(!document.querySelector('.empty-state').textContent.includes('均为最新'))fail('加载完成后没有显示最新状态')
      marketControls.indexError='controlled offline failure';await refreshFixtureMarket()
      const alert=document.querySelector('.page-notice[role="alert"]')
      if(!alert||!alert.textContent.includes('controlled offline')||document.querySelector('.empty-state'))fail('加载错误未保留原因与恢复入口，或误报空状态')
      marketControls.indexError='';alert.querySelector('button').click();await tick();await tick()
      if(document.querySelector('.page-notice--error'))fail('错误重试没有恢复')

      await selectMarketView(0)
      marketControls.installed=[{...window.__failedPlugin,builtIn:false}]
      await refreshFixtureMarket()
      if([...document.querySelectorAll('.plugin-actions .icon-btn')].some(button=>!button.getAttribute('aria-label')))fail('插件日志或卸载缺少可访问名称')
      let finishLocal
      marketControls.localGate=new Promise((resolve)=>{finishLocal=resolve})
      const packageButton=document.querySelector('.top-actions button'),before=store.chooseAndInstallCalls.length
      packageButton.click();await tick();packageButton.click();await tick()
      if(!packageButton.disabled||packageButton.getAttribute('aria-busy')!=='true'||store.chooseAndInstallCalls.length!==before+1)fail('本地安装没有忙碌保护')
      finishLocal();marketControls.localGate=null;await tick();await tick()
      let finishDev
      marketControls.devGate=new Promise((resolve)=>{finishDev=resolve})
      const toggle=document.querySelector('.dev-mode-toggle button'),patchesBefore=store.patches.length
      toggle.click();await tick();toggle.click();await tick()
      if(!toggle.disabled||toggle.getAttribute('aria-busy')!=='true'||store.patches.length!==patchesBefore+1)fail('开发者模式保存期间没有锁定重复切换')
      finishDev();marketControls.devGate=null;await tick();await tick()
      marketControls.installed=null;marketControls.entries=null
      return 'pagination,filtered-updates,bulk-update-busy,loading-empty-error,retry,local-install-busy,developer-save-busy'
    }
    window.checkMarketResponsiveLayout = async (fontSize, theme) => {
      const fail=(message)=>{throw new Error(message+' ['+innerWidth+'x'+innerHeight+'/'+fontSize+'/'+theme+']')}
      document.documentElement.dataset.theme=theme
      document.documentElement.style.setProperty('--te-font-size-body',fontSize+'px')
      // Hidden Chromium windows can suspend animation frames. Flush Vue and let
      // resize/scroll events settle before taking the same real layout readings.
      const layoutTick=async()=>{await tick();await new Promise(resolve=>setTimeout(resolve,24));document.body.getBoundingClientRect()}
      await layoutTick()
      for(const tab of [0,1,2]){
        await selectMarketView(tab);await searchMarket('')
        for(const count of [1,2,6,48]){
          marketControls.entries=marketEntries(count).map(entry=>({...entry,installState:tab===2?'update-available':'not-installed'}))
          marketControls.installed=marketEntries(count).map(entry=>({...entry,enabled:false,requestedEnabled:false,status:'disabled',builtIn:false}))
          await refreshFixtureMarket()
          const page=document.querySelector('.plugin-page'),scroller=page.querySelector('.plugin-window'),grid=page.querySelector('.plugin-grid')
          scroller.scrollTop=0;await layoutTick()
          window.checkPluginShellLayout()
          if(scroller.scrollWidth>scroller.clientWidth+1)fail('工作区横向溢出')
          const cards=[...grid.querySelectorAll('.plugin-card')],boxes=cards.map(card=>card.getBoundingClientRect()),first=boxes[0]
          const row=boxes.filter(box=>Math.abs(box.top-first.top)<1),available=grid.parentElement.getBoundingClientRect().width
          const target=Math.min(available,count*560+(count-1)*24),span=row.at(-1).right-first.left
          if(row.some(box=>box.width>560.5||box.width<Math.min(320,available)-.5||Math.abs(box.width-first.width)>.5))fail('条目宽度越界或同排宽度不统一')
          for(let index=1;index<row.length;index++)if(Math.abs(row[index].left-row[index-1].right-24)>1)fail('稀疏网格产生无效大列隙')
          if((row.length>1||target<=560)&&span/target<.97)fail('可满足范围的完整行未利用可用空间')
          if(Math.abs(page.querySelector('.plugin-heading h1').getBoundingClientRect().left-first.left)>1||Math.abs(page.querySelector('.search-box').getBoundingClientRect().left-first.left)>1)fail('标题、搜索和安装项未共享内容边界')
          const classifications=page.querySelector('.market-classifications')
          if(classifications&&Math.abs(classifications.getBoundingClientRect().left-first.left)>1)fail('分类条多余缩进')
          for(const card of cards){
            const style=getComputedStyle(card)
            if(card.scrollWidth>card.clientWidth+1||style.boxShadow!=='none'||style.backdropFilter!=='none'||style.backgroundImage!=='none')fail('卡片内容溢出或引入独立装饰材质')
            if(parseFloat(style.paddingInlineStart)<12||parseFloat(style.paddingInlineEnd)<12||parseFloat(style.borderRadius)<8)fail('材质卡片缺少文字留白或圆角')
            const name=card.querySelector('.plugin-name')
            if(!name.title||name.title!==name.textContent.trim())fail('截断插件名缺少完整名称')
          }
          for(const button of page.querySelectorAll('.btn'))if(parseFloat(getComputedStyle(button).borderRadius)>16)fail('普通工具重新使用大胶囊')
          scroller.scrollTo({top:scroller.scrollHeight,behavior:'instant'});await layoutTick()
          const player=document.querySelector('#player-fixture').getBoundingClientRect(),last=cards.at(-1).getBoundingClientRect()
          if(last.bottom>player.top-8||last.bottom>scroller.getBoundingClientRect().bottom-24)fail('末项被播放器覆盖或缺少底部安全区 '+JSON.stringify({tab,count,last:last.bottom,player:player.top,scroller:scroller.getBoundingClientRect().bottom,scrollTop:scroller.scrollTop,scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight,padding:getComputedStyle(scroller).paddingBottom,behavior:getComputedStyle(scroller).scrollBehavior}))
        }
      }
      document.documentElement.style.removeProperty('--te-font-size-body')
      marketControls.installed=null;marketControls.entries=null
    }
  `
}

function electronRunnerSource(): string {
  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false }
  })
  window.webContents.on('console-message', (details) => {
    if (details && details.message) console.error('RENDERER ' + details.message)
  })
  try {
    await window.loadFile(path.resolve(target))
    const result = await window.webContents.executeJavaScript('window.runDeveloperModeChecks()')
    for (const width of [1360, 960, 640]) {
      window.setContentSize(width, 800)
      await window.webContents.executeJavaScript('window.checkPluginShellLayout()')
      await window.webContents.executeJavaScript('window.checkPluginVisualTone()')
    }
    const states = await window.webContents.executeJavaScript('window.runMarketStateChecks()')
    for (const [width,height,fontSize] of [[1366,800,14],[1499,800,20],[960,600,28],[640,600,28],[480,600,28]]) {
      window.setContentSize(width,height)
      for(const theme of ['pureWhite','dark']) {
        await window.webContents.executeJavaScript('window.checkMarketResponsiveLayout('+fontSize+',"'+theme+'")')
      }
    }
    console.error('MARKET_LAYOUT_OK 120 scenarios; '+states)
    console.error('DEVELOPER_MODE_OK ' + result)
    app.exit(0)
  } catch (error) {
    console.error('DEVELOPER_MODE_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
