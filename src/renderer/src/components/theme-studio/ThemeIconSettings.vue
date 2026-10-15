<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import PlaybackIcon from '../icons/PlaybackIcon.vue'
import PlaybackModeIcon from '../icons/PlaybackModeIcon.vue'
import PlayerControlIcon from '../player-bar/PlayerControlIcon.vue'
import {
  THEME_ICON_SLOTS,
  THEME_ICON_SLOT_LABELS,
  THEME_ICON_SLOT_REGISTRY,
  resolveThemeIconUrl,
  type ThemeIconSlot,
  type ThemeProfileV2
} from '../../../../shared/theme'

export type ThemeIconGroup = 'all' | 'navigation' | 'titlebar' | 'playback' | 'library'
const props = defineProps<{
  profile: ThemeProfileV2 | null
  selection: ThemeIconSlot | null
  initialGroup?: ThemeIconGroup
  busy?: boolean
  importing?: boolean
}>()
const emit = defineEmits<{
  select: [slot: ThemeIconSlot | null]
  import: [slot: ThemeIconSlot]
  bind: [slot: ThemeIconSlot, assetId: string]
}>()
const group = ref<ThemeIconGroup>(props.initialGroup ?? 'navigation')
const groups: Array<{ id: ThemeIconGroup; label: string }> = [
  { id: 'navigation', label: '侧边栏与导航' },
  { id: 'titlebar', label: '标题栏' },
  { id: 'playback', label: '播放控件' },
  { id: 'library', label: '资料库' },
  { id: 'all', label: '全部图标' }
]
const titlebarSlots = new Set<ThemeIconSlot>([
  'navigation.menu',
  'navigation.home',
  'navigation.search',
  'navigation.settings',
  'navigation.appearance',
  'navigation.plugin',
  'navigation.back',
  'navigation.person',
  'navigation.notification',
  'navigation.quiet'
])
watch(
  [() => props.initialGroup, () => props.profile?.id],
  () => (group.value = props.initialGroup ?? 'navigation')
)
const slots = computed(() =>
  THEME_ICON_SLOTS.filter((slot) =>
    group.value === 'all'
      ? true
      : group.value === 'titlebar'
        ? titlebarSlots.has(slot)
        : THEME_ICON_SLOT_REGISTRY[slot].domain === group.value
  )
)
const selectedSlot = computed(() =>
  props.selection && slots.value.includes(props.selection)
    ? props.selection
    : (slots.value[0] ?? null)
)
watch(selectedSlot, (slot) => emit('select', slot), { immediate: true })
const binding = computed(() =>
  selectedSlot.value ? (props.profile?.iconBindings?.[selectedSlot.value] ?? '') : ''
)
const imageUrl = computed(() =>
  props.profile && selectedSlot.value ? resolveThemeIconUrl(props.profile, selectedSlot.value) : ''
)
const imageFailed = ref(false)
watch(imageUrl, () => (imageFailed.value = false))
const family = computed(() => props.profile?.modes.icons?.family ?? 'outline')
const defaultClass = computed(() =>
  selectedSlot.value ? THEME_ICON_SLOT_REGISTRY[selectedSlot.value].classes[family.value] : ''
)
const DefaultIcon = () => {
  const name = selectedSlot.value?.startsWith('playback.')
    ? selectedSlot.value.slice('playback.'.length)
    : ''
  if (name === 'play' || name === 'pause' || name === 'previous' || name === 'next')
    return h(PlaybackIcon, { name, defaultOnly: true })
  if (
    name === 'volume' ||
    name === 'muted' ||
    name === 'queue' ||
    name === 'equalizer' ||
    name === 'miniPlayer' ||
    name === 'favorite'
  )
    return h(PlayerControlIcon, { name, defaultOnly: true })
  if (name === 'favoriteActive')
    return h(PlayerControlIcon, { name: 'favorite', filled: true, defaultOnly: true })
  if (
    name === 'sequential' ||
    name === 'listLoop' ||
    name === 'repeat' ||
    name === 'shuffle' ||
    name === 'heart'
  )
    return h(PlaybackModeIcon, { mode: name, defaultOnly: true })
  return h('i', { class: defaultClass.value })
}
const imageAssets = computed(
  () => props.profile?.assets?.filter((asset) => asset.type === 'image') ?? []
)
const locked = computed(() => props.busy || !props.profile || !selectedSlot.value)
function select(event: Event): void {
  const slot = (event.target as HTMLSelectElement).value as ThemeIconSlot
  if (slots.value.includes(slot)) emit('select', slot)
}
function bind(event: Event): void {
  if (selectedSlot.value)
    emit('bind', selectedSlot.value, (event.target as HTMLSelectElement).value)
}
function slotLabel(slot: ThemeIconSlot): string {
  const label = THEME_ICON_SLOT_LABELS[slot]
  if (group.value !== 'all') return label
  const domainLabel = { navigation: '导航', library: '资料库', playback: '播放' }
  return `${domainLabel[THEME_ICON_SLOT_REGISTRY[slot].domain]} · ${label}`
}
</script>

<template>
  <section class="theme-icon-settings" aria-label="图标设置" :aria-busy="importing">
    <div class="theme-icon-settings-heading"><strong>图标</strong></div>
    <p class="theme-icon-settings-hint">替换当前主题的图标，深浅外观共用。透明区域会保留。</p>
    <p v-if="!profile" class="theme-icon-settings-hint" role="status">
      先创建主题副本，即可替换图标。
    </p>
    <fieldset :disabled="locked">
      <label>
        <span>分组</span>
        <select v-model="group" aria-label="图标分组">
          <option v-for="item in groups" :key="item.id" :value="item.id">{{ item.label }}</option>
        </select>
      </label>
      <label>
        <span>图标</span>
        <select :value="selectedSlot ?? ''" aria-label="选择图标" @change="select">
          <option v-for="slot in slots" :key="slot" :value="slot">
            {{ slotLabel(slot) }}
          </option>
        </select>
      </label>
      <div v-if="selectedSlot" class="theme-icon-settings-previews">
        <div>
          <span class="theme-icon-settings-sample" aria-hidden="true"><DefaultIcon /></span>
          <span>默认</span>
        </div>
        <div>
          <span class="theme-icon-settings-sample" data-icon-replacement-preview aria-hidden="true">
            <img
              v-if="imageUrl && !imageFailed"
              :src="imageUrl"
              alt=""
              @error="imageFailed = true"
            />
            <DefaultIcon v-else />
          </span>
          <span>{{ imageUrl && !imageFailed ? '替换图片' : '当前图标' }}</span>
        </div>
      </div>
      <p v-if="imageFailed" class="theme-icon-settings-hint" role="status">
        图片不可用，暂时显示默认图标。
      </p>
      <div class="theme-icon-settings-actions">
        <button
          type="button"
          data-icon-upload
          @click="selectedSlot && emit('import', selectedSlot)"
        >
          {{ importing ? '正在导入…' : binding ? '更换图片' : '上传图片' }}
        </button>
        <button
          type="button"
          data-icon-reset
          :disabled="!binding"
          @click="selectedSlot && emit('bind', selectedSlot, '')"
        >
          恢复默认
        </button>
      </div>
      <label v-if="imageAssets.length">
        <span>已有素材</span>
        <select :value="binding" aria-label="使用已导入图标图片" @change="bind">
          <option value="">默认图标</option>
          <option v-for="(asset, index) in imageAssets" :key="asset.id" :value="asset.id">
            图片 {{ index + 1 }} · {{ asset.path.split('.').at(-1)?.toUpperCase() }}
          </option>
        </select>
      </label>
    </fieldset>
    <p class="theme-icon-settings-hint" role="status">
      {{ importing ? '正在导入图标，请稍候。' : '支持 PNG、WebP；更改在应用主题后保存。' }}
    </p>
  </section>
</template>

<style scoped>
.theme-icon-settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  color: var(--appearance-edit-text, var(--te-settings-text));
  font: var(--te-type-body)/var(--te-type-line-body) var(--te-font-sans);
}
.theme-icon-settings-heading strong {
  font-weight: var(--te-type-weight-strong);
}
.theme-icon-settings-hint {
  margin: 0;
  color: var(--appearance-edit-muted, var(--te-settings-text-muted));
  font-size: var(--te-type-caption);
}
.theme-icon-settings fieldset {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}
.theme-icon-settings label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  min-width: 0;
}
.theme-icon-settings label > span {
  flex: 0 0 auto;
}
.theme-icon-settings :is(select, button) {
  box-sizing: border-box;
  min-height: max(var(--te-control-height-md), 2em);
  min-width: 0;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--appearance-edit-line, var(--te-settings-control-border));
  border-radius: var(--te-control-radius-sm);
  background: var(--appearance-edit-field, var(--te-settings-control-bg));
  color: inherit;
  font: inherit;
}
.theme-icon-settings select {
  flex: 1 1 150px;
  width: 0;
}
.theme-icon-settings button {
  cursor: pointer;
}
.theme-icon-settings button:not(:disabled):hover {
  background: var(--appearance-edit-hover, var(--te-hover-bg));
}
.theme-icon-settings :is(button, select):focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 2px;
}
.theme-icon-settings :is(button, select):disabled {
  cursor: default;
  opacity: var(--te-disabled-opacity, 0.5);
}
.theme-icon-settings-previews {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  padding-block: 6px;
}
.theme-icon-settings-previews > div {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--te-type-caption);
}
.theme-icon-settings-sample {
  display: grid;
  width: 40px;
  height: 40px;
  flex: 0 0 40px;
  place-items: center;
  font-size: 24px;
}
.theme-icon-settings-sample img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  pointer-events: none;
}
.theme-icon-settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
