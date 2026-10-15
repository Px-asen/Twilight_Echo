<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEscapeToClose } from '../app/useDismissLayer'
const props = defineProps<{ open: boolean; anchor: HTMLElement | null; label: string }>()
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement>()
const position = ref<Record<string, string>>({ left: '0px', top: '0px' })
const side = ref('none')
let layoutFrame = 0
let sizeObserver: ResizeObserver | undefined
function place(): void {
  const rect = props.anchor?.getBoundingClientRect()
  const element = panel.value
  if (!rect || !element) return
  const width = element.offsetWidth
  const height = element.offsetHeight
  const maxLeft = Math.max(12, window.innerWidth - width - 12)
  const gap = 12
  let left = rect.left + (rect.width - width) / 2
  let top = rect.bottom + gap
  // Small toolbar controls open vertically; larger preview regions open beside their edge.
  if (rect.width > 120 && rect.right + gap <= maxLeft) {
    left = rect.right + gap
    top = rect.top + (rect.height - height) / 2
    side.value = 'left'
  } else if (rect.width > 120 && rect.left - width - gap >= 12) {
    left = rect.left - width - gap
    top = rect.top + (rect.height - height) / 2
    side.value = 'right'
  } else if (top + height <= window.innerHeight - 12) {
    side.value = 'top'
  } else if (rect.top - height - gap >= 54) {
    top = rect.top - height - gap
    side.value = 'bottom'
  } else {
    top = rect.top
    side.value = 'none'
  }
  left = Math.max(12, Math.min(maxLeft, left))
  top = Math.max(54, Math.min(top, window.innerHeight - height - 12))
  position.value = {
    left: `${left}px`,
    top: `${top}px`,
    '--appearance-arrow-x': `${Math.max(22, Math.min(width - 22, rect.left + rect.width / 2 - left))}px`,
    '--appearance-arrow-y': `${Math.max(22, Math.min(height - 22, rect.top + rect.height / 2 - top))}px`
  }
}
function dismiss(restoreFocus = false): void {
  emit('close')
  if (restoreFocus && props.anchor?.isConnected) props.anchor.focus({ preventScroll: true })
}
useEscapeToClose(
  () => props.open,
  () => dismiss(true)
)
watch(panel, (element) => {
  sizeObserver?.disconnect()
  if (element) {
    sizeObserver = new ResizeObserver(place)
    sizeObserver.observe(element)
  }
})
function outside(event: PointerEvent): void {
  const node = event.target as Node
  if (props.open && !panel.value?.contains(node) && !props.anchor?.contains(node)) dismiss()
}
function scrolling(event: Event): void {
  if (props.open && !panel.value?.contains(event.target as Node)) dismiss()
}
watch(
  () => [props.open, props.anchor],
  async () => {
    await nextTick()
    if (!props.open) return
    place()
    panel.value
      ?.querySelector<HTMLElement>('button:not(:disabled),select,input')
      ?.focus({ preventScroll: true })
    cancelAnimationFrame(layoutFrame)
    layoutFrame = requestAnimationFrame(place)
  },
  { flush: 'post' }
)
onMounted(() => {
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('scroll', scrolling, true)
  window.addEventListener('resize', place)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('scroll', scrolling, true)
  window.removeEventListener('resize', place)
  cancelAnimationFrame(layoutFrame)
  sizeObserver?.disconnect()
})
</script>
<template>
  <Teleport to="body">
    <Transition name="appearance-popover">
      <section
        v-if="open"
        ref="panel"
        class="appearance-popover"
        data-te-material="popover"
        :data-side="side"
        :style="position"
        role="dialog"
        :aria-label="label"
        :aria-modal="false"
      >
        <div class="appearance-popover-content"><slot /></div>
      </section>
    </Transition>
  </Teleport>
</template>
<style scoped>
.appearance-popover {
  position: fixed;
  z-index: 2200;
  width: min(304px, calc(100vw - 24px));
  max-height: calc(100vh - 70px);
  overflow: visible;
  border-radius: 18px;
  color: var(--te-material-ink, var(--te-settings-text));
  font: var(--te-type-caption)/var(--te-type-line-body) var(--te-font-sans);
  background: var(--te-material-background, var(--te-settings-backplate));
  border: 1px solid var(--te-material-border, var(--te-card-border));
  box-shadow: var(--te-material-shadow, none);
  backdrop-filter: var(--te-material-filter, none);
  -webkit-backdrop-filter: var(--te-material-filter, none);
}
.appearance-popover-content {
  max-height: calc(100vh - 70px);
  overflow: auto;
  padding: 16px;
  border-radius: inherit;
}
.appearance-popover::before {
  content: '';
  position: absolute;
  width: 10px;
  height: 10px;
  background: var(--te-material-solid, var(--te-settings-backplate));
  border: 1px solid var(--te-material-border, var(--te-card-border));
  transform: rotate(45deg);
  z-index: -1;
}
.appearance-popover[data-side='none']::before {
  display: none;
}
.appearance-popover[data-side='top']::before {
  top: -6px;
  left: calc(var(--appearance-arrow-x) - 5px);
  border-right: 0;
  border-bottom: 0;
}
.appearance-popover[data-side='top'] {
  transform-origin: var(--appearance-arrow-x) top;
}
.appearance-popover[data-side='bottom'] {
  transform-origin: var(--appearance-arrow-x) bottom;
}
.appearance-popover[data-side='left'] {
  transform-origin: left var(--appearance-arrow-y);
}
.appearance-popover[data-side='right'] {
  transform-origin: right var(--appearance-arrow-y);
}
.appearance-popover[data-side='bottom']::before {
  bottom: -6px;
  left: calc(var(--appearance-arrow-x) - 5px);
  border-left: 0;
  border-top: 0;
}
.appearance-popover[data-side='left']::before {
  left: -6px;
  top: calc(var(--appearance-arrow-y) - 5px);
  border-right: 0;
  border-top: 0;
}
.appearance-popover[data-side='right']::before {
  right: -6px;
  top: calc(var(--appearance-arrow-y) - 5px);
  border-left: 0;
  border-bottom: 0;
}
.appearance-popover-enter-active,
.appearance-popover-leave-active {
  transition:
    opacity 140ms ease,
    transform 140ms var(--te-ease-soft, ease-out);
}
.appearance-popover-enter-from,
.appearance-popover-leave-to {
  opacity: 0;
  transform: translateY(3px) scale(0.985);
}
@media (prefers-reduced-motion: reduce) {
  :global(html:not([data-te-motion='full']) .appearance-popover-enter-active),
  :global(html:not([data-te-motion='full']) .appearance-popover-leave-active) {
    transition: none;
  }
}
:global(html[data-te-motion='off'] .appearance-popover-enter-active),
:global(html[data-te-motion='off'] .appearance-popover-leave-active) {
  transition: none;
}
:global(html[data-te-motion='reduced'] .appearance-popover-enter-active),
:global(html[data-te-motion='reduced'] .appearance-popover-leave-active) {
  transition: opacity 100ms ease;
}
:global(html[data-te-motion='reduced'] .appearance-popover-enter-from),
:global(html[data-te-motion='reduced'] .appearance-popover-leave-to) {
  transform: none;
}
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .appearance-popover {
    background: var(--te-settings-backplate);
    backdrop-filter: none;
  }
}
</style>
