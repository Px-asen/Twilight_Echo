<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  createPersonalRatingsView,
  observePersonalRatingsView,
  ratingLabel,
  RATINGS_HISTORY_PAGE_SIZE
} from './personalRatingsView.ts'
import PersonalPreferencesPanel from '../music-preferences/PersonalPreferencesPanel.vue'
import MusicTagsPanel from '../music-tags/MusicTagsPanel.vue'
import { createRatingTargetsView, RATING_TARGET_PAGE_SIZE } from './ratingTargetsView.ts'
const props = defineProps<{
  entityId: string
  scope?: string
  label: string
  trackContext?: { provider: string; id: string }
  compact?: boolean
}>()
const core = useCoreConnection()
const view = createPersonalRatingsView({
  detail: (entityId, signal) => core.query('ratings.detail', { entityId }, signal),
  set: (query) => core.command('ratings.set', query),
  history: (query, signal) => core.query('ratings.history', query, signal)
})
const { state, ready, canSave } = view
const targets = createRatingTargetsView((query, signal) =>
  core.query('ratings.targets', query, signal)
)
const targetState = targets.state
watch(
  [() => props.entityId, () => props.scope, () => JSON.stringify(props.trackContext)],
  ([id, scope]) => void targets.setContext(id, scope ?? '', props.trackContext),
  { immediate: true, flush: 'sync' }
)
watch(
  [
    () => core.state.value?.epoch,
    () => core.state.value?.catalogRevision,
    () => core.state.value?.libraryRevision
  ],
  (value, previous) => {
    if (value.some((item, index) => previous[index] != null && item !== previous[index]))
      targets.invalidate()
  },
  { flush: 'sync' }
)
const stop = observePersonalRatingsView(view, {
  entityId: () => targetState.value.selected?.id ?? null,
  scope: () => JSON.stringify([props.entityId, props.scope, props.trackContext]),
  snapshot: () => core.state.value
})
watch(
  [
    () => props.compact,
    () => targetState.value.blocked,
    () => state.value.blocked,
    () => targetState.value.loading,
    () => state.value.loading
  ],
  ([compact, targetBlocked, ratingBlocked, targetLoading, ratingLoading]) => {
    if (!compact || targetLoading || ratingLoading || state.value.saving) return
    if ((targetBlocked || ratingBlocked) && state.value.draft === undefined) {
      void refresh()
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  stop()
  view.dispose()
  targets.dispose()
})
async function refresh() {
  const context = JSON.stringify([
    props.entityId,
    props.scope,
    props.trackContext,
    core.state.value?.epoch
  ])
  view.invalidate()
  await targets.refresh()
  if (
    context ===
      JSON.stringify([props.entityId, props.scope, props.trackContext, core.state.value?.epoch]) &&
    targetState.value.selected &&
    !targetState.value.loading &&
    !targetState.value.blocked &&
    !targetState.value.error
  )
    await view.refresh()
}
async function targetPage(offset: number) {
  view.invalidate()
  await targets.page(offset)
}
const selected = computed(() =>
  state.value.draft === undefined ? state.value.detail?.value?.steps : state.value.draft
)
const hoverSteps = ref<number | null>(null)
const displaySteps = computed(() => hoverSteps.value ?? selected.value ?? 0)
function starFillState(starIndex: number): 'full' | 'half' | 'empty' {
  const full = starIndex * 2
  const half = full - 1
  if (displaySteps.value >= full) return 'full'
  if (displaySteps.value >= half) return 'half'
  return 'empty'
}
function chooseStar(steps: number) {
  if (!ready.value) return
  view.choose(steps)
  if (canSave.value) void view.save()
}
function onStarKeydown(event: KeyboardEvent) {
  if (!ready.value) return
  const current = selected.value ?? 0
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault()
    view.choose(Math.min(10, current + 1))
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault()
    view.choose(Math.max(1, (current || 2) - 1))
  } else if (event.key === 'Home') {
    event.preventDefault()
    view.choose(1)
  } else if (event.key === 'End') {
    event.preventDefault()
    view.choose(10)
  }
}
const reasons = {
  set: '设置评分',
  clear: '清除评分',
  identity_carry: '随身份带入',
  identity_current: '采用当前评分',
  identity_clear: '身份合并时清除'
}
const timestamp = (value: number) => new Date(value).toLocaleString()
</script>

<template>
  <section
    class="personal-ratings"
    :class="{ 'is-compact': compact }"
    :aria-label="`${label}评分`"
    :aria-busy="state.loading || state.saving"
  >
    <div class="ratings-main-row">
      <header class="ratings-header">
        <div class="ratings-title-group">
          <h3><span class="compact-hide">{{ label }}</span>评分</h3>
          <span v-if="!compact" class="base-rating-badge">资料评分：暂无资料评分</span>
        </div>
        <button
          v-if="!compact"
          type="button"
          class="ghost-btn"
          :disabled="state.loading || state.saving || targetState.loading"
          @click="refresh()"
        >
          重新读取评分
        </button>
      </header>
      <p v-if="targetState.loading && !compact" role="status" class="status-note">
        正在核对具体评分条目…
      </p>
      <p v-if="targetState.error" role="alert" class="alert-note">{{ targetState.error }}</p>
      <p v-if="targetState.blocked && !compact" role="status" class="status-note">
        曲库已变化，请重新读取具体评分条目。
      </p>
      <p v-if="targetState.page && !targetState.page.total && !compact" class="rating-hint">
        暂无可评分的具体录音或发行条目。
      </p>
      <template v-if="targetState.page && targetState.page.total > 1">
        <p v-if="!compact" class="rating-hint">
          此播放版本包含 {{ targetState.page.total }} 个独立{{
            label
          }}条目，请选择；评分不会合并不同录音或发行，喜欢与禁播也分别保留。
        </p>
        <ul class="rating-targets">
          <li v-for="target in targetState.page.items" :key="target.id">
            <button
              type="button"
              :aria-pressed="targetState.selected?.id === target.id"
              :disabled="state.saving"
              @click="targets.select(target)"
            >
              {{ target.title }} · {{ target.artist }} · {{ target.id }}
            </button>
          </li>
        </ul>
        <nav aria-label="具体评分条目分页">
          <button
            type="button"
            :disabled="state.saving || targetState.page.offset === 0"
            @click="targetPage(Math.max(0, targetState.page.offset - RATING_TARGET_PAGE_SIZE))"
          >
            上一组评分条目</button
          ><button
            type="button"
            :disabled="
              state.saving ||
              targetState.page.offset + targetState.page.items.length >= targetState.page.total
            "
            @click="targetPage(targetState.page.offset + RATING_TARGET_PAGE_SIZE)"
          >
            下一组评分条目
          </button>
        </nav>
      </template>
      <p v-if="state.loading && !compact" role="status" class="status-note">正在读取评分…</p>
      <p v-if="state.saving && !compact" role="status" class="status-note">正在保存并核对评分…</p>
      <p v-if="state.blocked && !compact" role="status" class="status-note">
        评分、身份或曲库已变化，请重新读取评分。
      </p>
      <p v-if="state.error" role="alert" class="alert-note">{{ state.error }}</p>
      <p v-if="state.notice && !compact" role="status" class="status-note">{{ state.notice }}</p>
      <template
        v-if="
          (state.detail && !targetState.loading && !targetState.blocked && !targetState.error) ||
          compact
        "
      >
        <div v-if="state.detail && !compact" class="rating-status-row">
          <p class="saved-rating">已保存：{{ ratingLabel(state.detail.value) }}</p>
          <p class="rating-hint">
            {{
              state.detail.scope === 'identity'
                ? '同一已确认身份共享个人评分。'
                : '仅此曲库条目的个人评分。'
            }}
          </p>
        </div>

        <div
          class="star-interactive-row"
          tabindex="0"
          role="slider"
          :aria-label="`${label}半星滑块`"
          :aria-valuemin="0.5"
          :aria-valuemax="5"
          :aria-valuenow="(selected ?? 0) / 2"
          @mouseleave="hoverSteps = null"
          @keydown="onStarKeydown"
        >
          <div class="star-visual-bar" aria-hidden="true">
            <div
              v-for="star in 5"
              :key="star"
              class="star-unit"
              :data-fill="starFillState(star)"
            >
              <span
                class="star-hit left"
                data-te-interactive
                @mouseenter="ready && (hoverSteps = star * 2 - 1)"
                @click="chooseStar(star * 2 - 1)"
              />
              <span
                class="star-hit right"
                data-te-interactive
                @mouseenter="ready && (hoverSteps = star * 2)"
                @click="chooseStar(star * 2)"
              />
              <svg viewBox="0 0 24 24" class="star-svg">
                <defs>
                  <linearGradient
                    :id="`half-grad-${entityId}-${star}`"
                    x1="0%"
                    y1="0%"
                    x2="100%"
                    y2="0%"
                  >
                    <stop offset="50%" stop-color="currentColor" />
                    <stop offset="50%" stop-color="transparent" />
                  </linearGradient>
                </defs>
                <path
                  class="star-outline"
                  d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.75"
                  stroke-linejoin="round"
                />
                <path
                  v-if="starFillState(star) !== 'empty'"
                  class="star-fill"
                  d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                  :fill="
                    starFillState(star) === 'full'
                      ? 'currentColor'
                      : `url(#half-grad-${entityId}-${star})`
                  "
                />
              </svg>
            </div>
          </div>
          <span v-if="compact" class="compact-rating-value">
            {{ ratingLabel(state.detail?.value) }}
          </span>
          <button
            v-if="compact && state.detail?.value?.steps != null"
            type="button"
            class="compact-clear-btn"
            :disabled="!ready"
            @click="view.clear()"
          >
            清除
          </button>
          <div
            v-if="state.detail"
            class="rating-choices"
            :class="{ 'compact-hide': compact }"
            role="group"
            aria-label="个人评分，半星递增"
          >
            <button
              v-for="steps in 10"
              :key="steps"
              type="button"
              class="step-pill"
              :class="{ 'is-filled': (displaySteps ?? 0) >= steps }"
              :aria-pressed="selected === steps"
              :disabled="!ready"
              @mouseenter="ready && (hoverSteps = steps)"
              @mouseleave="hoverSteps = null"
              @click="view.choose(steps)"
            >
              {{ steps / 2 }} 星
            </button>
          </div>
        </div>

        <template v-if="state.detail && (!compact || state.draft !== undefined)">
          <p v-if="state.draft !== undefined" class="rating-draft">
            未保存草稿：{{ state.draft === null ? '清除评分' : `${state.draft / 2} 星` }}
          </p>
          <div class="rating-actions">
            <button type="button" class="primary-btn" :disabled="!canSave" @click="view.save()">
              保存评分
            </button>
            <button
              type="button"
              :disabled="!ready || state.detail.value?.steps == null"
              @click="view.clear()"
            >
              清除评分
            </button>
            <button
              v-if="state.draft !== undefined"
              type="button"
              :disabled="state.saving"
              @click="view.discardDraft()"
            >
              放弃草稿
            </button>
            <span v-if="!compact" class="clear-rating-note">清除评分不会取消“喜欢”状态</span>
          </div>
        </template>
      </template>
      <p v-else-if="state.draft !== undefined" class="rating-draft">
        保留的草稿：{{ state.draft === null ? '清除评分' : `${state.draft / 2} 星` }}
      </p>
    </div>

    <PersonalPreferencesPanel
      v-if="
        targetState.selected &&
        (!targetState.loading || compact) &&
        (!targetState.blocked || compact) &&
        !targetState.error
      "
      :entity-id="targetState.selected.id"
      :scope="JSON.stringify([entityId, scope, trackContext])"
      :label="label"
      :compact="compact"
    />
    <MusicTagsPanel
      v-if="
        targetState.selected &&
        (!targetState.loading || compact) &&
        (!targetState.blocked || compact) &&
        !targetState.error
      "
      :entity-id="targetState.selected.id"
      :scope="JSON.stringify([entityId, scope, trackContext])"
      :label="label"
      :compact="compact"
    />
    <div v-if="!compact" class="history-footer">
      <button
        type="button"
        class="ghost-btn"
        :disabled="!ready || targetState.blocked || targetState.loading"
        :aria-expanded="state.historyOpened"
        @click="view.toggleHistory()"
      >
        {{ state.historyOpened ? '收起评分历史' : '查看评分历史' }}
      </button>
    </div>
    <template v-if="state.historyOpened && !compact">
      <p v-if="state.historyLoading" role="status" class="status-note">正在读取评分历史…</p>
      <p v-if="state.historyError" role="alert" class="alert-note">
        {{ state.historyError }}
        <button type="button" :disabled="!ready" @click="view.history()">重试评分历史</button>
      </p>
      <p v-if="state.history && !state.history.total" class="rating-hint">暂无评分历史。</p>
      <ol v-if="state.history?.items.length" class="rating-history">
        <li v-for="item in state.history.items" :key="item.seq">
          <span class="history-main">{{ ratingLabel(item) }} · {{ reasons[item.reason] }}</span>
          <time>{{ timestamp(item.updatedAt) }}</time>
        </li>
      </ol>
      <nav
        v-if="state.history && state.history.total > RATINGS_HISTORY_PAGE_SIZE"
        aria-label="评分历史分页"
      >
        <button
          type="button"
          :disabled="!ready || state.historyLoading || state.history.offset === 0"
          @click="view.history(Math.max(0, state.history.offset - RATINGS_HISTORY_PAGE_SIZE))"
        >
          上一页评分
        </button>
        <span
          >{{ state.history.offset + 1 }}–{{ state.history.offset + state.history.items.length }} /
          {{ state.history.total }}</span
        >
        <button
          type="button"
          :disabled="
            !ready ||
            state.historyLoading ||
            state.history.offset + state.history.items.length >= state.history.total
          "
          @click="view.history(state.history.offset + RATINGS_HISTORY_PAGE_SIZE)"
        >
          下一页评分
        </button>
      </nav>
    </template>
  </section>
</template>

<style scoped>
.personal-ratings {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--te-card-border);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.ratings-header,
.rating-choices,
.rating-actions,
.rating-status-row,
nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ratings-header {
  justify-content: space-between;
  margin-bottom: 10px;
}
.ratings-title-group {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
}
h3 {
  margin: 0;
  font-size: 1.05em;
  font-weight: 600;
  color: var(--te-neutral-900);
}
.base-rating-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--te-neutral-500);
  background: color-mix(in srgb, var(--te-neutral-500) 10%, transparent);
}
p {
  margin: 6px 0;
}
.rating-status-row {
  justify-content: space-between;
  margin-bottom: 8px;
}
.saved-rating {
  font-weight: 600;
  color: var(--te-neutral-900);
  margin: 0;
}
.rating-hint,
.clear-rating-note,
time {
  color: var(--te-neutral-500);
  font-size: 12.5px;
}
.status-note {
  font-size: 12.5px;
  color: var(--te-primary-600);
}
.alert-note {
  font-size: 12.5px;
  color: var(--te-danger, #d9534f);
}
.star-interactive-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--te-neutral-500) 6%, transparent);
  border: 1px solid color-mix(in srgb, var(--te-card-border) 70%, transparent);
  margin: 8px 0 10px;
}
.star-interactive-row:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
.star-visual-bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  user-select: none;
}
.star-unit {
  position: relative;
  width: 24px;
  height: 24px;
  color: color-mix(in srgb, var(--te-neutral-500) 40%, transparent);
  transition: transform 0.12s ease, color 0.12s ease;
}
.star-unit[data-fill='full'],
.star-unit[data-fill='half'] {
  color: var(--te-warning, #f59e0b);
}
.star-unit:hover {
  transform: scale(1.08);
}
.star-svg {
  width: 100%;
  height: 100%;
  display: block;
  pointer-events: none;
}
.star-hit {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 50%;
  cursor: pointer;
  z-index: 1;
}
.star-hit.left {
  left: 0;
}
.star-hit.right {
  right: 0;
}
button {
  padding: 5px 10px;
  font: inherit;
  font-size: 12.5px;
  color: var(--te-neutral-800, var(--te-neutral-900));
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.step-pill {
  padding: 3px 8px;
  font-size: 12px;
  border-radius: 999px;
}
.step-pill.is-filled {
  border-color: color-mix(in srgb, var(--te-warning, #f59e0b) 45%, var(--te-card-border));
}
.primary-btn {
  color: var(--te-primary-600);
  border-color: color-mix(in srgb, var(--te-primary-500) 40%, var(--te-card-border));
  background: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
  font-weight: 600;
}
.ghost-btn {
  border-color: transparent;
  color: var(--te-primary-600);
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:not(:disabled):hover,
button[aria-pressed='true'] {
  background: var(--te-hover-bg);
  color: var(--te-primary-600);
  border-color: color-mix(in srgb, var(--te-primary-500) 50%, var(--te-card-border));
}
button:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
.rating-draft {
  display: inline-block;
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
}
.history-footer {
  margin-top: 10px;
}
.rating-history {
  padding-left: 18px;
  margin: 8px 0;
  font-size: 12.5px;
}
.rating-history li {
  margin: 4px 0;
}
.rating-targets {
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
time {
  display: inline-block;
  margin-left: 8px;
}
.personal-ratings.is-compact {
  margin-top: 0;
  padding-top: 0;
  border-top: 0;
  display: grid;
  gap: 10px;
}
.personal-ratings.is-compact .compact-hide {
  display: none;
}
.personal-ratings.is-compact .ratings-main-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 28px;
}
.personal-ratings.is-compact .ratings-header {
  margin: 0;
}
.personal-ratings.is-compact h3 {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--te-neutral-500);
}
.personal-ratings.is-compact .star-interactive-row {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0;
  margin: 0;
  border: 0;
  background: transparent;
}
.personal-ratings.is-compact .star-unit {
  width: 20px;
  height: 20px;
}
.personal-ratings.is-compact .compact-rating-value {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--te-neutral-700);
}
.personal-ratings.is-compact .compact-clear-btn {
  padding: 1px 8px;
  font-size: 11.5px;
  border-radius: 999px;
  color: var(--te-neutral-500);
}
</style>
