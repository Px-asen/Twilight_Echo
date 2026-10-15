import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref
} from 'vue'
import { compileWorkshopProject, type WorkshopProject } from '../../../../shared/themeWorkshop.ts'
import {
  workshopDiagnosticReport,
  type WorkshopDiagnostic,
  type WorkshopDiagnosticReport
} from '../../../../shared/themeWorkshopDiagnostics.ts'
import { createThemePreviewScheduler } from '@renderer/utils/themePreviewScheduler'
import { createThemePerformanceRecorder } from '@renderer/utils/themePerformance'
import { WORKSHOP_PREVIEW_SURFACES } from '@renderer/components/theme-workshop/workshopCatalog'
import type { ThemeTone } from '../../../../shared/theme.ts'
import { diagnoseWorkshopCssSupport } from '../../../../shared/themeWorkshopCssDiagnostics.ts'

export interface WorkshopPreviewScene {
  tone: ThemeTone
  surface: string
  width: number
  state: string
}
export function useWorkshopDiagnostics(
  project: ComputedRef<WorkshopProject | undefined>,
  generation: Ref<number>,
  candidate: Ref<unknown>,
  inspect: () => Promise<WorkshopDiagnostic[]>
) {
  const css = ref('')
  const validProject = shallowRef<WorkshopProject>()
  const previewValid = ref(true)
  const baseReport = shallowRef<WorkshopDiagnosticReport>(workshopDiagnosticReport([]))
  const visual = shallowRef<WorkshopDiagnostic[]>([])
  const bufferProblems = shallowRef<WorkshopDiagnostic[]>([])
  const checking = ref(false)
  const progress = ref('')
  const stale = ref(true)
  const scene = shallowRef<WorkshopPreviewScene>()
  const performance = createThemePerformanceRecorder()
  const previewP95 = ref<number | null>(null)
  const report = computed(() =>
    workshopDiagnosticReport([
      ...bufferProblems.value,
      ...baseReport.value.diagnostics,
      ...visual.value
    ])
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  let epoch = 0
  let disposed = false
  let paused = false
  let needsCompile = true
  const diagnosticModule = import('../../../../shared/themeWorkshopDiagnostics.ts')
  const decodeCache = new Map<string, Promise<WorkshopDiagnostic | null>>()

  function decode(project: WorkshopProject): Promise<(WorkshopDiagnostic | null)[]> {
    return Promise.all(
      (project.assets ?? []).map((asset) => {
        const key = asset.type + asset.dataUrl
        const cached = decodeCache.get(key)
        if (cached)
          return cached.then(
            (item) =>
              item && {
                ...item,
                id: `asset.decode:${asset.id}`,
                message: asset.name + ' 无法解码，请替换素材',
                location: { kind: 'asset' as const, id: asset.id }
              }
          )
        const pending = new Promise<WorkshopDiagnostic | null>((resolve) => {
          let done = false
          const finish = (invalid: boolean): void => {
            if (done) return
            done = true
            clearTimeout(timeout)
            resolve(
              invalid
                ? {
                    id: `asset.decode:${asset.id}`,
                    code: 'asset.decode',
                    severity: 'error',
                    message: `${asset.name} 无法解码，请替换素材`,
                    location: { kind: 'asset', id: asset.id }
                  }
                : null
            )
          }
          const timeout = setTimeout(() => finish(true), 5000)
          if (asset.type === 'image') {
            const image = new Image()
            image.onload = () => finish(!image.naturalWidth)
            image.onerror = () => finish(true)
            image.src = asset.dataUrl
          } else {
            const font = new FontFace('workshop-diagnostic', `url('${asset.dataUrl}')`)
            void font.load().then(
              () => finish(false),
              () => finish(true)
            )
          }
        })
        if (decodeCache.size >= 128) decodeCache.delete(decodeCache.keys().next().value!)
        decodeCache.set(key, pending)
        return pending
      })
    )
  }
  async function runtimeCheck(): Promise<void> {
    const version = generation.value
    const currentEpoch = epoch
    const current = project.value
    if (disposed || paused || !current || !previewValid.value || checking.value) return
    const [items, assets] = await Promise.all([inspect(), decode(current)])
    if (disposed || paused || version !== generation.value || currentEpoch !== epoch) return
    visual.value = [
      ...diagnoseWorkshopCssSupport(current.css, (property, value) =>
        CSS.supports(property, value)
      ),
      ...items,
      ...assets.filter((item): item is WorkshopDiagnostic => !!item)
    ]
  }
  type CompileRequest = { snapshot: WorkshopProject; version: number; request: number }
  function compilation(snapshot: WorkshopProject): CompileRequest {
    return { snapshot, version: generation.value, request: epoch }
  }
  async function compile(job: CompileRequest, explicit = false): Promise<void> {
    const { snapshot, version, request } = job
    if (
      disposed ||
      (!explicit && (paused || request !== epoch)) ||
      generation.value !== version ||
      project.value !== snapshot
    )
      return
    const module = await diagnosticModule
    if (
      disposed ||
      (!explicit && (paused || request !== epoch)) ||
      generation.value !== version ||
      project.value !== snapshot
    )
      return
    needsCompile = false
    const start = performanceNow()
    const diagnostics = module.diagnoseWorkshopProject(snapshot)
    baseReport.value = diagnostics
    try {
      if (diagnostics.errors) {
        previewValid.value = false
        return
      }
      css.value = compileWorkshopProject(snapshot)
      validProject.value = snapshot
      previewValid.value = true
      const metric = performance.record('preview', performanceNow() - start)
      previewP95.value = metric.preview.p95Ms
    } catch (cause) {
      previewValid.value = false
      baseReport.value = workshopDiagnosticReport([
        ...diagnostics.diagnostics,
        {
          id: 'compile',
          severity: 'error',
          code: 'compile',
          message: cause instanceof Error ? cause.message : String(cause),
          location: { kind: 'project' }
        }
      ])
    }
    if (!paused && request === epoch && version === generation.value) scheduleRuntime()
  }
  const scheduler = createThemePreviewScheduler((job: CompileRequest) => compile(job))
  function performanceNow(): number {
    return globalThis.performance.now()
  }
  function cancel(): void {
    epoch++
    clearTimeout(timer)
    timer = undefined
    scheduler.cancel()
    checking.value = false
    scene.value = undefined
    stale.value = true
    progress.value = '完整检查未完成'
  }
  function pause(): void {
    if (paused) return
    paused = true
    cancel()
  }
  function resume(): void {
    if (disposed || !paused) return
    paused = false
    if (needsCompile && project.value) scheduler.schedule(compilation(project.value))
    else scheduleRuntime()
  }
  async function flush(): Promise<void> {
    await nextTick()
    if (disposed) return
    if (needsCompile && project.value) {
      scheduler.cancel()
      // Apply temporarily disables the editor. Its explicit static validation must
      // still use the latest draft, without restarting background scene checks.
      await compile(compilation(project.value), true)
    } else await scheduler.flush()
  }
  watch(
    [generation, candidate],
    () => {
      cancel()
      needsCompile = true
      visual.value = []
      stale.value = true
      if (project.value) {
        if (!paused) scheduler.schedule(compilation(project.value))
      } else {
        needsCompile = false
        css.value = ''
        validProject.value = undefined
        baseReport.value = workshopDiagnosticReport([])
      }
    },
    { immediate: true }
  )
  async function fullCheck(): Promise<void> {
    if (disposed || paused) return
    await flush()
    if (disposed || paused || !project.value || !previewValid.value || report.value.errors) return
    clearTimeout(timer)
    timer = undefined
    const version = generation.value
    const request = ++epoch
    checking.value = true
    const scenes: WorkshopPreviewScene[] = []
    for (const surface of WORKSHOP_PREVIEW_SURFACES) {
      const states = [
        'normal',
        'empty',
        'done',
        'listening',
        ...(surface.id.startsWith('streaming') ? ['loading'] : []),
        ...(['library', 'streaming-list'].includes(surface.id) ? ['selected'] : [])
      ]
      for (const tone of ['pureWhite', 'dark'] as const)
        for (const width of [640, 760, 1180, 1600])
          for (const state of states) scenes.push({ tone, surface: surface.id, width, state })
    }
    const results: WorkshopDiagnostic[] = []
    try {
      const assets = await decode(project.value)
      for (const asset of assets) if (asset) results.push(asset)
      for (const [index, next] of scenes.entries()) {
        if (disposed || paused || epoch !== request || generation.value !== version) return
        scene.value = next
        progress.value = `${index + 1}/${scenes.length} · ${WORKSHOP_PREVIEW_SURFACES.find((surface) => surface.id === next.surface)?.label} · ${next.tone === 'dark' ? '深色' : '浅色'} · ${next.width}px`
        await nextTick()
        if (disposed || paused || epoch !== request || generation.value !== version) return
        const items = await inspect()
        if (disposed || paused || epoch !== request || generation.value !== version) return
        for (const item of items)
          results.push({
            ...item,
            id: `${item.id}:${next.surface}:${next.tone}:${next.width}:${next.state}`,
            location: { ...item.location, ...next }
          })
      }
      visual.value = results
      stale.value = false
      progress.value = `已检查 ${scenes.length} 个场景`
    } finally {
      if (epoch === request) {
        checking.value = false
        scene.value = undefined
      }
    }
  }
  function scheduleRuntime(): void {
    if (disposed || paused || checking.value) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void runtimeCheck()
    }, 250)
  }
  onBeforeUnmount(() => {
    disposed = true
    cancel()
    decodeCache.clear()
  })
  return {
    css,
    validProject,
    previewValid,
    report,
    checking,
    progress,
    stale,
    scene,
    previewP95,
    bufferProblems,
    fullCheck,
    cancel,
    pause,
    resume,
    scheduleRuntime,
    flush
  }
}
