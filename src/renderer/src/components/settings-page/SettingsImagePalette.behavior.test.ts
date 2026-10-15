import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  backgroundCssVariables,
  normalizeAppBackgroundSettings,
  resolveBackgroundTextTone
} from '../../../../shared/appAppearance.ts'
import { themeContrastRatio } from '../../../../shared/theme.ts'
import { compileMaterialCss, readingMaterialTreatment } from '../../../../shared/materials.ts'
import { compileStyle, parse } from '@vue/compiler-sfc'

test('settings fields and search retain readable image colours and restore their theme after removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-settings-image-fields-'))
  try {
    const styles = await Promise.all(
      [
        'src/renderer/src/assets/base.css',
        'src/renderer/src/assets/appearance.css',
        'src/renderer/src/components/settings-page/SettingsPage.css',
        'src/renderer/src/components/settings-page/SettingsLayout.css',
        'src/renderer/src/components/settings-page/SettingsMarketLayout.css'
      ].map((path) => readFile(path, 'utf8'))
    )
    for (const path of [
      'src/renderer/src/components/SettingsPage.vue',
      'src/renderer/src/components/AppearancePage.vue',
      'src/renderer/src/components/AppearanceThemeSelection.vue',
      'src/renderer/src/components/AudioWorkspace.vue',
      'src/renderer/src/components/TitleBar.vue',
      'src/renderer/src/components/SideMenu.vue',
      'src/renderer/src/components/PluginPage.vue',
      'src/renderer/src/components/AnimatedInput.vue',
      'src/renderer/src/components/EqualizerPage.vue',
      'src/renderer/src/components/equalizer/GraphicEqPanel.vue',
      'src/renderer/src/components/equalizer/FrequencyResponseToolbar.vue',
      'src/renderer/src/components/equalizer/ParametricEqWorkspace.vue',
      'src/renderer/src/components/equalizer/ParametricEqBandInspector.vue'
    ]) {
      for (const style of parse(await readFile(path, 'utf8')).descriptor.styles) {
        const result = compileStyle({
          source: style.content,
          filename: path,
          id: path.endsWith('AppearancePage.vue')
            ? 'data-v-page'
            : path.endsWith('AppearanceThemeSelection.vue')
              ? 'data-v-selection'
              : path.endsWith('PluginPage.vue')
                ? 'data-v-plugin'
                : path.endsWith('AnimatedInput.vue')
                  ? 'data-v-input'
                  : path.endsWith('SideMenu.vue')
                    ? 'data-v-nav'
                    : 'data-v-dsp',
          scoped: !!style.scoped
        })
        assert.deepEqual(result.errors, [])
        styles.push(result.code)
      }
    }
    styles.push(compileMaterialCss())
    styles.push(
      compileStyle({
        source: await readFile(
          'src/renderer/src/components/local-dashboard/OnlineHome.css',
          'utf8'
        ),
        filename: 'OnlineHome.css',
        id: 'data-v-home',
        scoped: true
      }).code
    )
    for (const [filename, id] of [
      ['song-list/SongList.css', 'data-v-library'],
      ['streaming-page/StreamingContentHeader.css', 'data-v-stream']
    ]) {
      styles.push(
        compileStyle({
          source: await readFile('src/renderer/src/components/' + filename, 'utf8'),
          filename,
          id,
          scoped: true
        }).code
      )
    }
    const cases: {
      theme: 'pureWhite' | 'dark'
      average: string
      accent: string
      textTone: ReturnType<typeof resolveBackgroundTextTone>
      variables: Record<string, string>
    }[] = []
    for (const tone of ['light', 'dark'] as const) {
      for (const average of ['#101820', '#f5f1e9']) {
        for (const accent of ['#ec002c', '#1e50c8', '#2a995b', '#777777']) {
          const background = normalizeAppBackgroundSettings({
            global: {
              kind: 'image',
              image: 'background://field-palette.png',
              imagePalette: { image: 'background://field-palette.png', average, accent }
            }
          }).global
          cases.push({
            theme: tone === 'dark' ? 'dark' : 'pureWhite',
            average,
            accent,
            textTone: resolveBackgroundTextTone(background, tone),
            variables: Object.fromEntries(
              ['settings', 'app'].flatMap((page) =>
                Object.entries(backgroundCssVariables(background, tone)).map(([name, value]) => [
                  `--te-${page}-background-${name.slice('--appearance-'.length)}`,
                  value
                ])
              )
            )
          })
        }
      }
    }
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-te-motion="off"><head><meta charset="utf-8"><style>${styles.join('\n')}</style></head>
      <body class="te-settings-surface"><main class="settings-preview-page" data-settings-layout="categories" style="position:relative;inset:auto">
      <h1>设置</h1><select class="preview-select"><option>普通选择</option></select>
      <input class="number-input" type="number" value="36"><div class="path-control"><input value="本地路径"></div>
      <select class="preview-select" disabled><option>不可用</option></select>
      <div class="settings-market-search"><input type="search" value="歌词" placeholder="搜索设置"></div>
      <div class="settings-search-box"><input class="settings-search-input" placeholder="搜索设置"></div>
      <textarea placeholder="填写内容">说明</textarea>
      <button class="dashed-button">添加文件夹</button>
      <div class="segmented-control"><button class="active">选中模式</button></div>
      <div class="range-pill"><span>字号</span><strong>18px</strong></div>
      <div class="setting-item" id="feedback-row"><div class="setting-copy"><strong>设置行</strong></div><button class="soft-button">行内控件</button></div>
      </main>
      <main class="settings-preview-page appearance-page" data-appearance-workspace="selection" style="position:relative;inset:auto">
      <button aria-pressed="true">选中页签</button>
      <div class="appearance-theme-selection">
        <label class="theme-selection-search"><input type="search" placeholder="搜索主题"></label>
        <button class="theme-action-button">自定义当前主题</button>
        <button class="theme-action-button theme-action-primary">新建主题</button>
      </div></main>
      <main class="settings-preview-page appearance-page" data-appearance-workspace="customize" style="position:relative;inset:auto">
        <span class="appearance-save-status">当前外观已保存</span><button aria-pressed="true">整窗</button><select><option>中性编辑器材质</option></select>
      </main>
      <main class="online-home" style="position:relative;height:auto"><header class="online-section-heading"><h2>在线发现</h2><button class="online-text-button">发现歌单</button></header><section class="online-hero feature-card" data-te-material="content"><h2>首页卡片</h2><p class="online-hero-description">卡片说明</p></section><div class="online-login-strip"><span>登录后推荐</span><button class="online-text-button">去登录</button></div><div class="online-notice">提示</div><div class="online-empty">暂无推荐</div><label class="online-source-picker"><select><option>选择在线音源</option></select></label><nav class="home-library-switch"><button>音乐库入口</button></nav></main>
      <main class="song-list"><div class="search-box"><input class="search-input" placeholder="搜索本地音乐"></div></main>
      <main class="streaming-page"><div class="streaming-search-box"><div class="streaming-search-input animated-input"><input class="animated-input-field" placeholder="搜索流媒体音乐"><span class="animated-input-mirror">搜索流媒体音乐</span></div></div></main>
      <main class="audio-workspace" style="position:relative;height:auto;pointer-events:none">
      <header class="audio-workspace-header"><h1>DSP</h1><p class="audio-workspace-status">状态说明</p>
      <button class="audio-window-button">在独立窗口调节</button>
      <nav class="audio-workspace-tabs"><button aria-selected="true">均衡器</button><button>效果器</button></nav></header>
      <div class="eq-page is-embedded"><button class="eq-command">选择预设</button><section class="sliders-board"><span class="slider-gain">0.0 dB</span><span class="slider-freq">1 kHz</span></section><div class="preset-menu" data-te-material="popover"><span class="preset-menu-title">预设</span><button class="preset-menu-item">默认</button><button class="preset-menu-item active">选中预设</button></div><div class="response-view-switch"><button class="active">DSP 响应</button><button>耳机频响</button></div><div class="parametric-workspace" data-te-material="content"><section class="band-inspector">频段参数</section></div></div>
      </main><nav class="side-menu open" style="position:relative"><button class="menu-item active">选中导航</button></nav><section class="plugin-page" style="position:relative"><div class="search-box"><input type="search" placeholder="搜索插件"></div><button class="btn btn-primary">安装</button></section><script>
      document.querySelectorAll('.plugin-page,.plugin-page *').forEach(element=>element.setAttribute('data-v-plugin',''));document.querySelectorAll('.side-menu,.side-menu *').forEach(element=>element.setAttribute('data-v-nav',''));document.querySelectorAll('.audio-workspace,.audio-workspace *').forEach(element=>element.setAttribute('data-v-dsp',''));
      document.querySelectorAll('.appearance-page,.appearance-page>button,.appearance-theme-selection').forEach(element=>element.setAttribute('data-v-page',''));
      document.querySelectorAll('.appearance-theme-selection,.appearance-theme-selection *').forEach(element=>element.setAttribute('data-v-selection',''));
      document.querySelectorAll('.online-home,.online-home *').forEach(element=>element.setAttribute('data-v-home',''));
      document.querySelectorAll('.song-list,.song-list *').forEach(element=>element.setAttribute('data-v-library',''));document.querySelectorAll('.streaming-page,.streaming-page *').forEach(element=>element.setAttribute('data-v-stream',''));document.querySelectorAll('.animated-input,.animated-input *').forEach(element=>element.setAttribute('data-v-input',''));
      const title=document.createElement('header');title.className='title-bar title-bar-settings title-bar-reading';title.setAttribute('data-v-dsp','');title.style.pointerEvents='none';document.body.append(title);
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');
      document.querySelectorAll('.settings-preview-page,.plugin-page,.audio-workspace').forEach(page=>{const layer=document.createElement('div');layer.className='app-background-layer app-background-layer--reading';layer.dataset.backgroundImageState='ready';layer.style.cssText='display:block;visibility:hidden';layer.innerHTML='<div class="app-background-reading-wash"></div>';page.append(layer)});
      const rgb=value=>{if(!value.startsWith('color('))return value;context.clearRect(0,0,1,1);context.fillStyle=value;context.fillRect(0,0,1,1);const [r,g,b,a]=context.getImageData(0,0,1,1).data;return 'rgba('+[r,g,b,a/255].join(',')+')'};
      const fields=()=>[...document.querySelectorAll('input,select,textarea')],paint=element=>{const css=getComputedStyle(element);return {color:rgb(css.color),background:rgb(css.backgroundColor),opacity:css.opacity,cursor:css.cursor}};
      window.prepareFeedback=index=>{const item=${JSON.stringify(cases)}[index],root=document.documentElement;root.dataset.theme=item.theme;root.dataset.teSettingsImagePalette='on';root.dataset.teSettingsTextTone=item.textTone;for(const [name,value] of Object.entries(item.variables))root.style.setProperty(name,value);const row=document.querySelector('#feedback-row');row.scrollIntoView({behavior:'instant'});const rect=row.getBoundingClientRect();return {x:Math.round(rect.x+10),y:Math.round(rect.y+10)}};
      window.feedback=()=>{const row=document.querySelector('#feedback-row');return {...paint(row),hover:row.matches(':hover'),focus:row.matches(':focus-within')}};
      window.check=()=>${JSON.stringify(cases)}.map(item=>{
        const root=document.documentElement;root.dataset.theme=item.theme;root.dataset.teSettingsImagePalette='off';root.dataset.teSettingsTextTone='theme';root.dataset.teAppImagePalette='off';root.dataset.teAppTextTone='theme';root.dataset.teCardCustom='off';root.dataset.teEqualizerPanel='neutral';root.dataset.teEqualizerButton='soft';
        const baseline=fields().map(paint);for(const [name,value] of Object.entries(item.variables))root.style.setProperty(name,value);
        root.dataset.teSettingsImagePalette='on';root.dataset.teSettingsTextTone=item.textTone;root.dataset.teAppImagePalette='on';root.dataset.teAppTextTone=item.textTone;
        const active=fields().map(element=>({...paint(element),color:paint(element.closest('.animated-input')||element).color,label:element.outerHTML.slice(0,100),background:element.closest('.theme-selection-search,.search-box,.streaming-search-box,.online-source-picker')?paint(element.closest('.theme-selection-search,.search-box,.streaming-search-box,.online-source-picker')).background:paint(element).background,disabled:element.disabled,hasPlaceholder:element.hasAttribute('placeholder'),placeholder:getComputedStyle(element,'::placeholder').color}));
        const search=[...document.querySelectorAll('.settings-market-search,.settings-search-box')].map(paint);
        const buttons=[...document.querySelectorAll('.settings-preview-page button,.range-pill,.side-menu .menu-item,.plugin-page button,.plugin-page .search-box,.online-section-heading button')].map(element=>({...paint(element),label:element.textContent}));
        buttons.push({...paint(document.querySelector('.range-pill span')),background:paint(document.querySelector('.range-pill')).background,label:'字号标签'});
        const nestedSearch=paint(document.querySelector('.theme-selection-search input')).background;
        const editorRoot=document.querySelector('[data-appearance-workspace="customize"]'),editorStyle=getComputedStyle(editorRoot),editor={color:rgb(editorStyle.getPropertyValue('--appearance-edit-text').trim()),muted:rgb(editorStyle.getPropertyValue('--appearance-edit-muted').trim()),panel:rgb(editorStyle.getPropertyValue('--appearance-edit-menu').trim()),canvasText:rgb(editorStyle.getPropertyValue('--appearance-canvas-text').trim()),canvasMuted:rgb(editorStyle.getPropertyValue('--appearance-canvas-muted').trim())};
        const cards=[...document.querySelectorAll('.online-hero,.online-login-strip,.online-notice,.online-empty,.home-library-switch button,.parametric-workspace')].map(paint);
        root.dataset.teSettingsTextToneSource='auto';const fallbackCards=['light','dark'].map(tone=>{root.dataset.teSettingsImageFallbackTone=tone;return [...document.querySelectorAll('.online-hero,.online-login-strip,.online-notice,.online-empty,.home-library-switch button,.parametric-workspace')].map(paint)});delete root.dataset.teSettingsImageFallbackTone;
        const dsp=[...document.querySelectorAll('.audio-workspace h1,.audio-workspace-status,.audio-workspace-tabs button,.audio-window-button,.slider-gain,.slider-freq,.eq-command,.preset-menu-item,.preset-menu-title,.response-view-switch,.response-view-switch button,.band-inspector')].map(element=>{const value=paint(element),surface=element.closest('.preset-menu,.response-view-switch,.sliders-board,.parametric-workspace');return {...value,background:value.background==='rgba(0, 0, 0, 0)'&&surface?paint(surface).background:value.background,label:element.textContent}});
        const dspScheme=getComputedStyle(document.querySelector('.parametric-workspace')).getPropertyValue('--eq-color-scheme').trim();const dspPanel=paint(document.querySelector('.sliders-board'));
        const reading=${JSON.stringify(['standard', 'frosted', 'liquidGlass', 'transparent'].map((mode) => ({ mode, ...readingMaterialTreatment(mode) })))}.map(treatment=>{root.style.setProperty('--te-reading-fade',String(treatment.fade));return {...treatment,pages:[...document.querySelectorAll('.settings-preview-page,.plugin-page,.audio-workspace')].map(page=>({color:paint(page).color,background:paint(page.querySelector('.app-background-reading-wash')).background,fade:Number(getComputedStyle(page.querySelector('.app-background-reading-wash')).opacity)}))}});root.style.removeProperty('--te-reading-fade');
        const matching={surface:paint(document.querySelector('.online-source-picker')).background,accent:getComputedStyle(document.querySelector('.settings-preview-page')).getPropertyValue('--te-control-accent').trim()};
        const chromeInk=rgb(getComputedStyle(title).getPropertyValue('--te-shell-control-text').trim());root.dataset.teSettingsImagePalette='off';root.dataset.teSettingsTextTone='theme';for(const name of Object.keys(item.variables))root.style.removeProperty(name);
        return {...item,matching,baseline,active,search,buttons,nestedSearch,editor,cards,fallbackCards,chromeInk,dsp,dspPanel,dspScheme,reading,removed:fields().map(paint)};
      });</script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron'),path=require('node:path');app.setPath('userData',path.join(__dirname,'profile'));
      app.whenReady().then(async()=>{let win;try{win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{offscreen:true,backgroundThrottling:false}});await win.loadFile(path.join(__dirname,'index.html'));console.log('SETTINGS_IMAGE_FIELDS',JSON.stringify(await win.webContents.executeJavaScript('window.check()')));
      const feedback=[];for(let index=0;index<4;index++){const point=await win.webContents.executeJavaScript('window.prepareFeedback('+index+')');win.webContents.sendInputEvent({type:'mouseMove',...point});await win.webContents.executeJavaScript('new Promise(resolve=>{let attempts=0;const check=()=>{if(window.feedback().hover||++attempts===60)resolve();else setTimeout(check,25)};check()})');await win.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,250))');const hover=await win.webContents.executeJavaScript('window.feedback()');await win.webContents.executeJavaScript("document.querySelector('#feedback-row button').focus()");await win.webContents.executeJavaScript('new Promise(resolve=>setTimeout(resolve,250))');const focus=await win.webContents.executeJavaScript('window.feedback()');feedback.push({hover,focus});await win.webContents.executeJavaScript('document.activeElement.blur()')};console.log('SETTINGS_FEEDBACK',JSON.stringify(feedback));
      win.destroy();app.exit(0)}catch(error){console.error(error);win?.destroy();app.exit(1)}});`
    )
    const result = await promisify(execFile)(
      createRequire(import.meta.url)('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 30_000 }
    )
    const matrix = JSON.parse(result.stdout.match(/SETTINGS_IMAGE_FIELDS (.+)/)![1])
    const feedback = JSON.parse(result.stdout.match(/SETTINGS_FEEDBACK (.+)/)![1])
    for (const item of feedback) {
      assert.equal(item.hover.hover, true, JSON.stringify(item))
      assert.equal(item.focus.focus, true, JSON.stringify(item))
      for (const state of [item.hover, item.focus]) {
        const alpha = Number(state.background.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)?.[1])
        assert.ok(
          alpha > 0 && alpha <= 0.08,
          `setting feedback paints an opaque block: ${JSON.stringify(state)}`
        )
      }
      assert.equal(
        item.hover.background,
        item.focus.background,
        'mouse focus leaves a selected-looking setting row'
      )
    }
    for (const item of matrix) {
      assert.deepEqual(
        item.removed,
        item.baseline,
        'removed image colours leaked into theme fields'
      )
      for (const field of item.active) {
        const ratio = themeContrastRatio(field.color, field.background)
        assert.ok(
          ratio !== null && ratio >= 4.5,
          JSON.stringify({ theme: item.theme, average: item.average, field, ratio })
        )
        if (field.hasPlaceholder) {
          assert.ok((themeContrastRatio(field.placeholder, field.background) ?? 0) >= 4.5)
        }
        if (field.disabled) {
          assert.equal(field.opacity, '0.55')
          assert.equal(field.cursor, 'not-allowed')
        } else assert.equal(field.opacity, '1')
      }
      assert.equal(item.nestedSearch, 'rgba(0, 0, 0, 0)', 'composite search paints a second field')
      for (const color of [item.editor.color, item.editor.muted]) {
        for (const background of [item.editor.panel]) {
          assert.ok(
            (themeContrastRatio(color, background) ?? 0) >= 4.5,
            `editor chrome follows the theme instead of its image backdrop: ${JSON.stringify({ item, color, background })}`
          )
        }
      }
      const washBackground = (surface: string, fade: number, pixel: number) => {
        const channels = surface
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
        return (
          '#' +
          channels
            .map((channel) =>
              Math.round(channel * fade + pixel * (1 - fade))
                .toString(16)
                .padStart(2, '0')
            )
            .join('')
        )
      }
      for (const reading of item.reading) {
        for (const page of reading.pages) {
          assert.equal(page.fade, reading.fade)
          for (const pixel of [0, 255]) {
            const background = washBackground(page.background, page.fade, pixel)
            for (const color of [
              page.color,
              item.editor.canvasText,
              item.editor.canvasMuted,
              item.chromeInk
            ])
              assert.ok(
                (themeContrastRatio(color, background) ?? 0) >= 4.5,
                JSON.stringify({ theme: item.theme, reading, color, background })
              )
          }
        }
      }
      for (const field of [...item.search, ...item.buttons]) {
        assert.ok(
          (themeContrastRatio(field.color, field.background) ?? 0) >= 4.5,
          JSON.stringify({ theme: item.theme, average: item.average, field })
        )
      }
      assert.equal(item.dspScheme, item.theme === 'dark' ? 'dark' : 'light')
      for (const cards of item.fallbackCards)
        assert.deepEqual(cards, item.cards, 'missing image changed the selected card mode')
      for (const card of item.cards) {
        const channels = card.background
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
        assert.ok(
          item.theme === 'pureWhite' ? Math.min(...channels) > 220 : Math.max(...channels) < 50,
          `image changed the selected card mode: ${JSON.stringify({ theme: item.theme, average: item.average, card })}`
        )
        assert.ok((themeContrastRatio(card.color, card.background) ?? 0) >= 4.5)
      }
      for (const field of item.dsp) {
        const wash = item.reading[0].pages.at(-1)
        const surface =
          field.background === 'rgba(0, 0, 0, 0)'
            ? washBackground(wash.background, wash.fade, item.theme === 'dark' ? 255 : 0)
            : field.background
        assert.ok(
          (themeContrastRatio(field.color, surface) ?? 0) >= 4.5,
          JSON.stringify({ theme: item.theme, average: item.average, field, surface })
        )
      }
    }
    for (const theme of ['pureWhite', 'dark']) {
      for (const average of ['#101820', '#f5f1e9']) {
        const samples = matrix.filter((item) => item.theme === theme && item.average === average)
        assert.equal(
          new Set(samples.map((item) => item.matching.surface)).size,
          4,
          'image colour no longer reaches painted controls'
        )
        assert.equal(
          new Set(samples.map((item) => item.matching.accent)).size,
          4,
          'image colour no longer reaches selected controls'
        )
      }
    }
    console.info('SETTINGS_IMAGE_FIELDS_OK:', matrix.length, 'theme/image combinations')
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})
