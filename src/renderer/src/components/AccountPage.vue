<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useEscapeToClose } from '../app/useDismissLayer'
import ThemeIcon from './ThemeIcon.vue'

const props = defineProps<{ initialProviderId?: string | null; anchor?: HTMLElement | null }>()
const emit = defineEmits<{
  close: [returnFocus?: boolean]
  configure: []
  loginSuccess: []
  noticeTarget: [target: HTMLElement | null]
}>()
const LoginPage = defineAsyncComponent(() => import('./LoginPage.vue'))
const loginPage = ref<{ canDismissOutside: () => boolean } | null>(null)
const subpage = ref<HTMLElement | null>(null)
const noticeTarget = ref<HTMLElement | null>(null)
const position = reactive({ top: 48, left: 16 })
let anchorObserver: ResizeObserver | undefined

function updatePosition(): void {
  const anchor = props.anchor?.getBoundingClientRect()
  const titleInset =
    Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--te-titlebar-inset')
    ) || 40
  const width = Math.min(440, window.innerWidth - 24)
  position.left = Math.max(12, Math.min((anchor?.left ?? 28) - 12, window.innerWidth - width - 12))
  position.top = Math.max(titleInset, anchor?.bottom ?? 0) + 8
}
function dismissOutside(event: PointerEvent | FocusEvent): void {
  const target = event.target
  if (document.querySelector('dialog:modal') || !(target instanceof Node)) return
  // The title-bar return control resolves the account's existing inner/back stack.
  if (target instanceof Element && target.closest('.title-bar .back-btn')) return
  if (
    !subpage.value?.contains(target) &&
    !props.anchor?.contains(target) &&
    loginPage.value?.canDismissOutside() !== false
  )
    emit('close', false)
}
useEscapeToClose(
  () => true,
  () => emit('close', true)
)
onMounted(() => {
  updatePosition()
  emit('noticeTarget', noticeTarget.value)
  subpage.value?.focus({ preventScroll: true })
  window.addEventListener('resize', updatePosition)
  document.addEventListener('pointerdown', dismissOutside)
  document.addEventListener('focusin', dismissOutside)
  if (props.anchor) {
    anchorObserver = new ResizeObserver(updatePosition)
    anchorObserver.observe(props.anchor)
  }
})
onBeforeUnmount(() => {
  emit('noticeTarget', null)
  anchorObserver?.disconnect()
  window.removeEventListener('resize', updatePosition)
  document.removeEventListener('pointerdown', dismissOutside)
  document.removeEventListener('focusin', dismissOutside)
})
</script>

<template>
  <section
    id="account-subpage"
    ref="subpage"
    class="account-page"
    data-te-material="panel"
    role="dialog"
    aria-modal="false"
    tabindex="-1"
    aria-labelledby="account-page-title"
    :style="{ '--account-top': `${position.top}px`, '--account-left': `${position.left}px` }"
  >
    <div class="account-page-inner">
      <header class="account-page-header">
        <div>
          <h1 id="account-page-title">我的</h1>
        </div>
        <button
          type="button"
          class="account-collapse"
          aria-label="收起我的"
          title="收起我的"
          @click="emit('close', true)"
        >
          <ThemeIcon icon-slot="library.clear" />
        </button>
      </header>
      <div class="account-page-sections">
        <section class="account-connections" aria-label="音乐账户">
          <LoginPage
            ref="loginPage"
            embedded
            compact-profile
            :initial-provider-id="initialProviderId"
            @configure="emit('configure')"
            @login-success="emit('loginSuccess')"
          />
        </section>
        <section class="account-activity" aria-label="任务与通知">
          <div ref="noticeTarget" class="account-notice-target" />
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.account-page {
  position: fixed;
  top: var(--account-top, 48px);
  left: var(--account-left, 16px);
  z-index: 2050;
  display: flex;
  flex-direction: column;
  width: min(440px, calc(100vw - 24px));
  max-height: max(0px, calc(100dvh - var(--account-top, 48px) - var(--te-page-bottom, 32px)));
  box-sizing: border-box;
  overflow: hidden;
  padding: 0;
  border: 0;
  border-radius: 14px;
  background: var(--te-material-background, var(--te-chrome-material-solid));
  box-shadow: var(--te-material-shadow, none);
  color: var(--te-material-ink, var(--te-neutral-900));
  font-family: var(--te-font-sans);
  font-size: var(--te-type-body, 15px);
  outline: none;
  transform-origin: 24px top;
}
.account-page-inner {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.account-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--te-card-border);
}
.account-page-header h1 {
  margin: 0;
  font-size: var(--te-type-section-title, 20px);
  font-weight: 600;
  line-height: 1.3;
}
.account-collapse {
  display: grid;
  place-items: center;
  min-width: max(var(--te-control-height-md, 34px), 1.5em);
  min-height: max(var(--te-control-height-md, 34px), 1.5em);
  flex-shrink: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--te-text-secondary);
  cursor: pointer;
}
.account-collapse :deep(.theme-icon) {
  font-size: var(--te-type-icon, 16px);
}
.account-collapse:hover {
  background: var(--te-subtle-bg);
  color: var(--te-text);
}
.account-page-sections {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--te-space-group, 24px);
  min-height: 0;
  padding: 16px 20px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}
.account-page-sections > section {
  min-width: 0;
}
.account-activity {
  border-top: 1px solid color-mix(in srgb, var(--te-text) 10%, transparent);
  padding-top: 16px;
}
.account-collapse:focus-visible {
  outline: 2px solid var(--te-control-focus-color);
  outline-offset: 4px;
  border-radius: 4px;
}
@media (max-width: 480px) {
  .account-page-header,
  .account-page-sections {
    padding-inline: 16px;
  }
}
.account-subpage-enter-active,
.account-subpage-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}
.account-subpage-enter-from,
.account-subpage-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .account-subpage-enter-active,
  .account-subpage-leave-active {
    transition: none;
  }
}
</style>
