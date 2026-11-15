const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const asar = require('@electron/asar')

const afterPack = require('./after-pack.cjs').default
const {
  dependencyManifestCandidates,
  extractBundleExternalSpecifiers,
  findMissingPackageDependencies,
  findUnexpectedPackageVersions,
  findUnresolvedBundleImports,
  findUnsatisfiedDependencyRanges,
  normalizeArchivePath,
  packageRootFromManifest,
  parseExternalSpecifier,
  readPackagedArchive,
  resolvePackagedAsarPath,
  resolveSubpathInPackage
} = require('./verify-packaged-dependency-closure.cjs')

test('packaged dependency paths normalize scoped and nested package manifests', () => {
  assert.equal(
    normalizeArchivePath('\\node_modules\\token-types\\package.json'),
    '/node_modules/token-types/package.json'
  )
  assert.equal(
    packageRootFromManifest('/node_modules/@tokenizer/inflate/package.json'),
    '/node_modules/@tokenizer/inflate'
  )
  assert.deepEqual(
    dependencyManifestCandidates('/node_modules/parent/node_modules/child', 'shared'),
    [
      '/node_modules/parent/node_modules/child/node_modules/shared/package.json',
      '/node_modules/parent/node_modules/shared/package.json',
      '/node_modules/shared/package.json'
    ]
  )
})

test('packaged dependency closure reports every unresolved runtime dependency', () => {
  const manifests = new Map([
    ['/node_modules/root', { name: 'root', dependencies: { nested: '1.0.0', shared: '1.0.0' } }],
    [
      '/node_modules/root/node_modules/nested',
      { name: 'nested', dependencies: { shared: '1.0.0', missing: '1.0.0' } }
    ],
    ['/node_modules/shared', { name: 'shared' }]
  ])
  assert.deepEqual(findMissingPackageDependencies(manifests), ['nested -> missing'])
})

test('semver range verification catches flattened incompatible transitive versions while honoring overrides', () => {
  const brokenFlattened = new Map([
    [
      '/node_modules/type-is',
      { name: 'type-is', version: '1.6.18', dependencies: { 'media-typer': '0.3.0' } }
    ],
    [
      '/node_modules/music-metadata',
      { name: 'music-metadata', version: '11.16.0', dependencies: { 'media-typer': '^2.0.0' } }
    ],
    ['/node_modules/media-typer', { name: 'media-typer', version: '2.0.0' }]
  ])
  assert.deepEqual(findUnsatisfiedDependencyRanges(brokenFlattened), [
    'type-is -> media-typer@0.3.0: found 2.0.0'
  ])

  brokenFlattened.set('/node_modules/type-is/node_modules/media-typer', {
    name: 'media-typer',
    version: '0.3.0'
  })
  assert.deepEqual(findUnsatisfiedDependencyRanges(brokenFlattened), [])

  const overridden = new Map([
    [
      '/node_modules/express',
      {
        name: 'express',
        version: '4.22.2',
        dependencies: { 'body-parser': '~1.20.3', qs: '6.14.0' }
      }
    ],
    ['/node_modules/body-parser', { name: 'body-parser', version: '1.20.9' }],
    ['/node_modules/qs', { name: 'qs', version: '6.16.1' }]
  ])
  assert.deepEqual(
    findUnsatisfiedDependencyRanges(overridden, {
      overrides: { 'body-parser@1': '1.20.9', qs: '6.16.1' }
    }),
    []
  )
})

test('packaging preserves installed nested versions and intentional overrides', () => {
  const manifests = new Map([
    ['/node_modules/type-is', { name: 'type-is', dependencies: { 'media-typer': '0.3.0' } }],
    [
      '/node_modules/music-metadata',
      { name: 'music-metadata', dependencies: { 'media-typer': '^2.0.0' } }
    ],
    ['/node_modules/media-typer', { name: 'media-typer', version: '2.0.0' }]
  ])
  assert.deepEqual(findMissingPackageDependencies(manifests), [])
  const expected = [
    {
      destination: 'node_modules/media-typer',
      manifest: { name: 'media-typer', version: '2.0.0' }
    },
    {
      destination: 'node_modules/type-is/node_modules/media-typer',
      manifest: { name: 'media-typer', version: '0.3.0' }
    }
  ]
  assert.deepEqual(findUnexpectedPackageVersions(manifests, expected), [
    'media-typer@0.3.0 missing at node_modules/type-is/node_modules/media-typer'
  ])
  manifests.set('/node_modules/type-is/node_modules/media-typer', {
    name: 'media-typer',
    version: '0.3.0'
  })
  assert.deepEqual(findUnexpectedPackageVersions(manifests, expected), [])
  manifests.set('/node_modules/media-typer', {
    name: 'media-typer',
    version: '0.3.0'
  })
  assert.deepEqual(findUnexpectedPackageVersions(manifests, expected), [
    'node_modules/media-typer: expected 2.0.0, found 0.3.0'
  ])
  manifests.set('/node_modules/qs', { name: 'qs', version: '6.16.0' })
  assert.deepEqual(
    findUnexpectedPackageVersions(manifests, [
      { destination: 'node_modules/qs', manifest: { name: 'qs', version: '6.16.0' } }
    ]),
    []
  )
})

test('an extra nearer package cannot shadow the installed dependency resolution', () => {
  const expected = [
    {
      destination: 'node_modules/body-parser',
      manifest: {
        name: 'body-parser',
        version: '1.20.9',
        dependencies: { 'content-type': '~1.0.5' }
      }
    },
    {
      destination: 'node_modules/content-type',
      manifest: { name: 'content-type', version: '1.0.5' }
    }
  ]
  const manifests = new Map(
    expected.map(({ destination, manifest }) => ['/' + destination, manifest])
  )
  manifests.set('/node_modules/body-parser/node_modules/content-type', {
    name: 'content-type',
    version: '2.1.0'
  })
  assert.deepEqual(findUnexpectedPackageVersions(manifests, expected), [
    'body-parser -> content-type: expected 1.0.5, found 2.1.0'
  ])
})

test('bundle external import audit checks main/preload specifiers and exports subpaths', async () => {
  assert.equal(parseExternalSpecifier('fs/promises'), null)
  assert.equal(parseExternalSpecifier('node:path'), null)
  assert.deepEqual(parseExternalSpecifier('@neteasecloudmusicapienhanced/api/server.js'), {
    packageName: '@neteasecloudmusicapienhanced/api',
    subpath: 'server.js'
  })
  assert.deepEqual(
    extractBundleExternalSpecifiers(
      `const a = require("music-metadata"); import b from 'stream-json/parser.js'; const c = () => import('@neteasecloudmusicapienhanced/api/server.js')`
    ),
    ['@neteasecloudmusicapienhanced/api/server.js', 'music-metadata', 'stream-json/parser.js']
  )
  assert.equal(
    resolveSubpathInPackage(
      '/node_modules/stream-json',
      { exports: { '.': './src/index.js', './*': './src/*' } },
      'parser.js',
      new Set(['/node_modules/stream-json/src/parser.js'])
    ),
    true
  )

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-bundle-audit-'))
  try {
    const appDir = path.join(tempDir, 'app')
    fs.mkdirSync(path.join(appDir, 'out', 'main'), { recursive: true })
    fs.mkdirSync(path.join(appDir, 'node_modules', 'present-pkg'), { recursive: true })
    fs.writeFileSync(
      path.join(appDir, 'node_modules', 'present-pkg', 'package.json'),
      JSON.stringify({ name: 'present-pkg', version: '1.0.0' })
    )
    fs.writeFileSync(
      path.join(appDir, 'out', 'main', 'index.js'),
      `require('electron'); require('fs/promises'); require('present-pkg'); require('missing-pkg');`
    )
    const asarPath = path.join(tempDir, 'app.asar')
    await asar.createPackage(appDir, asarPath)
    const { manifests, archiveEntryByPath } = readPackagedArchive(asarPath)
    assert.deepEqual(
      findUnresolvedBundleImports(asarPath, manifests, archiveEntryByPath, {
        externalPackages: ['electron']
      }),
      ['/out/main/index.js -> missing-pkg']
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('afterPack fails closed on macOS app bundles when a nested runtime dependency is missing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-afterpack-darwin-'))
  try {
    const appSrc = path.join(tempDir, 'src-app')
    fs.mkdirSync(path.join(appSrc, 'node_modules', 'type-is'), { recursive: true })
    fs.writeFileSync(
      path.join(appSrc, 'node_modules', 'type-is', 'package.json'),
      JSON.stringify({
        name: 'type-is',
        version: '1.6.18',
        dependencies: { 'media-typer': '0.3.0' }
      })
    )
    const bundleResources = path.join(
      tempDir,
      'dist',
      'mac-arm64',
      'TwilightEcho.app',
      'Contents',
      'Resources'
    )
    fs.mkdirSync(bundleResources, { recursive: true })
    const asarPath = path.join(bundleResources, 'app.asar')
    await asar.createPackage(appSrc, asarPath)

    assert.equal(resolvePackagedAsarPath(path.join(tempDir, 'dist', 'mac-arm64')), asarPath)

    await assert.rejects(
      () =>
        afterPack({
          electronPlatformName: 'darwin',
          appOutDir: path.join(tempDir, 'dist', 'mac-arm64'),
          packager: { appInfo: { productFilename: 'TwilightEcho' } }
        }),
      /Missing packaged runtime dependencies:\ntype-is -> media-typer/
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
