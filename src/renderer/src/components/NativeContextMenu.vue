<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import type { NativeContextMenuItem } from '../../../shared/nativeContextMenu.ts'

const emit = defineEmits<{ close: [] }>()
const root = ref<HTMLElement | null>(null)
const requestId = crypto.randomUUID()
let active = true
let pending = false

function collectItems(
  container: HTMLElement,
  actions: Map<string, HTMLElement>
): NativeContextMenuItem[] {
  return Array.from(container.children)
    .filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        (child.classList.contains('menu-item') || child.matches('button'))
    )
    .map((element) => {
      const submenu = element.querySelector<HTMLElement>(':scope > .submenu')
      const label = Array.from(element.childNodes)
        .filter((child) => child !== submenu)
        .map((child) => child.textContent || '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      const id = String(actions.size)
      actions.set(id, element)
      return {
        id,
        label,
        enabled: !element.classList.contains('disabled') && !element.hasAttribute('disabled'),
        ...(submenu ? { submenu: collectItems(submenu, actions) } : {})
      }
    })
}

onMounted(async () => {
  const actions = new Map<string, HTMLElement>()
  const items = collectItems(root.value!, actions)
  pending = true
  try {
    const selected = await window.api.window.popupContextMenu({ requestId, items })
    pending = false
    if (active && selected !== null) actions.get(selected)?.click()
  } finally {
    pending = false
    if (active) emit('close')
  }
})

onBeforeUnmount(() => {
  active = false
  if (pending) void window.api.window.closeContextMenu(requestId)
})
</script>

<template>
  <div ref="root" hidden><slot /></div>
</template>
