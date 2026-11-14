import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command }) => {
  // Development and explicitly requested evaluation packages expose manual
  // listening without asserting delivery acceptance. Use the same build value
  // for main and renderer so a usable selector cannot be silently forced off.
  const evaluation = command === 'serve' || process.env.TWILIGHT_AUTOMIX_EVALUATION === '1'
  const autoMixDefine = { __TWILIGHT_AUTOMIX_EVALUATION__: JSON.stringify(evaluation) }
  return {
    main: {
      define: autoMixDefine,
      build: {
        sourcemap: 'hidden',
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
            bootstrap: resolve(__dirname, 'src/main/server/bootstrap.ts'),
            musicCore: resolve(__dirname, 'src/main/coreProcess/entry.ts'),
            modelPackWorker: resolve(__dirname, 'src/main/coreProcess/modelPackWorker.ts'),
            diagnosticWriter: resolve(__dirname, 'src/main/diagnostics/writerWorker.ts'),
            pluginHost: resolve(__dirname, 'src/main/plugins/host.ts'),
            audioEngineService: resolve(__dirname, 'src/main/audioEngineService.ts'),
            audioAnalysisService: resolve(__dirname, 'src/main/audioAnalysisService.ts'),
            libraryScanService: resolve(__dirname, 'src/main/library/libraryScanService.ts'),
            libraryDatabaseService: resolve(__dirname, 'src/main/library/libraryDatabaseService.ts')
          }
        }
      }
    },
    preload: { build: { sourcemap: 'hidden' } },
    renderer: {
      define: autoMixDefine,
      resolve: {
        alias: [
          {
            find: resolve(__dirname, 'src/shared/i18n/translate.ts'),
            replacement: resolve(__dirname, 'src/shared/i18n/translateRenderer.ts')
          },
          {
            find: resolve(__dirname, 'src/shared/i18n/translate.ts').replace(/\\/g, '/'),
            replacement: resolve(__dirname, 'src/shared/i18n/translateRenderer.ts')
          },
          {
            find: resolve(__dirname, 'src/shared/i18n/translate'),
            replacement: resolve(__dirname, 'src/shared/i18n/translateRenderer.ts')
          },
          {
            find: resolve(__dirname, 'src/shared/i18n/translate').replace(/\\/g, '/'),
            replacement: resolve(__dirname, 'src/shared/i18n/translateRenderer.ts')
          },
          {
            find: /^(?:(?:\.\.?\/)+(?:shared\/)?|src\/shared\/)i18n\/translate(?:\.ts)?$/,
            replacement: resolve(__dirname, 'src/shared/i18n/translateRenderer.ts')
          },
          {
            find: '@renderer',
            replacement: resolve('src/renderer/src')
          }
        ]
      },
      publicDir: resolve('resources'),
      plugins: [vue()],
      build: {
        manifest: true,
        chunkSizeWarningLimit: 600,
        rollupOptions: {
          output: {
            manualChunks: {
              'locale-zh-CN': [resolve(__dirname, 'src/shared/i18n/messages/zh-CN.ts')],
              'locale-en-US': [resolve(__dirname, 'src/shared/i18n/messages/en-US.ts')],
              'media-providers': [resolve('src/renderer/src/providers/index.ts')],
              'vendor-vue': ['vue'],
              'vendor-music-metadata': ['music-metadata'],
              'vendor-qrcode': ['qrcode'],
              'vendor-xmldom': ['@xmldom/xmldom']
            }
          }
        }
      }
    }
  }
})
