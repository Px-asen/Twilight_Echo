import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)
const panels = new Set([
  'HiFiSidebar',
  'LibraryQueueDrawer',
  'QueueAddToPlaylistDialog',
  'QueueSavePlaylistDialog',
  'CompactPlayerBarVisualizer',
  'ImportDialog',
  'EmbeddedExperience'
])

test('ordinary playback defers panel modules until use and preserves dialog instances after closing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-deferred-panels-'))
  try {
    const stores = join(directory, 'stores.ts').replaceAll('\\', '/')
    await writeFile(
      stores,
      (await readFile('scripts/fixtures/appearance-preview-stores.mjs', 'utf8'))
        .replaceAll('__SHARED__', resolve('src/shared').replaceAll('\\', '/'))
        .replace(
          /const forbidden =[\s\S]*?\nconst core =/,
          'const forbidden = () => () => Promise.resolve()\nconst core ='
        )
        .replace(
          'export const useExtensionRegistry',
          'export const fixtureExperiences = ref([])\nexport const useExtensionRegistry'
        )
        .replace(
          'return { uiContributions: ref([]), syncExtensions:',
          'return { experiences: fixtureExperiences, uiContributions: ref([]), syncExtensions:'
        )
    )
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [
        {
          name: 'deferred-panel-boundaries',
          enforce: 'pre',
          resolveId(source) {
            if (source === '/icon.png') return resolve('resources/icon.png')
            const panel = source.match(/\/([^/]+)\.vue$/)?.[1]
            if (panel && panels.has(panel)) return `\0deferred-panel:${panel}`
            if (
              /\/(useSettingsStore|useMusicStore|usePlayerStore|useThemeStore|useListeningStatsStore|useAudioOutputDspStore|useNcmStore|useAppNoticeStore|playbackBookmarks|lyricsManagement|coreConnection)(?:\.ts)?$/.test(
                source
              ) ||
              /\/extensions\/registry(?:\.ts)?$/.test(source) ||
              /\/providers(?:\/index(?:\.ts)?)?$/.test(source)
            )
              return stores
            return null
          },
          load(id) {
            if (!id.startsWith('\0deferred-panel:')) return null
            const name = id.split(':')[1]
            return `import {h,ref} from 'vue';
const name=${JSON.stringify(name)};
(window.loadedPanels??=[]).push(name);
export default {props:['open','show'],emits:['close','addToPlaylist','savePlaylist'],setup(props,{emit}){
  const draft=ref('');window.panelMounts[name]=(window.panelMounts[name]||0)+1;
  return ()=>h('section',{'data-panel':name,style:{display:props.open===false||props.show===false?'none':''}},[
    h('input',{value:draft.value,onInput:event=>draft.value=event.target.value}),
    h('button',{class:'close',onClick:()=>emit('close')},'关闭'),
    h('button',{class:'add',onClick:()=>emit('addToPlaylist',{id:'song',title:'Song',artist:'Artist',album:'Album',duration:180,size:1,source:'local'})},'添加'),
    h('button',{class:'save',onClick:()=>emit('savePlaylist')},'保存')
  ])}}
`
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          vue: require.resolve('vue/dist/vue.runtime.esm-bundler.js'),
          '@renderer': resolve('src/renderer/src')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        cssCodeSplit: true,
        minify: false,
        lib: { entry: join(directory, 'entry.ts'), formats: ['es'], fileName: () => 'runtime.js' }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><html data-te-motion="off"><body><div id="app"></div><script type="module" src="./bundle/runtime.js"></script></body></html>'
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{try{
const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,backgroundThrottling:false}});
win.webContents.on('console-message',event=>console.error(event.message));
await win.loadFile(path.join(__dirname,'index.html'));
await win.webContents.executeJavaScript('window.runDeferredPanelTests()');
console.log('DEFERRED_PANELS_OK');win.destroy();app.exit(0);
}catch(error){console.error(error.stack);app.exit(1)}});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      {
        env,
        windowsHide: true,
        timeout: 45_000,
        maxBuffer: 1024 * 1024
      }
    )
    assert.match(result.stdout, /DEFERRED_PANELS_OK/)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `
import {createApp,h,ref,nextTick} from 'vue'
import {usePlayerStore,fixtureExperiences} from './stores.ts'
import PlayerBar from '@renderer/components/PlayerBar.vue'
import SideMenu from '@renderer/components/SideMenu.vue'
import ExperienceFlyout from '@renderer/components/ExperienceFlyout.vue'
import {usePluginFlyout} from '@renderer/stores/usePluginFlyout.ts'
window.loadedPanels=[];window.panelMounts={};
window.api={desktopLyrics:{onEnabledChanged:()=>()=>{}},diagnostics:{record(){}}};
const player=usePlayerStore();
player.currentTrackBookmarks=ref([]);player.currentFavorite=ref({available:false});
player.refreshBookmarks=async()=>{};
player.queueSessions={open:ref(false),show(){}};
player.acquireVisualizationConsumer=()=>()=>{};
player.libraryQueueActive.value=true;
player.libraryQueueSnapshot.value={id:'queue',revision:1,total:1,index:0,selectedEntryId:'one'};
const mode=ref('standard'),visualizerVisible=ref(false);
const app=createApp({render:()=>h('main',[h(PlayerBar,{mode:mode.value,visualizerVisible:visualizerVisible.value}),h(SideMenu,{open:true,activeKey:'local:dashboard'}),h(ExperienceFlyout)])});
app.config.errorHandler=error=>window.previewErrors.push(error.stack);app.mount('#app');
const expect=(value,message)=>{if(!value)throw Error(message)};
const wait=async(check)=>{for(let i=0;i<100;i++){await nextTick();if(check())return;await new Promise(resolve=>setTimeout(resolve,10))}throw Error('Timed out waiting for a deferred panel')};
const panel=name=>document.querySelector('[data-panel="'+name+'"]');
const click=selector=>{const button=document.querySelector(selector);expect(button,'Missing button '+selector+'; errors: '+window.previewErrors.join('; '));button.click()};
window.runDeferredPanelTests=async()=>{
await nextTick();await new Promise(resolve=>setTimeout(resolve,30));
expect(window.loadedPanels.length===0,'ordinary playback evaluated hidden panel modules: '+window.loadedPanels);
click('[aria-label="HiFi 控制台"]');await wait(()=>panel('HiFiSidebar'));
expect(window.loadedPanels.join(',')==='HiFiSidebar','opening HiFi loaded unrelated panels');
click('[aria-label="HiFi 控制台"]');await wait(()=>!panel('HiFiSidebar'));
click('[aria-label="播放列表"]');await wait(()=>panel('LibraryQueueDrawer'));
click('[data-panel="LibraryQueueDrawer"] .add');await wait(()=>panel('QueueAddToPlaylistDialog'));
const picker=panel('QueueAddToPlaylistDialog');picker.querySelector('input').value='retained';picker.querySelector('input').dispatchEvent(new Event('input'));
click('[data-panel="QueueAddToPlaylistDialog"] .close');await nextTick();
expect(panel('QueueAddToPlaylistDialog')===picker&&picker.style.display==='none','closing picker discarded its transition/state host');
click('[data-panel="LibraryQueueDrawer"] .add');await wait(()=>picker.style.display!=='none');
expect(picker.querySelector('input').value==='retained'&&window.panelMounts.QueueAddToPlaylistDialog===1,'picker was recreated');
click('[data-panel="QueueAddToPlaylistDialog"] .close');
click('[data-panel="LibraryQueueDrawer"] .save');await wait(()=>panel('QueueSavePlaylistDialog'));
click('[data-panel="QueueSavePlaylistDialog"] .close');await wait(()=>!panel('QueueSavePlaylistDialog'));
click('[aria-label="导入歌曲"]');await wait(()=>panel('ImportDialog'));
const importer=panel('ImportDialog');click('[data-panel="ImportDialog"] .close');await nextTick();
expect(panel('ImportDialog')===importer&&importer.style.display==='none','import dialog close discarded its retained state');
click('[aria-label="导入歌曲"]');await wait(()=>importer.style.display!=='none');
expect(window.panelMounts.ImportDialog===1,'import dialog remounted');
expect(!window.loadedPanels.includes('CompactPlayerBarVisualizer'),'standard playback loaded the compact visualizer');
mode.value='compact';visualizerVisible.value=true;await wait(()=>panel('CompactPlayerBarVisualizer'));
expect(!window.loadedPanels.includes('EmbeddedExperience'),'ordinary playback loaded plugin bridge runtime');
fixtureExperiences.value=[{pluginId:'fixture',id:'panel',name:'Fixture',launch:'panel',version:'1'}];
usePluginFlyout().open({pluginId:'fixture',title:'Fixture'});await wait(()=>panel('EmbeddedExperience'));
usePluginFlyout().close();await wait(()=>!panel('EmbeddedExperience'));
expect(window.previewErrors.length===0,'unexpected renderer errors: '+window.previewErrors.join('; '));
};
`
