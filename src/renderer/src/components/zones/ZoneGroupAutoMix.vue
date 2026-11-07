<script setup lang="ts">
import { computed } from 'vue'
import type { SyncGroupView } from '../../../../shared/coreSyncGroups.ts'
import type { AutoMixMode } from '../../../../shared/twilightAutoMix.ts'
import { moveRadioFocus } from './radioFocus.ts'

const props = defineProps<{ group: SyncGroupView; busy: boolean }>()
const emit = defineEmits<{ change: [mode: AutoMixMode] }>()
const choices: { mode: AutoMixMode; label: string; hint: string }[] = [
  { mode: 'off', label: '关闭', hint: '按原曲顺序衔接' },
  { mode: 'natural', label: '自然', hint: '柔和衔接，保留歌曲节奏' },
  { mode: 'dj', label: 'DJ', hint: '节拍对齐与混音过渡' }
]
const mode = computed(() => props.group.autoMixMode ?? 'off')
const status = computed(() => {
  if (props.busy) return '正在保存'
  if (mode.value === 'off') return '已关闭'
  if (props.group.playback?.state !== 'playing') return '暂停待播'
  return ({ preparing: '正在准备', ready: '已就绪', mixing: '正在过渡', degraded: '普通衔接', off: '等待下一曲' } as Record<string, string>)[props.group.playback.autoMixState ?? 'off'] ?? '等待下一曲'
})
</script>

<template>
  <section class="zones-panel zone-automix" aria-labelledby="zone-automix-title" :aria-busy="busy">
    <header class="zones-panel-head">
      <div><h3 id="zone-automix-title">AutoMix</h3><p>全组采用同一过渡，成员一起切换</p></div>
      <span class="zones-chip">{{ status }}<template v-if="group.playback?.state === 'playing' && group.playback.autoMixStemEnhanced"> · 人声分离增强</template></span>
    </header>
    <div class="zone-automix-choices" role="radiogroup" aria-label="同步组 AutoMix 模式" @keydown="moveRadioFocus">
      <button v-for="choice in choices" :key="choice.mode" type="button" role="radio"
        :aria-checked="mode === choice.mode" :tabindex="mode === choice.mode || (!group.autoMixAvailable && choice.mode === 'off') ? 0 : -1"
        :disabled="busy || (choice.mode !== 'off' && !group.autoMixAvailable)"
        @click="choice.mode !== mode && emit('change', choice.mode)">
        <strong>{{ choice.label }}</strong><span>{{ choice.hint }}</span>
      </button>
    </div>
    <p class="zone-automix-note">{{ group.autoMixAvailable ? '更改后全组暂停；按播放继续。成员的本地 AutoMix 设置不变。' : '更新 Core 与成员引擎后可开启组 AutoMix。' }}</p>
  </section>
</template>

<style scoped>
.zone-automix-choices { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.zone-automix-choices button { text-align: left; display: flex; flex-direction: column; gap: 5px; padding: 14px 16px; border: 1px solid var(--zones-line); border-radius: 14px; color: var(--zones-ink); background: transparent; cursor: pointer; }
.zone-automix-choices button[aria-checked='true'] { border-color: currentColor; background: var(--zones-subtle); }
.zone-automix-choices button:disabled { opacity: .45; cursor: default; }
.zone-automix-choices strong { font-size: 14px; font-weight: 600; }
.zone-automix-choices span, .zone-automix-note { color: var(--zones-muted); font-size: 13px; line-height: 1.6; }
.zone-automix-note { margin: 14px 0 0; }
@media (max-width: 620px) { .zone-automix-choices { grid-template-columns: 1fr; } }
</style>
