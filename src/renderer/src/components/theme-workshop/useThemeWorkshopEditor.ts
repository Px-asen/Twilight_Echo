import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import {
  copyWorkshopDraft,
  workshopProjectSummary,
  type ThemeWorkshopApi,
  type WorkshopBase,
  type WorkshopProject,
  type WorkshopProjectSummary,
  type WorkshopThemeSource
} from '../../../../shared/themeWorkshop.ts'

export function useThemeWorkshopEditor(api: ThemeWorkshopApi) {
  const projects = shallowRef<WorkshopProjectSummary[]>([])
  const sources = shallowRef<WorkshopThemeSource[]>([])
  const draft = shallowRef<WorkshopProject>()
  const candidate = shallowRef<WorkshopBase>()
  const generation = ref(0)
  const busy = ref(false)
  const error = ref('')
  const notice = ref('')
  const saveState = ref<'saved' | 'pending' | 'saving' | 'failed'>('saved')
  const savedAt = ref('')
  const cursor = ref(-1)
  const historyLength = ref(0)
  const history: WorkshopProject[] = []
  let savedGeneration = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let editTimer: ReturnType<typeof setTimeout> | undefined
  let saving: Promise<void> = Promise.resolve()
  let gestureStart: WorkshopProject | undefined
  let gestureGeneration = 0
  let pendingCheckpoint = false
  let stopTrial: () => void = () => undefined
  let metadataValid: () => boolean = () => true
  const previewProject = computed(() =>
    draft.value && candidate.value ? { ...draft.value, base: candidate.value } : draft.value
  )

  function checkpoint(): void {
    if (!draft.value) return
    history.splice(cursor.value + 1)
    history.push(copyWorkshopDraft(draft.value))
    if (history.length > 40) history.shift()
    cursor.value = history.length - 1
    historyLength.value = history.length
  }
  function finishInput(): void {
    clearTimeout(editTimer)
    if (pendingCheckpoint) {
      pendingCheckpoint = false
      checkpoint()
    }
  }
  function scheduleSave(): void {
    clearTimeout(timer)
    saveState.value = 'pending'
    timer = setTimeout(() => {
      void persist().catch(() => undefined)
    }, 600)
  }
  function change(edit: (project: WorkshopProject) => void, continuous = false): void {
    if (!draft.value) return
    if (!continuous) finishInput()
    const next = copyWorkshopDraft(draft.value)
    edit(next)
    draft.value = next
    generation.value++
    if (!gestureStart) {
      if (continuous) {
        pendingCheckpoint = true
        clearTimeout(editTimer)
        editTimer = setTimeout(finishInput, 300)
      } else checkpoint()
    }
    scheduleSave()
  }
  function beginGesture(): void {
    if (gestureStart || !draft.value) return
    finishInput()
    gestureStart = copyWorkshopDraft(draft.value)
    gestureGeneration = generation.value
    clearTimeout(timer)
  }
  function endGesture(cancel = false): void {
    if (!gestureStart || !draft.value) return
    if (cancel) {
      draft.value = { ...gestureStart, revision: draft.value.revision }
      generation.value++
    } else if (generation.value !== gestureGeneration) checkpoint()
    gestureStart = undefined
    scheduleSave()
  }
  function persist(): Promise<void> {
    clearTimeout(timer)
    if (gestureStart) return Promise.resolve()
    finishInput()
    saving = saving
      .catch(() => undefined)
      .then(async () => {
        if (!draft.value) return
        if (!metadataValid()) throw new Error('请先补全名称和版本，再保存或切换项目')
        if (savedGeneration === generation.value) return
        const current = copyWorkshopDraft(draft.value)
        const version = generation.value
        saveState.value = 'saving'
        try {
          const saved = await api.save(current)
          if (draft.value?.id === current.id) {
            draft.value = { ...draft.value, revision: saved.revision, updatedAt: saved.updatedAt }
            savedGeneration = version
            saveState.value = generation.value === version ? 'saved' : 'pending'
            savedAt.value = saved.updatedAt
          }
          projects.value = [
            workshopProjectSummary(saved),
            ...projects.value.filter((item) => item.id !== saved.id)
          ]
        } catch (cause) {
          error.value = cause instanceof Error ? cause.message : String(cause)
          saveState.value = 'failed'
          throw cause
        }
      })
    return saving
  }
  function adopt(project: WorkshopProject): void {
    stopTrial()
    clearTimeout(timer)
    clearTimeout(editTimer)
    gestureStart = undefined
    pendingCheckpoint = false
    draft.value = project
    candidate.value = undefined
    generation.value++
    savedGeneration = generation.value
    saveState.value = 'saved'
    savedAt.value = project.updatedAt
    history.length = 0
    cursor.value = -1
    checkpoint()
  }
  async function select(project: WorkshopProjectSummary): Promise<void> {
    await persist()
    adopt(await api.get(project.id))
  }
  async function create(template: string, source?: WorkshopThemeSource): Promise<void> {
    await persist()
    const project = await api.create(template, source)
    projects.value = [workshopProjectSummary(project), ...projects.value]
    adopt(project)
  }
  async function reload(): Promise<void> {
    if (draft.value) adopt(await api.get(draft.value.id))
  }
  async function duplicate(): Promise<void> {
    await persist()
    if (!draft.value) return
    const project = await api.duplicate(draft.value.id, draft.value.revision)
    projects.value = [workshopProjectSummary(project), ...projects.value]
    adopt(project)
  }
  async function saveCopy(): Promise<void> {
    if (!draft.value || !metadataValid()) throw new Error('请先补全名称和版本')
    const project = await api.save({
      ...copyWorkshopDraft(draft.value),
      id: crypto.randomUUID(),
      revision: 0,
      name: `${draft.value.name.slice(0, 155)} 副本`,
      lastApplied: undefined
    })
    projects.value = [workshopProjectSummary(project), ...projects.value]
    adopt(project)
    error.value = ''
  }
  async function remove(): Promise<void> {
    await persist()
    if (!draft.value) return
    const id = draft.value.id
    await api.remove(id, draft.value.revision)
    projects.value = projects.value.filter((project) => project.id !== id)
    stopTrial()
    if (projects.value[0]) adopt(await api.get(projects.value[0].id))
    else {
      draft.value = undefined
      generation.value++
      candidate.value = undefined
    }
  }
  function undo(offset: number): void {
    finishInput()
    if (gestureStart) endGesture(true)
    const index = cursor.value + offset
    if (!draft.value || index < 0 || index >= history.length) return
    draft.value = { ...copyWorkshopDraft(history[index]), revision: draft.value.revision }
    cursor.value = index
    generation.value++
    scheduleSave()
  }
  async function run(action: () => Promise<void>): Promise<void> {
    if (busy.value) return
    busy.value = true
    error.value = ''
    notice.value = ''
    try {
      await action()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      busy.value = false
    }
  }
  async function initialize(): Promise<void> {
    ;[projects.value, sources.value] = await Promise.all([api.list(), api.sources()])
    if (projects.value[0]) adopt(await api.get(projects.value[0].id))
  }
  function bindLifecycle(stop: () => void, valid: () => boolean): void {
    stopTrial = stop
    metadataValid = valid
  }
  onBeforeUnmount(() => {
    clearTimeout(timer)
    clearTimeout(editTimer)
    endGesture()
    clearTimeout(timer)
    stopTrial()
    void persist().catch(() => undefined)
  })
  return {
    projects,
    sources,
    draft,
    candidate,
    previewProject,
    generation,
    busy,
    error,
    notice,
    saveState,
    savedAt,
    cursor,
    historyLength,
    change,
    beginGesture,
    endGesture,
    persist,
    adopt,
    checkpoint,
    select,
    create,
    reload,
    duplicate,
    saveCopy,
    remove,
    undo,
    run,
    initialize,
    bindLifecycle
  }
}
