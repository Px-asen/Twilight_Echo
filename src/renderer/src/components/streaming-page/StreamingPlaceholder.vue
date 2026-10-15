<script setup lang="ts">
defineProps<{
  title: string
  hint: string
  icon: string
  actionLabel?: string
  actionIcon?: string
  danger?: boolean
  detail?: boolean
}>()

const emit = defineEmits<{
  action: []
}>()
</script>

<template>
  <div
    class="streaming-placeholder"
    :class="{ 'detail-placeholder': detail, 'is-error': danger }"
    :role="danger ? 'alert' : 'status'"
  >
    <i :class="icon" class="placeholder-icon" aria-hidden="true"></i>
    <p class="placeholder-title">{{ title }}</p>
    <p class="placeholder-hint">{{ hint }}</p>
    <button v-if="actionLabel" type="button" class="stream-action-btn" @click="emit('action')">
      <i v-if="actionIcon" :class="actionIcon" aria-hidden="true"></i>
      <span>{{ actionLabel }}</span>
    </button>
  </div>
</template>

<style scoped src="./StreamingPlaceholder.css"></style>
