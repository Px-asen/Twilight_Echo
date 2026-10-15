import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)

test('navigation density and large text retain usable geometry while editor commands remain readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-sidebar-sizing-'))
  try {
    const componentPath = resolve('src/renderer/src/components/SideMenu.vue')
    const { descriptor } = parse(await readFile(componentPath, 'utf8'), {
      filename: componentPath
    })
    const style = compileStyle({
      source: descriptor.styles.find((entry) => entry.scoped)!.content,
      filename: componentPath,
      id: 'data-v-sidebar-sizing',
      scoped: true
    })
    assert.deepEqual(style.errors, [])
    const styles = await Promise.all(
      [
        'src/renderer/src/assets/base.css',
        'src/renderer/src/assets/overlay-sidebars.css',
        'src/renderer/src/components/settings-page/BackgroundAppearanceCustomizer.css'
      ].map((path) => readFile(resolve(path), 'utf8'))
    )
    await writeFile(join(directory, 'sizing.css'), [...styles, style.code].join('\n'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8"><link rel="stylesheet" href="sizing.css"><style>
      body{margin:0;background:var(--te-app-bg)}
      .app-shell{position:absolute;inset:0;--te-window-content-top:40px;--te-window-content-bottom:0px;--te-window-surface-inset:4px}
      .content{position:absolute;inset:40px 4px 0;background:var(--te-app-bg)}
      .queue-sidebar{visibility:hidden}
      .glyph{display:block;width:1em;height:1em;font-size:inherit;line-height:1}
      .fixture-editor{position:fixed;right:8px;bottom:8px;width:450px;height:auto;z-index:2000}
      .fixture-editor .appearance-character-footer{flex-wrap:wrap;padding:8px}
      </style></head><body><div class="app-shell"><div class="content"></div><aside class="side-menu overlay-side-panel open"><nav class="menu-items"><div class="menu-nav"><button class="menu-item"><span class="item-icon"><span class="glyph">⌂</span></span><span class="item-label">音乐库</span></button><div class="menu-children"><button class="menu-item menu-child"><span class="item-icon"><span class="glyph">♫</span></span><span class="item-label">全部歌曲</span></button></div></div></nav></aside><aside class="queue-sidebar overlay-side-panel"></aside></div><section class="appearance-editor appearance-editor--character fixture-editor"><footer class="appearance-character-footer"><div><button class="appearance-full-preview">全窗口预览</button></div><div class="appearance-part-tools"><button aria-pressed="true">整窗</button><button aria-pressed="false">侧边栏</button></div><div><button disabled>放弃调整</button><button class="appearance-save">应用外观</button></div></footer></section><script>document.querySelectorAll('.side-menu,.side-menu *').forEach(element=>element.setAttribute('data-v-sidebar-sizing',''))</script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner())
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 45_000 }
    )
    assert.match(result.stdout, /SIDEBAR_SIZING_OK/)
    console.info(result.stdout.trim())
    if (process.env.TWILIGHT_SIDEBAR_SIZING_ARTIFACT_DIR) {
      const artifacts = resolve(process.env.TWILIGHT_SIDEBAR_SIZING_ARTIFACT_DIR)
      await mkdir(artifacts, { recursive: true })
      await writeFile(join(artifacts, 'sidebar-sizing.log'), result.stdout)
    }
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-sidebar-sizing-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = () => `
const {app,BrowserWindow}=require('electron'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1280,height:720,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false}});
 const run=async source=>{const result=await win.webContents.executeJavaScript('(async()=>{try{return {ok:true,value:await ('+source+')()}}catch(error){return {ok:false,error:error.stack}}})()');if(!result.ok)throw new Error(result.error);return result.value};
 try{
  await win.loadFile(path.join(__dirname,'index.html'));
  const results=[];
  for(const width of [1280,520]){
   win.setContentSize(width,720);
   results.push(...await run(${JSON.stringify(verifyGeometry)}));
  }
  const colors=await run(${JSON.stringify(verifyCommands)});
  console.log('SIDEBAR_SIZING',JSON.stringify(results));
  console.log('EDITOR_COMMAND_CONTRAST',JSON.stringify(colors));
  console.log('SIDEBAR_SIZING_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});
`

const verifyGeometry = `async function(){
 const expect=(value,message)=>{if(!value)throw new Error(message)};
 const settle=async()=>{for(let i=0;i<2;i++)await new Promise(resolve=>requestAnimationFrame(resolve))};
 const root=document.documentElement,menu=document.querySelector('.side-menu'),row=menu.querySelector('.menu-item'),icon=row.querySelector('.item-icon'),label=row.querySelector('.item-label'),glyph=icon.querySelector('.glyph'),queue=document.querySelector('.queue-sidebar'),content=document.querySelector('.content'),results=[];
 const originalContent=content.getBoundingClientRect().toJSON();
 for(const font of [14,20,28])for(const style of ['expanded','compact','rail']){
  root.style.setProperty('--te-font-size-body',font+'px');root.dataset.teNavigationStyle=style;await settle();
  const panel=menu.getBoundingClientRect(),item=row.getBoundingClientRect(),slot=icon.getBoundingClientRect(),text=label.getBoundingClientRect(),symbol=glyph.getBoundingClientRect(),child=menu.querySelector('.menu-child').getBoundingClientRect();
  const expected=style==='compact'?192*font/14:style==='rail'?Math.max(72,font*22/14+50):Math.min(260*font/14,Math.max(224*font/14,innerWidth*.18));
  expect(Math.abs(panel.width-Math.min(expected,innerWidth-8))<.1,'navigation density width was overridden: '+JSON.stringify({font,style,actual:panel.width,expected}));
  expect(panel.left>=0&&panel.right<=innerWidth,'navigation exceeds the window');
  expect(item.left>=panel.left&&item.right<=panel.right,'navigation control exceeds its panel');
  expect(slot.width+0.1>=symbol.width&&slot.height+0.1>=symbol.height,'large navigation icon exceeds its reserved slot');
  expect(item.height>=symbol.height+7.5,'large navigation icon has insufficient vertical clearance');
  if(style!=='rail')expect(text.height<=item.height-7.5&&text.right<=item.right,'navigation label is clipped by its control: '+JSON.stringify({font,style,item:item.toJSON(),text:text.toJSON()}));
  else expect(getComputedStyle(label).display==='none','icon rail retains hidden text geometry');
  expect(child.height>=36,'child navigation loses its minimum hit target');
  if(font===14)expect(item.height===40&&slot.width===22&&slot.height===22,'default navigation proportions changed');
  if(font===28)expect(item.height>40&&slot.width>22,'large text does not grow its row and icon slot');
  expect(queue.getBoundingClientRect().width>=260,'compact navigation also shrinks the playback queue');
  expect(JSON.stringify(content.getBoundingClientRect().toJSON())===JSON.stringify(originalContent),'navigation density shifts or shrinks page content');
  results.push({viewport:innerWidth,font,style,panelWidth:panel.width,rowHeight:item.height,iconSlot:slot.width});
 }
 return results;
}`

const verifyCommands = `async function(){
 const expect=(value,message)=>{if(!value)throw new Error(message)};
 const settle=async()=>{for(let i=0;i<2;i++)await new Promise(resolve=>requestAnimationFrame(resolve))};
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d',{willReadFrequently:true});
 const rgba=color=>{context.clearRect(0,0,1,1);context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data]};
 const compose=(foreground,background)=>{const alpha=foreground[3]/255;return foreground.slice(0,3).map((value,index)=>value*alpha+background[index]*(1-alpha)).concat(255)};
 const background=element=>{const ancestors=[];for(let node=element;node;node=node.parentElement)ancestors.unshift(node);return ancestors.reduce((color,node)=>compose(rgba(getComputedStyle(node).backgroundColor),color),[255,255,255,255])};
 const luminance=color=>color.slice(0,3).map(value=>{value/=255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4}).reduce((total,value,index)=>total+value*[.2126,.7152,.0722][index],0);
 const editor=document.querySelector('.fixture-editor'),buttons=[...editor.querySelectorAll('button:not(:disabled)')],disabled=editor.querySelector('button:disabled'),results=[];
 document.documentElement.style.setProperty('--te-font-size-body','14px');
 for(const theme of ['pureWhite','dark']){
  document.documentElement.dataset.theme=theme;await settle();
  for(const button of buttons){const ink=luminance(rgba(getComputedStyle(button).color)),surface=luminance(background(button)),contrast=(Math.max(ink,surface)+.05)/(Math.min(ink,surface)+.05);expect(contrast>=4.5,'enabled editor command resembles a disabled control: '+JSON.stringify({theme,label:button.textContent,contrast}));expect(getComputedStyle(button).opacity==='1','enabled editor command is faded');results.push({theme,label:button.textContent,contrast:Number(contrast.toFixed(2))});}
  expect(Number(getComputedStyle(disabled).opacity)<1,'disabled editor command loses its visual distinction');
 }
 return results;
}`
