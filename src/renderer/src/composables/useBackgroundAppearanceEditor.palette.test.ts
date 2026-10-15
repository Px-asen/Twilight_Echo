import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import * as vue from 'vue'
import * as appearance from '../../../shared/appAppearance.ts'
import * as glass from '../../../shared/liquidGlass.ts'
import { useAppearanceDraft } from './useAppearanceDraft.ts'
import { persistAppearanceLayers } from './appearanceLayersPersistence.ts'
import type { AppBackgroundImagePalette } from '../../../shared/appSettings.ts'
import * as transparentRecipe from '../utils/transparentAppearanceRecipe.ts'

const source = transformSync(
  readFileSync(new URL('./useBackgroundAppearanceEditor.ts', import.meta.url), 'utf8'),
  { loader: 'ts', format: 'cjs' }
).code

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function palette(image: string): AppBackgroundImagePalette {
  return { image, average: '#e8e4dc', accent: '#c06040', opacity: 1 }
}

function fixture(
  options: {
    importImage?: (file: File) => Promise<string | null>
    analyze?: (
      image: string,
      options: { signal: AbortSignal }
    ) => Promise<AppBackgroundImagePalette | null>
  } = {}
) {
  const settings = vue.ref({
    ...appearance.cloneAppearance({
      appBackground: appearance.normalizeAppBackgroundSettings({
        global: {
          kind: 'image',
          image: 'background://original.png',
          imagePalette: palette('background://original.png')
        }
      }),
      cardAppearance: appearance.defaultCardAppearance(),
      liquidGlass: glass.DEFAULT_LIQUID_GLASS,
      surfaceMaterial: 'standard'
    }),
    theme: 'pureWhite'
  })
  const writes: unknown[] = []
  const lifecycle: Array<() => void> = []
  const store = {
    settings,
    updateSettings: async (patch: Record<string, unknown>) => {
      writes.push(JSON.parse(JSON.stringify(patch)))
      settings.value = { ...settings.value, ...patch }
    },
    importBackgroundImage:
      options.importImage ?? (async (file: File) => `background://${file.name}`)
  }
  const modules: Record<string, unknown> = {
    vue: {
      ...vue,
      onBeforeUnmount: (callback: () => void) => lifecycle.push(callback),
      watch: () => () => {}
    },
    '../stores/useSettingsStore': { useSettingsStore: () => store },
    '../stores/useThemeStore.ts': {
      useThemeStore: () => ({
        activeProfile: vue.ref(null),
        activeTheme: vue.ref({ kind: 'builtin', id: 'twilight-default' })
      }),
      previewAppearance: async () => {}
    },
    './appearanceLayersPersistence.ts': { persistAppearanceLayers },
    '../app/useDismissLayer.ts': { useEscapeToClose: () => {}, useFocusTrap: () => {} },
    './appearanceEditorState.ts': {
      appearanceEditorOpen: vue.ref(true),
      appearanceEditorArea: vue.ref('background'),
      appearanceFullWindowPreview: vue.ref(false)
    },
    './useAppearanceDraft.ts': { useAppearanceDraft },
    '../utils/backgroundImagePalette.ts': {
      analyzeBackgroundImage: options.analyze ?? (async (image: string) => palette(image))
    },
    '../utils/liquidGlassContextImage.ts': {
      loadLiquidGlassContextImage: async () => {
        throw new Error('not used by image import')
      }
    },
    '../utils/transparentAppearanceRecipe.ts': transparentRecipe,
    '../../../shared/appAppearance.ts': appearance,
    '../../../shared/liquidGlass.ts': glass
  }
  const api = runInNewContext(`${source}\nmodule.exports`, {
    module: { exports: {} },
    require(name: string) {
      assert.ok(name in modules, `unexpected import: ${name}`)
      return modules[name]
    },
    document: {
      documentElement: { dataset: { theme: 'pureWhite' } },
      hidden: false,
      addEventListener() {},
      removeEventListener() {}
    },
    AbortController,
    Error,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {}
  })
  const editor = api.useBackgroundAppearanceEditor({ embedded: true }) as ReturnType<
    typeof import('./useBackgroundAppearanceEditor').useBackgroundAppearanceEditor
  >
  const upload = (name = 'replacement.png') =>
    editor.importImage({
      target: { files: [{ name, size: 100 }], value: name }
    } as unknown as Event)
  return {
    editor,
    upload,
    writes,
    settings,
    unmount: () => lifecycle.forEach((callback) => callback())
  }
}

test('image color analysis changes only the pending draft, preserves manual choices and saves once', async () => {
  const f = fixture()
  f.editor.setEffect('textTone', 'light')
  f.editor.state.draft.appearanceLayers!.scopes.controls.light.body = {
    enabled: true,
    color: '#345678',
    opacity: 85
  }
  await f.upload()
  assert.equal(f.writes.length, 0)
  assert.equal(f.settings.value.appBackground.global.image, 'background://original.png')
  assert.equal(
    f.editor.state.draft.appBackground.global.imagePalette!.image,
    'background://replacement.png'
  )
  assert.equal(f.editor.effect.value.textTone, 'light')
  assert.deepEqual(f.editor.state.draft.appearanceLayers!.scopes.controls.light.body, {
    enabled: true,
    color: '#345678',
    opacity: 85
  })
  await f.editor.save()
  assert.equal(f.writes.length, 1)
  assert.equal(
    f.settings.value.appBackground.global.imagePalette!.image,
    'background://replacement.png'
  )
  assert.equal(f.editor.hasChanges.value, false)
  f.unmount()
})

test('late import and analysis results cannot replace a newer selected image', async () => {
  const imports = new Map<string, ReturnType<typeof deferred<string>>>()
  const samples = new Map<string, ReturnType<typeof deferred<AppBackgroundImagePalette | null>>>()
  const signals: AbortSignal[] = []
  const f = fixture({
    importImage: (file) => {
      const request = deferred<string>()
      imports.set(file.name, request)
      return request.promise
    },
    analyze: (image, options) => {
      signals.push(options.signal)
      const request = deferred<AppBackgroundImagePalette | null>()
      samples.set(image, request)
      return request.promise
    }
  })
  const first = f.upload('first.png')
  imports.get('first.png')!.resolve('background://first.png')
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
  assert.equal(f.editor.state.draft.appBackground.global.image, 'background://original.png')
  await f.editor.save()
  assert.equal(f.writes.length, 0)
  const second = f.upload('second.png')
  assert.equal(signals[0].aborted, true)
  imports.get('second.png')!.resolve('background://second.png')
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
  samples.get('background://second.png')!.resolve(palette('background://second.png'))
  await second
  samples.get('background://first.png')!.resolve(palette('background://first.png'))
  await first
  assert.equal(f.editor.state.draft.appBackground.global.image, 'background://second.png')
  assert.equal(
    f.editor.state.draft.appBackground.global.imagePalette!.image,
    'background://second.png'
  )
  assert.equal(f.editor.importing.value, false)
  assert.equal(f.writes.length, 0)
  f.unmount()
})

test('cancel, remove, reset and unmount invalidate a still-pending image operation', async () => {
  for (const action of ['cancel', 'remove', 'reset', 'unmount'] as const) {
    const pending = deferred<string>()
    let analyzed = 0
    const f = fixture({
      importImage: () => pending.promise,
      analyze: async (image) => {
        analyzed++
        return palette(image)
      }
    })
    const importing = f.upload()
    if (action === 'cancel') await f.editor.cancel()
    else if (action === 'remove') f.editor.removeImage()
    else if (action === 'reset') f.editor.resetCurrent()
    else f.unmount()
    const expected = JSON.stringify(f.editor.state.draft)
    pending.resolve('background://replacement.png')
    await importing
    assert.equal(JSON.stringify(f.editor.state.draft), expected, action)
    assert.equal(f.editor.importing.value, false, action)
    assert.equal(f.writes.length, 0, action)
    assert.equal(analyzed, 0, action)
    if (action !== 'unmount') f.unmount()
  }
})

test('failed imports preserve the previous image; sampling failure accepts a manually adjustable draft', async () => {
  const failure = fixture({
    importImage: async () => {
      throw new Error('import unavailable')
    }
  })
  const original = JSON.stringify(failure.editor.state.draft)
  await failure.upload()
  assert.equal(JSON.stringify(failure.editor.state.draft), original)
  assert.equal(failure.editor.state.error, 'import unavailable')
  failure.unmount()
  const f = fixture({ analyze: async () => null })
  await f.upload()
  assert.equal(f.editor.state.draft.appBackground.global.image, 'background://replacement.png')
  assert.equal(f.editor.state.draft.appBackground.global.imagePalette, undefined)
  assert.equal(f.editor.state.error, '')
  assert.ok(f.editor.imagePaletteNotice.value.includes('手动调整'))
  f.editor.setEffect('textTone', 'dark')
  await f.editor.save()
  assert.equal(f.writes.length, 1)
  assert.equal(f.settings.value.appBackground.global.effects!.light.textTone, 'dark')
  f.unmount()
})
