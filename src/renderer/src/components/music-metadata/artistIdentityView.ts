import { shallowRef } from 'vue'
import type { CatalogPage, CatalogQuery } from '../../../../shared/musicCatalog.ts'
import type {
  EntityMetadataDetail,
  EntityMetadataLanguage
} from '../../../../shared/entityMetadata.ts'
import type { MusicIdentityDetail } from '../../../../shared/musicIdentification.ts'
import type { ArtistProfileChoice } from './artistProfileChoice.ts'
import { selectArtistProfile } from './artistProfileSelection.ts'

/** Retain recently resolved card metadata across virtual-grid unmounts. */
export function createArtistIdentityCache(now = Date.now) {
  const entries = new Map<
    string,
    { detail: EntityMetadataDetail | null; bytes: number; createdAt: number }
  >()
  let bytes = 0
  return {
    get(key: string): EntityMetadataDetail | null | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      // Remote image grants expire after 24 idle hours; do not pin their handles
      // indefinitely in a renderer that stays open across days.
      if (now() - entry.createdAt >= 60 * 60 * 1000) {
        bytes -= entry.bytes
        return undefined
      }
      entries.set(key, entry)
      return entry.detail
    },
    set(key: string, detail: EntityMetadataDetail | null) {
      bytes -= entries.get(key)?.bytes ?? 0
      entries.delete(key)
      const size =
        ((detail?.manualArtwork?.dataUrl.length ?? 0) +
          (detail?.artwork ?? []).reduce((total, image) => total + image.handle.length, 0)) *
        2
      if (size > 16 * 1024 * 1024) return
      entries.set(key, { detail, bytes: size, createdAt: now() })
      bytes += size
      while (entries.size > 256 || bytes > 16 * 1024 * 1024) {
        const oldest = entries.keys().next().value!
        bytes -= entries.get(oldest)!.bytes
        entries.delete(oldest)
      }
    }
  }
}

const cardCaches = new WeakMap<object, ReturnType<typeof createArtistIdentityCache>>()
export function artistIdentityCache(owner: object) {
  let cache = cardCaches.get(owner)
  if (!cache) {
    cache = createArtistIdentityCache()
    cardCaches.set(owner, cache)
  }
  return cache
}

/** Card data comes from exact collection membership, not a same-name online search. */
export function createArtistIdentityView(api: {
  catalog(query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage>
  detail(
    id: string,
    language: EntityMetadataLanguage,
    signal: AbortSignal,
    shared: boolean
  ): Promise<EntityMetadataDetail>
  identity?(id: string, signal: AbortSignal): Promise<MusicIdentityDetail>
  choice?(name: string): ArtistProfileChoice | null
  cache?: ReturnType<typeof createArtistIdentityCache>
  cacheScope?(): string
  /** Authorization/membership scope; defaults to the cache scope for existing callers. */
  readScope?(): string
}) {
  const detail = shallowRef<EntityMetadataDetail | null>(null)
  let context: { name: string; language: EntityMetadataLanguage } | null = null
  let request: AbortController | null = null
  let pending = false,
    disposed = false
  const cacheKey = (value: NonNullable<typeof context>) =>
    JSON.stringify([api.cacheScope?.(), value.name, value.language, api.choice?.(value.name)])
  const readKey = (value: NonNullable<typeof context>) =>
    JSON.stringify([
      api.readScope ? api.readScope() : api.cacheScope?.(),
      value.name, value.language, api.choice?.(value.name)
    ])
  async function refresh(): Promise<void> {
    if (!context || disposed) return
    if (request) {
      pending = true
      return
    }
    const current = new AbortController(),
      expected = context,
      key = cacheKey(expected),
      scope = readKey(expected)
    request = current
    const publish = (result: EntityMetadataDetail | null) => {
      if (disposed || request !== current || scope !== readKey(expected)) return
      detail.value = result
      // An unrelated content commit must not starve the initial portrait, but
      // only a read completed within its cache revision can be reused on remount.
      if (key === cacheKey(expected)) api.cache?.set(key, result)
    }
    try {
      const query: CatalogQuery = {
        kind: 'artist',
        source: 'local',
        artistName: expected.name,
        limit: 200,
        context: { type: 'collection', collection: 'artists', id: expected.name }
      }
      const page = await api.catalog(query, current.signal)
      current.signal.throwIfAborted()
      const choice = api.choice?.(expected.name)
      const { selected, shared, targetId } = await selectArtistProfile(
        api,
        query,
        page,
        current.signal,
        choice?.entityId
      )
      current.signal.throwIfAborted()
      let result = selected
        ? await api.detail(selected.id, expected.language, current.signal, shared)
        : null
      if (
        (choice &&
          (result?.targetId !== choice.targetId ||
            (choice.targetId && result?.link?.state !== 'confirmed'))) ||
        (shared &&
          (targetId
            ? result?.link?.state !== 'confirmed' || result.targetId !== targetId
            : result?.link?.state === 'confirmed'))
      )
        result = null
      // A personal choice belongs to its selected source entity, not all other
      // same-target sources in this collection.
      if (result && shared) result = { ...result, artworkOverride: null, manualArtwork: null }
      publish(result)
    } catch {
      if (!disposed && request === current) detail.value = null
    } finally {
      if (request === current) {
        request = null
        if (pending) {
          pending = false
          void refresh()
        }
      }
    }
  }
  return {
    detail,
    refresh,
    setContext(name: string | null, language: EntityMetadataLanguage) {
      request?.abort()
      request = null
      pending = false
      detail.value = null
      context = name ? { name, language } : null
      const cached = context ? api.cache?.get(cacheKey(context)) : undefined
      if (cached !== undefined) {
        detail.value = cached
        return Promise.resolve()
      }
      return refresh()
    },
    dispose() {
      disposed = true
      context = null
      request?.abort()
      request = null
      detail.value = null
    }
  }
}

/** Never replace file tags or collection keys with a normalized display name. */
export function artistIdentityPresentation(
  detail: EntityMetadataDetail | null,
  fallback: { name: string; cover?: string | null; coverSource?: string | null },
  now: number,
  failedCovers?: ReadonlySet<string>
) {
  const valid = detail?.link?.state === 'confirmed'
  const name = valid
    ? detail.facts.find(
        (f) =>
          f.field === 'name' &&
          (!f.usage ||
            (f.usage.display &&
              f.usage.cache &&
              f.usage.crossSource &&
              (f.usage.expiresAt === undefined || f.usage.expiresAt > now)))
      )?.value
    : null
  const image = valid
    ? detail.artwork?.find(
        (a) =>
          a.scope === 'artist' &&
          a.usage.display &&
          a.usage.cache &&
          a.usage.crossSource &&
          !failedCovers?.has(a.handle) &&
          (a.usage.expiresAt === undefined || a.usage.expiresAt > now)
      )
    : null
  const fallbackKey = fallback.cover || fallback.coverSource
  const useTrackCover =
    !detail?.artworkOverride && !image && !!fallbackKey &&
    !failedCovers?.has(fallbackKey)
  const manual = detail?.manualArtwork?.dataUrl
  const personalCover = manual && !failedCovers?.has(manual) ? manual : null
  const cover = detail?.artworkOverride
    ? detail.artworkOverride.mode === 'clear'
      ? null
      : personalCover
    : image?.handle ?? (useTrackCover ? fallback.cover ?? null : null)
  return {
    name: name || fallback.name,
    cover,
    coverSource: useTrackCover ? fallback.coverSource ?? null : null,
    attribution: !detail?.artworkOverride && image ? image.attribution : null
  }
}
