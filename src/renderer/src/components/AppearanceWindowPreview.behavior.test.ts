import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { compileStyle, parse } from '@vue/compiler-sfc'
import { PNG } from 'pngjs'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { resolveLiquidGlassTone } from '../../../shared/liquidGlass.ts'

const require = createRequire(import.meta.url)
test('shared glass tone honors forced and adaptive profiles without changing its input', () => {
  const automatic = { overLight: false, adaptiveTone: true }
  const manual = { overLight: true, adaptiveTone: false }
  assert.equal(resolveLiquidGlassTone('light', automatic), 'light')
  assert.equal(resolveLiquidGlassTone('light', automatic, 'dark'), 'dark')
  assert.equal(resolveLiquidGlassTone('light', automatic, 'light'), 'light')
  assert.equal(resolveLiquidGlassTone('light', automatic, 'Dark'), 'light')
  assert.equal(resolveLiquidGlassTone('light', manual, 'light'), 'dark')
  assert.equal(
    resolveLiquidGlassTone('light', { ...automatic, adaptiveTone: false }, 'dark'),
    'light'
  )
  assert.equal(resolveLiquidGlassTone('dark', automatic, 'light'), 'dark')
  assert.deepEqual(automatic, { overLight: false, adaptiveTone: true })
  assert.deepEqual(manual, { overLight: true, adaptiveTone: false })
})
test('preview title chrome never reads private login state and live chrome retains it', async () => {
  const source = await readFile(new URL('./TitleBar.vue', import.meta.url), 'utf8')
  const bindings = source.slice(
    source.indexOf('const loginProvider = computed'),
    source.indexOf('const { canGoBack')
  )
  const avatarWatch = source.slice(
    source.indexOf('const avatarLoadFailed = ref'),
    source.indexOf('const titleBar = ref')
  )
  const props = reactive({ preview: true })
  const account = ref({
    userId: 123,
    nickname: 'PRIVATE_PROFILE_SENTINEL',
    avatarUrl: 'private.png'
  })
  const loggedIn = ref(true)
  const providers = ref([{ id: 'ncm', name: '网易云音乐', capabilities: ['login'] }])
  let profileReads = 0
  let providerReads = 0
  let loginReads = 0
  const scope = effectScope()
  try {
    const chrome = scope.run(() =>
      runInNewContext(
        `${bindings}\n${avatarWatch}\n;({loginProvider,showNcmProfile,loginLabel,avatarLoadFailed})`,
        {
          props,
          computed,
          ref,
          watch,
          profile: {
            get value() {
              profileReads++
              return account.value
            }
          },
          isLoggedIn: {
            get value() {
              loginReads++
              return loggedIn.value
            }
          },
          providerStore: {
            providers: {
              get value() {
                providerReads++
                return providers.value
              }
            }
          }
        }
      )
    )!
    const assertPreview = (): void => {
      assert.equal(chrome.loginProvider.value, undefined)
      assert.equal(chrome.showNcmProfile.value, false)
      assert.equal(chrome.loginLabel.value, '流媒体登录')
      assert.equal(profileReads, 0)
      assert.equal(providerReads, 0)
      assert.equal(loginReads, 0)
    }
    assertPreview()
    props.preview = false
    await nextTick()
    assert.equal(chrome.loginProvider.value.id, 'ncm')
    assert.equal(chrome.showNcmProfile.value, true)
    assert.equal(chrome.loginLabel.value, 'PRIVATE_PROFILE_SENTINEL')
    chrome.avatarLoadFailed.value = true
    account.value.avatarUrl = 'updated-private.png'
    await nextTick()
    assert.equal(chrome.avatarLoadFailed.value, false)
    loggedIn.value = false
    assert.equal(chrome.showNcmProfile.value, false)
    assert.equal(chrome.loginLabel.value, '网易云音乐登录')
    props.preview = true
    await nextTick()
    profileReads = providerReads = loginReads = 0
    account.value.nickname = 'UPDATED_PRIVATE_PROFILE_SENTINEL'
    account.value.avatarUrl = 'updated-again-private.png'
    await nextTick()
    assertPreview()
  } finally {
    scope.stop()
  }
})
test('real window preview preserves controls, isolated drafts, hidden work and one contextual camera', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-window-preview-'))
  try {
    const skinImage = new PNG({ width: 240, height: 100 })
    for (let y = 0; y < skinImage.height; y++) {
      for (let x = 0; x < skinImage.width; x++) {
        const offset = (y * skinImage.width + x) * 4
        const transparentCorner = (x < 24 || x >= 216) && (y < 20 || y >= 80)
        const color = y < 20 || y >= 80 ? [219, 55, 119] : [21, 116, 76]
        skinImage.data.set([...color, transparentCorner ? 0 : 255], offset)
      }
    }
    await writeFile(join(directory, 'panel-skin.png'), PNG.sync.write(skinImage))
    const blueIcon = new PNG({ width: 16, height: 16 })
    for (let offset = 0; offset < blueIcon.data.length; offset += 4)
      blueIcon.data.set([40, 120, 220, 255], offset)
    await writeFile(join(directory, 'icon-blue.png'), PNG.sync.write(blueIcon))
    const components = resolve('src/renderer/src/components').replaceAll('\\', '/')
    // Optional read-only compatibility input: compile an in-progress native
    // home without copying its production files into this worktree.
    const homeSource = process.env.TE_PREVIEW_HOME_SOURCE
    const shared = resolve('src/shared').replaceAll('\\', '/')
    const isolatedStores = join(directory, 'fixtures.ts').replaceAll('\\', '/')
    const filename = resolve(components, '../App.vue')
    const { descriptor } = parse(await readFile(filename, 'utf8'), { filename })
    const shellStyles = descriptor.styles
      .map((style) => {
        const result = compileStyle({
          source: style.content,
          filename,
          id: 'data-v-fixture-app',
          scoped: style.scoped
        })
        assert.deepEqual(result.errors, [])
        return result.code
      })
      .join('\n')
    await writeFile(
      join(directory, 'entry.ts'),
      runtime.replaceAll('__COMPONENTS__', components).replaceAll('__SHARED__', shared)
    )
    await writeFile(
      join(directory, 'fixtures.ts'),
      (await readFile(resolve('scripts/fixtures/appearance-preview-stores.mjs'), 'utf8'))
        .replaceAll('__SHARED__', shared)
        .replaceAll(
          'PRIVATE_AVATAR_SENTINEL',
          'https://private-avatar.invalid/PRIVATE_AVATAR_SENTINEL.png'
        )
    )
    const compiledComponents = new Set<string>()
    await build({
      root: directory,
      configFile: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'real-preview-isolated-stores',
          enforce: 'pre',
          resolveId(source) {
            if (source === '/icon.png') return resolve('resources/icon.png')
            if (
              /\/(useSettingsStore|useMusicStore|usePlayerStore|useThemeStore|useListeningStatsStore|useAudioOutputDspStore|useNcmStore|useAppNoticeStore|playbackBookmarks|lyricsManagement)(?:\.ts)?$/.test(
                source
              ) ||
              /\/extensions\/registry(?:\.ts)?$/.test(source)
            )
              return isolatedStores
            if (
              /\/(HiFiSidebar|PlaybackQueueSidebar|QueueAddToPlaylistDialog|CompactPlayerBarVisualizer)\.vue$/.test(
                source
              )
            )
              return '\0preview-forbidden-overlay'
            return null
          },
          async load(id) {
            if (id === '\0preview-forbidden-overlay')
              return 'export default { setup() { throw Error("preview mounted an inactive business panel") } }'
            const sourcePath = id.split('?')[0]
            if (
              homeSource &&
              ((sourcePath === `${components}/local-dashboard/OnlineHome.vue` &&
                !id.includes('?')) ||
                sourcePath === `${components}/local-dashboard/OnlineHome.css`)
            )
              return readFile(resolve(homeSource, basename(sourcePath)), 'utf8')
            return null
          },
          transform(code, id) {
            const component = id.match(
              /\/(TitleBar|SideMenu|LocalDashboard|OnlineHome|OnlineDashboard|PlayerBar)\.vue$/
            )?.[1]
            if (component) compiledComponents.add(component)
            if (id.endsWith('/assets/main.css')) return code.replace("@import './fonts.css';", '')
            return null
          }
        },
        vue()
      ],
      resolve: {
        alias: {
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: isolatedStores,
          '@renderer': resolve(components, '..'),
          '@shared': shared
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: 'bundle',
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'PreviewFixture',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    // LocalDashboard remains the separate workshop sample; the normal scene
    // must also compile the pure home and never the online business container.
    assert.deepEqual([...compiledComponents].sort(), [
      'LocalDashboard',
      'OnlineHome',
      'PlayerBar',
      'SideMenu',
      'TitleBar'
    ])
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html data-theme="dark" data-te-motion="off" data-platform="win32"><head><meta charset="utf-8">${files
        .filter((f) => f.endsWith('.css'))
        .map((f) => `<link rel="stylesheet" href="bundle/${f}">`)
        .join('')}<style>${shellStyles}</style><style>
      :root{--te-app-bg:#17181a;--te-settings-backplate:#17181a;--te-settings-text:#f7f7f2;--te-font-sans:Arial;--te-primary-500:#3478fa}
      body{margin:0}.stage{width:640px;margin:60px 20px}.fixture-real-titlebar{position:fixed;inset:0 0 auto;height:40px}
      .fixture-app-scope{position:fixed;inset:0;visibility:hidden;pointer-events:none}
      body.visual-qa{background:var(--te-app-bg)}body.visual-qa .stage{width:calc(100vw - 48px);margin:16px 24px}
      body.visual-qa #menu-anchor,body.visual-qa .fixture-real-titlebar{display:none}
      #menu-anchor{position:fixed;left:420px;bottom:20px;width:60px;height:44px}
      #app > .appearance-page button[aria-pressed="true"]{background:#303234}
      </style></head><body><div id="app"></div><script src="bundle/${files.find((f) => f.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      { windowsHide: true, timeout: 180_000 }
    )
    if (process.env.TE_PREVIEW_DEPTH_ONLY) {
      assert.match(result.stdout, /PREVIEW_DEPTH_OK/)
      console.info(result.stdout.trim())
      return
    }
    assert.match(result.stdout, /WINDOW_PREVIEW_OK/)
    const home = JSON.parse(result.stdout.match(/PREVIEW_HOME (.+)/)![1])
    assert.equal(home.component, 'OnlineHome')
    assert.equal(home.providerSections, 0)
    assert.equal(home.recentTracks, 6)
    assert.equal(home.heroTitle, '夜空中的旋律')
    assert.equal(home.network, 0)
    if (homeSource) assert.equal(home.hasLocalSection, true)
    if (home.hasLocalSection) {
      assert.equal(home.localCards, 6)
      assert.equal(home.libraryEntries, 2)
    }
    console.info('Preview pure home boundary:', JSON.stringify(home))
    const skins = JSON.parse(result.stdout.match(/PREVIEW_SKINS (.+)/)![1]) as {
      cases: { paintedPixels: number; samePlane: boolean; nativeBoundsPreserved: boolean }[]
      outerCases: { samples: { name: string; paintedPixels: number }[]; rootTransparent: boolean }[]
      innerCases: { paintedPixels: number; samePlane: boolean; nativeBoundsPreserved: boolean }[]
      externalRequests: number
    }
    assert.equal(skins.cases.length, 6)
    assert.equal(skins.outerCases.length, 4)
    assert.ok(
      skins.outerCases.every(
        (item) =>
          item.rootTransparent &&
          ['title', 'edge'].every((name) =>
            item.samples.some((sample) => sample.name === name && sample.paintedPixels > 0)
          )
      )
    )
    assert.equal(skins.innerCases.length, 4)
    assert.ok(
      skins.innerCases.every(
        (item) => item.paintedPixels > 0 && item.samePlane && item.nativeBoundsPreserved
      )
    )
    assert.equal(skins.externalRequests, 0)
    assert.ok(
      skins.cases.every(
        (item) => item.paintedPixels > 0 && item.samePlane && item.nativeBoundsPreserved
      )
    )
    console.info('Preview real PNG skins:', JSON.stringify(skins))
    const iconSync = JSON.parse(result.stdout.match(/PREVIEW_ICON_SYNC (.+)/)![1]) as {
      phase: string
      sameStyles: boolean
      sameSize: boolean
      layered: boolean
      paintedPixels: number
    }[]
    assert.equal(iconSync.length, 3)
    assert.ok(iconSync.every((item) => item.sameStyles && item.sameSize && item.layered))
    assert.ok(
      iconSync.filter((item) => item.phase !== 'clear').every((item) => item.paintedPixels > 0)
    )
    console.info('Preview live icon bridge:', JSON.stringify(iconSync))
    const performance = JSON.parse(result.stdout.match(/PREVIEW_PERF (.+)/)![1])
    assert.ok(performance.mirroredUpdates <= 2)
    assert.ok(performance.cameraFrames > 0)
    assert.equal(performance.animatedChildStyles, 0)
    assert.equal(performance.animatedSourceMeasures, 0)
    assert.equal(performance.repeatedRootWrites, 0)
    const lifecycle = JSON.parse(result.stdout.match(/PREVIEW_LIFECYCLE (.+)/)![1])
    assert.equal(lifecycle.hiddenChildWrites, 0)
    assert.equal(lifecycle.hiddenSourceMeasures, 0)
    assert.equal(lifecycle.hiddenCameraFrames, 0)
    assert.equal(lifecycle.hiddenScheduledFrames, 0)
    assert.equal(lifecycle.resumeLatestWrites, 1)
    assert.equal(lifecycle.resumeCameraFrames, 1)
    assert.ok(lifecycle.resumeSourceMeasures > 0 && lifecycle.resumeSourceMeasures <= 160)
    const configuration = JSON.parse(result.stdout.match(/PREVIEW_CONFIGURATION (.+)/)![1])
    assert.equal(configuration.navigationCases, 2)
    assert.equal(configuration.customPlayerModes, 3)
    assert.equal(configuration.nativeActions, 0)
    const geometry = JSON.parse(result.stdout.match(/PREVIEW_GEOMETRY (.+)/)![1])
    assert.equal(geometry.tokenCases, 3)
    assert.equal(geometry.playerModes, 3)
    assert.equal(geometry.draftSettingsUnchanged, true)
    const palette = JSON.parse(result.stdout.match(/PREVIEW_IMAGE_PALETTE (.+)/)![1])
    assert.equal(palette.automaticCases, 2)
    assert.equal(palette.manualTextPreserved, true)
    assert.equal(palette.removedPalette, true)
    const backgroundOwnership = JSON.parse(
      result.stdout.match(/PREVIEW_BACKGROUND_OWNERSHIP (.+)/)![1]
    )
    assert.equal(backgroundOwnership.inheritedCases, 3)
    assert.equal(backgroundOwnership.exactColor, true)
    assert.equal(backgroundOwnership.savedImageTuning, true)
    assert.equal(backgroundOwnership.themeEditingNeutral, true)
    assert.equal(backgroundOwnership.draftUnchanged, true)
    const interaction = JSON.parse(result.stdout.match(/PREVIEW_CANVAS (.+)/)![1])
    assert.equal(interaction.centerCases, 3)
    assert.equal(interaction.blankResets, 2)
    assert.equal(interaction.propertySelectionPreserved, true)
    assert.equal(interaction.backgroundModules, 4)
    assert.equal(interaction.navigationRestorations, 3)
    assert.equal(interaction.manualNavigationPreserved, true)
    assert.equal(interaction.naturalChromeCases, 2)
    assert.equal(interaction.keyboardBackgroundPreserved, true)
    assert.equal(interaction.backgroundImmediateClear, true)
    const camera = JSON.parse(result.stdout.match(/PREVIEW_CAMERA (.+)/)![1])
    assert.equal(camera.range, true)
    assert.equal(camera.keyboardCases, 3)
    assert.equal(camera.clampCases, 3)
    assert.equal(camera.sameEngine, true)
    assert.equal(camera.liveReading, true)
    assert.equal(camera.restored2D, true)
    assert.ok(camera.cameraFrames > 0 && camera.rulerWrites > 0)
    assert.equal(camera.sceneWrites, 0)
    assert.equal(camera.sceneClones, 0)
    assert.equal(camera.sceneMeasures, 0)
    assert.equal(camera.unexpectedParentWrites, 0)
    const floating = JSON.parse(result.stdout.match(/PREVIEW_FLOATING (.+)/)![1])
    assert.equal(floating.geometry.length, 9)
    assert.ok(
      floating.geometry.every((item) => item.inside && item.outsideScene && item.rulersClear)
    )
    assert.ok(floating.transforms > 0)
    assert.equal(floating.unexpectedWrites, 0)
    assert.equal(floating.sceneWrites, 0)
    assert.equal(floating.sceneClones, 0)
    assert.equal(floating.sceneMeasures, 0)
    assert.equal(floating.rangeKeyboard, true)
    assert.equal(floating.nativeUndo, true)
    assert.equal(floating.escapeBubbles, true)
    assert.equal(floating.historyBubbles, true)
    assert.equal(floating.selectionPreserved, true)
    const layers = JSON.parse(result.stdout.match(/PREVIEW_LAYERS (.+)/)![1])
    assert.deepEqual(JSON.parse(result.stdout.match(/PREVIEW_TRANSITION (.+)/)![1]), {
      interrupted: true,
      instantReverse: true,
      opening: true,
      closing: true,
      axes: 2,
      boundaries: 4,
      controlsIsolated: true,
      reduced: true,
      defaultAngles: true
    })
    const rulers = JSON.parse(result.stdout.match(/PREVIEW_RULER_GEOMETRY (.+)/)![1])
    assert.equal(rulers.length, 3)
    assert.ok(rulers.every((item) => item.inside && item.horizontalDrop === 8 && item.pitchStable))
    assert.equal(layers.initialClones, 1)
    assert.ok(
      layers.initialSourceMeasures > 0 && layers.initialSourceMeasures <= 256,
      JSON.stringify(layers)
    )
    assert.equal(layers.projectionCases, 20)
    assert.equal(layers.sourceGeometryPreserved, true)
    assert.equal(layers.privacyPreserved, true)
    assert.equal(layers.spacingClones, 0)
    assert.equal(layers.spacingSourceMeasures, 0)
    assert.ok(layers.cameraFrames > 0)
    assert.equal(layers.cameraChildWrites, 0)
    assert.equal(layers.cameraClones, 0)
    assert.equal(layers.cameraSourceMeasures, 0)
    assert.ok(layers.parallaxFrames > 0)
    assert.equal(layers.parallaxClones, 0)
    assert.equal(layers.parallaxSourceMeasures, 0)
    assert.equal(layers.parallaxUnexpectedWrites, 0)
    assert.equal(layers.parallaxCameraStable, true)
    assert.equal(layers.parallaxReduced, true)
    const pointerRouting = JSON.parse(result.stdout.match(/PREVIEW_POINTER_ROUTING (.+)/)![1])
    assert.equal(pointerRouting.canvasMoves, 100)
    assert.equal(pointerRouting.canvasDocumentMoves, 0)
    assert.equal(pointerRouting.canvasGeometryReads, 0)
    assert.equal(pointerRouting.pointerFrames, 1)
    assert.equal(pointerRouting.trackingTailWrites, 0)
    assert.equal(pointerRouting.rulerDocumentMoves, 0)
    assert.equal(pointerRouting.ordinaryDocumentMoves, 1)
    assert.ok(pointerRouting.ordinaryGeometryReads > 0)
    assert.equal(pointerRouting.ordinaryScrollbarNear, true)
    assert.equal(pointerRouting.ordinaryScrollTopVisible, true)
    const boundaries = JSON.parse(result.stdout.match(/PREVIEW_POINTER_BOUNDARIES (.+)/)![1])
    assert.equal(boundaries.outsideEdges, 4)
    assert.equal(boundaries.rapidReentry, true)
    assert.equal(boundaries.immediateCases, 6)
    assert.equal(boundaries.lifecycleCases, 3)
    assert.equal(boundaries.baseAnglesPreserved, true)
    assert.equal(boundaries.zoomPreserved, true)
    assert.equal(boundaries.draftSettingsPreserved, true)
    assert.equal(boundaries.exitClones, 0)
    assert.equal(boundaries.exitSourceMeasures, 0)
    assert.equal(boundaries.exitSourceWrites, 0)
    assert.equal(boundaries.exitRootWrites, 0)
    assert.equal(boundaries.pendingFrames, 0)
    assert.equal(boundaries.idleWrites, 0)
    assert.equal(boundaries.scrollPresentationClones, 0)
    assert.equal(boundaries.scrollPresentationMeasures, 0)
    assert.equal(boundaries.publicAttributeCases, 3)
    assert.equal(boundaries.publicAttributeClones, 3)
    assert.equal(boundaries.noDifferenceClones, 0)
    assert.equal(boundaries.nativeCaptureCases, 4)
    assert.ok(boundaries.returnTimes.every((duration) => duration > 0 && duration < 500))
    assert.equal(layers.visibleRefreshClones, 1)
    assert.equal(layers.visibleRefreshLatestWrites, 1)
    assert.equal(layers.visibleRefreshMinimumOpacity, 1)
    assert.equal(layers.hiddenChildWrites, 0)
    assert.equal(layers.hiddenClones, 0)
    assert.equal(layers.hiddenSourceMeasures, 0)
    assert.equal(layers.hiddenScheduledFrames, 0)
    assert.equal(layers.resumeClones, 1)
    assert.ok(layers.resumeSourceMeasures > 0 && layers.resumeSourceMeasures <= 160)
    assert.equal(layers.resumeLatestWrites, 1)
    assert.equal(Number(result.stdout.match(/PREVIEW_LAYER_FOCUS (\d+)/)![1]), 12)
    const layerHits = JSON.parse(result.stdout.match(/PREVIEW_LAYER_HITS (.+)/)![1])
    assert.equal(layerHits.cases.length, 16)
    assert.ok(layerHits.cases.every((item) => item.pointerSelected && item.sameNativeProjection))
    assert.equal(layerHits.draftSettingsUnchanged, true)
    const workshop = JSON.parse(result.stdout.match(/PREVIEW_WORKSHOP (.+)/)![1])
    assert.equal(workshop.surfaceCases, 6)
    assert.equal(workshop.frames, 1)
    assert.equal(workshop.runtimeOverrides, true)
    assert.equal(workshop.diagnosticWarning, true)
    assert.equal(workshop.hiddenRejections, 2)
    assert.equal(workshop.hiddenChildWrites, 0)
    assert.equal(workshop.resumeLatestWrites, 1)
    assert.equal(workshop.dragCases, 2)
    assert.equal(workshop.cameraUnchanged, true)
    assert.equal(workshop.layerCount, 6)
    assert.ok(workshop.appPaintPixels2D > 20)
    assert.ok(workshop.appPaintPixels3D > 10)
    assert.equal(workshop.committedInspections, 2)
    assert.equal(workshop.interactiveControls, 2)
    assert.equal(workshop.draftUnchanged, true)
    const boundary = JSON.parse(result.stdout.match(/PREVIEW_BOUNDARY (.+)/)![1])
    assert.deepEqual(boundary, {
      native: 0,
      storeActions: 0,
      intervals: 0,
      persistence: 0,
      network: 0
    })
    console.info('Preview update burst:', JSON.stringify(performance))
    console.info('Preview hidden/resume:', JSON.stringify(lifecycle))
    console.info('Preview saved arrangements:', JSON.stringify(configuration))
    console.info('Preview real geometry:', JSON.stringify(geometry))
    console.info('Preview canvas interaction:', JSON.stringify(interaction))
    console.info('Preview same camera ruler:', JSON.stringify(camera))
    console.info('Preview native layers:', JSON.stringify(layers))
    console.info('Preview pointer boundaries:', JSON.stringify(boundaries))
    console.info('Preview ruler geometry:', JSON.stringify(rulers))
    console.info('Preview shared workshop:', JSON.stringify(workshop))
    console.info('Preview isolated boundary:', JSON.stringify(boundary))
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-window-preview-'))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `
import {createApp,h,reactive,ref,nextTick,computed} from 'vue';
import Preview from '__COMPONENTS__/AppearanceWindowPreview.vue';
import {installPreviewBoundary} from './fixtures.ts';
installPreviewBoundary();
import Popover from '__COMPONENTS__/AppearancePopover.vue';
import {uiMotionFor} from '__COMPONENTS__/../app/uiMotion.ts';
import {analyzeLiquidGlassColor} from '__COMPONENTS__/../utils/liquidGlassEnvironment.ts';
import {installAutoHideScrollbars} from '__COMPONENTS__/../utils/autoHideScrollbars.ts';
import {installScrollToTopButton} from '__COMPONENTS__/../utils/scrollToTopButton.ts';
import '__COMPONENTS__/../assets/main.css';
import '__COMPONENTS__/../assets/icon-fonts.ts';
import '__COMPONENTS__/theme-studio/ThemeStudioPage.css';
import {normalizeAppBackgroundSettings,defaultCardAppearance,cloneAppearance,resolveBackgroundPalette} from '__SHARED__/appAppearance.ts';
import {normalizeLiquidGlass} from '__SHARED__/liquidGlass.ts';
import {normalizeAppearanceLayers} from '__SHARED__/appearanceLayers.ts';
import {setThemeIconProfile} from '__COMPONENTS__/../app/themeIconRuntime.ts';
import {normalizeThemeProfile,themeTokensToCssVariables,TWILIGHT_DEFAULT_THEME,BUILT_IN_THEME_PRESET_IDS,getBuiltInThemePreset,resolveThemeProfileTokens,resolveThemeProfileModes,themeModesToDataAttributes,themeContrastRatio} from '__SHARED__/theme.ts';
import {createWorkshopProject,copyWorkshopDraft,compileWorkshopProject,workshopRuntimeAttributes} from '__SHARED__/themeWorkshop.ts';
import {createWorkshopLayer} from '__SHARED__/themeWorkshopLayers.ts';
import {workshopCanvasBoxes} from '__COMPONENTS__/theme-workshop/workshopCanvas.ts';
import {measureAppearanceSurfaces} from '__COMPONENTS__/../editor/appearanceSurfaces.ts';
import {useProviderStore} from '__COMPONENTS__/../stores/useProviderStore.ts';
import {useSongListSearch} from '__COMPONENTS__/song-list/useSongListSearch.ts';
import {libraryViewKey} from '__COMPONENTS__/../utils/libraryViewPreferences.ts';
const providerStore=useProviderStore({listen:false});providerStore.providers.value=[{id:'ncm',name:'Fixture',capabilities:['login'],supportedMethods:[]}];
const liveSearchProbe=(value)=>{let current;const node=document.createElement('div'),probe=createApp({setup(){const search=useSongListSearch(computed(()=>libraryViewKey('allSongs',null)));if(value!==undefined)search.searchQuery.value=value;current=search.searchQuery.value;return()=>null;}});probe.mount(node);probe.unmount();return current;};liveSearchProbe('PRIVATE_SEARCH_SENTINEL');
Storage.prototype.getItem=key=>{window.previewBoundary.persistence++;const error=Error('preview reads persisted preferences: '+key);console.error(error.stack);throw error;};
for(const [name,value] of Object.entries(themeTokensToCssVariables(TWILIGHT_DEFAULT_THEME.variants.dark.tokens)))document.documentElement.style.setProperty(name,value);
for(const [name,value] of Object.entries(themeModesToDataAttributes(resolveThemeProfileModes(TWILIGHT_DEFAULT_THEME))))document.documentElement.setAttribute(name,value);
const applyGlassEnvironment=nextTone=>{const root=document.documentElement,environment=analyzeLiquidGlassColor(getComputedStyle(root).getPropertyValue('--te-app-bg'),nextTone==='dark');for(const [name,value] of Object.entries(environment.variables))root.style.setProperty(name,value);root.dataset.teLiquidGlassContext=environment.context;root.dataset.teLiquidGlassAdaptiveTone=nextTone==='dark'?'dark':'light';};
applyGlassEnvironment('dark');
const draft=reactive({appBackground:normalizeAppBackgroundSettings(null),cardAppearance:defaultCardAppearance(),surfaceMaterial:'standard',liquidGlass:normalizeLiquidGlass(null)});
const nativeMatchMedia=window.matchMedia.bind(window),motionMedia=new EventTarget();let systemReduced=false;Object.defineProperties(motionMedia,{matches:{get:()=>systemReduced},media:{value:'(prefers-reduced-motion: reduce)'}});window.matchMedia=query=>query==='(prefers-reduced-motion: reduce)'?motionMedia:nativeMatchMedia(query);
const tone=ref('dark'),open=ref(false),anchor=ref(null),visible=ref(true),focused=ref('overview'),previewActive=ref(true),preview=ref(null),occlusions=ref([]),themeEditing=ref(false);
const floatingEnabled=ref(false),floatingValue=ref(5),floatingText=ref('原生输入');let floatingActions=0;
const workshopModel=ref(),workshopEvents=[];
const selectWorkshopLayer=(id,surface)=>{workshopEvents.push({kind:'select',id,surface});workshopModel.value={...workshopModel.value,selectedLayer:id};};
const editWorkshopLayer=(id,surface,patch)=>{workshopEvents.push({kind:'edit',id,surface,patch});const model=workshopModel.value,project=copyWorkshopDraft(model.project),layer=project.layers[model.scene.tone][surface].find(layer=>layer.id===id);Object.assign(layer,patch);workshopModel.value={...model,project,css:compileWorkshopProject(project)};};
let selected='',propertyActions=0;const app=createApp({setup:()=>()=>h('div',{class:'appearance-page'},[
 h('div',{class:'title-bar fixture-real-titlebar'},'主窗口标题栏'),
 h('div',{class:'app-shell fixture-app-scope','data-v-fixture-app':''}),
 visible.value?h('div',{class:'stage'},[h(Preview,{ref:preview,draft,tone:tone.value,page:'local',themeEditing:themeEditing.value,focusedRegion:focused.value,active:previewActive.value,occlusions:occlusions.value,workshopModel:workshopModel.value,onWorkshopLayerSelect:selectWorkshopLayer,onWorkshopLayerEdit:editWorkshopLayer,onWorkshopGesture:action=>workshopEvents.push({kind:'gesture',action}),onRegion:id=>{selected=id;focused.value=id}},floatingEnabled.value?{'context-tools':({region,layered})=>h('div',{style:'width:240px;height:36px;display:flex;align-items:center;gap:6px;background:#27292c', 'data-fixture-floating-region':region,'data-fixture-layered':String(layered)},[h('input',{type:'range',min:0,max:30,step:1,value:floatingValue.value,'aria-label':'浮动模糊',style:'width:72px',onInput:event=>{floatingValue.value=Number(event.target.value)}}),h('input',{value:floatingText.value,'aria-label':'浮动名称',style:'width:80px',onInput:event=>{floatingText.value=event.target.value}}),h('button',{type:'button','aria-label':'浮动恢复',onClick:()=>{floatingActions++}},'恢复')])}:undefined)]):null,
 h('button',{id:'menu-anchor',ref:anchor,onClick:()=>{open.value=true}},'背景'),
 visible.value?h(Popover,{open:open.value,anchor:anchor.value,label:'背景',onClose:()=>{open.value=false}},()=>[h('input',{type:'color',value:draft.appBackground.global.dark,onInput:e=>{draft.appBackground.global.dark=e.target.value;draft.appBackground.global.customized=true}}),h('button',{id:'fixture-property-action',type:'button',onClick:()=>{propertyActions++}},'属性控件')]):null
])});app.config.errorHandler=error=>{window.previewErrors.push(String(error?.stack??error));console.error(error?.stack??error)};app.mount('#app');
const settle=async()=>{await nextTick();await new Promise(r=>setTimeout(r,220));await nextTick()};
const expect=(v,message)=>{if(!v)throw Error(message)};
const waitFor=async(condition,message)=>{const deadline=performance.now()+3000;while(!condition()&&performance.now()<deadline){await nextTick();await new Promise(resolve=>setTimeout(resolve,30));}expect(condition(),message);};
const previewViewReady=(host,layered)=>{
 const doc=host.querySelector('iframe')?.contentDocument,source=doc?.querySelector('body > .appearance-preview-scene'),clone=doc?.querySelector('.appearance-layer-view');
 if(!source||preview.value.layeredView!==layered||host.dataset.viewTransition!=='idle'||preview.value.layerTransitioning||host.getAttribute('aria-busy')!=='false'||preview.value.getCameraZoom().pending)return false;
 if(!previewActive.value||document.hidden||document.documentElement.dataset.teVisibility==='hidden')return !clone&&source.style.visibility==='';
 return doc.documentElement.dataset.teMotion===document.documentElement.dataset.teMotion&&host.dataset.previewView===(layered?'layered':'flat')&&(layered?!!clone?.querySelector('[data-appearance-layer-scene]')&&source.style.visibility==='hidden':!clone&&source.style.visibility==='');
};
const waitForPreviewView=(host,message,layered=preview.value.layeredView)=>waitFor(()=>previewViewReady(host,layered),message);
const noExpandedNavigationHotspot=host=>!host.querySelector('[aria-label="调整侧边栏材质"]')||host.querySelector('[aria-label="调整侧边栏材质"]').getBoundingClientRect().width<=80;
const actualElements=(scope,selector)=>[...scope.querySelectorAll(selector)].filter(element=>element.ownerDocument.defaultView.getComputedStyle(element).display!=='none'&&!element.closest('[data-appearance-material-context]')&&(!element.closest('[data-appearance-surface-key]')||element.closest('[data-appearance-detail]')));
const actualElement=(scope,selector)=>actualElements(scope,selector)[0];
const moduleSelectors={navigation:'.side-menu',material:'.app-shell-title .title-bar','player-bar':'.player-bar',card:'.online-hero, .feature-card, .online-playlist',background:'.app-shell-content'};
const backgroundPaint=(scope,doc)=>Object.fromEntries(['.appearance-window-background','.app-background-image','.app-background-dim','.app-shell-content','.main-content','.online-home'].map(selector=>{const element=actualElement(scope,selector),paint=doc.defaultView.getComputedStyle(element);return [selector,{color:paint.backgroundColor,image:paint.backgroundImage,opacity:paint.opacity,filter:paint.filter}]}));
const foregroundOnly=(scope,doc,host,baseline)=>{
 expect(JSON.stringify(backgroundPaint(scope,doc))===JSON.stringify(baseline),'background focus alters native background color, image, ambient paint or transparency');
 expect(doc.defaultView.getComputedStyle(actualElement(scope,'.online-home-inner')).opacity==='0','background focus does not clear the native foreground');
 expect(getComputedStyle(host.querySelector('.appearance-editor-context')).opacity==='0','background focus leaves a gray context mask over the editable background');
 expect(getComputedStyle(host.querySelector('[data-region="inner-panel"]')).backgroundColor==='rgba(0, 0, 0, 0)','host selected-button skin paints over the actual editable background');
 const windowEdge=host.dataset.previewView==='layered'?doc.defaultView.getComputedStyle(scope.querySelector('[data-appearance-layer="content"]'),'::after'):getComputedStyle(host.querySelector('.appearance-editor-world'),'::after');
 expect(windowEdge.display==='block'&&windowEdge.outlineStyle==='solid'&&parseFloat(windowEdge.outlineWidth)>0&&windowEdge.outlineColor!=='rgba(0, 0, 0, 0)','background focus loses the visible preview window boundary');
 expect(parseFloat(windowEdge.borderRadius)>0,'background window loses its rounded extent');
};
const sourceGeometry=doc=>Object.fromEntries(Object.entries(moduleSelectors).map(([id,selector])=>{const r=doc.querySelector(selector).getBoundingClientRect();return [id,{left:r.left,top:r.top,width:r.width,height:r.height}]}));
const unchangedGeometry=(doc,snapshot,message)=>{const current=sourceGeometry(doc);for(const id of Object.keys(snapshot))for(const dimension of ['left','top','width','height'])expect(Math.abs(current[id][dimension]-snapshot[id][dimension])<0.01,message+': '+id+' '+dimension)};
const navigationItems=doc=>actualElements(doc,'.menu-nav > .menu-item,.menu-nav > .menu-group > .menu-group-toggle');
const navigationRows=doc=>navigationItems(doc).filter(row=>!row.classList.contains('sidebar-plugins')).map(row=>({'主页':'local-home','搜索':'search','流媒体音乐':'streaming','音乐库':'local-library','最近播放':'recent'})[row.getAttribute('aria-label')]);
const playerControlClasses={cover:'player-cover-slot',trackInfo:'player-track-info',transport:'player-controls',playPause:'mini-play-button',time:'player-time-readout',favorite:'favorite-btn',playMode:'mode-btn-right',volume:'volume-anchor',queue:'track-menu-button',hifi:'hifi-toggle-button',equalizer:'equalizer-btn',desktopLyrics:'desktop-lyrics-btn',miniPlayer:'mini-player-btn'};
const placedControls=region=>[...region.children].flatMap(element=>{const id=Object.entries(playerControlClasses).find(([,name])=>element.classList.contains(name))?.[0];return id?[{id,element}]:[]});
const playerArrangement=doc=>Object.fromEntries([...doc.querySelectorAll('[data-te-playbar-region]')].map(region=>[region.dataset.tePlaybarRegion,placedControls(region).map(control=>control.id)]));
const uniformCamera=host=>{
 const world=host.querySelector('.appearance-editor-world'),frame=host.querySelector('iframe'),matrix=new DOMMatrixReadOnly(getComputedStyle(world).transform),scale=Number(host.dataset.cameraScale);
 expect(Math.abs(matrix.a-matrix.d)<0.00001&&Math.abs(matrix.b)<0.00001&&Math.abs(matrix.c)<0.00001&&Math.abs(matrix.a-scale)<0.00001,'camera applies nonuniform or additional scaling');expect(getComputedStyle(frame).transform==='none'&&Number.parseFloat(getComputedStyle(frame).zoom)===1,'iframe applies a second scale');
 const source=frame.contentDocument;
 for(const element of source.querySelectorAll('.title-bar button,.title-bar-icon,.window-control-icon,.menu-item,.item-icon,.player-cover-slot,.player-controls,.btn-play,.mini-play-button,.player-title,.player-artist')){const style=source.defaultView.getComputedStyle(element),local=new DOMMatrixReadOnly(style.transform);expect(Math.abs(local.a-1)<0.00001&&Math.abs(local.d-1)<0.00001&&Math.abs(local.b)<0.00001&&Math.abs(local.c)<0.00001&&Number.parseFloat(style.zoom)===1,'a real control applies an additional scale instead of the common camera: '+element.className);}
 return scale;
};
const faithfulGlyphs=(doc,scope=doc)=>{
 const title=actualElement(scope,'.app-shell-title .title-bar'),paint=element=>doc.defaultView.getComputedStyle(element),slots=['navigation.menu','navigation.person','navigation.appearance','navigation.settings'];
 for(const slot of slots){const icon=actualElement(title,'[data-theme-icon-slot="'+slot+'"]'),glyphs=icon?actualElements(icon,'.theme-icon-glyph').filter(glyph=>paint(glyph).display!=='none'):[];expect(glyphs.length===1,'title bar loses its real icon or paints duplicate icon families: '+slot);const glyph=glyphs[0],content=doc.defaultView.getComputedStyle(glyph,'::before').content,font=paint(glyph).fontFamily;expect(glyph.getBoundingClientRect().width>0&&/Phosphor/i.test(font)&&doc.fonts.check('16px '+font)&&!['none','normal','""',"''"].includes(content),'title icon has no loaded glyph: '+slot);}
 const windowControls=actualElements(title,'.title-bar-window-controls svg');expect(windowControls.length===3&&windowControls.every(icon=>icon.querySelector('path,rect')),'window minimize, maximize or close icons are simplified away');expect(actualElements(title,'.title-bar-window-controls button').every(button=>button.disabled),'preview window actions remain enabled');
 const sidebar=actualElement(scope,'.side-menu'),navigationSlots={'主页':'navigation.home','搜索':'navigation.search','流媒体音乐':'navigation.streaming','音乐库':'navigation.songs','最近播放':'navigation.recent','插件市场':'navigation.plugin'};
 for(const row of navigationItems(scope)){const label=row.getAttribute('aria-label'),icon=row.querySelector('[data-theme-icon-slot="'+navigationSlots[label]+'"]');expect(icon,'sidebar entry loses its actual icon: '+label);if(sidebar.getBoundingClientRect().width>0){const glyphs=[...icon.querySelectorAll('.theme-icon-glyph')].filter(glyph=>paint(glyph).display!=='none');expect(glyphs.length===1&&glyphs[0].getBoundingClientRect().width>0,'expanded sidebar icon is not rendered: '+label);}}
 const regions=actualElements(scope,'[data-te-playbar-region]');expect(JSON.stringify(regions.map(region=>region.dataset.tePlaybarRegion))===JSON.stringify(['left','center','right']),'player does not retain its three actual layout regions');
 const controls=regions.flatMap(placedControls);expect(new Set(controls.map(control=>control.id)).size===controls.length,'player duplicates a placed control');
 for(const {id,element:control} of controls){
  if(id==='cover')expect(control.querySelector('.player-cover'),'real player artwork is missing');
  else if(id==='trackInfo')expect(control.textContent.includes('夜空中的旋律')&&control.textContent.includes('示例歌手'),'real player title or artist information missing');
  else if(id==='time')expect(control.textContent.trim()==='1:02/3:00','real player duration readout missing');
  else if(id==='transport')expect(JSON.stringify([...control.querySelectorAll('[data-playback-icon]')].map(icon=>icon.dataset.playbackIcon))===JSON.stringify(['previous','play','next']),'previous/play/next glyphs have been simplified or reordered');
  else if(id==='playPause')expect(control.querySelector('[data-playback-icon="play"]'),'standalone play glyph missing');
  else if(id==='playMode'){const glyph=control.querySelector('img');expect(glyph?.getAttribute('src')&&glyph.getBoundingClientRect().width>0,'play mode loses the actual sequential-playback asset');}
  else if(id==='desktopLyrics')expect(control.textContent.trim()==='词','desktop lyrics loses its actual compact glyph');
  else expect(control.querySelector('svg path,svg rect'),'player control has no actual glyph: '+id);
 }
 expect(scope.querySelector('.player-bar :is(.progress-track,.mini-progress-track,.compact-progress-track)'),'real player progress has been simplified away');
};
const isolatedBoundary=()=>{expect(Object.values(window.previewBoundary).every(value=>value===0),'real preview crosses its isolated boundary: '+JSON.stringify(window.previewBoundary));expect(window.previewErrors.length===0,'real preview produced an unhandled error: '+JSON.stringify(window.previewErrors));};
const realScene=doc=>{
 for(const element of [doc.documentElement,doc.body]){const paint=doc.defaultView.getComputedStyle(element);expect(paint.backgroundColor==='rgba(0, 0, 0, 0)'&&paint.backgroundImage==='none','preview document paints a flat stage behind the native window');}
 for(const pseudo of ['::before','::after'])expect(doc.defaultView.getComputedStyle(doc.body,pseudo).display==='none','preview document leaves an independent background decoration');
 const shell=doc.querySelector('.app-shell');expect(shell&&shell.inert,'real scene is not isolated');expect(!/PRIVATE_.*_SENTINEL|private-library-fixture|private-fixture[.]flac/.test(shell.outerHTML),'preview exposes private library, playback or profile attributes');expect(!shell.querySelector('.login-btn img')&&shell.querySelector('.login-btn').getAttribute('aria-label')==='流媒体登录'&&shell.querySelector('.login-btn').getAttribute('title')==='流媒体登录','preview title retains a live login label or avatar source');
 const home=shell.querySelector('.app-shell-content > .main-content > .online-home');expect(home&&!shell.querySelector('.home,.dashboard-wrapper'),'default appearance scene mounts a dashboard instead of the pure native home');
 const heroTitle=home.querySelector('.online-hero h2')?.textContent.trim(),recentTracks=home.querySelectorAll('.online-track').length,localCards=home.querySelectorAll('.home-local-card').length,hasLocalSection=!!home.querySelector('.home-local-section'),libraryEntries=home.querySelectorAll('.home-library-switch > button').length,providerSections=home.querySelectorAll('.online-discovery,.online-source-picker').length;
 expect(heroTitle==='夜空中的旋律'&&recentTracks===6&&providerSections===0,'pure home uses live data or loses its static local hero/recent props');if(hasLocalSection)expect(localCards===6&&libraryEntries===2,'upstream local/online home drops the supplied local sample or equal library entries');
 window.previewHome={component:'OnlineHome',heroTitle,recentTracks,localCards,hasLocalSection,libraryEntries,providerSections,network:window.previewBoundary.network};
 expect(shell.querySelector('.title-bar button')&&shell.querySelector('.menu-item')&&shell.querySelector('.online-home .online-hero')&&shell.querySelector('.player-bar .btn-play,.player-bar .mini-play-button'),'preview replaces a real window component with hand-drawn controls');
 const button=shell.querySelector('.title-bar button');button.focus();expect(doc.activeElement!==button&&doc.defaultView.getComputedStyle(doc.body).pointerEvents==='none','real preview accepts native input');
 for(const [id,selector] of Object.entries(moduleSelectors)){const module=doc.querySelector(selector);expect(module?.closest('[data-preview-module]')?.dataset.previewModule===(id==='card'?'background':id),'real module semantics missing: '+id)}
 faithfulGlyphs(doc,shell);
 const shapes=[...shell.querySelectorAll('[data-preview-shape]')];
 expect(shapes.length>0,'secondary copy is not masked in its real line box');for(const shape of shapes){expect(!shape.closest('.title-bar,.menu-item,.player-bar,.hero-title,.hero-artist'),'text masking covers a required icon or control');expect(Number.parseFloat(doc.defaultView.getComputedStyle(shape).borderTopLeftRadius)>0,'secondary copy mask has square corners');for(const pseudo of ['::before','::after'])expect(['none','normal','""',"''"].includes(doc.defaultView.getComputedStyle(shape,pseudo).content),'mask generated a visible text label');}isolatedBoundary();
};
const sourceLayout=doc=>{
 const rect=sourceGeometry(doc),root=doc.querySelector('.app-shell'),size=root.getBoundingClientRect();expect(Math.abs(size.width-doc.defaultView.innerWidth)<0.1&&Math.abs(size.height-doc.defaultView.innerHeight)<0.1,'real source shell has been laid out at thumbnail dimensions');
 for(const element of doc.querySelectorAll('.app-shell,.app-shell-title,.app-shell-navigation,.app-shell-content,.app-shell-player,.main-content'))expect(element.hasAttribute('data-v-fixture-app'),'App shell scope is not mirrored onto the real scene');
 expect(doc.querySelector('.app-shell-content > .main-content > .online-home'),'real home no longer shares the actual content shell');
 if(root.dataset.previewNavigation==='collapsed')expect(rect.navigation.width===0&&rect.navigation.height===0&&doc.defaultView.getComputedStyle(doc.querySelector('[data-preview-module="navigation"]')).display==='none','collapsed sidebar retains a visible rail');else expect(rect.navigation.width>0&&rect.navigation.top>=rect.material.top+rect.material.height&&rect.navigation.left>=0&&rect.navigation.left+rect.navigation.width<=doc.defaultView.innerWidth&&rect.navigation.top+rect.navigation.height<=doc.defaultView.innerHeight,'real sidebar is placed outside the source window: '+JSON.stringify({preset:doc.documentElement.dataset.tePresetLayout,navigation:rect.navigation,title:rect.material}));
 expect(rect.material.width===doc.defaultView.innerWidth&&rect.material.height===40,'real title strip is resized independently');
};
const colorChannels=color=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');expect(context,'fixture cannot read native contour colors');context.fillStyle=color;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data]};
const neutralContrast=(color,nextTone,opaque)=>{const channels=colorChannels(color),mean=(channels[0]+channels[1]+channels[2])/3;expect(Math.max(...channels.slice(0,3))-Math.min(...channels.slice(0,3))<16&&(nextTone==='dark'?mean>200:mean<100)&&(opaque?channels[3]===255:channels[3]>160&&channels[3]<200),'module contour lacks neutral contrast for '+nextTone+': '+JSON.stringify(channels))};
const rectArea=rect=>Math.max(0,rect.right-rect.left)*Math.max(0,rect.bottom-rect.top);
const intersection=(a,b)=>({left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)});
const projectedSourceRect=(host,rect)=>{const world=host.querySelector('.appearance-editor-world').getBoundingClientRect(),scale=Number(host.dataset.cameraScale);return {left:world.left+rect.left*scale,top:world.top+rect.top*scale,right:world.left+rect.right*scale,bottom:world.top+rect.bottom*scale};};
const sceneOpacity=element=>{let opacity=1;for(let current=element;current&&current!==element.ownerDocument.documentElement;current=current.parentElement)opacity*=Number(element.ownerDocument.defaultView.getComputedStyle(current).opacity);return opacity;};
let workshopOriginal,workshopHostStyles=[],workshopDrag;
const workshopScenes=[
 {surface:'dashboard',tone:'dark',width:1180,state:'normal',selector:'.dashboard-wrapper'},
 {surface:'library',tone:'pureWhite',width:640,state:'empty',selector:'.song-list'},
 {surface:'streaming',tone:'dark',width:760,state:'loading',selector:'.music-home'},
 {surface:'streaming-list',tone:'pureWhite',width:1180,state:'selected',selector:'.streaming-content:not(:has(.music-home))'},
 {surface:'settings',tone:'pureWhite',width:640,state:'done',selector:'.settings-preview-page'},
 {surface:'player',tone:'dark',width:1180,state:'listening',selector:'.settings-preview-page'}
];
const workshopContext=()=>{const host=document.querySelector('.appearance-window-preview'),frame=host.querySelector('iframe'),doc=frame.contentDocument;return {host,frame,doc,source:doc.querySelector('body > .appearance-preview-scene')};};
const workshopPoint=node=>{const {host}=workshopContext(),rect=projectedSourceRect(host,node.getBoundingClientRect());return {x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2};};
const workshopSnapshot=()=>{const {host,doc,source}=workshopContext(),model=workshopModel.value,paint=doc.defaultView.getComputedStyle(doc.documentElement),background=source.querySelector(':scope > .appearance-window-background'),decoration=source.querySelector(':scope > .workshop-decoration'),probe=decoration?.children[1],style=element=>element?doc.defaultView.getComputedStyle(element):null;return {scene:{...model.scene},view:host.dataset.previewView,frames:document.querySelectorAll('iframe').length,sourceWidth:doc.defaultView.innerWidth,sourceHeight:doc.defaultView.innerHeight,sourceVisibility:source.style.visibility,layerCount:doc.querySelectorAll('.appearance-layer-view [data-appearance-layer]').length,canvasScale:Number(host.dataset.cameraScale),appColor:paint.getPropertyValue('--te-app-bg').trim(),primary:paint.getPropertyValue('--te-primary-500').trim(),appDecoration:{backgroundZ:style(background)?.zIndex,decorationZ:style(decoration)?.zIndex,probeDisplay:style(probe)?.display,probeFill:style(probe)?.backgroundImage,probeOpacity:style(probe)?.opacity,probeRect:probe?probe.getBoundingClientRect().toJSON():null},bodyClasses:doc.body.className,overlay:!!host.querySelector('.workshop-canvas-overlay'),interactive:host.querySelector('iframe').getAttribute('aria-hidden')==='false',boundary:{...window.previewBoundary}};};
const setWorkshopScene=async(scene,editing=false)=>{const current=workshopModel.value;workshopModel.value={...current,scene:{tone:scene.tone,surface:scene.surface,width:scene.width,state:scene.state},canvasEditing:editing,checking:false};focused.value='overview';await settle();preview.value.fitPart();await settle();await waitFor(()=>{const {host,doc,source}=workshopContext();return source?.dataset.workshopState===scene.state&&doc.documentElement.dataset.theme===scene.tone&&Number(host.dataset.sourceWidth)===scene.width;},'shared workshop scene did not commit its latest surface, state, tone and width');};
window.fixture={
 async backgroundOwnership(){
  const original={draft:JSON.stringify(draft),tone:tone.value,themeEditing:themeEditing.value,hostStyle:document.documentElement.style.cssText,hostTheme:document.documentElement.dataset.theme},stats={inheritedCases:0,exactColor:false,savedImageTuning:false,themeEditingNeutral:false,draftUnchanged:false};
  const doc=document.querySelector('.appearance-window-preview iframe').contentDocument,root=doc.documentElement;
  const paint=()=>doc.defaultView.getComputedStyle(root),wallpaper=()=>doc.querySelector('body > .appearance-preview-scene > .appearance-window-background');
  const neutral=()=>expect(paint().getPropertyValue('--appearance-blur').trim()==='0px'&&paint().getPropertyValue('--appearance-brightness').trim()==='100%'&&paint().getPropertyValue('--appearance-dim').trim()==='0'&&paint().getPropertyValue('--appearance-scale').trim()==='1','non-image background retains saved image tuning');
  const themeOwned=()=>{neutral();expect(root.dataset.teAppCustomBackground==='off'&&root.dataset.teLocalCustomBackground==='off'&&root.dataset.teLocalTextTone==='theme'&&root.dataset.teLocalImagePalette==='off','theme/default/empty background retains a custom background or foreground override');expect(doc.defaultView.getComputedStyle(wallpaper()).backgroundColor==='rgba(0, 0, 0, 0)'&&doc.defaultView.getComputedStyle(wallpaper().querySelector('.app-background-dim')).display==='none','theme background is covered by a second preview painter');expect(paint().getPropertyValue('--te-app-bg').trim()==='#aabbcc'&&paint().getPropertyValue('--te-local-bg').trim()==='#ddeeff','theme/default preview inherits the host confirmed background instead of its theme baseline')};
  try{
   tone.value='light';themeEditing.value=false;document.documentElement.dataset.theme='pureWhite';for(const [name,value]of Object.entries({'--te-app-bg':'#543210','--te-local-bg':'#654321','--te-theme-app-bg':'#aabbcc','--te-theme-local-bg':'#ddeeff'}))document.documentElement.style.setProperty(name,value);
   for(const kind of ['default','theme','empty-image']){
    draft.appBackground=normalizeAppBackgroundSettings(null);const bg=draft.appBackground.global;Object.assign(bg,{kind:kind==='default'?'color':kind==='theme'?'theme':'image',customized:kind!=='default',image:kind==='theme'?'background://panel-skin.png':''});Object.assign(bg.effects.light,{blur:5,brightness:67,dim:16,scale:1.3,textTone:'light'});await settle();themeOwned();stats.inheritedCases++;
   }
   const bg=draft.appBackground.global;Object.assign(bg,{kind:'color',customized:true,light:'#f4f4f7',image:'background://panel-skin.png'});const savedEffects=JSON.stringify(bg.effects.light);await settle();neutral();expect(root.dataset.teLocalCustomBackground==='on'&&paint().getPropertyValue('--te-app-bg').trim()==='#f4f4f7'&&doc.defaultView.getComputedStyle(wallpaper()).backgroundColor==='rgb(244, 244, 247)','selected solid color is tinted, replaced or treated as an image');stats.exactColor=true;
   bg.kind='image';await settle();await waitFor(()=>wallpaper().dataset.backgroundImageState==='ready','valid wallpaper never finishes loading');expect(paint().getPropertyValue('--appearance-dim').trim()==='0.16'&&paint().getPropertyValue('--appearance-blur').trim()==='5px'&&JSON.stringify(bg.effects.light)===savedEffects,'switching back to an image loses its saved image effects');stats.savedImageTuning=true;
   themeEditing.value=true;await settle();themeOwned();stats.themeEditingNeutral=true;
  }finally{document.documentElement.style.cssText=original.hostStyle;document.documentElement.dataset.theme=original.hostTheme;Object.assign(draft,JSON.parse(original.draft));tone.value=original.tone;themeEditing.value=original.themeEditing;await settle();stats.draftUnchanged=JSON.stringify(draft)===original.draft;expect(stats.draftUnchanged,'background preview verification changes the saved draft');}
  window.previewBackgroundOwnership=stats;
 },
 async beginSkin(){
  window.skinOriginal={layers:draft.appearanceLayers?JSON.parse(JSON.stringify(draft.appearanceLayers)):undefined,tone:tone.value,focus:focused.value,angles:{...preview.value.viewAngles},zoom:preview.value.getCameraZoom().zoom,layered:preview.value.layeredView,motion:document.documentElement.getAttribute('data-te-motion'),mode:window.previewSettings.value.playerBar.mode};
  document.documentElement.dataset.teMotion='off';focused.value='overview';preview.value.setLayeredView(false);window.previewSettings.value.playerBar.mode='standard';draft.appearanceLayers=normalizeAppearanceLayers(undefined);await settle();
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument,bar=doc.querySelector('body > .appearance-preview-scene .player-bar');
  window.skinBounds=()=>{const r=bar.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,buttons:bar.querySelectorAll('button').length,text:bar.textContent}};window.skinBaseline=window.skinBounds();
  expect(window.skinBaseline.width>=doc.defaultView.innerWidth*.4,'native standard player has collapsed before any skin is applied: '+JSON.stringify(window.skinBaseline));
  for(const nextTone of ['light','dark'])Object.assign(draft.appearanceLayers.scopes['player-bar'][nextTone].skin,{enabled:true,image:'background://panel-skin.png',opacity:100,fit:'fill',frame:{top:20,right:10,bottom:20,left:10}});
  await settle();try{await waitFor(()=>bar.dataset.teAppearanceSkin==='player-bar','real PNG skin never reaches the native player body')}catch(error){const r=bar.getBoundingClientRect(),style=doc.defaultView.getComputedStyle(bar);throw Error(error.message+' '+JSON.stringify({connected:bar.isConnected,same:bar===doc.querySelector('body > .appearance-preview-scene .player-bar'),marker:bar.dataset,style:bar.style.cssText,hidden:doc.hidden,body:doc.body.dataset,visibility:style.visibility,display:style.display,pointer:style.pointerEvents,hit:doc.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.className,rootInert:doc.querySelector('.appearance-preview-scene').inert,sheet:[...doc.querySelectorAll('style[data-appearance-layers]')].map(style=>style.textContent),settings:draft.appearanceLayers.scopes['player-bar']}))}
 },
 async skinCase(nextTone,layered,update=false){
  tone.value=nextTone;focused.value='overview';preview.value.setLayeredView(layered);preview.value.setViewAngles(layered?{x:8,y:-22}:{x:0,y:0});preview.value.fitPart();await settle();await settle();
  const host=document.querySelector('.appearance-window-preview'),frame=host.querySelector('iframe'),doc=frame.contentDocument,source=doc.querySelector('body > .appearance-preview-scene'),sourceBar=source.querySelector('.player-bar');
  const getOverflow=()=>layered?doc.querySelector('.appearance-layer-view [data-appearance-layer-scene] > [data-appearance-skin-plane="player"] > .te-appearance-skin-overflow[data-appearance-scope="player-bar"]'):doc.querySelector('body > .te-appearance-effects > .te-appearance-skin-overflow[data-appearance-scope="player-bar"]');
  await waitFor(()=>!!getOverflow(),'PNG overflow is absent in '+(layered?'3D':'2D'));
  const oldTop=sourceBar.style.getPropertyValue('--te-skin-top');
  if(update){Object.assign(draft.appearanceLayers.scopes['player-bar'][nextTone].skin,{image:'background://panel-skin-'+nextTone+'.png',frame:{top:30,right:10,bottom:20,left:10}});await settle();await settle();await waitFor(()=>sourceBar.style.getPropertyValue('--te-skin-top')!==oldTop&&sourceBar.style.getPropertyValue('--te-skin-image').includes('panel-skin-'+nextTone+'.png'),'hidden 3D source loses delayed image and live UV updates');await waitFor(()=>!!getOverflow(),'new PNG loads into the hidden native source but never reaches its 3D overflow plane');await settle()}
  const overflow=getOverflow(),copy=layered?doc.querySelector('.appearance-layer-view [data-appearance-layer="player"] .player-bar'):sourceBar,plane=overflow.parentElement;
  expect(copy.dataset.teAppearanceSkin==='player-bar'&&doc.defaultView.getComputedStyle(copy).backgroundImage.includes('background://panel-skin'),'PNG is a sticker instead of the native component background');
  expect(!source.querySelector('button[data-te-appearance-skin]'),'component skin was stamped onto all buttons');
  const current=window.skinBounds();expect(JSON.stringify(current)===JSON.stringify(window.skinBaseline),'skin changes native player dimensions, text or controls: '+JSON.stringify({nextTone,layered,update,current,baseline:window.skinBaseline}));
  expect(copy.offsetWidth===sourceBar.offsetWidth&&copy.offsetHeight===sourceBar.offsetHeight,'3D native player copy changes its original component dimensions');
  expect(doc.defaultView.getComputedStyle(overflow).pointerEvents==='none'&&overflow.inert&&overflow.getAttribute('aria-hidden')==='true','overflow can intercept real controls');
  let samePlane=true;
  if(layered){
   const nativePlane=doc.querySelector('.appearance-layer-view [data-appearance-layer="player"]');samePlane=plane.dataset.appearanceSkinPlane==='player'&&plane.style.transform===nativePlane.style.transform;expect(samePlane&&!nativePlane.contains(overflow),'3D overflow is clipped inside its native region or does not follow its plane');
   expect(doc.defaultView.getComputedStyle(plane).overflow==='visible','3D overflow sheet clips transparent edges');
   const shell=doc.querySelector('.appearance-layer-view [data-appearance-layer="outer"]');expect(shell.style.left==='0px'&&shell.style.top==='0px'&&parseFloat(shell.style.width)===doc.defaultView.innerWidth&&parseFloat(shell.style.height)===doc.defaultView.innerHeight,'outer shell does not include the title strip');
   expect(shell.style.transform!==doc.querySelector('.appearance-layer-view [data-appearance-layer="content"]').style.transform,'inner and outer share one repeated background plane');
   expect(!doc.querySelector('body > .te-appearance-effects > .te-appearance-skin-overflow'),'3D also paints a viewport-fixed skin portal');
   expect(copy.style.getPropertyValue('--te-skin-top')===sourceBar.style.getPropertyValue('--te-skin-top'),'3D clone shows an obsolete UV frame');
   expect(copy.style.getPropertyValue('--te-skin-image')===sourceBar.style.getPropertyValue('--te-skin-image'),'3D clone keeps a previous image after the new PNG finishes loading');
  }
  const probe=doc.createElement('i');probe.style.cssText='position:absolute;width:0;height:0;left:'+parseFloat(overflow.style.width)/2+'px;top:'+(-parseFloat(copy.style.getPropertyValue('--te-skin-top'))/2)+'px';overflow.append(probe);
  const p=probe.getBoundingClientRect(),f=frame.getBoundingClientRect(),scale=f.width/doc.defaultView.innerWidth,point={x:f.left+p.left*scale,y:f.top+p.top*scale};probe.remove();
  expect(point.x>1&&point.y>1&&point.x<innerWidth-1&&point.y<innerHeight-1,'skin paint sample is outside the actual captured viewport');
  window.skinOverflow=overflow;
  const hit=host.querySelector('[data-region="player-bar"]'),r=hit.getBoundingClientRect();let hitPoint;
  for(const fx of [.5,.25,.75,.1,.9])for(const fy of [.5,.2,.8]){const candidate={x:r.left+r.width*fx,y:r.top+r.height*fy};if(!hitPoint&&hit.contains(document.elementFromPoint(candidate.x,candidate.y)))hitPoint=candidate}
  expect(!!hitPoint,'no real preview player hit target remains reachable around the camera rulers');
  return {tone:nextTone,layered,update,point,hit:hitPoint,samePlane,nativeBoundsPreserved:true,uvTop:copy.style.getPropertyValue('--te-skin-top'),overflow:{left:overflow.style.left,top:overflow.style.top,width:overflow.style.width,height:overflow.style.height},bodyBackground:doc.defaultView.getComputedStyle(copy).backgroundImage,nativeSize:{width:sourceBar.offsetWidth,height:sourceBar.offsetHeight},copySize:{width:copy.offsetWidth,height:copy.offsetHeight}};
 },
 async beginOuterSkin(){
  for(const nextTone of ['light','dark']){
   draft.appearanceLayers.scopes['player-bar'][nextTone].skin.enabled=false;
   Object.assign(draft.appearanceLayers.scopes['outer-panel'][nextTone].skin,{enabled:true,image:'background://panel-skin.png',opacity:100,fit:'fill',frame:{top:20,right:10,bottom:20,left:10}});
  }
  preview.value.setLayeredView(false);focused.value='overview';await settle();await settle();
 },
 async outerSkinCase(nextTone,layered){
  tone.value=nextTone;focused.value='overview';preview.value.setLayeredView(layered);preview.value.setViewAngles(layered?{x:8,y:-22}:{x:0,y:0});preview.value.fitPart();await settle();await settle();
  const {host,frame,doc,source}=workshopContext();await waitFor(()=>source.dataset.teAppearanceSkin==='outer-panel','whole-window PNG never reaches the actual preview shell');
  const group=doc.querySelector('.appearance-layer-view [data-appearance-layer-scene]'),surface=layered?group.querySelector(':scope > [data-appearance-layer="outer"]'):source;
  expect(surface.dataset.teAppearanceSkin==='outer-panel'&&doc.defaultView.getComputedStyle(surface).backgroundImage.includes('background://panel-skin.png'),'outer layer is not the actual shell skin');
  const rootTransparent=!layered||doc.defaultView.getComputedStyle(group).backgroundImage==='none';expect(rootTransparent,'rotation group paints a second screen-level shell image');
  const title=layered?group.querySelector(':scope > [data-appearance-layer="title"] .title-bar'):source.querySelector('.title-bar');
  const points=[...([100,doc.defaultView.innerWidth*.5,doc.defaultView.innerWidth-100].map(x=>['title',x,20])),...([2,doc.defaultView.innerWidth-2].flatMap(x=>[.3,.55,.8].map(y=>['edge',x,doc.defaultView.innerHeight*y])))],f=frame.getBoundingClientRect(),scale=f.width/doc.defaultView.innerWidth,samples=[];
  for(const [name,x,y]of points){const probe=doc.createElement('i');probe.style.cssText='position:absolute;width:0;height:0;left:'+x+'px;top:'+y+'px';surface.append(probe);const r=probe.getBoundingClientRect();probe.remove();samples.push({name,point:{x:f.left+r.left*scale,y:f.top+r.top*scale}})}
  window.outerSkinSurface=surface;window.outerSkinStyle={value:surface.style.getPropertyValue('background-image'),priority:surface.style.getPropertyPriority('background-image')};
  const paint=doc.defaultView.getComputedStyle(surface),nativePaint=doc.defaultView.getComputedStyle(source),overflowPlane=group?.querySelector(':scope > [data-appearance-skin-plane="outer"]');
  expect(!layered||overflowPlane?.style.transform===surface.style.transform,'whole-window PNG overflow does not follow the outer shell plane');
  return {tone:nextTone,layered,rootTransparent,samples,titleBackground:doc.defaultView.getComputedStyle(title).backgroundColor,wallpaperClip:doc.defaultView.getComputedStyle((layered?group:source).querySelector(':scope > .appearance-window-background')).clipPath,outerRect:{width:parseFloat(surface.style.width)||source.offsetWidth,height:parseFloat(surface.style.height)||source.offsetHeight},paint:{position:paint.backgroundPosition,size:paint.backgroundSize,nativePosition:nativePaint.backgroundPosition,nativeSize:nativePaint.backgroundSize}};
 },
 async beginInnerSkin(){
  preview.value.setLayeredView(false);focused.value='overview';
  for(const nextTone of ['light','dark']){
   draft.appearanceLayers.scopes['outer-panel'][nextTone].skin.enabled=false;
   Object.assign(draft.appearanceLayers.scopes['inner-panel'][nextTone].skin,{enabled:true,image:'background://panel-skin.png',opacity:100,fit:'fill',frame:{top:20,right:10,bottom:20,left:10}});
  }
  await settle();await settle();
 },
 async innerSkinCase(nextTone,layered){
  tone.value=nextTone;focused.value='overview';preview.value.setLayeredView(layered);preview.value.setViewAngles(layered?{x:8,y:-22}:{x:0,y:0});preview.value.fitPart();await settle();await settle();
  const {frame,doc,source}=workshopContext(),native=source.querySelector('.app-shell-content');await waitFor(()=>native.dataset.teAppearanceSkin==='inner-panel','independent inner-panel skin never reaches native rounded content');
  const group=doc.querySelector('.appearance-layer-view [data-appearance-layer-scene]'),surface=layered?group.querySelector(':scope > [data-appearance-layer="content"]'):native,overflowPlane=group?.querySelector(':scope > [data-appearance-skin-plane="content"]'),samePlane=!layered||overflowPlane?.style.transform===surface.style.transform;
  expect(surface.dataset.teAppearanceSkin==='inner-panel'&&doc.defaultView.getComputedStyle(surface).backgroundImage.includes('background://panel-skin.png'),'inner-panel has been remapped to a duplicate whole-window wallpaper');
  expect(!source.hasAttribute('data-te-appearance-skin')&&(!layered||surface.style.transform!==group.querySelector(':scope > [data-appearance-layer="outer"]').style.transform),'inner-panel changes the full-window shell skin or shares its physical plane');
  expect(surface.offsetWidth===native.offsetWidth&&surface.offsetHeight===native.offsetHeight&&samePlane,'inner-panel skin changes dimensions or detaches its overflow from the content plane');
  const probe=doc.createElement('i');probe.style.cssText='position:absolute;width:0;height:0;left:'+surface.offsetWidth*.55+'px;top:20px';surface.append(probe);const r=probe.getBoundingClientRect(),f=frame.getBoundingClientRect(),scale=f.width/doc.defaultView.innerWidth;probe.remove();
  window.outerSkinSurface=surface;window.outerSkinStyle={value:surface.style.getPropertyValue('background-image'),priority:surface.style.getPropertyPriority('background-image')};
  return {tone:nextTone,layered,samePlane,nativeBoundsPreserved:true,point:{x:f.left+r.left*scale,y:f.top+r.top*scale},size:{width:native.offsetWidth,height:native.offsetHeight},radius:doc.defaultView.getComputedStyle(surface).borderRadius};
 },
 async hideOuterSkin(hidden){
  const element=window.outerSkinSurface,style=window.outerSkinStyle;
  if(hidden)element.style.setProperty('background-image','none','important');else if(style.value)element.style.setProperty('background-image',style.value,style.priority);else element.style.removeProperty('background-image');
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 },
 async hideSkinOverflow(hidden){window.skinOverflow.style.visibility=hidden?'hidden':'';await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))},
 async finishSkin(){
  const original=window.skinOriginal;preview.value.setLayeredView(false);if(original.layers)draft.appearanceLayers=original.layers;else delete draft.appearanceLayers;tone.value=original.tone;window.previewSettings.value.playerBar.mode=original.mode;preview.value.setViewAngles(original.angles);preview.value.setCameraZoom(original.zoom);focused.value=original.focus;preview.value.setLayeredView(original.layered);if(original.motion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.dataset.teMotion=original.motion;await settle();
 },
 async beginIconPreview(){
  window.iconOriginal={focus:focused.value,layered:preview.value.layeredView,angles:{...preview.value.viewAngles},motion:document.documentElement.getAttribute('data-te-motion')};document.documentElement.dataset.teMotion='off';focused.value='overview';preview.value.setLayeredView(true);preview.value.setViewAngles({x:8,y:-22});preview.value.fitPart();await settle();await settle();
  window.iconStyles=()=>JSON.stringify({root:document.documentElement.style.cssText,head:[...document.head.querySelectorAll('style,link[rel="stylesheet"]')].map(node=>node.outerHTML)});window.iconStylesBefore=window.iconStyles();const bar=workshopContext().source.querySelector('.player-bar');window.iconSizeBefore={width:bar.offsetWidth,height:bar.offsetHeight};
 },
 async iconPreviewCase(phase){
  const binding=phase==='first'?'first':'second',assetPath='icons/'+binding+'.png';setThemeIconProfile(phase==='clear'?null:normalizeThemeProfile({schemaVersion:2,id:'user:preview-icon-probe',name:'Preview icons',overrides:{},modes:{},assets:[{id:'first',type:'image',path:'icons/first.png'},{id:'second',type:'image',path:'icons/second.png'}],iconBindings:{'navigation.home':binding,'playback.play':binding}}));
  const {host,frame,doc,source}=workshopContext(),selectors=['[data-theme-icon-slot="navigation.home"]','[data-theme-icon-slot="playback.play"]'];
  const matches=(scope,custom)=>selectors.every(selector=>{const node=actualElement(scope,selector);if(!node)return false;const image=node.querySelector('img,image');return custom?node.hasAttribute('data-theme-icon-custom')&&image&&(image.getAttribute('src')||image.getAttribute('href')).endsWith(assetPath):!node.hasAttribute('data-theme-icon-custom')&&!image});
  await waitFor(()=>matches(source,phase!=='clear'),'real native icons do not reflect the controlled lightweight theme bridge');
  await waitFor(()=>matches(doc.querySelector('[data-appearance-layer-scene]'),phase!=='clear'),'3D stays open but retains a stale icon after an image-only bridge change');
  if(phase!=='clear'){
   for(const selector of selectors){const image=actualElement(doc.querySelector('[data-appearance-layer-scene]'),selector).querySelector('img');if(image)await image.decode();}
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  }
  const copy=actualElement(doc.querySelector('[data-appearance-layer-scene]'),selectors[0]),bar=source.querySelector('.player-bar'),r=copy.getBoundingClientRect(),f=frame.getBoundingClientRect(),scale=f.width/doc.defaultView.innerWidth;
  const sameStyles=window.iconStyles()===window.iconStylesBefore,sameSize=JSON.stringify(window.iconSizeBefore)===JSON.stringify({width:bar.offsetWidth,height:bar.offsetHeight}),layered=host.dataset.previewView==='layered';expect(sameStyles&&sameSize&&layered,'image binding changes CSS, native player geometry or closes the layered view');
  return {phase,sameStyles,sameSize,layered,slots:selectors.length,point:{x:f.left+(r.left+r.width/2)*scale,y:f.top+(r.top+r.height/2)*scale},color:phase==='first'?[21,116,76]:[40,120,220]};
 },
 async finishIconPreview(){
  setThemeIconProfile(null);const original=window.iconOriginal;focused.value=original.focus;preview.value.setLayeredView(original.layered);preview.value.setViewAngles(original.angles);if(original.motion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.dataset.teMotion=original.motion;await settle();
 },
 async pointerBoundaries(){
  const root=document.documentElement,original={attributes:new Map([...root.attributes].map(attribute=>[attribute.name,attribute.value])),focused:focused.value,layered:preview.value.layeredView,angles:{...preview.value.viewAngles},zoom:preview.value.getCameraZoom().zoom,floating:floatingEnabled.value,active:previewActive.value,draft:JSON.stringify(draft),settings:JSON.stringify(window.previewSettings.value)};
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument,source=doc.querySelector('body > .appearance-preview-scene'),group=()=>doc.querySelector('[data-appearance-layer-scene]');
  const nativeClone=Node.prototype.cloneNode,nativeChildClone=doc.defaultView.Node.prototype.cloneNode,nativeRect=Element.prototype.getBoundingClientRect,nativeChildRect=doc.defaultView.Element.prototype.getBoundingClientRect,nativeRequest=window.requestAnimationFrame,nativeCancel=window.cancelAnimationFrame;
  let clones=0,sourceMeasures=0,sourceWrites=0,rootWrites=0,poseWrites=0;const pending=new Set(),stats={outsideEdges:0,returnTimes:[],immediateCases:0,lifecycleCases:0},observers=[];
  const sleep=time=>new Promise(resolve=>setTimeout(resolve,time));let clearAuto,clearTop;
  try{
   root.dataset.teMotion='full';focused.value='card';floatingEnabled.value=true;preview.value.setLayeredView(true);preview.value.setViewAngles({x:17,y:-29});preview.value.setCameraZoom(1.3);await settle();await settle();clearAuto=installAutoHideScrollbars();clearTop=installScrollToTopButton();await settle();
   const ready=()=>group()&&previewViewReady(host,true)&&host.classList.contains('has-motion');
   await waitFor(ready,'boundary fixture never settles its layered view');
   const area=host.getBoundingClientRect(),basis=group().style.transform,angles=JSON.stringify(preview.value.viewAngles),zoom=preview.value.getCameraZoom().zoom;
   const dispatch=(type,point,target=host)=>target.dispatchEvent(new PointerEvent(type,{pointerId:77,pointerType:'mouse',clientX:point?.x??area.right-10,clientY:point?.y??area.top+10,bubbles:type!=='pointerenter'&&type!=='pointerleave'}));
   // Offscreen rAF can arrive after a wall-clock delay; observe the actual pose.
   const enter=async()=>{await waitFor(ready,'boundary fixture never settles its layered view');dispatch('pointerenter');await waitFor(()=>group()&&group().style.transform!==basis,'boundary fixture never applies real mouse feedback')};
   Node.prototype.cloneNode=function(deep){if(this===source)clones++;return nativeClone.call(this,deep)};doc.defaultView.Node.prototype.cloneNode=function(deep){if(this===source)clones++;return nativeChildClone.call(this,deep)};
   Element.prototype.getBoundingClientRect=function(){if(this.ownerDocument===doc&&source.contains(this))sourceMeasures++;return nativeRect.call(this)};doc.defaultView.Element.prototype.getBoundingClientRect=function(){if(source.contains(this))sourceMeasures++;return nativeChildRect.call(this)};
   window.requestAnimationFrame=callback=>{const handle=nativeRequest.call(window,time=>{pending.delete(handle);callback(time)});pending.add(handle);return handle};window.cancelAnimationFrame=handle=>{pending.delete(handle);nativeCancel.call(window,handle)};
   const rootObserver=new MutationObserver(records=>rootWrites+=records.length);rootObserver.observe(root,{attributes:true});observers.push(rootObserver);
   const sceneObserver=new MutationObserver(records=>{sourceWrites+=records.filter(record=>source.contains(record.target)).length;poseWrites+=records.filter(record=>record.target===group()&&record.attributeName==='style').length});sceneObserver.observe(doc.body,{attributes:true,subtree:true,childList:true,characterData:true});observers.push(sceneObserver);
   for(const point of [{x:area.left-1,y:area.top+20},{x:area.right+1,y:area.top+20},{x:area.left+20,y:area.top-1},{x:area.left+20,y:area.bottom+1}]){
    await enter();const started=performance.now();dispatch('pointermove',point);await waitFor(()=>group().style.transform===basis,'outside coordinate remains clamped to a mouse edge');stats.returnTimes.push(performance.now()-started);expect(JSON.stringify(preview.value.viewAngles)===angles&&preview.value.getCameraZoom().zoom===zoom,'leaving the canvas resets the user angle or zoom');stats.outsideEdges++;
   }
   dispatch('pointerenter');await sleep(30);dispatch('pointerleave');await sleep(30);dispatch('pointerenter',{x:area.left+10,y:area.bottom-10});await sleep(30);dispatch('pointerleave');await waitFor(()=>group().style.transform===basis,'rapid reentry retains a previous edge');stats.rapidReentry=true;
   const immediate=async(action,label)=>{await enter();dispatch('pointermove',{x:area.left+10,y:area.bottom-10});action();expect(group().style.transform===basis,label+' does not clear current and queued mouse feedback immediately');await sleep(170);expect(group().style.transform===basis,label+' replays a late pointer frame');stats.immediateCases++};
   await immediate(()=>dispatch('pointercancel'),'pointer cancellation');
   await immediate(()=>window.dispatchEvent(new Event('blur')),'window blur');
   const tools=host.querySelector('[data-appearance-floating-tools]'),ruler=host.querySelector('.appearance-view-angle-controls');
   await immediate(()=>dispatch('pointerenter',undefined,tools),'floating tool entry');
   await immediate(()=>tools.querySelector('input').focus(),'floating input focus');
   await immediate(()=>dispatch('pointerenter',undefined,ruler),'camera ruler entry');
   await immediate(()=>host.querySelector('[aria-label="相机缩放"]').focus(),'camera ruler focus');
   await enter();dispatch('pointerleave');await waitFor(()=>group().style.transform===basis,'last leave does not return to the base pose');await sleep(30);const still=poseWrites;await sleep(180);await nextTick();stats.idleWrites=poseWrites-still;stats.pendingFrames=pending.size;
   Object.assign(stats,{exitClones:clones,exitSourceMeasures:sourceMeasures,exitSourceWrites:sourceWrites,exitRootWrites:rootWrites});expect(clones===0&&sourceMeasures===0&&sourceWrites===0&&rootWrites===0&&pending.size===0&&stats.idleWrites===0,'pointer boundaries rebuild, mutate or measure the native scene, or retain idle frames: '+JSON.stringify(stats));
   clones=0;sourceMeasures=0;for(let index=0;index<8;index++){for(const name of ['te-auto-scrollbar','is-scrollbar-near','is-scrollbar-active'])root.classList.toggle(name);await new Promise(resolve=>nativeRequest.call(window,resolve));}await settle();stats.scrollPresentationClones=clones;stats.scrollPresentationMeasures=sourceMeasures;stats.scrollPresentationRootWrites=rootWrites;expect(clones===0&&sourceMeasures===0&&group().style.transform===basis,'transient scrollbar affordances rebuild the 3D scene after leave');
   clones=0;stats.publicAttributeCases=0;
   root.classList.add('fixture-plugin-public-class');await settle();expect(doc.documentElement.classList.contains('fixture-plugin-public-class'),'unknown plugin root class does not reach the preview');stats.publicAttributeCases++;
   root.dataset.fixturePublicTheme='updated';await settle();expect(doc.documentElement.dataset.fixturePublicTheme==='updated','unknown public theme data attribute does not reach the preview');stats.publicAttributeCases++;
   root.style.setProperty('--te-fixture-public-color','#435261');await settle();expect(doc.documentElement.style.getPropertyValue('--te-fixture-public-color')==='#435261','public theme CSS variable does not reach the preview');stats.publicAttributeCases++;stats.publicAttributeClones=clones;expect(clones===3,'real public theme attributes are incorrectly filtered or rebuild more than once: '+clones);
   clones=0;root.setAttribute('class',root.getAttribute('class'));root.setAttribute('style',root.getAttribute('style'));root.setAttribute('data-fixture-public-theme','updated');await settle();stats.noDifferenceClones=clones;expect(clones===0,'identical root attributes trigger a scene reconstruction');
   for(const mode of ['hidden','inactive','flat']){
    await enter();dispatch('pointermove',{x:area.left+10,y:area.bottom-10});if(mode==='hidden')root.dataset.teVisibility='hidden';else if(mode==='inactive')previewActive.value=false;else preview.value.setLayeredView(false);await nextTick();await waitFor(()=>!doc.querySelector('.appearance-layer-view')&&pending.size===0,'suspended '+mode+' view keeps a layered scene or pointer frames');
    if(mode==='flat')await waitForPreviewView(host,'flat suspension never finishes its view transition',false);
    if(mode==='hidden')root.dataset.teVisibility='visible';else if(mode==='inactive')previewActive.value=true;else preview.value.setLayeredView(true);await settle();await settle();await waitFor(ready,'resumed '+mode+' view never settles its layered presentation');expect(group().style.transform===basis&&JSON.stringify(preview.value.viewAngles)===angles&&preview.value.getCameraZoom().zoom===zoom,'resume restores stale mouse feedback or changes the base pose: '+mode);stats.lifecycleCases++;
   }
   Object.assign(stats,{baseAnglesPreserved:JSON.stringify(preview.value.viewAngles)===angles,zoomPreserved:preview.value.getCameraZoom().zoom===zoom,draftSettingsPreserved:JSON.stringify(draft)===original.draft&&JSON.stringify(window.previewSettings.value)===original.settings});window.previewPointerBoundaries=stats;isolatedBoundary();
  }finally{
   for(const observer of observers)observer.disconnect();Node.prototype.cloneNode=nativeClone;doc.defaultView.Node.prototype.cloneNode=nativeChildClone;Element.prototype.getBoundingClientRect=nativeRect;doc.defaultView.Element.prototype.getBoundingClientRect=nativeChildRect;window.requestAnimationFrame=nativeRequest;window.cancelAnimationFrame=nativeCancel;clearAuto?.();clearTop?.();previewActive.value=original.active;floatingEnabled.value=original.floating;preview.value.setLayeredView(original.layered);preview.value.setViewAngles(original.angles);preview.value.setCameraZoom(original.zoom);focused.value=original.focused;for(const attribute of [...root.attributes])if(!original.attributes.has(attribute.name))root.removeAttribute(attribute.name);for(const [name,value]of original.attributes)root.setAttribute(name,value);await settle();await settle();await waitForPreviewView(host,'boundary cleanup leaves its original view unsettled',original.layered);
  }
 },
 async prepareBoundaryCapture(kind){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument;window.boundaryCapture={kind,original:{motion:document.documentElement.getAttribute('data-te-motion'),angles:{...preview.value.viewAngles},zoom:preview.value.getCameraZoom().zoom,layered:preview.value.layeredView,focused:focused.value},draft:JSON.stringify(draft),settings:JSON.stringify(window.previewSettings.value)};document.documentElement.dataset.teMotion='full';focused.value='overview';preview.value.setLayeredView(true);preview.value.setViewAngles({x:17,y:-29});preview.value.setCameraZoom(1.3);await settle();await settle();
  await waitForPreviewView(host,'native boundary capture starts before its layered view and camera settle',true);
  const state=window.boundaryCapture,area=host.getBoundingClientRect();state.basis='perspective(2400px) rotateX(17deg) rotateY(-29deg)';state.angles=JSON.stringify(preview.value.viewAngles);state.zoom=preview.value.getCameraZoom().zoom;state.area=area.toJSON();state.listen=event=>{state.id=event.pointerId};host.addEventListener('pointerdown',state.listen,{once:true});return {point:{x:area.left+area.width/2,y:area.top+area.height/2},outside:{x:area.left-4,y:area.top+area.height/2}};
 },
 async boundaryCaptureAction(){
  const state=window.boundaryCapture,host=document.querySelector('.appearance-window-preview');expect(host.hasPointerCapture(state.id)&&host.classList.contains('is-dragging'),'native drag never captures the pointer');
  if(state.kind==='lost')host.releasePointerCapture(state.id);else if(state.kind==='cancel')host.dispatchEvent(new PointerEvent('pointercancel',{pointerId:state.id,pointerType:'mouse',bubbles:true}));else if(state.kind==='blur')window.dispatchEvent(new Event('blur'));await new Promise(resolve=>setTimeout(resolve,150));
 },
 async checkBoundaryCapture(){
  await nextTick();const state=window.boundaryCapture,host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument;
  expect(!host.classList.contains('is-dragging')&&!host.hasPointerCapture(state.id),'native '+state.kind+' leaves pointer capture or drag state active');expect(doc.querySelector('[data-appearance-layer-scene]').style.transform===state.basis&&JSON.stringify(preview.value.viewAngles)===state.angles&&preview.value.getCameraZoom().zoom===state.zoom,'native '+state.kind+' keeps an edge tilt or changes the user angle/zoom');expect(JSON.stringify(draft)===state.draft&&JSON.stringify(window.previewSettings.value)===state.settings,'native pointer boundary changes saved settings or draft');window.previewPointerBoundaries.nativeCaptureCases=(window.previewPointerBoundaries.nativeCaptureCases??0)+1;
  const original=state.original;preview.value.setLayeredView(original.layered);preview.value.setViewAngles(original.angles);preview.value.setCameraZoom(original.zoom);focused.value=original.focused;if(original.motion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.setAttribute('data-te-motion',original.motion);await settle();await settle();await waitForPreviewView(host,'native boundary cleanup leaves its original view unsettled',original.layered);isolatedBoundary();
 },
 async pointerRouting(){
  const original={motion:document.documentElement.getAttribute('data-te-motion'),focused:focused.value,layered:preview.value.layeredView,htmlAuto:document.documentElement.classList.contains('te-auto-scrollbar'),bodyAuto:document.body.classList.contains('te-auto-scrollbar')};
  const ordinary=document.createElement('div');ordinary.style.cssText='position:fixed;right:8px;top:8px;width:180px;height:360px;overflow:auto;z-index:9999999;background:#25272a';const content=document.createElement('div');content.style.height='1100px';ordinary.append(content);document.body.append(ordinary);
  let clearAuto,clearTop,documentMoves=0,geometryReads=0,pointerFrames=0;const onMove=()=>documentMoves++,nativeRect=Element.prototype.getBoundingClientRect;
  let observer;
  try{
   document.documentElement.dataset.teMotion='full';focused.value='card';preview.value.setLayeredView(true);await settle();await settle();
   clearAuto=installAutoHideScrollbars();clearTop=installScrollToTopButton();await settle();
   const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument;
   await waitForPreviewView(host,'pointer routing observes an unsettled layered view',true);
   const group=doc.querySelector('[data-appearance-layer-scene]'),area=host.getBoundingClientRect();
   host.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse',clientX:(area.left+area.right)/2,clientY:(area.top+area.bottom)/2}));await new Promise(resolve=>setTimeout(resolve,150));
   document.addEventListener('pointermove',onMove);Element.prototype.getBoundingClientRect=function(){if(this.ownerDocument===document)geometryReads++;return nativeRect.call(this)};
   observer=new MutationObserver(records=>{pointerFrames+=records.filter(record=>record.target===group&&record.attributeName==='style').length});observer.observe(group,{attributes:true});
   const hit=host.querySelector('[aria-label="调整内容卡片"]');
   for(let index=0;index<100;index++)hit.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:area.left+12+index/10,clientY:area.bottom-12,bubbles:true}));
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await nextTick();
   const stats={canvasMoves:100,canvasDocumentMoves:documentMoves,canvasGeometryReads:geometryReads,pointerFrames};
   expect(documentMoves===0&&geometryReads===0&&pointerFrames===1,'canvas pointer drives global scroll geometry or does not coalesce: '+JSON.stringify(stats));
   pointerFrames=0;await new Promise(resolve=>setTimeout(resolve,180));await nextTick();stats.trackingTailWrites=pointerFrames;expect(pointerFrames===0,'stationary pointer keeps reprojecting the native optical pipeline');
   host.querySelector('[aria-label="左右视角"]').dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:20,clientY:20,bubbles:true}));await new Promise(resolve=>requestAnimationFrame(resolve));stats.rulerDocumentMoves=documentMoves;expect(documentMoves===0,'angle ruler triggers shared scroll detection');
   const rect=nativeRect.call(ordinary);geometryReads=0;ordinary.scrollTop=300;ordinary.dispatchEvent(new Event('scroll'));content.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:rect.right-2,clientY:rect.top+30,bubbles:true}));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   Object.assign(stats,{ordinaryDocumentMoves:documentMoves,ordinaryGeometryReads:geometryReads,ordinaryScrollbarNear:ordinary.classList.contains('is-scrollbar-near'),ordinaryScrollTopVisible:document.querySelector('.te-scroll-top')?.dataset.teScrollTopVisible==='true'});
   expect(documentMoves===1&&geometryReads>0&&stats.ordinaryScrollbarNear&&stats.ordinaryScrollTopVisible,'consuming canvas input breaks shared scroll controls: '+JSON.stringify(stats));window.previewPointerRouting=stats;isolatedBoundary();
  }finally{
   observer?.disconnect();Element.prototype.getBoundingClientRect=nativeRect;document.removeEventListener('pointermove',onMove);clearAuto?.();clearTop?.();ordinary.remove();
   if(!original.htmlAuto)document.documentElement.classList.remove('te-auto-scrollbar');if(!original.bodyAuto)document.body.classList.remove('te-auto-scrollbar');
   preview.value.setLayeredView(original.layered);focused.value=original.focused;if(original.motion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.setAttribute('data-te-motion',original.motion);await settle();await waitForPreviewView(document.querySelector('.appearance-window-preview'),'pointer routing cleanup leaves its original view unsettled',original.layered);
  }
 },
 async beginFloating(){
  window.floatingOriginal={motion:document.documentElement.getAttribute('data-te-motion'),focused:focused.value,draft:JSON.stringify(draft),settings:JSON.stringify(window.previewSettings.value),visual:document.body.classList.contains('visual-qa')};
  document.documentElement.dataset.teMotion='off';document.body.classList.add('visual-qa');preview.value.setLayeredView(false);focused.value='material';floatingEnabled.value=true;await settle();window.previewFloating={geometry:[]};
 },
 async floatingGeometry(part,layered){
  focused.value=part;preview.value.setLayeredView(layered);await settle();await settle();const host=document.querySelector('.appearance-window-preview'),tools=host.querySelector('[data-appearance-floating-tools]'),bounds=host.getBoundingClientRect(),rect=tools.getBoundingClientRect(),label={material:'调整标题栏材质',navigation:'调整侧边栏材质','player-bar':'调整播放条布局'}[part],target=host.querySelector('[aria-label="'+label+'"]')?.getBoundingClientRect();
  const inside=rect.left>=bounds.left+7.5&&rect.top>=bounds.top+7.5&&rect.right<=bounds.right-7.5&&rect.bottom<=bounds.bottom-7.5,outsideScene=!tools.closest('.appearance-editor-world,iframe'),overlap=target?Math.max(0,Math.min(rect.right,target.right)-Math.max(rect.left,target.left))*Math.max(0,Math.min(rect.bottom,target.bottom)-Math.max(rect.top,target.top)):0;
  expect(inside&&outsideScene&&tools.querySelector('[data-fixture-floating-region]').dataset.fixtureFloatingRegion===part,'floating controls are clipped, inside the source or out of sync: '+JSON.stringify({bounds:bounds.toJSON(),rect:rect.toJSON(),part,layered}));
  const rulersClear=!layered||[...host.querySelectorAll('.appearance-angle-axis,.appearance-camera-controls')].every(ruler=>rectArea(intersection(rect,ruler.getBoundingClientRect()))===0);expect(rulersClear,'floating tools cover an angle or zoom ruler: '+JSON.stringify({part,layered,tools:rect.toJSON()}));
  if(part==='material')expect(overlap===0,'floating tools cover a small selected title bar despite available space');window.previewFloating.geometry.push({part,layered,width:innerWidth,height:innerHeight,inside,outsideScene,rulersClear,overlap,target:target?.toJSON(),tools:rect.toJSON()});
 },
 async floatingMotion(){
  preview.value.setLayeredView(false);focused.value='material';await settle();document.documentElement.dataset.teMotion='full';await settle();const host=document.querySelector('.appearance-window-preview'),tools=host.querySelector('[data-appearance-floating-tools]'),doc=host.querySelector('iframe').contentDocument;
  const nativeClone=Node.prototype.cloneNode,nativeChildClone=doc.defaultView.Node.prototype.cloneNode,nativeRect=Element.prototype.getBoundingClientRect,nativeChildRect=doc.defaultView.Element.prototype.getBoundingClientRect;let transforms=0,unexpectedWrites=0,sceneWrites=0,sceneClones=0,sceneMeasures=0;
  const observer=new MutationObserver(records=>{for(const record of records){if(record.target===tools&&record.attributeName==='style')transforms++;else unexpectedWrites++}}),sourceObserver=new MutationObserver(records=>sceneWrites+=records.length);
  try{
   Node.prototype.cloneNode=function(deep){sceneClones++;return nativeClone.call(this,deep)};doc.defaultView.Node.prototype.cloneNode=function(deep){sceneClones++;return nativeChildClone.call(this,deep)};Element.prototype.getBoundingClientRect=function(){if(this.ownerDocument===doc)sceneMeasures++;return nativeRect.call(this)};doc.defaultView.Element.prototype.getBoundingClientRect=function(){sceneMeasures++;return nativeChildRect.call(this)};
   observer.observe(tools,{subtree:true,attributes:true,childList:true,characterData:true});sourceObserver.observe(doc.body,{subtree:true,attributes:true,childList:true,characterData:true});preview.value.zoomIn();await new Promise(resolve=>setTimeout(resolve,480));await nextTick();
  }finally{observer.disconnect();sourceObserver.disconnect();Node.prototype.cloneNode=nativeClone;doc.defaultView.Node.prototype.cloneNode=nativeChildClone;Element.prototype.getBoundingClientRect=nativeRect;doc.defaultView.Element.prototype.getBoundingClientRect=nativeChildRect;}
  expect(transforms>0&&unexpectedWrites===0&&sceneWrites===0&&sceneClones===0&&sceneMeasures===0,'floating position animation redraws or measures its controls/source: '+JSON.stringify({transforms,unexpectedWrites,sceneWrites,sceneClones,sceneMeasures}));Object.assign(window.previewFloating,{transforms,unexpectedWrites,sceneWrites,sceneClones,sceneMeasures});document.documentElement.dataset.teMotion='off';preview.value.fitPart();await settle();
 },
 async prepareFloatingControl(kind){
  focused.value='material';await settle();const host=document.querySelector('.appearance-window-preview'),tools=host.querySelector('[data-appearance-floating-tools]'),selector=kind==='range'?'input[type=range]':kind==='text'?'input:not([type])':'button',input=tools.querySelector(selector);
  input.focus();window.floatingControl={kind,selection:focused.value,camera:host.querySelector('.appearance-editor-world').style.transform,range:floatingValue.value,text:floatingText.value,actions:floatingActions,bubbles:[]};
  window.floatingKeyListener=event=>window.floatingControl.bubbles.push({key:event.key,ctrl:event.ctrlKey,target:event.target.getAttribute('aria-label')});window.addEventListener('keydown',window.floatingKeyListener);const rect=input.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};
 },
 async checkFloatingControl(kind){
  await nextTick();const host=document.querySelector('.appearance-window-preview'),control=window.floatingControl;window.removeEventListener('keydown',window.floatingKeyListener);
  expect(focused.value===control.selection&&host.querySelector('.appearance-editor-world').style.transform===control.camera,'property input resets selection or changes the camera');
  if(kind==='range'){expect(floatingValue.value===control.range+1,'native floating range does not respond to ArrowRight');window.previewFloating.rangeKeyboard=true;}
  if(kind==='text'){expect(floatingText.value===control.text,'native text undo was swallowed by the viewport');expect(control.bubbles.some(event=>event.key==='z'&&event.ctrl),'history shortcut cannot reach the parent');window.previewFloating.nativeUndo=true;window.previewFloating.historyBubbles=true;}
  if(kind==='action'){expect(floatingActions===control.actions+1,'floating button does not receive the pointer');expect(control.bubbles.some(event=>event.key==='Escape'),'floating Escape cannot reach shared dismiss handlers');window.previewFloating.escapeBubbles=true;}
  window.previewFloating.selectionPreserved=true;isolatedBoundary();
 },
 async finishFloating(){
  const original=window.floatingOriginal;floatingEnabled.value=false;preview.value.setLayeredView(false);focused.value=original.focused;if(original.motion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.dataset.teMotion=original.motion;if(!original.visual)document.body.classList.remove('visual-qa');await settle();
  expect(!document.querySelector('[data-appearance-floating-tools]')&&JSON.stringify(draft)===original.draft&&JSON.stringify(window.previewSettings.value)===original.settings,'floating lifecycle retains controls or changes appearance/settings');return window.previewFloating;
 },
 async reliefGeometry(){
  const motion=document.documentElement.getAttribute('data-te-motion'),originalLayered=preview.value.layeredView,originalAngles={...preview.value.viewAngles};document.documentElement.dataset.teMotion='off';preview.value.setLayeredView(true);preview.value.setViewAngles({x:0,y:40});await settle();
  const doc=document.querySelector('.appearance-window-preview iframe').contentDocument,clone=doc.querySelector('[data-appearance-layer-scene]'),surfaces=measureAppearanceSurfaces(doc.querySelector('body > .appearance-preview-scene'),{width:doc.defaultView.innerWidth,height:doc.defaultView.innerHeight});let checked=0,maxDrift=0;
  for(const plane of clone.querySelectorAll('[data-appearance-detail]')){
   const control=plane.querySelector('[data-appearance-surface-key]:not([data-appearance-detail-branch])');if(!control)continue;const source=surfaces[Number(control.dataset.appearanceSurfaceKey)];if(!source)continue;
   const r=source.rect,probes=[[r.left,r.top],[r.left+r.width,r.top],[r.left,r.top+r.height],[r.left+r.width,r.top+r.height]].map(([x,y])=>{const e=doc.createElement('i');e.style.cssText='position:absolute;left:'+x+'px;top:'+y+'px;width:0;height:0';plane.append(e);return e}),points=probes.map(e=>e.getBoundingClientRect());probes.forEach(e=>e.remove());
   const expected={left:Math.min(...points.map(p=>p.left)),top:Math.min(...points.map(p=>p.top)),right:Math.max(...points.map(p=>p.right)),bottom:Math.max(...points.map(p=>p.bottom))},actual=control.getBoundingClientRect(),drift=Math.max(...Object.keys(expected).map(k=>Math.abs(expected[k]-actual[k])));maxDrift=Math.max(maxDrift,drift);checked++;expect(drift<=2,'raised native control drifts from its measured plane: '+JSON.stringify({class:control.className,expected,actual:actual.toJSON(),drift}));
  }
  expect(checked>=20,'3D relief did not cover content, chrome and player controls');if(motion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.dataset.teMotion=motion;preview.value.setViewAngles(originalAngles);preview.value.setLayeredView(originalLayered);await settle();return {checked,maxDrift};
 },
 async beginLayerHits(){
  window.layerHitOriginal={motion:document.documentElement.getAttribute('data-te-motion'),angles:{...preview.value.viewAngles},focused:focused.value,draft:JSON.stringify(draft),settings:JSON.stringify(window.previewSettings.value)};document.documentElement.dataset.teMotion='off';focused.value='overview';preview.value.setLayeredView(true);await settle();window.previewLayerHits={cases:[]};
 },
 async prepareLayerHit(angles,zoom,part){
  preview.value.setViewAngles(angles);focused.value=part;await settle();preview.value.setCameraZoom(zoom);await settle();const canvas=document.querySelector('.appearance-window-preview');if(zoom>1){const area=canvas.getBoundingClientRect(),target=canvas.querySelector('[data-region="'+part+'"]').getBoundingClientRect();for(const [key,delta]of [[(target.left+target.right)/2>area.left+area.width/2?'ArrowRight':'ArrowLeft',Math.abs((target.left+target.right)/2-area.left-area.width/2)],[(target.top+target.bottom)/2>area.top+area.height/2?'ArrowDown':'ArrowUp',Math.abs((target.top+target.bottom)/2-area.top-area.height/2)]])for(let step=0;step<Math.round(delta/32);step++)canvas.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true}));await settle();}const host=document.querySelector('.appearance-window-preview'),hit=host.querySelector('[data-region="'+part+'"]'),doc=host.querySelector('iframe').contentDocument,clone=doc.querySelector('[data-appearance-layer-scene]'),selector={material:'.app-shell-title .title-bar',navigation:'.side-menu'}[part],actual=actualElement(clone,selector).getBoundingClientRect(),expected=projectedSourceRect(host,actual),shown=hit.getBoundingClientRect();for(const edge of ['left','top','right','bottom'])expect(Math.abs(shown[edge]-expected[edge])<.3,'extreme 3D hit bounds diverge from native component: '+JSON.stringify({angles,zoom,part,edge,shown:shown.toJSON(),expected}));const point={x:(shown.left+shown.right)/2,y:(shown.top+shown.bottom)/2},target=document.elementFromPoint(point.x,point.y);expect(target===hit||hit.contains(target),'extreme native hit point is covered or outside its projected plane: '+JSON.stringify({angles,zoom,part,point,target:target?.outerHTML}));selected='';window.layerHitCurrent={angles,zoom,part,sameNativeProjection:true};return point;
 },
 async checkLayerHit(){
  await nextTick();const item=window.layerHitCurrent;expect(selected===item.part&&focused.value===item.part,'native CSS3D pointer selects the wrong module');window.previewLayerHits.cases.push({...item,pointerSelected:true});
 },
 async finishLayerHits(){
  const original=window.layerHitOriginal;preview.value.setLayeredView(false);preview.value.setViewAngles(original.angles);focused.value=original.focused;if(original.motion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.dataset.teMotion=original.motion;await settle();await waitForPreviewView(document.querySelector('.appearance-window-preview'),'native hit verification leaves the flat view unsettled',false);window.previewLayerHits.draftSettingsUnchanged=JSON.stringify(draft)===original.draft&&JSON.stringify(window.previewSettings.value)===original.settings;expect(window.previewLayerHits.draftSettingsUnchanged,'native hit verification changed personal settings or draft');return window.previewLayerHits;
 },
 diagnostics(){const host=document.querySelector('.appearance-window-preview'),frame=host?.querySelector('iframe'),doc=frame?.contentDocument;return {boundary:window.previewBoundary,errors:window.previewErrors,roots:{parent:{...document.documentElement.dataset},child:doc?{...doc.documentElement.dataset}:null},viewport:doc?{parentWidth:innerWidth,parentHeight:innerHeight,childWidth:doc.defaultView.innerWidth,childHeight:doc.defaultView.innerHeight,frameStyle:getComputedStyle(frame).cssText,frameWidth:getComputedStyle(frame).width,frameHeight:getComputedStyle(frame).height,world:host.querySelector('.appearance-preview-world')?.style.cssText}:null,workshop:workshopModel.value?workshopSnapshot():null,source:doc?.querySelector(moduleSelectors.card)?sourceGeometry(doc):null,controls:doc?Object.fromEntries(['.title-bar','.side-menu','.main-content','.player-bar','.player-cover-slot','.player-center','.player-controls','.btn-play','.mini-play-button','.player-title','.progress-area','.player-bar-warp'].map(selector=>{const element=doc.querySelector(selector);if(!element)return [selector,null];const style=doc.defaultView.getComputedStyle(element),rect=element.getBoundingClientRect();return [selector,{className:element.className,width:rect.width,height:rect.height,background:style.backgroundColor,backdrop:style.backdropFilter,font:style.fontSize,transform:style.transform,grid:style.gridTemplateColumns}]})):null}},
 async initial(){await settle();const host=document.querySelector('.appearance-window-preview'),frame=host.querySelector('iframe'),doc=frame.contentDocument;await waitFor(()=>!!host.dataset.cameraScale&&doc.querySelector('.side-menu'),'initial preview did not mount its source');expect(!preview.value.navigationExpanded&&doc.querySelector('.side-menu').getBoundingClientRect().width===0&&noExpandedNavigationHotspot(host),'overview initially obscures the content with navigation');window.previewDefaultNavigation='collapsed';preview.value.toggleNavigation();await waitFor(()=>{const a=host.getBoundingClientRect(),b=frame.getBoundingClientRect();return !!host.dataset.cameraScale&&doc.querySelector('.side-menu')?.getBoundingClientRect().width>0&&b.left>=a.left&&b.top>=a.top&&b.right<=a.right&&b.bottom<=a.bottom;},'initial preview did not settle after styles and viewport became ready');
 expect(frame.getAttribute('sandbox')==='allow-same-origin','preview can execute scripts');expect(doc.querySelector('.app-shell').inert,'real controls not inert');
 await doc.fonts.ready;realScene(doc);expect(JSON.stringify(navigationRows(doc))===JSON.stringify(['local-home','search','streaming','local-library','recent']),'default sidebar diverges from the real five navigation entries');const sourceSnapshot=sourceGeometry(doc);
 const a=host.getBoundingClientRect(),b=frame.getBoundingClientRect();expect(Math.abs(a.width/a.height-innerWidth/innerHeight)<0.003,'preview aspect distorted');expect(b.left>=a.left&&b.top>=a.top&&b.right<=a.right&&b.bottom<=a.bottom,'complete source window not fitted');
 expect(sourceSnapshot.navigation.width>0&&sourceSnapshot.material.width===innerWidth,'source layout shrunk instead of scaled');
 for(let tries=0;tries<20&&!document.querySelector('[aria-label="调整侧边栏材质"]');tries++)await settle();expect(document.querySelector('[aria-label="调整侧边栏材质"]'),'navigation hotspot missing: '+JSON.stringify([...host.querySelectorAll('button')].map(e=>e.getAttribute('aria-label'))));document.querySelector('[aria-label="调整侧边栏材质"]').click();expect(selected==='navigation'&&window.nativeActions===0,'preview invoked native action');
 document.documentElement.dataset.teMotion='reduced';await waitFor(()=>doc.documentElement.dataset.teMotion==='reduced','root attributes stale');await settle();
 expect(host.querySelectorAll('[aria-pressed="true"]').length===1&&host.querySelector('[aria-label="调整侧边栏材质"]').getAttribute('aria-pressed')==='true','module click does not update the selected state');focused.value='overview';await settle();
 const retained=doc.querySelector('[data-appearance-host-style]');const style=document.createElement('style');style.textContent='.side-menu{--te-preview-host-probe:live}';document.head.append(style);await settle();expect(doc.defaultView.getComputedStyle(doc.querySelector('.side-menu')).getPropertyValue('--te-preview-host-probe').trim()==='live','styles stale');expect(retained.isConnected,'unrelated style addition recopies all styles');
 const overviewScale=Number(host.dataset.cameraScale);focused.value='navigation';await settle();const focusScale=Number(host.dataset.cameraScale);expect(focusScale>overviewScale,'selected part not enlarged to fit its actual source geometry');unchangedGeometry(doc,sourceSnapshot,'zoom changes source layout');expect(getComputedStyle(document.querySelector('[aria-label="调整侧边栏材质"]')).backgroundColor==='rgba(0, 0, 0, 0)','selection covers actual part');focused.value='overview';await settle();
 const labels={navigation:'调整侧边栏材质',material:'调整标题栏材质','player-bar':'调整播放条布局',card:'调整内容卡片'},selectors={navigation:'.side-menu',material:'.title-bar','player-bar':'.player-bar',card:moduleSelectors.card};
 const complete=part=>{
  const hit=host.querySelector('[aria-label="'+labels[part]+'"]'),r=hit.getBoundingClientRect(),v=host.getBoundingClientRect();
  const native=doc.querySelector(selectors[part]).getBoundingClientRect(),scale=Number(host.dataset.cameraScale);expect(Math.abs(r.width-native.width*scale)<0.1&&Math.abs(r.height-native.height*scale)<0.1,'hotspot does not match the painted module: '+part);
  expect(getComputedStyle(hit).borderTopWidth==='0px'&&getComputedStyle(hit).boxShadow==='none','selected module retains a permanent border or halo: '+part);
  expect(r.left>=v.left&&r.top>=v.top&&r.right<=v.right+0.01&&r.bottom<=v.bottom+0.01,'part cropped: '+part);
  for(const selector of Object.values(selectors))expect(doc.defaultView.getComputedStyle(doc.querySelector(selector)).visibility==='visible','surrounding module hidden: '+selector);
  const context=host.querySelector('.appearance-editor-context');
  expect(getComputedStyle(context).opacity==='0.6','surrounding scene is not faded');
  expect(getComputedStyle(context).pointerEvents==='none','context overlay blocks module selection');
  expect(context.children.length===4&&host.querySelectorAll('iframe').length===1,'context duplicates scene');
  for(const panel of context.children){const p=panel.getBoundingClientRect();expect(Math.max(0,Math.min(p.right,r.right)-Math.max(p.left,r.left))*Math.max(0,Math.min(p.bottom,r.bottom)-Math.max(p.top,r.top))<0.01,'selected module faded by context');}
  for(const [id,label] of Object.entries(labels)){const hit=host.querySelector('[aria-label="'+label+'"]');if(id==='navigation'&&host.dataset.navigationRelief==='behind')expect(!hit,'covered sidebar retains its misleading hotspot');else expect(hit&&getComputedStyle(hit).display!=='none','context module cannot be selected: '+id);}
 };
 for(const part of ['navigation','material','player-bar','card']){focused.value=part;await settle();complete(part);const scale=()=>Number(host.dataset.cameraScale);const baseline=scale();expect(baseline>overviewScale,'part not enlarged: '+part);preview.value.zoomIn();await settle();expect(scale()>baseline,'zoom control ineffective: '+part);preview.value.fitPart();await settle();expect(scale()<=baseline,'fit part ineffective: '+part);complete(part);unchangedGeometry(doc,sourceSnapshot,'camera reflows real source');}
 const panel=document.createElement('div');panel.style.cssText='position:absolute;top:52px;right:12px;width:170px;height:320px;pointer-events:none';focused.value='material';await settle();const centered=host.querySelector('.appearance-editor-world').style.transform;host.append(panel);occlusions.value=[panel];await settle();complete('material');expect(host.querySelector('.appearance-editor-world').style.transform===centered,'property width changes the full-canvas camera');panel.style.height='44px';occlusions.value=[panel];await settle();expect(host.querySelector('.appearance-editor-world').style.transform===centered,'property collapse changes the full-canvas camera');panel.remove();occlusions.value=[];await settle();
 const beforeWheel=Number(host.dataset.cameraScale);host.dispatchEvent(new WheelEvent('wheel',{deltaY:-80,clientX:300,clientY:200,bubbles:true,cancelable:true}));await settle();expect(Number(host.dataset.cameraScale)>beforeWheel,'wheel zoom ineffective');host.dispatchEvent(new KeyboardEvent('keydown',{key:'0',bubbles:true}));await settle();complete('material');
 document.documentElement.dataset.teMotion='full';await settle();focused.value='card';await nextTick();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const first=Number(host.dataset.cameraScale);let cameraFrames=0,animatedChildStyles=0,animatedSourceMeasures=0;const world=host.querySelector('.appearance-editor-world');const animationCounter=new MutationObserver(records=>{for(const record of records)if(record.target===world)cameraFrames++;else animatedChildStyles++;});animationCounter.observe(world,{attributes:true,subtree:true,attributeFilter:['style']});const nativeRect=doc.defaultView.Element.prototype.getBoundingClientRect,nativeParentRect=Element.prototype.getBoundingClientRect;doc.defaultView.Element.prototype.getBoundingClientRect=function(){animatedSourceMeasures++;return nativeRect.call(this)};Element.prototype.getBoundingClientRect=function(){if(this.ownerDocument===doc)animatedSourceMeasures++;return nativeParentRect.call(this)};doc.querySelector('.side-menu').getBoundingClientRect();expect(animatedSourceMeasures===1,'source measurement probe misses the teleported node realm');animatedSourceMeasures=0;await new Promise(resolve=>setTimeout(resolve,80));const during=Number(host.dataset.cameraScale);expect(first!==during,'full motion skips intermediate camera frames');await new Promise(resolve=>setTimeout(resolve,360));animationCounter.disconnect();doc.defaultView.Element.prototype.getBoundingClientRect=nativeRect;Element.prototype.getBoundingClientRect=nativeParentRect;expect(cameraFrames>0&&animatedChildStyles===0&&animatedSourceMeasures===0,'camera redraws children or remeasures source: '+JSON.stringify({cameraFrames,animatedChildStyles,animatedSourceMeasures}));complete('card');host.querySelector('[aria-label="调整标题栏材质"]').click();expect(selected==='material','faded context cannot select another module');document.documentElement.dataset.teMotion='off';await settle();focused.value='overview';await settle();expect(getComputedStyle(host.querySelector('.appearance-editor-context')).opacity==='0','whole scene remains faded');
 document.documentElement.style.setProperty('--te-app-bg','#17181a');await settle();let mirrored=0,repeatedRootWrites=0;const counter=new MutationObserver(records=>{for(const record of records)if(record.attributeName==='data-preview-perf')mirrored++;else repeatedRootWrites++;});counter.observe(doc.documentElement,{attributes:true});for(let i=0;i<100;i++){document.documentElement.dataset.previewPerf=String(i);await Promise.resolve()}await settle();counter.disconnect();expect(doc.documentElement.dataset.previewPerf==='99'&&mirrored<=2&&repeatedRootWrites===0,'preview does not coalesce update burst: '+JSON.stringify({mirrored,repeatedRootWrites}));window.previewPerf={inputChanges:100,mirroredUpdates:mirrored,cameraFrames,animatedChildStyles,animatedSourceMeasures,repeatedRootWrites};
 previewActive.value=false;await settle();document.documentElement.dataset.previewPerf='paused';await settle();expect(doc.documentElement.dataset.previewPerf==='99','hidden preview still updates');previewActive.value=true;await settle();expect(doc.documentElement.dataset.previewPerf==='paused','resumed preview stale');
 draft.appBackground.global.dark='#28332f';draft.appBackground.global.customized=true;await settle();expect(doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue('--te-app-bg').trim()==='#28332f','draft not rendered');expect(getComputedStyle(host.querySelector('.appearance-editor-context > div')).backgroundColor==='rgb(40, 51, 47)','context does not use current background');tone.value='light';await settle();expect(doc.documentElement.dataset.theme==='pureWhite'&&getComputedStyle(host.querySelector('.appearance-editor-context > div')).backgroundColor!=='rgb(40, 51, 47)','light preview retains dark context');tone.value='dark';await settle();
 document.documentElement.dataset.teMotion='reduced';await settle();anchor.value.click();await settle();let popover=document.querySelector('.appearance-popover'),rect=popover.getBoundingClientRect();expect(rect.left>=12&&rect.right<=innerWidth-12&&rect.bottom<=innerHeight-12,'menu outside viewport');expect(popover.dataset.side==='bottom','menu not anchored above button');popover.classList.add('appearance-popover-enter-active','appearance-popover-enter-from');expect(getComputedStyle(popover).transitionProperty==='opacity'&&getComputedStyle(popover).transform==='none','reduced motion still transforms');popover.classList.remove('appearance-popover-enter-active','appearance-popover-enter-from');expect(document.activeElement.type==='color','menu not keyboard focused');
 window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await waitFor(()=>!document.querySelector('.appearance-popover')&&document.activeElement===anchor.value,'escape/focus return failed');
 anchor.value.click();await settle();document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));await settle();expect(!document.querySelector('.appearance-popover'),'outside did not dismiss');expect(draft.appBackground.global.dark==='#28332f','dismiss lost draft');
 },
 async canvasBehavior(){
  const host=document.querySelector('.appearance-window-preview'),frame=host.querySelector('iframe'),doc=frame.contentDocument,draftSnapshot=JSON.stringify(draft),settingsSnapshot=JSON.stringify(window.previewSettings.value),originalExpanded=preview.value.navigationExpanded;
  const panel=document.createElement('aside');panel.style.cssText='position:absolute;right:0;top:0;width:210px;height:100%;pointer-events:none';host.append(panel);let centerCases=0,backgroundModules=0,navigationRestorations=0;
  const assertCentered=part=>{const target=part==='overview'?frame:host.querySelector('[aria-label="'+{material:'调整标题栏材质',card:'调整内容卡片'}[part]+'"]'),a=target.getBoundingClientRect(),b=host.getBoundingClientRect();expect(Math.abs((a.left+a.right-b.left-b.right)/2)<0.1&&Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<0.1,'camera is not centered in the whole canvas: '+part);};
  try{
   document.documentElement.dataset.teMotion='off';if(!preview.value.navigationExpanded)preview.value.toggleNavigation();focused.value='overview';await settle();const source=sourceGeometry(doc),navigation=doc.querySelector('[data-preview-module="navigation"]'),content=doc.querySelector('[data-preview-module="background"]'),normalNavigationZ=doc.defaultView.getComputedStyle(navigation).zIndex,nativePaint=backgroundPaint(doc,doc);
   for(const part of ['overview','material','card']){focused.value=part;await settle();preview.value.fitPart();await settle();assertCentered(part);const camera=host.querySelector('.appearance-editor-world').style.transform;occlusions.value=[panel];await settle();assertCentered(part);expect(host.querySelector('.appearance-editor-world').style.transform===camera,'property occlusion changes the camera center or scale: '+part);occlusions.value=[];centerCases++;}
   focused.value='card';await settle();const overlap=rectArea(intersection(doc.querySelector('.side-menu').getBoundingClientRect(),doc.querySelector(moduleSelectors.card).getBoundingClientRect()));expect(overlap>0,'sidebar relief fixture does not cover the actual card');expect(preview.value.navigationExpanded&&doc.querySelector('.side-menu').getBoundingClientRect().width===source.navigation.width,'automatic relief changes the manual sidebar state or geometry');const navigationZ=Number.parseInt(doc.defaultView.getComputedStyle(navigation).zIndex)||0,contentZ=Number.parseInt(doc.defaultView.getComputedStyle(content).zIndex)||0;expect(host.dataset.navigationRelief==='behind'&&doc.querySelector('.app-shell').dataset.previewNavigationLayer==='behind'&&noExpandedNavigationHotspot(host)&&navigationZ<=contentZ&&doc.defaultView.getComputedStyle(navigation).zIndex!==normalNavigationZ,'overlapping sidebar remains over the selected real card or retains an invisible hotspot');unchangedGeometry(doc,source,'sidebar relief reflows the real scene');
   focused.value='overview';await settle();const nativeControl=doc.querySelector('.online-hero button'),controlRect=projectedSourceRect(host,nativeControl.getBoundingClientRect()),controlHit=[...host.querySelectorAll('[data-region="controls"]')].find(hit=>{const r=hit.getBoundingClientRect();return Math.abs(r.left-controlRect.left)<1&&Math.abs(r.top-controlRect.top)<1;});expect(controlHit,'native nested control has no matching hit region');controlHit.click();await settle();expect(rectArea(intersection(doc.querySelector('.side-menu').getBoundingClientRect(),nativeControl.getBoundingClientRect()))>0,'control relief fixture has no native overlap');expect(focused.value==='controls'&&host.dataset.navigationRelief==='behind'&&doc.querySelector('.app-shell').dataset.previewNavigationLayer==='behind'&&noExpandedNavigationHotspot(host),'sidebar covers the selected nested control');unchangedGeometry(doc,source,'control relief reflows the real scene');focused.value='card';await settle();
   anchor.value.click();await settle();const actions=propertyActions;document.querySelector('#fixture-property-action').click();expect(propertyActions===actions+1&&focused.value==='card','property control resets the selected module or does not receive its action');window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await settle();expect(focused.value==='card','closing property controls resets the selected module');
   for(const part of ['overview','background','navigation']){focused.value=part;await settle();expect(preview.value.navigationExpanded&&host.dataset.navigationRelief==='normal'&&doc.defaultView.getComputedStyle(navigation).zIndex===normalNavigationZ&&(part==='background'?noExpandedNavigationHotspot(host):host.querySelector('[aria-label="调整侧边栏材质"]')),'navigation layer or hotspot is not restored for '+part);navigationRestorations++;if(part==='background'){realScene(doc);foregroundOnly(doc,doc,host,nativePaint);for(const [id,selector] of Object.entries(moduleSelectors)){const bounds=doc.querySelector(selector).getBoundingClientRect();expect(Math.abs(bounds.width-source[id].width)<0.01&&Math.abs(bounds.height-source[id].height)<0.01,'background editing reflows '+id)}expect(doc.querySelector('.app-shell').dataset.previewFocus==='inner-panel'&&sceneOpacity(content)===1,'background editing fades its editable backdrop');const context=host.querySelector('.appearance-editor-context'),contextStyle=getComputedStyle(context),panels=[...context.children].map(node=>node.getBoundingClientRect()),canvas=host.getBoundingClientRect();for(const id of ['navigation','material','player-bar','card']){const element=doc.querySelector(moduleSelectors[id]),paint=doc.defaultView.getComputedStyle(element),native=element.getBoundingClientRect(),target=intersection(projectedSourceRect(host,native),canvas);expect(paint.display!=='none'&&paint.visibility==='visible'&&native.width>0&&native.height>0,'background editing hides a native module: '+id);const opacity=sceneOpacity(element),frameOpacity=Number(getComputedStyle(frame).opacity),overlayArea=panels.reduce((sum,panel)=>sum+rectArea(intersection(panel,target)),0),overlayDim=Number(contextStyle.opacity)>0&&Number(contextStyle.opacity)<1&&overlayArea>=rectArea(target)-1;expect(opacity===0&&frameOpacity>0&&!overlayDim,'background editing does not fully hide the real module: '+id);backgroundModules++;}}}
   let naturalChromeCases=0;expect(rectArea(intersection(doc.querySelector('.side-menu').getBoundingClientRect(),doc.querySelector('.player-bar').getBoundingClientRect()))>0,'natural stacking fixture does not overlap the player and navigation');for(const part of ['material','player-bar']){focused.value=part;await settle();expect(host.dataset.navigationRelief==='normal'&&doc.defaultView.getComputedStyle(navigation).zIndex===normalNavigationZ&&host.querySelector('[aria-label="调整侧边栏材质"]'),'naturally higher chrome incorrectly pushes navigation behind: '+part);naturalChromeCases++;}host.querySelector('[aria-label="调整内框背景"]').click();await settle();expect(focused.value==='inner-panel'&&selected==='inner-panel','keyboard-compatible background activation resets to overview');
   document.documentElement.dataset.teMotion='full';focused.value='card';await waitFor(()=>getComputedStyle(host.querySelector('.appearance-editor-context')).opacity==='0.6','background transition fixture has no previous context');focused.value='background';await nextTick();await waitFor(()=>doc.defaultView.getComputedStyle(actualElement(doc,'.online-home-inner')).opacity==='0','background foreground does not finish sliding out');foregroundOnly(doc,doc,host,nativePaint);expect(getComputedStyle(host.querySelector('.appearance-editor-context')).transitionDuration==='0s','background focus waits for a gray-mask fade');document.documentElement.dataset.teMotion='off';await settle();
   preview.value.toggleNavigation();focused.value='card';await settle();focused.value='overview';await settle();expect(!preview.value.navigationExpanded&&doc.querySelector('.side-menu').getBoundingClientRect().width===0&&noExpandedNavigationHotspot(host),'automatic restoration opens a manually collapsed sidebar');expect(JSON.stringify(draft)===draftSnapshot&&JSON.stringify(window.previewSettings.value)===settingsSnapshot,'canvas presentation changes the appearance or saved settings');window.previewCanvas={centerCases,blankResets:0,propertySelectionPreserved:true,backgroundModules,navigationRestorations,manualNavigationPreserved:true,naturalChromeCases,keyboardBackgroundPreserved:true,backgroundImmediateClear:true};isolatedBoundary();
  }finally{panel.remove();occlusions.value=[];if(preview.value.navigationExpanded!==originalExpanded)preview.value.toggleNavigation();focused.value='overview';await settle();}
 },
 async prepareCanvasReset(kind){
  window.canvasResetKind=kind;focused.value='card';document.documentElement.dataset.teMotion='off';await settle();const host=document.querySelector('.appearance-window-preview'),bounds=host.getBoundingClientRect();window.canvasResetDraft=JSON.stringify(draft);let point;
  if(kind==='blank'){for(const [x,y] of [[bounds.left+3,bounds.top+3],[bounds.right-3,bounds.top+3],[bounds.left+3,bounds.bottom-3]]){const target=document.elementFromPoint(x,y);if(target===host){point={x,y};break;}}}
  else{const background=host.querySelector('[aria-label="调整内框背景"]'),rect=background.getBoundingClientRect();for(const u of [.9,.5,.1])for(const v of [.08,.15,.85,.95]){const x=rect.left+rect.width*u,y=rect.top+rect.height*v;if(x>bounds.left+1&&x<bounds.right-1&&y>bounds.top+1&&y<bounds.bottom-1&&document.elementFromPoint(x,y)===background){point={x,y};break;}}}
  expect(point,'reset fixture has no visible '+kind+' target');return point;
 },
 async checkCanvasReset(){await settle();const host=document.querySelector('.appearance-window-preview');if(window.canvasResetKind==='background'){expect(focused.value==='inner-panel'&&selected==='inner-panel'&&host.querySelectorAll('[data-region]').length===1,'background pointer click does not isolate the background');host.querySelector('[data-region="inner-panel"]').click();await settle();}expect(focused.value==='overview'&&selected==='overview'&&!host.querySelector('[aria-pressed="true"]'),'background focus does not release to the retained window');expect(JSON.stringify(draft)===window.canvasResetDraft,'overview reset discards the unsaved draft');window.previewCanvas.blankResets++;realScene(host.querySelector('iframe').contentDocument);isolatedBoundary();},
 async motionApi(){
  document.documentElement.dataset.teMotion='full';await nextTick();
  const input=document.createElement('input');input.type='text';input.value='原生输入';input.style.cssText='position:fixed;left:22px;bottom:12px;width:140px;height:28px;transform:translate(3px, 2px);border-radius:7px';document.body.append(input);
  const motion=uiMotionFor(document),original=input.style.cssText,base=getComputedStyle(input).transform;
  const handles=[];
  try{
   const press=motion.control(input,'press',{duration:160});handles.push(press);expect(press.enabled,'control interface rejects a native input');const animation=input.getAnimations()[0];expect(animation,'native input has no control animation');animation.pause();animation.currentTime=80;expect(Number(getComputedStyle(input).opacity)<1,'control interface provides no intermediate feedback');expect(input.style.cssText===original&&getComputedStyle(input).transform===base,'control feedback overwrites input geometry or style');
   const all=motion.edge(input,{edges:'all',radius:7,duration:200});handles.push(all);const allLayer=document.querySelector('.te-ui-motion-edge[data-edges="all"]'),target=input.getBoundingClientRect();expect(all.enabled&&allLayer,'all-edge interface creates no temporary layer');const layer=allLayer.getBoundingClientRect();expect(Math.abs(layer.left-target.left)<0.1&&Math.abs(layer.top-target.top)<0.1&&Math.abs(layer.width-target.width)<0.1&&Math.abs(layer.height-target.height)<0.1,'temporary outline does not follow the input rectangle');expect(getComputedStyle(allLayer).pointerEvents==='none'&&getComputedStyle(allLayer).borderRadius==='7px','temporary outline blocks input or loses rounded geometry');
   const bottom=motion.edge(input,{edges:'bottom',radius:0,duration:200});handles.push(bottom);await all.finished;expect(!allLayer.isConnected,'new edge request retains its previous layer');const bottomLayer=document.querySelector('.te-ui-motion-edge[data-edges="bottom"]');expect(bottom.enabled&&getComputedStyle(bottomLayer).borderTopWidth==='0px'&&getComputedStyle(bottomLayer).borderBottomWidth==='1px','bottom edge paints an entire border');expect(input.style.cssText===original,'edge interface writes native input styles');
   press.cancel();bottom.cancel();await Promise.all(handles.map(handle=>handle.finished));expect(!document.querySelector('.te-ui-motion-edge')&&input.getAnimations().length===0&&input.style.cssText===original,'temporary feedback does not clean up');
   for(const mode of ['reduced','off']){document.documentElement.dataset.teMotion=mode;await nextTick();const edge=motion.edge(input,{edges:'all'});expect(!edge.enabled&&!document.querySelector('.te-ui-motion-edge'),mode+' still paints decorative edges');const feedback=motion.control(input,'press',{duration:400,delay:200});handles.push(feedback);if(mode==='reduced'){expect(feedback.enabled,'reduced motion removes useful control feedback');const reduced=input.getAnimations()[0];expect(reduced.effect.getTiming().duration<=120&&reduced.effect.getTiming().delay===0,'reduced control feedback keeps long movement or delay');}else expect(!feedback.enabled&&input.getAnimations().length===0,'off mode still animates controls');feedback.cancel();await feedback.finished;expect(input.style.cssText===original,'motion policy changes pollute input style');}
  }finally{for(const handle of handles)handle.cancel();input.remove();document.documentElement.dataset.teMotion='off';await settle();}
 },
 async rulerGeometry(){
  const host=document.querySelector('.appearance-window-preview'),root=document.documentElement,original={motion:root.getAttribute('data-te-motion'),layered:preview.value.layeredView,angles:{...preview.value.viewAngles},focused:focused.value,height:host.style.height,ratio:host.style.aspectRatio,visual:document.body.classList.contains('visual-qa')};
  try{
   root.dataset.teMotion='off';document.body.classList.add('visual-qa');focused.value='overview';preview.value.setViewAngles({x:0,y:0});preview.value.setLayeredView(true);host.style.height='280px';host.style.aspectRatio='auto';await settle();await settle();
   const bounds=host.getBoundingClientRect(),yaw=host.querySelector('.appearance-angle-axis--yaw').getBoundingClientRect(),pitch=host.querySelector('.appearance-angle-axis--pitch').getBoundingClientRect(),zoom=host.querySelector('.appearance-camera-controls').getBoundingClientRect();
   const controls=[...host.querySelectorAll('.appearance-angle-axis,.appearance-angle-reading,.appearance-camera-controls,input[type=range],.appearance-camera-restore')],inside=controls.every(control=>{const rect=control.getBoundingClientRect();return rect.left>=bounds.left+3&&rect.top>=bounds.top+3&&rect.right<=bounds.right-3&&rect.bottom<=bounds.bottom-3});
   const horizontalDrop=Math.round(130-(bounds.bottom-yaw.top)),pitchStable=Math.abs(pitch.top-bounds.top-24)<.1&&Math.abs(bounds.bottom-pitch.bottom-134)<.1;
   expect(inside&&Math.abs(bounds.height-280)<.1&&horizontalDrop===8&&pitchStable&&Math.abs(bounds.bottom-zoom.bottom-10)<.1,'angle/zoom rulers are clipped or do not move down8px while preserving pitch: '+JSON.stringify({width:innerWidth,height:innerHeight,bounds:bounds.toJSON(),yaw:yaw.toJSON(),pitch:pitch.toJSON(),zoom:zoom.toJSON(),inside,horizontalDrop,pitchStable}));
   for(const label of ['上下视角','左右视角'])expect(host.querySelector('[aria-label="'+label+'"]').value==='0'&&host.querySelector('[aria-label="'+label+'"]').getAttribute('aria-valuetext')==='0°','neutral default angle is not reflected in its native control');
   (window.previewRulerGeometry??=[]).push({width:innerWidth,height:innerHeight,canvasHeight:bounds.height,inside,horizontalDrop,pitchStable,zoomBottomInset:bounds.bottom-zoom.bottom});
  }finally{host.style.height=original.height;host.style.aspectRatio=original.ratio;preview.value.setViewAngles(original.angles);preview.value.setLayeredView(original.layered);focused.value=original.focused;if(!original.visual)document.body.classList.remove('visual-qa');if(original.motion===null)root.removeAttribute('data-te-motion');else root.dataset.teMotion=original.motion;await settle();}
 },
 async layerTransitionBehavior(){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument;
  const initialMotion=document.documentElement.getAttribute('data-te-motion'),initialAngles={...preview.value.viewAngles};
  expect(initialAngles.x===0&&initialAngles.y===0,'new appearance camera does not start at zero on both axes');
  const root=()=>doc.querySelector('.appearance-layer-view'),group=()=>doc.querySelector('[data-appearance-layer-scene]'),depth=()=>new DOMMatrixReadOnly(group().querySelector('[data-appearance-layer="title"]').style.transform).m43;
  try{
   document.documentElement.dataset.teMotion='full';focused.value='overview';await settle();preview.value.setLayeredView(false);await waitFor(()=>!root(),'preparing 2D does not settle');
   preview.value.setLayeredView(true);expect(root()&&depth()===0,'opening creates no initial flat clone');preview.value.setLayeredView(false);await nextTick();expect(!root()&&host.dataset.previewView==='flat'&&doc.querySelector('body > .appearance-preview-scene').style.visibility==='','reversing before the first frame retains a layered clone');
   preview.value.setLayeredView(true);await nextTick();expect(root()&&depth()===0&&host.dataset.previewView==='layered','3D starts by jumping to an exploded pose');
   await new Promise(resolve=>setTimeout(resolve,90));const opening=depth();expect(opening>0&&opening<preview.value.layerSpacing*5&&host.dataset.viewTransition==='running','3D expansion has no intermediate eased frame');
   const beforeReverse=depth();preview.value.setLayeredView(false);expect(Math.abs(depth()-beforeReverse)<0.01&&root(),'reverse transition jumps or immediately destroys the layers');
   await waitFor(()=>!root()&&host.dataset.previewView==='flat','reverse transition does not restore the live 2D source');expect(doc.querySelector('body > .appearance-preview-scene').style.visibility==='','folded scene remains hidden');
   preview.value.setLayeredView(true);await nextTick();await waitFor(()=>root()&&!preview.value.layerTransitioning&&host.dataset.viewTransition==='idle','3D expansion never settles');
   const yaw=host.querySelector('input[aria-label="左右视角"]'),pitch=host.querySelector('input[aria-label="上下视角"]');expect(yaw&&pitch&&yaw.min==='-60'&&yaw.max==='60'&&pitch.min==='-30'&&pitch.max==='30','view-angle controls do not match the requested two-axis ranges');
   for(const [axis,input,values] of [['y',yaw,[-60,60]],['x',pitch,[-30,30]]])for(const value of values){input.value=String(value);input.dispatchEvent(new Event('input',{bubbles:true}));await nextTick();expect(preview.value.viewAngles[axis]===value,'arc range does not update '+axis+': '+JSON.stringify({value,actual:preview.value.viewAngles,disabled:input.disabled,transition:host.dataset.viewTransition}));}
   const chosen=focused.value,world=host.querySelector('.appearance-editor-world').style.transform;
   yaw.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:31,clientX:70,clientY:70,bubbles:true}));yaw.dispatchEvent(new PointerEvent('pointermove',{pointerId:31,clientX:150,clientY:90,bubbles:true}));yaw.dispatchEvent(new PointerEvent('pointerup',{pointerId:31,clientX:150,clientY:90,bubbles:true}));yaw.click();yaw.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await settle();expect(focused.value===chosen&&host.querySelector('.appearance-editor-world').style.transform===world&&!host.classList.contains('is-dragging'),'ruler interaction changes object selection or pans the scene');
   preview.value.setViewAngles(initialAngles);preview.value.setLayeredView(false);await new Promise(resolve=>setTimeout(resolve,100));expect(root()&&depth()>0&&host.dataset.viewTransition==='running','returning to 2D has no fold animation');await waitFor(()=>!root(),'fold animation does not release its clone');
   document.documentElement.dataset.teMotion='reduced';await settle();preview.value.setLayeredView(true);expect(root()&&host.dataset.viewTransition==='idle'&&depth()===preview.value.layerSpacing*5,'reduced motion still plays the expansion');preview.value.setLayeredView(false);expect(!root(),'reduced motion still plays the fold');
   window.previewTransition={interrupted:true,instantReverse:true,opening:true,closing:true,axes:2,boundaries:4,controlsIsolated:true,reduced:true,defaultAngles:true};
  }finally{preview.value.setViewAngles(initialAngles);preview.value.setLayeredView(false);if(initialMotion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.dataset.teMotion=initialMotion;focused.value='overview';await settle();}
 },
 async cameraZoomBehavior(){
  const host=document.querySelector('.appearance-window-preview'),world=host.querySelector('.appearance-editor-world'),doc=host.querySelector('iframe').contentDocument;
  window.cameraOriginal={motion:document.documentElement.getAttribute('data-te-motion'),draft:JSON.stringify(draft),settings:JSON.stringify(window.previewSettings.value),selected:focused.value};
  document.documentElement.dataset.teMotion='off';focused.value='overview';preview.value.setLayeredView(true);preview.value.fitPart();await settle();
  preview.value.setViewAngles({x:0,y:40});await settle();const composedCamera=world.style.transform;for(const part of ['material','player-bar','card','controls','navigation','overview']){focused.value=part;await settle();expect(world.style.transform===composedCamera,'3D material selection magnifies and crops the assembly: '+part);for(const polygon of host.querySelectorAll('.appearance-layer-selection polygon')){const bounds=polygon.getBoundingClientRect(),canvas=host.getBoundingClientRect();expect(bounds.left>=canvas.left+12&&bounds.right<=canvas.right-12&&bounds.top>=canvas.top+12&&bounds.bottom<=canvas.bottom-12,'default 3D selection falls outside the canvas: '+part)}}const zoomBar=host.querySelector('.appearance-camera-controls').getBoundingClientRect();expect(zoomBar.width<=360&&zoomBar.width<host.clientWidth*.65,'3D zoom control dominates the canvas width');for(const pose of ['player-controls','chrome-controls']){const raised=[...doc.querySelectorAll('.appearance-layer-view [data-appearance-detail="controls"]')].filter(plane=>Number(new DOMMatrixReadOnly(plane.style.transform).m43)>(pose==='player-controls'?4:5)*preview.value.layerSpacing);expect(raised.length>0,'native buttons do not rise above their '+pose+' material')}preview.value.setViewAngles({x:0,y:0});await settle();
  const input=host.querySelector('input[aria-label="相机缩放"]'),marker=host.querySelector('.appearance-camera-marker'),reading=host.querySelector('.appearance-camera-reading');
  expect(input&&input.min==='0.35'&&input.max==='4'&&input.step==='0.01'&&!input.disabled,'camera range does not match its engine zoom limits');
  preview.value.focusCameraZoom();await nextTick();expect(document.activeElement===input,'camera entry does not focus the native zoom ruler');
  let clampCases=0;
  for(const [value,expected]of [[-20,.35],[20,4],[Number.NaN,4]]){preview.value.setCameraZoom(value);await nextTick();expect(preview.value.cameraZoom===expected&&preview.value.getCameraZoom().zoom===expected,'invalid or boundary zoom changes the engine incorrectly');clampCases++;}
  preview.value.setCameraZoom(1);await settle();const baseScale=preview.value.getCameraZoom().scale;
  const nativeClone=Node.prototype.cloneNode,nativeChildClone=doc.defaultView.Node.prototype.cloneNode,nativeRect=Element.prototype.getBoundingClientRect,nativeChildRect=doc.defaultView.Element.prototype.getBoundingClientRect;
  let sceneWrites=0,sceneClones=0,sceneMeasures=0,cameraFrames=0,rulerWrites=0,unexpectedParentWrites=0;const unexpected=[];
  const sceneCounter=new MutationObserver(records=>sceneWrites+=records.length),hostCounter=new MutationObserver(records=>{
   for(const record of records){if(record.target===world)cameraFrames++;else if(record.target===host&&record.attributeName==='data-camera-scale')continue;else if(record.target===input||record.target===marker||record.target===reading||record.target.parentNode===reading)rulerWrites++;else{unexpectedParentWrites++;unexpected.push({type:record.type,target:record.target.nodeName,className:record.target.className,attribute:record.attributeName})}}
  });
  try{
   document.documentElement.dataset.teMotion='full';await settle();
   Node.prototype.cloneNode=function(deep){sceneClones++;return nativeClone.call(this,deep)};doc.defaultView.Node.prototype.cloneNode=function(deep){sceneClones++;return nativeChildClone.call(this,deep)};
   Element.prototype.getBoundingClientRect=function(){if(this.ownerDocument===doc)sceneMeasures++;return nativeRect.call(this)};doc.defaultView.Element.prototype.getBoundingClientRect=function(){sceneMeasures++;return nativeChildRect.call(this)};
   sceneCounter.observe(doc.body,{subtree:true,attributes:true,childList:true,characterData:true});hostCounter.observe(host,{subtree:true,attributes:true,childList:true,characterData:true});
   preview.value.setCameraZoom(2.25);await new Promise(resolve=>setTimeout(resolve,80));await nextTick();
   const during=preview.value.getCameraZoom(),actualZoom=during.scale/baseScale;
   expect(during.pending&&actualZoom>1&&actualZoom<2.25,'camera zoom jumps directly to its target');
   expect(Math.abs(input.valueAsNumber-actualZoom)<.006&&reading.textContent.trim()===Math.round(actualZoom*100)+'%'&&input.getAttribute('aria-valuetext')===reading.textContent.trim(),'zoom ruler does not follow the actual intermediate camera scale');
   await waitFor(()=>!preview.value.getCameraZoom().pending,'camera zoom never settles');await nextTick();
   const final=preview.value.getCameraZoom(),matrix=new DOMMatrixReadOnly(world.style.transform);
   expect(Math.abs(final.scale/baseScale-2.25)<.00001&&Math.abs(matrix.a-final.scale)<.00001&&Math.abs(matrix.d-final.scale)<.00001&&input.valueAsNumber===2.25&&reading.textContent.trim()==='225%','zoom ruler and scene use different scales or different cameras');
  }finally{
   sceneCounter.disconnect();hostCounter.disconnect();Node.prototype.cloneNode=nativeClone;doc.defaultView.Node.prototype.cloneNode=nativeChildClone;Element.prototype.getBoundingClientRect=nativeRect;doc.defaultView.Element.prototype.getBoundingClientRect=nativeChildRect;
  }
  expect(cameraFrames>0&&rulerWrites>0&&sceneWrites===0&&sceneClones===0&&sceneMeasures===0&&unexpectedParentWrites===0,'camera ruler redraws or measures the native scene: '+JSON.stringify({cameraFrames,rulerWrites,sceneWrites,sceneClones,sceneMeasures,unexpectedParentWrites,unexpected}));
  preview.value.setCameraZoom(1);await waitFor(()=>!preview.value.getCameraZoom().pending,'preparing keyboard camera does not settle');preview.value.focusCameraZoom();await nextTick();
  window.previewCamera={range:true,clampCases,keyboardCases:0,sameEngine:true,liveReading:true,cameraFrames,rulerWrites,sceneWrites,sceneClones,sceneMeasures,unexpectedParentWrites};
 },
 async checkCameraZoom(expected){
  await waitFor(()=>!preview.value.getCameraZoom().pending,'native zoom key never settles');await nextTick();
  const host=document.querySelector('.appearance-window-preview'),input=host.querySelector('input[aria-label="相机缩放"]'),reading=host.querySelector('.appearance-camera-reading'),camera=preview.value.getCameraZoom(),matrix=new DOMMatrixReadOnly(host.querySelector('.appearance-editor-world').style.transform);
  expect(document.activeElement===input&&Math.abs(input.valueAsNumber-expected)<.00001&&Math.abs(camera.zoom-expected)<.00001&&Math.abs(preview.value.cameraZoom-expected)<.00001,'native range keyboard input does not reach the same camera');
  expect(Math.abs(matrix.a-camera.scale)<.00001&&Math.abs(matrix.d-camera.scale)<.00001&&reading.textContent.trim()===Math.round(expected*100)+'%','keyboard zoom separates the ruler and actual camera');
  expect(focused.value===window.cameraOriginal.selected&&JSON.stringify(draft)===window.cameraOriginal.draft&&JSON.stringify(window.previewSettings.value)===window.cameraOriginal.settings,'camera controls select another object, edit appearance or persist settings');window.previewCamera.keyboardCases++;
 },
 async closeCameraZoom(){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument;
  preview.value.setCameraZoom(1);await waitFor(()=>!preview.value.getCameraZoom().pending,'preparing 2D camera does not settle');
  host.querySelector('button[aria-label="返回2D视图"]').click();await nextTick();await new Promise(resolve=>setTimeout(resolve,80));
  expect(!preview.value.layeredView&&doc.querySelector('.appearance-layer-view')&&host.dataset.viewTransition==='running','bottom 2D action skips the restore animation');
  await waitFor(()=>host.dataset.previewView==='flat'&&!doc.querySelector('.appearance-layer-view'),'bottom 2D action does not release its static layers');
  expect(doc.querySelector('body > .appearance-preview-scene').style.visibility===''&&!host.querySelector('input[aria-label="相机缩放"]'),'restored 2D retains a hidden native scene or a 3D zoom ruler');
  window.previewCamera.restored2D=true;isolatedBoundary();
  const original=window.cameraOriginal;if(original.motion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.dataset.teMotion=original.motion;focused.value=original.selected;await settle();
 },
 async layeredBehavior(){
  const host=document.querySelector('.appearance-window-preview'),world=host.querySelector('.appearance-editor-world'),doc=host.querySelector('iframe').contentDocument,scene=doc.querySelector('body > .appearance-preview-scene'),draftSnapshot=JSON.parse(JSON.stringify(draft)),settingsSnapshot=JSON.parse(JSON.stringify(window.previewSettings.value)),originalExpanded=preview.value.navigationExpanded,originalSpacing=preview.value.layerSpacing;
  const hiddenDescriptor=Object.getOwnPropertyDescriptor(document,'hidden'),originalMotion=document.documentElement.getAttribute('data-te-motion');let hidden=false,clones=0,sourceMeasures=0,projectionCases=0,hiddenSchedules=0,childCounter,worldCounter,rootCounter;const stats={};
  const nativeClone=Node.prototype.cloneNode,nativeChildClone=doc.defaultView.Node.prototype.cloneNode,nativeRect=Element.prototype.getBoundingClientRect,nativeChildRect=doc.defaultView.Element.prototype.getBoundingClientRect,nativeRequest=window.requestAnimationFrame,nativeCancel=window.cancelAnimationFrame,nativeChildRequest=doc.defaultView.requestAnimationFrame,nativeChildCancel=doc.defaultView.cancelAnimationFrame,pending=new Set(),childPending=new Set();
  const isSource=element=>element.ownerDocument===doc&&(element===scene||scene.contains(element));
  const root=()=>doc.querySelector('.appearance-layer-view'),group=()=>root()?.querySelector('[data-appearance-layer-scene]');
  const projection=()=>{const clone=group();for(const [part,selector] of Object.entries(moduleSelectors)){if(part==='background')continue;const control=actualElement(clone,selector),actual=control.getBoundingClientRect(),hit=host.querySelector('[data-region="'+part+'"]'),shown=hit.getBoundingClientRect(),predicted=projectedSourceRect(host,actual);for(const edge of ['left','top','right','bottom'])if(Math.abs(shown[edge]-predicted[edge])>=0.3)throw Error('3D native projection differs from its actual cloned control: '+JSON.stringify({part,spacing:preview.value.layerSpacing,edge,hotspot:{left:shown.left,top:shown.top,right:shown.right,bottom:shown.bottom},clone:{left:actual.left,top:actual.top,right:actual.right,bottom:actual.bottom},predicted,source:sourceGeometry(doc)[part]}));expect(hit.style.clipPath===''&&host.querySelector('.appearance-region-world').style.transform===group().style.transform,'3D hit regions do not use the native cached CSS pose: '+part);projectionCases++;}uniformCamera(host);};
  try{
   document.documentElement.dataset.teMotion='off';preview.value.setLayeredView(false);focused.value='overview';if(!preview.value.navigationExpanded)preview.value.toggleNavigation();await settle();const source=sourceGeometry(doc),nativePaint=backgroundPaint(scene,doc);expect(preview.value.layerSpacing===56,'3D default spacing changes');
   Node.prototype.cloneNode=function(deep){if(this===scene)clones++;return nativeClone.call(this,deep)};doc.defaultView.Node.prototype.cloneNode=function(deep){if(this===scene)clones++;return nativeChildClone.call(this,deep)};
   Element.prototype.getBoundingClientRect=function(){if(isSource(this))sourceMeasures++;return nativeRect.call(this)};doc.defaultView.Element.prototype.getBoundingClientRect=function(){if(isSource(this))sourceMeasures++;return nativeChildRect.call(this)};
   preview.value.setLayeredView(true);await settle();stats.initialClones=clones;stats.initialSourceMeasures=sourceMeasures;expect(clones===1&&sourceMeasures>0&&sourceMeasures<=256,'3D initialization does not use one bounded native clone: '+JSON.stringify(stats));expect(host.dataset.previewView==='layered'&&preview.value.layeredView&&scene.style.visibility==='hidden','3D does not replace the visible source while preserving its native layout');
   const clone=group(),planes=[...clone.querySelectorAll('[data-appearance-layer]')];expect(root().inert&&clone.inert&&root().getAttribute('aria-hidden')==='true'&&clone.getAttribute('aria-hidden')==='true','3D accepts real window input');expect(JSON.stringify(planes.map(plane=>plane.dataset.appearanceLayer))===JSON.stringify(['outer','background','content','navigation','player','title']),'3D layers do not match native paint order');expect(new DOMMatrixReadOnly(doc.defaultView.getComputedStyle(clone).transform).is2D===false&&doc.defaultView.getComputedStyle(clone).transformStyle==='preserve-3d','3D is flattened into decorative rectangles');expect(doc.defaultView.getComputedStyle(clone).opacity==='1'&&doc.defaultView.getComputedStyle(clone).overflow==='visible','3D scene flattens depth through a grouping property');
   expect(!/PRIVATE_.*_SENTINEL|private-library-fixture|private-fixture[.]flac/.test(clone.outerHTML),'3D exposes private library or profile data');expect(!clone.querySelector('script,iframe,object,embed,animate,animateMotion,animateTransform,set')&&[clone,...clone.querySelectorAll('*')].every(element=>[...element.attributes].every(attribute=>!/^on/i.test(attribute.name))),'3D clone retains executable native markup');const ids=[...doc.querySelectorAll('[id]')].map(element=>element.id);expect(ids.length===new Set(ids).size,'3D clone duplicates source IDs');
   const selectorDimensions=['.app-shell-title .title-bar button','.app-shell-title .title-bar-icon','.side-menu .item-icon','.player-cover-slot','.btn-play','.player-title','.progress-track'];for(const selector of selectorDimensions){const native=actualElement(scene,selector),copy=actualElement(clone,selector),size=element=>element?{width:element.offsetWidth,height:element.offsetHeight,font:doc.defaultView.getComputedStyle(element).fontSize,style:element.style.cssText,className:element.className}:null;expect(native&&copy&&native.offsetWidth===copy.offsetWidth&&native.offsetHeight===copy.offsetHeight&&doc.defaultView.getComputedStyle(native).fontSize===doc.defaultView.getComputedStyle(copy).fontSize,'3D changes a native control layout instead of projecting it: '+JSON.stringify({selector,native:size(native),copy:size(copy)}))}
   let listenerCalls=0;const listener=()=>listenerCalls++;scene.addEventListener('fixture-clone-probe',listener);clone.dispatchEvent(new Event('fixture-clone-probe'));expect(listenerCalls===0,'3D cloned real event listeners');scene.removeEventListener('fixture-clone-probe',listener);unchangedGeometry(doc,source,'3D changes native source geometry');projection();
   clones=0;sourceMeasures=0;for(const spacing of [0,80]){preview.value.setLayerSpacing(spacing);focused.value='card';await settle();expect(preview.value.layerSpacing===spacing&&group()===clone,'spacing or selection reconstructs the native DOM');const context=host.querySelector('.appearance-editor-context'),path=context.querySelector('path'),points=host.querySelector('.appearance-layer-selection polygon').getAttribute('points').split(' ').map(point=>point.split(',').map(Number)),center=points.reduce((sum,point)=>[sum[0]+point[0]/points.length,sum[1]+point[1]/points.length],[0,0]),mask=document.createElement('canvas').getContext('2d'),hole=new Path2D(path.getAttribute('d'));expect(planes.every(plane=>doc.defaultView.getComputedStyle(plane).opacity==='1')&&getComputedStyle(context).opacity==='0.6'&&path.getAttribute('fill-rule')==='evenodd'&&!mask.isPointInPath(hole,center[0],center[1],'evenodd')&&mask.isPointInPath(hole,0,0,'evenodd'),'3D contextual fade dims the selected polygon or flattens the native planes');expect(clones===0&&sourceMeasures===0,'spacing or selection remeasures or reclones native source');projection();}
   sourceMeasures=0;preview.value.setLayerSpacing(-10);expect(preview.value.layerSpacing===0,'negative 3D spacing is not clamped');preview.value.setLayerSpacing(200);expect(preview.value.layerSpacing===80,'3D spacing exceeds its range');preview.value.setLayerSpacing(Number.NaN);expect(preview.value.layerSpacing===80,'invalid 3D spacing changes its previous value');focused.value='background';await settle();expect(group()===clone&&clones===0&&sourceMeasures===0,'3D range handling or background selection rebuilds the scene');expect(planes.filter(plane=>['outer','background','content'].includes(plane.dataset.appearanceLayer)).every(plane=>doc.defaultView.getComputedStyle(plane).opacity==='1')&&planes.filter(plane=>!['outer','background','content'].includes(plane.dataset.appearanceLayer)).every(plane=>doc.defaultView.getComputedStyle(plane).opacity==='0')&&[...clone.querySelectorAll('.main-content > *')].every(element=>doc.defaultView.getComputedStyle(element).opacity==='1'),'3D background selection changes the backdrop or fails to hide foreground chrome');foregroundOnly(clone,doc,host,nativePaint);stats.spacingClones=clones;stats.spacingSourceMeasures=sourceMeasures;stats.sourceGeometryPreserved=true;stats.privacyPreserved=true;
   document.documentElement.dataset.teMotion='full';focused.value='overview';await settle();await new Promise(resolve=>setTimeout(resolve,180));clones=0;sourceMeasures=0;let cameraFrames=0,childWrites=0;childCounter=new MutationObserver(records=>{childWrites+=records.length});childCounter.observe(doc.body,{subtree:true,attributes:true,childList:true,characterData:true});worldCounter=new MutationObserver(records=>{cameraFrames+=records.length});worldCounter.observe(world,{attributes:true,attributeFilter:['style']});preview.value.zoomIn();await new Promise(resolve=>setTimeout(resolve,500));await nextTick();childCounter.disconnect();worldCounter.disconnect();Object.assign(stats,{cameraFrames,cameraChildWrites:childWrites,cameraClones:clones,cameraSourceMeasures:sourceMeasures});expect(cameraFrames>0&&childWrites===0&&clones===0&&sourceMeasures===0,'3D camera does work inside the static native scene: '+JSON.stringify(stats));
   focused.value='card';await settle();await new Promise(resolve=>setTimeout(resolve,400));
   const neutralTilt=group().style.transform,stableCamera=world.style.transform,area=host.getBoundingClientRect();let parallaxFrames=0,parallaxUnexpectedWrites=0;
   childCounter=new MutationObserver(records=>{for(const record of records){if(record.target===group())parallaxFrames++;else if(record.target!==group().parentElement)parallaxUnexpectedWrites++;}});childCounter.observe(doc.body,{subtree:true,attributes:true,childList:true,characterData:true});clones=0;sourceMeasures=0;
   host.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse',clientX:area.right-8,clientY:area.top+8}));
   await new Promise(resolve=>setTimeout(resolve,60));const intermediateTilt=group().style.transform;
   await new Promise(resolve=>setTimeout(resolve,700));await nextTick();const edgeTilt=group().style.transform;
   expect(intermediateTilt!==neutralTilt&&edgeTilt!==intermediateTilt,'mouse parallax has no smooth intermediate frames');
   childCounter.disconnect();Object.assign(stats,{parallaxFrames,parallaxUnexpectedWrites,parallaxClones:clones,parallaxSourceMeasures:sourceMeasures,parallaxCameraStable:world.style.transform===stableCamera});
   expect(parallaxFrames>0&&parallaxUnexpectedWrites===0&&clones===0&&sourceMeasures===0&&world.style.transform===stableCamera,'mouse parallax reconstructs or measures native controls, or chases the camera: '+JSON.stringify(stats));projection();
   host.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:area.left+8,clientY:area.bottom-8,bubbles:true}));await new Promise(resolve=>setTimeout(resolve,760));await nextTick();expect(group().style.transform!==edgeTilt,'parallax does not follow both mouse axes');projection();
   host.dispatchEvent(new PointerEvent('pointerleave',{pointerType:'mouse'}));await waitFor(()=>group().style.transform===neutralTilt,'leaving the canvas does not return smoothly to neutral');
   for(const mode of ['reduced','off']){document.documentElement.dataset.teMotion=mode;await settle();const still=group().style.transform;host.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse',clientX:area.right-8,clientY:area.top+8}));host.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:area.left+8,clientY:area.bottom-8,bubbles:true}));await new Promise(resolve=>setTimeout(resolve,100));expect(group().style.transform===still,'parallax ignores '+mode+' motion preferences');}stats.parallaxReduced=true;
   document.documentElement.dataset.teMotion='full';focused.value='overview';await settle();
   clones=0;sourceMeasures=0;let refreshLatestWrites=0,refreshMinimumOpacity=1;rootCounter=new MutationObserver(records=>{refreshLatestWrites+=records.filter(record=>record.attributeName==='data-preview-layer-refresh').length});rootCounter.observe(doc.documentElement,{attributes:true});childCounter=new MutationObserver(records=>{if(records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&node.classList.contains('appearance-layer-view'))))refreshMinimumOpacity=Math.min(refreshMinimumOpacity,Number(doc.defaultView.getComputedStyle(root()).opacity))});childCounter.observe(doc.body,{childList:true});for(let i=0;i<100;i++){draft.appBackground.global.dark='#49'+i.toString(16).padStart(4,'0');draft.appBackground.global.customized=true;document.documentElement.dataset.previewLayerRefresh=String(i);await Promise.resolve();}await settle();await new Promise(resolve=>setTimeout(resolve,100));rootCounter.disconnect();childCounter.disconnect();Object.assign(stats,{visibleRefreshClones:clones,visibleRefreshLatestWrites:refreshLatestWrites,visibleRefreshMinimumOpacity:refreshMinimumOpacity});expect(clones===1&&refreshLatestWrites===1&&refreshMinimumOpacity===1&&Number(doc.defaultView.getComputedStyle(root()).opacity)===1,'continuous visible appearance changes rebuild excessively or restart 3D reveal: '+JSON.stringify(stats));
   document.documentElement.dataset.teMotion='off';focused.value='overview';await settle();Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});window.requestAnimationFrame=callback=>{if(hidden)hiddenSchedules++;const handle=nativeRequest.call(window,time=>{pending.delete(handle);callback(time)});pending.add(handle);return handle};window.cancelAnimationFrame=handle=>{pending.delete(handle);nativeCancel.call(window,handle)};doc.defaultView.requestAnimationFrame=callback=>{if(hidden)hiddenSchedules++;const handle=nativeChildRequest.call(doc.defaultView,time=>{childPending.delete(handle);callback(time)});childPending.add(handle);return handle};doc.defaultView.cancelAnimationFrame=handle=>{childPending.delete(handle);nativeChildCancel.call(doc.defaultView,handle)};
   hidden=true;document.dispatchEvent(new Event('visibilitychange'));await nextTick();expect(!root()&&scene.style.visibility===''&&pending.size===0&&childPending.size===0,'hidden 3D retains its clone, hides its native source or keeps pending frames');childWrites=0;clones=0;sourceMeasures=0;childCounter.observe(doc.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});
   for(let i=0;i<100;i++){draft.appBackground.global.dark='#39'+i.toString(16).padStart(4,'0');draft.appBackground.global.customized=true;document.documentElement.dataset.previewLayerHidden=String(i);preview.value.setLayerSpacing(i%81);focused.value=i===99?'background':'card';window.previewSettings.value.playerBar.mode=i===99?'mini':i%2?'standard':'compact';await nextTick();}window.dispatchEvent(new Event('resize'));await new Promise(resolve=>setTimeout(resolve,170));await nextTick();Object.assign(stats,{hiddenChildWrites:childWrites,hiddenClones:clones,hiddenSourceMeasures:sourceMeasures,hiddenScheduledFrames:hiddenSchedules});expect(childWrites===0&&clones===0&&sourceMeasures===0&&hiddenSchedules===0&&!root(),'hidden 3D continues work: '+JSON.stringify(stats));childCounter.disconnect();
   clones=0;sourceMeasures=0;let latestWrites=0;rootCounter=new MutationObserver(records=>{latestWrites+=records.filter(record=>record.attributeName==='data-preview-layer-hidden').length});rootCounter.observe(doc.documentElement,{attributes:true});hidden=false;document.dispatchEvent(new Event('visibilitychange'));await waitFor(()=>!!root()&&doc.documentElement.dataset.previewLayerHidden==='99'&&pending.size===0&&childPending.size===0,'3D does not rebuild the latest hidden state');await new Promise(resolve=>setTimeout(resolve,170));await nextTick();rootCounter.disconnect();stats.resumeClones=clones;stats.resumeSourceMeasures=sourceMeasures;stats.resumeLatestWrites=latestWrites;expect(clones===1&&sourceMeasures>0&&sourceMeasures<=160&&latestWrites===1,'3D resume replays hidden changes: '+JSON.stringify(stats));expect(preview.value.layeredView&&preview.value.layerSpacing===18&&scene.style.visibility==='hidden'&&doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue('--te-app-bg').trim()==='#390063'&&scene.querySelector('.player-bar').getBoundingClientRect().height===40,'3D resume does not preserve its latest spacing, draft and native player mode');expect(group()!==clone,'3D resume reuses an obsolete detached clone');isolatedBoundary();stats.projectionCases=projectionCases;window.previewLayers=stats;
  }finally{
   childCounter?.disconnect();worldCounter?.disconnect();rootCounter?.disconnect();Node.prototype.cloneNode=nativeClone;doc.defaultView.Node.prototype.cloneNode=nativeChildClone;Element.prototype.getBoundingClientRect=nativeRect;doc.defaultView.Element.prototype.getBoundingClientRect=nativeChildRect;window.requestAnimationFrame=nativeRequest;window.cancelAnimationFrame=nativeCancel;doc.defaultView.requestAnimationFrame=nativeChildRequest;doc.defaultView.cancelAnimationFrame=nativeChildCancel;hidden=false;if(hiddenDescriptor)Object.defineProperty(document,'hidden',hiddenDescriptor);else delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));preview.value.setLayeredView(false);preview.value.setLayerSpacing(originalSpacing);Object.assign(draft,draftSnapshot);window.previewSettings.value=settingsSnapshot;if(preview.value.navigationExpanded!==originalExpanded)preview.value.toggleNavigation();document.documentElement.removeAttribute('data-preview-layer-hidden');document.documentElement.removeAttribute('data-preview-layer-refresh');if(originalMotion===null)document.documentElement.removeAttribute('data-te-motion');else document.documentElement.setAttribute('data-te-motion',originalMotion);focused.value='overview';await settle();expect(!root()&&scene.style.visibility==='','3D close does not restore its native source');
  }
 },
 async lifecycle(){
  const host=document.querySelector('.appearance-window-preview'),world=host.querySelector('.appearance-editor-world'),doc=host.querySelector('iframe').contentDocument,snapshot=JSON.parse(JSON.stringify(draft)),sourceNavigationExpanded=preview.value.navigationExpanded,sourceSettings=JSON.parse(JSON.stringify(window.previewSettings.value));
  const hiddenDescriptor=Object.getOwnPropertyDescriptor(document,'hidden');let hidden=false;
  const nativeRequest=window.requestAnimationFrame,nativeCancel=window.cancelAnimationFrame,nativeRect=doc.defaultView.Element.prototype.getBoundingClientRect,nativeParentRect=Element.prototype.getBoundingClientRect;
  let childWrites=0,sourceMeasures=0,cameraFrames=0,hiddenSchedules=0,resumeLatestWrites=0;const pending=new Set();let childCounter,worldCounter,rootCounter;
  try{
   document.documentElement.dataset.teMotion='full';systemReduced=true;motionMedia.dispatchEvent(new Event('change'));await settle();focused.value='material';await nextTick();expect(world.style.willChange==='transform','active camera does not claim its transform layer');const before=Number(host.dataset.cameraScale);await new Promise(resolve=>setTimeout(resolve,80));expect(Number(host.dataset.cameraScale)!==before&&host.classList.contains('has-motion'),'explicit full mode loses smooth camera motion to OS reduced preference');await waitFor(()=>world.style.willChange==='','completed camera retains will-change');expect(getComputedStyle(world).willChange==='auto','completed camera retains a promoted transform layer');
   focused.value='overview';draft.liquidGlass.playbarEnabled=true;await settle();await new Promise(resolve=>setTimeout(resolve,160));
   Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
   window.requestAnimationFrame=callback=>{if(hidden)hiddenSchedules++;const handle=nativeRequest.call(window,time=>{pending.delete(handle);callback(time)});pending.add(handle);return handle};window.cancelAnimationFrame=handle=>{pending.delete(handle);nativeCancel.call(window,handle)};
   doc.defaultView.Element.prototype.getBoundingClientRect=function(){sourceMeasures++;return nativeRect.call(this)};
   Element.prototype.getBoundingClientRect=function(){if(this.ownerDocument===doc)sourceMeasures++;return nativeParentRect.call(this)};
   doc.querySelector('.side-menu').getBoundingClientRect();expect(sourceMeasures===1,'lifecycle source measurement probe misses the teleported node realm');sourceMeasures=0;
   focused.value='material';await nextTick();expect(pending.size>0&&world.style.willChange==='transform','suspension probe has no active camera work');hidden=true;document.dispatchEvent(new Event('visibilitychange'));expect(pending.size===0&&world.style.willChange==='','visibility change retains queued camera work');await nextTick();
   childCounter=new MutationObserver(records=>{childWrites+=records.length});childCounter.observe(doc.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});worldCounter=new MutationObserver(records=>{cameraFrames+=records.length});worldCounter.observe(world,{attributes:true,attributeFilter:['style']});sourceMeasures=0;
   for(let i=0;i<100;i++){draft.appBackground.global.dark='#28'+i.toString(16).padStart(4,'0');draft.appBackground.global.customized=true;draft.liquidGlass.dark.displacementScale=10+i%50;document.documentElement.dataset.previewHidden=String(i);focused.value=i===99?'card':'navigation';if(i<99)preview.value.toggleNavigation();window.previewSettings.value.playerBar.mode=i===99?'mini':i%2?'standard':'compact';window.previewSettings.value.navigationPages={version:1,order:i===99?['allSongs','local-home','search']:[],hidden:i%2?['recent']:[]};window.previewSettings.value.playerBar.layout.mini={left:['trackInfo'],center:['playPause'],right:i%2?['volume','queue','time']:['queue','volume']};await nextTick();}
   window.dispatchEvent(new Event('resize'));await new Promise(resolve=>setTimeout(resolve,170));await nextTick();
   const hiddenStats={hiddenChildWrites:childWrites,hiddenSourceMeasures:sourceMeasures,hiddenCameraFrames:cameraFrames,hiddenScheduledFrames:hiddenSchedules};expect(Object.values(hiddenStats).every(value=>value===0),'hidden preview continues rendering or scheduling: '+JSON.stringify(hiddenStats));
   childCounter.disconnect();worldCounter.disconnect();sourceMeasures=0;cameraFrames=0;worldCounter.observe(world,{attributes:true,attributeFilter:['style']});rootCounter=new MutationObserver(records=>{resumeLatestWrites+=records.filter(record=>record.attributeName==='data-preview-hidden').length});rootCounter.observe(doc.documentElement,{attributes:true});
   hidden=false;document.dispatchEvent(new Event('visibilitychange'));await waitFor(()=>doc.documentElement.dataset.previewHidden==='99'&&pending.size===0,'resumed preview did not render its latest target once');await new Promise(resolve=>setTimeout(resolve,170));await nextTick();
   rootCounter.disconnect();worldCounter.disconnect();const resumeSourceMeasures=sourceMeasures;expect(doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue('--te-app-bg').trim()==='#280063','resumed preview discards the latest hidden draft');const resumedNavigationWidth=doc.querySelector('.side-menu').getBoundingClientRect().width;expect(preview.value.navigationExpanded===!sourceNavigationExpanded&&doc.querySelector('.app-shell').dataset.previewNavigation===(sourceNavigationExpanded?'collapsed':'expanded')&&(sourceNavigationExpanded?resumedNavigationWidth===0:resumedNavigationWidth>0),'resumed preview loses the final navigation state');expect(JSON.stringify(navigationRows(doc))===JSON.stringify(['local-library','local-home','search','streaming']),'resumed preview ignores latest saved navigation order or visibility');expect(JSON.stringify(playerArrangement(doc))===JSON.stringify({left:['trackInfo'],center:['playPause'],right:['volume','queue','time']}),'resumed preview ignores latest saved player arrangement');expect(doc.querySelector('.player-bar-shell').dataset.tePlaybarMode==='mini'&&doc.querySelector('.player-bar').getBoundingClientRect().height===40,'resumed preview loses the final player mode');expect(world.style.willChange==='','resumed camera replays intermediate animations');window.previewLifecycle={...hiddenStats,resumeLatestWrites,resumeCameraFrames:cameraFrames,resumeSourceMeasures};expect(resumeLatestWrites===1&&cameraFrames===1&&resumeSourceMeasures>0&&resumeSourceMeasures<=160,'resume replays hidden intermediate updates: '+JSON.stringify(window.previewLifecycle));
  }finally{
   childCounter?.disconnect();worldCounter?.disconnect();rootCounter?.disconnect();doc.defaultView.Element.prototype.getBoundingClientRect=nativeRect;Element.prototype.getBoundingClientRect=nativeParentRect;window.requestAnimationFrame=nativeRequest;window.cancelAnimationFrame=nativeCancel;hidden=false;if(hiddenDescriptor)Object.defineProperty(document,'hidden',hiddenDescriptor);else delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));systemReduced=false;motionMedia.dispatchEvent(new Event('change'));Object.assign(draft,snapshot);if(preview.value.navigationExpanded!==sourceNavigationExpanded)preview.value.toggleNavigation();window.previewSettings.value=sourceSettings;document.documentElement.removeAttribute('data-preview-hidden');document.documentElement.dataset.teMotion='off';focused.value='overview';await settle();
  }
 },
 async loading(){
  const edgeLayers=()=>[...document.querySelectorAll('.te-ui-motion-edge')];
  const remount=async mode=>{visible.value=false;await nextTick();document.documentElement.dataset.teMotion=mode;focused.value='overview';previewActive.value=true;visible.value=true;await nextTick();return document.querySelector('.appearance-window-preview')};
  try{
   const host=await remount('full'),world=host.querySelector('.appearance-editor-world'),placeholder=host.querySelector('.appearance-preview-placeholder'),caption=document.querySelector('.fixture-real-titlebar');
   expect(host.dataset.loadingPhase==='outline'&&placeholder&&Number.parseFloat(getComputedStyle(placeholder).borderRadius)>0&&placeholder.innerText==='','loading does not start with an empty rounded placeholder');expect(getComputedStyle(world).visibility==='hidden','unmeasured scene appears before the loading outline');const outline=edgeLayers().find(layer=>layer.dataset.edges==='all'),echo=edgeLayers().find(layer=>layer.dataset.edges==='bottom');expect(outline&&echo,'loading outline or real title bar echo is missing');expect(outline.style.getPropertyValue('--te-ui-motion-edge-color')==='var(--te-settings-text)'&&echo.style.getPropertyValue('--te-ui-motion-edge-color')==='var(--te-settings-text)','appearance introduction uses an accent edge instead of a neutral contour');const captionRect=caption.getBoundingClientRect(),echoRect=echo.getBoundingClientRect();expect(Math.abs(echoRect.left-captionRect.left)<0.1&&Math.abs(echoRect.width-captionRect.width)<0.1&&Math.abs(echoRect.height-captionRect.height)<0.1,'title echo targets a preview caption instead of the real title bar');
   await waitFor(()=>host.dataset.loadingPhase==='revealing','measured scene never enters a reveal phase');const doc=host.querySelector('iframe').contentDocument;expect(doc.querySelector('.online-home').getBoundingClientRect().width>0&&doc.querySelector('.title-bar').getBoundingClientRect().width>0&&host.querySelector('[aria-label="调整标题栏材质"]')&&!preview.value.navigationExpanded,'scene fades in before its visible geometry is available');realScene(doc);expect(!host.querySelector('.appearance-preview-placeholder')&&getComputedStyle(world).visibility==='visible','placeholder remains over the revealed scene');const fade=world.getAnimations().find(animation=>animation.effect.getKeyframes().some(frame=>frame.opacity!==undefined));expect(fade,'scene reveal has no fade animation');fade.pause();fade.currentTime=100;expect(Number(getComputedStyle(world).opacity)>0&&Number(getComputedStyle(world).opacity)<1,'scene reveal has no smooth intermediate opacity');fade.finish();await waitFor(()=>host.dataset.loadingPhase==='ready','scene reveal never settles');expect(edgeLayers().length===0&&!host.querySelector('.appearance-preview-placeholder'),'ready preview retains temporary edge or placeholder');expect(getComputedStyle(host).borderTopWidth==='0px'&&getComputedStyle(host).boxShadow==='none','ready preview retains an inner frame');
   for(const mode of ['off','reduced']){const next=await remount(mode);expect(edgeLayers().length===0,'decorative loading outline ignores '+mode);let enteredWaiting=false;const observer=new MutationObserver(()=>{if(next.dataset.loadingPhase==='waiting')enteredWaiting=true});observer.observe(next,{attributes:true,attributeFilter:['data-loading-phase']});await waitFor(()=>next.dataset.loadingPhase==='ready',mode+' preview never becomes ready');observer.disconnect();expect(!enteredWaiting&&!next.querySelector('.appearance-preview-placeholder')&&edgeLayers().length===0,'quiet loading retains the outline delay or layer: '+mode);}
  }finally{document.documentElement.dataset.teMotion='off';visible.value=true;await settle();if(!preview.value.navigationExpanded){preview.value.toggleNavigation();await settle();}}
 },
 async themeMaterials(){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument,root=document.documentElement,sourceStyle=root.style.cssText,snapshot=JSON.parse(JSON.stringify(draft)),sourceMode=window.previewSettings.value.playerBar.mode,sourceEditing=themeEditing.value,sourceTone=tone.value;
  const paint=(element,pseudo)=>doc.defaultView.getComputedStyle(element,pseudo),material=part=>doc.querySelector({material:'.title-bar-background',navigation:'.side-menu','player-bar':'.player-bar-warp'}[part]);
  try{
   focused.value='overview';tone.value='dark';themeEditing.value=true;draft.surfaceMaterial='standard';draft.cardAppearance.enabled=false;draft.liquidGlass.navigationEnabled=false;draft.liquidGlass.playbarEnabled=false;
   const variables={'--te-app-bg':'#314159','--te-local-bg':'#192837','--te-player-bar-play-surface':'#674839','--te-player-bar-play-text':'#eddfcd','--te-player-bar-progress-track':'#314159','--te-player-bar-progress-fill':'#456789','--te-font-size-body':'20px','--te-chrome-frosted-blur':'27px','--te-chrome-frosted-saturation':'145%'};
   for(const [name,value] of Object.entries(variables))root.style.setProperty(name,value);await settle();realScene(doc);
   const play=doc.querySelector('.btn-play'),progress=doc.querySelector('.progress-track');expect(paint(play).backgroundColor==='rgb(103, 72, 57)'&&paint(play).color==='rgb(237, 223, 205)'&&paint(progress).backgroundColor==='rgb(49, 65, 89)','real controls do not consume host theme tokens');
   expect(Math.abs(Number.parseFloat(paint(doc.querySelector('.player-title')).fontSize)-20*16/14)<0.1,'real player typography does not consume the font token');
   for(const mode of ['standard','compact','mini']){window.previewSettings.value.playerBar.mode=mode;await settle();const shell=doc.querySelector('.player-bar-shell');expect(shell.dataset.tePlaybarMode===mode,'real player mode is stale: '+mode);focused.value='player-bar';await settle();const hit=host.querySelector('[aria-label="调整播放条布局"]'),a=hit.getBoundingClientRect(),b=host.getBoundingClientRect(),source=doc.querySelector('.player-bar').getBoundingClientRect(),scale=uniformCamera(host);expect(Math.abs(a.height-source.height*scale)<0.1&&Math.abs(a.width-source.width*scale)<0.1,'mode change leaves stale playback geometry: '+mode);expect(a.left>=b.left&&a.top>=b.top&&a.right<=b.right+0.01&&a.bottom<=b.bottom+0.01,'real player mode is cropped: '+mode);}
   window.previewSettings.value.playerBar.mode='standard';draft.liquidGlass.navigationEnabled=true;draft.liquidGlass.playbarEnabled=true;Object.assign(draft.liquidGlass.dark,{blurAmount:11,tintOpacity:23,saturation:154});await settle();
   const before={};for(const part of ['material','navigation','player-bar']){const surface=paint(material(part),part==='navigation'?'::before':undefined),playback=part==='player-bar';before[part]={blur:surface.backdropFilter,tint:surface.backgroundColor};expect(surface.backdropFilter.includes(playback?'blur(11px)':'blur(27px)')&&surface.backdropFilter.includes(playback?'saturate(1.54)':'saturate(1.45)'),'real material does not consume its own tuning: '+part+' '+JSON.stringify(before[part]));expect(surface.backdropFilter.includes('te-lg-playbar')===playback,'refraction escapes the playback backdrop: '+part);}
   Object.assign(draft.liquidGlass.dark,{blurAmount:23,tintOpacity:42,saturation:166});await settle();for(const part of ['material','navigation','player-bar']){const surface=paint(material(part),part==='navigation'?'::before':undefined);if(part==='player-bar')expect(surface.backdropFilter.includes('blur(23px)')&&surface.backdropFilter.includes('saturate(1.66)')&&surface.backdropFilter!==before[part].blur&&surface.backgroundColor!==before[part].tint,'draft adjustment does not change painted real glass: '+part+' '+JSON.stringify({before:before[part],after:{blur:surface.backdropFilter,tint:surface.backgroundColor}}));else expect(surface.backdropFilter===before[part].blur&&surface.backgroundColor===before[part].tint,'playback optics contaminate ordinary chrome: '+part);}
   root.style.setProperty('--te-chrome-frosted-blur','17px');root.style.setProperty('--te-chrome-frosted-saturation','136%');await settle();for(const part of ['material','navigation']){const surface=paint(material(part),part==='navigation'?'::before':undefined);expect(surface.backdropFilter.includes('blur(17px)')&&surface.backdropFilter.includes('saturate(1.36)')&&surface.backdropFilter!==before[part].blur,'ordinary chrome does not update its own material: '+part);}expect(paint(material('player-bar')).backdropFilter.includes('blur(23px)'),'chrome tuning contaminates playback optics');
   draft.liquidGlass.navigationEnabled=false;draft.liquidGlass.playbarEnabled=false;await settle();expect(!doc.querySelector('.title-bar-liquid,.side-menu-liquid,.player-bar-liquid,.player-bar-warp'),'disabled glass retains its refracting layer');
   draft.surfaceMaterial='transparent';await settle();for(const part of ['material','navigation','player-bar']){const element=doc.querySelector(part==='material'?'.title-bar-background':moduleSelectors[part]),surface=paint(element);expect(surface.backgroundColor==='rgba(0, 0, 0, 0)'&&surface.backdropFilter==='none','transparent material keeps a background or glass filter: '+part);}
  }finally{Object.assign(draft,snapshot);root.style.cssText=sourceStyle;window.previewSettings.value.playerBar.mode=sourceMode;themeEditing.value=sourceEditing;tone.value=sourceTone;focused.value='overview';await settle();}
 },
 async navigationStates(){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument,originalExpanded=preview.value.navigationExpanded,draftSnapshot=JSON.stringify(draft);
  const fitNavigation=()=>{const hit=host.querySelector('[aria-label="调整侧边栏材质"]'),a=hit.getBoundingClientRect(),b=host.getBoundingClientRect(),source=doc.querySelector('.side-menu').getBoundingClientRect(),scale=Number(host.dataset.cameraScale);expect(Math.abs(a.width-source.width*scale)<0.1&&Math.abs(a.height-source.height*scale)<0.1,'navigation state leaves stale painted geometry');expect(a.left>=b.left&&a.top>=b.top&&a.right<=b.right+0.01&&a.bottom<=b.bottom+0.01,'navigation state is cropped');};
  try{
   document.documentElement.dataset.teMotion='off';focused.value='overview';if(!preview.value.navigationExpanded)preview.value.toggleNavigation();await settle();const expanded=sourceGeometry(doc);expect(expanded.navigation.width>72&&['主页','搜索','流媒体音乐','音乐库','最近播放'].every(label=>doc.querySelector('.side-menu').innerText.includes(label)),'expanded navigation loses its real width or labels');
   preview.value.toggleNavigation();await settle();const collapsed=sourceGeometry(doc);expect(preview.value.navigationExpanded===false&&collapsed.navigation.width===0&&collapsed.navigation.height===0&&doc.defaultView.getComputedStyle(doc.querySelector('[data-preview-module="navigation"]')).display==='none','collapsed navigation remains visible');expect(noExpandedNavigationHotspot(host),'collapsed navigation retains an interactive hotspot');expect(Math.abs(collapsed.background.left-expanded.background.left)<0.1&&Math.abs(collapsed.background.width-expanded.background.width)<0.1,'preview navigation overrides the real stable content shell');realScene(doc);sourceLayout(doc);focused.value='navigation';await settle();expect(noExpandedNavigationHotspot(host),'focusing the hidden module restores a ghost hotspot');focused.value='overview';await settle();
   preview.value.toggleNavigation();focused.value='navigation';await settle();expect(preview.value.navigationExpanded===true,'navigation does not expand again');unchangedGeometry(doc,expanded,'expanded navigation does not restore source layout');fitNavigation();expect(JSON.stringify(draft)===draftSnapshot,'navigation preview state changes the appearance draft');
  }finally{if(preview.value.navigationExpanded!==originalExpanded)preview.value.toggleNavigation();focused.value='overview';await settle();}
 },
 async imagePalette(){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument,snapshot=cloneAppearance(draft),originalTone=tone.value,originalEditing=themeEditing.value,originalExpanded=preview.value.navigationExpanded;let automaticCases=0;
  const computedColor=value=>{const probe=doc.createElement('span');probe.style.color=value;doc.body.append(probe);const color=doc.defaultView.getComputedStyle(probe).color;probe.remove();return color};
  try{
   document.documentElement.dataset.teMotion='off';themeEditing.value=false;tone.value='light';focused.value='overview';if(!preview.value.navigationExpanded)preview.value.toggleNavigation();draft.surfaceMaterial='standard';draft.cardAppearance.enabled=false;draft.liquidGlass.navigationEnabled=false;draft.liquidGlass.playbarEnabled=false;
   const background=draft.appBackground.global;Object.assign(background,{kind:'image',image:'background://panel-skin.png',customized:true,imagePalette:{image:'background://panel-skin.png',average:'#071323',accent:'#15744c'}});Object.assign(background.effects.light,{textTone:'theme',brightness:100,dim:0});
   for(const [average,expectedTone]of [['#071323','light'],['#f8f4ed','dark']]){background.imagePalette.average=average;await settle();const palette=resolveBackgroundPalette(background,'light'),root=doc.documentElement,paint=element=>doc.defaultView.getComputedStyle(element),navigation=doc.querySelector('.side-menu'),play=doc.querySelector('.btn-play');expect(root.dataset.teLocalImagePalette==='on'&&root.dataset.teLocalTextTone===expectedTone,'preview does not derive image foreground from its draft');expect(paint(navigation).getPropertyValue('--te-control-bg').trim()===palette.controlBackground,'image control variables did not reach the real sidebar');const surface=colorChannels(paint(navigation).backgroundColor);expect(surface[3]>180&&surface[3]<210&&paint(navigation).backdropFilter.includes('blur('),'image navigation lacks a translucent, diffused surface');for(const backdrop of [0,255]){const composite='#'+surface.slice(0,3).map(channel=>Math.round(channel*surface[3]/255+backdrop*(1-surface[3]/255)).toString(16).padStart(2,'0')).join('');expect((themeContrastRatio(paint(navigation).color,composite)||0)>=4.5,'navigation text lacks contrast over extreme backdrops: '+composite)}expect((themeContrastRatio(paint(play).color,paint(play).backgroundColor)||0)>=4.5,'automatic playback control lacks contrast');const card=paint(doc.querySelector('.online-hero'));expect(card.getPropertyValue('--te-card-bg-solid').trim()===palette.controlBackground&&card.backdropFilter.includes('blur('),'ordinary cards lack coordinated frosted material');automaticCases++;}
   background.effects.light.textTone='light';await settle();expect(doc.documentElement.dataset.teLocalTextTone==='light','automatic palette overrides manual text tone');background.kind='color';background.image='';delete background.imagePalette;background.effects.light.textTone='theme';await settle();expect(doc.documentElement.dataset.teLocalImagePalette==='off'&&doc.documentElement.dataset.teLocalTextTone==='theme'&&!doc.querySelector('style[data-appearance-preview-vars]').textContent.includes('--appearance-control-surface:'),'removed image leaves its palette in the preview');window.previewImagePalette={automaticCases,manualTextPreserved:true,removedPalette:true};
  }finally{Object.assign(draft,snapshot);tone.value=originalTone;themeEditing.value=originalEditing;if(preview.value.navigationExpanded!==originalExpanded)preview.value.toggleNavigation();focused.value='overview';await settle();}
 },
 async geometry(){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument,root=document.documentElement,sourceStyle=root.style.cssText,originalMode=window.previewSettings.value.playerBar.mode,originalEditing=themeEditing.value,originalTone=tone.value,snapshot=cloneAppearance(draft),settingsSnapshot=JSON.stringify(window.previewSettings.value),measurements=[];
  const box=selector=>{const element=doc.querySelector(selector);expect(element,'real geometry control is missing: '+selector);const rect=element.getBoundingClientRect();return {width:rect.width,height:rect.height}};
  const controls=()=>Object.fromEntries(['.menu-btn','.title-bar-icon','.window-control-icon','.menu-nav > .menu-item','.menu-nav > .menu-item .item-icon','.player-cover-slot','.btn-play,.mini-play-button','.player-title','.player-artist'].flatMap(selector=>doc.querySelector(selector)?[[selector,box(selector)]]:[]));
  try{
   root.dataset.teMotion='off';themeEditing.value=true;tone.value='dark';
   for(const [font,playSize,controlSize] of [[14,44,32],[20,55,64],[28,55,64]]){
    root.style.setProperty('--te-font-size-body',font+'px');root.style.setProperty('--te-player-play-size',playSize+'px');root.style.setProperty('--te-player-control-size',controlSize+'px');
    for(const mode of ['standard','mini','compact']){
     window.previewSettings.value.playerBar.mode=mode;focused.value='overview';await settle();realScene(doc);sourceLayout(doc);const source=sourceGeometry(doc),dimensions=controls(),bar=box('.player-bar'),play=box('.btn-play,.mini-play-button');
     expect(dimensions['.menu-btn'].width===46&&dimensions['.menu-btn'].height===40&&dimensions['.title-bar-icon'].width===18&&dimensions['.window-control-icon'].width===16,'real title bar no longer uses its actual slots and icons');
     expect(dimensions['.menu-nav > .menu-item'].height===40&&dimensions['.menu-nav > .menu-item .item-icon'].width===22&&dimensions['.menu-nav > .menu-item .item-icon'].height===22,'real navigation changes its fixed row or icon slot geometry: '+JSON.stringify({font,row:dimensions['.menu-nav > .menu-item'],icon:dimensions['.menu-nav > .menu-item .item-icon']}));expect(Math.abs(Number.parseFloat(doc.defaultView.getComputedStyle(doc.querySelector('.menu-nav > .menu-item .item-label')).fontSize)-font)<.1&&Math.abs(Number.parseFloat(doc.defaultView.getComputedStyle(doc.querySelector('.menu-nav > .menu-item .item-icon')).fontSize)-font*18/14)<.1,'real navigation label or glyph ignores the user font token');
     if(mode==='standard'){const playHeight=playSize*8/11,barHeight=Math.max(playHeight,controlSize)+Math.max(22,font*11/14*1.65+4)+18,coverSize=barHeight-20;expect(Math.abs(bar.height-barHeight)<.1&&Math.abs(dimensions['.player-cover-slot'].width-coverSize)<.1&&Math.abs(dimensions['.player-cover-slot'].height-coverSize)<.1&&Math.abs(play.width-playHeight*15/8)<.1&&Math.abs(play.height-playHeight)<.1,'standard player ignores its transport, progress and font token geometry: '+JSON.stringify({font,playSize,controlSize,bar,play,cover:dimensions['.player-cover-slot']}));}
     if(mode==='mini')expect(bar.height===40&&play.width===26&&play.height===26,'mini player differs from the real flat 40px source and 26px control');
     if(mode==='compact')expect(bar.height===72&&play.width===40&&play.height===40,'compact player differs from the real 72px source and 40px control');
     const overviewScale=uniformCamera(host);focused.value='player-bar';await settle();const fittedScale=uniformCamera(host);expect(fittedScale>overviewScale,'real player focus does not enlarge the common camera');preview.value.zoomIn();await settle();expect(uniformCamera(host)>fittedScale,'real controls do not zoom through the common camera');preview.value.fitPart();await settle();uniformCamera(host);unchangedGeometry(doc,source,'camera reflows a real window component');expect(JSON.stringify(controls())===JSON.stringify(dimensions),'zoom independently resizes real controls or typography');
     const hit=host.querySelector('[aria-label="调整播放条布局"]'),physical=hit.getBoundingClientRect(),native=doc.querySelector('.player-bar').getBoundingClientRect(),scale=uniformCamera(host);expect(Math.abs(physical.width-native.width*scale)<0.1&&Math.abs(physical.height-native.height*scale)<0.1,'real player controls are not transformed with the exact common scale');measurements.push({font,playSize,controlSize,mode,bar,play,scale});
    }
   }
   const savedBeforeDraft=JSON.stringify(window.previewSettings.value),detached=cloneAppearance({...draft,navigationPages:window.previewSettings.value.navigationPages,playerBar:window.previewSettings.value.playerBar});draft.navigationPages=detached.navigationPages;draft.playerBar=detached.playerBar;expect(draft.navigationPages!==window.previewSettings.value.navigationPages&&draft.playerBar!==window.previewSettings.value.playerBar,'appearance draft shares saved navigation or player objects');draft.navigationPages.order=['allSongs','local-home','search'];draft.navigationPages.hidden=['recent'];draft.playerBar.mode='mini';draft.playerBar.layout.mini={left:['trackInfo'],center:['playPause'],right:['volume','queue','time']};await settle();
   expect(JSON.stringify(navigationRows(doc))===JSON.stringify(['local-library','local-home','search','streaming'])&&doc.querySelector('.player-bar-shell').dataset.tePlaybarMode==='mini'&&JSON.stringify(playerArrangement(doc))===JSON.stringify({left:['trackInfo'],center:['playPause'],right:['volume','queue','time']}),'real preview does not prioritize cloned draft navigation and player settings');expect(JSON.stringify(window.previewSettings.value)===savedBeforeDraft,'editing the cloned draft changes saved settings');
   delete draft.navigationPages;delete draft.playerBar;window.previewSettings.value.playerBar.mode=originalMode;await settle();expect(JSON.stringify(navigationRows(doc))===JSON.stringify(['local-home','search','streaming','local-library','recent'])&&doc.querySelector('.player-bar-shell').dataset.tePlaybarMode===originalMode,'cancelling draft chrome does not return to saved settings');expect(JSON.stringify(window.previewSettings.value)===settingsSnapshot,'draft chrome cancellation changes saved settings');isolatedBoundary();window.previewGeometry={tokenCases:3,playerModes:3,draftSettingsUnchanged:true,measurements};
  }finally{delete draft.navigationPages;delete draft.playerBar;Object.assign(draft,snapshot);root.style.cssText=sourceStyle;window.previewSettings.value.playerBar.mode=originalMode;themeEditing.value=originalEditing;tone.value=originalTone;focused.value='overview';await settle();}
 },
 async prepareSurfaceClick(kind,index,layered){
  document.documentElement.dataset.teMotion='off';focused.value='overview';preview.value.setLayeredView(layered);if(preview.value.navigationExpanded)preview.value.toggleNavigation();await settle();
  const host=document.querySelector('.appearance-window-preview'),hits=[...host.querySelectorAll('[data-region="'+kind+'"]')];expect(hits.length>=2,'missing complete '+kind+' hit regions');
  const hit=hits[index===-1?hits.length-1:index],r=hit.getBoundingClientRect();selected='';window.surfaceChoice={kind,layered};return {x:r.left+r.width/2,y:r.top+r.height/2};
 },
 async restoreSurfaceClicks(){if(!preview.value.navigationExpanded)preview.value.toggleNavigation();preview.value.setLayeredView(true);focused.value='overview';await settle();},
 async checkSurfaceClick(){await settle();expect(selected===window.surfaceChoice.kind&&focused.value===window.surfaceChoice.kind,'surface click first selected background: '+JSON.stringify({choice:window.surfaceChoice,selected}));expect(document.querySelectorAll('.appearance-window-region[aria-pressed="true"]').length===1,'surface selection is duplicated');},
 async configuration(){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument,settings=JSON.parse(JSON.stringify(window.previewSettings.value)),draftSnapshot=JSON.stringify(draft),originalExpanded=preview.value.navigationExpanded;
  try{
   focused.value='overview';if(!preview.value.navigationExpanded)preview.value.toggleNavigation();await settle();expect(JSON.stringify(navigationRows(doc))===JSON.stringify(['local-home','search','streaming','local-library','recent']),'default navigation fixture does not represent the real app');
   window.previewSettings.value.navigationPages={version:1,order:['allSongs','local-home','search'],hidden:['recent']};await settle();expect(JSON.stringify(navigationRows(doc))===JSON.stringify(['local-library','local-home','search','streaming']),'preview ignores saved navigation order or hidden pages');realScene(doc);
   for(const mode of ['standard','compact','mini']){
    window.previewSettings.value.playerBar.layout[mode]={left:['trackInfo'],center:['playPause'],right:['volume','queue','time']};window.previewSettings.value.playerBar.mode=mode;await settle();const arrangement=playerArrangement(doc);expect(JSON.stringify(arrangement)===JSON.stringify({left:['trackInfo'],center:['playPause'],right:['volume','queue','time']}),'preview ignores saved control placement for '+mode+': '+JSON.stringify(arrangement));expect(!doc.querySelector('.player-cover-slot,.player-bar .player-controls,.player-bar .favorite-btn'),'removed player controls remain in the preview: '+mode);realScene(doc);
    const source=doc.querySelector('.player-bar').getBoundingClientRect();if(mode==='compact')expect(source.left===0&&source.right===doc.defaultView.innerWidth&&source.bottom===doc.defaultView.innerHeight&&doc.querySelector('.compact-progress-rail'),'compact player loses edge-to-edge placement or its progress rail');if(mode==='mini')expect(doc.querySelector('.mini-progress-rail')&&doc.querySelector('.mini-progress-time').textContent.includes('1:02')&&doc.querySelector('.mini-progress-time').textContent.includes('3:00'),'mini player loses its progress and necessary time labels');
   }
   expect(JSON.stringify(draft)===draftSnapshot&&window.nativeActions===0,'preview configuration mutates the appearance draft or invokes native behavior');window.previewConfiguration={navigationCases:2,customPlayerModes:3,nativeActions:window.nativeActions};
  }finally{window.previewSettings.value=settings;if(preview.value.navigationExpanded!==originalExpanded)preview.value.toggleNavigation();focused.value='overview';await settle();}
  expect(JSON.stringify(navigationRows(doc))===JSON.stringify(['local-home','search','streaming','local-library','recent'])&&doc.querySelectorAll('.player-bar .player-controls [data-playback-icon]').length===3,'restoring saved settings retains custom preview state');
 },
 async presetLayouts(){
  const root=document.documentElement,attributes=new Map([...root.attributes].map(attribute=>[attribute.name,attribute.value])),snapshot=JSON.parse(JSON.stringify(draft)),originalTone=tone.value,originalExpanded=preview.value.navigationExpanded,originalEditing=themeEditing.value,originalMode=window.previewSettings.value.playerBar.mode;
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument;let checked=0;
  try{
   document.documentElement.dataset.teMotion='off';themeEditing.value=true;draft.surfaceMaterial='standard';draft.liquidGlass.navigationEnabled=false;draft.liquidGlass.playbarEnabled=false;draft.cardAppearance.enabled=false;window.previewSettings.value.playerBar.mode='standard';
   for(const preset of BUILT_IN_THEME_PRESET_IDS)for(const nextTone of ['dark','light']){
    const profile=getBuiltInThemePreset(preset),key=nextTone==='dark'?'dark':'pureWhite';tone.value=nextTone;root.dataset.theme=key;root.dataset.tePresetLayout=preset.startsWith('builtin:')?preset.slice(8):preset;for(const [name,value] of Object.entries(themeModesToDataAttributes(resolveThemeProfileModes(profile))))root.setAttribute(name,value);for(const [name,value] of Object.entries(themeTokensToCssVariables(resolveThemeProfileTokens(profile,key))))root.style.setProperty(name,value);
    for(const expanded of [true,false]){
     if(preview.value.navigationExpanded!==expanded)preview.value.toggleNavigation();focused.value=expanded?'navigation':'overview';await settle();await doc.fonts.ready;
     await waitFor(()=>doc.documentElement.dataset.theme===key&&doc.documentElement.dataset.tePresetLayout===root.dataset.tePresetLayout&&doc.querySelector('body > .appearance-preview-scene')?.dataset.previewNavigation===(expanded?'expanded':'collapsed'),'preset layout does not commit its requested tone and navigation state: '+preset+' '+nextTone+' '+expanded);
     await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));await nextTick();realScene(doc);sourceLayout(doc);const source=sourceGeometry(doc),rail=resolveThemeProfileModes(profile).navigation.style==='rail';expect(expanded?source.navigation.width>=(rail?72:160):source.navigation.width===0&&source.navigation.height===0,'preset sidebar disagrees with its real overlay surface or expanded state: '+preset+' '+nextTone+' '+expanded+' '+source.navigation.width);
     const hit=host.querySelector('[aria-label="调整侧边栏材质"]'),b=host.getBoundingClientRect(),scale=uniformCamera(host);if(expanded){expect(hit,'expanded preset navigation hotspot missing');const a=hit.getBoundingClientRect();expect(Math.abs(a.width-source.navigation.width*scale)<0.1&&Math.abs(a.height-source.navigation.height*scale)<0.1&&a.left>=b.left&&a.top>=b.top&&a.right<=b.right+0.01&&a.bottom<=b.bottom+0.01,'preset navigation focus is stale or cropped: '+preset+' '+nextTone);if(rail)expect(navigationItems(doc).every(row=>doc.defaultView.getComputedStyle(row.querySelector('.item-label')).display==='none'),'rail navigation retains expanded labels');}else expect(!hit||hit.getBoundingClientRect().width<=80,'collapsed preset retains a full navigation hotspot: '+preset+' '+nextTone);checked++;
    }
   }
   expect(checked===BUILT_IN_THEME_PRESET_IDS.length*4,'preset layout matrix is incomplete');window.previewPresetCases=checked;
  }finally{
   for(const attribute of [...root.attributes])if(!attributes.has(attribute.name))root.removeAttribute(attribute.name);for(const [name,value] of attributes)root.setAttribute(name,value);Object.assign(draft,snapshot);tone.value=originalTone;themeEditing.value=originalEditing;window.previewSettings.value.playerBar.mode=originalMode;if(preview.value.navigationExpanded!==originalExpanded)preview.value.toggleNavigation();focused.value='overview';await settle();
  }
 },
 async prepareLayerFocus(nextTone){
  document.documentElement.dataset.teMotion='off';tone.value=nextTone;focused.value='card';preview.value.setLayeredView(true);await settle();document.querySelector('#menu-anchor').focus();const host=document.querySelector('.appearance-window-preview'),selected=host.querySelector('.appearance-layer-selection polygon:not(.is-keyboard-focus)');expect(selected&&getComputedStyle(selected).strokeWidth==='1px','3D selection has no native polygon contour');neutralContrast(getComputedStyle(selected).stroke,nextTone,true);expect(host.querySelectorAll('[aria-pressed="true"]').length===1&&host.querySelector('[data-region="card"]').getAttribute('aria-pressed')==='true','3D selection state is not unique');host.focus();
 },
 async checkLayerFocus(label){
  await nextTick();const host=document.querySelector('.appearance-window-preview'),active=document.activeElement,keyboard=host.querySelector('.appearance-layer-selection polygon.is-keyboard-focus'),selected=host.querySelector('.appearance-layer-selection polygon:not(.is-keyboard-focus)');expect(active.getAttribute('aria-label')===label&&active.matches(':focus-visible'),'native 3D Tab does not reach '+label);expect(keyboard&&getComputedStyle(keyboard).strokeWidth==='3px'&&selected&&getComputedStyle(selected).strokeWidth==='1px','3D keyboard focus is not separate from the selected plane');neutralContrast(getComputedStyle(keyboard).stroke,tone.value,true);const a=active.getBoundingClientRect(),b=keyboard.getBoundingClientRect();for(const edge of ['left','top','right','bottom'])expect(Math.abs(a[edge]-b[edge])<0.3,'3D keyboard contour does not follow its projected native control: '+label+' '+edge);expect(focused.value==='card'&&host.querySelectorAll('[aria-pressed="true"]').length===1,'3D keyboard traversal changes the selected plane');
 },
 async closeLayerFocus(){preview.value.setLayeredView(false);focused.value='overview';await settle();},
 async prepareSelectionFeedback(nextTone){
  const originalPrimary=document.documentElement.style.getPropertyValue('--te-primary-500');document.documentElement.dataset.teMotion='off';tone.value=nextTone;focused.value='card';await settle();const host=document.querySelector('.appearance-window-preview'),selected=host.querySelector('[aria-label="调整内容卡片"]');document.querySelector('#menu-anchor').focus();expect(host.querySelectorAll('[aria-pressed="true"]').length===1&&selected.getAttribute('aria-pressed')==='true'&&selected.classList.contains('is-selected'),'selected module is not uniquely exposed');expect(!selected.matches(':focus-visible')&&getComputedStyle(selected).outlineWidth==='2px'&&getComputedStyle(selected).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(selected).borderTopWidth==='0px'&&getComputedStyle(selected).boxShadow==='none','unfocused selection loses its neutral contour or paints over the scene');neutralContrast(getComputedStyle(selected).outlineColor,nextTone,false);expect(document.documentElement.style.getPropertyValue('--te-primary-500')===originalPrimary,'preview selection tone changes the host theme accent');host.focus();
 },
 async checkSelectionFocus(label){
  const host=document.querySelector('.appearance-window-preview'),active=document.activeElement,selected=host.querySelector('[aria-label="调整内容卡片"]');expect(active.getAttribute('aria-label')===label&&active.matches(':focus-visible'),'native Tab does not reach the module: '+label);expect(getComputedStyle(active).outlineWidth==='3px'&&getComputedStyle(active).outlineOffset==='-5px','keyboard focus has no stronger distinct contour');try{neutralContrast(getComputedStyle(active).outlineColor,tone.value,true)}catch(error){throw Error(error.message+' '+JSON.stringify({label,tone:tone.value,hover:active.matches(':hover'),hostStyle:host.style.cssText,hostFocus:getComputedStyle(host).getPropertyValue('--appearance-focus-color'),activeFocus:getComputedStyle(active).getPropertyValue('--appearance-focus-color'),outline:getComputedStyle(active).outline}))}expect(host.querySelectorAll('[aria-pressed="true"]').length===1&&selected.getAttribute('aria-pressed')==='true'&&focused.value==='card','keyboard traversal changes the selected module');expect(getComputedStyle(selected).outlineWidth===(active===selected?'3px':'2px'),'selection and keyboard focus are indistinguishable');
 },
 async glassProfiles(){
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument,original=JSON.stringify(draft),snapshot=JSON.parse(original),originalTone=tone.value,originalAdaptive=document.documentElement.getAttribute('data-te-liquid-glass-adaptive-tone');
  const variable=name=>doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue(name).trim(),opticalScale=()=>Number(doc.querySelector('#te-lg-playbar feDisplacementMap').getAttribute('scale'));
  tone.value='light';draft.liquidGlass.playbarEnabled=true;draft.liquidGlass.overLight=true;draft.liquidGlass.adaptiveTone=false;
  Object.assign(draft.liquidGlass.light,{blurAmount:7,tintOpacity:12,saturation:133,displacementScale:31});Object.assign(draft.liquidGlass.dark,{blurAmount:19,tintOpacity:47,saturation:177,displacementScale:68});
  draft.cardAppearance.enabled=true;draft.cardAppearance.light.backgroundColor='#667788';draft.cardAppearance.dark.backgroundColor='#bbccdd';draft.appBackground.global.light='#e6e8ee';draft.appBackground.global.customized=true;document.documentElement.dataset.teLiquidGlassAdaptiveTone='light';await settle();
  expect(preview.value.glassTone==='dark'&&host.dataset.glassTone==='dark','forced dark tone is not exposed');expect(variable('--te-lg-blur')==='19px'&&Number(variable('--te-lg-tint'))===0.47&&variable('--te-lg-saturate')==='177%','forced glass preview uses light tuning');
  expect(doc.documentElement.dataset.theme==='pureWhite'&&variable('--te-app-bg')==='#e6e8ee'&&variable('--te-card-bg')==='#667788ff','glass override changes background, card or application tone');const darkScale=opticalScale();expect(darkScale>0,'rendered optical profile has no displacement input');expect(doc.querySelector('#te-lg-playbar feImage').getAttribute('href').startsWith('data:image/png'),'isolated preview has no raster for its own playback geometry');
  draft.liquidGlass.overLight=false;document.documentElement.dataset.teLiquidGlassAdaptiveTone='dark';await settle();expect(preview.value.glassTone==='light'&&variable('--te-lg-blur')==='7px'&&opticalScale()<darkScale,'disabled adaptation still uses the dark profile');
  draft.liquidGlass.adaptiveTone=true;await settle();expect(preview.value.glassTone==='dark'&&variable('--te-lg-blur')==='19px'&&opticalScale()===darkScale,'adaptive CSS and optical profile disagree');const adaptiveDraft=JSON.stringify(draft);document.documentElement.dataset.teLiquidGlassAdaptiveTone='light';await settle();expect(preview.value.glassTone==='light'&&variable('--te-lg-blur')==='7px'&&JSON.stringify(draft)===adaptiveDraft,'root environment change mutates the theme draft or retains dark tuning');
  expect(doc.documentElement.dataset.theme==='pureWhite'&&variable('--te-app-bg')==='#e6e8ee'&&variable('--te-card-bg')==='#667788ff','adaptive change leaks its tone into non-glass settings');
  Object.assign(draft,snapshot);tone.value=originalTone;if(originalAdaptive===null)document.documentElement.removeAttribute('data-te-liquid-glass-adaptive-tone');else document.documentElement.setAttribute('data-te-liquid-glass-adaptive-tone',originalAdaptive);await settle();expect(JSON.stringify(draft)===original,'glass preview restoration changed the snapshot');
 },
 async prepareDrag(){focused.value='card';await settle();const host=document.querySelector('.appearance-window-preview'),rect=host.getBoundingClientRect();window.beforeDrag=host.querySelector('.appearance-editor-world').style.transform;window.selectionBeforeDrag=selected;return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};},
 async checkDrag(){await settle();const host=document.querySelector('.appearance-window-preview');expect(host.querySelector('.appearance-editor-world').style.transform!==window.beforeDrag,'drag does not pan camera');expect(selected===window.selectionBeforeDrag&&window.nativeActions===0,'drag accidentally selects or invokes real action');preview.value.fitPart();focused.value='overview';await settle();},
 async beginWorkshop(){
  const root=document.documentElement;workshopOriginal={attributes:[...root.attributes].map(attribute=>[attribute.name,attribute.value]),draft:JSON.stringify(draft),settings:JSON.stringify(window.previewSettings.value),tone:tone.value,themeEditing:themeEditing.value,navigationExpanded:preview.value.navigationExpanded};
  const project=createWorkshopProject('shared-canvas-fixture','共享工坊验证');
  for(const nextTone of ['dark','pureWhite']){
   const app=nextTone==='dark'?'#12232f':'#f4e3e8',primary=nextTone==='dark'?'#127b93':'#8b365a';
   project.tokens[nextTone]={'surface.app':app,'surface.local':app,'color.primary.500':primary};
   project.layers??={pureWhite:{},dark:{}};
   project.layers[nextTone].app=[{...createWorkshopLayer('qa-gradient','gradient'),name:'可拖动渐变',width:36,height:18},{...createWorkshopLayer('paint-probe','gradient'),name:'应用图层绘制',x:94,y:8,width:8,height:5,colorStart:'#de3f75',colorEnd:'#de3f75'}];
  }
  project.modes={library:{density:'compact',selection:'stroke'}};
  project.css="html[data-theme='pureWhite'] .settings-preview-page label{color:#888888!important;background-color:#888888!important}";
  root.style.setProperty('--te-app-bg','#00ff00','important');root.style.setProperty('--te-primary-500','#00ffff','important');root.style.setProperty('--appearance-color','#ff0000','important');root.dataset.teLibraryDensity='comfortable';for(const page of ['app','local','settings','streaming','player'])root.setAttribute('data-te-'+page+'-image-palette','on');
  for(const id of ['workshop-trial','twilight-theme-runtime']){expect(!document.getElementById(id),'fixture would replace a live host theme stylesheet');const style=document.createElement('style');style.id=id;style.textContent='html[data-theme]{--te-app-bg:#ff00ff!important;--te-primary-500:#ffff00!important;--preview-host-theme-leak:yes!important}';document.head.append(style);workshopHostStyles.push(style);}
  document.documentElement.dataset.teMotion='off';tone.value='dark';themeEditing.value=false;preview.value.setLayeredView(false);focused.value='overview';
  workshopModel.value={project,css:compileWorkshopProject(project),scene:{tone:'dark',surface:'dashboard',width:1180,state:'normal'},selectedLayer:'',canvasEditing:false,checking:false};
  window.previewWorkshop={surfaceCases:0,frames:0,runtimeOverrides:false,diagnosticWarning:false,hiddenRejections:0,hiddenChildWrites:0,resumeLatestWrites:0,dragCases:0,cameraUnchanged:true,layerCount:0,committedInspections:0,interactiveControls:0,draftUnchanged:false};
  await setWorkshopScene(workshopScenes[0]);
 },
 async workshopScene(index){
  const scene=workshopScenes[index];await setWorkshopScene(scene);const {host,frame,doc,source}=workshopContext(),paint=doc.defaultView.getComputedStyle(doc.documentElement);
  expect(document.querySelectorAll('iframe').length===1&&doc.querySelectorAll('iframe').length===0,'workshop mounts a second preview iframe');
  expect(source?.querySelector(scene.selector),'shared workshop did not mount its real surface: '+scene.surface);
  expect(source.classList.contains('app-shell')&&doc.querySelector('.appearance-window-background'),'shared workshop loses the common scene/background contract');
  const appPaint=workshopSnapshot().appDecoration;expect(appPaint.backgroundZ==='-2'&&appPaint.decorationZ==='-1'&&appPaint.probeDisplay==='block'&&appPaint.probeFill.includes('222, 63, 117')&&appPaint.probeOpacity==='1','shared app layer loses its direct paint or stacking contract: '+JSON.stringify(appPaint));
  expect(doc.defaultView.innerWidth===scene.width&&doc.defaultView.innerHeight===760&&Number(host.dataset.sourceWidth)===scene.width,'shared workshop lays out at a stale or thumbnail source size');
  expect(source.dataset.workshopSurface===scene.surface&&source.dataset.workshopState===scene.state&&doc.documentElement.dataset.theme===scene.tone,'shared workshop retains a stale page surface, state or tone');
  for(const [attribute,value] of Object.entries(workshopRuntimeAttributes(workshopModel.value.project)))expect(doc.documentElement.getAttribute(attribute)===value,'shared workshop runtime attribute overridden by the host: '+attribute);
  const expectedApp=scene.tone==='dark'?'#12232f':'#f4e3e8',expectedPrimary=scene.tone==='dark'?'#127b93':'#8b365a';
  expect(paint.getPropertyValue('--te-app-bg').trim()===expectedApp&&paint.getPropertyValue('--te-primary-500').trim()===expectedPrimary,'compiled workshop CSS loses to host inline/default theme: '+JSON.stringify(workshopSnapshot()));
  expect(doc.documentElement.style.getPropertyValue('--te-app-bg')===''&&paint.getPropertyValue('--preview-host-theme-leak').trim()==='','host theme inline variables or trial/runtime CSS leak into the shared project');
  expect(['app','local','settings','streaming','player'].every(page=>!doc.documentElement.hasAttribute('data-te-'+page+'-image-palette')),'host image palette leaks into an independent workshop project');
  expect(doc.documentElement.dataset.teLibraryDensity==='compact'&&document.documentElement.dataset.teLibraryDensity==='comfortable','workshop mode contaminates or follows the host');
  const surfaceClasses=[...doc.body.classList].filter(value=>['te-local-surface','te-streaming-surface','te-settings-surface'].includes(value));expect(surfaceClasses.length===1&&surfaceClasses[0]===(scene.surface.startsWith('streaming')?'te-streaming-surface':scene.surface==='settings'?'te-settings-surface':'te-local-surface'),'shared workshop retains conflicting body surface classes: '+surfaceClasses);
  expect(!/PRIVATE_.*_SENTINEL/.test(source.outerHTML),'workshop exposes private library, playback or account attributes');
  if(scene.surface==='library'){expect(!source.querySelector('.song-list .song-title'),'empty workshop library renders private or stale tracks');expect(source.querySelector('.song-list .search-input').value==='','workshop reads the live library search query');}
  if(scene.surface==='streaming-list')expect(source.querySelector('.streaming-content .selected'),'selected workshop state is not reflected by the real track row');
  if(scene.surface==='settings'){
   expect(frame.getAttribute('aria-hidden')==='false'&&frame.tabIndex===0&&getComputedStyle(frame).pointerEvents==='auto','settings experience does not expose the real iframe for native input');
   const diagnostics=await preview.value.inspectWorkshop();expect(Array.isArray(diagnostics)&&diagnostics.some(item=>item.code==='preview.contrast'&&item.severity==='warning'&&item.location?.kind==='preview'),'shared inspection does not inspect the actual low-contrast project controls: '+JSON.stringify(diagnostics));window.previewWorkshop.diagnosticWarning=true;
   const title=source.querySelector('.title-bar'),nav=source.querySelector('.side-menu'),originalTitle=title.style.outline;title.style.outline='1px solid rgb(17, 34, 51)';const customOutline=title.style.outline;preview.value.highlightWorkshop('.title-bar');expect(title.style.outline!==customOutline,'diagnostic highlight not applied');preview.value.highlightWorkshop('.side-menu');expect(title.style.outline===customOutline&&nav.style.outline.includes('77, 80, 86'),'repeat light diagnostic highlight fails to restore the previous outline or uses dark colors');title.style.outline=originalTitle;
  }else expect(frame.getAttribute('aria-hidden')==='true'&&getComputedStyle(frame).pointerEvents==='none','noninteractive workshop surface exposes real native controls');
  uniformCamera(host);isolatedBoundary();window.previewWorkshop.surfaceCases++;window.previewWorkshop.frames=1;window.previewWorkshop.runtimeOverrides=true;return workshopSnapshot();
 },
 async workshopHidden(){
  await setWorkshopScene(workshopScenes[0]);const {doc}=workshopContext(),root=document.documentElement,descriptor=Object.getOwnPropertyDescriptor(document,'hidden');let hidden=false;Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden});
  const rejection=async()=>{const start=performance.now(),result=await Promise.race([preview.value.inspectWorkshop().then(()=>({ok:true}),error=>({error:String(error)})),new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),300))]);expect(result.error?.includes('不可见')&&!result.timeout&&performance.now()-start<300,'hidden shared inspection hangs or falsely completes: '+JSON.stringify(result));window.previewWorkshop.hiddenRejections++;};
  try{
   hidden=true;document.dispatchEvent(new Event('visibilitychange'));await settle();let writes=0;const observer=new MutationObserver(records=>{writes+=records.length});observer.observe(doc.documentElement,{subtree:true,attributes:true,childList:true,characterData:true});await rejection();
   for(let index=0;index<100;index++){const current=workshopModel.value,project=copyWorkshopDraft(current.project);project.tokens.dark['surface.app']=index===99?'#112244':'#223344';workshopModel.value={...current,project,css:compileWorkshopProject(project),scene:{...current.scene,state:index===99?'done':'loading'}};root.dataset.previewWorkshopRevision=String(index);await Promise.resolve();}
   await settle();observer.disconnect();expect(writes===0,'hidden workshop continues writing child DOM: '+writes);window.previewWorkshop.hiddenChildWrites=writes;
   let latest=0;const resumeObserver=new MutationObserver(records=>{latest+=records.filter(record=>record.target===doc.documentElement&&record.attributeName==='data-preview-workshop-revision').length});resumeObserver.observe(doc.documentElement,{attributes:true});hidden=false;document.dispatchEvent(new Event('visibilitychange'));await settle();await waitFor(()=>doc.documentElement.dataset.previewWorkshopRevision==='99'&&doc.querySelector('.appearance-preview-scene')?.dataset.workshopState==='done','visible workshop resumes an old project model');resumeObserver.disconnect();expect(latest===1&&doc.defaultView.getComputedStyle(doc.documentElement).getPropertyValue('--te-app-bg').trim()==='#112244','workshop resume publishes stale/intermediate models: '+latest);window.previewWorkshop.resumeLatestWrites=latest;
   previewActive.value=false;await settle();await rejection();previewActive.value=true;await settle();
  }finally{hidden=false;if(descriptor)Object.defineProperty(document,'hidden',descriptor);else delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));await settle();}
  const current=workshopModel.value,project=copyWorkshopDraft(current.project);project.tokens.dark['surface.app']='#12232f';workshopModel.value={...current,project,css:compileWorkshopProject(project)};await settle();
 },
 async workshopCommittedInspections(){
  await setWorkshopScene(workshopScenes[4]);
  for(const surface of ['library','settings']){
   workshopModel.value={...workshopModel.value,scene:{tone:'pureWhite',width:640,state:'done',surface}};
   const diagnostics=await preview.value.inspectWorkshop(),{doc,source}=workshopContext();
   expect(source.dataset.workshopSurface===surface&&source.dataset.workshopState==='done'&&!!source.querySelector('.song-list')===(surface==='library')&&!!source.querySelector('.settings-preview-page')===(surface==='settings'),'shared inspect completes on the previous surface when state, width and tone are unchanged: '+JSON.stringify(workshopSnapshot()));
   expect(Array.isArray(diagnostics)&&doc.documentElement.dataset.teLibraryDensity==='compact'&&source.querySelector(':scope > .workshop-decoration'),'shared inspect runs before runtime modes or actual decorations are committed');window.previewWorkshop.committedInspections++;
  }
 },
 async prepareWorkshopDrag(nextTone='dark'){
  await setWorkshopScene({...workshopScenes[0],tone:nextTone,width:nextTone==='dark'?1180:640},true);
  const {host,doc}=workshopContext(),overlay=host.querySelector('.workshop-canvas-overlay'),box=workshopCanvasBoxes(doc,workshopModel.value.project,nextTone).find(box=>box.id==='qa-gradient');
  expect(overlay&&box&&box.width>0&&box.height>0,'shared 2D workshop is missing a real layer overlay');
  const rect=overlay.getBoundingClientRect(),scale=rect.width/workshopModel.value.scene.width,point={x:rect.left+(box.left+box.width/2)*scale,y:rect.top+(box.top+box.height/2)*scale};
  const viewport=host.getBoundingClientRect();expect(point.x>viewport.left&&point.x<viewport.right&&point.y>viewport.top&&point.y<viewport.bottom,'layer point is outside the shared camera viewport');
  workshopDrag={tone:nextTone,scale,box,layer:{...workshopModel.value.project.layers[nextTone].app[0]},events:workshopEvents.length,camera:host.querySelector('.appearance-editor-world').style.transform};
  return point;
 },
 async checkWorkshopDrag(){
  await settle();const {host}=workshopContext(),model=workshopModel.value,layer=model.project.layers[workshopDrag.tone].app[0],events=workshopEvents.slice(workshopDrag.events),selection=host.querySelector('.workshop-layer-selection');
  expect(events.some(event=>event.kind==='select'&&event.id==='qa-gradient'&&event.surface==='app')&&events.some(event=>event.kind==='edit'&&event.id==='qa-gradient'&&event.surface==='app'),'shared layer drag does not emit select/edit with the project surface: '+JSON.stringify(events));
  expect(JSON.stringify(events.filter(event=>event.kind==='gesture').map(event=>event.action))===JSON.stringify(['begin','end']),'shared layer drag loses or cancels its gesture: '+JSON.stringify(events));
  const expectedX=workshopDrag.layer.x+20/workshopDrag.scale/workshopDrag.box.hostWidth*100,expectedY=workshopDrag.layer.y+10/workshopDrag.scale/workshopDrag.box.hostHeight*100;
  expect(Math.abs(layer.x-expectedX)<0.05&&Math.abs(layer.y-expectedY)<0.05,'shared layer drag uses host or stale camera coordinates: '+JSON.stringify({layer,expectedX,expectedY,scale:workshopDrag.scale}));
  expect(host.querySelector('.appearance-editor-world').style.transform===workshopDrag.camera,'shared layer gesture pans the editor camera');
  expect(selection&&getComputedStyle(selection).borderTopColor===(workshopDrag.tone==='dark'?'rgb(222, 222, 222)':'rgb(77, 80, 86)'),'shared overlay does not inherit the tone-correct neutral selection color');
  isolatedBoundary();window.previewWorkshop.dragCases++;return workshopSnapshot();
 },
 async workshopLayered(){
  await setWorkshopScene(workshopScenes[0],true);preview.value.setLayeredView(true);await settle();const {host,doc,source}=workshopContext();await waitForPreviewView(host,'shared workshop 3D view never finishes unfolding',true);const layers=doc.querySelector('.appearance-layer-view');
  await waitFor(()=>layers&&doc.defaultView.getComputedStyle(layers).opacity==='1','shared workshop 3D did not finish revealing');
  expect(host.dataset.previewView==='layered'&&!host.querySelector('.workshop-canvas-overlay'),'3D workshop retains a misleading 2D layer-edit overlay');
  expect(layers.querySelectorAll('[data-appearance-layer]').length===6&&source.style.visibility==='hidden','shared workshop fails to reuse the six-layer view or paints a second source');
  expect(layers.querySelector('.workshop-decoration')&&layers.querySelector('.app-shell-title .title-bar')&&layers.querySelector('.player-bar'),'shared 3D loses project decorations or real chrome');
  const diagnostics=await preview.value.inspectWorkshop();expect(Array.isArray(diagnostics)&&source.style.visibility==='hidden','3D diagnostics reveal a duplicate source scene');
  window.previewWorkshop.layerCount=6;return workshopSnapshot();
 },
 async leaveWorkshopLayered(){preview.value.setLayeredView(false);await settle();const {host,doc,source}=workshopContext();await waitForPreviewView(host,'shared workshop 2D view never finishes restoring',false);expect(!doc.querySelector('.appearance-layer-view')&&source.style.visibility!=='hidden'&&host.querySelector('.workshop-canvas-overlay'),'return to shared 2D does not restore layer editing');},
 async prepareWorkshopInput(kind){
  await setWorkshopScene(workshopScenes[4],false);const {host,frame,doc,source}=workshopContext(),input=source.querySelector(kind==='checkbox'?'input[type=checkbox]':'input:not([type])');
  if(preview.value.navigationExpanded){const nav=source.querySelector('.side-menu').getBoundingClientRect(),content=source.querySelector('.main-content').getBoundingClientRect();expect(source.dataset.previewNavigation==='expanded'&&nav.width>0&&content.left<nav.right&&content.right>nav.right,'settings fixture does not exercise the real expanded overlay navigation');preview.value.toggleNavigation();await settle();}
  expect(source.dataset.previewNavigation==='collapsed'&&doc.defaultView.getComputedStyle(source.querySelector('.app-shell-navigation')).display==='none'&&source.querySelector('.side-menu').getBoundingClientRect().width===0,'public navigation collapse does not remove the real sidebar from the experience surface');
  expect(input&&!input.closest('[inert]')&&!host.querySelector('.workshop-canvas-overlay,.appearance-window-region')&&getComputedStyle(frame).pointerEvents==='auto','experience controls are blocked by an inert scene, overlay or hotspot');
  const control=input.getBoundingClientRect();expect(control.width>0&&control.height>0&&doc.elementFromPoint(control.left+control.width/2,control.top+control.height/2)===input,'collapsed navigation still blocks the native settings input hit target');
  window.workshopInput={kind,before:kind==='checkbox'?input.checked:input.value};return workshopPoint(input);
 },
 async checkWorkshopInput(){
  await settle();const {source}=workshopContext(),{kind,before}=window.workshopInput,input=source.querySelector(kind==='checkbox'?'input[type=checkbox]':'input:not([type])');
  expect(kind==='checkbox'?input.checked!==before:input.value==='shared-editor-input','native input does not reach the settings iframe: '+JSON.stringify({kind,before,current:kind==='checkbox'?input.checked:input.value}));
  isolatedBoundary();window.previewWorkshop.interactiveControls++;
 },
 async setWorkshopPaint(visible){
  const {doc,source}=workshopContext();
  if(!visible){const shown=doc.querySelector('.appearance-layer-view [data-appearance-layer-scene]')??source,probe=shown.querySelector(':scope > .workshop-decoration')?.children[1];expect(probe&&!probe.closest('[data-appearance-material-context]'),'visible shared scene has no direct app paint probe');window.workshopPaintRestore={probe,value:probe.style.getPropertyValue('display'),priority:probe.style.getPropertyPriority('display'),kind:shown===source?'source':'clone'};probe.style.setProperty('display','none','important');expect(doc.defaultView.getComputedStyle(probe).display==='none','paint difference did not hide its actual direct app probe');}
  else{const {probe,value,priority}=window.workshopPaintRestore;if(value)probe.style.setProperty('display',value,priority);else probe.style.removeProperty('display');delete window.workshopPaintRestore;}
  await new Promise(resolve=>doc.defaultView.requestAnimationFrame(()=>doc.defaultView.requestAnimationFrame(resolve)));
  if(!visible){const {probe,kind}=window.workshopPaintRestore;return {kind,display:doc.defaultView.getComputedStyle(probe).display,rect:probe.getBoundingClientRect().toJSON()};}
 },
 async finishWorkshop(){
  preview.value.setLayeredView(false);workshopModel.value=undefined;for(const style of workshopHostStyles)style.remove();workshopHostStyles=[];
  const root=document.documentElement;for(const attribute of [...root.attributes])root.removeAttribute(attribute.name);for(const [name,value]of workshopOriginal.attributes)root.setAttribute(name,value);tone.value=workshopOriginal.tone;themeEditing.value=workshopOriginal.themeEditing;if(preview.value.navigationExpanded!==workshopOriginal.navigationExpanded)preview.value.toggleNavigation();focused.value='overview';await settle();
  expect(JSON.stringify(draft)===workshopOriginal.draft&&JSON.stringify(window.previewSettings.value)===workshopOriginal.settings,'shared workshop changes daily appearance or playback settings');expect(liveSearchProbe()==='PRIVATE_SEARCH_SENTINEL','workshop overwrites the live library search query');realScene(workshopContext().doc);window.previewWorkshop.draftUnchanged=true;return window.previewWorkshop;
 },
 async visual(nextTone,part,expanded,layered=false,spacing=56){
  if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
  document.body.classList.add('visual-qa');document.documentElement.dataset.teMotion='off';tone.value=nextTone;focused.value=part;themeEditing.value=false;Object.assign(draft,{appBackground:normalizeAppBackgroundSettings(null),cardAppearance:defaultCardAppearance(),surfaceMaterial:'standard',liquidGlass:normalizeLiquidGlass(null)});window.previewSettings.value.playerBar.mode='standard';document.documentElement.dataset.theme=nextTone==='dark'?'dark':'pureWhite';for(const [name,value] of Object.entries(themeTokensToCssVariables(TWILIGHT_DEFAULT_THEME.variants[nextTone==='dark'?'dark':'pureWhite'].tokens)))document.documentElement.style.setProperty(name,value);await settle();
  if(preview.value.navigationExpanded!==expanded){preview.value.toggleNavigation();await settle();}preview.value.setLayerSpacing(spacing);preview.value.setLayeredView(layered);await settle();
  const host=document.querySelector('.appearance-window-preview'),doc=host.querySelector('iframe').contentDocument;await doc.fonts.ready;realScene(doc);const bounds=host.getBoundingClientRect();expect(!host.querySelector('.appearance-window-region:focus-visible,.appearance-window-region:hover'),'visual fixture retains a previous keyboard or pointer focus');expect(bounds.left>=0&&bounds.top>=0&&bounds.right<=innerWidth&&bounds.bottom<=innerHeight,'visual fixture does not fit the viewport');
  const focusedShape=part==='overview'||part==='background'||part==='navigation'&&!expanded?host:host.querySelector('[aria-label="'+{navigation:'调整侧边栏材质',material:'调整标题栏材质','player-bar':'调整播放条布局',card:'调整内容卡片'}[part]+'"]');const selectedRect=focusedShape.getBoundingClientRect();expect(selectedRect.left>=bounds.left&&selectedRect.top>=bounds.top&&selectedRect.right<=bounds.right+0.01&&selectedRect.bottom<=bounds.bottom+0.01,'visual focused part is cropped: '+part);if(!expanded)expect(noExpandedNavigationHotspot(host)&&sourceGeometry(doc).navigation.width===0,'closed visual fixture retains the sidebar');
  const layerRoot=doc.querySelector('.appearance-layer-view');if(layered){expect(layerRoot&&layerRoot.inert&&Number(doc.defaultView.getComputedStyle(layerRoot).opacity)===1,'visual 3D clone is unavailable or still revealing');faithfulGlyphs(doc,layerRoot);expect(doc.querySelector('body > .appearance-preview-scene').style.visibility==='hidden','visual 3D duplicates the visible native source');}else expect(!layerRoot,'flat visual retains a layered clone');
  return {rendering:'native TitleBar / SideMenu / OnlineHome / PlayerBar',view:host.dataset.previewView,layerSpacing:preview.value.layerSpacing,layerCount:layerRoot?.querySelectorAll('[data-appearance-layer]').length??0,navigationRelief:host.dataset.navigationRelief,tone:nextTone,part,navigationExpanded:preview.value.navigationExpanded,width:innerWidth,height:innerHeight,loadingPhase:host.dataset.loadingPhase,visibleText:doc.body.innerText.trim(),cameraScale:uniformCamera(host),source:sourceGeometry(doc),boundary:{...window.previewBoundary}};
 },
 async resized(){await settle();const host=document.querySelector('.appearance-window-preview'),rect=host.getBoundingClientRect();expect(+host.dataset.sourceWidth===innerWidth&&+host.dataset.sourceHeight===innerHeight,'source viewport stale');expect(Math.abs(rect.width/rect.height-innerWidth/innerHeight)<0.003,'resize distorted preview');
 visible.value=false;await settle();document.head.append(document.createElement('style'));window.dispatchEvent(new Event('resize'));await settle();expect(!document.querySelector('iframe'),'preview retained after unmount');app.unmount();}
};
`
const runner = `
const {app,BrowserWindow,protocol}=require('electron'),path=require('node:path'),fs=require('node:fs/promises'),{PNG}=require(${JSON.stringify(require.resolve('pngjs'))});app.setPath('userData',path.join(__dirname,'profile'));
protocol.registerSchemesAsPrivileged(['background','theme-asset'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}})));
app.whenReady().then(async()=>{let win;const captureCssPage=async()=>{const image=await win.webContents.capturePage(),viewport=await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})'),size=image.getSize();return size.width===viewport.width&&size.height===viewport.height?image:image.resize({...viewport,quality:'best'});};try{
 const delayedSkins=new Set();protocol.handle('background',async request=>{console.log('PREVIEW_LOCAL_IMAGE',request.url);const url=new URL(request.url);if(['panel-skin-dark.png','panel-skin-light.png'].includes(url.hostname)&&!delayedSkins.has(url.hostname)){delayedSkins.add(url.hostname);await new Promise(resolve=>setTimeout(resolve,500))}return ['panel-skin.png','panel-skin-dark.png','panel-skin-light.png'].includes(url.hostname)?new Response(await fs.readFile(path.join(__dirname,'panel-skin.png')),{headers:{'Content-Type':'image/png','Access-Control-Allow-Origin':'*','Cache-Control':'public,max-age=31536000,immutable'}}):new Response('',{status:404})});
 protocol.handle('theme-asset',async request=>{const url=new URL(request.url),file=url.pathname.endsWith('/icons/first.png')?'panel-skin.png':url.pathname.endsWith('/icons/second.png')?'icon-blue.png':null;return file?new Response(await fs.readFile(path.join(__dirname,file)),{headers:{'Content-Type':'image/png','Access-Control-Allow-Origin':'*'}}):new Response('',{status:404})});
 win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 // Windows can return physical capture pixels even when renderer devicePixelRatio is 1.
 // Keep CSS-coordinate samples aligned without weakening their color/difference thresholds.
 let externalRequests=0;win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,reply)=>{externalRequests++;reply({cancel:true})});
 win.webContents.on('console-message',event=>{if(event.level==='error')console.error(event.message)});
 await win.loadFile(path.join(__dirname,'index.html'));await win.webContents.executeJavaScript('window.fixture.initial()');
 if(process.env.TE_PREVIEW_DEPTH_ONLY){await win.webContents.executeJavaScript('window.fixture.cameraZoomBehavior()');console.log('PREVIEW_RELIEF',JSON.stringify(await win.webContents.executeJavaScript('window.fixture.reliefGeometry()')));console.log('PREVIEW_DEPTH_OK');win.destroy();app.exit(0);return;}
 console.log('PREVIEW_RELIEF',JSON.stringify(await win.webContents.executeJavaScript('window.fixture.reliefGeometry()')));
 await win.webContents.executeJavaScript('window.fixture.imagePalette()');console.log('PREVIEW_IMAGE_PALETTE',JSON.stringify(await win.webContents.executeJavaScript('window.previewImagePalette')));
 await win.webContents.executeJavaScript('window.fixture.backgroundOwnership()');console.log('PREVIEW_BACKGROUND_OWNERSHIP',JSON.stringify(await win.webContents.executeJavaScript('window.previewBackgroundOwnership')));
 console.log('PREVIEW_HOME',JSON.stringify(await win.webContents.executeJavaScript('window.previewHome')));
 console.log('PREVIEW_PERF',JSON.stringify(await win.webContents.executeJavaScript('window.previewPerf')));
 // The real shell reserves sidebar clearance on wide windows. Exercise its
 // overlapping navigation state below the 900px responsive breakpoint.
 win.setContentSize(880,800);
 await win.webContents.executeJavaScript('window.fixture.canvasBehavior()');
 win.webContents.debugger.attach('1.3');
 for(const kind of ['blank','background']){const point=await win.webContents.executeJavaScript('window.fixture.prepareCanvasReset('+JSON.stringify(kind)+')');await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});await win.webContents.executeJavaScript('window.fixture.checkCanvasReset()');}
 console.log('PREVIEW_CANVAS',JSON.stringify(await win.webContents.executeJavaScript('window.previewCanvas')));
 win.setContentSize(1280,800);
 await win.webContents.executeJavaScript('window.fixture.beginFloating()');
 for(const [width,height]of [[1280,800],[960,640],[640,640]]){win.setContentSize(width,height);for(const [part,layered]of [['material',false],['navigation',false],['player-bar',true]])await win.webContents.executeJavaScript('window.fixture.floatingGeometry('+JSON.stringify(part)+','+layered+')');}
 win.setContentSize(1280,800);await win.webContents.executeJavaScript('window.fixture.floatingMotion()');
 for(const kind of ['range','text','action']){
  const point=await win.webContents.executeJavaScript('window.fixture.prepareFloatingControl('+JSON.stringify(kind)+')');
  if(kind==='action'){await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});}
  if(kind==='text'){await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,nativeVirtualKeyCode:65,modifiers:2});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,nativeVirtualKeyCode:65,modifiers:2});await win.webContents.debugger.sendCommand('Input.insertText',{text:'edited floating input'});}
  const [key,code,virtualKey,modifiers]=kind==='range'?['ArrowRight','ArrowRight',39,0]:kind==='text'?['z','KeyZ',90,2]:['Escape','Escape',27,0];await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey,modifiers});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey,modifiers});await win.webContents.executeJavaScript('window.fixture.checkFloatingControl('+JSON.stringify(kind)+')');
 }
 console.log('PREVIEW_FLOATING',JSON.stringify(await win.webContents.executeJavaScript('window.fixture.finishFloating()')));
 for(const [width,height]of [[1280,800],[1280,500],[640,500]]){win.setContentSize(width,height);await win.webContents.executeJavaScript('window.fixture.rulerGeometry()');}win.setContentSize(1280,800);console.log('PREVIEW_RULER_GEOMETRY',JSON.stringify(await win.webContents.executeJavaScript('window.previewRulerGeometry')));
 await win.webContents.executeJavaScript('window.fixture.layerTransitionBehavior()');console.log('PREVIEW_TRANSITION',JSON.stringify(await win.webContents.executeJavaScript('window.previewTransition')));
 await win.webContents.executeJavaScript('window.fixture.cameraZoomBehavior()');
 for(const [key,code,virtualKey,value]of [['End','End',35,4],['Home','Home',36,.35],['ArrowRight','ArrowRight',39,.36]]){await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey});await win.webContents.executeJavaScript('window.fixture.checkCameraZoom('+value+')');}
 await win.webContents.executeJavaScript('window.fixture.closeCameraZoom()');console.log('PREVIEW_CAMERA',JSON.stringify(await win.webContents.executeJavaScript('window.previewCamera')));
 await win.webContents.executeJavaScript('window.fixture.layeredBehavior()');console.log('PREVIEW_LAYERS',JSON.stringify(await win.webContents.executeJavaScript('window.previewLayers')));
 for(const layered of [false,true])for(const kind of ['card','controls'])for(const index of [0,1]){const p=await win.webContents.executeJavaScript('window.fixture.prepareSurfaceClick('+JSON.stringify(kind)+','+index+','+layered+')');await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...p});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...p});await win.webContents.executeJavaScript('window.fixture.checkSurfaceClick()');}await win.webContents.executeJavaScript("window.fixture.restoreSurfaceClicks()");console.log('PREVIEW_SURFACE_CLICKS',8);
 await win.webContents.executeJavaScript('window.fixture.pointerRouting()');console.log('PREVIEW_POINTER_ROUTING',JSON.stringify(await win.webContents.executeJavaScript('window.previewPointerRouting')));
 await win.webContents.executeJavaScript('window.fixture.pointerBoundaries()');
 for(const kind of ['leave','cancel','lost','blur']){
  const {point,outside}=await win.webContents.executeJavaScript('window.fixture.prepareBoundaryCapture('+JSON.stringify(kind)+')');
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',buttons:0,...point});
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
  const dragging={x:point.x+20,y:point.y+12};await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...dragging});await win.webContents.executeJavaScript('window.fixture.boundaryCaptureAction()');
  if(kind==='leave')await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,...outside});
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...(kind==='leave'?outside:dragging)});await win.webContents.executeJavaScript('window.fixture.checkBoundaryCapture()');
 }
 console.log('PREVIEW_POINTER_BOUNDARIES',JSON.stringify(await win.webContents.executeJavaScript('window.previewPointerBoundaries')));
 await win.webContents.executeJavaScript('window.fixture.beginLayerHits()');for(const angles of [{x:-30,y:-60},{x:-30,y:60},{x:30,y:-60},{x:30,y:60}])for(const zoom of [.35,4])for(const part of ['material','navigation']){const point=await win.webContents.executeJavaScript('window.fixture.prepareLayerHit('+JSON.stringify(angles)+','+zoom+','+JSON.stringify(part)+')');await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});await win.webContents.executeJavaScript('window.fixture.checkLayerHit()');}console.log('PREVIEW_LAYER_HITS',JSON.stringify(await win.webContents.executeJavaScript('window.fixture.finishLayerHits()')));
 await win.webContents.executeJavaScript('window.fixture.glassProfiles()');
 await win.webContents.executeJavaScript('window.fixture.themeMaterials()');
 await win.webContents.executeJavaScript('window.fixture.navigationStates()');
 await win.webContents.executeJavaScript('window.fixture.geometry()');console.log('PREVIEW_GEOMETRY',JSON.stringify(await win.webContents.executeJavaScript('window.previewGeometry')));
 await win.webContents.executeJavaScript('window.fixture.configuration()');console.log('PREVIEW_CONFIGURATION',JSON.stringify(await win.webContents.executeJavaScript('window.previewConfiguration')));
 await win.webContents.executeJavaScript('window.fixture.presetLayouts()');console.log('PREVIEW_PRESET_CASES',await win.webContents.executeJavaScript('window.previewPresetCases'));
 const failures=[];for(const check of ['motionApi','lifecycle','loading']){try{await win.webContents.executeJavaScript('window.fixture.'+check+'()')}catch(error){failures.push(check+': '+error.message)}}
 console.log('PREVIEW_LIFECYCLE',JSON.stringify(await win.webContents.executeJavaScript('window.previewLifecycle')));
 if(failures.length)throw Error(failures.join('; '));
 for(const tone of ['dark','light']){await win.webContents.executeJavaScript('window.fixture.prepareSelectionFeedback('+JSON.stringify(tone)+')');for(const label of ['调整内框背景','调整外框','调整侧边栏材质','调整标题栏材质','调整播放条布局','调整内容卡片']){
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});await win.webContents.executeJavaScript('window.fixture.checkSelectionFocus('+JSON.stringify(label)+')');
 }}
 let layerFocusCases=0;for(const tone of ['dark','light']){await win.webContents.executeJavaScript('window.fixture.prepareLayerFocus('+JSON.stringify(tone)+')');for(const label of ['调整内框背景','调整外框','调整侧边栏材质','调整标题栏材质','调整播放条布局','调整内容卡片']){await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});await win.webContents.executeJavaScript('window.fixture.checkLayerFocus('+JSON.stringify(label)+')');layerFocusCases++;}}await win.webContents.executeJavaScript('window.fixture.closeLayerFocus()');console.log('PREVIEW_LAYER_FOCUS',layerFocusCases);
 const point=await win.webContents.executeJavaScript('window.fixture.prepareDrag()');
 await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
 await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:point.x+40,y:point.y+20});
 await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:point.x+40,y:point.y+20});
 await win.webContents.executeJavaScript('window.fixture.checkDrag()');
 const workshopVisual=[],workshopDirectory=process.env.TE_PREVIEW_QA_OUTPUT?path.join(path.resolve(process.env.TE_PREVIEW_QA_OUTPUT),'shared-workshop'):null;
 if(workshopDirectory)await fs.mkdir(workshopDirectory,{recursive:true});
 const workshopCapture=async(file,state)=>{const image=await captureCssPage(),bitmap=image.toBitmap();let hidden,hiddenImage,hiddenState;try{hiddenState=await win.webContents.executeJavaScript('window.fixture.setWorkshopPaint(false)');hiddenImage=await captureCssPage();hidden=hiddenImage.toBitmap();}finally{await win.webContents.executeJavaScript('window.fixture.setWorkshopPaint(true)');}if(bitmap.length!==hidden.length)throw Error('paint probe changed the capture dimensions');let changed=0;for(let offset=0;offset<bitmap.length;offset+=4)if(Math.abs(bitmap[offset]-hidden[offset])+Math.abs(bitmap[offset+1]-hidden[offset+1])+Math.abs(bitmap[offset+2]-hidden[offset+2])>24)changed++;if(workshopDirectory){await fs.writeFile(path.join(workshopDirectory,file),image.toPNG());if(!changed)await fs.writeFile(path.join(workshopDirectory,file.replace('.png','-hidden-probe.png')),hiddenImage.toPNG());workshopVisual.push({...state,file,appPaintPixels:changed,paintEvidence:'same-camera visible/hidden RGB difference >24',hiddenState});}if(!changed)console.error('PREVIEW_PAINT_DIAGNOSTIC',JSON.stringify({file,...hiddenState}));return changed;};
 await win.webContents.executeJavaScript('window.fixture.beginWorkshop()');
 let appPaintPixels2D=0;for(let index=0;index<6;index++){const state=await win.webContents.executeJavaScript('window.fixture.workshopScene('+index+')'),pixels=await workshopCapture(index+'-'+state.scene.surface+'-'+state.scene.tone+'-'+state.scene.width+'.png',state);if(index===0){appPaintPixels2D=pixels;if(pixels<=20)throw Error('shared app decoration is not actually painted above the background in 2D: '+pixels);}}
 await win.webContents.executeJavaScript('window.fixture.workshopCommittedInspections()');
 await win.webContents.executeJavaScript('window.fixture.workshopHidden()');
 const dragWorkshop=async(tone)=>{const point=await win.webContents.executeJavaScript('window.fixture.prepareWorkshopDrag('+JSON.stringify(tone)+')');await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:point.x+20,y:point.y+10});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:point.x+20,y:point.y+10});return win.webContents.executeJavaScript('window.fixture.checkWorkshopDrag()');};
 await dragWorkshop('dark');const layeredState=await win.webContents.executeJavaScript('window.fixture.workshopLayered()'),appPaintPixels3D=await workshopCapture('dashboard-dark-layered.png',layeredState);if(appPaintPixels3D<=10)throw Error('shared six-layer view does not paint the project app decoration: '+appPaintPixels3D);
 await win.webContents.executeJavaScript('window.fixture.leaveWorkshopLayered()');await workshopCapture('dashboard-pureWhite-edited.png',await dragWorkshop('pureWhite'));
 for(const kind of ['checkbox','text']){const point=await win.webContents.executeJavaScript('window.fixture.prepareWorkshopInput('+JSON.stringify(kind)+')');await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});if(kind==='text'){await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,nativeVirtualKeyCode:65,modifiers:2});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,nativeVirtualKeyCode:65,modifiers:2});await win.webContents.debugger.sendCommand('Input.insertText',{text:'shared-editor-input'});}await win.webContents.executeJavaScript('window.fixture.checkWorkshopInput()');}
 const sharedMetrics=await win.webContents.executeJavaScript('window.fixture.finishWorkshop()');Object.assign(sharedMetrics,{appPaintPixels2D,appPaintPixels3D});console.log('PREVIEW_WORKSHOP',JSON.stringify(sharedMetrics));
 if(workshopDirectory){await fs.writeFile(path.join(workshopDirectory,'shared-workshop-manifest.json'),JSON.stringify({metrics:sharedMetrics,scenes:workshopVisual},null,2));console.log('PREVIEW_WORKSHOP_VISUAL_QA',workshopDirectory);}
 const skinDirectory=process.env.TE_PANEL_SKIN_QA_OUTPUT?path.resolve(process.env.TE_PANEL_SKIN_QA_OUTPUT):null,skinCases=[];if(skinDirectory){await fs.mkdir(skinDirectory,{recursive:true});await fs.copyFile(path.join(__dirname,'panel-skin.png'),path.join(skinDirectory,'transparent-source.png'));}
 await win.webContents.executeJavaScript('window.fixture.beginSkin()');
 for(const tone of ['dark','light'])for(const [layered,update]of [[false,false],[true,false],[true,true]]){
  const state=await win.webContents.executeJavaScript('window.fixture.skinCase('+[tone,layered,update].map(value=>JSON.stringify(value)).join(',')+')'),image=await captureCssPage(),before=PNG.sync.read(image.toPNG());
  await win.webContents.executeJavaScript('window.fixture.hideSkinOverflow(true)');const hidden=PNG.sync.read((await captureCssPage()).toPNG());await win.webContents.executeJavaScript('window.fixture.hideSkinOverflow(false)');
  let paintedPixels=0;for(let y=Math.round(state.point.y)-2;y<=Math.round(state.point.y)+2;y++)for(let x=Math.round(state.point.x)-2;x<=Math.round(state.point.x)+2;x++){if(x<0||y<0||x>=before.width||y>=before.height)continue;const offset=(y*before.width+x)*4,paint=[...before.data.subarray(offset,offset+3)],delta=paint.reduce((sum,color,index)=>sum+Math.abs(color-hidden.data[offset+index]),0),distance=paint.reduce((sum,color,index)=>sum+Math.abs(color-[219,55,119][index]),0);if(delta>24&&distance<75)paintedPixels++;}
  const evidence={...state,paintedPixels};if(skinDirectory)await fs.writeFile(path.join(skinDirectory,tone+'-'+(layered?'3d':'2d')+(update?'-uv-update':'')+'.png'),image.toPNG());if(!paintedPixels)throw Error('Actual transparent PNG overflow did not paint outside its component: '+JSON.stringify(evidence));
  console.log('PREVIEW_SKIN_CASE',JSON.stringify(evidence));for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1,...state.hit});
  if(!await win.webContents.executeJavaScript('document.querySelector(".appearance-window-preview").dataset.focusedRegion==="player-bar"&&window.nativeActions===0'))throw Error('Skin blocks the real preview hit target or invokes playback');skinCases.push(evidence);
 }
 const outerCases=[];await win.webContents.executeJavaScript('window.fixture.beginOuterSkin()');
 for(const tone of ['dark','light'])for(const layered of [false,true]){
  const state=await win.webContents.executeJavaScript('window.fixture.outerSkinCase('+JSON.stringify(tone)+','+layered+')'),image=await captureCssPage(),before=PNG.sync.read(image.toPNG());
  await win.webContents.executeJavaScript('window.fixture.hideOuterSkin(true)');const hidden=PNG.sync.read((await captureCssPage()).toPNG());await win.webContents.executeJavaScript('window.fixture.hideOuterSkin(false)');
  const samples=state.samples.map(sample=>{let paintedPixels=0;for(let y=Math.round(sample.point.y)-1;y<=Math.round(sample.point.y)+1;y++)for(let x=Math.round(sample.point.x)-1;x<=Math.round(sample.point.x)+1;x++){if(x<0||y<0||x>=before.width||y>=before.height)continue;const offset=(y*before.width+x)*4,paint=[...before.data.subarray(offset,offset+3)],delta=paint.reduce((sum,color,index)=>sum+Math.abs(color-hidden.data[offset+index]),0),distance=paint.reduce((sum,color,index)=>sum+Math.abs(color-[21,116,76][index]),0);if(delta>24&&distance<75)paintedPixels++;}return {...sample,paintedPixels}});
  const evidence={...state,samples};if(skinDirectory)await fs.writeFile(path.join(skinDirectory,tone+'-'+(layered?'3d':'2d')+'-outer.png'),image.toPNG());if(['title','edge'].some(name=>!samples.some(sample=>sample.name===name&&sample.paintedPixels>0)))throw Error('Actual whole-window skin is obscured at its title or edge: '+JSON.stringify(evidence));outerCases.push(evidence);
 }
 const innerCases=[];await win.webContents.executeJavaScript('window.fixture.beginInnerSkin()');
 for(const tone of ['dark','light'])for(const layered of [false,true]){
  const state=await win.webContents.executeJavaScript('window.fixture.innerSkinCase('+JSON.stringify(tone)+','+layered+')'),image=await captureCssPage(),before=PNG.sync.read(image.toPNG());
  await win.webContents.executeJavaScript('window.fixture.hideOuterSkin(true)');const hidden=PNG.sync.read((await captureCssPage()).toPNG());await win.webContents.executeJavaScript('window.fixture.hideOuterSkin(false)');
  let paintedPixels=0;for(let y=Math.round(state.point.y)-2;y<=Math.round(state.point.y)+2;y++)for(let x=Math.round(state.point.x)-2;x<=Math.round(state.point.x)+2;x++){if(x<0||y<0||x>=before.width||y>=before.height)continue;const offset=(y*before.width+x)*4,paint=[...before.data.subarray(offset,offset+3)],delta=paint.reduce((sum,color,index)=>sum+Math.abs(color-hidden.data[offset+index]),0),distance=paint.reduce((sum,color,index)=>sum+Math.abs(color-[21,116,76][index]),0);if(delta>24&&distance<75)paintedPixels++;}
  const evidence={...state,paintedPixels};if(skinDirectory)await fs.writeFile(path.join(skinDirectory,tone+'-'+(layered?'3d':'2d')+'-inner.png'),image.toPNG());if(!paintedPixels)throw Error('Independent rounded inner-panel skin did not paint: '+JSON.stringify(evidence));innerCases.push(evidence);
 }
 await win.webContents.executeJavaScript('window.fixture.finishSkin()');const skinEvidence={cases:skinCases,outerCases,innerCases,externalRequests};if(externalRequests)throw Error('Preview attempted external requests: '+externalRequests);if(skinDirectory)await fs.writeFile(path.join(skinDirectory,'skin-preview-manifest.json'),JSON.stringify(skinEvidence,null,2));console.log('PREVIEW_SKINS',JSON.stringify(skinEvidence));
 const iconSync=[];await win.webContents.executeJavaScript('window.fixture.beginIconPreview()');for(const phase of ['first','second','clear']){
  const state=await win.webContents.executeJavaScript('window.fixture.iconPreviewCase('+JSON.stringify(phase)+')'),image=await captureCssPage(),png=PNG.sync.read(image.toPNG());let paintedPixels=0;
  if(phase!=='clear')for(let y=Math.round(state.point.y)-1;y<=Math.round(state.point.y)+1;y++)for(let x=Math.round(state.point.x)-1;x<=Math.round(state.point.x)+1;x++){if(x<0||y<0||x>=png.width||y>=png.height)continue;const offset=(y*png.width+x)*4,distance=[...png.data.subarray(offset,offset+3)].reduce((sum,color,index)=>sum+Math.abs(color-state.color[index]),0);if(distance<75)paintedPixels++;}
  const evidence={...state,paintedPixels};if(phase!=='clear'&&!paintedPixels)throw Error('Updated real 3D icon does not paint its declared image: '+JSON.stringify(evidence));if(skinDirectory)await fs.writeFile(path.join(skinDirectory,'3d-icons-'+phase+'.png'),image.toPNG());iconSync.push(evidence);
 }await win.webContents.executeJavaScript('window.fixture.finishIconPreview()');if(skinDirectory)await fs.writeFile(path.join(skinDirectory,'icon-preview-manifest.json'),JSON.stringify(iconSync,null,2));console.log('PREVIEW_ICON_SYNC',JSON.stringify(iconSync));
 if(process.env.TE_PREVIEW_QA_OUTPUT){
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:0,y:0});
  const directory=path.resolve(process.env.TE_PREVIEW_QA_OUTPUT),manifest=[];await fs.mkdir(directory,{recursive:true});
  for(const [tone,part,width,height,expanded,layered=false,spacing=56] of [['dark','overview',1280,800,true],['light','overview',1280,800,true],['dark','navigation',1280,800,true],['light','navigation',1280,800,true],['dark','overview',1280,800,false],['dark','material',1280,800,true],['dark','player-bar',1280,800,true],['dark','card',1280,800,true],['dark','background',1280,800,true],['light','background',1280,800,true],['dark','overview',800,600,true],['light','overview',800,600,true],['dark','overview',800,600,false],['dark','overview',1280,800,true,true],['light','overview',1280,800,true,true],['dark','card',1280,800,true,true],['dark','player-bar',1280,800,true,true],['dark','background',1280,800,true,true],['dark','overview',1280,800,true,true,0],['dark','overview',1280,800,true,true,80],['dark','overview',800,600,true,true],['light','overview',800,600,true,true],['dark','overview',800,600,false,true]]){
   win.setContentSize(width,height);const state=await win.webContents.executeJavaScript('window.fixture.visual('+[tone,part,expanded,layered,spacing].map(value=>JSON.stringify(value)).join(',')+')');const file=tone+'-'+part+'-'+(expanded?'expanded':'collapsed')+'-'+width+'x'+height+(layered?'-layered-'+spacing:'')+'.png';const image=await captureCssPage();await fs.writeFile(path.join(directory,file),image.toPNG());manifest.push({...state,file});
  }
  await fs.writeFile(path.join(directory,'scene-visual-manifest.json'),JSON.stringify(manifest,null,2));console.log('PREVIEW_VISUAL_QA',directory);
 }
 win.setContentSize(1024,768);await win.webContents.executeJavaScript('window.fixture.resized()');
 console.log('PREVIEW_BOUNDARY',JSON.stringify(await win.webContents.executeJavaScript('window.previewBoundary')));console.log('WINDOW_PREVIEW_OK');win.destroy();app.exit(0)
}catch(e){console.error(e);if(win&&!win.isDestroyed()){try{console.error('PREVIEW_FAILURE_STATE',JSON.stringify(await win.webContents.executeJavaScript('window.fixture.diagnostics()')))}catch(diagnosticError){console.error(diagnosticError)}}if(win&&!win.isDestroyed()&&process.env.TE_PREVIEW_QA_OUTPUT){try{const directory=path.resolve(process.env.TE_PREVIEW_QA_OUTPUT);await fs.mkdir(directory,{recursive:true});const image=await captureCssPage();await fs.writeFile(path.join(directory,'failed-state.png'),image.toPNG());}catch(captureError){console.error(captureError)}}win?.destroy();app.exit(1)}});
`
