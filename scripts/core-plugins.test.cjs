'use strict'
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const test = require('node:test')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'Core owns real plugin hosts, credentials and cancellable providers without any BrowserWindow',
  { timeout: 90_000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-plugins-'))
    try {
      const runner = join(directory, 'runner.cjs')
      buildSync({
        stdin: { contents: fixture, resolveDir: root },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        define: {
          'import.meta.url': JSON.stringify(
            require('node:url').pathToFileURL(join(root, 'package.json')).href
          )
        },
        outfile: runner
      })
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const execution = promisify(execFile)(require('electron'), [runner, root], {
        env,
        windowsHide: true,
        timeout: 80_000,
        maxBuffer: 2 * 1024 * 1024
      })
      execution.child.stderr?.on('data', (data) => process.stderr.write(data))
      execution.child.stdout?.on('data', (data) => process.stdout.write(data))
      await execution
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')), {
        windows: 0,
        pluginPorts: 4,
        businessViaMain: 0,
        credentialPreserved: true,
        ncmGateway: true,
        cloudTransferHeadless: true,
        pauseResponsive: true,
        cancelled: true,
        unknownWriteNotReplayed: true,
        playlistImportDurable: true,
        playlistRecovery: true,
        recordingVersionsDurable: true,
        playlistViews: true,
        importMatchingHeadless: true,
        importPreviewHeadless: true,
        bookmarksDurable: true,
        lyricsHeadless: true,
        workspaceDurable: true,
        namedRestoreHeadless: true,
        streamsHeadless: true,
        networkHeadless: true,
        networkCacheHeadless: true,
        personalizedHeadless: true,
        heartHeadless: true,
        searchHeadless: true,
        collectionsHeadless: true,
        sourceRefreshHeadless: true,
        sourceRepairHeadless: true,
        metadataHeadless: true,
        pluginMarketplaceHeadless: true,
        experienceHeadless: true,
        hostsAfterShutdown: 0
      })
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-plugins-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const pluginSource = String.raw`
export async function activate({ settings, twilight }) {
  const cookie = await settings.get('cookie')
  await Promise.all([
    settings.set('boots', ((await settings.get('boots')) ?? 0) + 1),
    settings.set('volume', 0.25)
  ])
  twilight.ui.onCommand('fixture.import', paths => twilight.library.importPlaylists({ playlists: [{ name: 'Headless import', paths }] }))
  await twilight.ui.register({ id:'import', kind:'localSidebarItem', title:'Import fixture', command:'fixture.import' })
  twilight.ui.onCommand('fixture.expire', () => settings.set('failExpired', true))
  await twilight.ui.register({ id:'expire', kind:'localSidebarItem', title:'Expire fixture', command:'fixture.expire' })
  let cancelled = false, searchActive = false, searchCancelled = false
  const sourceRefresh = []
  await twilight.providers.register({
    id: 'fixture', name: 'Fixture', capabilities: ['playbackUrl', 'lyrics', 'search', 'login', 'library'],
    async getProfile() {
      return { credentialPreserved: cookie === 'legacy-credential', boots: await settings.get('boots'),
        volume: await settings.get('volume'), writes: await settings.get('writes'), cancelled, searchActive, searchCancelled, sourceRefresh }
    },
    async getPlaybackUrl(track, options, invocation) {
      if(track.id==='fixture:expired') {
        if(await settings.get('failExpired')) return null
        sourceRefresh.push(options.force===true)
        return {streamUrl:'https://example.invalid/refreshed.flac?token=fresh',providerSource:{expiresAt:Date.now()+(options.force?60000:-1)}}
      }
      if(track.id==='fixture:replacement') return {streamUrl:await settings.get('silentSource')}
      if (track.id.endsWith('slow')) await new Promise((resolve, reject) =>
        invocation.signal.addEventListener('abort', () => { cancelled = true; reject(Error('cancelled')) }, { once: true }))
      return { streamUrl: 'https://example.invalid/track.flac?token=fixture', providerSource: { expiresAt: Date.now() + 60000 } }
    },
    async searchSongs(query, limit, offset, invocation) {
      if(query==='Expired authority Other') return {items:[{id:'fixture:replacement',source:'fixture',title:'Expired authority',artist:'Other',album:'',duration:180,filePath:'',fileName:'',size:0,cover:null,lyrics:null}],total:1}
      if(query==='slow-search') {
        searchActive=true
        await new Promise((resolve,reject)=>invocation.signal.addEventListener('abort',()=>{searchActive=false;searchCancelled=true;reject(Error('cancelled search'))},{once:true}))
      }
      return { items: [{ id:'fixture:one', source:'fixture', title:'One', artist:'Artist', album:'Headless metadata', genre:'Jazz', duration:180, filePath:'fixture:one', fileName:'One', size:0, cover:null, lyrics:null }], total:1 }
    },
    async searchAlbums() { return { items:[{id:'fixture:album',name:'One album',artist:'Artist',cover:null,trackCount:1}],total:1 } },
    async searchArtists() { return { items:[{id:'fixture:artist',name:'Artist',picUrl:null,musicSize:1}],total:1 } },
    async searchPlaylists() { return { items:[{id:'fixture:list',name:'Headless online',cover:null,trackCount:1}],total:1 } },
    async getLyrics() { await new Promise(r=>setTimeout(r,100)); return { lyrics:'[00:00.00]Headless lyric', translatedLyrics:'[00:00.00]Headless translation' } },
    async likeTrack() { await settings.set('writes', (await settings.get('writes')) + 1); return true },
    async fetchPersonalFm() { const n=((await settings.get('fmCalls'))??0)+1;await settings.set('fmCalls',n);await new Promise(r=>setTimeout(r,100));return [1,n+1].map(id=>({id:'fixture:fm-'+id,source:'fixture',title:'FM '+id,artist:'Artist',duration:180})) },
    async fetchPrivateContent() { return [] },
  })
}
`
const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { CoreStateDatabase } = require('./src/main/library/coreStateDatabase.ts')
const { LibraryDatabase } = require('./src/main/library/libraryDatabase.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { createPluginManagerPlatform } = require('./src/main/plugins/platform.ts')
const { protectJsonValue, unprotectJsonValue, protectString } = require('./src/main/security/secureStorage.ts')
const { createNetworkCorePlatform } = require('./src/main/network/corePlatform.ts')
const { remoteMediaGrants } = require('./src/main/security/remoteMediaGrants.ts')
const { writeFileSync, readFileSync, mkdirSync } = require('node:fs')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile'), pluginId = 'com.example.core-provider'
app.disableHardwareAcceleration(); mkdirSync(profile); app.setPath('userData', profile)
const alive = new Set(), children = []
let supervisor, serial = 0, pluginPorts = 0, businessViaMain = 0, dropWrite = false, dropBookmark = false, dropLyrics = false, dropWorkspace = false, dropRestore = false, dropMetadata = false, allowSourceRepair = false
function readPlaylists() {
  const database = new LibraryDatabase(join(profile, 'music-library.sqlite'))
  try { return database.preferencesPlaylistsLoad() } finally { database.close() }
}
async function main() {
  await app.whenReady()
  if(process.platform==='win32') {
    const mountCalls=[]
    const os=createNetworkCorePlatform(profile,{mount:async(command,args)=>{mountCalls.push({command,args});return {code:0,stdout:'',stderr:''}}})
    const first=new AbortController(), second=new AbortController(), live=new AbortController()
    const open={command:'net',args:['use','\\\\fixture.invalid\\music','','/user:guest']}
    const close={command:'net',args:['use',open.args[1],'/delete','/y']}
    await os['network.mountCommand'](open,first.signal);await os['network.mountCommand'](open,second.signal)
    assert.equal(mountCalls.length,1)
    await os['network.mountCommand'](close,live.signal)
    first.abort();await new Promise(resolve=>setImmediate(resolve))
    assert.equal(mountCalls.length,1)
    second.abort();await os['network.mountCommand'](close,live.signal)
    assert.equal(mountCalls.length,2)
    await assert.rejects(()=>os['network.mountCommand']({command:'cmd',args:['/c','echo bad']},live.signal),/Unsupported/)
    await assert.rejects(()=>os['network.sftp']({connection:{host:'nas',username:'alice',port:22,keyPath:'/key'},operation:{kind:'download',path:'/a.flac',local:join(profile,'outside.tmp')}},live.signal),/outside/)
  }
  const library = join(profile, 'music-library.json')
  const localPath = join(profile, 'one.flac')
  const cuePath = join(profile, 'disc.flac')
  writeFileSync(library, JSON.stringify({ version: 2, revision: 0, tracks: [
    { id:'one', title:'One', artist:'Artist', filePath:localPath, duration:180 },
    { id:'cue:disc:1', title:'Cue one', filePath:cuePath, duration:30, cueRange:{ startSeconds:0, endSeconds:30 } },
    { id:'cue:disc:2', title:'Cue two', filePath:cuePath, duration:40, cueRange:{ startSeconds:30, endSeconds:70 } },
    { id:'fixture:expired',source:'fixture',title:'Expired authority',artist:'Other',duration:180,filePath:'https://example.invalid/persisted.flac?token=obsolete' }
  ], folders: [], exclusions: [] }))
  const resumeTrack = {id:'one',title:'One',artist:'Artist',filePath:localPath,duration:180}
  writeFileSync(join(profile,'one.lrc'),'[00:00.00]Headless sidecar')
  writeFileSync(join(profile,'lyrics-management.json'),JSON.stringify({schemaVersion:1,globalOffsetMs:50,showOriginal:true,showTranslation:true,showRomanization:false,tracks:{one:{source:'auto',offsetMs:125,original:null,translation:null,romanization:null,updatedAt:'2024-01-01'}}}))
  writeFileSync(join(profile,'playback-session.json'),JSON.stringify({version:1,savedAt:new Date().toISOString(),mode:'trackAndPosition',track:resumeTrack,position:42,queue:[resumeTrack],queueIndex:0,playMode:'sequential'}))
  const selectedOccurrence='queue:'+localPath+':'+ 'folder/'.repeat(30)
  const savedEntries=[
    {id:'removed',queueEntryId:'saved:missing',source:'local',filePath:join(profile,'missing.flac'),title:'Gone',artist:'',album:'',duration:0},
    ...['saved:cue:first','saved:cue:second'].map(queueEntryId=>({id:'cue:disc:2',queueEntryId,source:'local',filePath:cuePath,title:'Saved CUE',artist:'',album:'',duration:40,cueRange:{startSeconds:30,endSeconds:70}})),
    {id:'one',queueEntryId:selectedOccurrence,source:'local',filePath:localPath,title:'Old name',artist:'Artist',album:'',duration:180},
    {id:'fixture:one',queueEntryId:'saved:provider',source:'fixture',title:'Remote',artist:'',album:'',duration:180},
    {id:'network:one',queueEntryId:'saved:network',source:'network',title:'NAS',artist:'',album:'',duration:180,network:{profileId:'legacy-nas',entryId:'network:one',path:'/music/a.flac',name:'a.flac'}}
  ]
  const savedSessions=['legacy-array','overlap-array'].map(id=>({id,name:id,createdAt:'2024-01-01',updatedAt:'2024-01-01',entries:savedEntries,originalEntryIds:savedEntries.map(e=>e.queueEntryId).reverse(),currentEntryId:selectedOccurrence,position:42,playMode:'shuffle'}))
  writeFileSync(join(profile,'queue-workspace.json'),JSON.stringify({version:1,sessions:savedSessions,history:[{id:'legacy-history',playedAt:'2024-01-01',track:{id:'ncm:7',queueEntryId:'old-occurrence',source:'ncm',ncmSongId:7,title:'Old',artist:'Artist',album:'Album',duration:180},playMode:'heart'}]}))
  writeFileSync(join(profile,'playlists.json'),JSON.stringify([{id:'repeated',name:'Repeated CUE',isDefault:true,createdAt:'2024-01-01',trackIds:['cue:disc:2','cue:disc:2']},{id:'source-repair',name:'Repair references',createdAt:'2024-01-01',trackIds:['fixture:expired']}]))
  let feedRequests=0
  const feedServer=createServer((req,res)=>{
    feedRequests++;assert.equal(req.headers['if-none-match'],'"old"')
    setTimeout(()=>{res.setHeader('ETag','"new"');res.end('<rss><channel><title>Headless cast</title><item><guid>urn:episode:one</guid><title>Updated episode</title><enclosure url="https://example.invalid/new.mp3?token=private"/><duration>120</duration></item></channel></rss>')},100)
  })
  await new Promise(resolve=>feedServer.listen(0,'127.0.0.1',resolve))
  const feedUrl='http://127.0.0.1:'+feedServer.address().port+'/feed'
  writeFileSync(join(profile,'podcast-subscriptions.json'),JSON.stringify({schemaVersion:1,subscriptions:[{id:'headless',feedUrl,title:'Legacy cast',createdAt:'2024-01-01',updatedAt:'2024-01-01',feedEtag:'"old"',episodes:[{guid:'urn:episode:one',title:'Old episode',mediaUrl:'https://example.invalid/old.mp3',durationSeconds:120,progressSeconds:42}]}]}))
  const db = new CoreStateDatabase(join(profile, 'core-state.sqlite'))
  let networkRequests=0
  const networkServer=createServer((req,res)=>{
    assert.equal(req.headers.authorization, 'Basic '+Buffer.from('alice:legacy-network-password').toString('base64'))
    assert.equal(req.method,'PROPFIND'); networkRequests++
    setTimeout(()=>{res.writeHead(207,{'Content-Type':'application/xml'});res.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/music/a.flac</d:href><d:propstat><d:prop><d:getcontentlength>4</d:getcontentlength><d:getcontenttype>audio/flac</d:getcontenttype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>')},100)
  })
  await new Promise(resolve=>networkServer.listen(0,'127.0.0.1',resolve))
  mkdirSync(join(profile,'network-sources'))
  const legacyNetworkCiphertext=JSON.stringify(protectString('legacy-network-password','network-source-credentials'))
  writeFileSync(join(profile,'network-sources','profiles.json'),JSON.stringify({profiles:[{id:'legacy-nas',protocol:'webdav',name:'Legacy NAS',host:'127.0.0.1',port:networkServer.address().port,rootPath:'/music',username:'alice',credential:{kind:'password',encryptedId:legacyNetworkCiphertext},options:{readOnly:true,connectTimeoutMs:10000,transferTimeoutMs:60000,maxConcurrentTransfers:2},bookmarks:[],createdAt:1,lastConnectedAt:null}]}))
  const migrationCounts=emptyCoreStateCounts();migrationCounts['podcast-preferences']=1
  await db.begin('empty-upgrade', { version: 1, counts: migrationCounts })
  await db.stage('empty-upgrade',0,'podcast-preferences',[{key:'defaultPlaybackRate',value:1.25}])
  await db.commit('empty-upgrade'); db.close()
  const pkg = join(profile, 'plugins', pluginId, '1.0.0'), data = join(profile, 'plugin-data', pluginId)
  mkdirSync(pkg, { recursive: true }); mkdirSync(data, { recursive: true })
  const silentSource=join(data,'silent.wav'), wav=Buffer.alloc(44+88200)
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(44100,24);wav.writeUInt32LE(88200,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(88200,40)
  writeFileSync(silentSource,wav)
  const credential = protectJsonValue('legacy-credential', 'plugin-settings:' + data + ':cookie')
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ cookie: credential, writes: 0, silentSource }))
  writeFileSync(join(profile, 'plugin-state.json'), JSON.stringify({ [pluginId]: { enabled: true, activeVersion: '1.0.0', source: 'directory', installedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }))
  const manifest={ id: pluginId, name: 'Core fixture', version: '1.0.0', description: 'silent integration', author: 'fixture', license: 'MIT', main: 'index.mjs', type: ['provider', 'tool', 'ui'], apiVersion: 4, engines: { twilightEcho: '*' }, permissions: ['settings','network','library:read','library:write', 'ui:inject','player:control','player:observe'], contributes:{experiences:[{id:'library',name:'Library',entry:'ui/index.html',bridgeVersion:2}]} }
  writeFileSync(join(pkg, 'plugin.json'), JSON.stringify(manifest))
  mkdirSync(join(pkg,'ui'));writeFileSync(join(pkg,'ui','index.html'),'<main>Headless experience</main>')
  const marketFile=join(profile,'market.json')
  writeFileSync(marketFile,JSON.stringify({schemaVersion:1,plugins:[{...manifest,version:'1.1.0',sourceUrl:'https://example.invalid/fixture.tep',checksumSha256:'a'.repeat(64)}]}))
  writeFileSync(join(pkg, 'index.mjs'), plugin)
  const ncmId = 'com.twilightecho.provider.ncm', ncmPkg = join(profile, 'plugins', ncmId, '1.0.0')
  mkdirSync(ncmPkg, { recursive: true })
  const states = JSON.parse(readFileSync(join(profile,'plugin-state.json'),'utf8'))
  states[ncmId] = { ...states[pluginId] }
  writeFileSync(join(profile,'plugin-state.json'), JSON.stringify(states))
  writeFileSync(join(ncmPkg,'plugin.json'), JSON.stringify({ id:ncmId, name:'Core NCM fixture', description:'silent integration', author:'fixture', license:'MIT', version:'1.0.0', main:'index.mjs', type:['provider'], apiVersion:1, engines:{twilightEcho:'*'}, permissions:['settings','network','library:read'] }))
  writeFileSync(join(ncmPkg,'index.mjs'), 'export async function activate({ twilight }) { let completed=0; await twilight.providers.register({ async prepareCloudUpload() { await new Promise(r=>setTimeout(r,100)); return {needUpload:false,songId:1,resourceId:"private-resource"} }, async completeCloudUpload() { completed++;return true }, async fetchCloudSongsPage() { return {completed} }, id: "ncm", name: "NCM fixture", capabilities: ["login","playbackUrl","playlist","library"], async fetchUserLibrary() { return {likedPlaylist:{id:123}} }, async fetchLikedTracksPage() { return {tracks:[1,2,3].map(id=>({id:"ncm:"+id,source:"ncm",ncmSongId:id,title:"Liked "+id,duration:180})),nextOffset:3,hasMore:false} }, async fetchIntelligenceList(seed) { if(seed.playlistId!==123||seed.count!==20) throw Error("Wrong heart context"); await new Promise(r=>setTimeout(r,100)); return [10,11,12,13].map(id=>({id:"ncm:"+id,source:"ncm",ncmSongId:id,title:"Heart "+id,duration:180})) }, async readPlaylistImportPage(id, offset) { await new Promise(r => setTimeout(r, 100)); return { name: "Headless preview", songs: [{ title: "Remote", platform: "ncm", platformId: "77" }], total: 2, nextOffset: offset + 1, hasMore: offset === 0 } }, async getProfile() { return twilight.internal.ncm.request("/inner/version") }, async getPlaybackUrl() { throw Error("Matching must not resolve expiring audio URLs") } }) }')
  const platform = createPluginManagerPlatform({ userData: profile, launchHost() { throw Error('main cannot choose a host from plugin payloads') } })
  supervisor = new CoreSupervisor({
    configuration: { root: profile, libraryFilePath: library, coverCacheDir: join(profile,'covers'), libraryStorage: 'sqlite', resumeMode:'trackAndPosition', plugins: { appVersion: '1.0.0', hostIdleTimeoutMs: 0, index:{localPath:marketFile} } },
    entries: Object.fromEntries(Object.entries({ core:'musicCore', audio:'audioEngineService','audio-test':'audioEngineService', database:'libraryDatabaseService', scan:'libraryScanService', analysis:'audioAnalysisService', plugin:'pluginHost' }).map(([name,file]) => [name,join(root,'out/main',file+'.js')])),
    readyTimeoutMs: 30_000, requestTimeoutMs: 3000, stopTimeoutMs: 5000,
    platform: {
      'ncm.chooseUploadFiles': async () => {
        const path = join(profile, 'cloud-upload.wav')
        writeFileSync(path, 'fixture upload; never opens an audio device')
        return [path]
      },
      'downloads.authorizedRoots': async ({libraryFolders}) => ({libraryRoots: libraryFolders, downloadRoot: null}),
      'artwork.present': async () => ({cover:null,coverSource:null}),
      'artwork.remotePreview': async () => null,
      ...createDspCorePlatform(),
      ...createNetworkCorePlatform(profile),
      'paths.authorizeAudio': async () => { throw Error('Playback is not authorized by this silent test') },
      'paths.prepareAudio': async ({source}) => {
        if(allowSourceRepair && source===silentSource) return source
        throw Error('Playback is not authorized by this silent test')
      },
      'paths.authorizeAudioFile': async ({ path }) => { assert.equal(path,localPath); return path },
      'paths.areAudioFilesAuthorized': async ({ paths }) => paths.map(path=>path===localPath||path===cuePath),
      'media.resolveAudio': async ({ handle }) => remoteMediaGrants.resolve(handle,'audio'),
      'media.protectProviderResult': async ({ value, method }) => platform.protectProviderResult(value,method),
      'overlay.hide': async () => {},
      'credentials.protect': async ({ value, scope }) => protectJsonValue(value,scope),
      'credentials.unprotect': async ({ value, scope }) => unprotectJsonValue(value,scope)
    },
    fork(entry,args,serviceName) {
      const child = utilityProcess.fork(entry,args,{ serviceName, stdio:'pipe', env: { ...process.env, TWILIGHT_PLUGIN_PROXY_MODE:'off' } })
      children.push({ child,serviceName }); alive.add(child); child.once('exit',()=>alive.delete(child))
      child.stderr?.on('data',data=>process.stderr.write(data))
      const post = child.postMessage.bind(child)
      child.postMessage = (message,ports=[]) => {
        if (serviceName === 'twilight-plugin') {
          if (message.kind === 'core:attach-service') pluginPorts += ports.length
          else businessViaMain++
        }
        return post(message,ports)
      }
      const emit = child.emit.bind(child)
      child.emit = (event,...args) => {
        const message = args[0]
        if (dropRestore && serviceName === 'twilight-core' && event === 'message' && message?.kind === 'core:client-message' && message.message?.requestId === 'lost-restore') return true
        if (dropWorkspace && serviceName === 'twilight-core' && event === 'message' && message?.kind === 'core:client-message' && message.message?.requestId === 'lost-workspace') return true
        if (dropLyrics && serviceName === 'twilight-core' && event === 'message' && message?.kind === 'core:client-message' && message.message?.requestId === 'lost-lyrics') return true
        if (dropBookmark && serviceName === 'twilight-core' && event === 'message' && message?.kind === 'core:client-message' && message.message?.requestId === 'lost-bookmark') return true
        if (dropWrite && serviceName === 'twilight-core' && event === 'message' && message?.kind === 'core:client-message' && message.message?.requestId === 'lost-write') return true
        if (dropMetadata && serviceName === 'twilight-core' && event === 'message' && message?.kind === 'core:client-message' && message.message?.requestId === 'lost-metadata') return true
        return emit(event,...args)
      }
      return child
    },
    channel: () => new MessageChannelMain()
  })
  const identity = { id:'desktop:fixture', role:'desktop', permissions:['playback:read','playback:write','library:read','library:write','plugins:read','plugins:manage','providers:call','extensions:execute','downloads:read','downloads:write'] }
  supervisor.connect(identity)
  const request = (kind,name,payload={},requestId='request:'+ ++serial,signal) => supervisor.request(identity.id,{ kind,name,payload,requestId,epoch:supervisor.getStatus().epoch },signal)
  const call = (method,args=[],options={},signal) => request('command','providers.call',{providerId:'fixture',method,args,...options},undefined,signal)
  await supervisor.start()
  supervisor.disconnect(identity.id)
  await new Promise(resolve=>setTimeout(resolve,300))
  supervisor.connect(identity)
  assert.equal(BrowserWindow.getAllWindows().length,0)
  assert.deepEqual((await request('query','providers.list')).map(p=>p.id).sort(),['fixture','ncm'],JSON.stringify(await request('query','plugins.list')))
  let metadataTrack = await request('query','library.tracks',{ids:['one'],limit:1})
  assert.equal(metadataTrack.tracks[0].album,'Headless metadata')
  assert.equal(metadataTrack.tracks[0].genre,'Jazz')
  const catalog=await request('query','plugins.index.list')
  assert.equal(catalog[0].id,pluginId);assert.equal(catalog[0].installState,'update-available');assert.equal(catalog[0].installedVersion,'1.0.0')
  assert.deepEqual(await request('command','plugins.index.refresh'),catalog)
  assert.equal((await request('query','plugins.index.status')).loadedFrom,'bundled')
  const experiences=await request('query','extensions.experiences')
  const experienceUrl='plugin-ui://'+pluginId+'/1.0.0/ui/index.html'
  assert.equal(experiences[0].url,experienceUrl)
  await assert.rejects(request('query','extensions.resource',{url:experienceUrl}),error=>error.code==='FORBIDDEN')
  const system={id:'system:resources',role:'system',permissions:['plugins:resources']}
  supervisor.connect(system)
  const resource=await supervisor.request(system.id,{kind:'query',name:'extensions.resource',payload:{url:experienceUrl},requestId:'resource',epoch:supervisor.getStatus().epoch})
  assert.equal(resource.path,join(pkg,'ui','index.html'));supervisor.disconnect(system.id)
  await request('command','extensions.preferences.edit',{id:pluginId,value:{view:'albums'}})
  await request('command','extensions.document.edit',{id:pluginId,update:{revision:0,value:{config:{onlineEnabled:false}}}})
  const task=await request('command','extensions.music',{id:pluginId,operation:'task',args:{scope:'all'}})
  assert.ok(task.albums.some(album=>album.title==='Headless metadata'))
  const experienceDocument=await request('query','extensions.document',{id:pluginId})
  assert.equal(experienceDocument.revision,2);assert.ok(Object.keys(experienceDocument.value.proofs).length>0)
  assert.equal(BrowserWindow.getAllWindows().length,0)
  const metadataCandidates=await request('query','metadata.candidates',{id:'one',version:metadataTrack.versions.one})
  assert.equal(metadataCandidates.items[0].track.id,'fixture:one')
  assert.doesNotMatch(JSON.stringify(metadataCandidates),/filePath|streamUrl|private/)
  await request('command','metadata.clear',{id:'one',version:metadataTrack.versions.one})
  await assert.rejects(request('command','metadata.apply',{token:metadataCandidates.token,index:0}),error=>error.code==='STALE_REVISION')
  metadataTrack=await request('query','library.tracks',{ids:['one'],limit:1})
  const metadataCurrent=await request('query','metadata.candidates',{id:'one',version:metadataTrack.versions.one})
  dropMetadata=true
  await assert.rejects(request('command','metadata.apply',{token:metadataCurrent.token,index:0},'lost-metadata'),error=>error.code==='OUTCOME_UNKNOWN')
  dropMetadata=false
  supervisor.disconnect(identity.id);supervisor.connect(identity)
  metadataTrack=await request('query','library.tracks',{ids:['one'],limit:1})
  assert.equal(metadataTrack.tracks[0].album,'Headless metadata')
  assert.equal((await request('query','metadata.status')).active,0)
  const automaticLyrics = await request('query','lyrics.current')
  assert.equal(automaticLyrics.effective.original,'[00:00.00]Headless sidecar')
  assert.equal(automaticLyrics.effective.translation,'[00:00.00]Headless translation')
  assert.equal(automaticLyrics.offsetSeconds,0.175)
  assert.doesNotMatch(JSON.stringify(automaticLyrics),/filePath|streamUrl|ciphertext/)
  const initialStreams=await request('query','streams.state')
  assert.equal(initialStreams.defaultPlaybackRate,1.25)
  await request('command','radio.edit',{revision:initialStreams.radioRevision,edit:{kind:'add',name:'Headless radio',streamUrl:'https://example.invalid/live'}})
  await request('command','podcasts.defaultRate',{revision:initialStreams.preferencesRevision,rate:1.5})
  const startedRefresh=await request('command','podcasts.refresh',{revision:initialStreams.podcastRevision,id:'headless'})
  assert.deepEqual(startedRefresh.refreshing,['headless'])
  supervisor.disconnect(identity.id)
  await new Promise(resolve=>setTimeout(resolve,300))
  supervisor.connect(identity)
  const streamsState=await request('query','streams.state')
  assert.equal(feedRequests,1);assert.deepEqual(streamsState.refreshing,[])
  assert.equal(streamsState.podcastRevision,initialStreams.podcastRevision+1)
  const streamEpisodes=await request('query','podcasts.episodes',{id:'headless',revision:streamsState.podcastRevision})
  assert.equal(streamEpisodes.items[0].title,'Updated episode');assert.equal(streamEpisodes.items[0].progressSeconds,42)
  assert.doesNotMatch(JSON.stringify([streamEpisodes,await request('query','podcasts.subscriptions',{revision:streamsState.podcastRevision})]),/mediaUrl|feedUrl|private/)
  feedServer.close()
  const networkState=await request('query','network.state')
  assert.equal(networkState.profiles,1)
  const networkProfiles=await request('query','network.profiles',{revision:networkState.revision})
  assert.equal(networkProfiles.items[0].id,'legacy-nas')
  assert.doesNotMatch(JSON.stringify(networkProfiles),/encryptedId|legacy-network-password|ciphertext/)
  const networkJob=await request('command','network.job',{revision:networkState.revision,kind:'scan',profileId:'legacy-nas',path:'/music'})
  assert.equal(networkJob.jobs[0].state,'running')
  supervisor.disconnect(identity.id)
  await new Promise(resolve=>setTimeout(resolve,300))
  supervisor.connect(identity)
  const scannedNetwork=await request('query','network.state')
  assert.equal(scannedNetwork.jobs[0].state,'completed');assert.equal(networkRequests,1)
  const networkLibrary=await request('query','network.library',{revision:scannedNetwork.revision})
  assert.equal(networkLibrary.total,1);assert.equal(networkLibrary.items[0].name,'a.flac')
  assert.doesNotMatch(JSON.stringify(networkLibrary),/mimeType|coverPath|legacy-network-password/)
  const editedNetwork=await request('command','network.profiles.edit',{revision:scannedNetwork.revision,kind:'update',id:'legacy-nas',patch:{name:'Core NAS'}})
  assert.equal(editedNetwork.profile.name,'Core NAS')
  assert.equal(JSON.parse(readFileSync(join(profile,'network-sources','profiles.json'),'utf8')).profiles[0].credential.encryptedId,legacyNetworkCiphertext)
  const networkCache=join(profile,'music-cache','network-cache')
  mkdirSync(networkCache,{recursive:true});writeFileSync(join(networkCache,'stale.flac'),'stale');writeFileSync(join(networkCache,'stale.flac.part'),'partial')
  assert.ok((await request('query','network.cacheInfo')).sizeBytes>0)
  assert.deepEqual(await request('command','network.clearCache'),{sizeBytes:0})
  assert.deepEqual(await request('query','network.cacheInfo'),{sizeBytes:0})
  assert.equal(BrowserWindow.getAllWindows().length,0)
  networkServer.close()
  dropLyrics=true
  await assert.rejects(request('command','lyrics.edit',{revision:automaticLyrics.revision,edit:{kind:'track',trackId:'one',patch:{originalSelection:'manual',original:'[00:01]Core edit'}}},'lost-lyrics'), e=>e.code==='OUTCOME_UNKNOWN')
  dropLyrics=false
  supervisor.disconnect(identity.id);supervisor.connect(identity)
  const editedLyrics=await request('query','lyrics.current')
  assert.equal(editedLyrics.revision,automaticLyrics.revision+1)
  assert.equal(editedLyrics.effective.original,'[00:01]Core edit')
  assert.equal(JSON.parse(readFileSync(join(profile,'lyrics-management.json'),'utf8')).revision,editedLyrics.revision)
  const initialWorkspace=await request('query','workspace.state')
  assert.equal(initialWorkspace.history,1)
  dropWorkspace=true
  await assert.rejects(request('command','workspace.edit',{revision:initialWorkspace.revision,edit:{kind:'saveCurrent',name:'Headless capture'}},'lost-workspace'),e=>e.code==='OUTCOME_UNKNOWN')
  dropWorkspace=false
  supervisor.disconnect(identity.id);supervisor.connect(identity)
  const workspaceState=await request('query','workspace.state')
  const workspaceQuery={revision:workspaceState.revision,contentRevision:workspaceState.contentRevision}
  const sessionsPage=await request('query','workspace.sessions',workspaceQuery)
  const historyPage=await request('query','workspace.history',workspaceQuery)
  assert.equal(sessionsPage.total,3);assert.equal(sessionsPage.items[2].position,42)
  assert.equal(historyPage.total,1);assert.equal(historyPage.items[0].id,'legacy-history')
  assert.doesNotMatch(JSON.stringify([sessionsPage,historyPage]),/filePath|originalEntryIds|"libraryQueue":|streamUrl/)
  const workspaceDisk=JSON.parse(readFileSync(join(profile,'queue-workspace.json'),'utf8'))
  assert.equal(workspaceDisk.revision,initialWorkspace.revision+1)
  assert.equal(workspaceDisk.data.sessions[2].libraryQueue.entryId,(await request('query','state.snapshot')).queue.occurrenceId)
  const initialBookmarks = await request('query','bookmarks.state')
  assert.equal(initialBookmarks.current.trackId,'one')
  assert.equal((await request('query','state.snapshot')).playback.state,'paused')
  dropBookmark=true
  await assert.rejects(request('command','bookmarks.edit',{revision:initialBookmarks.revision,edit:{kind:'addCurrent',current:initialBookmarks.current,label:'Headless marker'}},'lost-bookmark'), e=>e.code==='OUTCOME_UNKNOWN')
  dropBookmark=false
  supervisor.disconnect(identity.id);supervisor.connect(identity)
  const bookmarkState=await request('query','bookmarks.state')
  const bookmarkPage=await request('query','bookmarks.page',{revision:bookmarkState.revision,scope:'all'})
  assert.equal(bookmarkPage.total,1);assert.equal(bookmarkPage.items[0].positionSeconds,42)
  assert.doesNotMatch(JSON.stringify(bookmarkPage),/filePath|trackKey/)
  const bookmarkDisk=JSON.parse(readFileSync(join(profile,'playback-bookmarks.json'),'utf8'))
  assert.equal(bookmarkDisk.revision,bookmarkState.revision);assert.equal(bookmarkDisk.data.bookmarks.length,1)
  const restoredQueues=[]
  for(const id of ['legacy-array','overlap-array']) {
    if(id==='overlap-array')dropRestore=true
    const restoration=request('command','workspace.restore',{revision:workspaceState.revision,id},id==='overlap-array'?'lost-restore':undefined)
    if(dropRestore)await assert.rejects(restoration,e=>e.code==='OUTCOME_UNKNOWN')
    else { const result=await restoration;assert.equal(result.restored,5);assert.equal(result.unavailable,1);assert.equal(result.deferred,2);assert.equal(result.issues[0].occurrenceId,'saved:missing') }
    dropRestore=false
    const committed=await request('query','state.snapshot')
    supervisor.disconnect(identity.id);supervisor.connect(identity)
    const state=await request('query','state.snapshot')
    assert.equal(state.queue.id,committed.queue.id)
    assert.equal(state.queue.occurrenceId,selectedOccurrence);assert.equal(state.queue.index,2);assert.equal(state.queue.total,5)
    assert.equal(state.playback.state,'paused');assert.equal(state.playback.position,42)
    const page=await request('query','queue.page',{id:state.queue.id,revision:state.queue.revision,offset:0})
    assert.deepEqual(page.items.map(row=>row.queueEntryId),['saved:cue:first','saved:cue:second',selectedOccurrence,'saved:provider','saved:network'])
    restoredQueues.push(state.queue.id)
  }
  assert.notEqual(restoredQueues[0],restoredQueues[1])
  await request('command','workspace.restore',{revision:workspaceState.revision,id:sessionsPage.items[2].id})
  const attached=await request('query','state.snapshot')
  assert.equal(attached.queue.id,workspaceDisk.data.sessions[2].libraryQueue.id)
  assert.equal(attached.queue.occurrenceId,workspaceDisk.data.sessions[2].libraryQueue.entryId)
  assert.equal(attached.playback.position,42)
  const gateway = await request('command','providers.call',{providerId:'ncm',method:'getProfile',args:[]})
  assert.equal(gateway.code,200); assert.match(gateway.data.version,/^4\./)
  const selectedCloud = await request('command', 'ncm.cloud.chooseUploadFiles')
  const acceptedCloud = await request('command', 'ncm.cloud.upload', { handle: selectedCloud[0].handle })
  supervisor.disconnect(identity.id)
  await new Promise(resolve => setTimeout(resolve, 400))
  supervisor.connect(identity)
  const cloudState = await request('query', 'ncm.cloud.state')
  const cloudTasks = await request('query', 'ncm.cloud.page', { revision: cloudState.revision })
  assert.equal(cloudTasks.items[0].transferId, acceptedCloud.transferId)
  assert.equal(cloudTasks.items[0].stage, 'completed', JSON.stringify(cloudTasks))
  const completedCloud = await request('command','providers.call',{providerId:'ncm',method:'fetchCloudSongsPage',args:[]})
  assert.equal(completedCloud.completed, 1)
  assert.doesNotMatch(JSON.stringify(cloudTasks), /uploadToken|uploadUrl|filePath|resourceId/)
  assert.equal(BrowserWindow.getAllWindows().length,0)
  let state = await call('getProfile')
  assert.equal(state.credentialPreserved,true); assert.equal(state.boots,1); assert.equal(state.volume,0.25)
  const raw = JSON.parse(readFileSync(join(data,'settings.json'),'utf8'))
  assert.deepEqual(raw.cookie,credential)
  assert.doesNotMatch(JSON.stringify(await request('query','state.snapshot')),/legacy-credential|ciphertext/)
  const source = await call('getPlaybackUrl',[{id:'fixture:1'},{}])
  assert.match(source,/^twilight-media:\/\/audio\//)
  assert.match(remoteMediaGrants.resolve(source,'audio').source,/https:\/\/example.invalid\/track/)
  assert.equal((await call('getLyrics',[{id:'fixture:1'}])).lyrics,'[00:00.00]Headless lyric')
  // Plugin import ACK is the real repository commit, with no renderer consumer.
  await request('command','extensions.execute',{command:'fixture.import',args:[[localPath,localPath,join(profile,'missing.flac')]]})
  const playlistPage = await request('query','playlists.list')
  const imported = playlistPage.items.find(p=>p.name==='Headless import')
  assert.equal(imported.count,1)
  const playlistDisk = readPlaylists()
  assert.equal(playlistDisk.revision,playlistPage.revision)
  assert.deepEqual(playlistDisk.data.find(p=>p.id===imported.id).trackIds,['one'])
  const importedEntries = await request('query','playlists.entries',{id:imported.id,revision:playlistPage.revision})
  assert.deepEqual(importedEntries.items.map(e=>e.track.id),['one'])
  const cueEntries = await request('query','playlists.entries',{id:'repeated',revision:playlistPage.revision})
  assert.deepEqual(cueEntries.items.map(e=>e.track.id),['cue:disc:2','cue:disc:2'])
  assert.equal(cueEntries.items[0].track.cueRange.startSeconds,30)
  assert.doesNotMatch(JSON.stringify(importedEntries),/filePath|streamUrl/)
  const versionRevision=(await request('query','state.snapshot')).versionsRevision
  const versionKeys=[JSON.stringify(['local',localPath.replace(/\\/g,'/').toLowerCase(),null,null]),JSON.stringify(['fixture','1'])]
  const versionEdit=await request('command','versions.edit',{revision:versionRevision,scope:'tracks',operation:'sources',keys:versionKeys,label:'Master'})
  const versions=await request('query','versions.page',{revision:versionEdit.revision,scope:'tracks',kind:'versions'})
  assert.equal(versions.items[0].label,'Master');assert.deepEqual(versions.items[0].sources,versionKeys)
  const cueView=await request('query','playlists.view',{id:'repeated',revision:playlistPage.revision,versionsRevision:versionEdit.revision})
  assert.equal(cueView.page.total,2);assert.deepEqual(cueView.page.entryIds,['0','1'])
  assert.deepEqual(cueView.page.tracks.map(t=>t.id),['cue:disc:2','cue:disc:2'])
  const external=await request('command','playlists.edit',{revision:playlistPage.revision,edit:{kind:'importCreate',document:{name:'Background matching',source:{kind:'file',label:'Fixture'},warnings:[],complete:true,songs:[{platform:'ncm',platformId:'77',title:'Remote'},{platform:'ncm',platformId:'77',title:'Remote'}]}}})
  supervisor.disconnect(identity.id)
  const matchingDeadline=Date.now()+5000
  let matched
  do {
    await new Promise(r=>setTimeout(r,10))
    matched=readPlaylists().data.find(p=>p.id===external.result)
  } while(matched.imported.entries.some(e=>e.resolution.state==='pending')&&Date.now()<matchingDeadline)
  assert.deepEqual(matched.imported.entries.map(e=>e.resolution.state),['streaming','streaming'])
  assert.notEqual(matched.imported.entries[0].entryId,matched.imported.entries[1].entryId)
  supervisor.connect(identity)
  assert.equal((await request('query','imports.status',{id:external.result})).done,2)
  const previewBefore = readPlaylists()
  const preview = await request('command','imports.previewStart',{link:'https://music.163.com/playlist?id=77',credentials:{accessToken:'one-shot-secret'}})
  supervisor.disconnect(identity.id)
  // No renderer and no client while the actual plugin performs both pages.
  await new Promise(r=>setTimeout(r,800))
  assert.deepEqual(readPlaylists(),previewBefore)
  supervisor.connect(identity)
  let previewStatus = await request('query','imports.preview',{id:preview.id})
  const previewDeadline=Date.now()+5000
  while(previewStatus.reading || (await request('query','imports.status',{id:preview.id}))?.running) {
    assert.ok(Date.now()<previewDeadline,'headless preview must complete')
    await new Promise(r=>setTimeout(r,20))
    previewStatus=await request('query','imports.preview',{id:preview.id})
  }
  assert.equal(previewStatus.complete,true);assert.equal(previewStatus.count,2)
  const previewPage=await request('query','imports.previewPage',{id:preview.id,revision:previewStatus.revision})
  assert.deepEqual(previewPage.items.map(e=>e.state),['streaming','streaming'])
  assert.notEqual(previewPage.items[0].id,previewPage.items[1].id)
  assert.doesNotMatch(JSON.stringify({previewStatus,previewPage}),/one-shot-secret|streamUrl|filePath/)
  const previewSaved=await request('command','imports.previewSave',{id:preview.id,revision:previewStatus.revision,playlistsRevision:previewBefore.revision})
  const previewOnDisk=readPlaylists().data.find(p=>p.id===previewSaved.id)
  assert.equal(previewOnDisk.transient,undefined)
  assert.deepEqual(previewOnDisk.imported.entries.map(e=>e.entryId),previewPage.items.map(e=>e.id))
  assert.equal((await request('query','imports.previews')).total,0)
  const currentPlaylistRevision=(await request('query','playlists.list')).revision
  const searchPage=await request('query','search.songs',{query:'One',limit:10})
  assert.ok(searchPage.items.some(item=>item.track.id==='one'))
  assert.ok(searchPage.items.some(item=>item.track.id==='fixture:one'))
  assert.doesNotMatch(JSON.stringify(searchPage),/filePath|streamUrl|networkSource|legacy-network-password/)
  const localSearch=await request('query','search.songs',{query:'One',scope:'local',limit:1})
  assert.equal(localSearch.items.length,1);assert.equal(localSearch.total,2)
  assert.equal(localSearch.playbackQuery.contentRevision,localSearch.libraryRevision)
  const networkSearch=await request('query','search.songs',{query:'a.flac',limit:10})
  assert.ok(networkSearch.items.some(item=>item.source==='network'))
  const albumSearch=await request('query','search.collections',{kind:'albums',query:'One',limit:10})
  assert.equal(albumSearch.items[0].providerId,'fixture');assert.equal(albumSearch.items[0].id,'fixture:album')
  const artistSearch=await request('query','search.collections',{kind:'artists',query:'Artist',limit:10})
  assert.ok(artistSearch.items.some(item=>item.providerId==='local'));assert.ok(artistSearch.items.some(item=>item.id==='fixture:artist'))
  const listSearch=await request('query','search.collections',{kind:'playlists',query:'Headless',scope:'local',limit:10})
  assert.ok(listSearch.items.some(item=>item.name==='Headless import'));assert.equal(listSearch.playlistsRevision,currentPlaylistRevision)
  const onlineList=await request('query','search.collections',{kind:'playlists',query:'Headless',providerId:'fixture',limit:10})
  assert.equal(onlineList.items[0].id,'fixture:list')
  assert.doesNotMatch(JSON.stringify([albumSearch,artistSearch,listSearch,onlineList]),/filePath|trackIds|streamUrl|token=|ciphertext/)
  for(const page of [albumSearch,artistSearch,listSearch,onlineList])
    for(const item of page.items) assert.equal(item.cover ?? item.picUrl ?? null,null)
  // Persisted provider paths cannot bypass a real provider/expiry round-trip.
  // Native authorization is denied: no LoadQueue/Play or audible device is used.
  const beforeRefresh=await request('query','state.snapshot')
  await assert.rejects(request('command','queue.fromQuery',{query:{search:'Expired authority',sort:'playlist'},play:false}),/Playback is not authorized/)
  assert.deepEqual((await call('getProfile')).sourceRefresh,[false,true])
  const afterRefresh=await request('query','state.snapshot')
  assert.equal(afterRefresh.queue.id,beforeRefresh.queue.id)
  assert.equal(afterRefresh.queue.occurrenceId,beforeRefresh.queue.occurrenceId)
  assert.equal(afterRefresh.playback.position,beforeRefresh.playback.position)
  const searchController=new AbortController()
  const pendingSearch=request('query','search.songs',{query:'slow-search'},undefined,searchController.signal)
  const cancelledSearch=assert.rejects(pendingSearch,error=>error.code==='CANCELLED')
  const searchDeadline=Date.now()+2000
  while(!(await call('getProfile')).searchActive) {
    assert.ok(Date.now()<searchDeadline,'search must reach the provider')
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  const pauseStart=Date.now();await request('command','playback.pause');assert.ok(Date.now()-pauseStart<1000)
  searchController.abort();await cancelledSearch
  const cancellationDeadline=Date.now()+2000
  while(!(await call('getProfile')).searchCancelled) {
    assert.ok(Date.now()<cancellationDeadline,'cancel must reach the provider')
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  // A slow provider never owns the native-control queue.
  const controller = new AbortController()
  const slow = call('getPlaybackUrl',[{id:'fixture:slow'},{}],{},controller.signal)
  const slowResult = assert.rejects(slow,error=>error.code==='OUTCOME_UNKNOWN')
  await new Promise(r=>setTimeout(r,100))
  const start = Date.now(); await request('command','playback.pause'); assert.ok(Date.now()-start<1000)
  controller.abort(); await slowResult
  state = await call('getProfile'); assert.equal(state.cancelled,true)
  // Drop an already committed write's response. Reconnection never repeats it.
  dropWrite = true
  const lost = request('command','providers.call',{providerId:'fixture',method:'likeTrack',args:['fixture:1',true],idempotencyKey:'fixture-write'},'lost-write')
  await assert.rejects(lost,error=>error.code==='OUTCOME_UNKNOWN')
  dropWrite = false
  supervisor.disconnect(identity.id); supervisor.connect(identity)
  assert.equal((await call('getProfile')).writes,1)
  await call('likeTrack',['fixture:1',true],{idempotencyKey:'fixture-write'})
  assert.equal((await call('getProfile')).writes,1)
  await assert.rejects(()=>request('command','providers.call',{providerId:'fixture',method:'createDownload',args:[]}),error=>error.code==='INVALID_REQUEST')
  // Core failure kills the old host before reopening the same settings file.
  const recovered = new Promise(resolve=>supervisor.on('status',status=>{if(status.phase==='ready')resolve()}))
  children.find(p=>p.serviceName==='twilight-core').child.kill(); await recovered
  assert.deepEqual(await request('query','extensions.preferences',{id:pluginId}),{view:'albums'})
  assert.deepEqual(await request('query','extensions.document',{id:pluginId}),experienceDocument)
  assert.deepEqual(await request('query','bookmarks.page',{revision:bookmarkState.revision,scope:'all'}),bookmarkPage)
  const recoveredLyrics=await request('query','lyrics.current')
  assert.equal(recoveredLyrics.revision,editedLyrics.revision)
  assert.equal(recoveredLyrics.effective.original,editedLyrics.effective.original)
  const recoveredWorkspace=await request('query','workspace.state')
  const recoveredNetwork=await request('query','network.state')
  assert.equal((await request('query','network.profiles',{revision:recoveredNetwork.revision})).items[0].name,'Core NAS')
  const recoveredNetworkLibrary=await request('query','network.library',{revision:recoveredNetwork.revision})
  assert.deepEqual(recoveredNetworkLibrary.items.map(item=>item.id),networkLibrary.items.map(item=>item.id))
  const recoveredStreams=await request('query','streams.state')
  assert.equal(recoveredStreams.radioRevision,streamsState.radioRevision)
  assert.equal(recoveredStreams.podcastRevision,streamsState.podcastRevision)
  assert.equal(recoveredStreams.defaultPlaybackRate,1.5)
  assert.deepEqual(await request('query','podcasts.episodes',{id:'headless',revision:recoveredStreams.podcastRevision}),streamEpisodes)
  assert.equal(recoveredWorkspace.revision,workspaceState.revision)
  assert.equal(recoveredWorkspace.history,1)
  const recoveredSessions=await request('query','workspace.sessions',{revision:recoveredWorkspace.revision,contentRevision:recoveredWorkspace.contentRevision})
  assert.deepEqual(recoveredSessions.items,sessionsPage.items)
  state = await call('getProfile'); assert.equal(state.boots,2); assert.equal(state.writes,1); assert.equal(state.credentialPreserved,true)
  const recoveredEntries=await request('query','playlists.entries',{id:imported.id,revision:currentPlaylistRevision})
  assert.deepEqual(recoveredEntries.items,importedEntries.items)
  assert.deepEqual(await request('query','versions.page',{revision:versionEdit.revision,scope:'tracks',kind:'versions'}),versions)
  const recoveredCue=await request('query','playlists.view',{id:'repeated',revision:currentPlaylistRevision,versionsRevision:versionEdit.revision})
  assert.deepEqual(recoveredCue.page,cueView.page)
  const recoveredExternal=await request('query','playlists.entries',{id:external.result,revision:currentPlaylistRevision})
  assert.deepEqual(recoveredExternal.items.map(e=>e.id),matched.imported.entries.map(e=>e.entryId))
  assert.deepEqual(recoveredExternal.items.map(e=>e.track.id),['ncm:77','ncm:77'])
  await request('command','extensions.execute',{command:'fixture.import',args:[[localPath]]})
  const afterImport = await request('query','playlists.list')
  assert.equal(afterImport.items.find(p=>p.name==='Headless import').id,imported.id)
  assert.equal(afterImport.items.find(p=>p.name==='Headless import').count,1)
  await request('command','personalized.start',{providerId:'fixture',key:'radar',play:false})
  const personalBefore=await request('query','state.snapshot')
  assert.equal(personalBefore.personalized.key,'radar');assert.equal(personalBefore.queue.total,2)
  const filling=request('command','personalized.refill',{id:personalBefore.queue.id,revision:personalBefore.queue.revision})
  const unknownFill=assert.rejects(filling,error=>error.code==='OUTCOME_UNKNOWN')
  await new Promise(resolve=>setTimeout(resolve,25));supervisor.disconnect(identity.id);await unknownFill
  await new Promise(resolve=>setTimeout(resolve,250));supervisor.connect(identity)
  const personalAfter=await request('query','state.snapshot')
  assert.equal(personalAfter.queue.id,personalBefore.queue.id);assert.equal(personalAfter.queue.occurrenceId,personalBefore.queue.occurrenceId)
  assert.equal(personalAfter.queue.total,3);assert.equal(personalAfter.playback.state,'paused')
  assert.equal(BrowserWindow.getAllWindows().length,0)
  await request('command','liked.play',{selectedId:'ncm:2',play:false})
  const likedBefore=await request('query','state.snapshot')
  assert.equal(likedBefore.heart.available,true);assert.equal(likedBefore.queue.total,3)
  await request('command','playback.mode',{mode:'heart'})
  const heartReady=await request('query','state.snapshot')
  const fillingHeart=request('command','heart.refill',{id:heartReady.queue.id,revision:heartReady.queue.revision})
  const detachedHeart=assert.rejects(fillingHeart,error=>error.code==='OUTCOME_UNKNOWN')
  await new Promise(resolve=>setTimeout(resolve,25));supervisor.disconnect(identity.id);await detachedHeart
  await new Promise(resolve=>setTimeout(resolve,250));supervisor.connect(identity)
  const heartAfter=await request('query','state.snapshot')
  assert.equal(heartAfter.heart.active,true);assert.equal(heartAfter.queue.occurrenceId,likedBefore.queue.occurrenceId)
  assert.equal(heartAfter.playback.playMode,'heart');assert.equal(heartAfter.playback.state,'paused')
  await request('command','heart.refill',{id:heartAfter.queue.id,revision:heartAfter.queue.revision})
  await request('command','playback.mode',{mode:'sequential'})
  const likedAfter=await request('query','state.snapshot')
  assert.equal(likedAfter.queue.total,3);assert.equal(likedAfter.track.id,'ncm:2')
  assert.equal(likedAfter.queue.occurrenceId,likedBefore.queue.occurrenceId)
  assert.equal(likedAfter.heart.active,false);assert.equal(likedAfter.playback.state,'paused')
  // Resolve a genuinely failed provider ID, then commit its new SQL occurrence
  // identity and playlist reference over the real ports. LoadQueue only stores
  // metadata in native; play:false never opens a decoder or issues Play.
  await request('command','extensions.execute',{command:'fixture.expire',args:[]})
  allowSourceRepair=true
  await request('command','queue.fromQuery',{query:{ids:['fixture:expired'],sort:'playlist'},play:false})
  const repaired=await request('query','state.snapshot')
  assert.equal(repaired.track.id,'fixture:replacement');assert.notEqual(repaired.playback.state,'playing')
  const repairPage=await request('query','queue.page',{id:repaired.queue.id,revision:repaired.queue.revision,offset:0})
  assert.equal(repairPage.items[0].track.id,'fixture:replacement');assert.equal(repairPage.items[0].queueEntryId,repaired.queue.occurrenceId)
  const repairedPlaylist=readPlaylists().data.find(p=>p.id==='source-repair')
  assert.deepEqual(repairedPlaylist.trackIds,['fixture:replacement'])
  supervisor.disconnect(identity.id);supervisor.connect(identity)
  const repairAttached=await request('query','state.snapshot')
  assert.deepEqual(repairAttached.queue,repaired.queue);assert.equal(repairAttached.playback.position,repaired.playback.position)
  assert.equal(BrowserWindow.getAllWindows().length,0)
  assert.notEqual((await request('query','state.snapshot')).playback.state,'playing')
  await supervisor.shutdown()
  assert.equal(alive.size,0)
  writeFileSync(join(__dirname,'result.json'),JSON.stringify({windows:BrowserWindow.getAllWindows().length,pluginPorts,businessViaMain,credentialPreserved:true,ncmGateway:true,cloudTransferHeadless:true,pauseResponsive:true,cancelled:true,unknownWriteNotReplayed:true,playlistImportDurable:true,playlistRecovery:true,recordingVersionsDurable:true,playlistViews:true,importMatchingHeadless:true,importPreviewHeadless:true,bookmarksDurable:true,lyricsHeadless:true,workspaceDurable:true,namedRestoreHeadless:true,streamsHeadless:true,networkHeadless:true,networkCacheHeadless:true,personalizedHeadless:true,heartHeadless:true,searchHeadless:true,collectionsHeadless:true,sourceRefreshHeadless:true,sourceRepairHeadless:true,metadataHeadless:true,pluginMarketplaceHeadless:true,experienceHeadless:true,hostsAfterShutdown:alive.size}))
}
const plugin = ${JSON.stringify(pluginSource)}
app.whenReady().then(main).then(()=>app.exit(0),async error=>{
  console.error(error); await supervisor?.shutdown().catch(()=>{}); for(const child of alive)child.kill(); app.exit(1)
})
`
