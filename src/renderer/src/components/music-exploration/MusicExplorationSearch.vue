<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { createExplorationSearchView } from './explorationSearchView.ts'
const props = defineProps<{ query: string }>()
const core = useCoreConnection()
const view = createExplorationSearchView((query, signal) => core.query('exploration.query', query, signal))
const state = view.state, scope = ref<'library' | 'catalog'>('library'), selected = ref('')
const MusicExplorationPanel = defineAsyncComponent(() => import('./MusicExplorationPanel.vue'))
watch([
  () => props.query.trim(), scope, () => core.state.value?.epoch,
  () => core.state.value?.pluginsRevision, () => core.state.value?.explorationRevision,
  () => core.state.value?.catalogRevision, () => core.state.value?.libraryRevision,
  () => core.state.value?.entityMetadataRevision
], ([query, nextScope, epoch, plugins], [previousQuery, previousScope, previousEpoch, previousPlugins]) => {
  if (query !== previousQuery || nextScope !== previousScope || epoch !== previousEpoch || plugins !== previousPlugins) {
    selected.value = ''
    void view.setQuery(query, nextScope)
  } else {
    void view.refresh()
  }
}, { immediate: true })
onBeforeUnmount(() => view.dispose())
</script>

<template>
  <section v-if="query.trim()" class="exploration-search" aria-label="统一搜索的人物与作品" :aria-busy="state.loading">
    <header><h3>人物与作品</h3><label>范围 <select v-model="scope"><option value="library">库内参与内容</option><option value="catalog">含外部目录缓存</option></select></label></header>
    <p v-if="state.loading && !state.page" role="status">正在查找人物与作品…</p>
    <p v-else-if="state.error" role="alert">{{ state.error }} <button type="button" @click="view.refresh()">重新读取</button></p>
    <template v-else-if="state.page">
      <p v-if="!state.page.total">暂无匹配的{{ scope === 'library' ? '库内' : '已保存' }}人物或作品。</p>
      <ul v-else><li v-for="item in state.page.items" :key="item.id">
        <button type="button" :aria-pressed="selected === item.id" @click="selected = item.id">{{ item.title }} <span>· {{ item.kind === 'artist' ? '人物' : item.kind === 'work' ? '作品' : '演绎' }} · {{ item.inLibrary ? `库内 ${item.sourceCount} 个来源` : '仅目录缓存' }}</span></button>
      </li></ul>
      <nav v-if="state.page.total > 10" aria-label="人物作品搜索分页"><button type="button" :disabled="state.loading || !state.page.offset" @click="view.page(Math.max(0, state.page.offset - 10))">上一页</button><span>{{ state.page.offset + 1 }}–{{ state.page.offset + state.page.items.length }} / {{ state.page.total }}</span><button type="button" :disabled="state.loading || state.page.offset + state.page.items.length >= state.page.total" @click="view.page(state.page.offset + 10)">下一页</button></nav>
    </template>
    <template v-if="selected"><button type="button" @click="selected = ''">收起详情</button><MusicExplorationPanel :entity-id="selected" /></template>
  </section>
</template>

<style scoped>
.exploration-search {
  margin: 12px 0;
  padding: 14px 16px;
  border-radius: 12px;
  border: 1px solid var(--te-card-border);
  background: var(--te-card-bg, color-mix(in srgb, var(--te-neutral-500, #888) 4%, transparent));
  font-size: var(--te-font-size-body, 13px);
}
header,
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
header {
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--te-card-border);
}
h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
ul {
  list-style: none;
  margin: 10px 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
li {
  margin: 0;
}
span {
  color: var(--te-neutral-500);
  font-size: 12px;
}
button,
select {
  color: var(--te-neutral-900);
  background: var(--te-hover-bg);
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  padding: 6px 12px;
  font: inherit;
  transition: background-color 0.14s ease, border-color 0.14s ease;
}
button {
  cursor: pointer;
}
button[aria-pressed='true'] {
  border-color: var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-500, #3b82f6) 14%, transparent);
  color: var(--te-primary-600);
  font-weight: 600;
}
button:disabled {
  opacity: 0.45;
}
button:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
</style>
