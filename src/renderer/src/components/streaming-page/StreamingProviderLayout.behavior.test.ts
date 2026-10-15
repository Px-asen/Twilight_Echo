import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test(
  'shared streaming host keeps provider contracts, header and downloads usable',
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-provider-layout-'))
    try {
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'provider-layout-external-boundaries',
            enforce: 'pre',
            resolveId(source) {
              const match = source
                .replaceAll('\\', '/')
                .match(/\/stores\/(use(?:Settings|Music|Player|Ncm|ListeningStats)Store)(?:\.ts)?$/)
              return match ? '\0provider-layout-' + match[1] : null
            },
            load(id) {
              const name = id.replace('\0provider-layout-', '')
              if (name === 'useListeningStatsStore')
                return 'export const getTopTracks=()=>[];export const getRecentTracks=()=>[];export const useListeningStatsStore=()=>({})'
              const slot = {
                useSettingsStore: 'settingsStore',
                useMusicStore: 'musicStore',
                usePlayerStore: 'playerStore',
                useNcmStore: 'ncmStore'
              }[name]
              return slot
                ? `export const ${name}=()=>window.streamingFixture.${slot};${name === 'useNcmStore' ? 'export const captureNcmSession=()=>()=>true;' : ''}`
                : null
            }
          },
          vue()
        ],
        resolve: {
          alias: {
            '@renderer': join(workspace, 'src/renderer/src'),
            vue: require.resolve('vue/dist/vue.esm-bundler.js')
          }
        },
        define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
        build: {
          outDir: join(directory, 'bundle'),
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: join(
              workspace,
              'src/renderer/src/components/streaming-page/StreamingProviderLayout.fixture.mjs'
            ),
            name: 'StreamingProviderLayout',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      const script = files.find((file) => file.endsWith('.js'))
      assert.ok(script, 'The test must compile the actual StreamingPage')
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html lang="zh-CN" data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">${files
          .filter((file) => file.endsWith('.css'))
          .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
          .join(
            ''
          )}<style>html,body,#app{margin:0;width:100%;height:100%;overflow:hidden}#fixture-start{position:fixed;top:4px;left:8px;z-index:3000;height:28px;font:inherit}.streaming-page{--te-titlebar-inset:44px;--te-playbar-bottom-clearance:94px}</style></head><body><button id="fixture-start">窗口工具</button><div id="app"></div><script src="bundle/${script}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), electronRunner)
      const fingerprint = createHash('sha256')
      for (const file of files.filter((file) => /\.(js|css)$/.test(file)))
        fingerprint.update(await readFile(join(directory, 'bundle', file)))
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        TWILIGHT_PROVIDER_BUNDLE_SHA: fingerprint.digest('hex')
      }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 160_000, env, maxBuffer: 4 * 1024 * 1024 }
      )
      assert.match(result.stdout, /STREAMING_PROVIDER_LAYOUT_OK/)
      console.log(result.stdout.trim())
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const electronRunner = `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const directory=process.argv.at(-1);
app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1499,height:884,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:true,contextIsolation:false}});
 let networkRequests=0;const requests=[];const reports=[];const failures=[];let current='setup';
 win.webContents.session.webRequest.onBeforeRequest((details,done)=>{if(/^(?:https?|wss?):/i.test(details.url)){networkRequests++;requests.push(details.url);done({cancel:true})}else done({})});
 const run=code=>win.webContents.executeJavaScript(code);
 const expect=(value,message)=>{if(!value)throw new Error(message)};
 const verify=(value,message)=>{if(!value)failures.push(current+': '+message)};
 const checkSearch=layout=>{
  verify(layout.title&&layout.query&&layout.input&&layout.controls&&layout.result,'Search must retain its title, query, scopes and result region');
  if(!layout.title||!layout.query||!layout.input||!layout.controls||!layout.result)return;
  verify(Math.abs(layout.query.left-layout.title.left)<=2,'The main query must share the title alignment');
  verify(layout.query.top>=layout.title.bottom+4,'The main query belongs below the page title');
  verify(layout.query.width>=Math.min(560,layout.result.width*.65),'The query has been reduced to a minor corner control');
  verify(Math.abs(layout.controls.left-layout.query.left)<=2,'Search scopes must continue from the query alignment');
  verify(layout.controls.top>=layout.query.bottom-1&&layout.controls.top-layout.query.bottom<=32,'Search scopes must stay next to the query');
  verify(layout.result.top>=layout.controls.bottom-1&&layout.result.top-layout.controls.bottom<=40,'Results must follow the scopes without a detached blank region');
  verify(!layout.query.overflow&&!layout.controls.overflow,'The query or scopes overflow horizontally');
  verify(layout.input.top>=layout.query.top-1&&layout.input.bottom<=layout.query.bottom+1,'The search input is clipped vertically');
  verify(layout.tools.length>=5&&layout.tools.every(tool=>tool.left>=8&&tool.right<=layout.viewport.width-8&&tool.bottom<=layout.viewport.height-8),'Search scope controls must remain visible and reachable');
 };
 const key=async(keyCode,modifiers=[])=>{const nativeCode={ArrowDown:'Down',ArrowUp:'Up',ArrowLeft:'Left',ArrowRight:'Right'}[keyCode]||keyCode;win.webContents.sendInputEvent({type:'keyDown',keyCode:nativeCode,modifiers});if(keyCode==='Enter'||keyCode==='Space')win.webContents.sendInputEvent({type:'char',keyCode:keyCode==='Enter'?'\\r':' ',modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode:nativeCode,modifiers});await run('window.providerProbe.flush()')};
 const prepare=options=>run('window.prepareProviderFixture('+JSON.stringify(options)+')');
 const inspectSearch=()=>run('window.providerProbe.searchState()');
 const settleSearch=()=>run('window.providerProbe.settleSearch()');
 const queryCalls=(state,query,method='searchSongs',provider='aurora')=>state.calls.filter(call=>call[0]===provider&&call[1]===method&&call[2][0]===query).length;
 const profiles=[{name:'desktop',width:1499,height:884,font:14},{name:'narrow',width:760,height:692,font:14},{name:'short',width:1100,height:600,font:14},{name:'text20',width:760,height:692,font:20},{name:'text28',width:760,height:692,font:28},{name:'desktop28',width:1499,height:884,font:28}];
 try{
  await win.loadFile(path.join(directory,'index.html'));
  current='search-command-first-mount';
  await prepare({surface:'search',searchResults:true,searchNavigationRequest:{key:1,query:'  初次顶栏查询  '}});await settleSearch();
  let search=await inspectSearch();
  expect(search.query==='初次顶栏查询'&&search.resultText.includes('初次顶栏查询')&&!search.detail,'The initial command must trim its query and search on first mount');
  expect(queryCalls(search,'初次顶栏查询')===1,'The initial command must execute once without a duplicate debounce request');expect(!search.errors.length,'Initial command raised a Vue error');reports.push({case:current,...search});
  current='search-command-new-key-same-query';
  await run('window.providerProbe.submitSearch({key:2,query:"初次顶栏查询"})');await settleSearch();search=await inspectSearch();
  expect(queryCalls(search,'初次顶栏查询')===2&&search.query==='初次顶栏查询','A new command key must rerun an unchanged query');reports.push({case:current,...search});
  current='search-command-duplicate-key';const callsBeforeDuplicate=search.calls.length;
  await run('window.providerProbe.submitSearch({key:2,query:"重复键不得改词"});');await settleSearch();
  await run('window.providerProbe.setActive(false)');await run('window.providerProbe.setActive(true)');await settleSearch();search=await inspectSearch();
  expect(search.query==='初次顶栏查询'&&search.calls.length===callsBeforeDuplicate,'The same key must not replay or change query after a payload update or reactivation');reports.push({case:current,...search});
  current='search-command-inactive-coalescing';
  await prepare({surface:'search',active:false,searchResults:true,searchNavigationRequest:{key:10,query:'后台初始词'}});
  await run('window.providerProbe.submitSearch({key:11,query:"后台旧命令"})');await run('window.providerProbe.submitSearch({key:12,query:"后台最新命令"})');await settleSearch();const inactiveSearch=await inspectSearch();
  expect(inactiveSearch.hidden&&inactiveSearch.query===''&&inactiveSearch.calls.length===0,'An inactive page must defer navigation commands without changing its current query');
  await run('window.providerProbe.setActive(true)');await settleSearch();search=await inspectSearch();
  expect(!search.hidden&&search.query==='后台最新命令'&&search.resultText.includes('后台最新命令'),'Activation must consume the latest pending search command');
  expect(queryCalls(search,'后台最新命令')===1&&!search.calls.some(call=>['后台初始词','后台旧命令'].includes(call[2][0])),'Deferred commands must coalesce instead of replaying obsolete queries');reports.push({case:current,inactive:inactiveSearch,activated:search});
  current='search-command-exits-detail';
  await prepare({surface:'search',searchResults:true,searchNavigationRequest:{key:20,query:'详情之前的词'}});await settleSearch();
  await run('[...document.querySelectorAll(".search-type-group button")].find(button=>button.textContent.trim()==="专辑").focus()');await key('Enter');await settleSearch();
  expect(await run('!!document.querySelector(".album-search-card")'),'A real album search result is required before entering details');
  await run('document.querySelector(".album-search-card").focus()');await key('Enter');
  expect(await run('!!document.querySelector(".detail-back-button")&&window.providerProbe.calls.some(call=>call[1]==="fetchAlbumTracks")'),'Album activation must enter the real detail and provider handler');
  await run('window.providerProbe.submitSearch({key:21,query:"详情之后的新词"})');await settleSearch();search=await inspectSearch();
  expect(!search.detail&&search.query==='详情之后的新词'&&search.resultText.includes('详情之后的新词')&&!search.resultText.includes('详情之前的词'),'A new command must clear the real detail and display only its new query results');
  expect(queryCalls(search,'详情之后的新词','searchAlbums')===1,'Detail exit must retain the selected search type and search the new keyword once');reports.push({case:current,...search});
  current='search-command-late-response';
  await prepare({surface:'search',searchResults:true,searchNavigationRequest:{key:30,query:'迟到旧关键词'},behavior:{'aurora:searchSongs:迟到旧关键词':'hold','archive:searchSongs:迟到旧关键词':'hold','quiet:searchSongs:迟到旧关键词':'hold'}});const pendingSearch=await inspectSearch();
  expect(pendingSearch.loading&&queryCalls(pendingSearch,'迟到旧关键词')===1,'The old command must reach a controlled pending provider request');
  await run('window.providerProbe.submitSearch({key:31,query:"快速新关键词"})');await settleSearch();search=await inspectSearch();
  expect(search.query==='快速新关键词'&&search.resultText.includes('快速新关键词'),'The newest query must settle while the previous request is pending');
  await run('["aurora","archive","quiet"].forEach(id=>window.providerProbe.release(id+":searchSongs:迟到旧关键词"));window.providerProbe.flush()');await settleSearch();const afterLateSearch=await inspectSearch();
  expect(afterLateSearch.query==='快速新关键词'&&afterLateSearch.resultText.includes('快速新关键词')&&!afterLateSearch.resultText.includes('迟到旧关键词')&&!afterLateSearch.loading,'Late old responses must not replace results or loading state for the new command');reports.push({case:current,pending:pendingSearch,newest:search,afterLate:afterLateSearch});
  current='search-command-provider-arrival';
  await prepare({surface:'search',none:true,searchResults:true,searchNavigationRequest:{key:40,query:'音源变化保留搜索词'}});await settleSearch();const beforeArrival=await inspectSearch();
  expect(beforeArrival.query==='音源变化保留搜索词','The query must remain present even without an online source');
  await run('window.providerProbe.addProvider("aurora")');await settleSearch();search=await inspectSearch();
  expect(search.query==='音源变化保留搜索词'&&search.sources.includes('aurora')&&!search.emittedQueries.includes(''),'Discovering a provider must update source choices without clearing the titlebar query');reports.push({case:current,before:beforeArrival,after:search});
  current='search-command-provider-removal';
  await prepare({surface:'search',provider:'archive',searchResults:true,searchNavigationRequest:{key:50,query:'移除音源仍保留词'}});await settleSearch();const beforeRemoval=await inspectSearch();
  await run('window.providerProbe.removeProvider("archive")');await settleSearch();search=await inspectSearch();
  expect(search.query==='移除音源仍保留词'&&search.source==='all'&&!search.sources.includes('archive')&&!search.emittedQueries.includes(''),'Removing the preferred provider must preserve the unified query and its own source filter');
  const afterRemovalCalls=search.calls.length;await run('window.providerProbe.submitSearch({key:51,query:"移除音源仍保留词"})');await settleSearch();const repeatedAfterRemoval=await inspectSearch();
  expect(repeatedAfterRemoval.calls.length>afterRemovalCalls&&repeatedAfterRemoval.calls.slice(afterRemovalCalls).every(call=>call[0]!=='archive'),'A new command must use the current source registry after removal');
  expect(repeatedAfterRemoval.resultText.includes('aurora')&&!repeatedAfterRemoval.resultText.includes('archive')&&!repeatedAfterRemoval.errors.length,'Removed sources must not contribute to the refreshed results');reports.push({case:current,before:beforeRemoval,after:search,rerun:repeatedAfterRemoval});
  current='search-command-clear-empty-and-whitespace';
  await prepare({surface:'search',searchResults:true,searchNavigationRequest:{key:60,query:'清除前已显示的查询'}});await settleSearch();const beforeEmptyCommand=await inspectSearch();
  expect(beforeEmptyCommand.resultText.includes('清除前已显示的查询')&&!beforeEmptyCommand.loading,'The clear regression needs settled real search results');
  await run('window.providerProbe.submitSearch({key:61,query:""})');await settleSearch();const afterEmptyCommand=await inspectSearch();
  expect(afterEmptyCommand.query===''&&afterEmptyCommand.resultText===''&&!afterEmptyCommand.resultsSummary&&!afterEmptyCommand.detail&&!afterEmptyCommand.loading&&afterEmptyCommand.startHint.includes('输入关键词'),'An empty command must clear the query and old results, then display the initial search hint');
  expect(afterEmptyCommand.calls.length===beforeEmptyCommand.calls.length&&afterEmptyCommand.emittedQueries.at(-1)==='','Clearing must emit the empty query without issuing an empty provider search');
  await run('window.providerProbe.submitSearch({key:62,query:"空白命令之前的详情"})');await settleSearch();
  await run('[...document.querySelectorAll(".search-type-group button")].find(button=>button.textContent.trim()==="专辑").focus()');await key('Enter');await settleSearch();
  await run('document.querySelector(".album-search-card").focus()');await key('Enter');const beforeWhitespaceCommand=await inspectSearch();
  expect(beforeWhitespaceCommand.detail&&await run('window.providerProbe.calls.some(call=>call[1]==="fetchAlbumTracks")'),'The whitespace clear regression must enter the real album detail first');
  await run('window.providerProbe.submitSearch({key:63,query:"   "})');await settleSearch();const afterWhitespaceCommand=await inspectSearch();
  expect(afterWhitespaceCommand.query===''&&afterWhitespaceCommand.resultText===''&&!afterWhitespaceCommand.resultsSummary&&!afterWhitespaceCommand.detail&&!afterWhitespaceCommand.loading&&afterWhitespaceCommand.startHint.includes('输入关键词'),'A whitespace command must also leave details and restore the empty search state');
  expect(afterWhitespaceCommand.calls.length===beforeWhitespaceCommand.calls.length&&afterWhitespaceCommand.calls.every(call=>String(call[2][0]).trim()!==''),'Empty and whitespace commands must never reach provider search methods');
  expect(!afterWhitespaceCommand.errors.length,'Clear commands raised a Vue error');reports.push({case:current,before:beforeEmptyCommand,empty:afterEmptyCommand,beforeWhitespace:beforeWhitespaceCommand,whitespace:afterWhitespaceCommand});
  current='search-command-clear-pending-response';
  await prepare({surface:'search',searchResults:true,searchNavigationRequest:{key:70,query:'清除后才返回的旧查询'},behavior:{'aurora:searchSongs:清除后才返回的旧查询':'hold','archive:searchSongs:清除后才返回的旧查询':'hold','quiet:searchSongs:清除后才返回的旧查询':'hold'}});const beforePendingClear=await inspectSearch();
  expect(beforePendingClear.loading&&queryCalls(beforePendingClear,'清除后才返回的旧查询')===1&&!beforePendingClear.responses.some(response=>response.query==='清除后才返回的旧查询'),'The late-clear regression needs a started provider request whose response is still held');
  await run('window.providerProbe.submitSearch({key:71,query:""})');await settleSearch();const afterPendingClear=await inspectSearch();
  expect(afterPendingClear.query===''&&afterPendingClear.resultText===''&&!afterPendingClear.resultsSummary&&!afterPendingClear.loading&&afterPendingClear.startHint.includes('输入关键词'),'Clearing a pending search must stop loading and show the empty search state immediately');
  expect(afterPendingClear.calls.length===beforePendingClear.calls.length,'Clearing a pending request must not start an empty search');
  await run('["aurora","archive","quiet"].forEach(id=>window.providerProbe.release(id+":searchSongs:清除后才返回的旧查询"));window.providerProbe.flush()');await settleSearch();const afterClearedLateResponse=await inspectSearch();
  expect(afterClearedLateResponse.responses.filter(response=>response.query==='清除后才返回的旧查询').length===3,'All three deliberately late provider responses must actually settle after clearing');
  expect(afterClearedLateResponse.query===''&&afterClearedLateResponse.resultText===''&&!afterClearedLateResponse.resultsSummary&&!afterClearedLateResponse.detail&&!afterClearedLateResponse.loading&&afterClearedLateResponse.startHint.includes('输入关键词'),'Late responses must not restore a cleared keyword, results, summary or loading state');
  expect(afterClearedLateResponse.calls.length===beforePendingClear.calls.length&&afterClearedLateResponse.emittedQueries.at(-1)===''&&!afterClearedLateResponse.errors.length,'A cleared request must remain cleared without empty requests or Vue errors');reports.push({case:current,pending:beforePendingClear,cleared:afterPendingClear,afterLate:afterClearedLateResponse});
  for(const tone of ['pureWhite','dark'])for(const profile of profiles)for(const surface of ['home','discover','library','search']){
   current=tone+'-'+profile.name+'-'+surface;win.setContentSize(profile.width,profile.height);
   await prepare({tone,...profile,surface});const report=await run('window.inspectProviderHeader()');if(surface==='search'){report.searchLayout=await run('window.inspectProviderRefinement("search")');checkSearch(report.searchLayout)}reports.push({case:current,...report});
   expect(!report.issues.length,current+': '+report.issues.join('; '));
  }
  const reviewDesktop={name:'review-desktop',width:1499,height:1027,font:14};
  for(const tone of ['pureWhite','dark'])for(const provider of ['aurora','archive']){
   current=tone+'-review-home-'+provider;win.setContentSize(reviewDesktop.width,reviewDesktop.height);await prepare({tone,...reviewDesktop,provider,counts:{tracks:9}});
   const report=await run('window.inspectProviderRefinement("home")');reports.push({case:current,...report});
   verify(!report.errors.length,'Home raised a runtime error');verify(!!report.main&&report.quick.length>0,'Main recommendation and supported quick recommendation must both be present');
   for(const card of [report.main,...report.quick].filter(Boolean)){verify(card.width>card.height*1.1,'A recommendation card must have a rectangular reading area');verify(card.radius.every(radius=>radius>0&&radius<Math.min(card.width,card.height)/4),'Recommendation cards must retain rounded rectangular corners');verify(!card.overflow,'A recommendation card overflows horizontally')}
   verify(report.tracks.length===9,'The preview must disclose nine available tracks');verify(report.columns.length===3&&report.rows.length===3,'The current desktop preview must form three columns and three rows');verify(report.tracks.every(track=>track.label&&track.width>0&&track.left>=16&&track.right<=report.viewport.width-16),'Preview tracks must remain named and within page bounds');
   verify(report.tracks.filter(track=>track.top>=0&&track.bottom<=report.viewport.height-24).length>=3,'The current desktop must reveal at least the first preview row');
  }
  for(const tone of ['pureWhite','dark']){
   current=tone+'-review-library-default';win.setContentSize(reviewDesktop.width,reviewDesktop.height);await prepare({tone,...reviewDesktop,surface:'library',counts:{albums:26,artists:6,playlists:6}});
   const report=await run('window.inspectProviderRefinement("library")');reports.push({case:current,...report});
   verify(!report.errors.length,'Library raised a runtime error');verify(report.selectedCollection==='playlists','The library must start with playlists');verify(report.tabs.map(tab=>tab.type).join(',')==='playlists,albums,artists'&&report.tabs.every(tab=>tab.role==='tab'),'Supported collection types must share one visible tab navigation');
   verify(report.albumRequests===0&&report.artistRequests===0&&report.visibleSavedItems===0,'Saved albums and artists must not precede or load ahead of the selected playlist collection');
   verify(report.visiblePlaylists===6&&report.firstPlaylist&&report.firstPlaylist.top>0&&report.firstPlaylist.bottom<=report.viewport.height-24,'The first playlist must be directly visible on the current desktop');
   verify(report.navigation&&report.panel&&report.panel.top>=report.navigation.bottom-1&&report.panel.top-report.navigation.bottom<=32,'The selected collection panel must stay next to its tabs');
   current=tone+'-review-search';await prepare({tone,...reviewDesktop,surface:'search'});const search=await run('window.inspectProviderRefinement("search")');reports.push({case:current,...search});checkSearch(search);
   current=tone+'-dynamic-collection-methods';await prepare({tone,...reviewDesktop,surface:'library',counts:{albums:26,playlists:6}});
   await run('document.querySelector("[data-collection=albums]").focus()');await key('Enter');const albums=await run('window.inspectProviderRefinement("library")');
   verify(albums.selectedCollection==='albums'&&albums.visibleSavedItems===26&&albums.visiblePlaylists===0,'Selecting albums must reveal that collection without mixing playlist content');
   await run('window.providerProbe.updateMethods("aurora",window.providerProbe.methods("aurora").filter(method=>method!=="fetchSavedAlbums"))');const removedAlbum=await run('window.inspectProviderRefinement("library")');
   verify(removedAlbum.selectedCollection!=='albums'&&!removedAlbum.tabs.some(tab=>tab.type==='albums')&&removedAlbum.tabs.some(tab=>tab.type==='artists'),'Removing the actual album handler must remove only its tab and leave a valid selected collection');
   await run('window.providerProbe.updateMethods("aurora",window.providerProbe.methods("aurora").filter(method=>method!=="fetchSavedArtists"))');const playlists=await run('window.inspectProviderRefinement("library")');
   verify(playlists.tabs.every(tab=>tab.type==='playlists')&&playlists.visibleSavedItems===0&&playlists.visiblePlaylists===6,'Removing optional collection handlers must restore the valid playlist panel');
   verify(!playlists.errors.length,'Changing Provider methods raised a runtime error');reports.push({case:current,albums,removedAlbum,playlists});
  }
  current='playlist-detail-return-state';win.setContentSize(reviewDesktop.width,reviewDesktop.height);await prepare({...reviewDesktop,surface:'library',counts:{playlists:200}});
  await run('[...document.querySelectorAll("[aria-label=歌单分类] button")].find(button=>button.textContent.includes("我创建的")).focus()');await key('Enter');expect(await run('document.querySelectorAll(".playlist-item").length===48'),'The fixture must expose a real first playlist page before expanding');
  await run('[...document.querySelectorAll(".playlist-section button")].find(button=>button.textContent.includes("显示更多歌单")).focus()');await key('Enter');expect(await run('document.querySelectorAll(".playlist-item").length===96'),'Showing more must expand the actual filtered playlist collection');
  await run('document.querySelector(".playlist-item").focus()');await key('Enter');expect(await run('!!document.querySelector(".detail-back-button")&&window.providerProbe.calls.some(call=>call[0]==="aurora"&&call[1]==="fetchPlaylistTracks")'),'Playlist activation must enter the real detail route and Provider bridge');
  await run('document.querySelector(".detail-back-button").focus()');await key('Enter');const playlistReturn=await run('window.inspectProviderRefinement("library")');
  verify(playlistReturn.selectedCollection==='playlists'&&playlistReturn.visiblePlaylists===96,'Returning from a playlist must preserve the selected collection and expanded item limit');verify(await run('[...document.querySelectorAll("[aria-label=歌单分类] button")].some(button=>button.getAttribute("aria-pressed")==="true"&&button.textContent.includes("我创建的"))'),'Returning from a playlist must preserve the active ownership filter');reports.push({case:current,...playlistReturn});
  current='album-detail-return-state';await prepare({...reviewDesktop,surface:'library',counts:{albums:26}});await run('document.querySelector("[data-collection=albums]").focus()');await key('Enter');await run('document.querySelector(".saved-grid > button").focus()');await key('Enter');
  expect(await run('!!document.querySelector(".detail-back-button")&&window.providerProbe.calls.some(call=>call[0]==="aurora"&&call[1]==="fetchAlbumTracks")'),'Album activation must enter the real detail route and registered album handler');await run('document.querySelector(".detail-back-button").focus()');await key('Enter');const albumReturn=await run('window.inspectProviderRefinement("library")');
  verify(albumReturn.selectedCollection==='albums'&&albumReturn.visibleSavedItems===26&&albumReturn.visiblePlaylists===0,'Returning from an album must restore its collection instead of the playlist default');verify(!albumReturn.errors.length,'Detail return raised a runtime error');reports.push({case:current,...albumReturn});
  for(const tone of ['pureWhite','dark'])for(const mode of ['loading','failure','empty','guest','unavailable']){
   current=tone+'-state-'+mode;win.setContentSize(760,692);
   const behavior=mode==='loading'?{'aurora:fetchRecommendSongs':'hold','aurora:fetchRecommendPlaylists':'hold','aurora:fetchPersonalFm':'hold'}:mode==='failure'?{'aurora:fetchRecommendSongs':'fail','aurora:fetchRecommendPlaylists':'fail','aurora:fetchPersonalFm':'fail'}:mode==='empty'?{'aurora:fetchRecommendSongs':'empty','aurora:fetchRecommendPlaylists':'empty','aurora:fetchPersonalFm':'empty'}:{};
   await prepare({tone,font:28,mode,none:mode==='unavailable',behavior});const report=await run('window.inspectProviderHeader()');reports.push({case:current,...report});expect(!report.issues.length,current+': '+report.issues.join('; '));
   expect(report.text.length>0,'Every state must communicate what happened');
   if(mode==='loading')expect(await run('!!document.querySelector("[role=status],[aria-busy=true]")'),'Loading needs an accessible status');
   if(mode==='failure')expect(await run('[...document.querySelectorAll(".streaming-content-body button")].some(button=>/重试|重新加载/.test(button.textContent))'),'A failure must retain a retry action');
   if(mode==='guest')expect(await run('!window.providerProbe.calls.some(call=>call[0]==="aurora"&&call[1]==="fetchPersonalFm")'),'Private home sections must not request logged-out data');
  }
  current='capabilities-and-shared-host';win.setContentSize(1499,884);
  const contract=await prepare({});expect(contract.eligibleHome.join(',')==='aurora,archive','Home admission must use actual section handlers');
  await run('document.querySelector(".provider-switcher-trigger").click();window.providerProbe.flush()');
  expect(await run('document.querySelectorAll(".provider-switcher-option").length===2'),'Unimplemented section methods must not create a home option');
  await key('Escape');await run('window.providerProbe.select("archive")');
  expect(await run('!!document.querySelector(".home-view")'),'Provider without presentation metadata must render the shared legacy home');
  await run('window.providerProbe.select("aurora")');
  expect(await run('!!document.querySelector(".music-home")'),'Provider presentation metadata must render the shared branded home');
  expect(await run('window.providerProbe.calls.some(call=>call[0]==="aurora"&&call[1]==="fetchRecommendSongs"&&call[2][0]?.catalogue==="editorial")'),'Provider section args must reach the actual bridge');
  reports.push({case:current,passed:true});
  current='source-switch-late-response';
  await prepare({behavior:{'aurora:fetchRecommendSongs':'hold','aurora:fetchRecommendPlaylists':'hold','aurora:fetchPersonalFm':'hold'}});
  await run('window.providerProbe.select("archive")');
  expect(await run('window.providerProbe.text.includes("archive·")'),'New provider content must appear while the previous request is pending');
  await run('["fetchRecommendSongs","fetchRecommendPlaylists","fetchPersonalFm"].forEach(method=>window.providerProbe.release("aurora:"+method));window.providerProbe.flush()');
  expect(await run('window.providerProbe.text.includes("archive·")&&!window.providerProbe.text.includes("aurora·")'),'Late provider content replaced the selected source');reports.push({case:current,passed:true});
  current='source-menu-keyboard';
  await prepare({surface:'library',font:28});
  await run('document.querySelector(".provider-switcher-trigger").focus()');await key('Enter');
  expect(await run('document.querySelector(".provider-switcher-menu").matches(":popover-open")'),'Enter must open the source menu');
  expect(await run('document.activeElement.matches(".provider-switcher-option[aria-selected=true]")'),'Opening a source menu must focus the current source');
  await key('ArrowDown');expect(await run('document.activeElement.matches(".provider-switcher-option")&&!document.activeElement.matches("[aria-selected=true]")'),'ArrowDown must reach another source');
  await key('End');expect(await run('document.activeElement===document.querySelector(".provider-switcher-option:last-child")'),'End must reach the last source');
  await key('Home');expect(await run('document.activeElement===document.querySelector(".provider-switcher-option:first-child")'),'Home must reach the first source');
  await key('Escape');expect(await run('!document.querySelector(".provider-switcher-menu").matches(":popover-open")'),'Escape must close the source menu');
  expect(await run('document.activeElement.matches(".provider-switcher-trigger")'),'Closing the source menu must restore trigger focus');reports.push({case:current,passed:true});
  await key('Enter');await key('ArrowDown');await key('Enter');
  expect(await run('window.providerProbe.events.some(event=>event[0]==="settings"&&event[1].streamingActiveProvider==="archive")'),'Keyboard selection must persist the chosen source');
  expect(await run('document.activeElement.matches(".provider-switcher-trigger")'),'Choosing a source must restore trigger focus');
  current='single-source-identity';await prepare({only:'aurora'});
  expect(await run('!!document.querySelector(".provider-current")&&!document.querySelector(".provider-switcher-trigger")'),'A single source must retain its visible identity without a disabled switching button');reports.push({case:current,passed:true});
  current='removed-source-fallback';await prepare({provider:'archive'});await run('window.providerProbe.removeProvider("archive")');
  expect(await run('!!document.querySelector(".music-home")&&!window.providerProbe.events.some(event=>event[0]==="settings")'),'Availability fallback must show a valid shared page without overwriting the chosen source');reports.push({case:current,passed:true});
  current='root-search-keyboard';await prepare({surface:'search',font:20});
  await run('document.querySelector(".streaming-search-box input").focus()');await win.webContents.insertText('很长的歌曲与专辑搜索名称');await run('new Promise(resolve=>setTimeout(resolve,350))');
  expect(await run('!!document.querySelector("select[aria-label=搜索音源]")'),'Search sources must have an explicitly labelled native control');
  await key('Tab');expect(await run('document.activeElement.matches(".streaming-search-clear")'),'Keyboard must reach the named clear-search action');await key('Enter');
  expect(await run('document.querySelector(".streaming-search-box input").value===""'),'Keyboard clear must reset the root query');
  const searchFocus=await run('document.activeElement.matches(".streaming-search-box input")');if(!searchFocus)failures.push(current+': Clearing search must keep the input available for continued typing');reports.push({case:current,passed:searchFocus,focused:await run('document.activeElement.outerHTML.slice(0,300)')});
  current='search-clear-during-pending';win.setContentSize(760,692);await prepare({tone:'dark',surface:'search',font:28,behavior:{'aurora:searchSongs':'hold'}});
  await run('document.querySelector(".streaming-search-box input").focus()');await win.webContents.insertText('仍在等待音源的查询');await run('new Promise(resolve=>setTimeout(resolve,350))');
  expect(await run('window.providerProbe.calls.some(call=>call[0]==="aurora"&&call[1]==="searchSongs")&&!!document.querySelector(".streaming-search-spinner")'),'The controlled source must still be waiting before clearing');
  expect(await run('!!document.querySelector(".streaming-search-clear")'),'A pending search must retain its clear action');await key('Tab');expect(await run('document.activeElement.matches(".streaming-search-clear")'),'The pending clear action must be keyboard reachable');await key('Enter');
  expect(await run('document.activeElement.matches(".streaming-search-box input")&&document.activeElement.value===""'),'Clearing a pending search must return an empty, focused input');await run('window.providerProbe.release("aurora:searchSongs");window.providerProbe.flush()');
  expect(await run('document.querySelector(".streaming-search-box input").value===""&&!document.querySelector(".search-results-summary")'),'The cancelled query must not restore a results heading after its source settles');reports.push({case:current,passed:true});
  for(const tone of ['pureWhite','dark'])for(const mode of ['loading','failure']){
   current=tone+'-library-'+mode;win.setContentSize(760,692);await prepare({tone,font:28,surface:'library',behavior:{'aurora:fetchUserLibrary':mode==='loading'?'hold':'fail'}});
   const report=await run('window.inspectProviderHeader()');reports.push({case:current,...report});expect(!report.issues.length,current+': '+report.issues.join('; '));expect(report.text.length>0,'Library state must be explained');
   if(mode==='failure'){
    expect(await run('!!document.querySelector(".streaming-placeholder[role=alert]")'),'Library failure must be announced');
    await run('window.providerProbe.setBehavior("aurora:fetchUserLibrary",null);document.querySelector(".streaming-placeholder button").click();window.providerProbe.flush()');
    expect(await run('!!document.querySelector(".playlist-grid .playlist-item")'),'Retry must restore the same provider playlist library');
   }
  }
  for(const tone of ['pureWhite','dark']){
   current=tone+'-discovery-before-provider-sync';await prepare({tone,surface:'discover',holdProviderSync:true});
   expect(await run('!window.providerProbe.calls.some(call=>call[1]==="fetchDiscoveryPlaylists")'),'The sync gate must precede the initial discovery request');
   expect(await run('!!document.querySelector(".disc [role=status][aria-label=正在加载歌单]")&&!window.providerProbe.text.includes("暂无歌单")'),'Discovery must communicate pending work before its first request');
   await run('window.providerProbe.releaseProviderSync()');expect(await run('window.providerProbe.calls.some(call=>call[1]==="fetchDiscoveryPlaylists")&&window.providerProbe.text.includes("aurora·")'),'Finishing provider sync must reveal the selected source discovery results');reports.push({case:current,passed:true});
  }
  for(const tone of ['pureWhite','dark'])for(const profile of [profiles[0],profiles[2],profiles[4]])for(const count of [1,6])for(const kind of ['saved','toplists']){
   current=tone+'-'+profile.name+'-'+kind+'-'+count;win.setContentSize(profile.width,profile.height);
   await prepare({tone,...profile,surface:kind==='saved'?'library':'home',provider:kind==='saved'?'aurora':'ncm',ncm:kind==='toplists',count});
   if(kind==='saved')await run('document.querySelector("[data-collection=albums]").click();window.providerProbe.flush()');
   const selector=kind==='saved'?'.saved-grid':'.toplists-grid';
   const report=await run('(()=>{const grid=document.querySelector('+JSON.stringify(selector)+');if(!grid)return {missing:true,errors:window.providerProbe.errors};grid.scrollIntoView({block:"center"});const r=grid.getBoundingClientRect(),cards=[...grid.children].map(node=>{const a=node.getBoundingClientRect();return {left:a.left,right:a.right,top:a.top,bottom:a.bottom,width:a.width,height:a.height}});return {viewport:{width:innerWidth,height:innerHeight},containerWidth:r.width,cardCount:cards.length,cards,overflow:grid.scrollWidth>grid.clientWidth+1,errors:window.providerProbe.errors}})()');
   reports.push({case:current,...report});expect(!report.missing,'Shared collection is missing: '+current+' '+JSON.stringify(report.errors));expect(!report.errors.length,'Collection runtime error: '+JSON.stringify(report.errors));expect(!report.overflow,'Collection has horizontal overflow: '+current);expect(report.cardCount===(kind==='toplists'?Math.min(count,4):count),'Collection omitted visible fixture items: '+current);expect(report.cards.every(card=>card.width<=Math.min(report.containerWidth,kind==='saved'?220:480)+1),'Sparse collections stretched beyond their usable artwork/preview limit: '+current);
   if(kind==='saved'){
    await run('document.querySelector("[data-collection=artists]").click();window.providerProbe.flush()');
    expect(await run('window.providerProbe.calls.some(call=>call[0]==="aurora"&&call[1]==="fetchSavedArtists")'),'Saved artist tab must call the selected provider');
   }
  }
  for(const tone of ['pureWhite','dark'])for(const profile of [profiles[0],profiles[2],profiles[4]]){
   current=tone+'-'+profile.name+'-downloads';win.setContentSize(profile.width,profile.height);await prepare({tone,...profile});
   await run('window.providerProbe.setTasks(["queued","preparing","downloading","completed","failed","cancelled"])');
   await run('document.querySelector(".provider-download-fab").focus();document.querySelector(".provider-download-fab").click();window.providerProbe.flush()');
   const report=await run('(()=>{const panel=document.querySelector(".provider-download-panel"),list=panel.querySelector(".provider-download-list"),r=panel.getBoundingClientRect();return {viewport:{width:innerWidth,height:innerHeight},panel:{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height},overflow:panel.scrollWidth>panel.clientWidth+1||list.scrollWidth>list.clientWidth+1,focused:panel.contains(document.activeElement),statuses:[...panel.querySelectorAll(".provider-download-item")].map(item=>item.dataset.status)}})()');
   reports.push({case:current,...report});expect(!report.overflow,'Download panel has horizontal overflow: '+current);expect(report.panel.left>=8&&report.panel.right<=profile.width-8&&report.panel.top>=8&&report.panel.bottom<=profile.height-8,'Download dialog crosses viewport: '+current);expect(report.focused,'Opening downloads must move focus inside the modal');expect(report.statuses.length===6,'Every task state must remain represented');
   await run('(()=>{const list=document.querySelector(".provider-download-list");list.scrollTop=list.scrollHeight;const button=[...list.querySelectorAll("button")].at(-1);button.focus();button.scrollIntoView({block:"nearest"})})()');
   expect(await run('(()=>{const r=document.activeElement.getBoundingClientRect();const p=document.querySelector(".provider-download-panel").getBoundingClientRect();return r.height>0&&r.top>=p.top&&r.bottom<=p.bottom+1})()'),'Last task action is unreachable');
   await key('Tab');expect(await run('document.activeElement.matches("[aria-label=关闭下载管理]")'),'Tab from the final task action must remain in the download dialog');
   await key('Tab',['shift']);expect(await run('document.activeElement===[...document.querySelectorAll(".provider-download-panel button")].at(-1)'),'Shift+Tab must wrap to the last dialog action');
   await key('Escape');expect(await run('!document.querySelector(".provider-download-panel")'),'Escape must dismiss downloads');report.restoredFocus=await run('document.activeElement.matches(".provider-download-fab")');reports.at(-1).restoredFocus=report.restoredFocus;if(!report.restoredFocus)failures.push(current+': Downloads must restore trigger focus');
  }
  current='download-results-and-empty';await prepare({});await run('window.providerProbe.setTasks(["failed","completed","downloading"])');await run('document.querySelector(".provider-download-fab").click();window.providerProbe.flush()');
  await run('[...document.querySelectorAll(".provider-download-panel button")].find(button=>button.textContent.trim()==="重试").click();[...document.querySelectorAll(".provider-download-panel button")].find(button=>button.textContent.trim()==="取消").click();[...document.querySelectorAll(".provider-download-panel button")].find(button=>button.textContent.trim()==="打开目录").click();window.providerProbe.flush()');
  expect(await run('window.providerProbe.events.some(event=>event[0]==="retry")&&window.providerProbe.events.some(event=>event[0]==="cancel-download")&&window.providerProbe.events.some(event=>event[0]==="reveal")'),'Download actions must reach their controlled boundaries');
  await run('window.providerProbe.setTasks([])');expect(await run('document.querySelector(".provider-download-empty")?.textContent.includes("暂无下载任务")'),'An emptied download list must explain its state');reports.push({case:current,passed:true});
  expect(networkRequests===0,'Fixture attempted external network: '+requests.join(', '));
  expect(await run('window.providerProbe.errors.length===0'),'Vue reported a runtime error');
  expect(!failures.length,failures.join('; '));
  const searchNavigationScenarioCount=reports.filter(report=>report.case.startsWith('search-command-')).length;
  const searchClearScenarioCount=reports.filter(report=>report.case.startsWith('search-command-clear-')).length;
  expect(searchNavigationScenarioCount===10&&searchClearScenarioCount===2,'All ten search command scenarios, including both clear regressions, must execute');
  const evidence={generatedAt:new Date().toISOString(),bundleSha256:process.env.TWILIGHT_PROVIDER_BUNDLE_SHA,scenarioCount:reports.length,searchNavigationScenarioCount,searchClearScenarioCount,retainedScenarioCount:reports.length-searchClearScenarioCount,baselineScenarioCount:reports.length-searchNavigationScenarioCount,networkRequests,profiles,reports};
  if(process.env.TWILIGHT_STREAMING_REPORT_DIR){fs.mkdirSync(process.env.TWILIGHT_STREAMING_REPORT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_REPORT_DIR,'provider-layout-metrics.json'),JSON.stringify(evidence,null,2))}
  console.log('STREAMING_PROVIDER_LAYOUT_OK '+reports.length+' scenarios; external network requests='+networkRequests);app.exit(0);
 }catch(error){
  const runtime=await run('({calls:window.providerProbe.calls,errors:window.providerProbe.errors,activeElement:document.activeElement?.outerHTML,hasDetailBack:!!document.querySelector(".detail-back-button"),text:window.providerProbe.text})').catch(()=>null);
  if(process.env.TWILIGHT_STREAMING_REPORT_DIR){fs.mkdirSync(process.env.TWILIGHT_STREAMING_REPORT_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.TWILIGHT_STREAMING_REPORT_DIR,'provider-layout-failure.json'),JSON.stringify({current,networkRequests,requests,reports,failures,runtime,error:error.stack},null,2))}
  console.error(current+': '+error.stack);app.exit(1)
 }
});`
