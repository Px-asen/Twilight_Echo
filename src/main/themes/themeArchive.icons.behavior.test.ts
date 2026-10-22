import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { THEME_ICON_SLOTS } from '../../shared/theme.ts'

const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')

test('icon image assets survive real import, revisioned storage, copying and repeated theme archives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-theme-icon-archive-'))
  try {
    const PNG = require('pngjs').PNG
    const image = new PNG({ width: 24, height: 24 })
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++)
        image.data.set([240, 32, 96, x < 8 ? 0 : x < 16 ? 128 : 255], (y * image.width + x) * 4)
    await writeFile(join(directory, 'source.png'), PNG.sync.write(image))
    await build({
      stdin: {
        contents: `import { app, session } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { importThemeAsset, validateThemeProfileAssets, resolveThemeAssetFile, copyThemeAssets, exportThemeArchive, importThemeArchive } from ${JSON.stringify(resolve('src/main/themes/themeArchive.ts'))};
import { ThemeLibraryRepository } from ${JSON.stringify(resolve('src/main/themes/themeLibraryRepository.ts'))};
import { createDefaultThemeLibraryDocument, normalizeThemeProfile, resolveThemeIconUrl, THEME_ICON_SLOTS } from ${JSON.stringify(resolve('src/shared/theme.ts'))};
${probe}`,
        resolveDir: process.cwd(),
        sourcefile: 'theme-icon-archive-probe.ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: join(directory, 'runner.cjs')
    })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const result = await promisify(execFile)(
      require('electron'),
      [join(directory, 'runner.cjs'), directory],
      {
        env,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      }
    )
    const report = JSON.parse(result.stdout.match(/ICON_ARCHIVE_RESULT (.*)/)![1])
    assert.equal(report.networkRequests, 0)
    assert.equal(report.originalBytesPreserved, true)
    assert.equal(report.bindingCount, THEME_ICON_SLOTS.length)
    assert.equal(report.archives, 2)
    assert.equal(report.storageReopened, true)
    assert.equal(report.copiedAssetsPortable, true)
    assert.equal(report.missingIconRejected, true)
    const evidence = process.env.TWILIGHT_ICON_REPORT_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(
        join(evidence, 'icons-core-archive-result.json'),
        JSON.stringify(report, null, 2) + '\n'
      )
    }
    console.log(`ICON_ARCHIVE_RESULT ${JSON.stringify(report)}`)
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-theme-icon-archive-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const probe = String.raw`
const directory = process.argv[2];
app.setPath('userData', join(directory, 'user-data'));
app.whenReady().then(async () => {
  let networkRequests = 0;
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (_details, callback) => {networkRequests++;callback({cancel:true})});
  const id='user:portable-icons';
  const asset=await importThemeAsset(id, join(directory,'source.png'),'image');
  const source=await readFile(join(directory,'source.png'));
  assert.deepEqual(await readFile(resolveThemeAssetFile(id,asset.path)),source);
  assert.equal(await validateThemeProfileAssets(id,[asset]),true);
  const bindings=Object.fromEntries(THEME_ICON_SLOTS.map(slot=>[slot,asset.id]));
  const profile=normalizeThemeProfile({schemaVersion:2,id,name:'Portable icons',overrides:{},assets:[asset],iconBindings:bindings});
  assert(profile);
  const file=join(directory,'themes.json');
  let repository=new ThemeLibraryRepository(file,createDefaultThemeLibraryDocument);
  let snapshot=await repository.saveProfile(profile,0);
  snapshot=await repository.setActive({kind:'user',id},snapshot.revision);
  repository=new ThemeLibraryRepository(file,createDefaultThemeLibraryDocument);
  assert.deepEqual((await repository.load()).data.profiles[0].iconBindings,bindings);
  const edited={...profile,iconBindings:{...bindings}};
  delete edited.iconBindings['playback.pause'];
  snapshot=await repository.saveProfile(edited,snapshot.revision);
  assert.deepEqual(snapshot.data.profileHistory[id][0].profile.iconBindings,bindings);
  assert.equal((await new ThemeLibraryRepository(file,createDefaultThemeLibraryDocument).load()).data.profiles[0].iconBindings['playback.pause'],undefined);
  const first=join(directory,'icons.tetheme');
  await exportThemeArchive(profile,first);
  assert((await stat(first)).size>source.length);
  const imported=await importThemeArchive(first);
  assert.notEqual(imported.id,id);
  assert.deepEqual(imported.iconBindings,bindings);
  assert.deepEqual(imported.assets,[asset]);
  assert.deepEqual(await readFile(resolveThemeAssetFile(imported.id,asset.path)),source);
  assert.equal(resolveThemeIconUrl(imported,'playback.play'),'theme-asset://asset/'+encodeURIComponent(imported.id)+'/'+asset.path);
  const second=join(directory,'icons-second.tetheme');
  await exportThemeArchive(imported,second);
  const importedAgain=await importThemeArchive(second);
  assert.deepEqual(importedAgain.iconBindings,bindings);
  assert.deepEqual(await readFile(resolveThemeAssetFile(importedAgain.id,asset.path)),source);
  const copyId='user:copied-icons';
  await copyThemeAssets(importedAgain.id,copyId);
  assert.equal(await validateThemeProfileAssets(copyId,[asset]),true);
  const copied=normalizeThemeProfile({...importedAgain,id:copyId});
  await exportThemeArchive(copied,join(directory,'copied.tetheme'));
  assert.deepEqual(await readFile(resolveThemeAssetFile(copyId,asset.path)),source);
  await assert.rejects(()=>exportThemeArchive({...profile,id:'user:missing-icons'},join(directory,'missing.tetheme')),/主题资源不存在|图标的本地资源不可用/);
  const persisted=JSON.parse(await readFile(file,'utf8'));
  assert.equal(persisted.data.profiles[0].iconBindings['playback.play'],asset.id);
  console.log('ICON_ARCHIVE_RESULT '+JSON.stringify({networkRequests,originalBytesPreserved:true,bindingCount:THEME_ICON_SLOTS.length,archives:2,storageReopened:true,historyCapturesBindingEdit:true,copiedAssetsPortable:true,missingIconRejected:true,assetType:asset.type,assetPath:asset.path,alpha:[0,128,255]}));
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`
