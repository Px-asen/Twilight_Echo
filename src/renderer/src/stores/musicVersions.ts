import { computed, readonly, ref, shallowRef } from 'vue'
import {
  emptyMusicVersions,
  parseMusicVersions,
  type MusicVersionsDocument,
  type VersionScope
} from '@renderer/utils/musicVersions.ts'

const STORAGE_KEY = 'twilight.music-versions.v1'
const state = shallowRef<MusicVersionsDocument>(emptyMusicVersions())
const revision = ref(0)
const error = ref('')
let loaded = false
let storedRaw: string | null = null

export function loadMusicVersions(): void {
  if (typeof localStorage === 'undefined') return
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    state.value = parseMusicVersions(raw)
    storedRaw = raw
    loaded = true
    revision.value++
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取版本记录'
  }
}

export function getMusicVersions(): MusicVersionsDocument {
  if (!loaded && typeof localStorage !== 'undefined' && !error.value) loadMusicVersions()
  return state.value
}

const indexes = computed(() => {
  const document = getMusicVersions()
  return {
    tracks: new Map(
      document.tracks.versions.flatMap((version) =>
        version.sources.map((source) => [source, version] as const)
      )
    ),
    albums: new Map(
      document.albums.versions.flatMap((version) =>
        version.sources.map((source) => [source, version] as const)
      )
    )
  }
})

export function sourceVersion(scope: VersionScope, key: string) {
  return indexes.value[scope].get(key)
}

export function saveMusicVersions(
  next: MusicVersionsDocument,
  expected: MusicVersionsDocument
): void {
  if (error.value) throw new Error('请先重新读取版本记录，避免覆盖无法读取的数据')
  if (state.value !== expected) throw new Error('版本记录已变化，请重新预览')
  if (localStorage.getItem(STORAGE_KEY) !== storedRaw) {
    loadMusicVersions()
    throw new Error('其他窗口已修改版本记录，请重新预览')
  }
  const raw = JSON.stringify(next)
  const validated = parseMusicVersions(raw)
  localStorage.setItem(STORAGE_KEY, raw)
  storedRaw = raw
  state.value = validated
  revision.value++
}

export const musicVersionRevision = readonly(revision)
export const musicVersionError = readonly(error)

if (typeof window !== 'undefined')
  window.addEventListener?.('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) loadMusicVersions()
  })
