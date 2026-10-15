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
import { parse } from '@vue/compiler-sfc'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../', import.meta.url))

// These are usability budgets, not snapshots of the current CSS: a library
// must show playable content, retain compact sparse rows, and expose its last
// item above the floating player. All page markup comes from production Vue.
test(
  'real local library pages retain useful content and reachable controls across window and text sizes',
  { timeout: 240_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-library-layout-'))
    try {
      await build({
        configFile: false,
        root: workspace,
        logLevel: 'error',
        plugins: [
          {
            name: 'library-layout-playback-boundary',
            enforce: 'pre',
            resolveId(source) {
              return /\/stores\/usePlayerStore(?:\.ts)?$/.test(source)
                ? '\0library-layout-player'
                : null
            },
            load(id) {
              return id === '\0library-layout-player'
                ? 'export const usePlayerStore = () => window.libraryPlayer'
                : null
            }
          },
          vue()
        ],
        resolve: {
          alias: {
            '@renderer': join(workspace, 'src/renderer/src'),
            vue: require.resolve('vue/dist/vue.esm-bundler.js'),
            pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
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
              'src/renderer/src/components/local-library/LocalLibraryLayout.fixture.mjs'
            ),
            name: 'LocalLibraryLayoutTests',
            formats: ['iife'],
            fileName: 'runtime'
          }
        }
      })
      const files = await readdir(join(directory, 'bundle'))
      const script = files.find((name) => name.endsWith('.js'))
      assert.ok(script, 'Vite must bundle the real SongList and navigation wrappers')
      const shell = parse(await readFile(join(workspace, 'src/renderer/src/App.vue'), 'utf8'))
        .descriptor.styles.map((style) => style.content)
        .join('\n')
      await writeFile(
        join(directory, 'index.html'),
        `<!doctype html><html data-theme="pureWhite" data-te-motion="off"><head><meta charset="utf-8">${files
          .filter((name) => name.endsWith('.css'))
          .map((name) => `<link rel="stylesheet" href="bundle/${name}">`)
          .join('')}<style>${shell}
          /* Only external window/player chrome is a fixture. Page dimensions,
             font roles, padding, rows, cards and transitions remain production. */
          #fixture-titlebar{position:fixed;inset:0 0 auto;height:40px;z-index:2200}
          #fixture-start{height:30px;margin:5px;font:inherit}
          #fixture-player{position:fixed;bottom:14px;left:24px;right:24px;height:80px;z-index:1100;background:var(--te-app-bg)}
          </style></head><body class="te-local-surface"><div id="app"></div><script src="bundle/${script}"></script></body></html>`
      )
      await writeFile(join(directory, 'runner.cjs'), electronRunner)
      const env = { ...process.env }
      const fingerprint = createHash('sha256')
      for (const file of files.filter((name) => /\.(?:js|css)$/.test(name)))
        fingerprint.update(await readFile(join(directory, 'bundle', file)))
      env.TWILIGHT_LIBRARY_BUNDLE_SHA = fingerprint.digest('hex')
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron'),
        [join(directory, 'runner.cjs'), directory],
        { windowsHide: true, timeout: 220_000, env, maxBuffer: 4 * 1024 * 1024 }
      )
      assert.match(result.stdout, /LOCAL_LIBRARY_LAYOUT_OK/)
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const electronRunner = `
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const directory=process.argv.at(-1);
app.setPath('userData',path.join(directory,'profile'));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1366,height:768,webPreferences:{offscreen:true,backgroundThrottling:false,nodeIntegration:true,contextIsolation:false}});
 ipcMain.handle('library-layout:input',async(_event,input)=>{
  if(input.text!==undefined) await win.webContents.insertText(input.text);
  else if(input.click){win.webContents.sendInputEvent({type:'mouseDown',...input.click,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',...input.click,button:'left',clickCount:1})}
  else {const modifiers=input.modifiers||[];win.webContents.sendInputEvent({type:'keyDown',keyCode:input.key,modifiers});if(input.key==='Space'||input.key==='Enter')win.webContents.sendInputEvent({type:'char',keyCode:input.key==='Space'?' ':'\\r',modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode:input.key,modifiers})}
  await new Promise(r=>setTimeout(r,25));
 });
 const profiles=[
  {name:'desktop',width:1366,height:768,font:14},
  {name:'narrow',width:760,height:692,font:14},
  {name:'short',width:1100,height:600,font:14},
  {name:'narrow-large',width:760,height:692,font:20},
  {name:'short-large',width:1100,height:600,font:20},
  {name:'desktop-largest',width:1366,height:768,font:28},
  {name:'narrow-largest',width:760,height:692,font:28}
 ];
 const sixCollectionProfiles=[profiles[0],{name:'wide',width:1499,height:884,font:14}];
 let failures=[],reports=[],screenshots=0,current='startup';
 const evidence=process.env.TWILIGHT_LIBRARY_EVIDENCE_DIR||path.join(require('node:os').tmpdir(),'twilight-library-layout-evidence-'+Date.now());
 const capture=async(label)=>{if(screenshots>=12&&!process.env.TWILIGHT_LIBRARY_EVIDENCE_DIR)return;fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,label.replace(/[^a-zA-Z0-9_-]/g,'_')+'.png'),(await win.webContents.capturePage()).toPNG());screenshots++};
 try {
  await win.loadFile(path.join(directory,'index.html'));
  await win.webContents.executeJavaScript("window.libraryNativeInput=input=>require('electron').ipcRenderer.invoke('library-layout:input',input);void 0");
  await win.webContents.executeJavaScript('window.libraryLayoutReady');
  const views=await win.webContents.executeJavaScript('window.libraryLayoutViews');
  for(const tone of ['pureWhite','dark'])for(const profile of profiles){
   win.setContentSize(profile.width,profile.height);
   for(const view of views){
    current=tone+'-'+profile.name+'-'+view;
    const report=await win.webContents.executeJavaScript('window.inspectLibraryLayout('+JSON.stringify({tone,...profile})+','+JSON.stringify(view)+',false)');
    reports.push({case:current,...report});
    if(report.errors.length){failures.push(...report.errors.map(error=>current+': '+error));await capture(current)}
   }
   // Two real records are enough to detect rows/cards stretched to fill a viewport.
   for(const view of ['songs','albums','artists','genres','folders','playlists']){
    current=tone+'-'+profile.name+'-'+view+'-sparse';
    const report=await win.webContents.executeJavaScript('window.inspectLibraryLayout('+JSON.stringify({tone,...profile})+','+JSON.stringify(view)+',true)');
    reports.push({case:current,...report});
    if(report.errors.length){failures.push(...report.errors.map(error=>current+': '+error));await capture(current)}
   }
  }
  for(const tone of ['pureWhite','dark'])for(const profile of sixCollectionProfiles){
   win.setContentSize(profile.width,profile.height);
   for(const view of ['artists','albums','genres','folders','playlists']){
    current=tone+'-'+profile.name+'-'+view+'-six-collections';
    const report=await win.webContents.executeJavaScript('window.inspectLibraryLayout('+JSON.stringify({tone,...profile})+','+JSON.stringify(view)+',false,6)');
    reports.push({case:current,...report});
    if(report.errors.length){failures.push(...report.errors.map(error=>current+': '+error));await capture(current)}
   }
  }
  for(const profile of [profiles[0],profiles[3],profiles[6]]){
   win.setContentSize(profile.width,profile.height);current='interaction-'+profile.name;
   try{reports.push({case:current,...await win.webContents.executeJavaScript('window.exerciseLibraryControls('+JSON.stringify(profile)+')')})}
   catch(error){failures.push(current+': '+error.message);await capture(current)}
  }
  const reportJson=JSON.stringify({capturedAt:new Date().toISOString(),bundleSha256:process.env.TWILIGHT_LIBRARY_BUNDLE_SHA,profiles,sixCollectionProfiles,reports,failures},null,2);
  if(process.env.TWILIGHT_LIBRARY_METRICS_PATH){fs.mkdirSync(path.dirname(process.env.TWILIGHT_LIBRARY_METRICS_PATH),{recursive:true});fs.writeFileSync(process.env.TWILIGHT_LIBRARY_METRICS_PATH,reportJson)}
  if(failures.length||process.env.TWILIGHT_LIBRARY_EVIDENCE_DIR){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'geometry.json'),reportJson);console.error('Library layout evidence: '+evidence)}
  if(failures.length)throw new Error(failures.length+' library layout failures\\n'+failures.slice(0,60).join('\\n'));
  console.log('LOCAL_LIBRARY_LAYOUT_OK '+reports.length+' cases');app.exit(0);
 }catch(error){try{await capture(current+'-error')}catch{}console.error(error.stack);app.exit(1)}
});`
