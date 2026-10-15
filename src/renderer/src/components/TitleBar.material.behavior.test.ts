import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { compileStyle, parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.url)

test('ordinary captions diffuse their backdrop while immersive captions inherit playback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-caption-material-'))
  try {
    const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8')
    const source = parse(await read('./TitleBar.vue')).descriptor.styles[0].content
    const compiled = compileStyle({
      source,
      filename: 'TitleBar.vue',
      id: 'data-v-caption',
      scoped: true
    })
    assert.deepEqual(compiled.errors, [])
    const attached = await Promise.all(
      ['SideMenu.vue', 'SidebarBookmark.vue'].map(async (filename) => {
        const descriptor = parse(await read('./' + filename)).descriptor
        const result = compileStyle({
          source: descriptor.styles[0].content,
          filename,
          id: 'data-v-caption',
          scoped: true
        })
        assert.deepEqual(result.errors, [])
        return result.code
      })
    )
    const styles = [
      await read('../assets/base.css'),
      await read('../assets/materials.css'),
      await read('../assets/appearance.css'),
      (await read('../assets/main.css')).replace(/^@import[^;]+;/gm, ''),
      await read('../assets/overlay-sidebars.css'),
      ...parse(await read('../App.vue')).descriptor.styles.map((style) => style.content),
      compiled.code,
      ...attached
    ].join('\n')
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-platform="win32"><head>
      <meta charset="utf-8"><style>${styles}
      html,body{margin:0;width:100%;height:100%;overflow:hidden}
      body{background:#16181b}
      .sample-backdrop{position:fixed;inset:0;background:repeating-linear-gradient(90deg,#e64343 0 6px,#2059b8 6px 12px);pointer-events:none}
      .app-shell-title{z-index:2100}
      .app-shell{position:relative;isolation:isolate;--te-app-bg:#17181a;--te-player-bg:#08121d;--te-shell-control-text:#f4f7fb;
        --te-lg-context-material:rgb(18 28 45 / 38%);--te-lg-context-surface-solid:#121c2d;
        --te-lg-context-label:#f8fafc;--te-lg-context-diffusion:20px}
      .title-bar-start button{width:46px;height:40px;color:inherit;border:0;background:transparent}
      *,*::before,*::after{transition:none!important}
      </style></head><body><div class="sample-backdrop"></div><div class="app-shell"><div class="app-shell-title">
      <div data-te-material="titlebar" class="title-bar" data-v-caption><div class="title-bar-background" data-v-caption></div>
      <div class="title-bar-start" data-v-caption><button class="menu-btn" data-v-caption aria-label="导航">☰</button></div>
      <div class="title-bar-controls" data-v-caption><div class="title-bar-tools" data-v-caption>
      <button class="settings-btn" data-v-caption aria-pressed="true" aria-label="设置">⚙</button>
      <button class="settings-btn appearance-btn" data-v-caption aria-pressed="true" aria-label="外观">◇</button>
      <button class="control-btn notification-btn" data-v-caption aria-expanded="true" aria-label="通知">♧</button>
      </div><div class="title-bar-window-controls" data-v-caption><button class="control-btn close" data-v-caption aria-label="关闭">×</button></div></div>
      </div></div><aside class="side-menu overlay-side-panel open" data-te-material="navigation" data-v-caption></aside><button class="sidebar-bookmark" data-v-caption tabindex="-1"></button></div><script>
      const title=document.querySelector('.title-bar'),painter=document.querySelector('.title-bar-background'),nav=document.querySelector('.side-menu'),bookmark=document.querySelector('.sidebar-bookmark');
      window.prepare=(tone,page,liquid)=>{
        document.documentElement.dataset.theme=tone;
        document.documentElement.dataset.teLiquidGlassSource='solid';
        title.className='title-bar'+(page==='playing'?' title-bar-immersive':page==='settings'?' title-bar-settings':page==='streaming'?' title-bar-streaming':'')+(liquid&&page!=='playing'?' title-bar-liquid':'');
        nav.classList.toggle('side-menu-liquid',liquid);bookmark.classList.toggle('sidebar-bookmark-liquid',liquid);
        document.querySelector('.sample-backdrop').style.background='repeating-linear-gradient(90deg,#e64343 0 6px,#2059b8 6px 12px)';
        const style=getComputedStyle(painter),host=getComputedStyle(title),rect=title.getBoundingClientRect();
        const navigation=getComputedStyle(nav,liquid?'::before':null),handle=getComputedStyle(bookmark,'::before'),base=getComputedStyle(document.querySelector('.app-shell'));
        if(page!=='playing'&&((liquid&&navigation.backgroundColor!==style.backgroundColor)||navigation.backdropFilter!==style.backdropFilter||handle.backgroundColor!==navigation.backgroundColor||handle.backdropFilter!==navigation.backdropFilter))throw Error('attached sidebar, bookmark and title use different materials: '+JSON.stringify({liquid,title:[style.backgroundColor,style.backdropFilter],nav:[navigation.backgroundColor,navigation.backdropFilter],handle:[handle.backgroundColor,handle.backdropFilter]}));
        if(getComputedStyle(nav).boxShadow!=='none')throw Error('attached sidebar creates floating panel elevation');
        if(base.backgroundColor==='rgba(0, 0, 0, 0)'||base.backgroundImage!=='none')throw Error('window loses its continuous base or duplicates the wallpaper');
        if(page==='playing'){
          if(style.backdropFilter!=='none'||style.backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('immersive caption adds a separate material');
        }else if(!style.backdropFilter.includes('blur('))throw Error('missing diffusion: '+tone+'/'+page+'/'+liquid);
        if(style.backgroundImage!=='none'||style.boxShadow!=='none'||host.boxShadow!=='none')throw Error('caption creates a second decorative band');
        if(host.backgroundImage!=='none'||host.backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('caption host masks its backdrop');
        const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=style.backgroundColor;x.fillRect(0,0,1,1);const alpha=x.getImageData(0,0,1,1).data[3]/255;if(page!=='playing'&&(liquid?alpha>.31||alpha<.2:alpha!==0))throw Error('caption duplicates the window-base tint: '+alpha);
        if(rect.height!==40||rect.left!==0||rect.right!==innerWidth)throw Error('caption geometry changed');
        if(document.elementFromPoint(22,20)?.closest('button')===null)throw Error('material intercepts navigation input');
        for(const button of title.querySelectorAll('.title-bar-tools button')){
          const state=getComputedStyle(button),feedback=getComputedStyle(button,'::before'),box=button.getBoundingClientRect();
          if(box.width!==46||box.height!==40)throw Error('tool hit area changed');
          if(feedback.top!=='5px'||feedback.left!=='7px'||feedback.borderRadius!=='9px')throw Error('tool feedback is not inset and rounded');
          if(feedback.backgroundColor==='rgba(0, 0, 0, 0)')throw Error('selection depends on icon colour alone');
          if(state.backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('tool paints a full caption rectangle');
          if(document.elementFromPoint(box.left+2,box.top+2)!==button)throw Error('inset feedback shrinks the click target');
        }
        if(getComputedStyle(title.querySelector('.close')).borderRadius!=='0px')throw Error('tool styling changes native window buttons');
      };
      window.checkFallback=(kind)=>{
        const root=document.documentElement;
        if(kind==='effects')root.dataset.teEffectsMode='reduced';
        if(kind==='blur')document.body.classList.add('te-no-blur');
        if(kind==='transparent')root.dataset.teSurfaceMaterial='transparent';
        const style=getComputedStyle(painter);
        if(style.backdropFilter!=='none')throw Error('fallback still blurs: '+kind);
        if(kind==='transparent'&&style.backgroundColor!=='rgba(0, 0, 0, 0)')throw Error('transparent preference leaves a painted strip');
        if(kind!=='transparent'&&style.backgroundColor.includes(' / '))throw Error('accessibility fallback remains translucent');
        if(matchMedia('(forced-colors: active)').matches){
          const selected=title.querySelector('.settings-btn');
          if(getComputedStyle(selected).forcedColorAdjust!=='none'||getComputedStyle(selected,'::before').backgroundColor==='rgba(0, 0, 0, 0)')throw Error('system colours lose the selected tool');
        }else if(matchMedia('(prefers-contrast: more)').matches){
          const selected=title.querySelector('.settings-btn'),probe=document.createElement('span');
          probe.style.color='var(--te-shell-control-text)';title.append(probe);
          if(getComputedStyle(selected).color!==getComputedStyle(probe).color)throw Error('high contrast tool retains low contrast tint');
          probe.remove();
        }
        delete root.dataset.teEffectsMode;delete root.dataset.teSurfaceMaterial;document.body.classList.remove('te-no-blur');
      };
      window.checkSharedMaterial=()=>{
        const root=document.documentElement,player=document.querySelector('.player-bar');
        root.style.setProperty('--te-chrome-frosted-surface','rgb(52 78 96 / 68%)');
        root.style.setProperty('--te-chrome-frosted-blur','30px');
        root.style.setProperty('--te-chrome-frosted-saturation','135%');
        const caption=getComputedStyle(painter),playback=getComputedStyle(player);
        if(caption.backgroundColor!==playback.backgroundColor||caption.backdropFilter!==playback.backdropFilter||!caption.backdropFilter.includes('blur(30px)'))throw Error('shared material override does not reach both surfaces');
        for(const name of ['surface','blur','saturation'])root.style.removeProperty('--te-chrome-frosted-'+name);
      };
      </script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,nativeImage}=require('electron');
      app.setPath('userData',require('node:path').join(__dirname,'profile'));
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,width:800,height:400,useContentSize:true,webPreferences:{offscreen:{deviceScaleFactor:1},contextIsolation:false,backgroundThrottling:false}});
        try{
          await win.loadFile(process.argv.at(-1));win.webContents.debugger.attach('1.3');
          const js=async source=>{
            const result=await win.webContents.executeJavaScript('(()=>{try{'+source+';return null}catch(error){return String(error)}})()');
            if(result)throw Error(result+' ['+source+']');
          };
          const capture=async()=>nativeImage.createFromBuffer(Buffer.from((await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true})).data,'base64')).toBitmap();
          const settle=()=>new Promise(resolve=>setTimeout(resolve,90));
          const difference=(a,b)=>{let sum=0;for(let x=180;x<620;x++)for(let c=0;c<3;c++)sum+=Math.abs(a[(20*800+x)*4+c]-b[(20*800+x)*4+c]);return sum/(440*3)};
          for(const tone of ['dark','pureWhite'])for(const page of ['home','streaming','settings','playing'])for(const liquid of [false,true]){
            await js('prepare('+JSON.stringify(tone)+','+JSON.stringify(page)+','+liquid+')');await settle();
            const blurred=await capture();
            await js('document.querySelector(".title-bar-background").style.backdropFilter="none"');await settle();
            const sharp=await capture();
            if(page==='playing'){
              if(difference(blurred,sharp)>.1)throw Error('immersive caption applies a second diffusion');
            }else if(difference(blurred,sharp)<4)throw Error('blur property does not diffuse actual backdrop pixels: '+tone+'/'+page+'/'+liquid);
            await js('document.querySelector(".title-bar-background").style.backdropFilter="";document.querySelector(".sample-backdrop").style.background="#44ab62"');await settle();
            if(difference(blurred,await capture())<10)throw Error('caption hides backdrop colour');
            if(page==='home'&&!liquid){const pixels=await capture(),at=y=>[0,1,2].map(channel=>pixels[(y*800+400)*4+channel]),title=at(20),gap=at(42),inner=at(65);if(gap.some((value,channel)=>Math.abs(value-title[channel])>3))throw Error('title and outer foundation have different colours: '+JSON.stringify({tone,title,gap}));const lift=inner.reduce((sum,value,channel)=>sum+value-title[channel],0)/3;if(lift<5||lift>24||inner.some((value,channel)=>value<title[channel]-3))throw Error('outer foundation is not subtly deeper than content: '+JSON.stringify({tone,title,inner,lift}));}
            for(const kind of ['effects','blur','transparent'])await js('checkFallback('+JSON.stringify(kind)+')');
            for(const [name,value] of [['prefers-reduced-transparency','reduce'],['prefers-contrast','more'],['forced-colors','active']]){
              await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name,value}]});
              try{await js('checkFallback("media")')}catch(error){throw Error(tone+'/'+page+'/'+liquid+'/'+name+': '+error)}
              await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
            }
          }
          await js('prepare("dark","home",false);checkSharedMaterial()');
          await js('prepare("dark","home",true)');
          const point=await win.webContents.executeJavaScript('(()=>{const r=document.querySelector(".settings-btn").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:20}})()');
          win.webContents.sendInputEvent({type:'mouseMove',...point});await settle();
          await js('const b=document.querySelector(".settings-btn");if(!b.matches(":hover"))throw Error("tool does not receive real hover");if(getComputedStyle(b).backgroundColor!=="rgba(0, 0, 0, 0)")throw Error("hover becomes a full strip")');
          win.webContents.sendInputEvent({type:'mouseMove',x:350,y:200});
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
          await js('const b=document.activeElement;if(b.tagName!=="BUTTON"||!b.matches(":focus-visible")||getComputedStyle(b,"::before").outlineWidth!=="2px")throw Error("keyboard focus feedback missing")');
          console.error('CAPTION_MATERIAL_OK 16 page/tone/material combinations');app.exit(0);
        }catch(error){console.error(error);app.exit(1)}
      });`
    )
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const { stderr } = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90_000, env: environment }
    )
    assert.match(stderr, /CAPTION_MATERIAL_OK 16/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('scrolled homepage artwork reaches the caption and is visibly diffused by its material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-caption-scroll-'))
  try {
    const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8')
    const main = await read('../assets/main.css')
    const shell = main.slice(main.indexOf('/* Windows owns'), main.indexOf('/* Active lyrics'))
    const compile = (source: string): string => {
      const result = compileStyle({
        source,
        filename: 'CaptionScroll.css',
        id: 'data-v-scroll',
        scoped: true
      })
      assert.deepEqual(result.errors, [])
      return result.code
    }
    const styles = [
      await read('../assets/base.css'),
      await read('../assets/bohr.css'),
      ...parse(await read('../App.vue')).descriptor.styles.map((style) => style.content),
      compile(await read('./LocalDashboard.css')),
      compile(parse(await read('./local-dashboard/LocalHome.vue')).descriptor.styles[0].content),
      compile(parse(await read('./TitleBar.vue')).descriptor.styles[0].content),
      shell
    ].join('\n')
    const scope = 'data-v-scroll'
    const cards = ['#dc4650', '#276bd4', '#25946b', '#af66c5', '#dc9a36', '#32838c']
      .map(
        (color, index) =>
          `<button class="fresh-tile" ${scope}><span class="fresh-cover" ${scope} style="background:${color}"><span class="cover-art" ${scope}></span></span><strong class="fresh-name" ${scope}>Music ${index + 1}</strong></button>`
      )
      .join('')
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite"><head><meta charset="utf-8"><style>${styles}
      html,body{margin:0;height:100%;overflow:hidden}html{--te-titlebar-inset:40px}
      *,*::before,*::after{animation:none!important;transition:none!important}
      .cover-art{display:block;height:100%;background:repeating-linear-gradient(90deg,#e64343 0 6px,#2059b8 6px 12px)}
      .fresh-name{display:block;margin-top:10px}.title-bar-start{padding-inline:14px}
      </style></head><body><div class="app-shell">
      <div class="app-shell-title"><div class="title-bar" ${scope}><div class="title-bar-background" ${scope}></div><div class="title-bar-start" ${scope}><button class="menu-btn" ${scope} aria-label="导航">☰</button></div><div class="title-bar-controls" ${scope}><button class="control-btn close" ${scope} aria-label="关闭">×</button></div></div></div>
      <div class="app-shell-content"><div class="main-content"><div class="local-home-layout" ${scope}><div class="home" ${scope}><main class="home-inner" ${scope}>
      <header class="masthead" ${scope}><h1 ${scope}>本地音乐</h1></header>
      ${Array.from({ length: 4 }, () => `<section class="content-block" ${scope}><h2 ${scope}>最近添加</h2><div class="fresh-grid" ${scope}>${cards}</div></section>`).join('')}
      </main></div></div></div></div></div></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow,nativeImage}=require('electron');const fs=require('node:fs');const path=require('node:path');
      app.setPath('userData',path.join(__dirname,'profile'));
      app.whenReady().then(async()=>{
        const win=new BrowserWindow({show:false,frame:false,width:1000,height:640,useContentSize:true,webPreferences:{offscreen:true,backgroundThrottling:false}});
        try{
          await win.loadFile(path.join(__dirname,'index.html'));win.webContents.debugger.attach('1.3');
          const run=script=>win.webContents.executeJavaScript(script);
          const capture=async()=>Buffer.from((await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true})).data,'base64');
          const settle=()=>new Promise(resolve=>setTimeout(resolve,120));
          const difference=(a,b)=>{const x=nativeImage.createFromBuffer(a).toBitmap(),y=nativeImage.createFromBuffer(b).toBitmap();let sum=0;for(let row=12;row<30;row++)for(let col=180;col<760;col++)for(let c=0;c<3;c++)sum+=Math.abs(x[(row*1000+col)*4+c]-y[(row*1000+col)*4+c]);return sum/(18*580*3)};
          for(const tone of ['pureWhite','dark']){
            await run('document.documentElement.dataset.theme='+JSON.stringify(tone)+';document.querySelector(".home").scrollTop=0');await settle();
            const initial=await run('document.querySelector(".masthead").getBoundingClientRect().top');
            if(initial<44)throw Error('initial homepage content is covered by the caption');
            await run('(()=>{const home=document.querySelector(".home"),art=document.querySelector(".fresh-cover");home.scrollTop=art.getBoundingClientRect().top-10})()');await settle();
            const rect=await run('document.querySelector(".fresh-cover").getBoundingClientRect().toJSON()');
            if(rect.y>11||rect.y+rect.height<40)throw Error('scrolled cover never reaches the caption');
            if(!(await run('Boolean(document.elementFromPoint(24,20)?.closest(".menu-btn"))')))throw Error('scrolling page intercepts caption input');
            const frosted=await capture();
            await run('document.querySelector(".title-bar-background").style.backdropFilter="none"');await settle();
            const sharp=await capture();if(difference(frosted,sharp)<4)throw Error('caption does not blur real scrolled artwork: '+tone);
            await run('document.querySelector(".title-bar-background").style.backdropFilter="";document.querySelectorAll(".cover-art").forEach(el=>el.style.background="#44ab62")');await settle();
            if(difference(frosted,await capture())<8)throw Error('caption masks the artwork colors: '+tone);
            await run('document.querySelectorAll(".cover-art").forEach(el=>el.style.background="")');await settle();
            if(process.env.TE_CAPTION_SCROLL_EVIDENCE){
              fs.mkdirSync(process.env.TE_CAPTION_SCROLL_EVIDENCE,{recursive:true});
              fs.writeFileSync(path.join(process.env.TE_CAPTION_SCROLL_EVIDENCE,tone+'-frosted.png'),frosted);
              await run('document.querySelector(".app-shell-content").style.top="44px"');await settle();
              fs.writeFileSync(path.join(process.env.TE_CAPTION_SCROLL_EVIDENCE,tone+'-clipped.png'),await capture());
              await run('document.querySelector(".app-shell-content").style.top=""');
            }
          }
          console.log('CAPTION_SCROLL_OK');app.exit(0);
        }catch(error){console.error(error.stack);app.exit(1)}
      });`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron') as string,
      [join(directory, 'runner.cjs')],
      {
        windowsHide: true,
        timeout: 30_000,
        env
      }
    )
    assert.match(result.stdout, /CAPTION_SCROLL_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})
