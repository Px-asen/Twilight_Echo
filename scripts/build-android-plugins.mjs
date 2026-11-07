import { build } from 'esbuild'
import { readFile, writeFile, mkdir, copyFile, readdir, utimes } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { createZip } = require('../packages/create-twilight-plugin/lib/zip.cjs')
const output = resolve(root, 'dist/android-plugins')
const staging = resolve(output, 'ncm')
await mkdir(staging, { recursive: true })
const upstream = resolve(root, 'node_modules/@neteasecloudmusicapienhanced/api')
const upstreamPackage = JSON.parse(await readFile(resolve(upstream, 'package.json'), 'utf8'))
if (upstreamPackage.version !== '4.36.1') throw new Error('Review the NCM mobile gateway before changing upstream API version')
const source = await readFile(resolve(root, 'resources/plugins/ncm-provider/index.mjs'), 'utf8')
const routes = [...new Set([...source.matchAll(/(?:`|')\/(\w[\w/]*)(?=[?`'])/g)].map(m => m[1]))]
// NCBL uses Node crypto/zlib and belongs to the desktop/server playback owner.
const unsupported = new Set(['song/url/match', 'login/qr/create', 'cloud/upload/token', 'scrobble/v1'])
const included = []
for (const route of routes.filter(r => !unsupported.has(r))) {
  try { await readFile(resolve(upstream, 'module', route.replaceAll('/', '_') + '.js')); included.push(route) } catch { /* prefixes aren't endpoints */ }
}
const shims = {
  option: `module.exports=(q,c='')=>({crypto:q.crypto||c||'',cookie:q.cookie||'',ua:q.ua||'',e_r:false})`,
  logger: `module.exports={info(){},warn(){},error(){},debug(){}}`,
  crypto: `module.exports={MD5:v=>({toString:()=>__hostCall('md5',{value:String(v)})})}`,
  config: await readFile(resolve(upstream, 'util/config.json'), 'utf8')
}
await build({
  absWorkingDir: root, entryPoints: [resolve(root, 'sdk/plugins/repository-entry.ts')], bundle: true, format: 'iife', target: 'es2015',
  outfile: resolve(output, 'repository.js')
})
await build({
  absWorkingDir: root, entryPoints: [resolve(root, 'sdk/plugins/ncm-entry.js')], bundle: true, format: 'iife', target: 'es2015',
  outfile: resolve(staging, 'android.js'),
  banner: { js: await readFile(resolve(root, 'sdk/plugins/sync-promise.js'), 'utf8') },
  plugins: [{ name: 'mobile-ncm', setup(b) {
    b.onResolve({ filter: /^twilight:ncm-endpoints$/ }, () => ({ path: 'endpoints', namespace: 'mobile' }))
    b.onLoad({ filter: /.*/, namespace: 'mobile' }, () => ({
      contents: included.map((r, i) => `import r${i} from ${JSON.stringify(resolve(upstream, 'module', r.replaceAll('/', '_') + '.js'))}`).join('\n') +
        '\nexport const endpoints={' + included.map((r, i) => `${JSON.stringify('/' + r)}:r${i}`).join(',') + '}', resolveDir: root
    }))
    b.onResolve({ filter: /(?:util\/option(?:\.js)?|util\/logger(?:\.js)?|util\/config\.json|^crypto-js)$/ }, a => ({
      path: a.path === 'crypto-js' ? 'crypto' : a.path.includes('option') ? 'option' : a.path.includes('logger') ? 'logger' : 'config', namespace: 'shim'
    }))
    b.onLoad({ filter: /.*/, namespace: 'shim' }, a => ({ contents: a.path === 'config' ? 'module.exports=' + shims.config : shims[a.path] }))
    b.onLoad({ filter: /module[\\/]song_url_v1\.js$/ }, () => ({ contents:
      `module.exports=(q,request)=>request('/api/song/enhance/player/url/v1',{ids:'['+q.id+']',level:q.level,encodeType:'flac'},{crypto:'xeapi',cookie:q.cookie||'',ua:q.ua||''})` }))
  }}]
})
const manifest = JSON.parse(await readFile(resolve(root, 'resources/plugins/ncm-provider/plugin.json'), 'utf8'))
await writeFile(resolve(staging, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
await copyFile(resolve(root, 'resources/plugins/ncm-provider/index.mjs'), resolve(staging, 'index.mjs'))
await copyFile(resolve(root, 'LICENSE'), resolve(staging, 'LICENSE'))
await copyFile(resolve(upstream, 'LICENSE'), resolve(staging, 'NETEASE_API_LICENSE'))
await copyFile(resolve(root, 'node_modules/qrcode/license'), resolve(staging, 'QRCODE_LICENSE'))
await copyFile(resolve(root, 'node_modules/dijkstrajs/LICENSE.md'), resolve(staging, 'DIJKSTRAJS_LICENSE'))
await writeFile(resolve(staging, 'THIRD_PARTY_NOTICES.md'), `Android gateway bundles endpoint modules from @neteasecloudmusicapienhanced/api ${upstreamPackage.version} (MIT, Binaryify and contributors). See NETEASE_API_LICENSE.\nQR matrix generation: qrcode (MIT, Ryan Day), QRCODE_LICENSE; dijkstrajs (MIT), DIJKSTRAJS_LICENSE.\nTwilight Echo provider logic: resources/plugins/ncm-provider/index.mjs (Apache-2.0).\n`)
// Stable ZIP metadata: an unchanged plugin version must not change checksum on every build.
for (const file of await readdir(staging)) await utimes(resolve(staging, file), new Date(2000, 0, 1), new Date(2000, 0, 1))
const packagePath = resolve(output, 'ncm.tep')
await createZip(staging, packagePath)
const checksumSha256 = createHash('sha256').update(await readFile(packagePath)).digest('hex')
await writeFile(resolve(output, 'catalog.json'), JSON.stringify({ schemaVersion: 1, plugins: [{ ...manifest, sourceUrl: 'asset:ncm.tep', checksumSha256 }] }, null, 2) + '\n')
console.log(`Built Android plugin repository + NCM (${included.length} reused upstream endpoints).`)
