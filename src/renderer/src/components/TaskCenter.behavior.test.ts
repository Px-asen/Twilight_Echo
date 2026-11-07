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

test('notification dropdown retains tasks, actions and keyboard focus in light and dark windows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-task-center-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await writeFile(join(directory, 'music.ts'), musicFixture)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: [
          {
            find: /^.*\/stores\/useMusicStore(?:\.ts)?$/,
            replacement: join(directory, 'music.ts')
          },
          {
            find: /^.*\/stores\/usePlayerStore(?:\.ts)?$/,
            replacement: join(directory, 'music.ts')
          },
          {
            find: /^.*\/stores\/useNcmStore(?:\.ts)?$/,
            replacement: join(directory, 'music.ts')
          },
          {
            find: 'primeicons/primeicons.css',
            replacement: require.resolve('primeicons/primeicons.css')
          },
          { find: '@renderer', replacement: join(workspace, 'src/renderer/src') },
          { find: 'vue', replacement: require.resolve('vue/dist/vue.esm-bundler.js') }
        ]
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'TaskCenterTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="pureWhite"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join(
          ''
        )}</head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:960,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});try{await win.loadFile(process.argv.at(-1));for(const dark of [false,true]) {await win.webContents.executeJavaScript('window.runTaskCenterTests('+dark+')');await win.webContents.executeJavaScript('window.checkTaskMotion()');for(const [width,height] of [[1360,900],[640,600],[360,320]]) {win.setSize(width,height);await win.webContents.executeJavaScript('window.checkTaskViewport('+width+','+height+')');if(process.env.TASK_CENTER_CAPTURE_DIR&&height>320){await win.webContents.executeJavaScript('new Promise(r=>setTimeout(r,80))');const image=await win.webContents.capturePage();require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_CENTER_CAPTURE_DIR,'任务通知-'+(dark?'深色':'浅色')+'-'+width+'.png'),image.toPNG())}}await win.webContents.executeJavaScript('window.disposeTaskFixture()')}console.log('TASK_CENTER_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 90000 }
    )
    assert.match(result.stdout, /TASK_CENTER_OK/)
  } finally {
    assert.ok(
      resolve(directory).startsWith(resolve(tmpdir()) + '\\') ||
        resolve(directory).startsWith(resolve(tmpdir()) + '/')
    )
    await rm(directory, { recursive: true, force: true })
  }
})

const musicFixture = `import {ref} from 'vue'
export const usePlayerStore=()=>({playTrack:async()=>{calls.push('play')}})
export const useNcmStore=()=>({isLoggedIn:ref(false),profile:ref(null)})
export const scan=ref({state:'idle',current:0,total:10,error:''}),metadata=ref({state:'idle',completed:0,failed:0,skipped:0,total:0,error:''}),tracks=ref([]),calls=[]
export const useMusicStore=()=>({tracks,libraryScanStatus:scan,libraryMetadataEnrichmentStatus:metadata,pauseLibraryScan:async()=>{calls.push('pause');scan.value={...scan.value,state:'paused'}},resumeLibraryScan:async()=>{calls.push('resume');scan.value={...scan.value,state:'running'}},cancelLibraryScan:async()=>{calls.push('cancel');scan.value={...scan.value,state:'cancelled'}},startFullLibraryScan:async()=>{calls.push('retry');scan.value={...scan.value,state:'running',error:''}},cancelLibraryMetadataEnrichment:()=>{}})`

const runtime = `import '@renderer/assets/base.css'
import 'primeicons/primeicons.css'
import {createApp,h,nextTick,ref} from 'vue'
import Host from '@renderer/components/AppNoticeHost.vue'
import TitleBar from '@renderer/components/TitleBar.vue'
import {useAppNoticeStore} from '@renderer/stores/useAppNoticeStore'
import {createInitialAppUpdateSnapshot} from '@renderer/../../shared/appUpdate.ts'
import {coreSnapshot} from '@renderer/stores/coreTestFixtures.ts'
import {disposeCoreConnection} from '@renderer/stores/coreConnection.ts'
import {scan,metadata,calls} from './music'
const expect=(ok,message)=>{if(!ok)throw new Error(message)}
const tick=async()=>{await nextTick();await nextTick();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}
const button=(scope,label)=>[...document.querySelectorAll(scope+' button')].find(el=>el.textContent.trim()===label)
const noticeText=()=>document.querySelector('.notice-records')?.textContent||''
const opened=()=>getComputedStyle(document.querySelector('.notice-history')).display!=='none'
let dispose;
window.disposeTaskFixture=()=>dispose();
window.checkTaskViewport=async(width,height)=>{
  await tick();
  const panel=document.querySelector('.notice-history'),body=panel.querySelector('.notice-history-body'),rect=panel.getBoundingClientRect();
  expect(rect.left>=0&&rect.right<=innerWidth+.5,'dropdown overflows narrow viewport');
  expect(rect.top>=0&&rect.bottom<=innerHeight+.5,'dropdown exceeds short viewport');
  expect(body.clientHeight>0,'scrollable task area disappeared');
  expect(body.scrollWidth<=body.clientWidth+1,'task content overflows horizontally');
  expect(getComputedStyle(panel).position==='fixed'&&getComputedStyle(panel).borderRadius==='18px','original dropdown surface replaced');
  expect(!document.querySelector('.task-overlay'),'centered modal overlay was introduced');
  body.scrollTop=body.scrollHeight;await tick();
  expect(button('.notice-history','打开目录').getBoundingClientRect().right<=rect.right,'download controls overflow');
  body.scrollTop=0;await tick();
  const live=document.querySelector('.task-record');expect(live.getBoundingClientRect().top<body.getBoundingClientRect().bottom,'live task is not visible after scrolling');
}
window.checkTaskMotion=async()=>{
  const store=useAppNoticeStore(),panel=document.querySelector('.notice-history'),bell=document.querySelector('.notification-btn');
  const pointer=()=>bell.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
  const toggle=async()=>{pointer();bell.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));await nextTick()};
  const finish=async()=>{await nextTick();for(const a of document.getAnimations())a.finish();await tick()};
  const freeze=(element,time)=>{const animations=element.getAnimations();expect(animations.length,'missing notification motion: '+element.className+' / '+element.textContent.slice(0,70)+' / '+time+' / '+JSON.stringify({connected:element.isConnected,style:element.getAttribute('style'),parent:element.parentElement?.getAttribute('style'),input:document.documentElement.dataset.teMotionInput}));for(const a of animations){a.pause();a.currentTime=time}return animations};
  await toggle();document.documentElement.dataset.teMotion='full';await tick();await toggle();
  expect(panel.getAnimations().length,'pointer notification panel did not animate');await finish();
  await toggle();freeze(panel,29);const previous=new DOMMatrix(getComputedStyle(panel).transform).a;freeze(panel,30);const current=new DOMMatrix(getComputedStyle(panel).transform).a,alpha=Number(getComputedStyle(panel).opacity);
  await toggle();freeze(panel,0);expect(Math.abs(new DOMMatrix(getComputedStyle(panel).transform).a-current)<.0001&&Math.abs(Number(getComputedStyle(panel).opacity)-alpha)<.01,'notification panel reversal snapped');freeze(panel,1);
  const velocity=new DOMMatrix(getComputedStyle(panel).transform).a-current;
  expect(velocity<0&&Math.abs(velocity-(current-previous))<Math.abs(current-previous)*.4,'notification panel lost reversal velocity');await finish();
  await toggle();await finish();
  for(const notice of store.notices.value)store.dismissNotice(notice.id);await finish();
  const ids=[];
  for(const message of ['正在恢复播放设备','曲库更新已完成','下载任务可以继续'])ids.push(store.pushNotice({kind:'error',message,presentation:'toast',sticky:true}));
  await nextTick();await finish();
  const cards=[...document.querySelectorAll('.app-notice')],host=document.querySelector('.app-notice-host');
  const last=cards[2],originalTop=last.getBoundingClientRect().top;
  store.dismissNotice(ids[0]);await nextTick();expect(cards[0].inert&&cards[0].getAnimations().length,'leaving notice disappeared or stayed interactive');freeze(last,29);const before=last.getBoundingClientRect().top;freeze(last,30);const at=last.getBoundingClientRect().top;
  expect(at<originalTop&&last.getAnimations().length,'notice stack did not close the gap');store.dismissNotice(ids[1]);await nextTick();freeze(last,0);expect(Math.abs(last.getBoundingClientRect().top-at)<.5,'second dismissal jumped the moving notification');freeze(last,1);
  const after=last.getBoundingClientRect().top;expect(after<at&&Math.abs((after-at)-(at-before))<Math.abs(at-before)*.4,'notification stack lost incoming velocity');await finish();
  store.dismissNotice(ids[2]);await nextTick();freeze(last,30);expect(host.clientHeight>=last.offsetHeight,'last toast was clipped by collapsing scroll viewport: '+JSON.stringify({height:host.clientHeight,row:last.offsetHeight,host:host.getAttribute('style'),card:last.getAttribute('style'),box:getComputedStyle(host).boxSizing}));await finish();expect(!document.querySelector('.app-notice')&&!host.style.minHeight,'toast stack retained exit geometry');
  const quick=store.pushNotice({kind:'error',message:'快速完成的通知',presentation:'toast',sticky:true});await nextTick();const card=document.querySelector('.app-notice');freeze(card,35);const startAlpha=Number(getComputedStyle(card).opacity);store.dismissNotice(quick);await nextTick();freeze(card,0);expect(Math.abs(Number(getComputedStyle(card).opacity)-startAlpha)<.01,'toast dismissed during entry restarted');document.documentElement.dataset.teVisibility='hidden';await tick();expect(!document.querySelector('.app-notice'),'hidden window retained toast exit');delete document.documentElement.dataset.teVisibility;
  document.documentElement.dataset.teMotion='reduced';await tick();await toggle();freeze(panel,35);expect(getComputedStyle(panel).transform==='none','reduced notification panel scaled');await finish();await toggle();await finish();
  document.documentElement.dataset.teMotion='full';document.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));bell.click();await tick();expect(opened()&&!panel.getAnimations().length,'keyboard notification opening animated');bell.click();await tick();expect(!opened(),'keyboard notification close waited');
  document.documentElement.dataset.teMotion='off';await tick();bell.click();await tick();
};
window.runTaskCenterTests=async dark=>{
  document.documentElement.dataset.theme=dark?'dark':'pureWhite';document.documentElement.dataset.teMotion='off';
  const store=useAppNoticeStore();store.clearNotices();store.setDoNotDisturb(false);store.setCenterOpen(false);scan.value={state:'idle',current:0,total:10,error:''};metadata.value={state:'idle',total:0,completed:0,failed:0,skipped:0};calls.length=0;
  let message,updateChanged,retries=0,revealed=0,installed=0,library=0,stops=0,disconnected=0;
  let snapshot=createInitialAppUpdateSnapshot();
  let state=coreSnapshot({epoch:'fixture-'+dark,downloads:{revision:0,active:0,total:0}}),downloadTasks=[];
  const commands=[];
  const publish=patch=>{state={...state,...patch,sequence:state.sequence+1};message({connectionId:'fixture',message:{kind:'state',epoch:state.epoch,sequence:state.sequence,snapshot:state}})};
  const downloadsChanged=tasks=>{downloadTasks=tasks;publish({downloads:{revision:state.downloads.revision+1,total:tasks.length,active:tasks.filter(t=>t.status==='downloading').length}})};
  window.api={
    window:{getState:async()=>({maximized:false}),onStateChanged:()=>()=>{}},
    core:{
      connect:async()=>({ok:true,value:{connectionId:'fixture',snapshot:state}}),
      onMessage:fn=>{message=fn;return()=>stops++},onStatus:()=>()=>stops++,
      disconnect:async()=>{disconnected++;return {ok:true}},cancel:async()=>({ok:true}),
      request:async(_id,request)=>{
        if(request.name==='metadata.entity.tasks')return {ok:true,value:{offset:0,total:0,counts:{queued:0,running:0,retry_wait:0,needs_review:0,blocked:0,failed:0,completed:0,cancelled:0},items:[]}};
        if(request.name==='downloads.page')return {ok:true,value:{...state.downloads,offset:0,items:downloadTasks}};
        if(request.name==='downloads.indexed')return {ok:true,value:{indexed:true}};
        commands.push(request);
        if(request.name==='downloads.retry')retries++;
        else if(request.name==='downloads.reveal')revealed++;
        else if(request.name==='downloads.play')calls.push('play');
        else if(request.name!=='library.loudness.cancel')throw new Error('unexpected Core operation: '+request.name);
        return {ok:true};
      }
    },
    app:{getUpdateState:async()=>snapshot,onUpdateState:fn=>{updateChanged=fn;return()=>stops++},installUpdate:async()=>{installed++}}
  };
  const host=ref();
  scan.value={state:'completed',current:10,total:10,error:''};
  const app=createApp({render:()=>h('div',{},[h(TitleBar,{menuOpen:false,hideStart:true,notificationsOpen:store.centerOpen.value,onNotifications:event=>host.value.toggleHistory(event)}),h('button',{id:'outside'},'页面操作'),h(Host,{ref:host,onLibrary:()=>library++})])});app.mount('#app');await tick();
  document.querySelector('.notification-btn').click();await tick();
  expect(document.querySelector('.task-record')&&!store.noticeHistory.value.length,'initial completed scan fixture missing');
  expect(!button('.notice-history','清空记录').disabled,'completed initial scan cannot be cleared');
  button('.notice-history','清空记录').click();await tick();expect(!document.querySelector('.task-record'),'completed initial scan reappeared after clearing');
  document.querySelector('.notification-btn').click();scan.value={state:'idle',current:0,total:10,error:''};await tick();
  for(const kind of ['info','success','warning'])store.pushNotice({kind,message:'通知结果 '+kind});await tick();
  expect(!opened(),'notification opened the center automatically');expect(!document.querySelector('.app-notice'),'routine information interrupted the page');expect(store.unreadCount.value===3,'quiet outcomes lost unread state');
  scan.value={state:'running',current:4,total:10,error:''};await tick();expect(store.activeTaskCount.value===1,'closed dropdown stopped task updates');
  const bell=document.querySelector('.notification-btn');expect(bell.querySelector('.notification-dot'),'normal unread indicator missing');bell.focus();bell.click();await tick();
  expect(document.querySelectorAll('[role=dialog]').length===1,'notifications and tasks opened separate dialogs');expect(document.querySelectorAll('.notice-history').length===1,'history displayed twice');expect(noticeText().includes('通知结果 success'),'user result unavailable in shared panel');expect(store.unreadCount.value===0,'visible history was not marked read');
  expect(document.querySelector('progress[aria-label="曲库扫描"]').value===0.4,'live scan progress missing');button('.notice-history','暂停').click();await tick();button('.notice-history','继续').click();await tick();expect(calls.join(',')==='pause,resume','task controls lost behavior');
  scan.value={state:'completed',current:10,total:10,error:''};await tick();expect(noticeText().includes('曲库扫描：已完成'),'background completion disappeared');expect(!document.querySelector('.task-record'),'completion duplicated in live tasks');expect(!store.notices.value.length,'background completion became a toast');
  button('.notice-history','清空记录').click();await tick();expect(!noticeText().includes('曲库扫描')&&!document.querySelector('.task-record'),'cleared scan result reappeared');
  const loudness={id:'core-plan',libraryRevision:0,groups:2,tracks:2,skipped:0,status:{state:'running',jobId:'private-job',revision:1,total:2,processed:1,failed:0,currentTitle:'后台专辑'}};
  publish({libraryLoudness:loudness});await tick();expect(document.querySelector('progress[aria-label="响度分析"]').value===0.5,'Core loudness progress missing');
  button('.notice-history','取消').click();await tick();expect(commands.at(-1).name==='library.loudness.cancel'&&commands.at(-1).payload.id==='core-plan','loudness cancellation did not use the Core plan identity');
  publish({libraryLoudness:{...loudness,status:{...loudness.status,state:'completed',revision:2,processed:2}}});await tick();expect(noticeText().includes('响度分析：已完成'),'Core loudness completion was not retained');
  scan.value={state:'running',current:1,total:10,error:''};await tick();scan.value={state:'failed',current:1,total:10,error:'无法读取文件'};await tick();expect(noticeText().includes('无法读取文件'),'background error is not recoverable');button('.notice-records','重试').click();await tick();expect(calls.at(-1)==='retry','scan retry lost');
  const task=status=>({id:'download-'+dark,providerId:'fixture',track:{id:'track',title:'下载旋律',artist:'艺人'},requestedQuality:'aac',actualQuality:'aac',status,progress:status==='completed'?1:0.2,fileSize:10,error:status==='failed'?'连接中断':null,createdAt:'2026-10-06',updatedAt:'2026-10-06'});
  downloadsChanged([task('downloading')]);await tick();downloadsChanged([task('failed')]);await tick();expect(noticeText().includes('下载失败'),'download failure has no retained result');button('.notice-records','重新下载').click();await tick();expect(retries===1,'download retry lost');downloadsChanged([task('completed')]);await tick();button('.notice-records','打开目录').click();await tick();expect(revealed===1,'completed download action lost');button('.notice-records','播放本地文件').click();await tick();expect(calls.includes('play'),'completed download playback lost');
  snapshot={...snapshot,progress:{...snapshot.progress,phase:'ready',version:'1.2.0',message:'更新包已就绪'}};updateChanged(snapshot);await tick();button('.notice-history','安装更新').click();await tick();expect(installed===1,'ready update install action lost');
  let attempts=0,reject;
  store.pushNotice({message:'用户操作可以重试',presentation:'center',action:{label:'恢复',run:()=>{attempts++;if(attempts===1)return new Promise((_,no)=>reject=no)}}});await tick();
  button('.notice-history','恢复').click();button('.notice-history','恢复').click();await tick();expect(attempts===1,'duplicate action ran concurrently');reject(new Error('设备不可用'));await tick();expect(button('.notice-history','恢复'),'failed action was consumed');expect(noticeText().includes('设备不可用'),'action failure is not visible');button('.notice-history','恢复').click();await tick();expect(attempts===2 && !button('.notice-history','恢复'),'retry action did not complete');
  button('.notice-filters','进行中').click();await tick();store.pushNotice({message:'仍未阅读的用户结果'});await tick();expect(store.unreadCount.value===1,'hidden notification was incorrectly marked read');button('.notice-filters','需处理').click();await tick();expect(store.unreadCount.value===1,'attention filter swallowed unseen normal result');expect(button('.notice-history','安装更新'),'attention filter hid a ready update');button('.notice-filters','全部').click();await tick();expect(store.unreadCount.value===0,'all filter did not show/read result');
  const focusable=[...document.querySelectorAll('.notice-history button:not(:disabled)')].filter(el=>el.getClientRects().length);focusable.at(-1).focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));expect(document.activeElement===focusable[0],'Tab escaped the dropdown');
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();expect(!opened()&&document.activeElement===bell,'Escape did not close and restore bell focus');expect(stops===0,'closing dropdown disconnected background services');
  scan.value={state:'completed',current:10,total:10,error:''};await tick();expect(store.activeTaskCount.value===0,'closed dropdown count did not update');
  store.pushNotice({kind:'error',message:'播放被阻止'});await tick();expect([...document.querySelectorAll('.app-notice')].some(el=>el.textContent.includes('播放被阻止')),'necessary playback error was hidden');
  bell.click();await tick();const dnd=document.querySelector('[role=switch][aria-label="勿扰模式"]');expect(dnd.getAttribute('aria-checked')==='false','do not disturb did not default to off');dnd.click();await tick();expect(dnd.getAttribute('aria-checked')==='true'&&store.doNotDisturb.value,'do not disturb switch did not enable');expect(!store.notices.value.length,'enabling do not disturb retained active alerts');
  window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();let quietActions=0;store.pushNotice({kind:'error',message:'勿扰期间的错误',action:{label:'静默重试',run:()=>{quietActions++}}});store.pushNotice({message:'勿扰期间更新已就绪',presentation:'toast',sticky:true});await tick();expect(!document.querySelector('.app-notice')&&!bell.querySelector('.notification-dot'),'do not disturb allowed a toast or unread reminder');expect(bell.title.includes('勿扰模式已开启')&&bell.getAttribute('aria-label').includes('勿扰模式已开启'),'bell did not explain muted state');expect(store.unreadCount.value===2,'muted notices lost unread history');
  bell.click();await tick();expect(noticeText().includes('勿扰期间的错误')&&noticeText().includes('勿扰期间更新已就绪'),'muted results were not retained');button('.notice-history','静默重试').click();await tick();expect(quietActions===1,'muted notification action did not work');dnd.click();await tick();expect(dnd.getAttribute('aria-checked')==='false','do not disturb switch did not disable');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await tick();expect(!document.querySelector('.app-notice'),'disabling do not disturb replayed old alerts');store.pushNotice({kind:'error',message:'关闭勿扰后恢复提醒'});await tick();expect(document.querySelector('.app-notice')&&bell.querySelector('.notification-dot'),'normal reminders did not resume');
  bell.click();await tick();button('.notice-history','查看曲库').click();await tick();expect(library===1&&!opened(),'library action did not navigate and close dropdown');
  bell.click();await tick();document.querySelector('#outside').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await tick();expect(!opened(),'outside click did not close dropdown');
  scan.value={state:'running',current:7,total:10,error:''};bell.click();await tick();button('.notice-history','清空记录').click();await tick();expect(scan.value.state==='running'&&!calls.includes('cancel'),'clearing history cancelled a live task');
  expect(![...document.querySelectorAll('.task-record')].some(el=>el.textContent.includes('下载旋律')),'cleared download result reappeared');
  store.pushNotice({kind:'success',message:'下载完成 · '+('长曲名与路径'.repeat(18)),presentation:'center',downloadTaskId:task('completed').id});store.pushNotice({kind:'info',message:'曲库扫描：已完成，新增 12 首歌曲。'});await tick();
  dispose=()=>{const writes=commands.length;app.unmount();expect(stops===1,'task view did not release the update subscription');disposeCoreConnection();expect(stops===3&&disconnected===1,'window did not release its Core connection');expect(commands.length===writes,'unmount sent a business command');store.clearNotices()};
}
`
