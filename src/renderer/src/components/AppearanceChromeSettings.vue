<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ThemeIcon from './ThemeIcon.vue'
import { cloneAppearance, type AppearanceDraft } from '../../../shared/appAppearance'
import { normalizeNavigationPagePreferences } from '../../../shared/navigationPages'
import { normalizePlayerBarSettings, type PlayerBarMode } from '../../../shared/playerBar'
import {
  DEFAULT_PLAYER_BAR_LAYOUT,
  clonePlayerBarLayout,
  normalizePlayerBarLayout,
  resolvePlayerBarRegions,
  type PlayerBarControlId,
  type PlayerBarRegionName,
  type PlayerBarRegions
} from '../../../shared/playerBarLayout'
import {
  BUILTIN_NAVIGATION_PAGES,
  createNavigationPageDraft,
  isNavigationPageVisible,
  moveNavigationPage,
  orderNavigationPages,
  type NavigationPageDefinition
} from '../app/navigationPages'
import { buildSidebarEntries, sidebarGroupTitle } from '../app/sidebarNavigation'
import {
  playerBarControlOptions,
  playerBarModeOptions,
  playerBarRegionOptions
} from './settings-page/types'

const props = withDefaults(
  defineProps<{
    draft: AppearanceDraft
    part: 'navigation' | 'player-bar'
    busy?: boolean
    pages?: NavigationPageDefinition[]
  }>(),
  { pages: () => BUILTIN_NAVIGATION_PAGES }
)
const emit = defineEmits<{ 'update:draft': [draft: AppearanceDraft] }>()
const expanded = ref(false)
watch(
  () => props.part,
  () => {
    expanded.value = false
  }
)
const navigation = computed(() => normalizeNavigationPagePreferences(props.draft.navigationPages))
const orderedPages = computed(() => orderNavigationPages(props.pages, navigation.value))
const pageGroups = computed(() => {
  const groups = new Map<string, NavigationPageDefinition[]>()
  for (const entry of buildSidebarEntries(orderedPages.value)) {
    if (entry.kind === 'group') groups.set(entry.title, entry.pages)
    else {
      const title = sidebarGroupTitle(entry.page.id) ?? '页面'
      const group = groups.get(title) ?? []
      group.push(entry.page)
      groups.set(title, group)
    }
  }
  return [...groups].map(([title, pages]) => ({ title, pages }))
})
const navigationIsDefault = computed(() =>
  orderedPages.value.every(
    (page, index) =>
      page.id === props.pages[index]?.id &&
      isNavigationPageVisible(page, navigation.value) === page.defaultVisible
  )
)
const playerBar = computed(() => normalizePlayerBarSettings(props.draft.playerBar))
const playerRegions = computed(() =>
  resolvePlayerBarRegions(playerBar.value.layout, playerBar.value.mode)
)
const region = ref<PlayerBarRegionName>(playerBar.value.mode === 'mini' ? 'left' : 'center')
watch(
  () => playerBar.value.mode,
  (mode) => {
    region.value = mode === 'mini' ? 'left' : 'center'
  }
)
const controls = computed(() => playerRegions.value[region.value])
const controlLabels = new Map(playerBarControlOptions.map((option) => [option.value, option]))
const addableControls = computed(() =>
  playerBarControlOptions.filter((option) => !controls.value.includes(option.value))
)
const shapeIsDefault = computed(() => {
  const fallback = DEFAULT_PLAYER_BAR_LAYOUT[playerBar.value.mode]
  return playerBarRegionOptions.every(
    (option) => playerRegions.value[option.value].join() === fallback[option.value].join()
  )
})

function blockBusy(event: MouseEvent): void {
  if (props.busy) event.preventDefault()
}
function disclosureChanged(event: Event): void {
  expanded.value = (event.target as HTMLDetailsElement).open
}
function describe(id: PlayerBarControlId): (typeof playerBarControlOptions)[number] {
  return controlLabels.get(id) ?? { value: id, label: id, icon: 'pi pi-question' }
}
function togglePage(page: NavigationPageDefinition): void {
  if (props.busy) return
  const next = createNavigationPageDraft(props.pages, navigation.value)
  const hidden = new Set(next.hidden)
  if (isNavigationPageVisible(page, navigation.value)) hidden.add(page.id)
  else hidden.delete(page.id)
  const draft = cloneAppearance(props.draft)
  draft.navigationPages = normalizeNavigationPagePreferences({ ...next, hidden: [...hidden] })
  emit('update:draft', draft)
}
function stepPage(pages: NavigationPageDefinition[], index: number, offset: number): void {
  if (props.busy) return
  const target = pageMoveTarget(pages, index, offset)
  if (!target) return
  const draft = cloneAppearance(props.draft)
  const next = createNavigationPageDraft(props.pages, navigation.value)
  if (isHomeSearch(pages[index].id)) {
    const pair = ['local-home', 'search'].filter((id) => props.pages.some((page) => page.id === id))
    const order = next.order.filter((id) => !pair.includes(id))
    order.splice(order.indexOf(target.id) + (offset > 0 ? 1 : 0), 0, ...pair)
    draft.navigationPages = { ...next, order }
  } else {
    const pairEdge = offset < 0 ? 'local-home' : 'search'
    const targetId =
      isHomeSearch(target.id) && pages.some((page) => page.id === pairEdge) ? pairEdge : target.id
    draft.navigationPages = moveNavigationPage(next, pages[index].id, targetId)
  }
  emit('update:draft', draft)
}
function isHomeSearch(id: string): boolean {
  return id === 'local-home' || id === 'search'
}
function pageMoveTarget(
  pages: NavigationPageDefinition[],
  index: number,
  offset: number
): NavigationPageDefinition | undefined {
  let targetIndex = index + offset
  if (isHomeSearch(pages[index].id))
    while (pages[targetIndex] && isHomeSearch(pages[targetIndex].id)) targetIndex += offset
  return pages[targetIndex]
}
function resetPages(): void {
  if (props.busy || navigationIsDefault.value) return
  const known = new Set(props.pages.map((page) => page.id))
  const draft = cloneAppearance(props.draft)
  draft.navigationPages = {
    version: 1,
    order: [
      ...props.pages.map((page) => page.id),
      ...navigation.value.order.filter((id) => !known.has(id))
    ],
    hidden: [
      ...props.pages.filter((page) => !page.defaultVisible).map((page) => page.id),
      ...navigation.value.hidden.filter((id) => !known.has(id))
    ]
  }
  emit('update:draft', draft)
}
function setMode(value: string): void {
  if (props.busy || !playerBarModeOptions.some((option) => option.value === value)) return
  const draft = cloneAppearance(props.draft)
  draft.playerBar = normalizePlayerBarSettings({
    ...playerBar.value,
    mode: value as PlayerBarMode,
    modeSource: 'user'
  })
  emit('update:draft', draft)
}
function currentRegions(): PlayerBarRegions {
  return {
    left: [...playerRegions.value.left],
    center: [...playerRegions.value.center],
    right: [...playerRegions.value.right]
  }
}
function commitRegions(next: PlayerBarRegions): void {
  if (props.busy) return
  const layout = clonePlayerBarLayout(playerBar.value.layout)
  layout[playerBar.value.mode] = next
  const draft = cloneAppearance(props.draft)
  draft.playerBar = {
    ...playerBar.value,
    layout: normalizePlayerBarLayout(layout)
  }
  emit('update:draft', draft)
}
function moveControl(index: number, offset: number): void {
  if (props.busy) return
  const next = currentRegions()
  const items = next[region.value]
  const target = index + offset
  if (target < 0 || target >= items.length) return
  const [moved] = items.splice(index, 1)
  items.splice(target, 0, moved)
  commitRegions(next)
}
function canRemove(id: PlayerBarControlId): boolean {
  if (id !== 'transport' && id !== 'playPause') return true
  return (
    Object.values(playerRegions.value)
      .flat()
      .filter((control) => control === 'transport' || control === 'playPause').length > 1
  )
}
function removeControl(index: number): void {
  if (props.busy || !canRemove(controls.value[index])) return
  const next = currentRegions()
  next[region.value].splice(index, 1)
  commitRegions(next)
}
function placeControl(value: string): void {
  if (props.busy || !addableControls.value.some((option) => option.value === value)) return
  const id = value as PlayerBarControlId
  const next = currentRegions()
  for (const name of playerBarRegionOptions)
    next[name.value] = next[name.value].filter((control) => control !== id)
  next[region.value].push(id)
  commitRegions(next)
}
function addControl(event: Event): void {
  const select = event.target as HTMLSelectElement
  placeControl(select.value)
  select.value = ''
}
function resetShape(): void {
  if (props.busy || shapeIsDefault.value) return
  const fallback = DEFAULT_PLAYER_BAR_LAYOUT[playerBar.value.mode]
  commitRegions({
    left: [...fallback.left],
    center: [...fallback.center],
    right: [...fallback.right]
  })
}
</script>

<template>
  <details
    :key="part"
    class="appearance-chrome-settings"
    :data-chrome-part="part"
    :open="expanded"
    @toggle="disclosureChanged"
  >
    <summary :aria-disabled="busy || undefined" :tabindex="busy ? -1 : 0" @click="blockBusy">
      <span>{{ part === 'navigation' ? '导航选项' : '按钮排列' }}</span>
      <i class="pi pi-angle-down" aria-hidden="true" />
    </summary>
    <fieldset v-if="expanded" :disabled="busy">
      <template v-if="part === 'navigation'">
        <p class="appearance-chrome-note">勾选显示，栏目内排序；主页与搜索保持相邻。</p>
        <section v-for="group in pageGroups" :key="group.title" class="appearance-chrome-group">
          <h4>{{ group.title }}</h4>
          <ul>
            <li v-for="(page, index) in group.pages" :key="page.id" :data-navigation-page="page.id">
              <label
                class="appearance-chrome-page"
                :title="page.unavailableReason ?? page.description"
              >
                <input
                  type="checkbox"
                  :checked="isNavigationPageVisible(page, navigation)"
                  :aria-label="`显示${page.title}`"
                  @change="togglePage(page)"
                />
                <i v-if="page.customIcon" :class="page.customIcon" aria-hidden="true" />
                <ThemeIcon v-else :icon-slot="page.icon" />
                <span class="appearance-chrome-page-name">{{ page.title }}</span>
              </label>
              <button
                type="button"
                :disabled="!pageMoveTarget(group.pages, index, -1)"
                :aria-label="`上移${page.title}`"
                @click="stepPage(group.pages, index, -1)"
              >
                <i class="pi pi-angle-up" aria-hidden="true" />
              </button>
              <button
                type="button"
                :disabled="!pageMoveTarget(group.pages, index, 1)"
                :aria-label="`下移${page.title}`"
                @click="stepPage(group.pages, index, 1)"
              >
                <i class="pi pi-angle-down" aria-hidden="true" />
              </button>
            </li>
          </ul>
        </section>
        <button
          type="button"
          class="appearance-chrome-reset"
          :disabled="navigationIsDefault"
          @click="resetPages"
        >
          恢复导航默认
        </button>
      </template>
      <template v-else>
        <label class="appearance-chrome-field">
          形态
          <select
            aria-label="播放栏形态"
            :value="playerBar.mode"
            @change="setMode(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="option in playerBarModeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <nav class="appearance-chrome-regions" aria-label="按钮位置">
          <button
            v-for="option in playerBarRegionOptions"
            :key="option.value"
            type="button"
            :aria-pressed="region === option.value"
            :data-control-region="option.value"
            @click="region = option.value"
          >
            {{ option.label }}
          </button>
        </nav>
        <ul
          :aria-label="`${playerBarRegionOptions.find((option) => option.value === region)?.label}按钮`"
        >
          <li v-for="(control, index) in controls" :key="control" :data-player-control="control">
            <i :class="describe(control).icon" aria-hidden="true" />
            <span
              class="appearance-chrome-name"
              :title="describe(control).hint ?? describe(control).label"
            >
              {{ describe(control).label }}
            </span>
            <button
              type="button"
              :disabled="index === 0"
              :aria-label="`把${describe(control).label}往前移`"
              @click="moveControl(index, -1)"
            >
              <i class="pi pi-angle-up" aria-hidden="true" />
            </button>
            <button
              type="button"
              :disabled="index === controls.length - 1"
              :aria-label="`把${describe(control).label}往后移`"
              @click="moveControl(index, 1)"
            >
              <i class="pi pi-angle-down" aria-hidden="true" />
            </button>
            <button
              type="button"
              :disabled="!canRemove(control)"
              :title="!canRemove(control) ? '至少保留一个播放控制' : undefined"
              :aria-label="`移除${describe(control).label}`"
              @click="removeControl(index)"
            >
              <i class="pi pi-times" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <p v-if="!controls.length" class="appearance-chrome-note">此位置没有按钮</p>
        <select
          class="appearance-chrome-add"
          :aria-label="`往${playerBarRegionOptions.find((option) => option.value === region)?.label}添加按钮`"
          :disabled="!addableControls.length"
          value=""
          @change="addControl"
        >
          <option value="">添加或移入按钮…</option>
          <option v-for="option in addableControls" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <button
          type="button"
          class="appearance-chrome-reset"
          :disabled="shapeIsDefault"
          @click="resetShape"
        >
          恢复当前形态排列
        </button>
      </template>
    </fieldset>
  </details>
</template>

<style scoped>
.appearance-chrome-settings {
  margin-top: 8px;
  min-width: 0;
  font: inherit;
}
summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 32px;
  border-radius: var(--te-control-radius-sm, 8px);
  list-style: none;
  cursor: pointer;
}
summary::-webkit-details-marker {
  display: none;
}
summary > i {
  font-size: 12px;
}
details[open] > summary > i {
  transform: rotate(180deg);
}
summary[aria-disabled='true'] {
  opacity: 0.5;
  cursor: default;
}
fieldset {
  min-width: 0;
  padding: 8px 0 0;
  margin: 0;
  border: 0;
}
fieldset:disabled {
  opacity: 0.5;
}
.appearance-chrome-note,
.appearance-chrome-group h4 {
  margin: 0 0 8px;
  color: var(--te-settings-text-muted);
  font: inherit;
  line-height: 1.5;
}
.appearance-chrome-group {
  margin-bottom: 12px;
}
.appearance-chrome-group h4 {
  font-weight: var(--te-control-font-weight, 500);
}
ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
li {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  min-height: 32px;
}
.appearance-chrome-page {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 32px;
  cursor: pointer;
}
.appearance-chrome-page > input {
  width: 16px;
  height: 16px;
  margin: 0;
  flex: 0 0 auto;
  accent-color: var(--te-editor-accent, currentColor);
}
.appearance-chrome-page-name,
.appearance-chrome-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.appearance-chrome-name {
  margin-left: 4px;
}
li > i,
.appearance-chrome-page > i {
  flex-shrink: 0;
  font-size: 12px;
}
.appearance-chrome-settings button {
  flex-shrink: 0;
  min-width: 32px;
  min-height: 32px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--te-control-radius-sm, 8px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.appearance-chrome-settings button:disabled {
  opacity: 0.35;
  cursor: default;
}
.appearance-chrome-settings button:not(:disabled):hover,
summary:not([aria-disabled='true']):hover {
  background: var(--te-hover-bg);
}
.appearance-chrome-field {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  margin-bottom: 8px;
}
.appearance-chrome-settings select {
  box-sizing: border-box;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--te-settings-control-border);
  border-radius: var(--te-control-radius-sm, 8px);
  background: var(--te-settings-control-bg);
  color: inherit;
  font: inherit;
}
.appearance-chrome-field select {
  flex: 1;
}
.appearance-chrome-regions {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.appearance-chrome-regions button {
  flex: 1;
}
.appearance-chrome-regions button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--te-editor-accent) 14%, transparent);
  font-weight: var(--te-control-font-weight, 500);
}
.appearance-chrome-add {
  width: 100%;
  margin-top: 8px;
}
.appearance-chrome-settings .appearance-chrome-reset {
  margin-top: 8px;
  padding-inline: 0;
  color: var(--te-settings-text-muted);
}
.appearance-chrome-settings :is(summary, button, input, select):focus-visible {
  outline: 2px solid var(--te-editor-accent, currentColor);
  outline-offset: 2px;
}
</style>
