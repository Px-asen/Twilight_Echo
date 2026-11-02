import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { APPEARANCE_PARTS, resolveAppearancePart } from './appearanceParts.ts'
const require = createRequire(import.meta.url)

test('inner background remains one target and legacy background navigation resolves', () => {
  assert.equal(APPEARANCE_PARTS.filter((p) => p.id === 'background').length, 0)
  assert.equal(resolveAppearancePart('background'), 'inner-panel')
})

test('one custom theme workspace exports unsaved drafts and transfers advanced capabilities without a plugin gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-custom-theme-'))
  try {
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    await writeFile(
      join(directory, 'entry.mjs'),
      (await readFile('scripts/fixtures/appearance-page.mjs', 'utf8'))
        .replaceAll('__RENDERER__', renderer)
        .replaceAll('__SHARED__', resolve('src/shared').replaceAll('\\', '/'))
    )
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'custom-theme-boundaries',
          enforce: 'pre',
          resolveId(source) {
            const child = source.match(
              /\/(AppearanceWorkspaceSection|AppearanceWindowPreview|ThemeStudioPage|CustomThemeAdvancedPanel)\.vue$/
            )?.[1]
            if (child) return '\0fixture:' + child
            if (/\/stores\/useThemeStore(?:\.ts)?$/.test(source)) return '\0fixture:themeStore'
            if (/\/stores\/useSettingsStore(?:\.ts)?$/.test(source))
              return '\0fixture:settingsStore'
            if (/\/extensions\/registry(?:\.ts)?$/.test(source)) return '\0fixture:registry'
            return null
          },
          load(id) {
            if (id === '\0fixture:registry')
              return `import {ref} from 'vue';export const useExtensionRegistry=()=>({themeContributions:ref([])});`
            if (id === '\0fixture:settingsStore')
              return `import {ref} from 'vue';export const useSettingsStore=()=>({settings:ref({theme:'dark'}),loadSettings:async()=>{}});`
            if (id === '\0fixture:themeStore')
              return `import {ref} from 'vue';const activeTheme=ref({kind:'builtin',id:'builtin:twilight-echo-default'}),profiles=ref([]);const store={activeTheme,profiles,load:async()=>{},setActive:async v=>activeTheme.value=v,createProfile:()=>window.studioDraft,saveProfile:async p=>{window.calls.push({action:'save-profile'});profiles.value.push(p);return {data:{profiles:profiles.value}}}};export const useThemeStore=()=>store;`
            if (id === '\0fixture:AppearanceWorkspaceSection')
              return `import {ref,computed} from 'vue';export default {setup(p,{expose}){expose({previewDraft:computed(()=>window.dailyDraft),previewBusy:false,cancel:()=>window.calls.push({action:'cancel-daily'}),prepareLeave:async()=>{window.calls.push({action:'leave-daily'});return window.allowLeave},collapse:async()=>false,setTone:()=>{}});return()=> '常用调整预览'},template:'<div class="daily-fixture">常用调整预览</div>'}`.replace(
                "return()=> '常用调整预览'",
                'return {}'
              )
            if (id === '\0fixture:AppearanceWindowPreview')
              return `import {ref,h} from 'vue';export default {setup(p,{expose,slots}){const layeredView=ref(false);expose({layeredView,setLayeredView:v=>layeredView.value=v,inspectWorkshop:async()=>[]});return()=>h('div',{class:'preview-fixture'},slots['context-tools']?.({playerTarget:'stage',setPlayerTarget:()=>{}}))}}`
            if (id === '\0fixture:ThemeStudioPage' || id === '\0fixture:CustomThemeAdvancedPanel') {
              const studio = id.endsWith('ThemeStudioPage')
              return `import {ref,computed} from 'vue';export default {props:['initialKey','initialProjectId'],setup(p,{expose}){const state=computed(()=>({key:${studio ? 'p.initialKey' : "'workshop:'+p.initialProjectId"},tone:'dark',busy:false,canExport:true,canApply:true,canUndo:true,status:'正在编辑',dirty:true}));expose({state,projects:computed(()=>window.projects),customGroups:[],snapshot:()=>window.studioDraft,releaseForTransfer:async()=>window.calls.push({action:'release-studio'}),prepareLeave:async()=>{window.calls.push({action:'${studio ? 'leave-studio' : 'leave-advanced'}'});return window.allowLeave},perform:async action=>window.calls.push({action}),setTone:()=>{},selectKey:async()=>{},selectGroup:()=>{},openTools:async tool=>window.calls.push({action:'tools',tool})});return{}},template:'<div class="${studio ? 'studio' : 'advanced'}-fixture"><button>主题属性</button></div>'}`
            }
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.mjs'),
          name: 'CustomThemeTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}<style>body{margin:0;background:#17181a;color:#eee}#app{height:100vh}.daily-fixture,.preview-fixture{flex:1;min-height:300px}</style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1024,height:800,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.webContents.on('console-message',e=>console.error(e.message));try{await win.loadFile(require('node:path').join(__dirname,'index.html'));await win.webContents.executeJavaScript('window.runCustomization()');console.log('CUSTOM_THEME_WORKSPACE_OK');win.destroy();app.exit(0)}catch(e){console.error(e.stack);win.destroy();app.exit(1)}})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024 }
    )
    assert.match(result.stdout, /CUSTOM_THEME_WORKSPACE_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})
