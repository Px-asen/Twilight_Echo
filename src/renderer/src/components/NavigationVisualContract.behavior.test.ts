import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('live and appearance-preview navigation share settings text, selection and keyboard focus roles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-navigation-contract-'))
  try {
    const renderer = resolve('src/renderer/src').replaceAll('\\', '/')
    await writeFile(join(directory, 'entry.js'), entry.replaceAll('__RENDERER__', renderer))
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'navigation-contract-boundaries',
          enforce: 'pre',
          resolveId(source) {
            if (source === '/icon.png') return '\0navigation-logo'
            if (source.endsWith('/stores/useSettingsStore')) return '\0navigation-settings'
            if (source.endsWith('/stores/useMusicStore')) return '\0navigation-music'
            if (source.endsWith('/composables/appearanceEditorState.ts'))
              return '\0navigation-appearance-state'
            if (source.endsWith('/ThemeIcon.vue')) return '\0navigation-icon'
            if (
              /\/(TitleBar|SidebarBookmark|OnlineHome|PlayerBar|NavigationPagesDialog|NativeDialogTransition)\.vue$/.test(
                source
              )
            )
              return '\0navigation-unused'
            return null
          },
          load(id) {
            if (id === '\0navigation-logo') return 'export default "data:image/png;base64,";'
            if (id === '\0navigation-settings')
              return "import {ref} from 'vue';export const useSettingsStore=()=>({settings:ref({navigationPages:{version:1,order:[],hidden:[]}})});"
            if (id === '\0navigation-music')
              return "import {ref} from 'vue';export const useMusicStore=()=>({libraryScanStatus:ref({state:'idle'}),libraryScanProgress:ref(null)});"
            if (id === '\0navigation-appearance-state')
              return "import {ref} from 'vue';export const appearanceChromePreview=ref(null);"
            if (id === '\0navigation-icon')
              return "import {h} from 'vue';export default {setup:()=>()=>h('span',{'aria-hidden':'true'},'◇')};"
            if (id === '\0navigation-unused') return 'export default {render:()=>null};'
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: { '@renderer': renderer, vue: require.resolve('vue/dist/vue.esm-bundler.js') }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        lib: {
          entry: join(directory, 'entry.js'),
          name: 'NavigationContract',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join('')}<style>
        body{margin:0} .comparison-shell{position:absolute;top:0;width:320px;height:600px;transform:translateZ(0);--te-window-content-top:0px;--te-window-content-bottom:0px;--te-window-surface-inset:4px;--te-window-inner-radius:8px}
        #live{left:0} #preview{left:340px} #preview .appearance-preview-scene{height:100%}
        #settings{position:absolute;inset:0 0 auto 680px;width:900px;padding:0}
        </style></head><body><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { env, windowsHide: true, timeout: 40_000 }
    )
    assert.match(result.stdout, /NAVIGATION_VISUAL_CONTRACT_OK: 18/)
    console.info(result.stdout.trim())
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-navigation-contract-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const entry = `
import {createApp,h,nextTick,ref} from 'vue';
import SideMenu from '__RENDERER__/components/SideMenu.vue';
import AppearancePreviewScene from '__RENDERER__/components/AppearancePreviewScene.vue';
import SettingsWorkspaceNavigation from '__RENDERER__/components/settings-page/SettingsWorkspaceNavigation.vue';
import '__RENDERER__/assets/base.css';
import '__RENDERER__/assets/typography.css';
import '__RENDERER__/assets/overlay-sidebars.css';
import '__RENDERER__/components/settings-page/SettingsPage.css';
import '__RENDERER__/components/settings-page/SettingsLayout.css';
import '__RENDERER__/components/settings-page/SettingsMarketLayout.css';
const section=ref('general'),disabled=ref(false);
createApp({setup:()=>()=>h('div',[
 h('div',{id:'live',class:'comparison-shell app-shell'},[h(SideMenu,{open:true,activeKey:'local-home'})]),
 h('div',{id:'preview',class:'comparison-shell'},[h(AppearancePreviewScene,{navigationExpanded:true,navigationPages:{version:1,order:[],hidden:[]},navigationGlass:false,playerGlass:false,playerMode:'standard',playerLayout:{},appearance:{}})]),
 h('div',{id:'settings',class:'settings-preview-page','data-settings-layout':'categories'},[h(SettingsWorkspaceNavigation,{activeSection:section.value,disabled:disabled.value,onCategory:value=>section.value=value})])
])}).mount('#app');
const settle=async()=>{await nextTick();for(let i=0;i<2;i++)await new Promise(resolve=>requestAnimationFrame(resolve));await nextTick()};
const expect=(value,message)=>{if(!value)throw Error(message)};
window.checkNavigationContract=async()=>{
 const root=document.documentElement,live=document.querySelector('#live .side-menu'),preview=document.querySelector('#preview .side-menu'),settings=document.querySelector('#settings'),results=[];
 for(const theme of ['pureWhite','dark'])for(const font of [14,20,28])for(const style of ['expanded','compact','rail']){
  root.dataset.theme=theme;root.dataset.teNavigationStyle=style;root.style.setProperty('--te-font-size-body',font+'px');await settle();
  const item=live.querySelector('[data-page-id="local-home"]'),sample=preview.querySelector('[data-page-id="local-home"]'),label=item.querySelector('.item-label'),sampleLabel=sample.querySelector('.item-label'),settingsItem=settings.querySelector('[data-settings-category="general"]');
  const row=getComputedStyle(item),sampleRow=getComputedStyle(sample),text=getComputedStyle(label),sampleText=getComputedStyle(sampleLabel),category=getComputedStyle(settingsItem);
  for(const property of ['height','paddingLeft','paddingRight','columnGap','borderRadius','color','backgroundColor'])expect(row[property]===sampleRow[property],'preview navigation differs from live '+property+'/'+theme+'/'+font+'/'+style);
  for(const property of ['fontSize','fontWeight','lineHeight'])expect(text[property]===sampleText[property],'preview text differs from live '+property);
  expect(item.getAttribute('aria-current')==='page'&&settingsItem.getAttribute('aria-current')==='page','current page loses its semantic state');
  expect(text.fontWeight===category.fontWeight&&text.fontWeight==='600','selected navigation label loses the shared strong text role');
  if(style==='rail')expect(text.display==='none','rail retains visible text');
  else{
   const expected=font*(style==='compact'?13:15)/14;
   expect(Math.abs(parseFloat(text.fontSize)-expected)<.01,'navigation label does not use the shared text role: '+JSON.stringify({theme,font,style,actual:text.fontSize,expected}));
   expect(label.getBoundingClientRect().height<=item.getBoundingClientRect().height-8,'large navigation text is clipped');
   if(style==='expanded')expect(text.fontSize===category.fontSize,'navigation and settings body sizes differ');
  }
  const ordinary=live.querySelector('.sidebar-plugins .item-label');expect(getComputedStyle(ordinary).fontWeight==='500','ordinary navigation loses its medium text role');
  root.style.setProperty('--te-control-focus-width','3px');item.focus();await settle();
  expect(item.matches(':focus-visible')&&getComputedStyle(item).outlineWidth==='3px','navigation ignores configured keyboard focus width');
  const focusColor=getComputedStyle(item).outlineColor;
  settingsItem.focus();await settle();expect(settingsItem.matches(':focus-visible')&&getComputedStyle(settingsItem).outlineWidth==='3px','settings and sidebar focus widths differ');
  expect(focusColor===getComputedStyle(settingsItem).outlineColor,'settings and sidebar focus colors differ');
  results.push({theme,font,style,rowHeight:parseFloat(row.height),textSize:parseFloat(text.fontSize)});
 }
 disabled.value=true;await settle();const blocked=settings.querySelector('[data-settings-category="playback"]');blocked.click();await settle();expect(blocked.disabled&&section.value==='general'&&Number(getComputedStyle(blocked).opacity)<1,'disabled settings navigation remains active or indistinguishable');
 return results;
};
`

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({show:false,width:1600,height:800,useContentSize:true,webPreferences:{offscreen:true,contextIsolation:false,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,'index.html'));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
 const result=await win.webContents.executeJavaScript('window.checkNavigationContract().then(value=>({ok:true,value}),error=>({ok:false,error:error.stack}))');if(!result.ok)throw Error(result.error);
 console.log('NAVIGATION_VISUAL_CONTRACT_OK: '+result.value.length);console.log(JSON.stringify(result.value));win.destroy();app.exit(0);
}catch(error){console.error(error.stack);win?.destroy();app.exit(1)}});
`
