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
const componentRoot = new URL('./', import.meta.url)

test('page chrome, long plugin output and variable player clearance fit the shell', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-page-layout-'))
  try {
    const extract = async (path: string): Promise<string> => {
      const source = await readFile(new URL(path, componentRoot), 'utf8')
      return (
        path.endsWith('.vue')
          ? parse(source)
              .descriptor.styles.map((style) => style.content)
              .join('\n')
          : source
      ).replace(/:(?:deep|global)\(([^)]+)\)/g, '$1')
    }
    const main = await extract('../assets/main.css')
    const shell =
      (await extract('../App.vue')) +
      main.slice(main.indexOf('/* Windows owns'), main.indexOf('/* Active lyrics'))
    const base = await extract('../assets/base.css')
    const spacing = await extract('../assets/page-spacing.css')
    const cases = [
      {
        name: 'home',
        css: await extract('LocalDashboard.css'),
        html: '<div class="local-home-layout"><section class="home"><div class="home-inner">ROWS</div></section></div>'
      },
      {
        name: 'streaming',
        css:
          (await extract('streaming-page/StreamingPage.css')) +
          (await extract('streaming-page/StreamingContentHeader.css')),
        html: '<section class="streaming-page has-player"><div class="streaming-content"><header class="streaming-content-header"><h1 class="streaming-content-title">Streaming</h1></header><div class="streaming-content-body">ROWS</div></div></section>'
      },
      {
        name: 'aggregate',
        css: await extract('aggregate-playlist/AggregatePlaylistPage.css'),
        html: '<section class="aggregate-page has-player"><header class="aggregate-header">Aggregate</header><div class="aggregate-table-wrapper">ROWS</div></section>'
      },
      {
        name: 'theme',
        css: await extract('theme-studio/ThemeStudioPage.css'),
        html: '<section class="theme-studio-page"><header class="theme-studio-header">Theme</header><div class="theme-studio-workspace"><div class="theme-library-pane">Library</div><div class="theme-editor-pane">Editor</div><div class="theme-preview-pane">Preview</div></div></section>'
      },
      {
        name: 'playlists',
        css:
          (await extract('navigation/ApplicationPlaylistsPage.vue')) +
          (await extract('song-list/SongList.css')),
        html: '<section class="application-playlists-page"><div class="playlist-tabs"><button>应用歌单</button><button>聚合歌单</button></div><div class="playlist-content"><section class="song-list"><div class="table-view">ROWS</div></section></div></section>'
      },
      {
        name: 'plugin',
        css: await extract('PluginExtensionPage.vue'),
        html: '<section class="plugin-extension-page"><header class="plugin-extension-header"><div class="plugin-extension-icon">P</div><div class="plugin-extension-heading"><span>plugin.test</span><h1>LongPluginTitleWithoutBreaksABCDEFGHIJKLMNOPQRSTUVWXYZ</h1><p>Long description</p></div><button class="plugin-extension-action">刷新</button></header><div class="plugin-extension-body"><div class="plugin-extension-text-result"><pre>ROWS</pre></div></div></section>'
      },
      ...(await Promise.all(
        [
          ['songs', 'song-list/SongList.css', 'song-list'],
          ['analytics', 'ListeningAnalyticsPage.css', 'analytics-page'],
          ['radio', 'RadioPodcastPage.vue', 'radio-podcast-page'],
          ['network', 'NetworkSourcesPage.vue', 'network-sources-page']
        ].map(async ([name, path, className]) => ({
          name,
          css: await extract(path),
          html:
            '<section class="' +
            className +
            '">' +
            (name === 'songs'
              ? '<div class="table-view">ROWS</div>'
              : name === 'network'
                ? '<div class="network-profiles"><button class="brand-soft-button">添加网络源</button></div>ROWS'
                : 'ROWS') +
            '</section>'
        }))
      ))
    ]
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><style>${base}\n${spacing}\n${shell}
      *{box-sizing:border-box}body{margin:0;overflow:hidden;font:14px system-ui}
      :root{--te-titlebar-inset:40px;--te-menu-width:240px;--te-font-sans:system-ui;--te-font-rounded:system-ui;--te-neutral-900:#eee;--te-neutral-500:#aaa;--te-neutral-600:#bbb;--te-card-bg:#202224;--te-subtle-bg:#17181a;--te-app-bg:#17181a;--te-card-border:#333;--te-shell-control-text:#eee;--te-control-accent-soft:#233652;--te-control-accent-text:#92b9ff}
      .audit-row{display:block;height:68px;flex-shrink:0;margin:0;white-space:normal}.app-shell-title{height:40px}
      </style><style id="page-style"></style></head><body><div class="app-shell"><div class="app-shell-content"><div class="main-content"></div></div></div><script>
      window.cases=${JSON.stringify(cases)};
      window.inspectPage=${inspectPage.toString()};
      </script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',__dirname+'/profile');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1366,height:874,webPreferences:{offscreen:true,backgroundThrottling:false}});try{await win.loadFile(__dirname+'/index.html');let failures=[];for(const [w,h] of [[521,720],[760,692],[960,720],[1366,874]]){win.setContentSize(w,h);await new Promise(r=>setTimeout(r,80));for(const font of [14,20,28])for(const clearance of [102,220])for(let i=0;i<${cases.length};i++){const errors=await win.webContents.executeJavaScript('inspectPage('+i+','+font+','+clearance+')');failures.push(...errors.map(e=>w+'x'+h+' font '+font+' player '+clearance+': '+e))}}if(failures.length)throw Error(failures.join(' | '));console.log('PAGE_LAYOUT_OK ${cases.length * 24} cases');app.exit(0)}catch(e){console.error(e.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 45_000, maxBuffer: 1024 * 1024 }
    )
    assert.match(result.stdout, /PAGE_LAYOUT_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

function inspectPage(index: number, font: number, clearance: number): string[] {
  const win = window as unknown as { cases: Array<{ name: string; css: string; html: string }> }
  const item = win.cases[index]
  const host = document.querySelector<HTMLElement>('.main-content')!
  document.querySelector('#page-style')!.textContent = item.css
  document.documentElement.style.setProperty('--te-font-size-body', font + 'px')
  document.documentElement.style.setProperty('--te-playbar-bottom-clearance', clearance + 'px')
  document.documentElement.style.setProperty('--te-player-bar-height', '80px')
  host.classList.toggle('menu-open', item.name !== 'theme')
  host.innerHTML = item.html.replace(
    'ROWS',
    '<div class="audit-row">Long content</div>'.repeat(40) +
      '<div class="audit-row" id="last-row">End</div>'
  )
  const root = host.firstElementChild as HTMLElement
  const errors: string[] = []
  const shell = document.querySelector('.app-shell-content')!.getBoundingClientRect()
  const bounds = root.getBoundingClientRect()
  if (item.name !== 'theme') {
    const library = ['songs', 'streaming', 'aggregate', 'playlists'].includes(item.name)
    const gutter =
      innerWidth <= 680
        ? 16
        : library
          ? Math.min(32, Math.max(24, innerWidth * 0.02))
          : Math.min(48, Math.max(24, innerWidth * 0.04))
    const style = getComputedStyle(
      item.name === 'home' ? document.querySelector('.home-inner')! : root
    )
    const inset =
      library || item.name === 'home' ? gutter : Math.max(gutter, (shell.width - 1280) / 2 + gutter)
    const horizontal =
      item.name === 'streaming'
        ? parseFloat(
            getComputedStyle(document.querySelector('.streaming-content-body')!).paddingLeft
          )
        : item.name === 'playlists'
          ? parseFloat(getComputedStyle(document.querySelector('.playlist-tabs')!).paddingLeft)
          : parseFloat(style.paddingLeft)
    if (Math.abs(horizontal - inset) > 1)
      errors.push(item.name + ' breaks page inset contract: ' + horizontal + ' vs ' + inset)
    const titleTop =
      item.name === 'streaming'
        ? document.querySelector('.streaming-content-header')!.getBoundingClientRect().top -
          shell.top
        : item.name === 'playlists'
          ? parseFloat(getComputedStyle(document.querySelector('.playlist-tabs')!).paddingTop)
          : parseFloat(style.paddingTop)
    if (Math.abs(titleTop - (innerWidth <= 680 ? (library ? 16 : 24) : library ? 24 : 32)) > 1)
      errors.push(item.name + ' breaks page top contract: ' + titleTop)
  }
  if (bounds.top < shell.top - 1 || bounds.bottom > shell.bottom + 1)
    errors.push(item.name + ' escapes shell: ' + JSON.stringify(bounds.toJSON()))
  if (item.name === 'theme') {
    if (bounds.top > shell.top + 1) errors.push('theme reserves titlebar twice')
    if (root.scrollWidth > root.clientWidth + 1) errors.push('theme workspace overflows')
  } else {
    if (
      item.name === 'playlists' &&
      document.querySelector('.playlist-tabs')!.getBoundingClientRect().top > shell.top + 26
    )
      errors.push('playlist tabs reserve titlebar twice')
    const scroller =
      item.name === 'home'
        ? document.querySelector<HTMLElement>('.home')!
        : item.name === 'streaming'
          ? document.querySelector<HTMLElement>('.streaming-content')!
          : item.name === 'aggregate'
            ? document.querySelector<HTMLElement>('.aggregate-table-wrapper')!
            : item.name === 'plugin'
              ? innerWidth <= 620
                ? root
                : document.querySelector<HTMLElement>('.plugin-extension-body')!
              : item.name === 'playlists'
                ? document.querySelector<HTMLElement>('.song-list')!
                : root
    scroller.scrollTop = scroller.scrollHeight
    const last = document.querySelector('#last-row')!.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (last.bottom > Math.min(view.bottom, innerHeight - clearance - 8) + 1)
      errors.push(item.name + ' final content is clipped or covered by player')
    if (scroller.scrollHeight <= scroller.clientHeight)
      errors.push(item.name + ' cannot scroll long content')
    if (item.name === 'plugin') {
      const header = document.querySelector('.plugin-extension-header')!
      if (header.scrollWidth > header.clientWidth + 1)
        errors.push('plugin long title overflows header')
      if (getComputedStyle(document.querySelector('pre')!).color === 'rgb(51, 51, 51)')
        errors.push('plugin uses light-only text on dark background')
    }
    if (item.name === 'network') {
      const action = document.querySelector<HTMLElement>('.brand-soft-button')!
      const style = getComputedStyle(action)
      if (style.backgroundColor !== 'rgb(35, 54, 82)' || action.offsetHeight < 34)
        errors.push('network action falls back to native button styling')
    }
  }
  return errors
}
