'use strict'
const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

const root = resolve(__dirname, '..')
buildSync({
  absWorkingDir: root,
  entryPoints: {
    bootstrap: 'src/main/server/bootstrap.ts',
    server: 'src/main/server/entry.ts',
    runtime: 'src/main/server/runtime.ts',
    nodeSupervisor: 'src/main/server/nodeSupervisor.ts',
    platform: 'src/main/server/platform.ts',
    musicCore: 'src/main/coreProcess/entry.ts',
    audioEngineService: 'src/main/audioEngineService.ts',
    audioAnalysisService: 'src/main/audioAnalysisService.ts',
    libraryDatabaseService: 'src/main/library/libraryDatabaseService.ts',
    libraryScanService: 'src/main/library/libraryScanService.ts',
    pluginHost: 'src/main/plugins/host.ts'
  },
  outdir: 'out/server',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  packages: 'external',
  banner: { js: 'const __entryUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { 'import.meta.url': '__entryUrl', __TWILIGHT_AUTOMIX_EVALUATION__: 'false' },
  logLevel: 'info'
})
