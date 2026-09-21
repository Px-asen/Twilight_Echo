import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('version management previews changes, persists relationships, preserves album order and blocks unavailable preferences', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-versions-ui-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'VersionsTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">曲库整理</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.webContents.on('console-message',(_e,_l,message)=>console.error(message));try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runVersionTests()');if(process.env.TWILIGHT_VERSIONS_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_VERSIONS_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('VERSIONS_UI_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /VERSIONS_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import '@renderer/assets/base.css'
import {createApp,h,nextTick,shallowRef,ref} from 'vue'
import Panel from '@renderer/components/music-versions/MusicVersionsPanel.vue'
import {getMusicVersions,loadMusicVersions} from '@renderer/stores/musicVersions.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,20));await nextTick()}
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text)
const click=async text=>{const el=button(text);expect(el&&!el.disabled,'button unavailable: '+text+' / '+document.querySelector('[role=alert]')?.textContent);el.click();await tick()}
const value=async(el,text)=>{el.value=text;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));await tick()}
const track=(id,album='Release')=>({id,title:'Song '+id,artist:'Artist',album,albumId:album,filePath:'D:/music/'+id+'.flac',fileName:id+'.flac',source:'local',duration:180,size:1,cover:null,lyrics:null,discNumber:1,trackNumber:Number(id)+1})
window.runVersionTests=async()=>{
  localStorage.clear();loadMusicVersions()
  const tracks=shallowRef(Array.from({length:10000},(_,i)=>track(String(i),i<2?'Release A':'Release B')))
  const key=ref(0),plays=[]
  createApp({setup:()=>()=>h(Panel,{key:key.value,tracks:tracks.value,onPlay:items=>plays.push(items)})}).mount('#app')
  await tick()
  expect(document.querySelectorAll('.version-list > li').length===50,'10k catalog must render only one page')
  const boxes=()=>document.querySelectorAll('.version-list input[type=checkbox]')
  boxes()[0].click();boxes()[1].click();await tick()
  await value(document.querySelectorAll('.version-tools input')[1],'Studio')
  await click('关联为同版本的多个来源')
  expect(localStorage.length===0,'preview must not persist')
  expect(document.querySelector('.version-preview').textContent.includes('2 个来源'),'preview explains merge')
  await click('确认保存关系');expect(getMusicVersions().tracks.versions.length===1,'source group persisted')
  await click('清空选择');boxes()[1].click();await tick();await click('设为偏好来源');await click('确认保存关系')
  await click('播放偏好版本');expect(plays[0][0].id==='1','preferred source selected')
  key.value++;await tick();expect(document.querySelector('.version-list').textContent.includes('Studio'),'reopen keeps labels')
  boxes()[0].click();await tick();await click('拆分所选来源');await click('确认保存关系')
  expect(getMusicVersions().tracks.versions.length===2,'split keeps two versions')
  await click('清空选择');boxes()[0].click();boxes()[1].click();await tick();await click('关联为不同版本');await click('确认保存关系')
  await click('清空选择');boxes()[1].click();await tick();await click('设为偏好版本');await click('确认保存关系')
  await click('清空选择');boxes()[0].click();await tick();await click('播放偏好版本');expect(plays.at(-1)[0].id==='1','family preference chooses selected version')
  tracks.value=tracks.value.filter(item=>item.id!=='1');await tick();await click('播放偏好版本')
  expect(document.querySelector('[role=alert]').textContent.includes('未载入'),'missing preference requires user action')
  expect(plays.length===2,'missing preference cannot silently play other version')
  await click('撤回所选人工关系');tracks.value=[...tracks.value];await tick();expect(!document.querySelector('.version-preview'),'source change invalidates preview')
  await value(document.querySelector('select'),'albums');await tick()
  expect(document.querySelectorAll('.version-list > li').length===2,'album releases stay distinct')
  boxes()[0].click();boxes()[1].click();await tick();await click('关联为不同版本');await click('确认保存关系')
  expect(getMusicVersions().albums.families.length===1,'album version family persisted')
  await click('清空选择');boxes()[1].click();await tick();await click('设为偏好版本');await click('确认保存关系')
  await click('清空选择');boxes()[0].click();await tick();await click('播放偏好版本')
  expect(plays.at(-1)[0].id==='2'&&plays.at(-1).length===9998,'preferred release preserves all tracks and order')
  await value(document.querySelectorAll('.version-tools input')[1],'Remastered');await click('修改版本标签');await click('确认保存关系')
  await click('撤回所选人工关系');await click('确认保存关系')
  expect(getMusicVersions().albums.families.length===0,'retract removes dangling family')
  await click('修改版本标签');localStorage.setItem('twilight.music-versions.v1',JSON.stringify({version:1,tracks:{versions:[],families:[]},albums:{versions:[],families:[]}}));await click('确认保存关系')
  expect(document.querySelector('[role=alert]').textContent.includes('其他窗口'),'stale preview detects external edit')
  await value(document.querySelector('select'),'tracks');await tick()
}
`
