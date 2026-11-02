<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import type {
  EntityMetadataDetail,
  EntityMetadataLanguage,
  EntityMetadataJob
} from '../../../../shared/entityMetadata.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import IntroductionEditor from '../music-metadata/IntroductionEditor.vue'
import PersonalMetadataEditor from '../music-metadata/PersonalMetadataEditor.vue'
import PersonalPreferencesPanel from '../music-preferences/PersonalPreferencesPanel.vue'
import {
  metadataTaskReasonLabel,
  metadataTaskStateLabel
} from '../music-metadata/metadataTasksView.ts'
import { artistUpdateProviders, createArtistMetadataUpdate } from './artistMetadataUpdate.ts'
import { metadataProviderLabel } from '../../../../shared/metadataProviders.ts'

const props = defineProps<{
  detail: EntityMetadataDetail | null
  shared: boolean
  language: EntityMetadataLanguage
  scope: string
  available: boolean
  refresh: () => Promise<void>
}>()
defineEmits<{ edit: [] }>()
const core = useCoreConnection()
const update = createArtistMetadataUpdate({
  policy: (signal) => core.query('metadata.entity.policy', {}, signal),
  identity: (entityId, signal) => core.query('identification.detail', { entityId }, signal),
  jobs: (entityId, signal) => core.query('metadata.entity.jobs', { entityId, limit: 10 }, signal),
  enrich: async (request) =>
    (await core.command('metadata.entity.enrich', request)) as EntityMetadataJob,
  sources: (query) => core.query('metadata.entity.sources', query),
  requery: (request) => core.command('metadata.entity.requery', request),
  newId: () => `artist-page:${crypto.randomUUID()}`
})
const state = update.state
const editable = computed(() => (!props.shared ? props.detail : null))
const confirmed = computed(() => props.detail?.link?.state === 'confirmed')
watch(
  () => JSON.stringify([props.detail?.entityId, confirmed.value, props.language, props.scope]),
  () => {
    void update.setContext(
      confirmed.value && props.detail
        ? { entityId: props.detail.entityId, language: props.language }
        : null
    )
  },
  { immediate: true }
)
watch(
  [() => core.state.value?.entityMetadataRevision, () => core.state.value?.settingsRevision],
  () => {
    void update.refresh()
  }
)
const hasUpdateProvider = computed(
  () =>
    !!state.value.policy &&
    artistUpdateProviders(state.value.policy, 'artist', state.value.references).length > 0
)
const canUpdate = computed(() => props.available && hasUpdateProvider.value)
onBeforeUnmount(update.dispose)
</script>

<template>
  <section class="artist-manager" aria-label="管理艺术家资料">
    <div class="update-row">
      <div>
        <h3>公开资料</h3>
        <p>按已确认 ID 组合各来源简介与授权照片，保留手工内容。</p>
      </div>
      <button
        type="button"
        class="update-button"
        :disabled="!canUpdate || state.loading || state.submitting"
        @click="update.submit()"
      >
        {{ state.submitting ? '正在提交…' : '更新资料' }}
      </button>
    </div>
    <p v-if="!confirmed" class="hint">确认人物身份后，即可更新公开资料。</p>
    <template v-else-if="state.policy">
      <p v-if="!hasUpdateProvider" class="hint">
        {{
          metadataTaskReasonLabel(
            state.policy.reason ||
              state.policy.artwork?.find((item) => item.kind === 'artist')?.reason ||
              'provider_not_available'
          )
        }}
      </p>
      <p v-else-if="!state.policy.introduction" class="hint">
        Wikipedia 正文权限尚未开启；本次只更新已授权的资料。
      </p>
    </template>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <p v-if="state.error" role="alert">
      {{ state.error }} <button type="button" @click="update.refresh()">重新读取任务</button>
    </p>
    <ul v-if="state.jobs.length" class="artist-update-jobs" aria-label="艺术家资料任务">
      <li v-for="job in state.jobs" :key="job.id">
        <span
          >{{ metadataProviderLabel(job.provider) }} ·
          {{
            job.provider === 'public-artwork'
              ? '人物照片'
              : job.type === 'enrich'
                ? '人物资料'
                : '身份识别'
          }}</span
        >
        <span
          >{{ metadataTaskStateLabel[job.state]
          }}<template v-if="job.outcome === 'not_found'"> · 未找到资料</template
          ><template v-if="job.reason"> · {{ metadataTaskReasonLabel(job.reason) }}</template></span
        >
      </li>
    </ul>
    <p v-if="shared" class="hint">
      当前自动展示公开资料，手工编辑只影响当前库内条目。
      <button type="button" @click="$emit('edit')">编辑当前条目</button>
    </p>
    <template v-if="editable">
      <IntroductionEditor
        :scope="scope"
        :selected="editable.entityId"
        :detail="editable"
        :available="available"
        :language="language"
        :refresh="refresh"
      />
      <PersonalMetadataEditor
        :scope="scope"
        :selected="editable.entityId"
        :detail="editable"
        :available="available"
        :language="language"
        :refresh="refresh"
      />
      <PersonalPreferencesPanel
        v-if="confirmed"
        :entity-id="editable.entityId"
        :scope="scope"
        label="艺人"
      />
    </template>
  </section>
</template>

<style scoped>
.artist-manager {
  padding: 22px 0;
  line-height: 1.7;
}
.update-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 16px;
}
h3,
p {
  margin: 4px 0;
}
h3 {
  font-size: 17px;
}
p,
.artist-update-jobs {
  font-size: var(--te-font-size-body, 14px);
}
.hint,
.update-row p {
  color: var(--te-neutral-500);
}
button {
  font: inherit;
  cursor: pointer;
  color: var(--te-primary-600);
  border: 0;
  background: var(--te-hover-bg);
  border-radius: 8px;
  padding: 8px 14px;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.artist-update-jobs {
  padding: 0;
  margin: 16px 0;
  list-style: none;
}
.artist-update-jobs li {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--te-card-border);
}
</style>
