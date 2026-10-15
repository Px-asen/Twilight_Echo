import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('chrome properties edit one reversible appearance draft without importing live settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-appearance-chrome-'))
  const artifactDirectory = process.env.TWILIGHT_CHROME_ARTIFACT_DIR
    ? resolve(process.env.TWILIGHT_CHROME_ARTIFACT_DIR)
    : undefined
  try {
    if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true })
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      root: directory,
      logLevel: 'error',
      plugins: [
        vue(),
        {
          name: 'keep-chrome-properties-independent',
          generateBundle() {
            assert.ok(
              ![...this.getModuleIds()].some((id) =>
                /(?:useSettingsStore|NavigationPagesDialog|PlayerBarLayoutSettings|AppearanceSettingsSection)/.test(
                  id
                )
              ),
              'Compact properties imported a live settings store or full settings editor'
            )
          }
        }
      ],
      define: { 'process.env.NODE_ENV': '"production"' },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@shared': resolve('src/shared'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          'primeicons/primeicons.css': require.resolve('primeicons/primeicons.css'),
          '@phosphor-icons/web/regular': require.resolve('@phosphor-icons/web/regular'),
          '@phosphor-icons/web/bold': require.resolve('@phosphor-icons/web/bold'),
          '@phosphor-icons/web/fill': require.resolve('@phosphor-icons/web/fill')
        }
      },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'ChromePropertiesTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="off"><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{margin:0;background:#17181a}.fixture{width:264px;height:540px;margin:24px}</style></head><body><section class="fixture appearance-editor appearance-editor--embedded appearance-editor--character"><div id="mount" class="appearance-character-body"></div></section><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /CHROME_OK/)
    const metrics = JSON.parse(result.stdout.match(/CHROME_METRICS (.*)/)![1])
    console.info('Chrome properties:', JSON.stringify(metrics))
    if (artifactDirectory)
      await writeFile(
        join(artifactDirectory, 'chrome-validation.json'),
        JSON.stringify({ result: 'PASS', ...metrics }, null, 2) + '\n'
      )
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-appearance-chrome-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path'),fs=require('node:fs');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1024,height:700,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 const press=async(key,code,virtualKey,text)=>{await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,...(text?{text,unmodifiedText:text}:{})});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey})};
 try{
  await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const behavior=await win.webContents.executeJavaScript('window.runChromeTests()');
  await win.webContents.executeJavaScript('window.prepareChromeKeyboard()');await press('Enter','Enter',13,'\\r');await win.webContents.executeJavaScript('window.verifyChromeKeyboardDisclosure()');await press(' ','Space',32,' ');await win.webContents.executeJavaScript('window.verifyChromeKeyboardCheckbox()');await press('Enter','Enter',13,'\\r');await win.webContents.executeJavaScript('window.verifyChromeKeyboardMove()');
  const layout=await win.webContents.executeJavaScript('window.verifyChromeGeometry()');
  if(process.env.TWILIGHT_CHROME_ARTIFACT_DIR){for(const tone of ['light','dark'])for(const part of ['navigation','player-bar']){const rect=await win.webContents.executeJavaScript('window.prepareChromeIllustration('+JSON.stringify(tone)+','+JSON.stringify(part)+')');fs.writeFileSync(path.join(process.env.TWILIGHT_CHROME_ARTIFACT_DIR,'chrome-'+tone+'-'+part+'.png'),(await win.webContents.capturePage(rect)).toPNG())}}
  win.setContentSize(520,480);const narrow=await win.webContents.executeJavaScript('window.verifyChromeNarrow()');
  console.log('CHROME_METRICS',JSON.stringify({behavior,layout,narrow,nativeKeyboard:true,liveSettingsImported:false}));
  win.webContents.debugger.detach();console.log('CHROME_OK');app.exit(0);
 }catch(error){console.error(error.stack);app.exit(1)}
});
`

const runtime = `
import {createApp,h,nextTick,ref} from 'vue'
import Inspector from '@renderer/components/AppearanceSurfaceInspector.vue'
import {useAppearanceDraft} from '@renderer/composables/useAppearanceDraft'
import {useAppearanceHistory} from '@renderer/composables/useAppearanceHistory'
import {cloneAppearance,defaultCardAppearance,normalizeAppBackgroundSettings} from '@shared/appAppearance'
import {normalizeLiquidGlass} from '@shared/liquidGlass'
import {normalizePlayerBarSettings} from '@shared/playerBar'
import {DEFAULT_PLAYER_BAR_LAYOUT} from '@shared/playerBarLayout'
import {buildNavigationPages,orderNavigationPages} from '@renderer/app/navigationPages'
import {buildSidebarEntries} from '@renderer/app/sidebarNavigation'
import '@renderer/assets/base.css'
import '@renderer/assets/materials.css'
import '@renderer/assets/icon-fonts'
import 'primeicons/primeicons.css'
import '@renderer/components/settings-page/SettingsPage.css'
import '@renderer/components/settings-page/BackgroundAppearanceCustomizer.css'
const expect=(value,message)=>{if(!value)throw Error(message)}
const settle=async()=>{await nextTick();for(let i=0;i<2;i++)await new Promise(resolve=>requestAnimationFrame(resolve))}
const seed=()=>cloneAppearance({appBackground:normalizeAppBackgroundSettings(undefined),cardAppearance:defaultCardAppearance(),surfaceMaterial:'standard',liquidGlass:normalizeLiquidGlass(undefined),navigationPages:{version:1,order:['local-home','search','plugin:inactive:kept'],hidden:['plugin:inactive:kept']},playerBar:normalizePlayerBarSettings(undefined)})
const pages=buildNavigationPages([{kind:'sidebarPage',pluginId:'example',id:'tools',title:'插件工具',description:'示例插件页面',icon:'pi pi-wrench'}]);
let confirmed=seed(),history,emissions=0;const writes=[];
const session=useAppearanceDraft({confirmed:()=>confirmed,persist:async draft=>{writes.push(cloneAppearance(draft));confirmed=cloneAppearance(draft)},preview:async()=>{}});
const part=ref('navigation'),tone=ref('dark'),busy=ref(false),collapsed=ref(false);
createApp({setup(){history=useAppearanceHistory(()=>session.state.draft,draft=>session.state.draft=draft);return ()=>h(Inspector,{draft:session.state.draft,part:part.value,tone:tone.value,playerMode:session.state.draft.playerBar?.mode,pages,busy:busy.value,collapsed:collapsed.value,'onUpdate:draft':draft=>{emissions++;session.state.draft=draft},'onUpdate:collapsed':value=>collapsed.value=value})}}).mount('#mount');
const snapshot=()=>JSON.stringify(session.state.draft),chrome=()=>document.querySelector('.appearance-chrome-settings');
const click=async selector=>{const element=document.querySelector(selector);expect(element,'Missing '+selector);element.click();await settle()};
const change=async(selector,value)=>{const element=document.querySelector(selector);expect(element,'Missing '+selector);element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));await settle()};
const parameters=async()=>{if(document.querySelector('.appearance-parameters-button')?.getAttribute('aria-expanded')!=='true')await click('.appearance-parameters-button')};
const open=async()=>{await parameters();if(!chrome().open)await click('.appearance-chrome-settings summary');await document.fonts.ready;expect(chrome().open&&chrome().querySelector('fieldset'),'chrome properties did not open')};
const choose=async value=>{part.value=value;await settle();if(value==='navigation'||value==='player-bar')await parameters()};
const discard=async()=>{await session.cancel();session.begin();history.reset();await settle()};
const onlyMaterial=draft=>JSON.stringify({appBackground:draft.appBackground,cardAppearance:draft.cardAppearance,surfaceMaterial:draft.surfaceMaterial,liquidGlass:draft.liquidGlass});
const controlIds=()=>[...chrome().querySelectorAll('[data-player-control]')].map(row=>row.dataset.playerControl);
const region=async name=>click('[data-control-region="'+name+'"]');
window.runChromeTests=async()=>{
 await settle();const baseline=snapshot(),confirmedBaseline=JSON.stringify(confirmed),materialBaseline=onlyMaterial(confirmed);
 expect(!chrome(),'closed material parameters eagerly render chrome properties');await parameters();expect(!chrome().open&&!chrome().querySelector('fieldset'),'closed chrome eagerly renders all controls');await open();expect(snapshot()===baseline&&!writes.length,'opening chrome writes settings');const icon=chrome().querySelector('[data-navigation-page="local-home"] .theme-icon'),glyph=[...icon.querySelectorAll('.theme-icon-glyph')].find(element=>getComputedStyle(element).display!=='none'),font=getComputedStyle(glyph).fontFamily;expect(icon.getBoundingClientRect().width<=16&&getComputedStyle(glyph,'::before').content!=='none'&&/Phosphor/.test(font)&&document.fonts.check('12px '+font),'navigation icon stretches or has no loaded real glyph');
 expect(!chrome().querySelector('[aria-label="显示统计仪表盘"]').checked,'optional hidden pages are incorrectly checked');expect(chrome().querySelector('[data-navigation-page="plugin:example:tools"] .pi-wrench'),'plugin page loses its actual icon');
 await click('[aria-label="显示主页"]');expect(session.state.draft.navigationPages.hidden.includes('local-home'),'navigation checkbox does not change draft');await click('[aria-label="显示主页"]');
 await click('[aria-label="下移推荐主页"]');let prefs=session.state.draft.navigationPages;expect(prefs.order.indexOf('streaming-home')>prefs.order.indexOf('discover'),'same-column page move is lost');
 await click('[aria-label="下移主页"]');prefs=session.state.draft.navigationPages;const rootEntries=buildSidebarEntries(orderNavigationPages(pages,prefs)).filter(entry=>entry.kind==='page'&&['local-home','search','recent'].includes(entry.page.id)).map(entry=>entry.page.id);expect(JSON.stringify(rootEntries)===JSON.stringify(['recent','local-home','search']),'property order differs from the actual sidebar');expect(prefs.order.indexOf('recent')<prefs.order.indexOf('local-home')&&prefs.order.indexOf('search')===prefs.order.indexOf('local-home')+1,'home/search move violates the actual sidebar adjacency');
 expect(chrome().querySelector('[aria-label="上移最近播放"]').disabled,'root group reports an unavailable boundary move');const beforePluginHide=snapshot();history.reset();await click('[aria-label="显示插件工具"]');expect(session.state.draft.navigationPages.hidden.includes('plugin:example:tools'),'plugin visibility does not use its stable id');
 const navChanged=snapshot();history.undo();await settle();expect(snapshot()===beforePluginHide,'history drops or splits chrome draft');history.redo();await settle();expect(snapshot()===navChanged,'redo loses navigation edits');
 await click('.appearance-chrome-reset');expect(session.state.draft.navigationPages.order.includes('plugin:inactive:kept')&&session.state.draft.navigationPages.hidden.includes('plugin:inactive:kept'),'navigation reset discards disabled-plugin preferences');expect(!session.state.draft.navigationPages.hidden.includes('plugin:example:tools')&&session.state.draft.navigationPages.hidden.includes('analytics'),'navigation reset does not restore default visibility');
 expect(onlyMaterial(session.state.draft)===materialBaseline&&JSON.stringify(confirmed)===confirmedBaseline&&!writes.length,'navigation editing mutates saved settings or appearance');await discard();expect(snapshot()===baseline,'discard fails to restore the full navigation snapshot');
 await choose('player-bar');expect(!chrome().open&&!chrome().querySelector('fieldset'),'new part inherits an expanded heavy property list');await open();expect(chrome().querySelector('[aria-label="移除上一首 / 播放 / 下一首"]').disabled,'last playback control is removable');
 await change('[aria-label="往中间添加按钮"]','queue');expect(controlIds().includes('queue')&&!session.state.draft.playerBar.layout.standard.right.includes('queue'),'adding a placed control does not move it');expect(Object.values(session.state.draft.playerBar.layout.standard).flat().filter(id=>id==='queue').length===1,'control appears in two regions');
 await click('[aria-label="把播放列表往前移"]');expect(controlIds().indexOf('queue')<controlIds().indexOf('volume'),'button step move is lost');await click('[aria-label="移除播放列表"]');expect(!Object.values(session.state.draft.playerBar.layout.standard).flat().includes('queue'),'button removal is lost');
 const standardChanged=JSON.stringify(session.state.draft.playerBar.layout.standard);await change('[aria-label="播放栏形态"]','mini');expect(session.state.draft.playerBar.mode==='mini'&&session.state.draft.playerBar.modeSource==='user'&&chrome().querySelector('[data-control-region="left"]').getAttribute('aria-pressed')==='true','shape selection does not select the actual draft mode');
 await region('right');await change('[aria-label="往右侧添加按钮"]','favorite');const miniChanged=JSON.stringify(session.state.draft.playerBar.layout.mini);await change('[aria-label="播放栏形态"]','compact');await region('right');await change('[aria-label="往右侧添加按钮"]','playPause');await click('[aria-label="移除退出播放页"]');
 const beforeShapeReset=snapshot();history.reset();await click('.appearance-chrome-reset');expect(JSON.stringify(session.state.draft.playerBar.layout.compact)===JSON.stringify(DEFAULT_PLAYER_BAR_LAYOUT.compact)&&JSON.stringify(session.state.draft.playerBar.layout.standard)===standardChanged&&JSON.stringify(session.state.draft.playerBar.layout.mini)===miniChanged,'reset affects another shape or ignores current shape');
 const playerChanged=snapshot();history.undo();await settle();expect(snapshot()===beforeShapeReset,'undo loses player chrome or navigation snapshot');history.redo();await settle();expect(snapshot()===playerChanged,'redo loses independent shape layouts');
 busy.value=true;await settle();const busySnapshot=snapshot(),busyEmissions=emissions;expect([...chrome().querySelectorAll('input,select,button')].every(element=>element.matches(':disabled')),'busy properties leave native controls actionable');await change('[aria-label="播放栏形态"]','standard');await change('[aria-label="往右侧添加按钮"]','time');expect(snapshot()===busySnapshot&&emissions===busyEmissions,'busy synthetic change bypasses guards');busy.value=false;await settle();
 expect(onlyMaterial(session.state.draft)===materialBaseline&&JSON.stringify(confirmed)===confirmedBaseline&&!writes.length,'player editing persists immediately or changes material settings');await discard();expect(snapshot()===baseline,'discard changes inactive shape layouts');
 await choose('navigation');await open();await click('[aria-label="显示所有歌曲"]');await choose('player-bar');await open();await change('[aria-label="往中间添加按钮"]','queue');const joint=snapshot();expect(await session.save(),'joint draft cannot apply');expect(writes.length===1&&JSON.stringify(writes[0])===joint&&writes[0].navigationPages.hidden.includes('allSongs')&&writes[0].playerBar.layout.standard.center.includes('queue'),'appearance and chrome do not save together once');
 confirmed=seed();session.begin();history.reset();await choose('navigation');await settle();
 return {independentShapes:3,navGrouping:true,homeSearchAdjacency:true,unknownPluginPreserved:true,lastPlaybackProtected:true,history:true,discard:true,explicitJointWrites:writes.length};
};
let keyboardBaseline;
window.prepareChromeKeyboard=async()=>{confirmed=seed();session.begin();history.reset();await choose('card');await choose('navigation');keyboardBaseline=snapshot();chrome().querySelector('summary').focus()};
window.verifyChromeKeyboardDisclosure=async()=>{await settle();expect(chrome().open&&chrome().querySelector('fieldset')&&snapshot()===keyboardBaseline,'Enter cannot open chrome without editing');const style=getComputedStyle(document.activeElement);expect(style.outlineStyle==='solid'&&style.outlineWidth==='2px','summary has no distinct keyboard focus');const rgb=style.outlineColor.match(/[\\d.]+/g).slice(0,3).map(Number);expect(Math.max(...rgb)-Math.min(...rgb)<=4,'chrome keyboard focus is blue');chrome().querySelector('[aria-label="显示主页"]').focus()};
window.verifyChromeKeyboardCheckbox=async()=>{await settle();expect(session.state.draft.navigationPages.hidden.includes('local-home'),'Space cannot toggle a native visibility checkbox');chrome().querySelector('[aria-label="下移推荐主页"]').focus()};
window.verifyChromeKeyboardMove=async()=>{await settle();const prefs=session.state.draft.navigationPages;expect(prefs.order.indexOf('streaming-home')>prefs.order.indexOf('discover'),'Enter cannot reorder a navigation button');expect(writes.length===1,'keyboard edits persist unexpectedly')};
window.prepareChromeIllustration=async(currentTone,currentPart)=>{document.documentElement.dataset.theme=currentTone==='dark'?'dark':'pureWhite';tone.value=currentTone;confirmed=seed();session.begin();history.reset();await choose('card');await choose(currentPart);await open();document.activeElement?.blur();await settle();const rect=document.querySelector('.appearance-inspector').getBoundingClientRect();return {x:Math.floor(rect.x),y:Math.floor(rect.y),width:Math.ceil(rect.width),height:Math.ceil(rect.height)}};
window.verifyChromeGeometry=async()=>{const metrics=[];for(const currentTone of ['light','dark'])for(const currentPart of ['navigation','player-bar']){await window.prepareChromeIllustration(currentTone,currentPart);const panel=document.querySelector('.appearance-inspector'),body=panel.querySelector('.appearance-inspector-body'),rect=panel.getBoundingClientRect(),style=getComputedStyle(panel);expect(rect.width===240&&rect.height<=460&&body.scrollWidth<=body.clientWidth,'chrome expands or horizontally clips its property allocation');for(const row of chrome().querySelectorAll('li'))expect(row.scrollWidth<=row.clientWidth,'chrome row overflows');for(const element of chrome().querySelectorAll('button,select'))expect(element.getBoundingClientRect().height>=32,'chrome controls are too small');expect(style.backgroundColor===(currentTone==='dark'?'rgb(32, 34, 38)':'rgb(247, 247, 248)')&&style.backdropFilter==='none'&&style.boxShadow==='none','chrome alters the opaque neutral property backplate');metrics.push({tone:currentTone,part:currentPart,width:rect.width,height:rect.height,background:style.backgroundColor,scrollable:body.scrollHeight>body.clientHeight})}return metrics};
window.verifyChromeNarrow=async()=>{const fixture=document.querySelector('.fixture');fixture.style.width='220px';fixture.style.height='360px';await window.prepareChromeIllustration('dark','navigation');const panel=document.querySelector('.appearance-inspector'),body=panel.querySelector('.appearance-inspector-body'),input=chrome().querySelector('[aria-label="显示统计仪表盘"]');input.focus();await settle();const rect=panel.getBoundingClientRect(),bodyRect=body.getBoundingClientRect(),inputRect=input.getBoundingClientRect();expect(rect.width<=196&&rect.height<=168&&body.scrollWidth<=body.clientWidth&&panel.scrollTop>0&&inputRect.top>=rect.top&&inputRect.bottom<=rect.bottom,'narrow navigation fields cannot be reached or clip: '+JSON.stringify({width:rect.width,height:rect.height,scrollWidth:body.scrollWidth,clientWidth:body.clientWidth,scrollTop:body.scrollTop,bodyTop:bodyRect.top,bodyBottom:bodyRect.bottom,inputTop:inputRect.top,inputBottom:inputRect.bottom,hidden:input.closest('[inert]')?.tagName}));await choose('player-bar');await open();await region('right');for(const row of chrome().querySelectorAll('li'))expect(row.scrollWidth<=row.clientWidth,'narrow player buttons overflow');const baseline=snapshot();await click('[aria-label="收起属性"]');expect(panel.getBoundingClientRect().height<70&&snapshot()===baseline,'collapsed chrome changes draft or covers the canvas');return {width:rect.width,height:rect.height,nativeScroll:true,playerRowsFit:true,collapsedHeight:panel.getBoundingClientRect().height}};
`
