<script setup lang="ts">
import NativeDialogTransition from '@renderer/components/NativeDialogTransition.vue'
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onMounted,
  onBeforeUnmount,
  ref,
  watch
} from 'vue'
import ThemeIcon from '@renderer/components/ThemeIcon.vue'
import { overlaySidebarsNeedExclusiveMode } from '@renderer/app/overlaySidebars'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import { appearanceChromePreview } from '../composables/appearanceEditorState.ts'
import type { NavigationPagePreferences } from '../../../shared/navigationPages'
import {
  BUILTIN_NAVIGATION_PAGES,
  isNavigationPageVisible,
  orderNavigationPages,
  type NavigationPageDefinition
} from '@renderer/app/navigationPages.ts'
import {
  buildSidebarEntries,
  sidebarGroupId,
  type SidebarEntry,
  type SidebarGroupId
} from '@renderer/app/sidebarNavigation.ts'
const NavigationPagesDialog = defineAsyncComponent(
  () => import('@renderer/components/navigation/NavigationPagesDialog.vue')
)
const props = withDefaults(
  defineProps<{
    open: boolean
    liquidMaterial?: boolean
    activeKey: string
    pages?: NavigationPageDefinition[]
    preview?: boolean
    previewPreferences?: NavigationPagePreferences
  }>(),
  { pages: () => BUILTIN_NAVIGATION_PAGES }
)
const persistent = ref(false)
const sideMenu = ref<HTMLElement>()
let observer: MutationObserver | undefined
function syncPersistent(): void {
  const root = document.documentElement
  persistent.value =
    !overlaySidebarsNeedExclusiveMode() &&
    root.dataset.teShellLayout === 'custom' &&
    root.dataset.teShellNavigation === 'persistent'
}
onMounted(() => {
  if (props.preview) return
  const root = document.documentElement
  syncPersistent()
  window.addEventListener('resize', syncPersistent)
  observer = new MutationObserver(syncPersistent)
  observer.observe(root, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-te-shell-layout', 'data-te-shell-navigation']
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', syncPersistent)
  observer?.disconnect()
})
const emit = defineEmits<{
  selectPage: [page: NavigationPageDefinition]
  plugins: []
}>()
const settingsStore = useSettingsStore()
const navigationPreferences = computed(
  () =>
    props.previewPreferences ??
    appearanceChromePreview.value?.navigationPages ??
    settingsStore.settings.value.navigationPages
)
const ordered = computed(() => orderNavigationPages(props.pages, navigationPreferences.value))
const visible = computed(() =>
  ordered.value.filter((page) => isNavigationPageVisible(page, navigationPreferences.value))
)
const entries = computed(() => {
  const result: (SidebarEntry | { kind: 'plugins'; id: 'plugins' })[] = buildSidebarEntries(
    visible.value
  )
  const search = result.findIndex((entry) => entry.kind === 'page' && entry.page.id === 'search')
  const home = result.findIndex((entry) => entry.kind === 'page' && entry.page.id === 'local-home')
  result.splice(search >= 0 ? search + 1 : home + 1, 0, { kind: 'plugins', id: 'plugins' })
  return result
})
const expanded = ref(new Set<SidebarGroupId>())
watch(
  visible,
  async (pages, previous) => {
    const previousIds = new Set(previous?.map((page) => page.id))
    const added = pages.filter((page) =>
      previous ? !previousIds.has(page.id) : !page.defaultVisible
    )
    // Enabling a page must also reveal it inside its collapsed sidebar group.
    // Restore explicitly enabled optional pages when the sidebar mounts again.
    for (const page of added) {
      const group = sidebarGroupId(page.id)
      if (group) expanded.value.add(group)
    }
    if (!previous || added.length === 0) return
    await nextTick()
    const page = added.find((page) => !page.defaultVisible) ?? added[0]
    const button = [
      ...(sideMenu.value?.querySelectorAll<HTMLElement>('[data-page-id]') ?? [])
    ].find((button) => button.dataset.pageId === page.id)
    button?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  },
  { immediate: true }
)
watch(
  () => props.activeKey,
  (key) => {
    const group = sidebarGroupId(key)
    if (group) expanded.value.add(group)
  },
  { immediate: true }
)
function toggleGroup(id: SidebarGroupId): void {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}
async function handleGroupKey(event: KeyboardEvent, id: SidebarGroupId): Promise<void> {
  const group = event.currentTarget as HTMLElement
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    expanded.value.add(id)
    await nextTick()
    group.querySelector<HTMLElement>('.menu-children button')?.focus()
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    expanded.value.delete(id)
    group.querySelector<HTMLElement>('.menu-group-toggle')?.focus()
  }
}
const { libraryScanStatus, libraryScanProgress } = useMusicStore()
const scanning = computed(
  () => libraryScanStatus.value.state === 'running' || libraryScanStatus.value.state === 'paused'
)
const scanningLabel = computed(() => {
  const status = libraryScanStatus.value
  if (status.state === 'paused') return '扫描已暂停'
  const phase = libraryScanProgress.value?.phase === 'parsing' ? '解析' : '扫描'
  return status.total > 0 ? phase + '中 ' + (status.current || 0) + '/' + status.total : '正在扫描…'
})
const showPagesEditor = ref(false)
function selectPage(page: NavigationPageDefinition): void {
  showPagesEditor.value = false
  emit('selectPage', page)
}
function setPressOrigin(event: PointerEvent): void {
  const button =
    event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
  if (!button) return
  const rect = button.getBoundingClientRect()
  button.style.setProperty('--te-lg-press-x', String(event.clientX - rect.left) + 'px')
  button.style.setProperty('--te-lg-press-y', String(event.clientY - rect.top) + 'px')
}
</script>

<template>
  <div
    ref="sideMenu"
    :id="preview ? undefined : 'app-sidebar'"
    class="side-menu overlay-side-panel"
    data-te-material="navigation"
    :class="{ open: open || persistent, 'side-menu-liquid': props.liquidMaterial }"
    :inert="!open && !persistent"
    @pointerdown="setPressOrigin"
  >
    <div class="navigation-brand" aria-hidden="true">
      <img src="/icon.png" alt="" /><span>Twilight Echo</span>
    </div>
    <nav class="menu-items" aria-label="页面">
      <div class="menu-nav">
        <template v-for="entry in entries" :key="entry.kind === 'page' ? entry.page.id : entry.id">
          <button
            v-if="entry.kind === 'plugins'"
            type="button"
            class="menu-item sidebar-plugins"
            :class="{ active: props.activeKey === 'plugins' }"
            :aria-current="props.activeKey === 'plugins' ? 'page' : undefined"
            aria-label="插件市场"
            title="插件市场"
            @click="emit('plugins')"
          >
            <ThemeIcon class="item-icon" icon-slot="navigation.plugin" />
            <span class="item-label">插件市场</span>
          </button>
          <div
            v-else-if="entry.kind === 'group'"
            class="menu-group"
            :class="{
              expanded: expanded.has(entry.id),
              'contains-active': entry.pages.some((page) => page.id === props.activeKey)
            }"
            @keydown="handleGroupKey($event, entry.id)"
          >
            <button
              type="button"
              class="menu-item menu-group-toggle"
              :class="{
                active:
                  !expanded.has(entry.id) && entry.pages.some((page) => page.id === props.activeKey)
              }"
              :aria-label="entry.title"
              :aria-expanded="expanded.has(entry.id)"
              :aria-controls="`sidebar-group-${entry.id}`"
              :title="entry.title"
              @click="toggleGroup(entry.id)"
            >
              <ThemeIcon class="item-icon" :icon-slot="entry.icon" />
              <span class="item-label">{{ entry.title }}</span>
              <ThemeIcon
                class="group-chevron"
                :icon-slot="expanded.has(entry.id) ? 'navigation.collapse' : 'navigation.expand'"
              />
            </button>
            <div
              :id="`sidebar-group-${entry.id}`"
              v-show="expanded.has(entry.id)"
              class="menu-children"
            >
              <button
                v-for="page in entry.pages"
                :key="page.id"
                type="button"
                class="menu-item menu-child"
                :class="{ active: props.activeKey === page.id }"
                :aria-current="props.activeKey === page.id ? 'page' : undefined"
                :aria-label="page.title"
                :data-page-id="page.id"
                :title="page.title"
                @click="selectPage(page)"
              >
                <i
                  v-if="page.customIcon"
                  class="item-icon"
                  :class="page.customIcon"
                  aria-hidden="true"
                ></i>
                <ThemeIcon v-else class="item-icon" :icon-slot="page.icon" />
                <span class="item-label">{{ page.title }}</span>
              </button>
            </div>
          </div>
          <button
            v-else
            type="button"
            class="menu-item"
            :class="{ active: props.activeKey === entry.page.id }"
            :aria-current="props.activeKey === entry.page.id ? 'page' : undefined"
            :aria-label="entry.page.title"
            :data-page-id="entry.page.id"
            :title="entry.page.title"
            @click="selectPage(entry.page)"
          >
            <i
              v-if="entry.page.customIcon"
              class="item-icon"
              :class="entry.page.customIcon"
              aria-hidden="true"
            ></i
            ><ThemeIcon v-else class="item-icon" :icon-slot="entry.page.icon" /><span
              class="item-label"
              >{{ entry.page.title }}</span
            >
          </button>
        </template>
        <button
          v-if="visible.length === 0"
          type="button"
          class="menu-item"
          @click="showPagesEditor = true"
        >
          <ThemeIcon class="item-icon" icon-slot="navigation.import" /><span class="item-label"
            >添加常用页面</span
          >
        </button>
      </div>
    </nav>
    <div v-if="scanning" class="menu-bottom">
      <span class="scanning-text" aria-live="polite">
        <span class="scanning-label">{{ scanningLabel }}</span>
      </span>
    </div>
  </div>
  <NativeDialogTransition>
    <NavigationPagesDialog
      v-if="showPagesEditor"
      :pages="props.pages"
      edit
      @close="showPagesEditor = false"
      @select="selectPage"
    />
  </NativeDialogTransition>
</template>

<style scoped>
.side-menu {
  --te-type-body: calc(var(--te-font-size-body, 14px) * 15 / 14);
  --te-type-caption: calc(var(--te-font-size-body, 14px) * 13 / 14);
  --te-navigation-item-height: max(
    var(--te-control-height-lg, 40px),
    calc(var(--te-type-body) * var(--te-type-line-body, 1.5) + 12px)
  );
  --te-navigation-icon-slot: max(22px, calc(var(--te-font-size-body, 14px) * 22 / 14));
  position: fixed;
  display: flex;
  flex-direction: column;
  top: var(--te-titlebar-inset, 40px);
  left: 0;
  /* The shared overlay surface reaches behind the player in every shell. */
  bottom: var(--te-side-menu-bottom, 0px);
  width: var(--te-menu-width);
  /* Navigation shares the attached title-strip material, above the window base. */
  background: var(--te-chrome-navigation-surface, transparent);
  border-right: 0;
  border-radius: 0 var(--te-navigation-radius) var(--te-navigation-radius) 0;
  z-index: 1000;
  overflow: hidden;
  box-shadow: var(--te-chrome-navigation-elevation, var(--te-navigation-shadow));
  backdrop-filter: var(--te-material-filter);
  -webkit-backdrop-filter: var(--te-material-filter);
  transform: translate3d(-100%, 0, 0);
  transform-origin: left center;
  will-change: transform;
  transition: transform var(--te-motion-panel) var(--te-ease-soft);
  font-family: var(--te-font-sans);
}

.side-menu.open {
  transform: translate3d(0, 0, 0);
}

:global(html[data-theme='dark'] .side-menu:not(.side-menu-liquid)) {
  border-right-color: var(--te-navigation-border);
  background: var(--te-chrome-navigation-surface, transparent);
}

:global(html[data-te-navigation-style='expanded']) {
  --te-menu-width: clamp(
    calc(var(--te-font-size-body, 14px) * 224 / 14),
    18vw,
    calc(var(--te-font-size-body, 14px) * 260 / 14)
  ) !important;
}

:global(html[data-te-navigation-style='compact']) {
  --te-menu-width: calc(var(--te-font-size-body, 14px) * 192 / 14) !important;
}

:global(html[data-te-navigation-style='rail']) {
  --te-menu-width: max(72px, calc(var(--te-font-size-body, 14px) * 22 / 14 + 50px)) !important;
}

.navigation-brand {
  display: none;
  height: 56px;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--te-navigation-border);
  color: var(--te-navigation-text);
  font-size: var(--te-type-caption);
  font-weight: 700;
  white-space: nowrap;
}

.navigation-brand img {
  width: 28px;
  height: 28px;
  border-radius: 6px;
}

:global(html[data-te-navigation-logo='show'] .navigation-brand) {
  display: flex;
}

.side-menu .menu-items {
  transform: none;
  opacity: 1;
}

.menu-items {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  height: auto;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 16px 12px 16px;
}

.menu-nav {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.menu-group {
  flex-shrink: 0;
}

.menu-group-toggle .item-label {
  font-weight: 600;
}

.group-chevron {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--te-navigation-icon);
  font-size: 14px;
}

.contains-active .menu-group-toggle,
.contains-active .menu-group-toggle .item-icon {
  color: var(--te-navigation-active-text);
}

.menu-children {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-block: 4px 8px;
}

.menu-children::before {
  content: '';
  position: absolute;
  top: 8px;
  bottom: 12px;
  left: 23px;
  width: 1px;
  background: var(--te-navigation-border);
}

.menu-item.menu-child {
  width: calc(100% - 32px);
  margin-left: 32px;
  padding-inline: 10px;
  gap: 10px;
  height: max(36px, calc(var(--te-type-caption) * var(--te-type-line-body, 1.5) + 12px));
  min-height: 36px;
}

.menu-child .item-label {
  font-size: var(--te-type-caption);
}

.menu-child > .item-icon {
  display: none;
}

.menu-child.active::before {
  left: -10px;
}

.menu-toolbar {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.menu-item.toolbar-item {
  color: var(--te-navigation-icon);
}

.toolbar-item .item-label {
  font-size: var(--te-type-caption);
}

.menu-bottom {
  flex-shrink: 0;
  margin-top: auto;
  padding: 0 12px max(12px, var(--te-side-menu-tools-clearance, 0px));
}

.menu-item {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  height: var(--te-navigation-item-height);
  width: 100%;
  padding: 0 12px;
  margin-left: 0;
  border: 0;
  cursor: pointer;
  border-radius: var(--te-radius-global);
  gap: 10px;
  white-space: nowrap;
  color: var(--te-chrome-text, var(--te-navigation-text));
  background: transparent;
  font: inherit;
  font-weight: var(--te-type-weight-medium, 500);
  text-align: left;
  transition:
    background var(--te-motion-hover) var(--te-ease-enter),
    color var(--te-motion-hover) var(--te-ease-enter),
    transform var(--te-motion-hover) var(--te-ease-enter);
}

.menu-item:focus-visible {
  outline: var(--te-control-focus-width, 2px) solid var(--te-control-focus-color);
  outline-offset: calc(-1 * var(--te-control-focus-width, 2px));
}

.menu-item:hover {
  background: var(--te-navigation-hover);
  color: var(--te-navigation-hover-text);
  transform: none;
}

.menu-item.active {
  background: var(--te-navigation-active);
  color: var(--te-navigation-active-text);
  font-weight: var(--te-type-weight-strong, 600);
}

.menu-item.active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 2px;
  background: var(--te-navigation-indicator);
  opacity: 0.8;
}

:global(html[data-te-motion='full'] .menu-item.active::before) {
  animation: side-menu-indicator-in var(--te-motion-press) var(--te-ease-spring) both;
}

@keyframes side-menu-indicator-in {
  from {
    opacity: 0;
    scale: 1 0.45;
  }
}

.item-icon {
  width: var(--te-navigation-icon-slot);
  height: var(--te-navigation-icon-slot);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--te-navigation-icon);
  font-size: calc(var(--te-font-size-body, 14px) * 18 / 14);
  transition: color var(--te-motion-hover) var(--te-ease-enter);
}

:global(html[data-te-navigation-icon-scale='sm'] .item-icon) {
  font-size: calc(var(--te-font-size-body, 14px) * 1);
}

:global(html[data-te-navigation-icon-scale='lg'] .item-icon) {
  font-size: calc(var(--te-font-size-body, 14px) * 1.42857);
}

.menu-item:hover .item-icon {
  color: var(--te-navigation-hover-text);
}

.menu-item.active .item-icon {
  color: inherit;
}

.item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--te-type-body);
  line-height: var(--te-type-line-body, 1.5);
  font-weight: inherit;
  color: currentColor;
  opacity: 0;
  letter-spacing: normal;
  transition: opacity 0.2s ease;
}

.open .item-label {
  opacity: 1;
}

:global(html[data-te-navigation-style='compact'] .menu-items) {
  padding-right: 8px;
}

:global(html[data-te-navigation-style='compact'] .menu-item) {
  gap: 10px;
  padding-inline: 12px;
}

:global(html[data-te-navigation-style='compact'] .item-label) {
  font-size: var(--te-type-caption);
}

:global(html[data-te-navigation-style='compact'] .menu-item.menu-child) {
  margin-left: 36px;
  width: calc(100% - 36px);
  padding-inline: 8px;
  gap: 8px;
}

:global(html[data-te-navigation-style='compact'] .menu-children::before) {
  left: 28px;
}

:global(html[data-te-navigation-style='compact'] .menu-heading) {
  padding-left: 12px;
}

:global(html[data-te-navigation-style='rail'] .menu-items) {
  min-width: 0;
  max-width: 100%;
  padding: 12px 8px 12px;
}

:global(html[data-te-navigation-style='rail'] .menu-bottom) {
  padding: 0 8px max(12px, var(--te-side-menu-tools-clearance, 0px));
}

:global(html[data-te-navigation-style='rail'] .menu-nav) {
  gap: 5px;
}

:global(html[data-te-navigation-style='rail'] .menu-item) {
  width: max(44px, calc(var(--te-navigation-icon-slot) + 22px));
  margin-left: 6px;
  padding: 0;
  justify-content: center;
}

:global(html[data-te-navigation-style='rail'] .menu-item.menu-child) {
  margin-left: 10px;
  width: max(40px, calc(var(--te-navigation-icon-slot) + 18px));
  padding: 0;
}

:global(html[data-te-navigation-style='rail'] .menu-child > .item-icon) {
  display: inline-grid;
}

:global(html[data-te-navigation-style='rail'] .menu-children::before) {
  left: 5px;
}

:global(html[data-te-navigation-style='rail'] .menu-toolbar) {
  gap: 5px;
}

:global(html[data-te-navigation-style='rail'] .menu-heading) {
  display: none;
}

:global(html[data-te-navigation-style='rail'] .menu-caption),
:global(html[data-te-navigation-style='rail'] .group-chevron) {
  display: none;
}

:global(html[data-te-navigation-style='rail'] .menu-item:hover) {
  transform: none;
}

:global(html[data-te-navigation-style='rail'] .menu-item.active::before) {
  left: -6px;
}

:global(html[data-te-navigation-style='rail'] .item-label),
:global(html[data-te-navigation-style='rail'] .navigation-brand span) {
  display: none;
}

:global(html[data-te-navigation-style='rail'] .navigation-brand) {
  justify-content: center;
  padding-inline: 8px;
}

:global(html[data-te-navigation-style='rail'] .menu-separator) {
  margin-inline: 8px;
}

.menu-separator {
  height: 1px;
  margin: 12px 12px 12px 24px;
  background: var(--te-navigation-border);
}

.scanning-text {
  display: block;
  padding: 8px 16px;
  color: var(--te-navigation-icon);
  font-size: calc(var(--te-font-size-body, 14px) * 0.85714);
  font-weight: 500;
}

.side-menu-liquid {
  background: var(--te-window-foundation-tint);
  /* The pseudo surface owns the only backdrop pass. */
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  isolation: isolate;
  border-right-color: color-mix(in srgb, var(--te-lg-context-label) 6%, transparent);
  box-shadow: var(--te-chrome-navigation-elevation);
}

.side-menu-liquid::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background: var(--te-chrome-attached-liquid-surface);
  content: '';
  pointer-events: none;
  backdrop-filter: var(--te-chrome-attached-liquid-filter);
  -webkit-backdrop-filter: var(--te-chrome-attached-liquid-filter);
}

.side-menu-liquid :is(.navigation-brand, .menu-item, .scanning-text) {
  color: var(--te-lg-context-label);
}

.side-menu-liquid .menu-item:hover {
  background: color-mix(in srgb, var(--te-lg-context-rim) 28%, transparent);
}

.side-menu-liquid .menu-item.active {
  background: color-mix(in srgb, var(--te-lg-context-rim) 40%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--te-lg-context-rim) 30%, transparent);
}

.side-menu-liquid .menu-item {
  overflow: hidden;
}

.side-menu-liquid .menu-item::after {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: radial-gradient(
    circle at var(--te-lg-press-x, 50%) var(--te-lg-press-y, 50%),
    color-mix(in srgb, var(--te-lg-context-rim) 58%, transparent),
    transparent 62%
  );
  content: '';
  opacity: 0;
  pointer-events: none;
  transition: opacity 150ms ease-out;
}

.side-menu-liquid .menu-item:active {
  transform: scale(0.97);
  transition-duration: 90ms;
}

.side-menu-liquid .menu-item:active::after {
  opacity: 1;
}

/* Keep regular navigation readable when diffusion is disabled. */
body.te-no-blur .side-menu:not(.side-menu-liquid),
html[data-te-effects-mode='reduced'] .side-menu:not(.side-menu-liquid) {
  background: var(--te-chrome-frosted-solid, var(--te-navigation-bg));
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

body.te-no-blur .side-menu-liquid::before,
html[data-te-effects-mode='reduced'] .side-menu-liquid::before {
  background: var(--te-lg-context-surface-solid, var(--te-chrome-material-solid)) !important;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .side-menu:not(.side-menu-liquid) {
    background: var(--te-chrome-frosted-solid, var(--te-navigation-bg));
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .side-menu-liquid::before {
    background: var(--te-lg-context-surface-solid) !important;
    border-right: 1px solid var(--te-lg-context-label);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .side-menu:not(.side-menu-liquid) {
    background: Canvas !important;
    border-right: 1px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  .side-menu-liquid::before {
    background: Canvas !important;
    border-right: 1px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
</style>
