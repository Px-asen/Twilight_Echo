<script setup lang="ts">
import { computed, ref } from 'vue'
import { useMusicStore } from '../stores/useMusicStore'
import {
  getMostListenedTracks,
  getTopArtists,
  useListeningStatsStore,
  type ListeningArtistStat
} from '../stores/useListeningStatsStore'
import { usePlayerStore } from '../stores/usePlayerStore'
import { createUnifiedRecentTrackResolver } from '../utils/unifiedRecentTracks'
import CoverImg from './CoverImg.vue'
import type { Track } from '../types/music'

const emit = defineEmits<{
  (event: 'select-view', category: string, filter: string | null): void
  (event: 'open-artist', request: { name: string; providerId: string }): void
}>()

const DEFAULT_COVER = './icon.png'
const ONE_DAY_MS = 24 * 60 * 60 * 1000

const { tracks: libraryTracks, artists: libraryArtists } = useMusicStore()
const { listeningStats } = useListeningStatsStore()
const { currentTrack, playTrack } = usePlayerStore()

const generatedAt = ref(new Date())

function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

/**
 * Anything under a minute stays in seconds. Rounding it up to "1分钟" made a
 * 5-second row and an 85-second row read identically while their bars differed
 * by 17×, which is worse than showing the raw number.
 */
function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0 秒'
  const rounded = Math.round(totalSeconds)
  if (rounded < 60) return `${rounded} 秒`
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  if (hours > 0) return `${hours} 小时${minutes > 0 ? ` ${minutes} 分钟` : ''}`
  return `${minutes} 分钟`
}

/** Compact form for the ranked rows, matching the "11次 · 23分钟" rhythm. */
function formatCompactDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0秒'
  const rounded = Math.round(totalSeconds)
  if (rounded < 60) return `${rounded}秒`
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  if (hours > 0) return `${hours}小时${minutes > 0 ? `${minutes}分钟` : ''}`
  return `${minutes}分钟`
}

function formatShortDate(timestamp: number): string {
  if (!timestamp) return '-'
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/** Share of plays that ran to the end, clamped to a sane percentage. */
function completionRate(completions: number, plays: number): number {
  if (!Number.isFinite(plays) || plays <= 0) return 0
  return Math.max(0, Math.min(100, Math.round(((completions || 0) / plays) * 100)))
}

/** Bar length relative to the list leader, so the widest row always reads 100%. */
function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)))
}

/** Podium spine fades down the list: champion solid, runner-up mid, rest faint. */
function rankAlpha(index: number): number {
  if (index === 0) return 1
  if (index === 1) return 0.45
  return 0.28
}

const trackEntries = computed(() => Object.values(listeningStats.value.tracks))

const totalPlays = computed(() =>
  trackEntries.value.reduce((sum, stat) => sum + (stat.plays || 0), 0)
)

const totalTrackCount = computed(() =>
  trackEntries.value.filter((stat) => (stat.plays || 0) > 0).length
)

const totalSeconds = computed(() =>
  trackEntries.value.reduce((sum, stat) => sum + (stat.seconds || 0), 0)
)

const totalDurationText = computed(() => formatDuration(totalSeconds.value))

const resolvedTracks = computed(() => {
  if (libraryTracks.value.length === 0) return new Map<string, Track>()
  const resolve = createUnifiedRecentTrackResolver(libraryTracks.value)
  const map = new Map<string, Track>()
  for (const stat of getMostListenedTracks(100)) {
    const track = resolve(stat) ?? stat.track ?? null
    if (track) map.set(stat.id, track)
  }
  return map
})

const topTracks = computed(() => {
  return getMostListenedTracks(5).map((stat) => {
    const track = resolvedTracks.value.get(stat.id) ?? stat.track ?? null
    return {
      id: stat.id,
      title: stat.title,
      artist: stat.artist,
      cover: track?.cover ?? stat.cover ?? null,
      coverSource: track?.coverSource ?? stat.coverSource ?? null,
      plays: stat.plays,
      seconds: stat.seconds,
      track
    }
  })
})

const topArtists = computed(() => getTopArtists(5))

const maxTrackSeconds = computed(() =>
  topTracks.value.reduce((max, track) => Math.max(max, track.seconds || 0), 0)
)

const maxArtistSeconds = computed(() =>
  topArtists.value.reduce((max, artist) => Math.max(max, artist.seconds || 0), 0)
)

interface QualityBucket {
  key: string
  label: string
  count: number
  plays: number
}

const qualityBuckets = computed<QualityBucket[]>(() => {
  const buckets = new Map<string, QualityBucket>()
  for (const stat of trackEntries.value) {
    if (!stat.track) continue
    const { sampleRate, bitDepth, bitrate } = stat.track
    let key: string
    let label: string
    if (sampleRate && sampleRate >= 88200 && bitDepth && bitDepth >= 24) {
      key = 'hires'
      label = 'Hi-Res'
    } else if (bitDepth && bitDepth >= 24) {
      key = 'lossless-hd'
      label = '高清无损'
    } else if (
      (sampleRate && sampleRate >= 44100 && bitDepth && bitDepth >= 16) ||
      (bitrate && bitrate >= 1411)
    ) {
      key = 'lossless'
      label = '无损'
    } else {
      key = 'compressed'
      label = '有损压缩'
    }
    const existing = buckets.get(key)
    if (existing) {
      existing.count += 1
      existing.plays += stat.plays
    } else {
      buckets.set(key, { key, label, count: 1, plays: stat.plays })
    }
  }
  return Array.from(buckets.values()).sort((a, b) => b.count - a.count)
})

interface FormatBucket {
  format: string
  count: number
  plays: number
}

const formatDistribution = computed<FormatBucket[]>(() => {
  const map = new Map<string, FormatBucket>()
  for (const stat of trackEntries.value) {
    const format = (stat.track?.format || '未知').toLowerCase()
    const existing = map.get(format)
    if (existing) {
      existing.count += 1
      existing.plays += stat.plays
    } else {
      map.set(format, { format, count: 1, plays: stat.plays })
    }
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count)
})

const formatSummary = computed(() => {
  const [first, second] = formatDistribution.value
  if (!first) return '0 / 0'
  if (!second) return `${formatNumber(first.count)} / -`
  return `${formatNumber(first.count)} / ${formatNumber(second.count)}`
})

/** Weekday rail, Monday-first. Only odd rows are labelled, as in the reference wall. */
const WEEKDAY_RAIL = ['一', '', '三', '', '五', '', ''] as const

interface WallDay {
  key: string
  date: Date
  seconds: number
  level: number
  isFuture: boolean
  isToday: boolean
  inRange: boolean
}

interface WallWeek {
  key: string
  days: WallDay[]
}

const now = computed(() => new Date())

/**
 * The stats store buckets by UTC calendar day (`toISOString().slice(0, 10)`), so
 * the wall walks UTC days too — anything else drifts the lookup by one day for
 * users east of Greenwich.
 */
function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function utcToday(): Date {
  const source = now.value
  return new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()))
}

function shiftUtcDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

/** Monday-first index, 0 = Monday … 6 = Sunday. */
function mondayOffset(date: Date): number {
  return (date.getUTCDay() + 6) % 7
}

function dayLevel(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  const minutes = seconds / 60
  if (minutes >= 120) return 4
  if (minutes >= 60) return 3
  if (minutes >= 30) return 2
  return 1
}

const wallWeeks = computed<WallWeek[]>(() => {
  const today = utcToday()
  const rangeStart = shiftUtcDays(today, -(364 + mondayOffset(today)))
  const totalDays = 364 + mondayOffset(today)
  const weeks: WallWeek[] = []
  for (let weekIndex = 0; weekIndex * 7 <= totalDays; weekIndex += 1) {
    const days: WallDay[] = []
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = shiftUtcDays(rangeStart, weekIndex * 7 + dayIndex)
      const isFuture = date.getTime() > today.getTime()
      const key = utcDayKey(date)
      const seconds = isFuture ? 0 : listeningStats.value.days[key] || 0
      days.push({
        key,
        date,
        seconds,
        level: isFuture ? 0 : dayLevel(seconds),
        isFuture,
        isToday: date.getTime() === today.getTime(),
        inRange: !isFuture
      })
    }
    weeks.push({ key: days[0].key, days })
  }
  return weeks
})

const wallMonthLabels = computed(() => {
  const labels: Array<{ key: string; label: string; index: number }> = []
  let lastMonth = -1
  wallWeeks.value.forEach((week, index) => {
    const first = week.days.find((day) => day.inRange)
    if (!first) return
    const month = first.date.getUTCMonth()
    if (month === lastMonth) return
    lastMonth = month
    labels.push({
      key: `${first.date.getUTCFullYear()}-${month}`,
      label: `${month + 1}月`,
      index
    })
  })
  return labels
})

const yearStats = computed(() => {
  const today = now.value
  const cutoff = today.getTime() - 365 * ONE_DAY_MS
  let yearPlays = 0
  let activeDays = 0
  let maxDaySeconds = 0
  let maxDayKey = ''
  let longestStreak = 0
  let currentStreak = 0
  const sortedDays = Object.entries(listeningStats.value.days)
    .filter(([key, seconds]) => {
      const time = new Date(key).getTime()
      return time >= cutoff && time <= today.getTime() && seconds > 0
    })
    .sort(([a], [b]) => a.localeCompare(b))
  for (const [dayKey, seconds] of sortedDays) {
    yearPlays += Math.max(0, Math.round(seconds / 180))
    activeDays += 1
    if (seconds > maxDaySeconds) {
      maxDaySeconds = seconds
      maxDayKey = dayKey
    }
  }
  let previousKey = ''
  for (const [key] of sortedDays) {
    if (previousKey) {
      const prevDate = new Date(previousKey)
      const currDate = new Date(key)
      const diffDays = Math.round((currDate.getTime() - prevDate.getTime()) / ONE_DAY_MS)
      if (diffDays === 1) {
        currentStreak += 1
      } else {
        longestStreak = Math.max(longestStreak, currentStreak)
        currentStreak = 1
      }
    } else {
      currentStreak = 1
    }
    previousKey = key
  }
  longestStreak = Math.max(longestStreak, currentStreak)
  const avg = activeDays > 0 ? yearPlays / activeDays : 0
  return {
    yearPlays,
    activeDays,
    totalDays: wallWeeks.value.length * 7,
    maxDayKey,
    maxDaySeconds,
    longestStreak,
    avgPerActiveDay: Math.round(avg)
  }
})

function cellTitle(cell: WallDay): string {
  const dateText = `${cell.date.getUTCMonth() + 1}月${cell.date.getUTCDate()}日`
  if (cell.seconds <= 0) return dateText
  return `${dateText} · ${formatDuration(cell.seconds)}`
}

/**
 * The artist rollup only carries track ids, so the owning provider has to come
 * from the underlying track stats.
 */
function resolveArtistProvider(artistName: string): string | null {
  for (const stat of Object.values(listeningStats.value.tracks)) {
    if ((stat.artist || '').trim() !== artistName) continue
    const provider = stat.sourceIds?.find(
      (entry) => entry.source && entry.source !== 'local'
    )?.source
    if (provider) return provider
  }
  return null
}

/**
 * Mirrors the player bar's artist click. The library page matches on the exact
 * artist string (`artist:<name>`), so the raw display name is the only value
 * that resolves; anything not in the local library belongs to a streaming
 * provider and is handed off to that surface instead of opening an empty page.
 */
function openArtist(artist: ListeningArtistStat): void {
  const name = artist.name.trim()
  if (!name) return
  if (libraryArtists.value.some((item) => item.name === name)) {
    emit('select-view', 'artists', `artist:${name}`)
    return
  }
  const providerId = resolveArtistProvider(name)
  if (!providerId) return
  emit('open-artist', { name, providerId })
}

function playDashboardTrack(track: Track | null | undefined): void {
  if (!track) return
  const sourceIndex = libraryTracks.value.findIndex((item) => item.id === track.id)
  if (sourceIndex < 0) {
    playTrack(track, [track])
    return
  }
  const windowSize = 200
  const halfWindow = Math.floor(windowSize / 2)
  const start = Math.max(0, sourceIndex - halfWindow)
  const end = Math.min(libraryTracks.value.length, start + windowSize)
  const queueStart = Math.max(0, end - windowSize)
  playTrack(track, libraryTracks.value.slice(queueStart, end))
}

function emptyText(title: string): string {
  const map: Record<string, string> = {
    '最常听曲目': '暂无曲目统计',
    '最常听艺人': '暂无艺人统计',
    '音质使用': '暂无音质数据',
    '格式分布': '暂无格式数据'
  }
  return map[title] || '暂无数据'
}
</script>

<template>
  <main class="analytics-page">
    <header class="analytics-head">
      <div class="analytics-identity">
        <span class="analytics-kicker">LISTENING ANALYTICS</span>
        <h1 class="analytics-title">播放统计仪表盘</h1>
      </div>
      <time class="analytics-generated" :datetime="generatedAt.toISOString()">
        生成于 {{ generatedAt.getMonth() + 1 }}月{{ generatedAt.getDate() }}日
        {{ String(generatedAt.getHours()).padStart(2, '0') }}:{{
          String(generatedAt.getMinutes()).padStart(2, '0')
        }}
      </time>
    </header>

    <section class="analytics-summary">
      <article class="summary-card">
        <div class="summary-top">
          <span class="summary-value">{{ formatNumber(totalPlays) }}</span>
          <span class="summary-unit">次</span>
        </div>
        <span class="summary-caption">累计播放</span>
      </article>
      <article class="summary-card">
        <div class="summary-top">
          <span class="summary-value">{{ formatNumber(totalTrackCount) }}</span>
          <span class="summary-unit">首</span>
        </div>
        <span class="summary-caption">已播曲目</span>
      </article>
      <article class="summary-card">
        <div class="summary-top">
          <span class="summary-value">{{ totalDurationText }}</span>
        </div>
        <span class="summary-caption">聆听时长</span>
      </article>
      <article class="summary-card">
        <div class="summary-top">
          <span class="summary-value">{{ formatSummary }}</span>
        </div>
        <span class="summary-caption">格式分布</span>
      </article>
    </section>

    <section class="analytics-cards">
      <article class="detail-card">
        <header class="detail-card-head">
          <i class="ph ph-music-notes" aria-hidden="true"></i>
          <h3>最常听曲目</h3>
        </header>
        <ul v-if="topTracks.length > 0" class="detail-list">
          <li
            v-for="track in topTracks"
            :key="track.id"
            class="detail-row"
            :class="{ 'is-current': currentTrack?.id && track.track?.id === currentTrack.id }"
            @click="playDashboardTrack(track.track)"
          >
            <CoverImg
              class="detail-cover"
              :cover="track.cover"
              :cover-source="track.coverSource"
              :identity="track.track?.id ?? track.id"
              :fallback="DEFAULT_COVER"
              :alt="track.title"
            />
            <div class="detail-meta">
              <span class="detail-name">{{ track.title }}</span>
              <span class="detail-sub">{{ track.artist }}</span>
              <span class="detail-bar" aria-hidden="true">
                <span :style="{ width: barPercent(track.seconds, maxTrackSeconds) + '%' }"></span>
              </span>
            </div>
            <span class="detail-stat">{{ track.plays }} 次</span>
          </li>
        </ul>
        <p v-else class="detail-empty">{{ emptyText('最常听曲目') }}</p>
      </article>

      <article class="detail-card">
        <header class="detail-card-head">
          <i class="ph ph-microphone-stage" aria-hidden="true"></i>
          <h3>最常听艺人</h3>
        </header>
        <ul v-if="topArtists.length > 0" class="rank-list">
          <li
            v-for="(artist, index) in topArtists"
            :key="artist.id"
            class="rank-row"
            :class="{ 'is-champion': index === 0 }"
            :style="{ '--rank-alpha': rankAlpha(index) }"
            @click="openArtist(artist)"
          >
            <span class="rank-spine" aria-hidden="true"></span>
            <span class="rank-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <CoverImg
              class="rank-cover"
              :cover="artist.cover"
              :cover-source="artist.coverSource ?? null"
              :identity="artist.id"
              :fallback="DEFAULT_COVER"
              :alt="artist.name"
            />
            <div class="rank-body">
              <span class="rank-name">{{ artist.name }}</span>
              <span class="rank-sub"
                >{{ artist.plays }}次 · {{ formatCompactDuration(artist.seconds) }}</span
              >
              <span class="rank-bar" aria-hidden="true">
                <span
                  :style="{ width: barPercent(artist.seconds, maxArtistSeconds) + '%' }"
                ></span>
              </span>
            </div>
            <span class="rank-pill">{{ completionRate(artist.completions, artist.plays) }}% 完播</span>
          </li>
        </ul>
        <p v-else class="detail-empty">{{ emptyText('最常听艺人') }}</p>
      </article>

      <article class="detail-card">
        <header class="detail-card-head">
          <i class="ph ph-speaker-hifi" aria-hidden="true"></i>
          <h3>音质使用</h3>
        </header>
        <ul v-if="qualityBuckets.length > 0" class="detail-list">
          <li v-for="bucket in qualityBuckets" :key="bucket.key" class="detail-row is-static">
            <span class="detail-avatar">{{ bucket.label.slice(0, 2) }}</span>
            <div class="detail-meta">
              <span class="detail-name">{{ bucket.label }}</span>
              <span class="detail-sub">{{ bucket.count }} 首</span>
            </div>
            <span class="detail-stat">{{ bucket.plays }} 次</span>
          </li>
        </ul>
        <p v-else class="detail-empty">{{ emptyText('音质使用') }}</p>
      </article>

      <article class="detail-card">
        <header class="detail-card-head">
          <i class="ph ph-vinyl-record" aria-hidden="true"></i>
          <h3>格式分布</h3>
        </header>
        <ul v-if="formatDistribution.length > 0" class="detail-list">
          <li
            v-for="bucket in formatDistribution"
            :key="bucket.format"
            class="detail-row is-static"
          >
            <span class="detail-avatar format-avatar">{{ bucket.format.toUpperCase() }}</span>
            <div class="detail-meta">
              <span class="detail-name">{{ bucket.format.toUpperCase() }}</span>
              <span class="detail-sub">{{ bucket.count }} 首</span>
            </div>
            <span class="detail-stat">{{ bucket.plays }} 次</span>
          </li>
        </ul>
        <p v-else class="detail-empty">{{ emptyText('格式分布') }}</p>
      </article>
    </section>

    <section class="analytics-heatmap">
      <header class="heatmap-head">
        <div class="heatmap-title">
          <i class="ph ph-calendar-blank" aria-hidden="true"></i>
          <h2>近一年播放墙</h2>
        </div>
        <span class="heatmap-subtitle"
          >{{ formatNumber(yearStats.yearPlays) }} 次播放 · 近一年</span
        >
      </header>

      <div class="wall-scroll">
        <div class="wall-inner">
          <div class="wall-rail-spacer" aria-hidden="true"></div>
          <div
            class="wall-months"
            :style="{ '--wall-weeks': wallWeeks.length }"
            aria-hidden="true"
          >
            <span
              v-for="month in wallMonthLabels"
              :key="month.key"
              class="wall-month-label"
              :style="{ gridColumn: month.index + 1 }"
              >{{ month.label }}</span
            >
          </div>

          <div class="wall-weekdays" aria-hidden="true">
            <span v-for="(label, index) in WEEKDAY_RAIL" :key="index">{{ label }}</span>
          </div>
          <div class="wall-grid" :style="{ '--wall-weeks': wallWeeks.length }">
            <template v-for="week in wallWeeks" :key="week.key">
              <span
                v-for="cell in week.days"
                :key="cell.key"
                class="wall-cell"
                :class="[
                  `lv-${cell.level}`,
                  { 'is-future': cell.isFuture, 'is-today': cell.isToday }
                ]"
                :title="cellTitle(cell)"
              ></span>
            </template>
          </div>
        </div>
      </div>

      <footer class="heatmap-foot">
        <div class="heatmap-stat">
          <span class="heatmap-stat-label">最热一天</span>
          <span class="heatmap-stat-value">
            {{
              yearStats.maxDayKey
                ? `${formatShortDate(new Date(yearStats.maxDayKey).getTime())} · ${formatDuration(yearStats.maxDaySeconds)}`
                : '-'
            }}
          </span>
        </div>
        <div class="heatmap-stat">
          <span class="heatmap-stat-label">最长连续</span>
          <span class="heatmap-stat-value">{{ yearStats.longestStreak }} 天</span>
        </div>
        <div class="heatmap-stat">
          <span class="heatmap-stat-label">活跃天数</span>
          <span class="heatmap-stat-value">{{ yearStats.activeDays }} / {{ yearStats.totalDays }}</span>
        </div>
        <div class="heatmap-stat">
          <span class="heatmap-stat-label">活跃日均</span>
          <span class="heatmap-stat-value">{{ formatNumber(yearStats.avgPerActiveDay) }} 次</span>
        </div>
        <div class="heatmap-legend">
          <span>少</span>
          <i v-for="level in 5" :key="level" :class="`lv-${level - 1}`"></i>
          <span>多</span>
        </div>
      </footer>
    </section>
  </main>
</template>

<style scoped src="./ListeningAnalyticsPage.css"></style>
