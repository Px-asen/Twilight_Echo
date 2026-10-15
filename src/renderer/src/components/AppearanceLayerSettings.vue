<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import EditableRangeValue from './EditableRangeValue.vue'
import {
  cloneAppearance,
  type AppearanceDraft,
  type AppearanceTone
} from '../../../shared/appAppearance'
import {
  normalizeAppearanceLayers,
  type AppearanceLayerScope,
  type AppearanceBodyLayer,
  type AppearanceEffectLayer,
  type AppearanceSkinLayer
} from '../../../shared/appearanceLayers'
const props = defineProps<{
  draft: AppearanceDraft
  scope: AppearanceLayerScope
  tone: AppearanceTone
  busy?: boolean
}>()
const emit = defineEmits<{
  'update:draft': [draft: AppearanceDraft]
  'importing-change': [importing: boolean]
}>()
const channel = ref<'body' | 'effect'>(props.scope === 'inner-panel' ? 'effect' : 'body')
const fileInput = ref<HTMLInputElement>()
const importing = ref(false)
const imageError = ref('')
let importRevision = 0
watch(
  () => [props.scope, props.tone],
  () => {
    importRevision++
    importing.value = false
    emit('importing-change', false)
    imageError.value = ''
    channel.value = props.scope === 'inner-panel' ? 'effect' : 'body'
  }
)
const settings = computed(() => normalizeAppearanceLayers(props.draft.appearanceLayers))
const layers = computed(() => settings.value.scopes[props.scope][props.tone])
const layer = computed(() => layers.value[channel.value])
const locked = computed(() => props.busy || importing.value)
const skinAvailable = computed(() => props.scope !== 'controls')
const imageFields = [
  { key: 'scale', label: '尺寸', min: 20, max: 300 },
  { key: 'x', label: '水平位置', min: -100, max: 100 },
  { key: 'y', label: '垂直位置', min: -100, max: 100 },
  { key: 'opacity', label: '不透明度', min: 0, max: 100 }
] as const
const frameFields = [
  { key: 'top', label: '上边' },
  { key: 'right', label: '右边' },
  { key: 'bottom', label: '下边' },
  { key: 'left', label: '左边' }
] as const
function changeSkin(patch: Partial<AppearanceSkinLayer>): void {
  if (locked.value || !skinAvailable.value) return
  const draft = cloneAppearance(props.draft)
  const next = normalizeAppearanceLayers(draft.appearanceLayers)
  Object.assign(next.scopes[props.scope][props.tone].skin, patch)
  if (props.scope === 'inner-panel') next.scopes[props.scope][props.tone].body.enabled = false
  draft.appearanceLayers = normalizeAppearanceLayers(next)
  emit('update:draft', draft)
}
async function importImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || locked.value || !skinAvailable.value) return
  const revision = ++importRevision
  const scope = props.scope
  const tone = props.tone
  importing.value = true
  emit('importing-change', true)
  imageError.value = ''
  try {
    if (!/\.png$/i.test(file.name) || file.size > 20 * 1024 * 1024)
      throw new Error('请选择 20MB 以内的 PNG 图片，透明区域会保留。')
    const image = await window.api.settings.importBackgroundImage(
      file.name,
      await file.arrayBuffer()
    )
    if (revision !== importRevision || scope !== props.scope || tone !== props.tone) return
    if (!image || !/^background:\/\/[a-zA-Z0-9._-]+$/.test(image))
      throw new Error('图片导入失败，请重新选择。')
    const draft = cloneAppearance(props.draft)
    const next = normalizeAppearanceLayers(draft.appearanceLayers)
    Object.assign(next.scopes[scope][tone].skin, {
      image,
      enabled: true,
      opacity: 100,
      placement: 'outside',
      fit: 'fill',
      scale: 100,
      x: 0,
      y: 0,
      frame: { top: 0, right: 0, bottom: 0, left: 0 }
    })
    if (scope === 'inner-panel') next.scopes[scope][tone].body.enabled = false
    draft.appearanceLayers = normalizeAppearanceLayers(next)
    emit('update:draft', draft)
  } catch (error) {
    if (revision === importRevision)
      imageError.value = error instanceof Error ? error.message : '图片导入失败，请重试。'
  } finally {
    if (revision === importRevision) {
      importing.value = false
      emit('importing-change', false)
    }
  }
}
function removeImage(): void {
  imageError.value = ''
  changeSkin({ image: '', enabled: false })
}
function change(patch: Partial<AppearanceBodyLayer & AppearanceEffectLayer>): void {
  if (locked.value) return
  const draft = cloneAppearance(props.draft)
  const next = normalizeAppearanceLayers(draft.appearanceLayers)
  Object.assign(next.scopes[props.scope][props.tone][channel.value], patch)
  draft.appearanceLayers = normalizeAppearanceLayers(next)
  emit('update:draft', draft)
}
function radius(value: number): void {
  if (locked.value) return
  const draft = cloneAppearance(props.draft)
  draft.appearanceLayers = { ...settings.value, innerRadius: value }
  emit('update:draft', draft)
}
onBeforeUnmount(() => {
  importRevision++
  emit('importing-change', false)
})
</script>
<template>
  <fieldset
    class="appearance-layer-settings"
    :disabled="locked"
    :aria-busy="importing"
    :aria-label="skinAvailable ? '背景皮肤' : '控件颜色与效果'"
  >
    <template v-if="skinAvailable">
      <div class="appearance-layer-image-intro">
        <strong>部件背景皮肤</strong>
        <p>上传完整 PNG 作为这个部件的背景。透明轮廓可越出边缘，前景控件保持可用。</p>
      </div>
      <div class="appearance-layer-image-actions">
        <span v-if="layers.skin.image" class="appearance-layer-image-preview" aria-hidden="true">
          <img :src="layers.skin.image" alt="" />
        </span>
        <button type="button" class="appearance-layer-upload" @click="fileInput?.click()">
          <i class="pi pi-image" aria-hidden="true" />
          {{ importing ? '正在导入…' : layers.skin.image ? '更换皮肤' : '上传 PNG 皮肤' }}
        </button>
        <button v-if="layers.skin.image" type="button" @click="removeImage">移除皮肤</button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept="image/png"
        aria-label="上传背景皮肤"
        hidden
        @change="importImage"
      />
      <p v-if="importing" class="appearance-layer-image-status" role="status">
        正在导入皮肤，透明区域会保留。
      </p>
      <p v-if="imageError" class="appearance-layer-image-error" role="alert">{{ imageError }}</p>
    </template>
    <template v-if="skinAvailable && layers.skin.image">
      <label class="appearance-layer-enable">
        <strong>显示皮肤</strong>
        <input
          type="checkbox"
          role="switch"
          :checked="layers.skin.enabled"
          @change="changeSkin({ enabled: ($event.target as HTMLInputElement).checked })"
        />
      </label>
      <label
        >填充方式
        <select
          aria-label="皮肤填充方式"
          :value="layers.skin.fit"
          @change="
            changeSkin({
              fit: ($event.target as HTMLSelectElement).value as AppearanceSkinLayer['fit']
            })
          "
        >
          <option value="fill">拉伸填充</option>
          <option value="contain">完整显示（等比）</option>
          <option value="cover">铺满部件（裁切）</option>
        </select>
      </label>
      <label
        >显示范围
        <select
          aria-label="皮肤显示范围"
          :value="layers.skin.placement"
          @change="
            changeSkin({
              placement: ($event.target as HTMLSelectElement).value as 'inside' | 'outside'
            })
          "
        >
          <option value="outside">允许出框</option>
          <option value="inside">部件内部</option>
        </select>
      </label>
      <div v-for="field in imageFields" :key="field.key" class="appearance-layer-image-field">
        <div>
          <label :for="'appearance-image-' + scope + '-' + tone + '-' + field.key">{{
            field.label
          }}</label>
          <EditableRangeValue
            :value="layers.skin[field.key]"
            :min="field.min"
            :max="field.max"
            suffix="%"
            :aria-label="'皮肤' + field.label + '数值'"
            :disabled="locked"
            @change="changeSkin({ [field.key]: $event })"
          />
        </div>
        <input
          :id="'appearance-image-' + scope + '-' + tone + '-' + field.key"
          type="range"
          :min="field.min"
          :max="field.max"
          :value="layers.skin[field.key]"
          :aria-label="'皮肤' + field.label"
          @input="changeSkin({ [field.key]: Number(($event.target as HTMLInputElement).value) })"
        />
      </div>
      <details class="appearance-layer-detail">
        <summary>高级：主体边界</summary>
        <div class="appearance-layer-detail-fields">
          <p>标出 PNG 中主体区域之外的四边比例。中间矩形对应部件本身，透明边缘可延展出框。</p>
          <div v-for="field in frameFields" :key="field.key" class="appearance-layer-image-field">
            <div>
              <label :for="'appearance-frame-' + scope + '-' + tone + '-' + field.key">{{
                field.label
              }}</label>
              <EditableRangeValue
                :value="layers.skin.frame[field.key]"
                :min="0"
                :max="45"
                suffix="%"
                :aria-label="'主体边界' + field.label + '数值'"
                :disabled="locked"
                @change="changeSkin({ frame: { ...layers.skin.frame, [field.key]: $event } })"
              />
            </div>
            <input
              :id="'appearance-frame-' + scope + '-' + tone + '-' + field.key"
              type="range"
              min="0"
              max="45"
              :value="layers.skin.frame[field.key]"
              :aria-label="'主体边界' + field.label"
              @input="
                changeSkin({
                  frame: {
                    ...layers.skin.frame,
                    [field.key]: Number(($event.target as HTMLInputElement).value)
                  }
                })
              "
            />
          </div>
        </div>
      </details>
    </template>
    <label v-if="scope === 'inner-panel'"
      >内框圆角 <output>{{ settings.innerRadius }}px</output>
      <input
        type="range"
        aria-label="内框圆角"
        min="0"
        max="48"
        :value="settings.innerRadius"
        @input="radius(Number(($event.target as HTMLInputElement).value))"
      />
    </label>
    <details class="appearance-layer-advanced" :open="!skinAvailable">
      <summary>
        {{ skinAvailable ? '高级颜色效果' : '颜色与效果' }}
        <small v-if="layers.effect.enabled">已启用</small>
      </summary>
      <div class="appearance-layer-detail-fields">
        <div class="appearance-layer-channels" role="group" aria-label="编辑图层">
          <button
            v-if="scope !== 'inner-panel'"
            type="button"
            :aria-pressed="channel === 'body'"
            @click="channel = 'body'"
          >
            主体层
          </button>
          <button type="button" :aria-pressed="channel === 'effect'" @click="channel = 'effect'">
            效果层
          </button>
        </div>
        <label class="appearance-layer-enable">
          <span>
            <strong>{{ channel === 'body' ? '自定义主体' : '启用颜色效果' }}</strong>
            <small v-if="!layer.enabled">{{
              channel === 'body' ? '沿用主题外观' : '开启后调整颜色和动态'
            }}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            :checked="layer.enabled"
            @change="change({ enabled: ($event.target as HTMLInputElement).checked })"
          />
        </label>
        <template v-if="layer.enabled">
          <label
            >颜色<input
              type="color"
              :aria-label="channel === 'body' ? '主体颜色' : '效果颜色'"
              :value="layer.color"
              @input="change({ color: ($event.target as HTMLInputElement).value })"
          /></label>
          <label
            >不透明度 <output>{{ layer.opacity }}%</output>
            <input
              type="range"
              min="0"
              max="100"
              :value="layer.opacity"
              :aria-label="channel === 'body' ? '主体不透明度' : '效果不透明度'"
              @input="change({ opacity: Number(($event.target as HTMLInputElement).value) })"
            />
          </label>
          <template v-if="channel === 'effect'">
            <label
              >显示范围
              <select
                aria-label="效果显示范围"
                :value="layers.effect.placement"
                @change="
                  change({
                    placement: ($event.target as HTMLSelectElement).value as 'inside' | 'outside'
                  })
                "
              >
                <option value="outside">出框</option>
                <option value="inside">控件内部</option>
              </select>
            </label>
            <label
              >动态
              <select
                aria-label="效果动态"
                :value="layers.effect.motion"
                @change="
                  change({
                    motion: ($event.target as HTMLSelectElement)
                      .value as AppearanceEffectLayer['motion']
                  })
                "
              >
                <option value="none">静态</option>
                <option value="breathe">呼吸</option>
                <option value="drift">漂移</option>
              </select>
            </label>
            <label
              >扩展 <output>{{ layers.effect.spread }}px</output
              ><input
                aria-label="效果扩展"
                type="range"
                min="0"
                max="48"
                :value="layers.effect.spread"
                @input="change({ spread: Number(($event.target as HTMLInputElement).value) })"
            /></label>
            <label
              >柔化 <output>{{ layers.effect.blur }}px</output
              ><input
                aria-label="效果柔化"
                type="range"
                min="0"
                max="64"
                :value="layers.effect.blur"
                @input="change({ blur: Number(($event.target as HTMLInputElement).value) })"
            /></label>
          </template>
        </template>
      </div>
    </details>
  </fieldset>
</template>
<style scoped>
.appearance-layer-settings {
  --appearance-layer-control-height: max(
    var(--te-control-height-md, 34px),
    calc(var(--te-type-body) * 1.4 + 8px)
  );
  display: grid;
  gap: 12px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--te-settings-text);
  font: var(--te-type-body)/var(--te-type-line-body) var(--te-font-sans);
}
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: var(--appearance-layer-control-height);
  min-width: 0;
  padding: 4px 10px;
  border: 1px solid var(--te-settings-control-border);
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--te-settings-control-bg);
  box-shadow: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
.appearance-layer-image-intro > strong {
  font-weight: var(--te-control-font-weight-strong, 600);
}
.appearance-layer-image-intro p,
.appearance-layer-image-status,
.appearance-layer-image-error {
  font-size: var(--te-type-caption);
}
.appearance-layer-image-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.appearance-layer-image-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 56px;
  padding: 4px;
  border: 1px solid var(--te-settings-control-border);
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--te-settings-control-bg);
}
.appearance-layer-image-preview img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.appearance-layer-image-field {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.appearance-layer-image-field > div {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.appearance-layer-image-field :deep(.editable-range-value) {
  width: 5.5em;
  min-width: 68px;
  min-height: var(--appearance-layer-control-height);
  height: auto;
  padding: 0 4px;
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--te-settings-control-bg);
  box-shadow: none;
  color: inherit;
  font: inherit;
}
.appearance-layer-image-field :deep(.editable-range-value input) {
  min-height: var(--appearance-layer-control-height);
  height: auto;
  color: inherit;
  font: inherit;
}
.appearance-layer-image-field :deep(.editable-range-value:focus-within) {
  border-color: var(--te-control-focus-color, var(--te-editor-accent));
  box-shadow: none;
}
.appearance-layer-settings input[type='range'] {
  width: 100%;
  min-width: 0;
  min-height: var(--te-control-height-sm, 28px);
  margin: 0;
  accent-color: var(--te-editor-accent, var(--te-settings-text));
}
.appearance-layer-settings .appearance-layer-image-error {
  color: var(--te-error);
}
.appearance-layer-channels {
  display: flex;
  gap: 4px;
  padding: 4px;
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--te-settings-search-bg, var(--te-hover-bg));
}
.appearance-layer-channels button {
  flex: 1;
  min-width: 0;
  min-height: var(--appearance-layer-control-height);
  padding: 4px 8px;
  border: 0;
  border-radius: var(--te-control-radius-sm, 8px);
  background: transparent;
  box-shadow: none;
  color: var(--te-settings-text-muted);
  font: inherit;
  cursor: pointer;
}
.appearance-layer-channels button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
.appearance-layer-channels button[aria-pressed='true'] {
  background: var(--te-settings-control-bg);
  color: var(--te-settings-text);
  font-weight: var(--te-control-font-weight-strong, 600);
}
.appearance-layer-enable {
  justify-content: space-between;
  min-height: var(--appearance-layer-control-height);
}
.appearance-layer-enable > span {
  display: grid;
  flex: 1 1 140px;
  gap: 2px;
}
.appearance-layer-enable strong {
  font-weight: var(--te-control-font-weight, 500);
}
.appearance-layer-enable small {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
}
.appearance-layer-enable input {
  appearance: none;
  position: relative;
  flex: 0 0 36px;
  width: 36px;
  height: 22px;
  margin: 0;
  border: 1px solid var(--te-settings-text-muted);
  border-radius: var(--te-control-radius-pill, 999px);
  background: var(--te-settings-control-bg);
  cursor: pointer;
}
.appearance-layer-enable input::before {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--te-settings-text-muted);
}
.appearance-layer-enable input:checked {
  border-color: var(--te-settings-text);
  background: var(--te-settings-text);
}
.appearance-layer-enable input:checked::before {
  left: 17px;
  background: var(--te-settings-control-bg);
}
label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font: inherit;
}
label > input[type='range'] {
  flex: 1 1 100%;
  min-width: 0;
  width: 100%;
  min-height: var(--te-control-height-sm, 28px);
  margin: 0;
  accent-color: var(--te-editor-accent, var(--te-settings-text));
}
input[type='color'] {
  margin-left: auto;
  width: 44px;
  height: var(--appearance-layer-control-height);
  padding: 3px;
  border: 1px solid var(--te-settings-control-border);
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--te-settings-control-bg);
  cursor: pointer;
}
select {
  margin-left: auto;
  min-width: 0;
  max-width: 100%;
  min-height: var(--appearance-layer-control-height);
  padding: 4px 8px;
  border: 1px solid var(--te-settings-control-border);
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--te-settings-control-bg);
  color: inherit;
  font: inherit;
}
output {
  margin-left: auto;
  color: var(--te-settings-text-muted);
  font-variant-numeric: tabular-nums;
}
.appearance-layer-detail,
.appearance-layer-advanced {
  min-width: 0;
  border-top: 1px solid var(--te-settings-control-border);
  padding-top: 8px;
}
summary {
  min-height: var(--appearance-layer-control-height);
  align-content: center;
  cursor: pointer;
}
.appearance-layer-detail-fields {
  display: grid;
  gap: 12px;
  padding-top: 8px;
}
.appearance-layer-advanced summary small {
  color: var(--te-settings-text-muted);
  font-size: var(--te-type-caption);
  margin-left: 8px;
}
:is(button, input, select, summary):focus-visible {
  outline: var(--te-control-focus-width, 2px) solid
    var(--te-control-focus-color, var(--te-editor-accent));
  outline-offset: var(--te-control-focus-offset, 2px);
}
:is(button, input, select):disabled {
  cursor: default;
}
button:disabled {
  opacity: 0.5;
}
p {
  margin: 0;
  color: var(--te-settings-text-muted);
  padding-top: 4px;
  font: inherit;
  line-height: var(--te-type-line-body);
}
</style>
