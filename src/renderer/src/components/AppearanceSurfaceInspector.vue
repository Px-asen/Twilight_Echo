<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import EditableRangeValue from './EditableRangeValue.vue'
import AppearancePopover from './AppearancePopover.vue'
import AppearanceLayerSettings from './AppearanceLayerSettings.vue'
import AppearanceChromeSettings from './AppearanceChromeSettings.vue'
import { APPEARANCE_PARTS, type AppearancePart } from './appearanceParts'
import {
  backgroundEffect,
  cloneAppearance,
  resolveBackgroundPalette,
  type AppearanceDraft,
  type AppearanceTone
} from '../../../shared/appAppearance'
import {
  appearanceLayerScope,
  defaultComponentMaterial,
  normalizeAppearanceLayers,
  type ComponentMaterialMode
} from '../../../shared/appearanceLayers'
import type { NavigationPageDefinition } from '../app/navigationPages'

const props = defineProps<{
  draft: AppearanceDraft
  tone: AppearanceTone
  glassTone?: AppearanceTone
  part: AppearancePart
  busy?: boolean
  playerMode?: 'standard' | 'mini' | 'compact'
  collapsed?: boolean
  horizontal?: boolean
  currentColor?: string
  pages?: NavigationPageDefinition[]
}>()
const emit = defineEmits<{
  'update:draft': [draft: AppearanceDraft]
  image: []
  more: [part: AppearancePart]
  'update:collapsed': [collapsed: boolean]
  'importing-change': [importing: boolean]
}>()
const container = ref<HTMLElement>()
const heading = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const parametersOpen = ref(false)
const importing = ref(false)
const imageSettingsOpen = ref(false)
const panelTheme = ref<Record<string, string>>({})
const backgroundPart = computed(() => ['background', 'inner-panel'].includes(props.part))
const partInfo = computed(
  () =>
    APPEARANCE_PARTS.find(
      (p) => p.id === (props.part === 'background' ? 'inner-panel' : props.part)
    )!
)
const scope = computed(() =>
  appearanceLayerScope(backgroundPart.value ? 'inner-panel' : props.part)
)
const materialPart = computed(() =>
  ['controls', 'navigation', 'material', 'player-bar', 'card'].includes(props.part)
)
const layers = computed(() => normalizeAppearanceLayers(props.draft.appearanceLayers))
const layer = computed(() =>
  scope.value ? layers.value.scopes[scope.value][props.tone] : undefined
)
const material = computed(() => layer.value?.material ?? defaultComponentMaterial())
const background = computed(() => props.draft.appBackground.global)
const effect = computed(() => backgroundEffect(background.value, props.tone))
const palette = computed(() => resolveBackgroundPalette(background.value, props.tone))
const hasImage = computed(() => background.value.kind === 'image' && !!background.value.image)
const toneLabel = computed(() => (props.tone === 'dark' ? '深色' : '浅色'))
const materialModes = [
  { value: 'theme', label: '跟随主题' },
  { value: 'solid', label: '纯色' },
  { value: 'frosted', label: '毛玻璃' },
  { value: 'liquidGlass', label: '液态玻璃' }
] as const
const fields = computed(() =>
  backgroundPart.value
    ? hasImage.value
      ? [
          { key: 'dim', label: '图片遮罩', min: 0, max: 80, suffix: '%' },
          { key: 'brightness', label: '图片亮度', min: 50, max: 120, suffix: '%' },
          { key: 'blur', label: '图片模糊', min: 0, max: 30, suffix: 'px' }
        ]
      : []
    : material.value.mode === 'theme' || material.value.mode === 'solid'
      ? []
      : [
          { key: 'opacity', label: '底色浓度', min: 0, max: 100, suffix: '%' },
          { key: 'blur', label: '背景模糊', min: 0, max: 40, suffix: 'px' },
          { key: 'saturation', label: '色彩饱和度', min: 50, max: 180, suffix: '%' },
          ...(material.value.mode === 'liquidGlass'
            ? [{ key: 'refraction', label: '折射强度', min: 0, max: 8, suffix: 'px' }]
            : [])
        ]
)
function edit(mutator: (draft: AppearanceDraft) => void): void {
  if (props.busy || importing.value) return
  const draft = cloneAppearance(props.draft)
  mutator(draft)
  emit('update:draft', draft)
}
function editLayer(mutator: (value: NonNullable<typeof layer.value>) => void): void {
  if (!scope.value) return
  edit((draft) => {
    const next = normalizeAppearanceLayers(draft.appearanceLayers)
    mutator(next.scopes[scope.value!][props.tone])
    draft.appearanceLayers = next
  })
}
function setMaterial(value: string): void {
  if (materialModes.some((mode) => mode.value === value))
    editLayer((valueLayer) => {
      valueLayer.material.mode = value as ComponentMaterialMode
    })
}
function fieldValue(key: string): number {
  return Number((backgroundPart.value ? effect.value : material.value)[key])
}
function setField(key: string, value: number): void {
  if (backgroundPart.value)
    edit((draft) => {
      draft.appBackground.global.effects![props.tone][key] = value
    })
  else
    editLayer((valueLayer) => {
      valueLayer.material[key] = value
    })
}
function setColor(value: string): void {
  if (backgroundPart.value)
    edit((draft) => {
      if (draft.appBackground.global.kind === 'theme') draft.appBackground.global.kind = 'color'
      draft.appBackground.global[props.tone] = value
      draft.appBackground.global.customized = true
      const next = normalizeAppearanceLayers(draft.appearanceLayers)
      next.scopes['inner-panel'][props.tone].body.enabled = false
      draft.appearanceLayers = next
    })
  else
    editLayer((valueLayer) => {
      valueLayer.material.color = value
      valueLayer.material.colorSource = 'custom'
    })
}
function removeImage(): void {
  edit((draft) => {
    draft.appBackground.global.image = ''
    delete draft.appBackground.global.imagePalette
    draft.appBackground.global.kind = 'color'
  })
}
function setTextTone(value: string): void {
  if (['theme', 'light', 'dark'].includes(value))
    edit((draft) => {
      if (draft.appBackground.global.kind === 'theme') {
        draft.appBackground.global.kind = 'color'
        draft.appBackground.global.customized = true
      }
      draft.appBackground.global.effects![props.tone].textTone = value as 'theme' | 'light' | 'dark'
    })
}
function setImporting(value: boolean): void {
  importing.value = value
  emit('importing-change', value)
}
function skinToggled(event: Event): void {
  const details = event.target as HTMLDetailsElement
  if (importing.value && !details.open) details.open = true
  imageSettingsOpen.value = details.open
}
function closeParameters(): void {
  if (importing.value) return
  parametersOpen.value = false
  imageSettingsOpen.value = false
}
function toggleParameters(): void {
  if (props.busy || importing.value) return
  if (!parametersOpen.value && container.value) {
    const style = getComputedStyle(container.value)
    panelTheme.value = Object.fromEntries(
      [
        '--te-editor-panel',
        '--te-settings-text',
        '--te-settings-text-muted',
        '--te-settings-control-bg',
        '--te-settings-control-border',
        '--te-editor-accent',
        '--te-font-sans',
        '--te-font-size-body',
        '--te-control-height-md',
        '--te-control-focus-color'
      ].map((key) => [key, style.getPropertyValue(key)])
    )
  }
  parametersOpen.value = !parametersOpen.value
}
function dismiss(event: KeyboardEvent): void {
  if (event.defaultPrevented || !parametersOpen.value) return
  event.stopPropagation()
  if (importing.value) {
    event.preventDefault()
    return
  }
  closeParameters()
  void nextTick(() => trigger.value?.focus({ preventScroll: true }))
}
watch(
  () => props.part,
  async () => {
    closeParameters()
    await nextTick()
    if (!props.horizontal) heading.value?.focus({ preventScroll: true })
  }
)
</script>
<template>
  <aside
    ref="container"
    class="appearance-inspector"
    data-te-appearance-ignore
    :class="{ 'is-horizontal': horizontal, 'is-collapsed': collapsed }"
    @keydown.esc="dismiss"
  >
    <header v-if="!horizontal" class="appearance-inspector-title">
      <h3 ref="heading" tabindex="-1">{{ partInfo.label }}</h3>
      <span>{{ toneLabel }}外观</span>
      <button
        :aria-label="collapsed ? '展开属性' : '收起属性'"
        :aria-expanded="!collapsed"
        @click="emit('update:collapsed', !collapsed)"
      >
        <i :class="collapsed ? 'pi pi-chevron-down' : 'pi pi-chevron-up'" aria-hidden="true" />
      </button>
    </header>
    <div v-show="!collapsed" class="appearance-inspector-body">
      <fieldset class="appearance-inspector-controls" :disabled="busy || importing">
        <template v-if="materialPart">
          <label class="appearance-material-field"
            ><span>{{ horizontal ? partInfo.label : '材质' }}</span
            ><select
              aria-label="部件材质"
              :value="material.mode"
              @change="setMaterial(($event.target as HTMLSelectElement).value)"
            >
              <option v-for="mode in materialModes" :key="mode.value" :value="mode.value">
                {{ mode.label }}
              </option>
            </select></label
          >
        </template>
        <template v-else-if="backgroundPart">
          <label class="appearance-material-field"
            ><span>底色</span
            ><input
              type="color"
              aria-label="背景颜色"
              :value="background[tone]"
              @input="setColor(($event.target as HTMLInputElement).value)"
          /></label>
          <button class="appearance-image-button" @click="emit('image')">
            <i class="pi pi-image" aria-hidden="true" />{{
              background.image ? '更换图片' : '选择图片'
            }}
          </button>
        </template>
        <button
          v-if="scope"
          ref="trigger"
          class="appearance-parameters-button"
          :aria-expanded="parametersOpen"
          aria-controls="appearance-secondary-properties"
          @click="toggleParameters"
        >
          <span>{{ horizontal ? '调节' : materialPart ? '材质调节' : '背景调节' }}</span
          ><i
            :class="parametersOpen ? 'pi pi-chevron-up' : 'pi pi-chevron-down'"
            aria-hidden="true"
          />
        </button>
        <button v-else @click="emit('more', part)">编辑{{ partInfo.label }}</button>
      </fieldset>
      <component
        :is="horizontal ? AppearancePopover : 'div'"
        v-if="parametersOpen"
        v-bind="
          horizontal
            ? { open: true, anchor: container ?? null, label: `${partInfo.label}调节` }
            : {}
        "
        @close="closeParameters"
      >
        <div
          id="appearance-secondary-properties"
          class="appearance-floating-properties"
          :style="panelTheme"
          data-te-appearance-ignore
        >
          <header class="appearance-properties-heading">
            <strong
              >{{ partInfo.label
              }}{{ materialPart ? '材质' : backgroundPart ? '' : '背景' }}</strong
            ><span>{{ toneLabel }}</span>
          </header>
          <fieldset class="appearance-parameters" :disabled="busy || importing">
            <template v-if="materialPart">
              <div class="appearance-material-choices" role="group" aria-label="材质类型">
                <button
                  v-for="mode in materialModes"
                  :key="mode.value"
                  :aria-pressed="material.mode === mode.value"
                  @click="setMaterial(mode.value)"
                >
                  {{ mode.label }}
                </button>
              </div>
              <p v-if="material.mode === 'theme'" class="appearance-inspector-note">
                沿用主题与背景配色。选择材质后可独立调节{{ partInfo.label }}。
              </p>
              <template v-else>
                <label class="appearance-material-field"
                  ><span>底色来源</span
                  ><select
                    aria-label="材质底色来源"
                    :value="material.colorSource"
                    @change="
                      editLayer((value) => {
                        value.material.colorSource = ($event.target as HTMLSelectElement).value as
                          | 'auto'
                          | 'custom'
                      })
                    "
                  >
                    <option value="auto">自动配色</option>
                    <option value="custom">自选颜色</option>
                  </select></label
                >
                <label v-if="material.colorSource === 'custom'" class="appearance-material-field"
                  ><span>底色</span
                  ><input
                    type="color"
                    aria-label="部件底色"
                    :value="material.color"
                    @input="setColor(($event.target as HTMLInputElement).value)"
                /></label>
              </template>
            </template>
            <template v-if="backgroundPart">
              <label class="appearance-material-field"
                ><span>文字明暗</span
                ><select
                  aria-label="背景文字明暗"
                  :value="effect.textTone"
                  @change="setTextTone(($event.target as HTMLSelectElement).value)"
                >
                  <option value="theme">{{ palette ? '自动（依据图片）' : '跟随主题' }}</option>
                  <option value="light">浅色文字</option>
                  <option value="dark">深色文字</option>
                </select></label
              >
              <p v-if="!hasImage" class="appearance-inspector-note">
                选择图片后可调整遮罩、亮度与模糊。
              </p>
              <button v-if="background.image" @click="removeImage">移除背景图片</button>
              <button class="appearance-more-button" @click="emit('more', part)">
                页面背景设置
              </button>
            </template>
            <div v-for="field in fields" :key="field.key" class="appearance-parameter">
              <div>
                <label :for="'part-' + field.key">{{ field.label }}</label
                ><EditableRangeValue
                  :value="fieldValue(field.key)"
                  :min="field.min"
                  :max="field.max"
                  :suffix="field.suffix"
                  :aria-label="field.label + '数值'"
                  :disabled="busy"
                  @change="setField(field.key, $event)"
                />
              </div>
              <input
                :id="'part-' + field.key"
                type="range"
                :aria-label="field.label"
                :min="field.min"
                :max="field.max"
                :value="fieldValue(field.key)"
                @input="setField(field.key, Number(($event.target as HTMLInputElement).value))"
              />
            </div>
            <p v-if="materialPart && material.mode !== 'theme'" class="appearance-inspector-note">
              仅调整当前部件的{{ toneLabel }}材质；其他部件保持各自设置。
            </p>
            <button
              v-if="materialPart && material.mode !== 'theme'"
              class="appearance-text-button"
              @click="
                editLayer((value) => {
                  value.material = { ...defaultComponentMaterial(tone), mode: value.material.mode }
                })
              "
            >
              恢复当前材质参数
            </button>
          </fieldset>
          <AppearanceChromeSettings
            v-if="part === 'navigation' || part === 'player-bar'"
            :draft="draft"
            :part="part"
            :pages="pages"
            :busy="busy"
            @update:draft="emit('update:draft', $event)"
          />
          <details
            v-if="scope"
            class="appearance-image-settings"
            :open="imageSettingsOpen"
            @toggle="skinToggled"
          >
            <summary @click="importing && $event.preventDefault()">
              {{ part === 'controls' ? '颜色与效果' : '皮肤与效果' }}
            </summary>
            <AppearanceLayerSettings
              v-if="imageSettingsOpen"
              :draft="draft"
              :scope="scope"
              :tone="tone"
              :busy="busy"
              @update:draft="emit('update:draft', $event)"
              @importing-change="setImporting"
            />
          </details>
        </div>
      </component>
    </div>
  </aside>
</template>
<style scoped>
.appearance-inspector,
.appearance-floating-properties {
  box-sizing: border-box;
  font-family: var(--te-font-sans);
  font-size: var(--te-type-body, 14px);
  line-height: 1.5;
  color: var(--te-settings-text);
  background: var(--te-editor-panel, var(--te-settings-backplate));
  border-radius: var(--te-editor-panel-radius, 10px);
}
.appearance-inspector {
  width: 240px;
  max-width: 100%;
  padding: 12px;
  max-height: 100%;
  overflow: auto;
  scrollbar-width: thin;
}
.appearance-inspector-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.appearance-inspector-title h3 {
  margin: 0;
  font: inherit;
  font-weight: 600;
  outline: none;
}
.appearance-inspector-title span {
  font-size: 12px;
  color: var(--te-settings-text-muted);
}
.appearance-inspector-title button {
  margin-left: auto;
}
.appearance-inspector.is-collapsed header {
  margin: 0;
}
fieldset {
  padding: 0;
  margin: 0;
  border: 0;
  min-width: 0;
}
fieldset:disabled {
  opacity: 0.55;
}
.appearance-inspector-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.appearance-material-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  min-height: 34px;
  margin: 0;
}
.appearance-inspector-controls > .appearance-material-field {
  flex: 1;
}
.appearance-material-field select {
  min-width: 120px;
  max-width: 100%;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--te-settings-control-border);
  background: var(--te-settings-control-bg);
  color: inherit;
  font: inherit;
}
.appearance-material-field input[type='color'] {
  width: 34px;
  height: 34px;
  padding: 2px;
  background: var(--te-settings-control-bg);
  border: 1px solid var(--te-settings-control-border);
  border-radius: 8px;
}
button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  min-height: 34px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  padding: 0 8px;
}
button:hover {
  background: var(--te-settings-control-bg);
}
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: var(--te-control-focus-width, 2px) solid var(--te-control-focus-color);
  outline-offset: 2px;
}
.appearance-parameters-button,
.appearance-image-button {
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.appearance-parameters-button {
  margin-left: auto;
}
.appearance-floating-properties {
  padding: 16px;
  width: 100%;
  min-width: 0;
}
.appearance-properties-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.appearance-properties-heading strong {
  font-weight: 600;
}
.appearance-properties-heading span {
  font-size: 12px;
  color: var(--te-settings-text-muted);
}
.appearance-material-choices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-bottom: 16px;
}
.appearance-material-choices button {
  border: 1px solid var(--te-settings-control-border);
}
.appearance-material-choices button[aria-pressed='true'] {
  color: var(--te-editor-accent, var(--te-settings-text));
  border-color: currentColor;
  background: var(--te-editor-choice-surface);
}
.appearance-parameters > .appearance-material-field {
  margin-bottom: 14px;
}
.appearance-inspector-note {
  font: inherit;
  font-size: 13px;
  color: var(--te-settings-text-muted);
  line-height: 1.6;
  margin: 0 0 14px;
}
.appearance-parameter {
  margin: 0 0 16px;
}
.appearance-parameter > div {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  min-height: 32px;
}
.appearance-parameter input[type='range'] {
  width: 100%;
  display: block;
  margin: 4px 0 0;
  accent-color: var(--te-editor-accent);
  min-height: 24px;
}
.appearance-parameter :deep(.editable-range-value) {
  min-width: 64px;
  justify-content: flex-end;
  color: inherit;
  font-size: inherit;
}
.appearance-text-button {
  font-size: 13px;
  padding-left: 0;
}
.appearance-image-settings {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--te-settings-control-border);
}
.appearance-image-settings summary {
  min-height: 34px;
  align-content: center;
  cursor: pointer;
}
.appearance-image-settings[open] summary {
  margin-bottom: 12px;
}
.is-horizontal {
  width: auto;
  max-width: min(440px, calc(100vw - 32px));
  overflow: visible;
  padding: 10px 12px;
  box-shadow: var(--te-editor-toolbar-shadow);
}
.is-horizontal .appearance-inspector-body {
  overflow: visible;
}
.is-horizontal .appearance-inspector-controls {
  flex-wrap: nowrap;
}
.is-horizontal .appearance-material-field select {
  min-width: 120px;
}
.appearance-inspector:not(.is-horizontal) .appearance-floating-properties {
  padding: 16px 0 0;
}
.appearance-inspector:not(.is-horizontal) .appearance-properties-heading {
  display: none;
}
:global(.appearance-popover:has(.appearance-floating-properties)) {
  width: min(360px, calc(100vw - 24px));
  border: 1px solid var(--te-settings-control-border);
  border-radius: 12px;
  background: var(--te-editor-panel, var(--te-settings-backplate));
  box-shadow: var(--te-editor-property-shadow);
  backdrop-filter: none;
  max-height: min(560px, 68vh);
}
:global(.appearance-popover:has(.appearance-floating-properties)::before) {
  display: none;
}
:global(.appearance-popover:has(.appearance-floating-properties) > .appearance-popover-content) {
  padding: 0;
  max-height: min(560px, 68vh);
  overflow: auto;
  scrollbar-width: thin;
}
</style>
