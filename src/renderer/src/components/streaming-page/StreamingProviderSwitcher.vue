<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import type { StreamingProviderOption } from '../../utils/streamingNavigation'

const props = defineProps<{
  modelValue: string
  options: StreamingProviderOption[]
}>()

const emit = defineEmits<{
  change: [providerId: string]
}>()

const providerMenuOpen = ref(false)
const switcherRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuId = useId()
const menuStyle = ref({ left: '0px', top: '0px', maxHeight: '320px', transformOrigin: 'right top' })
const activeOption = computed(
  () => props.options.find((option) => option.id === props.modelValue) ?? props.options[0] ?? null
)

async function toggleProviderMenu(): Promise<void> {
  if (props.options.length < 2) return
  const menu = menuRef.value
  const rect = switcherRef.value?.getBoundingClientRect()
  if (!menu || !rect) return
  if (menu.matches(':popover-open')) {
    closeMenu()
    return
  }
  positionMenu()
  menu.inert = false
  menu.showPopover()
  providerMenuOpen.value = true
  await nextTick()
  menu.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
}

function positionMenu(): void {
  const rect = switcherRef.value?.getBoundingClientRect()
  if (!rect) return
  const below = Math.max(0, window.innerHeight - rect.bottom - 16)
  const above = Math.max(0, rect.top - 16)
  const upward = below < 200 && above > below
  const height = Math.min(320, upward ? above : below)
  const left = Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228))
  menuStyle.value = {
    left: `${left}px`,
    top: `${upward ? Math.max(8, rect.top - height - 8) : rect.bottom + 8}px`,
    maxHeight: `${height}px`,
    transformOrigin: `${Math.max(0, Math.min(220, rect.left + rect.width / 2 - left))}px ${upward ? 'bottom' : 'top'}`
  }
}

function closeMenu(restoreFocus = false): void {
  if (menuRef.value) menuRef.value.inert = true
  menuRef.value?.hidePopover()
  providerMenuOpen.value = false
  if (restoreFocus) triggerRef.value?.focus()
}

function onViewportChange(event: Event): void {
  if (event.target instanceof Node && menuRef.value?.contains(event.target)) return
  if (providerMenuOpen.value) positionMenu()
}

function onToggle(event: Event): void {
  providerMenuOpen.value = (event as ToggleEvent).newState === 'open'
  if (menuRef.value) menuRef.value.inert = !providerMenuOpen.value
}

function selectProvider(providerId: string): void {
  if (providerId !== props.modelValue) emit('change', providerId)
  closeMenu(true)
}

function onMenuKeydown(event: KeyboardEvent): void {
  const items = Array.from(
    menuRef.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []
  )
  if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  const index = items.findIndex((item) => item === document.activeElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!providerMenuOpen.value) return
  const target = event.target
  if (target instanceof Node && switcherRef.value?.contains(target)) return
  closeMenu()
}

function onMenuFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget as Node | null
  if (next && !switcherRef.value?.contains(next)) closeMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})
</script>

<template>
  <div
    v-if="activeOption"
    ref="switcherRef"
    class="provider-switcher"
    :class="{ open: providerMenuOpen }"
    @focusout="onMenuFocusOut"
    @keydown.esc.stop.prevent="closeMenu(true)"
  >
    <button
      v-if="options.length > 1"
      ref="triggerRef"
      type="button"
      class="provider-switcher-trigger"
      :style="{ '--provider-color': activeOption.color }"
      :title="
        options.length > 1
          ? `切换音源（当前：${activeOption.name}）`
          : `当前音源：${activeOption.name}`
      "
      :aria-label="
        options.length > 1
          ? `切换音源，当前为${activeOption.name}`
          : `当前音源：${activeOption.name}`
      "
      :aria-haspopup="options.length > 1 ? 'listbox' : undefined"
      :aria-expanded="options.length > 1 ? providerMenuOpen : undefined"
      :aria-controls="menuId"
      @click="toggleProviderMenu"
      @keydown.down.prevent="toggleProviderMenu"
    >
      <i :class="activeOption.icon" aria-hidden="true"></i>
      <span class="provider-switcher-label">{{ activeOption.name }}</span>
    </button>
    <span v-else class="provider-current" :title="`当前音源：${activeOption.name}`">
      <i :class="activeOption.icon" aria-hidden="true"></i>
      <span class="provider-switcher-label">{{ activeOption.name }}</span>
    </span>

    <div
      :id="menuId"
      ref="menuRef"
      class="provider-switcher-menu"
      popover="auto"
      :style="menuStyle"
      @toggle="onToggle"
      @keydown="onMenuKeydown"
      role="listbox"
      aria-label="选择音源"
    >
      <button
        v-for="option in options"
        :key="option.id"
        type="button"
        class="provider-switcher-option"
        :class="{ active: option.id === activeOption.id }"
        role="option"
        :aria-selected="option.id === activeOption.id"
        :tabindex="option.id === activeOption.id ? 0 : -1"
        :style="{ '--provider-color': option.color }"
        @click="selectProvider(option.id)"
      >
        <i :class="option.icon" aria-hidden="true"></i>
        <span class="provider-switcher-option-name">{{ option.name }}</span>
        <i
          v-if="option.id === activeOption.id"
          class="pi pi-check provider-switcher-option-check"
          aria-hidden="true"
        ></i>
      </button>
    </div>
  </div>
</template>

<style scoped>
.provider-switcher {
  position: relative;
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
}
.provider-switcher-trigger,
.provider-current {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  max-width: min(320px, 100%);
  min-height: max(var(--te-control-height-field), 2.5em);
  box-sizing: border-box;
  padding: 6px 12px;
  color: var(--te-neutral-900);
  font: inherit;
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
}
.provider-switcher-trigger {
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-subtle-bg);
  cursor: pointer;
}
.provider-current {
  padding-inline: 0;
  color: var(--te-neutral-600, var(--te-neutral-500));
}
.provider-switcher-trigger:hover,
.provider-switcher.open .provider-switcher-trigger {
  background: var(--te-hover-bg);
}
.provider-switcher-trigger > .pi,
.provider-current > i {
  flex-shrink: 0;
}
.provider-switcher-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-switcher-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  width: min(220px, calc(100vw - 16px));
  box-sizing: border-box;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 6px;
  border: 1px solid var(--te-card-border);
  border-radius: var(--te-control-radius-sm);
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  box-shadow: var(--te-menu-shadow, var(--te-glass-shadow));
  opacity: 0;
  transition:
    opacity var(--te-motion-panel) var(--te-ease-soft),
    display var(--te-motion-panel) allow-discrete,
    overlay var(--te-motion-panel) allow-discrete;
}
.provider-switcher-menu:popover-open {
  opacity: 1;
  @starting-style {
    opacity: 0;
  }
}
.provider-switcher-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: max(var(--te-control-height-field), 2.5em);
  padding: 6px var(--te-control-pad-x-sm);
  border: 0;
  border-radius: var(--te-control-radius-sm);
  background: transparent;
  color: var(--te-neutral-900);
  font: inherit;
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
  text-align: left;
  cursor: pointer;
}
.provider-switcher-option:hover,
.provider-switcher-option.active {
  background: var(--te-hover-bg);
}
.provider-switcher-option > .pi {
  flex-shrink: 0;
}
.provider-switcher-option-name {
  min-width: 0;
  flex: 1;
  overflow-wrap: anywhere;
}
.provider-switcher-option-check {
  color: var(--te-primary-500);
}
html[data-te-motion='off'] .provider-switcher-menu {
  transition: none;
}
</style>
