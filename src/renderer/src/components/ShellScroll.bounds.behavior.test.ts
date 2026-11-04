import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)

test('page scrollports paint under the caption while window controls retain input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-scroll-bounds-'))
  try {
    const source = await readFile(new URL('../App.vue', import.meta.url), 'utf8')
    const appCss = parse(source)
      .descriptor.styles.map((style) => style.content)
      .join('\n')
    const base = await readFile(new URL('../assets/base.css', import.meta.url), 'utf8')
    const main = await readFile(new URL('../assets/main.css', import.meta.url), 'utf8')
    const shellCss = main.slice(main.indexOf('/* Windows owns'), main.indexOf('/* Active lyrics'))
    const streamingCss = await readFile(
      new URL('./streaming-page/StreamingPage.css', import.meta.url),
      'utf8'
    )
    const homeCss = await readFile(new URL('./LocalDashboard.css', import.meta.url), 'utf8')
    const analyticsCss = await readFile(
      new URL('./ListeningAnalyticsPage.css', import.meta.url),
      'utf8'
    )
    const roots = [
      'RadioPodcastPage.vue',
      'NetworkSourcesPage.vue',
      'navigation/RecentPlaybackPage.vue'
    ]
    const rootCss = await Promise.all(
      roots.map(async (path) =>
        parse(await readFile(new URL(path, import.meta.url), 'utf8'))
          .descriptor.styles.map((s) => s.content)
          .join('\n')
      )
    )
    // ZonesPage.vue loads its styles through <style src>, so read the sheet itself.
    rootCss.push(await readFile(new URL('./zones/ZonesPage.css', import.meta.url), 'utf8'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><style>
      ${base}\n${appCss}\n${streamingCss}\n${homeCss}\n${analyticsCss}\n${rootCss.join('\n')}\n${shellCss}
      *{box-sizing:border-box}body{margin:0;overflow:hidden}html{--te-titlebar-inset:40px;--te-menu-width:192px}
      .app-shell-title{position:fixed;inset:0 0 auto;height:40px;background:#333}
      .row{height:80px;flex-shrink:0}.recent-playback-page{overflow-y:auto}
      </style></head><body><div class="app-shell"><div class="app-shell-title">Window controls</div>
      <div class="app-shell-content"><div class="main-content" style="min-height:100vh"></div></div></div></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      {
        windowsHide: true,
        timeout: 30_000
      }
    )
    assert.match(result.stdout, /SCROLL_BOUNDS_OK/)
  } finally {
    const target = resolve(directory)
    assert.ok(target.startsWith(resolve(tmpdir()) + sep))
    await rm(target, { recursive: true, force: true })
  }
})

const runner = `const {app,BrowserWindow}=require('electron')
app.setPath('userData',__dirname+'/profile')
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1366,height:768,webPreferences:{offscreen:true,backgroundThrottling:false}})
 try{
  await win.loadFile(__dirname+'/index.html')
  for(const [width,height] of [[1366,768],[760,692]]){
   win.setContentSize(width,height);await new Promise(r=>setTimeout(r,120))
   for(const tone of ['dark','pureWhite'])for(const root of ['streaming','home','analytics-page','radio-podcast-page','network-sources-page','zones-page','recent-playback-page'])for(const menu of [false,true]){
    const result=await win.webContents.executeJavaScript('(()=>{try{return {point:('+setup.toString()+')('+JSON.stringify(root)+','+menu+','+JSON.stringify(tone)+')}}catch(e){return {error:e.message}}})()')
    if(result.error)throw Error(result.error)
    const point=result.point
    const reachable=await win.webContents.executeJavaScript('Boolean(document.elementFromPoint('+point.x+','+point.y+')?.closest("[data-scroller]"))')
    if(!reachable)throw Error('page input is covered: '+root)
   }
  }
  console.log('SCROLL_BOUNDS_OK');app.exit(0)
 }catch(e){console.error(e.stack);app.exit(1)}
})
function setup(root,menu,tone){
 document.documentElement.dataset.theme=tone
 const host=document.querySelector('.main-content');host.classList.toggle('menu-open',menu)
 const rows='<div class="row">Music</div>'.repeat(30)
 host.innerHTML=root==='streaming'?'<div class="streaming-page '+(menu?'menu-open':'')+'"><div class="streaming-content" data-scroller>'+rows+'</div></div>':root==='home'?'<div class="local-home-layout"><div class="home" data-scroller><main class="home-inner">'+rows+'</main></div></div>':'<div class="'+root+'" data-scroller>'+rows+'</div>'
 const el=document.querySelector('[data-scroller]'),rect=el.getBoundingClientRect()
 const width=el.clientWidth,height=el.clientHeight
 for(const state of ['', 'te-auto-scrollbar te-scrollbar-active', 'te-auto-scrollbar te-scrollbar-near']){
  el.className=el.className.replace(/te-auto-scrollbar|te-scrollbar-active|te-scrollbar-near/g,'').trim()+' '+state
  for(const part of ['::-webkit-scrollbar','::-webkit-scrollbar-track','::-webkit-scrollbar-track-piece','::-webkit-scrollbar-corner']){
   const css=getComputedStyle(el,part)
   if(css.backgroundColor!=='rgba(0, 0, 0, 0)'||css.backgroundImage!=='none')throw Error(root+' '+tone+' paints a mismatched gutter: '+part+' '+css.backgroundColor)
  }
  if(el.clientWidth!==width||el.clientHeight!==height)throw Error(root+' scrollbar interaction shifts content')
 }
 const underCaption=root!=='recent-playback-page'
 if(Math.abs(rect.top-(underCaption?0:44))>.2||rect.bottom>innerHeight-4.1+0.2||rect.right>innerWidth-3.9)throw Error(root+' scroll bounds: '+JSON.stringify([rect.toJSON(),host.firstElementChild.getBoundingClientRect().toJSON(),getComputedStyle(host.firstElementChild).height,host.getBoundingClientRect().toJSON()]))
 if(document.elementFromPoint(innerWidth-8,28)?.closest('[data-scroller]'))throw Error('scrollport reaches the window controls')
 if(document.querySelector('.row').getBoundingClientRect().top<44)throw Error(root+' initial content is covered by the caption')
 el.scrollTop=el.scrollHeight
 if(el.scrollTop+el.clientHeight<el.scrollHeight-1)throw Error(root+' cannot reach its end')
 el.scrollTop=0
 return {x:Math.round(rect.right-20),y:Math.round(rect.top+120)}
}`
