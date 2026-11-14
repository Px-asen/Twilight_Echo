<script setup lang="ts">
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import CoverImg from './CoverImg.vue'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer.ts'

import { syncPluginProviders, useMediaProviders } from '../providers/index.ts'
import type { Track } from '../types/music'

const props = defineProps<{ track: Track }>()
const emit = defineEmits<{
  close: []
  select: [track: Track]
}>()

const providers = useMediaProviders()

const query = ref('')
const results = shallowRef<Track[]>([])
const searching = ref(false)
const error = ref('')
const dialog = ref<HTMLElement | null>(null)
let controller: AbortController | undefined

useEscapeToClose(() => true, () => emit('close'))
useFocusTrap(dialog, () => true)

function sourceId(track: Track): string {
  if (track.source) return track.source
  const separator = track.id.indexOf(':')
  return separator > 0 ? track.id.slice(0, separator) : 'local'
}

function sourceName(track: Track): string {
  const source = sourceId(track)
  if (source === 'local') return '本地音乐'
  return providers.get(source)?.name ?? source
}

function duration(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`
}

function reset(): void {
  controller?.abort()
  query.value = [props.track.title, props.track.artist].filter(Boolean).join(' ')
  results.value = []
  error.value = ''
  searching.value = false
}

async function search(): Promise<void> {
  const text = query.value.trim()
  if (!text) return
  controller?.abort()
  const nextController = new AbortController()
  controller = nextController
  searching.value = true
  error.value = ''
  try {
    await syncPluginProviders()
    const result = await providers.searchAllSongs({
      query: text,
      limit: 40,
      offset: 0,
      signal: nextController.signal
    })
    if (nextController.signal.aborted) return
    const seen = new Set<string>()
    results.value = result.items
      .map((item) => item.track)
      .filter((track) => {
        const source = sourceId(track)
        const provider = source === 'local' ? null : providers.get(source)
        if (source !== 'local' && !provider?.getPlaybackUrl) return false
        const key = `${source}:${track.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  } catch (value) {
    if (!nextController.signal.aborted) error.value = value instanceof Error ? value.message : String(value)
  } finally {
    if (controller === nextController) searching.value = false
  }
}

function select(track: Track): void {
  emit('select', track)
  emit('close')
}

watch(() => props.track, reset, { immediate: true })
onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <Teleport to="body">
    <div class="source-picker-overlay" @click.self="emit('close')">
      <section ref="dialog" class="source-picker" role="dialog" aria-modal="true" aria-labelledby="source-picker-title">
        <header>
          <div>
            <span class="eyebrow">选择播放来源</span>
            <h2 id="source-picker-title">{{ props.track.title || '信息缺失' }}</h2>
            <p>{{ props.track.artist || '艺术家未提供' }} · {{ props.track.album || '专辑未提供' }}</p>
          </div>
          <button type="button" class="close" aria-label="关闭选源" @click="emit('close')">×</button>
        </header>
        <div class="search-row">
          <input v-model="query" aria-label="搜索歌曲来源" placeholder="输入歌名或艺术家" @keydown.enter="search" />
          <button type="button" class="primary" :disabled="searching || !query.trim()" @click="search">
            {{ searching ? '搜索中…' : '搜索音源' }}
          </button>
        </div>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <p v-else-if="!results.length && !searching" class="empty">搜索本地库和已启用的流媒体来源</p>
        <ul v-else class="results" aria-live="polite">
          <li v-for="(candidate, index) in results" :key="`${candidate.id}:${index}`">
            <CoverImg
              :cover="candidate.coverSmall || candidate.cover"
              :cover-source="candidate.coverSmallSource || candidate.coverSource"
              :identity="candidate.id"
              size="sm"
              class="candidate-cover"
              alt=""
              loading="lazy"
            />
            <div class="candidate-copy">
              <strong>{{ candidate.title || '信息缺失' }}</strong>
              <span>{{ candidate.artist || '艺术家未提供' }} · {{ candidate.album || '专辑未提供' }}</span>
              <small>{{ sourceName(candidate) }} · {{ duration(candidate.duration) }}</small>
            </div>
            <button type="button" @click="select(candidate)">使用</button>
          </li>
        </ul>
        <footer>
          <span>当前来源：{{ sourceName(props.track) }}</span>
          <button type="button" @click="emit('close')">取消</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.source-picker-overlay{position:fixed;inset:0;z-index:1800;display:grid;place-items:center;padding:24px;background:#0007;backdrop-filter:blur(8px)}
.source-picker{width:min(700px,100%);max-height:min(760px,88vh);overflow:auto;box-sizing:border-box;padding:24px;border:1px solid var(--te-card-border,#ddd);border-radius:14px;background:var(--te-card-bg,#fff);color:var(--te-neutral-900,#171b23);box-shadow:var(--te-card-shadow,0 18px 60px #0003)}
.source-picker header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.eyebrow{font-size:11px;color:var(--te-neutral-500,#656b78);text-transform:uppercase;letter-spacing:.08em}.source-picker h2{margin:7px 0 5px;font-size:20px;overflow-wrap:anywhere}.source-picker p{margin:0;color:var(--te-neutral-500,#656b78);font-size:13px;line-height:1.5}.close{border:0;background:transparent;padding:0 4px;font-size:25px;line-height:1;color:inherit;cursor:pointer}.search-row{display:flex;gap:8px;margin:22px 0 12px}.search-row input{min-width:0;flex:1;box-sizing:border-box;border:1px solid var(--te-card-border,#ddd);border-radius:8px;padding:10px 12px;background:var(--te-subtle-bg,#f4f5f8);color:inherit;font:inherit}.search-row button,.results button,footer button{border:1px solid var(--te-card-border,#ddd);border-radius:8px;padding:8px 12px;background:var(--te-subtle-bg,#f4f5f8);color:inherit;font:inherit;cursor:pointer}.search-row .primary{border-color:transparent;background:var(--te-primary-500,#6664dc);color:#fff}.search-row button:disabled{opacity:.55;cursor:default}.error{color:var(--te-danger-500,#b33a45)!important}.empty{text-align:center;padding:36px 0}.results{list-style:none;margin:0;padding:0}.results li{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid var(--te-card-border,#ddd)}.candidate-cover{width:44px;height:44px;flex:none;border-radius:6px;object-fit:cover;background:var(--te-subtle-bg,#f4f5f8)}.candidate-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:4px}.candidate-copy strong,.candidate-copy span,.candidate-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.candidate-copy strong{font-size:13px}.candidate-copy span,.candidate-copy small{font-size:12px;color:var(--te-neutral-500,#656b78)}footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:18px;color:var(--te-neutral-500,#656b78);font-size:12px}footer button{color:inherit}@media(max-width:600px){.source-picker{padding:18px}.search-row{flex-direction:column}.search-row .primary{width:100%}.results li{align-items:flex-start}.results li>button{align-self:center;padding-inline:9px}}
.source-picker header > .close {
  display: inline-flex;
  flex: none;
  width: var(--te-control-height-md);
  height: var(--te-control-height-md);
  align-items: center;
  justify-content: center;
}
</style>
