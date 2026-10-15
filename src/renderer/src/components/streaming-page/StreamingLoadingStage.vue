<script setup lang="ts">
import { computed } from 'vue'
const props = defineProps<{ providerLabel?: string; title?: string; hint?: string }>()
const stageTitle = computed(() => props.title ?? '正在加载音乐库')
const stageHint = computed(
  () => props.hint ?? `正在同步 ${props.providerLabel ?? '在线音源'} 的歌单与收藏`
)
</script>

<template>
  <div class="tls-stage" role="status" aria-live="polite" :aria-label="stageTitle">
    <i class="pi pi-spin pi-spinner" aria-hidden="true"></i>
    <div class="tls-copy">
      <h2 class="tls-title">{{ stageTitle }}</h2>
      <p class="tls-hint">{{ stageHint }}</p>
    </div>
  </div>
</template>

<style scoped>
.tls-stage {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 24px 0;
  color: var(--te-neutral-600, var(--te-neutral-500));
  font-size: var(--te-type-body);
}
.tls-stage > i {
  margin-top: 4px;
}
.tls-copy {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.tls-title {
  margin: 0;
  color: var(--te-neutral-900);
  font-size: var(--te-type-headline);
  font-weight: var(--te-type-weight-strong);
  line-height: var(--te-type-line-title);
  overflow-wrap: anywhere;
}
.tls-hint {
  margin: 0;
  font-size: var(--te-type-caption);
  line-height: var(--te-type-line-caption);
  overflow-wrap: anywhere;
}
html[data-te-motion='full'] .pi-spin {
  animation: fa-spin 2s infinite linear;
}
</style>
