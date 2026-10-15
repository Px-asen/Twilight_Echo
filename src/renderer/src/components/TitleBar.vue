<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useBackStack } from '../app/useBackStack'
import { useNcmStore } from '../stores/useNcmStore'
import { useProviderStore } from '../stores/useProviderStore'
import TitleBarIcon from './icons/TitleBarIcon.vue'
import { useWindowChrome } from '../app/useWindowChrome'
import { useAppNoticeStore } from '../stores/useAppNoticeStore'
import PageDock from './PageDock.vue'
import type { PageDockAction } from '../app/pageDock'

const props = withDefaults(
  defineProps<{
    menuOpen: boolean
    home?: boolean
    pageDockActions?: readonly PageDockAction[]
    glass?: boolean
    immersive?: boolean
    liquidMaterial?: boolean
    streaming?: boolean
    titleSurface?: 'default' | 'settings' | 'streaming'
    reading?: boolean
    activeTool?: 'settings' | 'plugins' | 'appearance' | 'dsp' | null
    preview?: boolean
    closeOnly?: boolean
    accountOpen?: boolean
    searchQuery?: string
  }>(),
  {
    titleSurface: 'default',
    home: true,
    accountOpen: false,
    pageDockActions: () => []
  }
)

const emit = defineEmits<{
  toggleMenu: []
  home: []
  collapseMenu: []
  back: []
  login: [providerId?: string | null, anchor?: HTMLElement]
  settings: []
  appearance: []
  dsp: []
  library: []
  search: [query: string]
  'update:searchQuery': [query: string]
}>()

const searchDraft = ref(props.searchQuery ?? '')
const searchInput = ref<HTMLInputElement | null>(null)
const searchComposing = ref(false)
let publishedSearchQuery = searchDraft.value
watch(
  () => props.searchQuery,
  (query) => {
    if (query === undefined) return
    searchDraft.value = query
    publishedSearchQuery = query
  }
)
function updateSearchDraft(query: string): void {
  searchDraft.value = query
  if (searchComposing.value || query === publishedSearchQuery) return
  publishedSearchQuery = query
  if (!props.preview && !props.closeOnly) emit('update:searchQuery', query)
}
function onSearchInput(event: Event): void {
  updateSearchDraft((event.target as HTMLInputElement).value)
}
function endSearchComposition(event: CompositionEvent): void {
  searchComposing.value = false
  onSearchInput(event)
}
function guardSearchComposition(event: KeyboardEvent): void {
  if (searchComposing.value || event.isComposing || event.keyCode === 229) event.preventDefault()
}
function submitSearch(): void {
  if (props.preview || props.closeOnly || searchComposing.value) return
  const query = searchDraft.value.trim()
  if (!query) return
  updateSearchDraft(query)
  emit('search', query)
}
function clearSearch(): void {
  updateSearchDraft('')
  searchInput.value?.focus()
}

const { isLoggedIn, profile } = useNcmStore()
const providerStore = useProviderStore()
const loginProvider = computed(() => {
  const providers = providerStore.providers.value.filter((provider) =>
    provider.capabilities.includes('login')
  )
  return providers.find((provider) => provider.id === 'ncm') ?? providers[0]
})
const showNcmProfile = computed(
  () => !props.preview && loginProvider.value?.id === 'ncm' && isLoggedIn.value
)
const { canGoBack, backHint } = useBackStack()
const { unreadCount, activeTaskCount, doNotDisturb } = useAppNoticeStore()
const loginLabel = computed(
  () =>
    `我的账户与任务${showNcmProfile.value && profile.value?.nickname ? ' · ' + profile.value.nickname : ''}${doNotDisturb.value ? ' · 勿扰模式已开启' : ''}（${activeTaskCount.value} 项进行中，${unreadCount.value} 条未读）`
)
const { maximized } = useWindowChrome(() => props.preview === true)
const avatarLoadFailed = ref(false)
watch([() => profile.value?.userId, () => profile.value?.avatarUrl], () => {
  avatarLoadFailed.value = false
})
const titleBar = ref<HTMLElement | null>(null)
let titleObserver: ResizeObserver | undefined
onMounted(() => {
  if (props.preview) return
  const updateInset = (): void => {
    if (titleBar.value)
      titleBar.value.ownerDocument.documentElement.style.setProperty(
        '--te-titlebar-inset',
        `${titleBar.value.getBoundingClientRect().bottom}px`
      )
  }
  titleObserver = new ResizeObserver(updateInset)
  if (titleBar.value) titleObserver.observe(titleBar.value)
  updateInset()
})
onBeforeUnmount(() => titleObserver?.disconnect())

function revealTitleTool(event: FocusEvent): void {
  const target = event.target
  if (target instanceof HTMLElement) target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function setPressOrigin(event: PointerEvent): void {
  const button =
    event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null
  if (!button) return
  const rect = button.getBoundingClientRect()
  button.style.setProperty('--te-lg-press-x', `${event.clientX - rect.left}px`)
  button.style.setProperty('--te-lg-press-y', `${event.clientY - rect.top}px`)
}

function minimize(): void {
  if (props.preview) return
  window.api.window.minimize()
}

function toggleMaximize(): void {
  if (props.preview) return
  window.api.window.toggleMaximize()
}

function close(): void {
  if (props.preview) return
  window.api.window.close()
}
</script>

<template>
  <div
    class="title-bar"
    data-te-material="titlebar"
    ref="titleBar"
    :class="{
      'drag-region': !preview,
      'no-drag': preview,
      'title-bar-glass': glass && !immersive && !closeOnly,
      'title-bar-liquid': liquidMaterial && !immersive && !closeOnly,
      'title-bar-immersive': immersive && !closeOnly,
      'title-bar-close-only': closeOnly,
      'title-bar-settings': titleSurface === 'settings' && !immersive && !closeOnly,
      'title-bar-reading': reading && !immersive && !closeOnly,
      'title-bar-streaming': titleSurface === 'streaming' && !immersive && !closeOnly,
      'title-bar-menu-open': menuOpen && !immersive && !closeOnly
    }"
  >
    <div v-if="!closeOnly" class="title-bar-background" aria-hidden="true"></div>
    <div v-if="!closeOnly" class="title-bar-leading">
      <div v-if="!closeOnly" class="title-bar-start no-drag" @pointerdown="setPressOrigin">
        <button
          type="button"
          :aria-label="home ? '侧边栏' : '回到主页'"
          class="menu-btn"
          :title="home ? (menuOpen ? '收起侧边栏' : '展开侧边栏') : '回到主页'"
          :aria-expanded="home ? menuOpen : undefined"
          :aria-controls="home ? 'app-sidebar' : undefined"
          @click="home ? $emit('toggleMenu') : $emit('home')"
        >
          <TitleBarIcon :name="home ? 'navigation' : 'home'" />
        </button>
        <button
          type="button"
          :aria-label="loginLabel"
          :aria-expanded="accountOpen"
          aria-haspopup="dialog"
          aria-controls="account-subpage"
          class="login-btn"
          :title="loginLabel"
          @click="$emit('login', null, $event.currentTarget as HTMLElement)"
        >
          <img
            v-if="showNcmProfile && profile?.avatarUrl && !avatarLoadFailed"
            :src="profile.avatarUrl"
            class="user-avatar"
            alt=""
            @error="avatarLoadFailed = true"
          />
          <TitleBarIcon v-else name="person" />
          <Transition name="notification-dot">
            <span
              v-if="!doNotDisturb && (unreadCount || activeTaskCount)"
              class="notification-dot"
              :class="{ 'notification-dot--busy': !unreadCount && activeTaskCount }"
              aria-hidden="true"
            ></span>
          </Transition>
        </button>
      </div>
      <!-- Keep commands anchored when a return handler becomes available. -->
      <div
        v-if="!closeOnly"
        class="title-bar-back"
        :class="{
          'title-bar-back-visible': canGoBack && !preview,
          'no-drag': canGoBack && !preview
        }"
        :inert="!canGoBack || preview"
        @pointerdown="setPressOrigin"
      >
        <Transition name="title-back-fade">
          <button
            type="button"
            v-if="canGoBack && !preview"
            class="back-btn"
            :title="backHint ?? '返回'"
            aria-label="返回"
            @click="canGoBack && $emit('back')"
          >
            <TitleBarIcon name="arrow_left" />
          </button>
        </Transition>
      </div>
    </div>
    <form
      v-if="!closeOnly"
      class="title-bar-search no-drag"
      role="search"
      aria-label="全局音乐搜索"
      @submit.prevent="submitSearch()"
    >
      <button type="submit" class="title-search-submit" aria-label="搜索" title="搜索">
        <TitleBarIcon name="search" />
      </button>
      <input
        ref="searchInput"
        :value="searchDraft"
        type="search"
        aria-label="搜索音乐"
        placeholder="搜索音乐"
        enterkeyhint="search"
        autocomplete="off"
        spellcheck="false"
        @input="onSearchInput"
        @compositionstart="searchComposing = true"
        @compositionend="endSearchComposition"
        @keydown.enter="guardSearchComposition"
      />
      <button
        v-if="searchDraft"
        type="button"
        class="title-search-clear"
        aria-label="清除搜索"
        title="清除搜索"
        @click="clearSearch"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
      </button>
    </form>
    <div class="title-bar-controls no-drag" @pointerdown="setPressOrigin">
      <div
        v-if="!closeOnly"
        class="title-bar-tools"
        role="group"
        aria-label="应用工具"
        @focusin="revealTitleTool"
      >
        <PageDock :actions="pageDockActions" />
        <button
          type="button"
          aria-label="DSP 音频处理"
          :aria-pressed="activeTool === 'dsp'"
          class="settings-btn dsp-btn"
          title="DSP 音频处理"
          @click="$emit('dsp')"
        >
          <span class="title-bar-label">DSP</span>
        </button>
        <button
          type="button"
          aria-label="外观"
          :aria-pressed="activeTool === 'appearance'"
          class="settings-btn appearance-btn"
          title="外观"
          @click="$emit('appearance')"
        >
          <TitleBarIcon name="appearance" />
        </button>
        <button
          type="button"
          aria-label="设置"
          :aria-pressed="activeTool === 'settings'"
          class="settings-btn"
          title="设置"
          @click="$emit('settings')"
        >
          <TitleBarIcon name="settings" />
        </button>
      </div>
      <div class="title-bar-window-controls" role="group" aria-label="窗口控制">
        <button
          v-if="!closeOnly"
          type="button"
          :disabled="preview"
          aria-label="最小化"
          class="control-btn minimize"
          title="最小化"
          @click="minimize"
        >
          <svg class="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 8.5h12" />
          </svg>
        </button>
        <button
          v-if="!closeOnly"
          type="button"
          :aria-label="maximized ? '还原窗口' : '最大化窗口'"
          class="control-btn maximize"
          :title="maximized ? '还原窗口' : '最大化窗口'"
          :disabled="preview"
          @click="toggleMaximize"
        >
          <svg class="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
            <g v-if="maximized">
              <path d="M5 4.5v-1A1 1 0 0 1 6 2.5h6.5a1 1 0 0 1 1 1V10a1 1 0 0 1-1 1h-1" />
              <rect x="2.5" y="5" width="8.5" height="8.5" rx="1.5" />
            </g>
            <rect v-else x="2.5" y="2.5" width="11" height="11" rx="2" />
          </svg>
        </button>
        <button
          type="button"
          :disabled="preview"
          class="control-btn close"
          title="关闭窗口"
          aria-label="关闭窗口"
          @click="close"
        >
          <svg class="window-control-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m2.5 2.5 11 11m0-11-11 11" />
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notification-dot {
  position: absolute;
  top: calc(50% - 9px);
  right: 12px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--te-primary-500);
  box-shadow: none;
}
.notification-dot--busy {
  background: currentColor;
  opacity: 0.55;
}
.notification-dot-enter-active,
.notification-dot-leave-active {
  transition:
    opacity 180ms ease,
    transform 240ms var(--te-ease-soft);
}
.notification-dot-enter-from,
.notification-dot-leave-to {
  opacity: 0;
  transform: scale(0);
}
.title-bar {
  --te-titlebar-item-opacity: 0.58;
  --te-titlebar-ink-duration: 160ms;
  --te-titlebar-height: 40px;
  --te-titlebar-material-surface: var(--te-chrome-frosted-solid, var(--te-app-bg));
  --te-titlebar-frosted-surface: var(
    --te-chrome-frosted-surface,
    color-mix(in srgb, var(--te-titlebar-material-surface) 80%, transparent)
  );
  --te-titlebar-material-ink: var(--te-shell-control-text);
  --te-titlebar-icon-size: 16px;
  --te-titlebar-control-width: 46px;
  font-family: var(--te-font-sans);
  font-weight: var(--te-control-font-weight, 500);
  letter-spacing: normal;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 40px;
  min-height: 40px;
  max-height: 40px;
  box-sizing: border-box;
  flex-shrink: 0;
  background: transparent !important;
  user-select: none;
  position: fixed;
  isolation: isolate;
  top: 0;
  left: 0;
  right: 0;
  z-index: 9999;
  overflow: hidden;
  border-bottom: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transition:
    border-color 0.3s,
    box-shadow 0.3s;
}

/* Keep the search aligned to the expanded navigation edge, including when the
   overlay is closed. Only the unused leading space yields on a crowded strip. */
.title-bar-leading {
  display: flex;
  flex: 0 999 var(--te-menu-width, 224px);
  min-width: calc(3 * var(--te-titlebar-control-width, 46px));
  height: 100%;
  position: relative;
  z-index: 1;
}
.title-bar-search {
  --te-titlebar-search-ink: color-mix(in srgb, var(--te-titlebar-material-ink) 68%, transparent);
  display: flex;
  align-items: center;
  flex: 0 1 360px;
  min-width: 128px;
  height: 34px;
  margin: 0 12px 0 0;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--te-titlebar-material-ink) 10%, transparent);
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: var(--te-titlebar-search-ink);
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  transition:
    color var(--te-motion-fast, 160ms) ease,
    border-color var(--te-motion-fast, 160ms) ease;
  position: relative;
  z-index: 1;
  -webkit-app-region: no-drag;
}
.title-bar-search:is(:hover, :focus-within) {
  --te-titlebar-search-ink: color-mix(in srgb, var(--te-titlebar-material-ink) 84%, transparent);
}
.title-bar-search:focus-within {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 1px;
}
.title-bar-search input {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 32px;
  padding: 0 2px;
  border: 0;
  border-radius: 0;
  outline: none;
  box-shadow: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  font-size: var(--te-type-caption);
  font-weight: 400;
  line-height: 1.15;
  user-select: text;
  -webkit-app-region: no-drag;
}
.title-bar-search input::placeholder {
  color: inherit;
  opacity: 1;
}
.title-bar-search input::-webkit-search-cancel-button,
.title-bar-search input::-webkit-search-decoration {
  -webkit-appearance: none;
  appearance: none;
}
.title-bar-search button {
  display: grid;
  place-items: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: var(--te-control-radius-sm);
  color: inherit;
  background: transparent;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.title-bar-search button:hover {
  color: var(--te-titlebar-material-ink);
}
@media (prefers-contrast: more) {
  .title-bar-search {
    color: var(--te-titlebar-material-ink);
    border-color: currentColor;
  }
}
@media (forced-colors: active) {
  .title-bar-search {
    color: CanvasText;
    border-color: GrayText;
  }
  .title-bar-search button:hover {
    color: Highlight;
  }
  .title-bar-search:focus-within,
  .title-bar-search button:focus-visible {
    outline-color: Highlight;
  }
}
.title-bar-search button:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: -3px;
}
.title-search-clear svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}
.title-bar-tools {
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  flex: 0 1 auto;
  min-width: 40px;
}
.title-bar-tools::-webkit-scrollbar {
  display: none;
}
.title-bar-tools :deep(.page-dock) {
  flex-shrink: 0;
}

.title-bar-background {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: calc(100% + var(--te-titlebar-base-extension, 0px));
  z-index: 0;
  pointer-events: none;
  background: var(--te-material-background, var(--te-chrome-attached-surface));
  box-shadow: none;
  backdrop-filter: var(--te-material-filter, none);
  -webkit-backdrop-filter: var(--te-material-filter, none);
}

/* Dark chrome has a soft surface, without a pale outline around the strip. */
html[data-theme='dark']
  .title-bar:not(.title-bar-immersive):not(.title-bar-liquid)
  .title-bar-background {
  background: var(--te-material-background, var(--te-chrome-attached-surface));
  box-shadow: none;
  backdrop-filter: var(--te-material-filter, none);
  -webkit-backdrop-filter: var(--te-material-filter, none);
}

/* Appearance material switches must reach the painter as well as its host. */
html[data-te-surface-material='transparent'] .title-bar .title-bar-background {
  background: transparent !important;
  box-shadow: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.title-bar::before {
  display: none;
}

.title-bar-glass {
  --te-titlebar-material-surface: #17181a;
  --te-titlebar-frosted-surface: rgb(23 24 26 / 72%);
  --te-titlebar-material-ink: #fff;
}

/* Playback paints one continuous backdrop, including the caption strip. */
.title-bar-immersive {
  --te-shell-control-text: var(--te-playback-page-text, #f4f7fb);
  --te-shell-control-hover: color-mix(in srgb, var(--te-shell-control-text) 8%, transparent);
  --te-titlebar-material-surface: var(--te-player-bg);
  --te-titlebar-material-ink: var(--te-shell-control-text);
  /* Presets must not tint the artwork again behind the caption controls. */
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.title-bar-immersive .title-bar-background {
  background: transparent !important;
  box-shadow: none;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.title-bar-start,
.title-bar-back,
.title-bar-tools {
  --te-titlebar-icon-size: 18px;
}

.title-bar-start {
  display: flex;
  flex-shrink: 0;
  height: 100%;
  position: relative;
  z-index: 1;
}

.title-bar-back {
  display: flex;
  align-items: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  overflow: hidden;
  position: relative;
  z-index: 1;
  flex-shrink: 0;
}

.title-bar-back-visible {
  overflow: visible;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  min-width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.title-back-fade-enter-active,
.title-back-fade-leave-active {
  transition: opacity 0.18s ease;
}

.title-back-fade-enter-from,
.title-back-fade-leave-to {
  opacity: 0;
}

.title-bar-glass .back-btn {
  color: var(--te-on-accent);
}

.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
}

.settings-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

.dsp-btn {
  width: auto;
  min-width: var(--te-titlebar-control-width, 46px);
  padding: 0 10px;
  font-weight: 500;
}

.plugins-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 17 / 14);
}

.login-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  border: none;
  background: transparent;
  color: var(--te-shell-control-text);
  cursor: pointer;
  transition: background 0.15s;
  padding: 0;
  flex-shrink: 0;
  font-size: calc(var(--te-font-size-body, 14px) * 14 / 14);
}

/* Use a neutral wash for dark caption feedback so album accents cannot tint the chrome. */
html[data-theme='dark'] .title-bar .control-btn:not(.notification-btn):not(.close):hover {
  background: color-mix(in srgb, var(--te-shell-control-text) 6%, transparent);
}

.user-avatar {
  width: var(--te-titlebar-icon-size, 18px);
  height: var(--te-titlebar-icon-size, 18px);
  border-radius: 50%;
  object-fit: cover;
}

.title-bar-glass :is(.menu-btn, .settings-btn, .plugins-btn) {
  color: #fff;
}

.title-bar-glass .login-btn {
  color: #fff;
}

.title-bar:not(.title-bar-close-only) .title-bar-controls {
  min-width: calc(3 * var(--te-titlebar-control-width, 46px) + 52px);
}

.title-bar-controls {
  --te-titlebar-item-opacity: 0.46;
  display: flex;
  flex-shrink: 1;
  min-width: 0;
  height: 100%;
  margin-left: auto;
  position: relative;
  z-index: 1;
}

.title-bar-tools,
.title-bar-window-controls {
  display: flex;
  align-items: center;
  height: 100%;
}

.title-bar-tools {
  min-width: 40px;
}

.title-bar-window-controls {
  flex-shrink: 0;
}

.title-bar-window-controls {
  margin-left: 12px;
}

.title-bar-close-only .title-bar-window-controls {
  margin-left: 0;
}

html .title-bar.title-bar-close-only {
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

.title-bar-tools::after {
  content: '';
  width: 1px;
  height: 16px;
  background: color-mix(in srgb, var(--te-shell-control-text) 12%, transparent);
  pointer-events: none;
}

.title-bar :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn):focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: -3px;
}

.control-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--te-titlebar-control-width, 46px);
  min-width: var(--te-titlebar-control-width, 46px);
  height: 100%;
  flex-shrink: 0;
  border: none;
  border-radius: 0;
  padding: 0;
  background: transparent;
  color: var(--te-shell-control-text);
  font-size: calc(var(--te-font-size-body, 14px) * 16 / 14);
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.3s,
    transform 0.24s var(--te-ease-soft);
}

.control-btn:active {
  transition-duration: 0.1s;
}

.control-btn:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: -2px;
}

.window-control-icon {
  display: block;
  width: var(--te-titlebar-icon-size, 16px);
  height: var(--te-titlebar-icon-size, 16px);
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.title-bar-glass .control-btn {
  color: #fff;
}

.title-bar-glass .control-btn:not(.notification-btn):hover {
  background: rgba(255, 255, 255, 0.08);
}

.control-btn:not(.notification-btn):hover {
  background: var(--te-shell-control-hover);
}

.control-btn.close:hover,
html[data-theme='pureWhite'] .title-bar .control-btn.close:hover,
.title-bar-liquid .control-btn.close:hover {
  background: #e81123;
  color: #fff;
}

html
  .title-bar-immersive
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn) {
  color: var(--te-shell-control-text);
  /* Match the playback surface as soon as it appears, without a light-theme tween. */
  transition-property: background-color;
}

html
  .title-bar-immersive
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):not(
    .close
  ):hover {
  color: var(--te-shell-control-text);
  transform: none;
}

html
  .title-bar-immersive
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):focus-visible {
  outline-color: var(--te-control-focus-color);
}

.title-bar-liquid {
  --te-titlebar-material-ink: var(--te-lg-context-label);
  isolation: isolate;
  color: var(--te-lg-context-label);
}

.title-bar-liquid .title-bar-background {
  display: block;
  background: var(--te-chrome-attached-liquid-surface);
  box-shadow: none;
  backdrop-filter: var(--te-chrome-attached-liquid-filter);
  -webkit-backdrop-filter: var(--te-chrome-attached-liquid-filter);
}

.title-bar-liquid :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn) {
  position: relative;
  overflow: hidden;
  color: inherit;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn)::after {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    circle at var(--te-lg-press-x, 50%) var(--te-lg-press-y, 50%),
    color-mix(in srgb, var(--te-lg-context-rim) 56%, transparent),
    transparent 58%
  );
  content: '';
  opacity: 0;
  pointer-events: none;
  transition: opacity 160ms ease-out;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):active {
  transform: scale(0.94);
  transition-duration: 90ms;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .control-btn):active::after {
  opacity: 1;
}

/* Inset feedback shares the caption material; the full 46 × 40 hit area stays intact. */
html
  .title-bar
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn) {
  position: relative;
  isolation: isolate;
  border-radius: 0;
  background: transparent;
  --te-titlebar-feedback: transparent;
  transition:
    background-color 160ms ease-out,
    color 160ms ease-out,
    opacity 100ms ease-out;
}

html
  .title-bar
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn)::before {
  content: '';
  position: absolute;
  inset: 5px 7px;
  border-radius: 9px;
  z-index: -1;
  pointer-events: none;
  background: var(--te-titlebar-feedback);
  transition: background-color 160ms ease-out;
}

html
  .title-bar-immersive
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn) {
  transition-property: background-color, opacity;
}

html
  .title-bar
  :is(
    .menu-btn,
    .back-btn,
    .settings-btn,
    .plugins-btn,
    .login-btn,
    .notification-btn
  ):focus-visible::before {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 1px;
}

html
  .title-bar
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn):not(
    :disabled
  ):hover {
  --te-titlebar-feedback: color-mix(in srgb, var(--te-shell-control-text) 4%, transparent);
}

html
  .title-bar
  :is(
    .settings-btn[aria-pressed='true'],
    .login-btn[aria-expanded='true'],
    .notification-btn[aria-expanded='true']
  ) {
  --te-titlebar-feedback: color-mix(in srgb, var(--te-shell-control-text) 8%, transparent);
  color: var(--te-primary-500);
}

html[data-theme='dark']
  .title-bar
  :is(
    .settings-btn[aria-pressed='true'],
    .login-btn[aria-expanded='true'],
    .notification-btn[aria-expanded='true']
  ) {
  color: var(--te-primary-400);
}

html
  .title-bar
  :is(
    .settings-btn[aria-pressed='true'],
    .login-btn[aria-expanded='true'],
    .notification-btn[aria-expanded='true']
  ):not(:disabled):hover {
  --te-titlebar-feedback: color-mix(in srgb, var(--te-shell-control-text) 10%, transparent);
}

html
  .title-bar
  :is(
    .menu-btn,
    .back-btn,
    .settings-btn,
    .plugins-btn,
    .login-btn,
    .notification-btn
  ):focus-visible {
  outline: none;
}

html
  .title-bar
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn):active {
  transform: none;
  opacity: 0.8;
}

.title-bar-liquid
  :is(.menu-btn, .back-btn, .settings-btn, .plugins-btn, .login-btn, .notification-btn)::after {
  /* The inset feedback already owns hover/selection/press paint. */
  display: none;
}

/* Quiet only the visual content. Hit areas, notification dots and focus rings
   keep their own contrast, including when a skin supplies bitmap icons. */
.title-bar :deep(:is(.title-bar-start, .title-bar-back, .title-bar-tools) .title-bar-icon),
.title-bar .window-control-icon,
.title-bar .user-avatar,
.title-bar :deep(.page-dock-action > .theme-icon) {
  opacity: var(--te-titlebar-item-opacity);
  transition: opacity var(--te-titlebar-ink-duration) ease-out;
}

/* Small command labels need more ink than outlines, especially over dark skins. */
.title-bar .title-bar-label,
.title-bar :deep(.page-dock-action-label) {
  opacity: max(0.58, var(--te-titlebar-item-opacity));
  transition: opacity var(--te-titlebar-ink-duration) ease-out;
}

.title-bar :deep(button:not(:disabled):hover) {
  --te-titlebar-item-opacity: 0.76;
}

.title-bar :deep(button[aria-pressed='true']),
.title-bar :deep(button[aria-expanded='true']) {
  --te-titlebar-item-opacity: 0.82;
}

.title-bar :deep(button:focus-visible),
.title-bar .control-btn.close:hover {
  --te-titlebar-item-opacity: 1;
}

@media (prefers-contrast: more), (forced-colors: active) {
  .title-bar,
  .title-bar :deep(button) {
    --te-titlebar-item-opacity: 1;
  }
}

html:is([data-te-motion='reduced'], [data-te-motion='off']) .title-bar {
  --te-titlebar-ink-duration: 0ms;
}

@media (prefers-reduced-motion: reduce) {
  .title-bar {
    --te-titlebar-ink-duration: 0ms;
  }
}

@media (prefers-contrast: more) {
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .login-btn[aria-expanded='true'],
      .notification-btn[aria-expanded='true']
    ),
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .login-btn[aria-expanded='true'],
      .notification-btn[aria-expanded='true']
    ):hover {
    --te-titlebar-feedback: color-mix(in srgb, var(--te-shell-control-text) 22%, transparent);
    color: var(--te-shell-control-text);
  }
}

@media (forced-colors: active) {
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .login-btn[aria-expanded='true'],
      .notification-btn[aria-expanded='true']
    ),
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .login-btn[aria-expanded='true'],
      .notification-btn[aria-expanded='true']
    ):hover {
    --te-titlebar-feedback: Highlight;
    color: HighlightText;
    forced-color-adjust: none;
  }
  html
    .title-bar
    :is(
      .menu-btn,
      .back-btn,
      .settings-btn,
      .plugins-btn,
      .login-btn,
      .notification-btn
    ):focus-visible::before {
    outline-color: Highlight;
  }
}

html:is([data-te-motion='reduced'], [data-te-motion='off']) .title-bar button,
html:is([data-te-motion='reduced'], [data-te-motion='off']) .title-bar button::before {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  @scope (:root:not([data-te-motion='full'])) {
    .title-bar button,
    .title-bar button::before {
      transition: none;
    }
  }
}

/* All effect switches target the painter, rather than its transparent host. */
html[data-te-effects-mode='reduced'] .title-bar .title-bar-background,
body.te-no-blur .title-bar .title-bar-background {
  background: var(--te-titlebar-material-surface) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .title-bar-background {
    background: var(--te-titlebar-material-surface) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  .title-bar-liquid .title-bar-background {
    background: var(--te-lg-context-surface-solid) !important;
    border-bottom: 1px solid var(--te-lg-context-label);
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}

@media (forced-colors: active) {
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .plugins-btn[aria-pressed='true'],
      .notification-btn[aria-expanded='true']
    ),
  html[data-theme]
    .title-bar
    :is(
      .settings-btn[aria-pressed='true'],
      .plugins-btn[aria-pressed='true'],
      .notification-btn[aria-expanded='true']
    ):hover {
    --te-titlebar-feedback: Highlight;
    color: HighlightText;
    forced-color-adjust: none;
  }
  html
    .title-bar
    :is(
      .menu-btn,
      .back-btn,
      .settings-btn,
      .plugins-btn,
      .login-btn,
      .notification-btn
    ):focus-visible::before {
    outline-color: Highlight;
  }
}

html:is([data-te-motion='reduced'], [data-te-motion='off']) .title-bar button,
html:is([data-te-motion='reduced'], [data-te-motion='off']) .title-bar button::before {
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .title-bar button,
  .title-bar button::before {
    transition: none;
  }
}

/* All effect switches target the painter, rather than its transparent host. */
html[data-te-effects-mode='reduced'] .title-bar .title-bar-background,
body.te-no-blur .title-bar .title-bar-background {
  background: var(--te-titlebar-material-surface) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .title-bar-background {
    background: var(--te-titlebar-material-surface) !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  .title-bar-liquid .title-bar-background {
    background: var(--te-lg-context-surface-solid) !important;
    border-bottom: 1px solid var(--te-lg-context-label);
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}

@media (forced-colors: active) {
  html .title-bar.title-bar-immersive {
    --te-shell-control-text: CanvasText;
    background: Canvas !important;
  }

  .title-bar .title-bar-background {
    background: Canvas !important;
    border-bottom: 1px solid CanvasText;
    box-shadow: none;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
}
</style>
