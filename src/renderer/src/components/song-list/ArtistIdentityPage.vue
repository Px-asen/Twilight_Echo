<script setup lang="ts">
import type { CatalogEntity, CatalogPage } from '../../../../shared/musicCatalog.ts'
import type { MusicIdentityDetail } from '../../../../shared/musicIdentification.ts'
import IdentityReviewPanel from '../music-metadata/IdentityReviewPanel.vue'
import { ARTIST_REFERENCE_PAGE_SIZE } from './artistDetailView.ts'

defineProps<{
  page: CatalogPage | null
  samples: Record<string, string>
  identities: Record<string, MusicIdentityDetail>
  selected: string | null
  shared: boolean
  exact: boolean
  loading: boolean
  scope: string
}>()
defineEmits<{ select: [entity: CatalogEntity]; page: [offset: number]; changed: [] }>()
function identityLabel(identity?: MusicIdentityDetail) {
  if (identity?.link?.state !== 'confirmed')
    return identity?.link?.state === 'detached' ? '已解除关联' : '待核对身份'
  return identity.link.confirmation?.mode === 'automatic' ? '已自动确认' : '身份已确认'
}
</script>

<template>
  <div class="artist-identity-page" :aria-busy="loading">
    <header>
      <h3>人物身份</h3>
      <p>默认自动采用可信资料。可按来源曲目核对同名人物，并指定要展示的资料。</p>
      <p v-if="!exact && page?.total">此分组含多位参与者，请分别核对各自的身份。</p>
    </header>
    <p v-if="loading" role="status">正在读取人物身份…</p>
    <p v-else-if="!page?.total" class="empty">暂无可核对的库内人物条目。</p>
    <ul v-else class="artist-identity-entries" aria-label="库内人物条目">
      <li v-for="entity in page.items" :key="entity.id">
        <button
          type="button"
          :aria-pressed="selected === entity.id"
          :disabled="loading"
          @click="$emit('select', entity)"
        >
          <strong>{{ entity.title }}</strong>
          <span>{{ samples[entity.id] || '暂无来源曲目' }}</span>
          <span class="entry-state">
            {{ identityLabel(identities[entity.id]) }}
            <em v-if="selected === entity.id">{{ shared ? '自动采用' : '正在查看' }}</em>
          </span>
        </button>
      </li>
    </ul>
    <nav v-if="page && page.total > ARTIST_REFERENCE_PAGE_SIZE" aria-label="人物条目分页">
      <button
        type="button"
        :disabled="loading || page.offset === 0"
        @click="$emit('page', page.offset - ARTIST_REFERENCE_PAGE_SIZE)"
      >
        上一页条目
      </button>
      <span>{{ page.offset + 1 }}–{{ page.offset + page.items.length }} / {{ page.total }}</span>
      <button
        type="button"
        :disabled="loading || page.offset + page.items.length >= page.total"
        @click="$emit('page', page.offset + ARTIST_REFERENCE_PAGE_SIZE)"
      >
        下一页条目
      </button>
    </nav>
    <template v-if="selected">
      <p class="current-source">当前条目：{{ samples[selected] || '暂无来源曲目' }}</p>
      <slot />
      <IdentityReviewPanel :entity-id="selected" :scope="scope" @changed="$emit('changed')" />
    </template>
  </div>
</template>

<style scoped>
.artist-identity-page {
  padding-block: 30px;
}
h3 {
  margin: 0;
  font-size: 24px;
}
p {
  color: var(--te-neutral-500);
  font-size: var(--te-font-size-body, 14px);
  line-height: 1.8;
}
.artist-identity-entries {
  list-style: none;
  padding: 0;
  margin: 24px 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr));
  gap: 12px;
}
button {
  font: inherit;
  font-size: var(--te-font-size-body, 14px);
  color: var(--te-neutral-900);
  background: var(--te-hover-bg);
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
}
li button {
  display: grid;
  width: 100%;
  height: 100%;
  gap: 8px;
}
li span {
  color: var(--te-neutral-500);
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.entry-state {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 13px;
}
em {
  color: var(--te-primary-600);
  font-style: normal;
}
button[aria-pressed='true'] {
  border-color: var(--te-primary-500);
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  font-size: 13px;
}
.current-source {
  margin: 28px 0 0;
  padding-top: 22px;
  border-top: 1px solid var(--te-card-border);
  overflow-wrap: anywhere;
}
</style>
