<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  sections,
  SETTINGS_SEARCH_INDEX,
  type SectionKey,
  type SettingsSearchEntry
} from './types.ts'

const props = withDefaults(
  defineProps<{
    activeSection: SectionKey
    heading?: string
    idPrefix?: string
    disabled?: boolean
  }>(),
  { idPrefix: 'settings', heading: '设置', disabled: false }
)
const emit = defineEmits<{
  category: [section: SectionKey, keyboard: boolean]
  search: [entry: SettingsSearchEntry, keyboard: boolean]
}>()
const query = ref('')
const activeIndex = ref(-1)
const navigation = ref<HTMLElement>()
const compact = ref(true)
let sizing: ResizeObserver | undefined
watch(query, () => {
  activeIndex.value = -1
})
watch(compact, async (next) => {
  const root = navigation.value
  const focused = document.activeElement
  if (!root || !(focused instanceof HTMLElement) || !root.contains(focused)) return
  const categoryHasFocus = next
    ? focused.matches('[data-settings-category]')
    : focused.matches('.settings-market-category-select')
  if (!categoryHasFocus) return
  await nextTick()
  // A resize changes the category control, while retaining its input target.
  if (document.activeElement !== focused && document.activeElement !== document.body) return
  root
    .querySelector<HTMLElement>(
      next
        ? '.settings-market-category-select'
        : `[data-settings-category="${props.activeSection}"]`
    )
    ?.focus({ preventScroll: true })
})
function dismissSearch(event: PointerEvent): void {
  if (event.target instanceof Node && !navigation.value?.contains(event.target)) query.value = ''
}
function dismissSearchOnBlur(event: FocusEvent): void {
  if (
    event.currentTarget instanceof Node &&
    (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
  )
    query.value = ''
}
onMounted(() => {
  document.addEventListener('pointerdown', dismissSearch)
  const measure = (): void => {
    const root = navigation.value
    if (!root) return
    const buttons = [...root.querySelectorAll<HTMLElement>('[data-settings-category]')]
    const categories = root.querySelector<HTMLElement>('.settings-nav-categories')
    const gap = categories ? parseFloat(getComputedStyle(categories).columnGap) || 0 : 0
    const required =
      buttons.reduce((width, button) => width + button.getBoundingClientRect().width, 0) +
      Math.max(0, buttons.length - 1) * gap
    compact.value = innerWidth <= 960 || required > root.clientWidth
  }
  sizing = new ResizeObserver(measure)
  if (navigation.value) {
    sizing.observe(navigation.value)
    navigation.value
      .querySelectorAll('[data-settings-category]')
      .forEach((button) => sizing?.observe(button))
  }
  measure()
})
onBeforeUnmount(() => {
  sizing?.disconnect()
  document.removeEventListener('pointerdown', dismissSearch)
})
const matches = computed(() => {
  const term = query.value.trim().toLowerCase()
  if (!term) return []
  return SETTINGS_SEARCH_INDEX.filter((entry) => entry.section !== 'appearance')
    .map((entry) => {
      const title = entry.title.toLowerCase()
      return {
        entry,
        score:
          title === term
            ? 4
            : title.startsWith(term)
              ? 3
              : title.includes(term)
                ? 2
                : entry.terms.toLowerCase().includes(term)
                  ? 1
                  : 0
      }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.entry)
})
function clearSearch(): void {
  query.value = ''
  navigation.value?.querySelector('input')?.focus({ preventScroll: true })
}
function choose(section: SectionKey, keyboard = false): void {
  if (props.disabled) return
  query.value = ''
  emit('category', section, keyboard)
}
function chooseResult(entry: SettingsSearchEntry, keyboard = false): void {
  if (props.disabled) return
  query.value = ''
  emit('search', entry, keyboard)
}
function moveResult(delta: number): void {
  if (!matches.value.length) return
  activeIndex.value =
    activeIndex.value < 0
      ? delta > 0
        ? 0
        : matches.value.length - 1
      : (activeIndex.value + delta + matches.value.length) % matches.value.length
  void nextTick(() =>
    navigation.value
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  )
}
function categoryKey(event: KeyboardEvent, section: SectionKey): void {
  const index = sections.findIndex((item) => item.key === section)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? sections.length - 1
        : event.key === 'ArrowRight'
          ? (index + 1) % sections.length
          : event.key === 'ArrowLeft'
            ? (index + sections.length - 1) % sections.length
            : -1
  if (next < 0 || props.disabled) return
  event.preventDefault()
  choose(sections[next].key, true)
  void nextTick(() =>
    navigation.value
      ?.querySelector<HTMLButtonElement>(`[data-settings-category="${sections[next].key}"]`)
      ?.focus()
  )
}
</script>

<template>
  <nav
    ref="navigation"
    class="settings-market-navigation"
    :class="{ 'settings-market-navigation--compact': compact }"
    aria-label="设置分区"
    data-te-material="navigation"
  >
    <div class="settings-market-title-row">
      <h1 class="settings-market-heading">{{ heading }}</h1>
      <slot name="heading-actions" />
    </div>
    <div class="settings-market-category-row">
      <div class="settings-nav-categories" :aria-hidden="compact || undefined">
        <button
          v-for="section in sections"
          :key="section.key"
          type="button"
          class="preview-nav-item"
          :class="{ active: activeSection === section.key }"
          :data-settings-category="section.key"
          :aria-current="activeSection === section.key ? 'page' : undefined"
          :tabindex="!compact && activeSection === section.key ? 0 : -1"
          :disabled="disabled"
          @keydown="categoryKey($event, section.key)"
          @click="choose(section.key, $event.detail === 0)"
        >
          <span>{{ section.label }}</span>
        </button>
      </div>
      <select
        class="settings-market-category-select"
        aria-label="设置分类"
        :value="activeSection"
        :disabled="disabled"
        @change="choose(($event.target as HTMLSelectElement).value as SectionKey, true)"
      >
        <option v-for="section in sections" :key="section.key" :value="section.key">
          {{ section.label }}
        </option>
      </select>
    </div>
    <div class="settings-market-search-wrap" @focusout="dismissSearchOnBlur">
      <div class="settings-market-search te-material" data-te-material="control">
        <i class="pi pi-search" aria-hidden="true" />
        <input
          :id="idPrefix + '-search-input'"
          v-model="query"
          type="search"
          autocomplete="off"
          placeholder="搜索设置"
          aria-label="搜索设置"
          role="combobox"
          aria-autocomplete="list"
          :disabled="disabled"
          :aria-expanded="Boolean(query.trim())"
          :aria-controls="query.trim() ? idPrefix + '-search-results' : undefined"
          :aria-activedescendant="
            activeIndex >= 0 && matches[activeIndex]
              ? idPrefix + '-result-' + activeIndex
              : undefined
          "
          @keydown.down.prevent="moveResult(1)"
          @keydown.up.prevent="moveResult(-1)"
          @keydown.enter.prevent="
            matches[Math.max(0, activeIndex)] &&
            chooseResult(matches[Math.max(0, activeIndex)], true)
          "
          @keydown.esc.stop.prevent="query = ''"
        />
        <button v-if="query" type="button" aria-label="清空搜索" @click="clearSearch">
          <i class="pi pi-times" aria-hidden="true" />
        </button>
      </div>
      <div
        v-if="query.trim()"
        :id="idPrefix + '-search-results'"
        class="settings-market-results te-material"
        data-te-material="popover"
        :role="matches.length ? 'listbox' : 'status'"
      >
        <button
          v-for="(result, index) in matches"
          :id="idPrefix + '-result-' + index"
          :key="result.id"
          type="button"
          class="settings-nav-result"
          role="option"
          tabindex="-1"
          :aria-selected="activeIndex === index"
          @mousedown.prevent
          @click="chooseResult(result, $event.detail === 0)"
        >
          <span class="settings-nav-result-title">{{ result.title }}</span
          ><small>{{ sections.find((section) => section.key === result.section)?.label }}</small>
        </button>
        <p v-if="!matches.length">没有找到匹配的设置</p>
      </div>
    </div>
  </nav>
</template>
