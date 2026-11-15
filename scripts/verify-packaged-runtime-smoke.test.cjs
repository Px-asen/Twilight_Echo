const assert = require('node:assert/strict')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const asar = require('@electron/asar')

async function createFlushedAsarArchive(sourceDir, outputAsarPath) {
  const realSource = fs.realpathSync(sourceDir)
  const entries = []
  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name)
      entries.push(fullPath)
      if (entry.isDirectory()) walk(fullPath)
    }
  }
  walk(realSource)
  fs.mkdirSync(path.dirname(outputAsarPath), { recursive: true })
  const writeStream = await asar.createPackageFromFiles(realSource, outputAsarPath, entries)
  if (writeStream && typeof writeStream.once === 'function' && !writeStream.closed) {
    await once(writeStream, 'close')
  }
  asar.uncache(outputAsarPath)
}

const {
  createPcmWaveBuffer,
  resolvePackagedRuntimeTarget,
  verifyPackagedRuntimeSmoke
} = require('./verify-packaged-runtime-smoke.cjs')

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

async function buildSyntheticPackagedAsar(outputAsarPath, { omitNestedMediaTyper = false } = {}) {
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-synthetic-asar-'))
  try {
    writeJson(path.join(stageDir, 'package.json'), {
      name: 'TwilightEcho',
      version: '2.0.2'
    })

    // Root media-typer@2.0.0 (ESM-style exports) used by music-metadata
    writeJson(path.join(stageDir, 'node_modules', 'media-typer', 'package.json'), {
      name: 'media-typer',
      version: '2.0.0',
      main: 'index.js'
    })
    writeText(
      path.join(stageDir, 'node_modules', 'media-typer', 'index.js'),
      `exports.parse = (v) => ({ type: String(v).split('/')[0] }); exports.format = (o) => o.type + '/wav';\n`
    )

    writeJson(path.join(stageDir, 'node_modules', 'strtok3', 'package.json'), {
      name: 'strtok3',
      version: '10.3.5',
      main: 'index.js'
    })
    writeText(
      path.join(stageDir, 'node_modules', 'strtok3', 'index.js'),
      `exports.fromFile = async (p) => ({ path: p });\n`
    )

    writeJson(path.join(stageDir, 'node_modules', 'music-metadata', 'package.json'), {
      name: 'music-metadata',
      version: '11.16.0',
      main: 'index.js',
      dependencies: { 'media-typer': '^2.0.0' }
    })
    writeText(
      path.join(stageDir, 'node_modules', 'music-metadata', 'index.js'),
      `const typer = require('media-typer');
exports.parseFromTokenizer = async () => {
  typer.parse('audio/wav');
  return { format: { duration: 1.2 } };
};\n`
    )

    writeJson(path.join(stageDir, 'node_modules', 'node-taglib-sharp', 'package.json'), {
      name: 'node-taglib-sharp',
      version: '6.0.3',
      main: 'index.js'
    })
    writeText(
      path.join(stageDir, 'node_modules', 'node-taglib-sharp', 'index.js'),
      `const fs = require('node:fs');
exports.ByteVector = { fromByteArray: (b) => b };
exports.Picture = function Picture() {};
exports.PictureType = { FrontCover: 3 };
exports.File = {
  createFromPath(filePath) {
    const buf = fs.readFileSync(filePath);
    const sampleRate = buf.readUInt32LE(24);
    const byteRate = buf.readUInt32LE(28);
    const dataSize = buf.readUInt32LE(40);
    return {
      properties: { durationMilliseconds: sampleRate > 0 ? Math.round((dataSize / byteRate) * 1000) : 0 },
      dispose() {}
    };
  }
};\n`
    )

    // type-is requires legacy media-typer@0.3.0 (default function export)
    writeJson(path.join(stageDir, 'node_modules', 'type-is', 'package.json'), {
      name: 'type-is',
      version: '1.6.18',
      main: 'index.js',
      dependencies: { 'media-typer': '0.3.0' }
    })
    writeText(
      path.join(stageDir, 'node_modules', 'type-is', 'index.js'),
      `const path = require('node:path');
const { createRequire } = require('node:module');
// Require specifically nested media-typer@0.3.0 (function export) as in Express 4 / body-parser 1
const localRequire = createRequire(__filename);
const typer = localRequire('media-typer');
if (typeof typer.test !== 'function') {
  throw new Error("Cannot find compatible media-typer@0.3.0 (got non-0.3 exports)");
}
module.exports = (contentType) => typer.test(contentType || 'application/json');\n`
    )

    if (!omitNestedMediaTyper) {
      writeJson(
        path.join(
          stageDir,
          'node_modules',
          'type-is',
          'node_modules',
          'media-typer',
          'package.json'
        ),
        {
          name: 'media-typer',
          version: '0.3.0',
          main: 'index.js'
        }
      )
      writeText(
        path.join(stageDir, 'node_modules', 'type-is', 'node_modules', 'media-typer', 'index.js'),
        `exports.test = (ct) => String(ct).includes('/');\n`
      )
    }

    writeJson(
      path.join(
        stageDir,
        'node_modules',
        '@neteasecloudmusicapienhanced',
        'unblockmusic-utils',
        'package.json'
      ),
      {
        name: '@neteasecloudmusicapienhanced/unblockmusic-utils',
        version: '1.0.0',
        main: 'index.js'
      }
    )
    writeText(
      path.join(
        stageDir,
        'node_modules',
        '@neteasecloudmusicapienhanced',
        'unblockmusic-utils',
        'index.js'
      ),
      `module.exports = { ok: true };\n`
    )

    const ncmRoot = path.join(stageDir, 'node_modules', '@neteasecloudmusicapienhanced', 'api')
    writeJson(path.join(ncmRoot, 'package.json'), {
      name: '@neteasecloudmusicapienhanced/api',
      version: '4.36.1',
      main: 'server.js'
    })
    writeJson(path.join(stageDir, 'node_modules', 'axios', 'package.json'), {
      name: 'axios',
      version: '1.20.0',
      main: 'index.js'
    })
    writeText(
      path.join(stageDir, 'node_modules', 'axios', 'index.js'),
      `exports.default = async () => { throw new Error('unmocked network call'); };\n`
    )
    writeText(
      path.join(ncmRoot, 'util', 'crypto.js'),
      `exports.eapiReqDecrypt = (raw) => JSON.parse(raw);\n`
    )
    writeText(path.join(ncmRoot, 'util', 'logger.js'), `exports.info = () => {};\n`)
    writeText(
      path.join(ncmRoot, 'util', 'apicache.js'),
      `exports.getIndex = () => ({ all: [] }); exports.clear = () => {};\n`
    )
    writeText(
      path.join(ncmRoot, 'server.js'),
      `const http = require('node:http');
const typeIs = require('type-is');
const axios = require('axios');
require('@neteasecloudmusicapienhanced/unblockmusic-utils');
exports.serveNcmApi = async ({ host = '127.0.0.1', port = 0 }) => {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'POST') {
      typeIs(req.headers['content-type'] || 'application/json');
      JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    }
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const apiUrl = pathname === '/login/qr/key' ? '/api/login/qrcode/unikey' : '/api/w/nuser/account/get';
    const upstream = await axios.default({
      url: 'https://interface.music.163.com/eapi/batch',
      data: 'params=' + encodeURIComponent(JSON.stringify({ url: apiUrl }))
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 200, data: upstream.data }));
  });
  await new Promise((resolve) => server.listen(Number(port), host, resolve));
  return { server };
};\n`
    )

    writeText(
      path.join(stageDir, 'out', 'main', 'libraryScanService.js'),
      `const fs = require('node:fs');
const path = require('node:path');
const mm = require('music-metadata');
const strtok3 = require('strtok3');
process.send({ kind: 'ready' });
process.on('message', async (msg) => {
  if (!msg || msg.kind !== 'scan') return;
  try {
    const files = fs.readdirSync(msg.request.roots[0]).filter((f) => f.endsWith('.wav'));
    const parsedTracks = [];
    for (const file of files) {
      const fullPath = path.join(msg.request.roots[0], file);
      const tok = await strtok3.fromFile(fullPath);
      const meta = await mm.parseFromTokenizer(tok);
      parsedTracks.push({ path: fullPath, duration: Math.round(meta.format.duration) });
    }
    process.send({ kind: 'response', requestId: msg.requestId, ok: true, value: { parsedTracks } });
  } catch (err) {
    process.send({ kind: 'response', requestId: msg.requestId, ok: false, error: err.message });
  }
});\n`
    )

    await createFlushedAsarArchive(stageDir, outputAsarPath)
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true })
  }
}

test('resolvePackagedRuntimeTarget locates asar and binaries across Windows, Linux, and macOS layouts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-smoke-targets-'))
  try {
    const winDir = path.join(tempDir, 'win-unpacked')
    writeText(path.join(winDir, 'TwilightEcho.exe'), 'pe')
    writeText(path.join(winDir, 'resources', 'app.asar'), 'asar')
    assert.deepEqual(resolvePackagedRuntimeTarget(winDir), {
      asarPath: path.join(winDir, 'resources', 'app.asar'),
      executablePath: path.join(winDir, 'TwilightEcho.exe')
    })

    const linuxDir = path.join(tempDir, 'linux-unpacked')
    writeText(path.join(linuxDir, 'music'), 'elf')
    writeText(path.join(linuxDir, 'resources', 'app.asar'), 'asar')
    assert.deepEqual(resolvePackagedRuntimeTarget(linuxDir), {
      asarPath: path.join(linuxDir, 'resources', 'app.asar'),
      executablePath: path.join(linuxDir, 'music')
    })

    const macDir = path.join(tempDir, 'mac-arm64')
    const appBundle = path.join(macDir, 'TwilightEcho.app')
    writeText(path.join(appBundle, 'Contents', 'MacOS', 'TwilightEcho'), 'macho')
    writeText(path.join(appBundle, 'Contents', 'Resources', 'app.asar'), 'asar')
    assert.deepEqual(resolvePackagedRuntimeTarget(macDir), {
      asarPath: path.join(appBundle, 'Contents', 'Resources', 'app.asar'),
      executablePath: path.join(appBundle, 'Contents', 'MacOS', 'TwilightEcho')
    })
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('createPcmWaveBuffer builds a valid PCM WAV header with >1s duration', () => {
  const wav = createPcmWaveBuffer()
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE')
  assert.equal(wav.readUInt16LE(20), 1)
  assert.ok(wav.length > 16_000)
})

test('packaged runtime smoke passes when nested dependencies exist and fails closed on Issue #235 regression even with parent node_modules present', async () => {
  const fakeCheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-smoke-checkout-'))
  try {
    // Plant a decoy media-typer@0.3.0 in parent node_modules to prove smoke runs hermetically in os.tmpdir()
    writeJson(path.join(fakeCheckout, 'node_modules', 'media-typer', 'package.json'), {
      name: 'media-typer',
      version: '0.3.0',
      main: 'index.js'
    })
    writeText(
      path.join(fakeCheckout, 'node_modules', 'media-typer', 'index.js'),
      `exports.test = () => true;\n`
    )

    const validBundle = path.join(fakeCheckout, 'dist', 'mac-arm64', 'TwilightEcho.app')
    await buildSyntheticPackagedAsar(path.join(validBundle, 'Contents', 'Resources', 'app.asar'), {
      omitNestedMediaTyper: false
    })
    const okResult = verifyPackagedRuntimeSmoke(validBundle, { runner: 'node' })
    assert.equal(okResult.mode, 'extracted-node')
    assert.equal(okResult.scannedTracks, 1)
    assert.equal(okResult.ncmRoutesChecked, 3)

    const brokenBundle = path.join(fakeCheckout, 'dist', 'mac-x64', 'TwilightEcho.app')
    await buildSyntheticPackagedAsar(path.join(brokenBundle, 'Contents', 'Resources', 'app.asar'), {
      omitNestedMediaTyper: true
    })
    assert.throws(() => verifyPackagedRuntimeSmoke(brokenBundle, { runner: 'node' }), /media-typer/)
  } finally {
    fs.rmSync(fakeCheckout, { recursive: true, force: true })
  }
})
