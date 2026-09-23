<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import WorkshopLayersPanel from '@renderer/components/theme-workshop/WorkshopLayersPanel.vue'
import WorkshopAssetsPanel from '@renderer/components/theme-workshop/WorkshopAssetsPanel.vue'
import WorkshopModesPanel from '@renderer/components/theme-workshop/WorkshopModesPanel.vue'
import WorkshopPreview from '@renderer/components/theme-workshop/WorkshopPreview.vue'
import ThemeAppearanceControl from '@renderer/components/theme-studio/ThemeAppearanceControl.vue'
import {
  compileWorkshopProject,
  copyWorkshopDraft,
  workshopRuntimeAttributes,
  type WorkshopProjectSummary,
  WORKSHOP_TEMPLATES,
  type WorkshopProject,
  type WorkshopThemeSource,
  type ThemeEditorControl,
  type WorkshopBase
} from '../../../../shared/themeWorkshop'
import {
  THEME_TOKEN_DEFINITIONS,
  TWILIGHT_DEFAULT_THEME,
  THEME_MANAGED_DATA_ATTRIBUTES,
  type ThemeTone
} from '../../../../shared/theme'
import { useThemeStore } from '@renderer/stores/useThemeStore'
import { useExtensionRegistry } from '@renderer/extensions/registry'

const api = window.api.themeWorkshop
const store = useThemeStore()
const projects = shallowRef<WorkshopProjectSummary[]>([])
const sources = shallowRef<WorkshopThemeSource[]>([])
const draft = shallowRef<WorkshopProject>()
const tone = ref<ThemeTone>('pureWhite')
const group = ref('项目')
const search = ref('')
const surface = ref('dashboard')
const previewState = ref('normal')
const editTarget = ref<'local' | 'streaming'>('local')
const width = ref(1180)
const error = ref('')
const notice = ref('')
const busy = ref(false)
const trial = ref(false)
const candidate = shallowRef<WorkshopBase>()
const history: WorkshopProject[] = []
let cursor = -1
const historyIndex = ref(-1)
const historyLength = ref(0)
let trialAttributes: Record<string, string | null> = {}
let trialRecovery: HTMLButtonElement | undefined
let trialSheet: HTMLStyleElement | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined
let releaseSession: (() => void) | undefined
let disablePrepared = false
let saving: Promise<void> = Promise.resolve()
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const copyProject = copyWorkshopDraft
const previewProject = computed(() =>
  draft.value && candidate.value ? { ...draft.value, base: candidate.value } : draft.value
)
const css = computed(() => {
  if (!draft.value) return ''
  try {
    return compileWorkshopProject(
      candidate.value ? { ...draft.value, base: candidate.value } : draft.value
    )
  } catch {
    return ''
  }
})
const compilationError = computed(() => {
  if (!draft.value) return ''
  try {
    compileWorkshopProject(
      candidate.value ? { ...draft.value, base: candidate.value } : draft.value
    )
    return ''
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
})
const groups = computed(() => [
  '项目',
  ...new Set(draft.value?.base.editor?.controls.map((c) => c.group) ?? []),
  '图层与蒙版',
  '素材库',
  '布局与模式',
  '标准外观',
  '高级 CSS'
])
const controls = computed(() =>
  (draft.value?.base.editor?.controls ?? []).filter(
    (c) =>
      c.group === group.value &&
      `${c.label} ${c.id}`.toLowerCase().includes(search.value.toLowerCase())
  )
)
const tokens = computed(() =>
  THEME_TOKEN_DEFINITIONS.filter((t) =>
    `${t.id} ${t.label}`.toLowerCase().includes(search.value.toLowerCase())
  )
)
const removedControls = computed(() =>
  (draft.value?.base.editor?.controls ?? [])
    .filter((c) => !candidate.value?.editor?.controls.some((next) => next.id === c.id))
    .map((c) => c.label)
)

async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

function adoptCandidate(): void {
  const base = candidate.value
  if (!base) return
  change((project) => {
    project.base = base
    const ids = new Set(base.editor?.controls.map((control) => control.id) ?? [])
    for (const mode of ['pureWhite', 'dark'] as const) {
      for (const id of Object.keys(project.values[mode])) {
        const linkedId = id.replace(/\.(local|streaming)$/, '')
        if (!ids.has(id) && !(project.unlinked?.[linkedId] && ids.has(linkedId))) {
          delete project.values[mode][id]
        }
      }
    }
  })
  candidate.value = undefined
}

function checkpoint(): void {
  history.splice(cursor + 1)
  history.push(copyProject(draft.value!))
  if (history.length > 40) history.shift()
  cursor = history.length - 1
  historyIndex.value = cursor
  historyLength.value = history.length
}

function change(edit: (project: WorkshopProject) => void): void {
  if (!draft.value) return
  const next = copyProject(draft.value)
  edit(next)
  draft.value = next
  checkpoint()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void persist().catch((e) => {
      error.value = String(e)
    })
  }, 600)
}

function persist(): Promise<void> {
  clearTimeout(saveTimer)
  saving = saving
    .catch(() => {})
    .then(async () => {
      const current = draft.value
      if (!current) return
      const saved = await api.save(copy(current))
      if (draft.value?.id === saved.id) draft.value = { ...draft.value, revision: saved.revision }
      projects.value = [saved, ...projects.value.filter((p) => p.id !== saved.id)]
    })
  return saving
}

async function select(project: WorkshopProjectSummary): Promise<void> {
  await persist()
  stopTrial()
  draft.value = await api.get(project.id)
  history.length = 0
  cursor = -1
  checkpoint()
  candidate.value = undefined
}

async function create(template: string, source?: WorkshopThemeSource): Promise<void> {
  await persist()
  const project = await api.create(template, source ? copy(source) : undefined)
  projects.value = [project, ...projects.value]
  await select(project)
}

function undo(offset: number): void {
  const index = cursor + offset
  if (index < 0 || index >= history.length || !draft.value) return
  const revision = draft.value.revision
  draft.value = { ...copyProject(history[index]), revision }
  cursor = index
  historyIndex.value = index
  void persist().catch((e) => {
    error.value = String(e)
  })
}

function value(control: ThemeEditorControl): string {
  return draft.value?.values[tone.value][controlKey(control)] ?? control.defaults[tone.value]
}
function controlKey(control: ThemeEditorControl): string {
  return control.targets && draft.value?.unlinked?.[control.id]
    ? `${control.id}.${editTarget.value}`
    : control.id
}
function toggleLink(control: ThemeEditorControl): void {
  change((project) => {
    project.unlinked = { ...project.unlinked }
    if (project.unlinked[control.id]) {
      for (const mode of ['pureWhite', 'dark'] as const) {
        project.values[mode][control.id] =
          project.values[mode][`${control.id}.${editTarget.value}`] ?? control.defaults[mode]
        delete project.values[mode][`${control.id}.local`]
        delete project.values[mode][`${control.id}.streaming`]
      }
      delete project.unlinked[control.id]
    } else {
      for (const mode of ['pureWhite', 'dark'] as const) {
        for (const target of ['local', 'streaming'])
          project.values[mode][`${control.id}.${target}`] =
            project.values[mode][control.id] ?? control.defaults[mode]
      }
      project.unlinked[control.id] = true
    }
  })
}
function setValue(control: ThemeEditorControl, raw: string): void {
  change((p) => {
    p.values[tone.value][controlKey(control)] =
      control.type === 'number'
        ? `${raw}${control.unit ?? control.defaults[tone.value].match(/[a-z%]+$/i)?.[0] ?? ''}`
        : raw
  })
}
async function image(control: ThemeEditorControl): Promise<void> {
  const asset = await api.importAsset()
  if (asset) {
    change((p) => {
      p.assets = [...(p.assets ?? []), asset]
      p.values[tone.value][controlKey(control)] = `url('${asset.dataUrl}')`
    })
  }
}
function stopTrial(): void {
  for (const [key, value] of Object.entries(trialAttributes)) {
    if (value === null) document.documentElement.removeAttribute(key)
    else document.documentElement.setAttribute(key, value)
  }
  trialAttributes = {}
  trialRecovery?.remove()
  trialRecovery = undefined
  trialSheet?.remove()
  trialSheet = undefined
  trial.value = false
}
function toggleTrial(): void {
  if (trial.value) {
    stopTrial()
    return
  }
  if (compilationError.value) {
    error.value = compilationError.value
    return
  }
  for (const key of THEME_MANAGED_DATA_ATTRIBUTES) {
    trialAttributes[key] = document.documentElement.getAttribute(key)
    document.documentElement.removeAttribute(key)
  }
  const attrs = workshopRuntimeAttributes(previewProject.value!)
  attrs['data-theme'] = tone.value
  for (const [key, value] of Object.entries(attrs)) {
    if (!(key in trialAttributes)) trialAttributes[key] = document.documentElement.getAttribute(key)
    document.documentElement.setAttribute(key, value)
  }
  trialSheet = document.createElement('style')
  trialSheet.id = 'workshop-trial'
  trialSheet.textContent = css.value
  document.head.append(trialSheet)
  trialRecovery = document.createElement('button')
  trialRecovery.textContent = '退出主题试用 · Esc'
  trialRecovery.setAttribute('popover', 'manual')
  for (const [key, value] of Object.entries({
    position: 'fixed',
    top: '12px',
    right: '12px',
    left: 'auto',
    bottom: 'auto',
    margin: '0',
    display: 'block',
    padding: '12px 18px',
    background: '#ffffff',
    color: '#152a30',
    border: '2px solid #087f79',
    'border-radius': '12px',
    'font-size': '14px',
    opacity: '1',
    visibility: 'visible',
    'pointer-events': 'auto'
  }))
    trialRecovery.style.setProperty(key, value, 'important')
  trialRecovery.onclick = stopTrial
  document.body.append(trialRecovery)
  trialRecovery.showPopover()
  trial.value = true
}
watch([css, tone, previewProject], () => {
  if (!trialSheet || !draft.value || compilationError.value) return
  trialSheet.textContent = css.value
  for (const key of THEME_MANAGED_DATA_ATTRIBUTES) document.documentElement.removeAttribute(key)
  for (const [key, value] of Object.entries(workshopRuntimeAttributes(previewProject.value!)))
    document.documentElement.setAttribute(key, value)
  document.documentElement.dataset.theme = tone.value
})
function key(event: KeyboardEvent): void {
  if (event.key === 'Escape') stopTrial()
}

async function apply(): Promise<void> {
  await persist()
  const result = await api.apply(draft.value!.id)
  await useExtensionRegistry().syncExtensions()
  stopTrial()
  await store.setActive({ kind: 'plugin', pluginId: result.pluginId, themeId: result.themeId })
  projects.value = await api.list()
  draft.value = result.project
  notice.value = '主题已应用，停用工坊后仍可使用'
}

onMounted(() => {
  releaseSession = api.onPrepareDisable(async () => {
    busy.value = true
    try {
      await persist()
      stopTrial()
      disablePrepared = true
    } catch (error) {
      busy.value = false
      throw error
    }
  })
  window.addEventListener('keydown', key, true)
  void run(async () => {
    ;[projects.value, sources.value] = await Promise.all([api.list(), api.sources()])
    if (projects.value[0]) await select(projects.value[0])
  })
})
onBeforeUnmount(() => {
  releaseSession?.()
  window.removeEventListener('keydown', key, true)
  stopTrial()
  clearTimeout(saveTimer)
  if (!disablePrepared)
    void persist().catch((e) => {
      console.error('主题工坊保存失败', e)
    })
})
</script>

<template>
  <section class="workshop-page">
    <header class="workshop-header">
      <div>
        <small>THEME PLUGIN WORKSHOP</small>
        <h1>主题插件工坊</h1>
      </div>
      <select
        aria-label="项目"
        :value="draft?.id ?? ''"
        :disabled="busy"
        @change="
          run(() =>
            select(projects.find((p) => p.id === ($event.target as HTMLSelectElement).value)!)
          )
        "
      >
        <option value="" disabled>选择项目</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <button
        :disabled="busy"
        @click="
          run(async () => {
            const p = await api.importProject()
            if (p) {
              projects = [p, ...projects]
              await select(p)
            }
          })
        "
      >
        导入项目
      </button>
      <template v-if="draft">
        <button :disabled="historyIndex <= 0" @click="undo(-1)">撤销</button
        ><button :disabled="historyIndex >= historyLength - 1" @click="undo(1)">重做</button>
        <button :disabled="busy" @click="run(persist)">保存</button
        ><button @click="toggleTrial">{{ trial ? '退出试用（Esc）' : '整窗试用' }}</button>
        <button :disabled="busy" @click="run(apply)">应用主题</button>
      </template>
    </header>
    <p v-if="error" role="alert" class="workshop-error">{{ error }}</p>
    <p v-if="compilationError" role="alert" class="workshop-error">{{ compilationError }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div class="workshop-create">
      <button
        v-for="t in WORKSHOP_TEMPLATES"
        :key="t.id"
        :disabled="busy"
        @click="run(() => create(t.id))"
      >
        ＋ {{ t.name }}
      </button>
      <select
        aria-label="从插件创建"
        value=""
        :disabled="busy"
        @change="run(() => create('', sources[Number(($event.target as HTMLSelectElement).value)]))"
      >
        <option disabled value="">定制已安装主题…</option>
        <option v-for="(s, index) in sources" :key="`${s.pluginId}:${s.themeId}`" :value="index">
          {{ s.name }} · {{ s.version }}
        </option>
      </select>
    </div>
    <div v-if="draft" class="workshop-workspace">
      <nav aria-label="编辑区域">
        <button v-for="g in groups" :key="g" :class="{ active: group === g }" @click="group = g">
          {{ g }}
        </button>
      </nav>
      <main class="workshop-preview">
        <div class="workshop-toolbar">
          <select v-model="tone" aria-label="深浅色">
            <option value="pureWhite">浅色</option>
            <option value="dark">深色</option></select
          ><select v-model="surface" aria-label="页面">
            <option value="dashboard">本地首页</option>
            <option value="streaming">流媒体首页</option>
            <option value="streaming-list">流媒体歌曲列表</option>
            <option value="library">歌曲列表</option>
            <option value="settings">设置与小控件</option></select
          ><select v-model="width" aria-label="预览宽度">
            <option :value="760">窄窗 · 760</option>
            <option :value="1180">标准 · 1180</option>
            <option :value="1600">宽窗 · 1600</option>
          </select>
        </div>
        <select v-model="previewState" aria-label="预览状态">
          <option value="normal">正常</option>
          <option value="empty">空内容</option>
          <option value="loading">流媒体加载中</option>
          <option value="selected">流媒体选中行</option>
        </select>
        <WorkshopPreview
          :css="css"
          :project="previewProject!"
          :tone="tone"
          :surface="surface"
          :width="width"
          :state="previewState"
        />
      </main>
      <aside class="workshop-properties">
        <h2>{{ group }}</h2>
        <template v-if="group === '项目'">
          <label
            >名称<input
              :value="draft.name"
              @change="
                change((p) => {
                  p.name = ($event.target as HTMLInputElement).value
                })
              "
          /></label>
          <label
            >作者<input
              :value="draft.author"
              @change="
                change((p) => {
                  p.author = ($event.target as HTMLInputElement).value
                })
              "
          /></label>
          <label
            >版本<input
              :value="draft.version"
              @change="
                change((p) => {
                  p.version = ($event.target as HTMLInputElement).value
                })
              "
          /></label>
          <label
            >描述<textarea
              :value="draft.description"
              @change="
                change((p) => {
                  p.description = ($event.target as HTMLTextAreaElement).value
                })
              "
            />
          </label>
          <button
            :disabled="busy || !draft.lastApplied"
            @click="
              run(async () => {
                const restored = await api.restoreApplied(draft!.id)
                draft = restored
                checkpoint()
              })
            "
          >
            恢复上次应用版本
          </button>
          <p>来源：{{ draft.base.pluginId ?? '内置模板' }} {{ draft.base.version }}</p>
          <p>素材许可：{{ draft.base.license }}</p>
          <button
            :disabled="busy"
            @click="
              run(async () => {
                await persist()
                const path = await api.exportProject(draft!.id, 'project')
                if (path) notice = `已导出：${path}`
              })
            "
          >
            导出可编辑项目
          </button>
          <button
            :disabled="busy"
            @click="
              run(async () => {
                await persist()
                const path = await api.exportProject(draft!.id, 'tep')
                if (path) notice = `已导出：${path}`
              })
            "
          >
            导出独立 .tep
          </button>
          <button
            v-if="draft.base.pluginId"
            :disabled="busy"
            @click="
              run(async () => {
                await persist()
                candidate = await api.updateBase(draft!.id)
              })
            "
          >
            检查基础主题更新
          </button>
          <div v-if="candidate">
            <p>
              正在预览候选版本 {{ candidate.version }}；失效参数：{{
                removedControls.join('、') || '无'
              }}
            </p>
            <button @click="adoptCandidate">采用新基础</button
            ><button @click="candidate = undefined">取消</button>
          </div>
          <p v-if="!draft.base.editor">
            此主题尚未适配专属参数。可编辑标准配色和高级 CSS；原有硬编码样式可能覆盖标准配色。
          </p>
        </template>
        <WorkshopLayersPanel
          v-else-if="group === '图层与蒙版'"
          :project="draft"
          :tone="tone"
          @change="change((p) => Object.assign(p, $event))"
        />
        <WorkshopAssetsPanel
          v-else-if="group === '素材库'"
          :project="draft"
          :busy="busy"
          @change="change((p) => Object.assign(p, $event))"
          @import="
            (type) =>
              run(async () => {
                const asset = await api.importAsset(type)
                if (asset)
                  change((p) => {
                    p.assets = [...(p.assets ?? []), asset]
                  })
              })
          "
        />
        <WorkshopModesPanel
          v-else-if="group === '布局与模式'"
          :project="draft"
          @change="change((p) => Object.assign(p, $event))"
        />
        <template v-else-if="group === '高级 CSS'"
          ><p>高级样式在原主题和参数之后应用。</p>
          <textarea
            class="workshop-code"
            spellcheck="false"
            :value="draft.css"
            @change="
              change((p) => {
                p.css = ($event.target as HTMLTextAreaElement).value
              })
            " />
          <details>
            <summary>查看基础 CSS</summary>
            <textarea class="workshop-code" readonly :value="draft.base.css" /></details
        ></template>
        <template v-else>
          <input v-model="search" placeholder="搜索参数…" aria-label="搜索参数" />
          <template v-if="group === '标准外观'"
            ><ThemeAppearanceControl
              v-for="t in tokens"
              :key="t.id"
              :definition="t"
              :value="
                draft.tokens[tone][t.id] ??
                draft.base.structured?.variants[tone]?.tokens?.[t.id] ??
                TWILIGHT_DEFAULT_THEME.variants[tone].tokens[t.id]
              "
              source="主题"
              :disabled="busy"
              :modified="draft.tokens[tone][t.id] !== undefined"
              @change="
                change((p) => {
                  p.tokens[tone][t.id] = $event
                })
              "
              @reset="
                change((p) => {
                  delete p.tokens[tone][t.id]
                })
              "
          /></template>
          <label v-for="c in controls" :key="c.id"
            >{{ c.label }}
            <template v-if="c.targets">
              <select v-if="draft.unlinked?.[c.id]" v-model="editTarget" aria-label="编辑页面">
                <option value="local">本地</option>
                <option value="streaming">流媒体</option>
              </select>
              <button @click="toggleLink(c)">
                {{
                  draft.unlinked?.[c.id]
                    ? `重新同步（保留${editTarget === 'local' ? '本地' : '流媒体'}）`
                    : '解除本地／流媒体同步'
                }}
              </button>
            </template>
            <template v-if="c.type === 'image'"
              ><button :disabled="busy" @click="run(() => image(c))">选择素材</button>
              <select
                v-if="draft.assets?.some((a) => a.type === 'image')"
                aria-label="使用素材库图片"
                value=""
                @change="
                  setValue(
                    c,
                    `url('${draft.assets!.find((a) => a.id === ($event.target as HTMLSelectElement).value)!.dataUrl}')`
                  )
                "
              >
                <option value="" disabled>使用已导入图片…</option>
                <option
                  v-for="asset in draft.assets?.filter((a) => a.type === 'image')"
                  :key="asset.id"
                  :value="asset.id"
                >
                  {{ asset.name }}
                </option>
              </select>
              <div class="workshop-asset" :style="{ backgroundImage: value(c) }"
            /></template>
            <select
              v-else-if="c.type === 'select'"
              :value="value(c)"
              @change="setValue(c, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="o in c.options" :key="o">{{ o }}</option>
            </select>
            <input
              v-else-if="c.type === 'number'"
              type="range"
              :min="c.min ?? 0"
              :max="c.max ?? 100"
              :step="c.step ?? 1"
              :value="parseFloat(value(c))"
              @change="setValue(c, ($event.target as HTMLInputElement).value)"
            />
            <input
              v-else-if="c.type === 'boolean'"
              type="checkbox"
              :checked="value(c) === (c.checkedValue ?? '1')"
              @change="
                setValue(
                  c,
                  ($event.target as HTMLInputElement).checked
                    ? (c.checkedValue ?? '1')
                    : (c.uncheckedValue ?? '0')
                )
              "
            />
            <input
              v-else
              :value="value(c)"
              @change="setValue(c, ($event.target as HTMLInputElement).value)"
            />
            <small v-if="c.type !== 'image'">{{ value(c) }}</small
            ><button
              @click="
                change((p) => {
                  delete p.values[tone][controlKey(c)]
                })
              "
            >
              恢复默认
            </button>
          </label>
        </template>
      </aside>
    </div>
    <div v-else class="workshop-empty">
      <h2>从一个主题开始</h2>
      <p>选择模板，或完整复制已安装主题的样式和素材。</p>
    </div>
  </section>
</template>

<style src="./ThemeWorkshopPage.css"></style>
