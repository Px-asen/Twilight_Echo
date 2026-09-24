import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import typescript from 'typescript'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)

// 这个用例在真实 Electron 窗口里挂载真实的 SFC，而不是用简化替身断言：
// 「设置 → 常规 → 开发者选项」的开关与插件页侧栏开关必须是同一个持久化设置，
// 且只有开启后插件页才出现「从文件夹安装（开发）」并以 'directory' 调用 IPC。
test('开发者模式开关在真实渲染中贯通设置页与插件页的目录安装入口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-developer-mode-'))
  try {
    const pluginPage = await compileComponent(
      './PluginPage.vue',
      'PluginPageComponent',
      'twilight-plugin-page-devmode'
    )
    const generalSection = await compileComponent(
      './settings-page/GeneralSettingsSection.vue',
      'GeneralSectionComponent',
      'twilight-general-section-devmode'
    )
    const vueRuntime = await readFile(require.resolve('vue/dist/vue.global.prod.js'), 'utf8')
    const htmlPath = join(directory, 'developer-mode.html')
    const runnerPath = join(directory, 'developer-mode-runner.cjs')
    await writeFile(htmlPath, createFixture(vueRuntime, [pluginPage, generalSection]), 'utf8')
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      timeout: 60_000,
      windowsHide: true
    })
    assert.match(stderr, /DEVELOPER_MODE_OK/)
    assert.doesNotMatch(stderr, /DEVELOPER_MODE_FAILED/)
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

function createFixture(vueRuntime: string, components: string[]): string {
  const componentScripts = components.map((component) => `<script>${component}</script>`).join('\n')
  return `<!doctype html>
<html><body>
  <div id="plugin-page"></div>
  <div id="general-section"></div>
  <script>${vueRuntime}</script>
  <script>${stubScript()}</script>
  ${componentScripts}
  <script>${checksScript()}</script>
</body></html>`
}

function stubScript(): string {
  return (
    `
    const chooseAndInstallCalls = []
    const toggleCalls = []
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
      settings.value = Object.assign({}, settings.value, patch)
      return settings.value
    }
    window.__store = { settings, updateSettings, patches, toggleCalls, chooseAndInstallCalls }
    window.__useSettingsStore = () => ({ settings, updateSettings })
    window.__stubComponent = { name: 'FixtureStub', template: '<span class="fixture-stub"></span>' }
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
      presentPluginTrust: () => ({ badges: [], notices: [] })
    }
    window.__trustRefresh = {
      createPluginTrustRefreshController: () => ({
        schedule() {},
        stop() {},
        refreshNow: async () => {}
      })
    }
    window.api = {
      plugins: {
        list: async () => [],
        listIndex: async () => [],
        refreshIndex: async () => [],
        getIndexStatus: async () => null,
        installFromIndex: async () => null,
        enable: async () => ({}),
        disable: async () => ({}),
        uninstall: async () => {},
        openLog: async () => {},
        getLog: async () => '',
        chooseAndInstall: async (kind) => {
          chooseAndInstallCalls.push(kind)
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
      resetPluginSettingsForm: () => {},
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
    const packageButton = () => installButtons().find((button) => button.textContent.includes('.tep'))
    const fail = (message) => { throw new Error(message) }

    window.runDeveloperModeChecks = async () => {
      const checks = []
      createApp({ render: () => h(window.PluginPageComponent) }).mount('#plugin-page')
      createApp({ render: () => h(window.GeneralSectionComponent, generalProps) }).mount('#general-section')
      await tick()

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
      return checks.join(',')
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
    webPreferences: { contextIsolation: false, nodeIntegration: false }
  })
  window.webContents.on('console-message', (details) => {
    if (details && details.message) console.error('RENDERER ' + details.message)
  })
  try {
    await window.loadFile(path.resolve(target))
    const result = await window.webContents.executeJavaScript('window.runDeveloperModeChecks()')
    console.error('DEVELOPER_MODE_OK ' + result)
    app.exit(0)
  } catch (error) {
    console.error('DEVELOPER_MODE_FAILED', error && error.stack ? error.stack : error)
    app.exit(1)
  }
})`
}
