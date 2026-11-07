const assert = require('node:assert/strict')
const test = require('node:test')

const {
  dependencyManifestCandidates,
  findMissingPackageDependencies,
  findUnexpectedPackageVersions,
  normalizeArchivePath,
  packageRootFromManifest
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
  // A security override is an explicit installation decision, even when the
  // original upstream range does not include the locked version.
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
