import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useSettingsStore } from '../stores/useSettingsStore'
import { previewAppearance, useThemeStore } from '../stores/useThemeStore.ts'
import { persistAppearanceLayers } from './appearanceLayersPersistence.ts'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer.ts'
import {
  appearanceEditorOpen,
  appearanceEditorArea,
  appearanceFullWindowPreview
} from './appearanceEditorState.ts'
import { useAppearanceDraft } from './useAppearanceDraft.ts'
import { analyzeBackgroundImage } from '../utils/backgroundImagePalette.ts'
import { loadLiquidGlassContextImage } from '../utils/liquidGlassContextImage.ts'
import { recommendTransparentAppearance } from '../utils/transparentAppearanceRecipe.ts'
import {
  BACKGROUND_EFFECT_RANGES,
  applyAppearancePreset,
  backgroundCssVariables,
  backgroundEffect,
  cardCssVariables,
  cloneAppearance,
  defaultBackground,
  defaultCardAppearance,
  resolveBackground,
  type AppearancePreset,
  type AppearanceTone
} from '../../../shared/appAppearance.ts'
import {
  DEFAULT_LIQUID_GLASS,
  liquidGlassCssVariables,
  normalizeLiquidGlass
} from '../../../shared/liquidGlass.ts'
import type {
  AppBackgroundColorPair,
  AppBackgroundEffect,
  AppBackgroundPage
} from '../../../shared/appSettings.ts'

export function useBackgroundAppearanceEditor(options: { embedded?: boolean } = {}) {
  const embedded = options.embedded === true
  let previewFrame: number | undefined
  let previewRevision = 0
  let disposed = false
  let previewError: string | undefined
  function cancelPendingPreview(): void {
    previewRevision++
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame)
    previewFrame = undefined
  }
  const area = embedded
    ? ref<typeof appearanceEditorArea.value>('background')
    : appearanceEditorArea
  const { settings, updateSettings, importBackgroundImage } = useSettingsStore()
  const themeStore = useThemeStore()
  const baselineTheme = ref(settings.value.theme)
  const draftTheme = ref(settings.value.theme)
  const confirmedAppearance = () =>
    cloneAppearance({
      ...settings.value,
      appearanceLayers:
        themeStore.activeProfile?.value?.appearanceLayers ?? settings.value.appearanceLayers
    })
  const themeKey = () => JSON.stringify(themeStore.activeTheme?.value)
  let baselineThemeKey = themeKey()
  const session = useAppearanceDraft({
    confirmed: confirmedAppearance,
    persist: (draft) =>
      persistAppearanceLayers(draft, {
        settings: settings.value,
        theme: draftTheme.value === baselineTheme.value ? undefined : draftTheme.value,
        profile: themeStore.activeProfile?.value ?? null,
        saveProfile: themeStore.saveProfile,
        updateSettings
      }),
    preview: (draft) => {
      cancelPendingPreview()
      return draft && (disposed || document.hidden) ? Promise.resolve() : previewAppearance(draft)
    }
  })
  const { state } = session
  async function applyPreview(): Promise<void> {
    const current = ++previewRevision
    try {
      await previewAppearance(cloneAppearance(state.draft))
      if (disposed || current !== previewRevision) return
      if (previewError !== undefined && state.error === previewError) state.error = ''
      previewError = undefined
    } catch (cause) {
      if (disposed || current !== previewRevision || !state.fullWindow || state.saving) return
      previewError = cause instanceof Error ? cause.message : '预览未能更新，请重试。'
      state.error = previewError
    }
  }
  function schedulePreview(): void {
    if (disposed || document.hidden || !state.fullWindow || state.saving) return
    if (previewFrame !== undefined) return
    previewFrame = requestAnimationFrame(() => {
      previewFrame = undefined
      if (disposed || document.hidden || !state.fullWindow || state.saving) return
      void applyPreview()
    })
  }
  function previewVisibilityChanged(): void {
    if (document.hidden) cancelPendingPreview()
    else schedulePreview()
  }
  document.addEventListener('visibilitychange', previewVisibilityChanged)
  const dialogRef = ref<HTMLElement | null>(null)
  const bodyRef = ref<HTMLElement | null>(null)
  const fileInput = ref<HTMLInputElement | null>(null)
  const target = ref<'global' | AppBackgroundPage>('global')
  const previewPage = ref<AppBackgroundPage>('local')
  const tone = ref<AppearanceTone>(
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
  )
  const importing = ref(false)
  const matching = ref(false)
  const busy = computed(() => importing.value || matching.value)
  let recipeRequest = null as AbortController | null
  const imagePaletteNotice = ref('')
  let importRevision = 0
  let imageAnalysis: AbortController | undefined
  function invalidateImageImport(): void {
    importRevision++
    recipeRequest?.abort()
    recipeRequest = null
    matching.value = false
    imageAnalysis?.abort()
    imageAnalysis = undefined
    importing.value = false
  }
  const advancedOpen = ref(area.value === 'advanced')
  const baseline = ref(JSON.stringify(state.draft))
  const hasChanges = computed(
    () => JSON.stringify(state.draft) !== baseline.value || draftTheme.value !== baselineTheme.value
  )
  const hasConflict = ref(false)
  function begin(): void {
    cancelPendingPreview()
    invalidateImageImport()
    imagePaletteNotice.value = ''
    session.begin()
    baseline.value = JSON.stringify(state.draft)
    baselineThemeKey = themeKey()
    baselineTheme.value = settings.value.theme
    draftTheme.value = settings.value.theme
    tone.value =
      settings.value.theme === 'dark' ||
      (settings.value.theme === 'system' && document.documentElement.dataset.theme === 'dark')
        ? 'dark'
        : 'light'
    hasConflict.value = false
  }
  function setTone(value: AppearanceTone): void {
    if (state.saving || importing.value) return
    tone.value = value
    draftTheme.value = value === 'dark' ? 'dark' : 'pureWhite'
  }
  let pickerTarget: typeof target.value = 'global'
  const pageOptions: Array<{ value: AppBackgroundPage; label: string }> = [
    { value: 'local', label: '本地音乐' },
    { value: 'streaming', label: '在线音乐' },
    { value: 'player', label: '播放页' },
    { value: 'settings', label: '设置页' }
  ]
  const materials: Array<{ value: AppearancePreset; label: string; icon: string }> = [
    { value: 'theme', label: '跟随主题', icon: 'pi pi-palette' },
    { value: 'transparent', label: '透明', icon: 'pi pi-eye' },
    { value: 'frosted', label: '毛玻璃', icon: 'pi pi-cloud' },
    { value: 'liquidGlass', label: '液态玻璃', icon: 'pi pi-sparkles' }
  ]
  const activeBackground = computed(() =>
    target.value === 'global'
      ? state.draft.appBackground.global
      : resolveBackground(state.draft.appBackground, target.value)
  )
  const inherited = computed(
    () => target.value !== 'global' && state.draft.appBackground.pages[target.value].inherit
  )
  const effect = computed(() => backgroundEffect(activeBackground.value, tone.value))
  const activeMaterial = computed(() =>
    state.draft.surfaceMaterial === 'standard'
      ? state.draft.cardAppearance.enabled
        ? 'frosted'
        : 'theme'
      : state.draft.surfaceMaterial
  )
  const previewStyle = computed(() => {
    const background = resolveBackground(state.draft.appBackground, previewPage.value)
    const card = state.draft.cardAppearance[tone.value]
    const glass = state.draft.liquidGlass[tone.value]
    return {
      ...backgroundCssVariables(background, tone.value),
      ...cardCssVariables(card),
      ...liquidGlassCssVariables(glass),
      '--preview-surface':
        state.draft.surfaceMaterial === 'transparent'
          ? 'transparent'
          : state.draft.surfaceMaterial === 'liquidGlass'
            ? `color-mix(in srgb, ${tone.value === 'dark' ? '#17181a' : '#ffffff'} ${glass.tintOpacity}%, transparent)`
            : state.draft.cardAppearance.enabled
              ? 'var(--te-card-bg)'
              : tone.value === 'dark'
                ? '#181818dd'
                : '#ffffffdd',
      '--preview-filter':
        state.draft.surfaceMaterial === 'transparent'
          ? 'none'
          : state.draft.surfaceMaterial === 'liquidGlass'
            ? `blur(${glass.blurAmount}px) saturate(${glass.saturation}%)`
            : state.draft.cardAppearance.enabled
              ? `blur(${card.blurRadius}px) saturate(${card.blurSaturation}%)`
              : 'none',
      '--preview-border':
        state.draft.surfaceMaterial === 'transparent' ? 'transparent' : 'var(--te-card-border)',
      '--preview-shadow':
        state.draft.surfaceMaterial === 'transparent'
          ? 'none'
          : state.draft.surfaceMaterial === 'liquidGlass'
            ? 'inset 0 1px 0 #ffffff40'
            : state.draft.cardAppearance.enabled
              ? 'var(--te-card-shadow)'
              : 'none'
    }
  })
  useFocusTrap(dialogRef, () => !embedded && appearanceEditorOpen.value && !state.fullWindow)
  useEscapeToClose(
    () => (embedded ? state.fullWindow : appearanceEditorOpen.value),
    () => {
      if (state.saving || importing.value) return
      if (state.fullWindow) void fullPreview(false)
      else void cancel()
    }
  )
  if (embedded) {
    begin()
    watch(
      () => [JSON.stringify(confirmedAppearance()), themeKey(), settings.value.theme],
      ([confirmed, key, theme]) => {
        if (
          state.saving ||
          (confirmed === baseline.value &&
            key === baselineThemeKey &&
            theme === baselineTheme.value)
        )
          return
        if (!hasChanges.value) begin()
        else {
          hasConflict.value = true
          state.error = '外观已在其他位置更改，请先放弃当前调整后继续。'
        }
      }
    )
  } else {
    watch(
      appearanceEditorOpen,
      (open) => {
        if (open) begin()
      },
      { immediate: true }
    )
  }
  async function scrollToArea(): Promise<void> {
    if (area.value === 'advanced') advancedOpen.value = true
    if (embedded) return
    await nextTick()
    bodyRef.value
      ?.querySelector(`#appearance-${area.value}`)
      ?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  watch([area, bodyRef], () => void scrollToArea(), { flush: 'post' })
  watch(() => state.draft, schedulePreview, { deep: true })
  watch(
    () => state.fullWindow,
    (value) => {
      if (!value) cancelPendingPreview()
      appearanceFullWindowPreview.value = value
    },
    { flush: 'sync' }
  )
  watch(target, (page) => {
    if (page !== 'global') previewPage.value = page
  })

  function editableBackground(page = target.value, customize = true): AppBackgroundColorPair {
    const background =
      page === 'global' ? state.draft.appBackground.global : state.draft.appBackground.pages[page]
    if (customize) {
      if (background.kind === 'theme') background.kind = 'color'
      background.customized = true
    }
    return background
  }
  function setEffect<K extends keyof AppBackgroundEffect>(
    field: K,
    value: AppBackgroundEffect[K]
  ): void {
    if (inherited.value) return
    const background = editableBackground(target.value, false)
    background.effects ??= {
      light: backgroundEffect(background, 'light'),
      dark: backgroundEffect(background, 'dark')
    }
    background.effects[tone.value][field] = value
  }
  function setInheritance(event: Event): void {
    if (target.value === 'global') return
    const inherit = (event.target as HTMLInputElement).checked
    const page = state.draft.appBackground.pages[target.value]
    if (!inherit && page.inherit) {
      const global = state.draft.appBackground.global
      Object.assign(page, {
        ...global,
        ...(global.imagePalette ? { imagePalette: { ...global.imagePalette } } : {}),
        effects: {
          light: { ...backgroundEffect(global, 'light') },
          dark: { ...backgroundEffect(global, 'dark') }
        }
      })
      if (!global.imagePalette) delete page.imagePalette
    }
    page.inherit = inherit
  }
  function chooseImage(): void {
    if (state.saving || disposed) return
    pickerTarget = target.value
    fileInput.value?.click()
  }
  async function importImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file || state.saving || disposed) return
    invalidateImageImport()
    const revision = importRevision
    const analysis = new AbortController()
    imageAnalysis = analysis
    const selectedTarget = pickerTarget
    importing.value = true
    state.error = ''
    imagePaletteNotice.value = ''
    try {
      if (!/\.(jpe?g|png|webp)$/i.test(file.name) || file.size > 20 * 1024 * 1024)
        throw new Error('请选择 20MB 以内的 JPG、PNG 或 WebP 图片')
      const image = await importBackgroundImage(file)
      if (revision !== importRevision || disposed) return
      if (!image) throw new Error('图片导入失败，请重新选择')
      const palette = await analyzeBackgroundImage(image, {
        signal: analysis.signal,
        createImage: () => new Image(),
        createCanvas: () => document.createElement('canvas')
      })
      if (revision !== importRevision || disposed) return
      const background = editableBackground(selectedTarget)
      background.image = image
      background.kind = 'image'
      if (palette) background.imagePalette = palette
      else {
        delete background.imagePalette
        imagePaletteNotice.value = '图片已导入，自动配色未能完成，可继续手动调整文字与控件颜色。'
      }
    } catch (error) {
      if (revision === importRevision && !disposed)
        state.error = error instanceof Error ? error.message : '无法读取这张图片'
    } finally {
      if (revision === importRevision) {
        importing.value = false
        imageAnalysis = undefined
      }
    }
  }
  function removeImage(): void {
    invalidateImageImport()
    imagePaletteNotice.value = ''
    const background = editableBackground()
    background.image = ''
    background.kind = 'color'
    delete background.imagePalette
  }
  function resetCurrent(): void {
    invalidateImageImport()
    imagePaletteNotice.value = ''
    if (area.value !== 'background') {
      state.draft.cardAppearance = defaultCardAppearance()
      state.draft.liquidGlass = normalizeLiquidGlass(DEFAULT_LIQUID_GLASS)
      state.draft.surfaceMaterial = 'standard'
    } else if (target.value === 'global') {
      state.draft.appBackground.global = defaultBackground()
    } else {
      state.draft.appBackground.pages[target.value] = {
        ...defaultBackground(target.value),
        inherit: true
      }
    }
  }
  function selectMaterial(preset: AppearancePreset): void {
    state.draft = applyAppearancePreset(state.draft, preset)
  }
  async function useTransparentRecipe(): Promise<void> {
    if (inherited.value || state.saving || importing.value) return
    recipeRequest?.abort()
    const request = new AbortController()
    recipeRequest = request
    matching.value = true
    state.error = ''
    const selectedTarget = target.value
    const selectedTone = tone.value
    const background = activeBackground.value
    const source = background.kind === 'image' ? background.image : ''
    let recipe = recommendTransparentAppearance([])
    let samplingFailed = false
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = Math.max(
        16,
        Math.min(128, Math.round((64 * window.innerHeight) / Math.max(1, window.innerWidth)))
      )
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('图片采样不可用')
      context.fillStyle = background[selectedTone]
      context.fillRect(0, 0, canvas.width, canvas.height)
      if (source) {
        const image = await loadLiquidGlassContextImage(source, request.signal, undefined, 2500)
        const aspect = canvas.width / canvas.height
        const cropWidth = Math.min(image.naturalWidth, image.naturalHeight * aspect)
        const cropHeight = cropWidth / aspect
        const position = backgroundEffect(background, selectedTone)
        context.drawImage(
          image,
          ((image.naturalWidth - cropWidth) * position.positionX) / 100,
          ((image.naturalHeight - cropHeight) * position.positionY) / 100,
          cropWidth,
          cropHeight,
          0,
          0,
          canvas.width,
          canvas.height
        )
      }
      recipe = recommendTransparentAppearance(
        context.getImageData(0, 0, canvas.width, canvas.height).data,
        canvas.width
      )
    } catch {
      samplingFailed = !request.signal.aborted
    } finally {
      if (recipeRequest === request) matching.value = false
    }
    // A late image result must not overwrite a new target, image, or editor session.
    if (
      request.signal.aborted ||
      recipeRequest !== request ||
      !appearanceEditorOpen.value ||
      target.value !== selectedTarget ||
      tone.value !== selectedTone ||
      activeBackground.value !== background ||
      (background.kind === 'image' ? background.image : '') !== source
    ) {
      if (recipeRequest === request) recipeRequest = null
      return
    }
    recipeRequest = null
    if (samplingFailed) state.error = '无法分析背景，已采用浅色文字与保护遮罩。'
    // Clear previous custom card/glass layers so the recipe has one predictable material.
    state.draft = applyAppearancePreset(applyAppearancePreset(state.draft, 'theme'), 'transparent')
    for (const [field, value] of Object.entries({
      ...recipe,
      blur: 0,
      brightness: 100,
      scale: 1
    })) {
      setEffect(
        field as keyof AppBackgroundEffect,
        value as AppBackgroundEffect[keyof AppBackgroundEffect]
      )
    }
  }
  async function fullPreview(value: boolean): Promise<void> {
    cancelPendingPreview()
    const update = session.preview(value)
    const current = previewRevision
    try {
      await update
      if (current === previewRevision) {
        if (previewError !== undefined && state.error === previewError) state.error = ''
        previewError = undefined
      }
    } catch (cause) {
      if (!disposed && current === previewRevision) {
        previewError = cause instanceof Error ? cause.message : '预览未能更新，请重试。'
        state.error = previewError
      }
      return
    }
    if (!value) {
      await nextTick()
      dialogRef.value?.focus({ preventScroll: true })
    }
  }
  async function cancel(): Promise<void> {
    if (state.saving) return
    cancelPendingPreview()
    invalidateImageImport()
    imagePaletteNotice.value = ''
    await session.cancel()
    if (embedded) begin()
    else appearanceEditorOpen.value = false
  }
  async function save(): Promise<void> {
    if (busy.value || hasConflict.value) return
    cancelPendingPreview()
    if (await session.save()) {
      if (embedded) begin()
      else appearanceEditorOpen.value = false
    }
  }
  onBeforeUnmount(() => {
    disposed = true
    cancelPendingPreview()
    document.removeEventListener('visibilitychange', previewVisibilityChanged)
    invalidateImageImport()
    if (!embedded || state.fullWindow) {
      appearanceFullWindowPreview.value = false
      void session.cancel()
    }
  })
  return {
    state,
    area,
    hasChanges,
    hasConflict,
    dialogRef,
    bodyRef,
    fileInput,
    target,
    previewPage,
    tone,
    setTone,
    importing,
    imagePaletteNotice,
    matching,
    busy,
    advancedOpen,
    pageOptions,
    materials,
    activeBackground,
    inherited,
    effect,
    activeMaterial,
    previewStyle,
    editableBackground,
    setEffect,
    setInheritance,
    chooseImage,
    importImage,
    removeImage,
    resetCurrent,
    selectMaterial,
    useTransparentRecipe,
    fullPreview,
    cancel,
    save,
    ranges: BACKGROUND_EFFECT_RANGES
  }
}
