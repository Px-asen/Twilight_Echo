import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

test('command palette keyboard, composition, lifecycle, paging and bounded rendering work in Electron', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-command-palette-'))
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
          name: 'CommandPaletteTest',
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
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">打开命令面板</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:960,height:820,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runCommandPaletteTests()');if(process.env.TWILIGHT_COMMAND_PALETTE_SCREENSHOT){await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const image=await win.webContents.capturePage();fs.writeFileSync(process.env.TWILIGHT_COMMAND_PALETTE_SCREENSHOT,image.toPNG())}console.log('COMMAND_PALETTE_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /COMMAND_PALETTE_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(
      target.startsWith(resolve(tmpdir()) + '\\') || target.startsWith(resolve(tmpdir()) + '/')
    )
    await rm(target, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref,shallowRef} from 'vue'
import CommandPalette from '@renderer/components/CommandPalette.vue'
import {createUnifiedMusicSearch} from '@renderer/app/useUnifiedMusicSearch.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const pause=(delay=25)=>new Promise(resolve=>setTimeout(resolve,delay))
const track=(id,title=id)=>({id,title,artist:'测试艺术家',album:'测试专辑',filePath:id+'.flac',fileName:id+'.flac',source:'local',duration:180,size:1,cover:null,lyrics:null})
const result=(tracks,hasMore=false)=>({items:[],logicalItems:tracks.map(track=>({id:track.id,title:track.title,artist:track.artist,album:track.album,preferredTrack:track,variants:[{track,source:'local',sourceName:'本地音乐',providerAvailable:true}]})),health:{},total:hasMore?40:tracks.length,hasMore})
window.runCommandPaletteTests=async()=>{
  let calls=[],executed=0,closed=0,releaseOld,releaseClosed,failAction=false,played
  const search=createUnifiedMusicSearch({getLocalTracks:()=>[],searchAllSongs:async({query,offset})=>{
    calls.push(query+':'+offset)
    if(query==='old')return new Promise(resolve=>releaseOld=()=>resolve(result([track('old')])))
    if(query==='closing')return new Promise(resolve=>releaseClosed=()=>resolve(result([track('closed')])))
    if(query==='many')return result(Array.from({length:20000},(_,index)=>track('many:'+index)))
    if(query==='page')return result([track('page:'+offset)],offset===0)
    return result([track(query,query==='new'?'新歌曲':query)])
  }})
  const actions=[
    {id:'disabled',title:'定位正在播放',description:'',terms:'disabled',group:'操作',disabledReason:'当前没有歌曲',run:()=>{throw new Error('disabled action ran')}},
    {id:'eq',title:'打开均衡器',description:'EQ 与耳机补偿',terms:'eq 均衡器',group:'操作',run:()=>{executed++;if(failAction)throw new Error('操作失败，请重试')}},
    {id:'settings',title:'进入设置',description:'应用偏好与音乐库',terms:'settings 设置',group:'操作',run:()=>{executed++}}
  ]
  const playlists=shallowRef([{id:'work',name:'工作',trackIds:[],createdAt:'2026-09-14'}])
  const tracks=shallowRef([]),visible=ref(true)
  const app=createApp({render:()=>visible.value?h(CommandPalette,{actions,search,playlists,tracks,playTrack:track=>{played=track.id},openPlaylist:playlist=>{played=playlist.id},onClose:()=>{closed++;visible.value=false}}):null})
  const opener=document.querySelector('#opener');opener.focus();app.mount('#app');await pause()
  let input=document.querySelector('input')
  const key=(key,options={})=>input.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options}))
  const type=async value=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick()}
  const reopen=async()=>{visible.value=true;await pause();input=document.querySelector('input')}
  expect(document.querySelector('dialog').matches(':modal'),'dialog is not modal')
  expect(document.activeElement===input,'opening did not focus search')
  expect(calls.length===0,'opening requested songs')
  document.querySelector('[aria-disabled="true"]').click();await pause();expect(executed===0,'disabled command executed')
  key('ArrowDown');key('Enter');await pause();expect(executed===1&&closed===1,'keyboard command failed')
  expect(document.activeElement===opener,'focus was not restored')
  await reopen();expect(input.value===''&&calls.length===0,'reopen retained a query or navigation searched')
  input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));await type('中文')
  key('Enter',{isComposing:true});key('Enter',{keyCode:229});key('Escape');await pause(300)
  expect(calls.length===0&&visible.value,'composition executed a command, searched, or closed')
  input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));await pause(300)
  expect(calls.at(-1)==='中文:0','composition did not search its committed query')
  await type('old');await pause(280)
  await type('new');expect(!document.querySelector('.palette-row')?.textContent.includes('old'),'stale result remained executable')
  await pause(280);releaseOld();await pause()
  expect(document.querySelector('.palette-results').textContent.includes('新歌曲'),'old query replaced new result')
  key('Enter');await pause();expect(played==='new','Enter did not execute latest result')
  await reopen();await type('page');await pause(280)
  const next=document.querySelector('footer button:last-child');expect(!next.disabled,'next page is unavailable')
  next.click();await pause();expect(calls.at(-1)==='page:20','next page sent wrong offset')
  expect(document.querySelector('footer button:last-child').disabled,'next page remained enabled past last source page')
  await type('many');await pause(340)
  expect(document.querySelectorAll('.palette-row').length<=16,'large result set mounted unbounded rows')
  key('ArrowUp');await pause();expect(document.querySelector('[aria-selected="true"]').textContent.includes('many:19999'),'keyboard cannot reach virtualized last result')
  expect(document.querySelector('.palette-results').scrollTop>100000,'virtual result did not scroll into view')
  await type('closing');await pause(280);key('Escape');await pause();releaseClosed();await pause()
  await reopen();expect(input.value===''&&search.logicalItems.value.length===0,'late closed result reappeared')
  await type('>eq');await pause(280);const callsBefore=calls.length;failAction=true;key('Enter');await pause()
  expect(visible.value&&document.querySelector('[role="alert"]').textContent.includes('操作失败'),'action failure closed the dialog')
  failAction=false;document.querySelector('[role="alert"] button').click();await pause()
  expect(!visible.value&&calls.length===callsBefore,'retry searched instead of rerunning the failed action')
  await reopen();await type('工作');await pause(280)
  expect(document.querySelector('.palette-results').textContent.includes('本地歌单'),'playlist search is missing')
  key('Escape');await pause()
  await reopen()
}
`
