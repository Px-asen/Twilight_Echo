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
import ImportDialog from '@renderer/components/ImportDialog.vue'
import ThemeIcon from '@renderer/components/ThemeIcon.vue'
import { useMusicStore } from '@renderer/stores/useMusicStore'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import {
  BUILTIN_NAVIGATION_PAGES,
  isNavigationPageVisible,
  orderNavigationPages,
  type NavigationPageDefinition
} from '@renderer/app/navigationPages.ts'
import {
  buildSidebarEntries,
  sidebarGroupId,
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
  }>(),
  { pages: () => BUILTIN_NAVIGATION_PAGES }
)
const persistent = ref(false)
let observer: MutationObserver | undefined
onMounted(() => {
  const root = document.documentElement
  const sync = (): void => {
    persistent.value =
      root.dataset.teShellLayout === 'custom' && root.dataset.teShellNavigation === 'persistent'
  }
  sync()
  observer = new MutationObserver(sync)
  observer.observe(root, {
    attributes: true,
    attributeFilter: ['data-te-shell-layout', 'data-te-shell-navigation']
  })
})
onBeforeUnmount(() => observer?.disconnect())
const emit = defineEmits<{ selectPage: [page: NavigationPageDefinition] }>()
const settingsStore = useSettingsStore()
const ordered = computed(() =>
  orderNavigationPages(props.pages, settingsStore.settings.value.navigationPages)
)
const visible = computed(() =>
  ordered.value.filter((page) =>
    isNavigationPageVisible(page, settingsStore.settings.value.navigationPages)
  )
)
const entries = computed(() => buildSidebarEntries(visible.value))
const expanded = ref(new Set<SidebarGroupId>())
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
function handleToolbarKey(event: KeyboardEvent): void {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll('button')]
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
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
const showImportDialog = ref(false)
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
    class="side-menu"
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
          <div
            v-if="entry.kind === 'group'"
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
              <i
                class="group-chevron pi"
                :class="expanded.has(entry.id) ? 'pi-angle-down' : 'pi-angle-right'"
                aria-hidden="true"
              ></i>
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
                :title="page.title"
                @click="selectPage(page)"
              >
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
      <div class="menu-bottom">
        <div class="menu-separator"></div>
        <div
          class="menu-toolbar"
          role="toolbar"
          aria-label="音乐工具"
          aria-orientation="vertical"
          @keydown="handleToolbarKey"
        >
          <button
            type="button"
            class="menu-item toolbar-item"
            title="导入歌曲"
            aria-label="导入歌曲"
            @click="showImportDialog = true"
          >
            <ThemeIcon class="item-icon" icon-slot="navigation.import" /><span class="item-label"
              >导入歌曲</span
            >
          </button>
          <button
            type="button"
            class="menu-item toolbar-item"
            title="编辑页面"
            aria-label="编辑页面"
            @click="showPagesEditor = true"
          >
            <i class="item-icon pi pi-pencil" aria-hidden="true"></i
            ><span class="item-label">编辑页面</span>
          </button>
        </div>
        <span v-if="scanning" class="scanning-text" aria-live="polite">{{ scanningLabel }}</span>
      </div>
    </nav>
  </div>
  <ImportDialog :show="showImportDialog" @close="showImportDialog = false" />
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
  position: fixed;
  display: flex;
  flex-direction: column;
  top: var(--te-titlebar-inset, 45px);
  left: 0;
  /* App.vue measures how much of the bottom edge the playbar covers and publishes
     it on `.app-shell-navigation`; the menu ends above the bar instead of running
     underneath it. A custom property rather than an inline `bottom` so the custom
     shell layout's `inset: auto !important` still wins. */
  bottom: var(--te-side-menu-bottom, 0px);
  width: var(--te-menu-width);
  /* Frosted surface: the bottom-most global background shows through. The
     blur is what keeps the split readable over a custom wallpaper — the page
     draws its own cover-scaled copy of that image while the body carries the
     window-wide one, and an unblurred seam between the two scales reads as the
     menu sitting off-grid. Same recipe the streaming sidebar ships. */
  background: transparent;
  border-right: 1px solid var(--te-navigation-border);
  border-radius: 0 var(--te-navigation-radius) var(--te-navigation-radius) 0;
  z-index: 1000;
  overflow: hidden;
  box-shadow: var(--te-navigation-shadow);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  transform: translate3d(-100%, 0, 0);
  transform-origin: left center;
  will-change: transform;
  transition:
    transform var(--te-motion-panel) var(--te-ease-soft),
    box-shadow var(--te-motion-panel);
  font-family: var(--te-font-sans);
}

.side-menu.open {
  transform: translate3d(0, 0, 0);
}

:global(html[data-theme='dark'] .side-menu) {
  border-right-color: var(--te-navigation-border);
  background: transparent;
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
  --te-menu-width: 72px !important;
}

.navigation-brand {
  display: none;
  height: 56px;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--te-navigation-border);
  color: var(--te-navigation-text);
  font-size: calc(var(--te-font-size-body, 14px) * 0.85714);
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
  padding: 16px 12px max(16px, var(--te-side-menu-tools-clearance, 0px));
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
  height: 36px;
  min-height: calc(var(--te-font-size-body, 14px) * 2.3);
}

.menu-child .item-label {
  font-size: calc(var(--te-font-size-body, 14px) * 0.92857);
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
  font-size: calc(var(--te-font-size-body, 14px) * 0.92857);
}

.menu-bottom {
  flex-shrink: 0;
  margin-top: auto;
}

.menu-item {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  height: 40px;
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
  text-align: left;
  transition:
    background var(--te-motion-hover) var(--te-ease-enter),
    color var(--te-motion-hover) var(--te-ease-enter),
    transform var(--te-motion-hover) var(--te-ease-enter);
}

.menu-item:focus-visible {
  outline: 2px solid var(--te-navigation-indicator);
  outline-offset: -2px;
}

.menu-item:hover {
  background: var(--te-navigation-hover);
  color: var(--te-navigation-hover-text);
  transform: none;
}

.menu-item.active {
  background: var(--te-navigation-active);
  color: var(--te-navigation-active-text);
  font-weight: 600;
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
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--te-navigation-icon);
  font-size: calc(var(--te-font-size-body, 14px) * 1.21429);
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
  font-size: calc(var(--te-font-size-body, 14px) * 1);
  font-weight: 500;
  color: currentColor;
  opacity: 0;
  letter-spacing: 0.3px;
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
  font-size: calc(var(--te-font-size-body, 14px) * 0.85714);
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
  padding: 12px 8px max(12px, var(--te-side-menu-tools-clearance, 0px));
}

:global(html[data-te-navigation-style='rail'] .menu-nav) {
  gap: 5px;
}

:global(html[data-te-navigation-style='rail'] .menu-item) {
  width: 44px;
  margin-left: 6px;
  padding: 0;
  justify-content: center;
}

:global(html[data-te-navigation-style='rail'] .menu-item.menu-child) {
  margin-left: 10px;
  width: 40px;
  padding: 0;
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
  isolation: isolate;
  border-right-color: color-mix(in srgb, var(--te-lg-context-label) 13%, transparent);
  box-shadow: 5px 0 22px var(--te-lg-context-shadow);
}

.side-menu-liquid::before {
  position: absolute;
  z-index: -1;
  inset: 0;
  border-radius: inherit;
  background:
    linear-gradient(
      112deg,
      color-mix(in srgb, var(--te-lg-context-rim) 18%, transparent),
      transparent 56%
    ),
    color-mix(in srgb, var(--te-lg-context-surface) 68%, transparent);
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--te-lg-context-rim) 32%, transparent);
  content: '';
  pointer-events: none;
  backdrop-filter: blur(20px) saturate(128%);
  -webkit-backdrop-filter: blur(20px) saturate(128%);
}

:global(html[data-te-liquid-glass-source='solid'] .side-menu-liquid::before) {
  background:
    linear-gradient(
      112deg,
      color-mix(in srgb, var(--te-lg-context-rim) 22%, transparent),
      transparent 56%
    ),
    var(--te-lg-context-material);
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

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .side-menu-liquid::before {
    background: var(--te-lg-context-surface-solid);
    border-right: 1px solid var(--te-lg-context-label);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .side-menu-liquid::before {
    background: Canvas;
    border-right: 1px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
</style>
