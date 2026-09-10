<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { PLAYER_BAR_MODES, type PlayerBarMode } from '../../../../shared/playerBar.ts'
import {
  DEFAULT_PLAYER_BAR_LAYOUT,
  clonePlayerBarLayout,
  normalizePlayerBarLayout,
  resolvePlayerBarRegions,
  type PlayerBarControlId,
  type PlayerBarRegionName,
  type PlayerBarRegions
} from '../../../../shared/playerBarLayout.ts'
import { playerBarControlOptions, playerBarModeOptions, playerBarRegionOptions } from './types.ts'

const { settings, updateSettings } = useSettingsStore()

const layoutOpen = ref(false)
/**
 * Which shape's arrangement is being edited. Starts on the global shape so the
 * panel opens on the arrangement the user is actually looking at, but it is a
 * local choice — editing one shape never switches the shape in use.
 */
const editingShape = ref<PlayerBarMode>(settings.value.playerBar.mode)

const controlLabels = new Map(playerBarControlOptions.map((option) => [option.value, option]))

const regions = computed(() =>
  resolvePlayerBarRegions(settings.value.playerBar.layout, editingShape.value)
)

const shapeIsDefault = computed(() => {
  const current = regions.value
  const fallback = DEFAULT_PLAYER_BAR_LAYOUT[editingShape.value]
  return playerBarRegionOptions.every(
    (region) => current[region.value].join() === fallback[region.value].join()
  )
})

/** Controls not already in this region — adding one moves it out of wherever it was. */
function addableTo(region: PlayerBarRegionName): typeof playerBarControlOptions {
  const placed = new Set(regions.value[region])
  return playerBarControlOptions.filter((option) => !placed.has(option.value))
}

function describe(id: PlayerBarControlId): { label: string; icon: string; hint?: string } {
  return controlLabels.get(id) ?? { label: id, icon: 'pi pi-question' }
}

/**
 * Write one shape's arrangement back. Everything goes through the shared
 * normalizer, so a layout that has lost its play control gets one back here
 * rather than reaching the bar and rendering something unusable.
 */
function commit(next: PlayerBarRegions): void {
  const layout = clonePlayerBarLayout(settings.value.playerBar.layout)
  layout[editingShape.value] = next
  void updateSettings({
    playerBar: { ...settings.value.playerBar, layout: normalizePlayerBarLayout(layout) }
  })
}

function currentRegions(): PlayerBarRegions {
  const current = regions.value
  return {
    left: [...current.left],
    center: [...current.center],
    right: [...current.right]
  }
}

function moveControl(region: PlayerBarRegionName, index: number, delta: number): void {
  const next = currentRegions()
  const items = next[region]
  const target = index + delta
  if (target < 0 || target >= items.length) return
  const [moved] = items.splice(index, 1)
  items.splice(target, 0, moved)
  commit(next)
}

function removeControl(region: PlayerBarRegionName, index: number): void {
  const next = currentRegions()
  next[region].splice(index, 1)
  commit(next)
}

/** Placing a control also lifts it out of any other region, so this doubles as a move. */
function placeControl(region: PlayerBarRegionName, value: string): void {
  if (!value) return
  const id = value as PlayerBarControlId
  const next = currentRegions()
  for (const name of playerBarRegionOptions) {
    next[name.value] = next[name.value].filter((item) => item !== id)
  }
  next[region].push(id)
  commit(next)
}

function resetShape(): void {
  commit({
    left: [...DEFAULT_PLAYER_BAR_LAYOUT[editingShape.value].left],
    center: [...DEFAULT_PLAYER_BAR_LAYOUT[editingShape.value].center],
    right: [...DEFAULT_PLAYER_BAR_LAYOUT[editingShape.value].right]
  })
}

const shapeLabel = computed(
  () =>
    playerBarModeOptions.find((option) => option.value === editingShape.value)?.label ??
    editingShape.value
)

/** Copy explaining what each shape renders on its own, outside the arrangement. */
const chromeNote: Record<PlayerBarMode, string> = {
  standard: '标准形态的内联进度条与两侧时间标签由形态本身渲染，不在编排范围内。',
  mini: '迷你形态中间那条长进度轨由形态本身渲染，占满中间一列，所以中间通常留空。',
  compact: '紧凑形态的进度线贴在播放条顶边，由形态本身渲染，不在编排范围内。'
}
</script>

<template>
  <button
    type="button"
    class="settings-accordion-trigger setting-item"
    :class="{ open: layoutOpen }"
    :aria-expanded="layoutOpen"
    @click="layoutOpen = !layoutOpen"
  >
    <span class="setting-copy">
      <strong>播放条按钮编排</strong>
      <span>为每种形态分别决定左侧、中间、右侧各放哪些按钮，以及它们的先后顺序。</span>
    </span>
    <i class="pi pi-chevron-down"></i>
  </button>
  <div v-if="layoutOpen" class="settings-accordion-body">
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>编辑哪种形态</strong>
        <span>{{ chromeNote[editingShape] }}</span>
      </div>
      <div class="segmented-control">
        <button
          v-for="option in playerBarModeOptions"
          :key="option.value"
          type="button"
          :class="{ active: editingShape === option.value }"
          @click="editingShape = option.value"
        >
          <i :class="option.icon"></i>
          {{ option.label }}
        </button>
      </div>
    </div>
    <hr />
    <div class="playbar-layout-regions">
      <section
        v-for="region in playerBarRegionOptions"
        :key="region.value"
        class="playbar-layout-region"
        :aria-label="`${shapeLabel}形态的${region.label}按钮`"
      >
        <header class="playbar-layout-region-head">
          <strong>{{ region.label }}</strong>
          <span>{{ regions[region.value].length }} 个</span>
        </header>
        <p v-if="regions[region.value].length === 0" class="playbar-layout-empty">这一侧是空的</p>
        <ul v-else class="playbar-layout-list">
          <li
            v-for="(control, index) in regions[region.value]"
            :key="control"
            class="playbar-layout-item"
          >
            <i :class="describe(control).icon" aria-hidden="true"></i>
            <span class="playbar-layout-item-copy">
              <span class="playbar-layout-item-label">{{ describe(control).label }}</span>
              <span v-if="describe(control).hint" class="playbar-layout-item-hint">
                {{ describe(control).hint }}
              </span>
            </span>
            <span class="playbar-layout-item-tools">
              <button
                type="button"
                :disabled="index === 0"
                :title="`把「${describe(control).label}」往前移`"
                :aria-label="`把${describe(control).label}往前移`"
                @click="moveControl(region.value, index, -1)"
              >
                <i class="pi pi-chevron-up" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                :disabled="index === regions[region.value].length - 1"
                :title="`把「${describe(control).label}」往后移`"
                :aria-label="`把${describe(control).label}往后移`"
                @click="moveControl(region.value, index, 1)"
              >
                <i class="pi pi-chevron-down" aria-hidden="true"></i>
              </button>
              <button
                type="button"
                class="playbar-layout-remove"
                :title="`移除「${describe(control).label}」`"
                :aria-label="`移除${describe(control).label}`"
                @click="removeControl(region.value, index)"
              >
                <i class="pi pi-times" aria-hidden="true"></i>
              </button>
            </span>
          </li>
        </ul>
        <select
          class="preview-select"
          :aria-label="`往${region.label}添加按钮`"
          :disabled="addableTo(region.value).length === 0"
          value=""
          @change="
            placeControl(region.value, ($event.target as HTMLSelectElement).value)
            ;($event.target as HTMLSelectElement).value = ''
          "
        >
          <option value="">添加按钮…</option>
          <option
            v-for="option in addableTo(region.value)"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </section>
    </div>
    <hr />
    <div class="setting-item">
      <div class="setting-copy">
        <strong>恢复默认编排</strong>
        <span
          >只重置「{{ shapeLabel }}」这一种形态，其余形态的编排不动。已经是默认时按钮不可用。</span
        >
      </div>
      <button type="button" class="preview-select" :disabled="shapeIsDefault" @click="resetShape">
        恢复默认
      </button>
    </div>
    <p class="playbar-layout-note">
      同一个按钮只会出现在一处：把它添加到别的一侧，就等于从原来那一侧移过去。播放控制至少要留一个，全部移除后会自动补回。
      共 {{ PLAYER_BAR_MODES.length }} 种形态，各自独立编排。
    </p>
  </div>
</template>

<style scoped>
.playbar-layout-regions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.playbar-layout-region {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--te-card-bg) 60%, transparent);
  min-width: 0;
}

.playbar-layout-region-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.playbar-layout-region-head span {
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  color: color-mix(in srgb, currentColor 55%, transparent);
}

.playbar-layout-empty {
  margin: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  color: color-mix(in srgb, currentColor 50%, transparent);
}

.playbar-layout-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.playbar-layout-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 6%, transparent);
}

.playbar-layout-item > i {
  flex: 0 0 auto;
  font-size: calc(var(--te-font-size-body, 14px) * 13 / 14);
  opacity: 0.7;
}

.playbar-layout-item-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}

.playbar-layout-item-label {
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playbar-layout-item-hint {
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
  color: color-mix(in srgb, currentColor 50%, transparent);
}

.playbar-layout-item-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.playbar-layout-item-tools button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: calc(var(--te-font-size-body, 14px) * 10 / 14);
}

.playbar-layout-item-tools button:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 12%, transparent);
}

.playbar-layout-item-tools button:disabled {
  opacity: 0.3;
  cursor: default;
}

.playbar-layout-item-tools .playbar-layout-remove:hover:not(:disabled) {
  background: var(--te-danger-soft-bg);
  color: var(--te-danger-soft-fg);
}

.playbar-layout-note {
  margin: 10px 0 0;
  font-size: calc(var(--te-font-size-body, 14px) * 11 / 14);
  line-height: 1.6;
  color: color-mix(in srgb, currentColor 55%, transparent);
}
</style>
