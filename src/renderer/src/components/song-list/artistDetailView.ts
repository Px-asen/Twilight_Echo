import { shallowRef } from 'vue'
import type { CatalogEntity, CatalogPage, CatalogQuery } from '../../../../shared/musicCatalog.ts'
import type {
  EntityMetadataDetail,
  EntityMetadataFact,
  EntityMetadataLanguage
} from '../../../../shared/entityMetadata.ts'
import { selectMetadataIntroduction } from '../../../../shared/metadataProviders.ts'
import type { MusicIdentityDetail } from '../../../../shared/musicIdentification.ts'
import type { EntityMetadataReadApi } from '../music-metadata/entityMetadataView.ts'
import { artistIdentityPresentation } from '../music-metadata/artistIdentityView.ts'
import type { ArtistProfileChoice } from '../music-metadata/artistProfileChoice.ts'
import { selectArtistProfile } from '../music-metadata/artistProfileSelection.ts'

export const ARTIST_REFERENCE_PAGE_SIZE = 6
export type ArtistSection = 'overview' | 'albums' | 'songs' | 'participation' | 'identity'
interface ArtistDetailState {
  page: CatalogPage | null
  samples: Record<string, string>
  identities: Record<string, MusicIdentityDetail>
  selected: CatalogEntity | null
  detail: EntityMetadataDetail | null
  shared: boolean
  exact: boolean
  /** Only a foreground read may replace controls with their loading state. */
  loading: boolean
  refreshing: boolean
  error: string
}
const empty = (): ArtistDetailState => ({
  page: null,
  samples: {},
  identities: {},
  selected: null,
  detail: null,
  shared: false,
  exact: true,
  loading: false,
  refreshing: false,
  error: ''
})

/** One read owner for the hero, biography, participation anchor and source-scoped editors. */
export function createArtistDetailView(
  api: Omit<EntityMetadataReadApi, 'detail'> & {
    identity(id: string, signal: AbortSignal): Promise<MusicIdentityDetail>
    choice?(name: string): ArtistProfileChoice | null
    detail(
      id: string,
      language: EntityMetadataLanguage,
      sourceProvider: string,
      signal: AbortSignal,
      includeAutomaticArtwork: boolean
    ): Promise<EntityMetadataDetail>
  }
) {
  const state = shallowRef<ArtistDetailState>(empty())
  let context: { name: string; language: EntityMetadataLanguage } | null = null
  let request: AbortController | null = null
  let choice: string | null = null,
    offset = 0,
    pending = false,
    disposed = false
  const waiting: Array<() => void> = []
  async function refresh(withdraw = false): Promise<void> {
    if (!context || disposed) return
    if (withdraw) {
      request?.abort()
      request = null
      state.value = empty()
    }
    if (request) {
      pending = true
      await new Promise<void>((resolve) => waiting.push(resolve))
      return
    }
    const controller = new AbortController(),
      expected = context
    request = controller
    const current = () => !disposed && request === controller && !controller.signal.aborted
    const painted = !!state.value.page
    state.value = { ...state.value, loading: !painted, refreshing: painted, error: '' }
    try {
      const base: CatalogQuery = {
        kind: 'artist',
        source: 'local',
        artistName: expected.name,
        context: { type: 'collection', collection: 'artists', id: expected.name },
        limit: 200
      }
      let first = await api.catalog(base, controller.signal)
      if (!current()) return
      const exact = first.total > 0
      if (!exact) {
        delete base.artistName
        first = await api.catalog(base, controller.signal)
      }
      if (!current()) return
      // Legacy composite collections may contain collaborators, not same-name
      // profile candidates. Only exact membership can choose a representative.
      let profile =
        exact || choice
          ? await selectArtistProfile(api, base, first, controller.signal, choice)
          : { selected: null, shared: false, targetId: undefined }
      if (!current()) return
      // A source being reviewed can leave the collection during a library update.
      // Resume the automatic profile without requiring a second refresh.
      if (choice && !profile.selected && api.choice?.(expected.name)?.entityId !== choice) {
        choice = null
        if (exact) profile = await selectArtistProfile(api, base, first, controller.signal)
      }
      const { selected, shared, targetId } = profile
      if (choice && !selected) choice = null
      offset = offset < first.total ? offset : 0
      const references =
        offset === 0
          ? { ...first, items: first.items.slice(0, ARTIST_REFERENCE_PAGE_SIZE) }
          : await api.catalog(
              { ...base, offset, limit: ARTIST_REFERENCE_PAGE_SIZE, revision: first.revision },
              controller.signal
            )
      if (references.revision !== first.revision || references.total !== first.total)
        throw new Error('人物引用已变化，请重新读取')
      const entities = [...references.items]
      if (selected && !entities.some((item) => item.id === selected.id)) entities.push(selected)
      const entries = await Promise.all(
        entities.map(async (entity) => {
          const [sourcePage, identity] = await Promise.all([
            api.sources(
              { entityId: entity.id, revision: first.revision, limit: 1 },
              controller.signal
            ),
            api.identity(entity.id, controller.signal)
          ])
          const source = sourcePage.items[0]
          return {
            id: entity.id,
            identity,
            sample: source
              ? [source.track.title, source.track.album].filter(Boolean).join(' · ')
              : ''
          }
        })
      )
      const samples = Object.fromEntries(entries.map((entry) => [entry.id, entry.sample]))
      const identities = Object.fromEntries(entries.map((entry) => [entry.id, entry.identity]))
      const detail = selected
        ? await api.detail(selected.id, expected.language, 'local', controller.signal, shared)
        : null
      if (!current()) return
      const saved = api.choice?.(expected.name)
      if (
        saved &&
        selected?.id === saved.entityId &&
        (detail?.targetId !== saved.targetId ||
          (saved.targetId && detail?.link?.state !== 'confirmed'))
      ) {
        choice = null
        throw Object.assign(new Error('已保存的人物身份已变化，请恢复自动选择'), {
          code: 'STALE_IDENTITY'
        })
      }
      if (
        shared &&
        (targetId
          ? detail?.link?.state !== 'confirmed' || detail.targetId !== targetId
          : detail?.link?.state === 'confirmed')
      )
        throw Object.assign(new Error('人物身份已变化，请重新读取'), { code: 'STALE_IDENTITY' })
      state.value = {
        page: references,
        samples,
        identities,
        selected,
        detail,
        shared,
        exact,
        loading: false,
        refreshing: false,
        error: ''
      }
    } catch (error) {
      if (current()) {
        // A temporary read failure must not unmount the source's open editors.
        // Changed identity and permission scopes still withdraw old content.
        const retain = painted && (error as { code?: string })?.code !== 'STALE_IDENTITY'
        state.value = {
          ...(retain ? state.value : empty()),
          loading: false,
          refreshing: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    } finally {
      if (request === controller) {
        request = null
        if (pending) {
          pending = false
          await refresh()
        } else waiting.splice(0).forEach((resolve) => resolve())
      }
    }
  }
  function cancel() {
    request?.abort()
    request = null
    pending = false
    waiting.splice(0).forEach((resolve) => resolve())
  }
  return {
    state,
    refresh,
    setContext(name: string | null, language: EntityMetadataLanguage) {
      cancel()
      choice = name ? (api.choice?.(name)?.entityId ?? null) : null
      offset = 0
      context = name ? { name, language } : null
      state.value = empty()
      return refresh()
    },
    select(entity: CatalogEntity) {
      cancel()
      choice = entity.id
      state.value = { ...state.value, detail: null, selected: null }
      return refresh()
    },
    page(next: number) {
      offset = Math.max(0, next)
      return refresh()
    },
    dispose() {
      disposed = true
      context = null
      cancel()
      state.value = empty()
    }
  }
}

function permitted(fact: EntityMetadataFact, now: number, shared: boolean) {
  return (
    !fact.usage ||
    (fact.usage.display &&
      fact.usage.cache &&
      (!shared || fact.usage.crossSource) &&
      (fact.usage.expiresAt === undefined || fact.usage.expiresAt > now))
  )
}

/** Personal overrides never become the biography or picture of a whole collection. */
export function artistDetailPresentation(
  detail: EntityMetadataDetail | null,
  shared: boolean,
  name: string,
  language: EntityMetadataLanguage,
  now: number
) {
  const confirmed = detail?.link?.state === 'confirmed'
  const facts = confirmed ? detail.facts.filter((fact) => permitted(fact, now, shared)) : []
  let introduction = detail?.introduction ?? null
  if (shared) {
    const texts = facts.filter((fact) => !fact.sourceProvider || fact.usage?.crossSource)
    const selected = selectMetadataIntroduction(texts, language, true)
    introduction = selected
      ? {
          value: selected.value,
          language: selected.language,
          origin: 'external',
          attribution: selected.attribution
        }
      : null
  } else if (
    introduction?.origin === 'external' &&
    !facts.some(
      (fact) =>
        fact.value === introduction?.value &&
        fact.attribution.provider === introduction.attribution?.provider &&
        fact.attribution.revision === introduction.attribution?.revision
    )
  )
    introduction = null
  const projected = detail
    ? { ...detail, facts, ...(shared ? { artworkOverride: null, manualArtwork: null } : {}) }
    : null
  return {
    ...artistIdentityPresentation(projected, { name }, now),
    introduction,
    country: facts.find((fact) => fact.field === 'country') ?? null,
    hiddenIntroduction: !shared && detail?.override?.mode === 'clear',
    hiddenImage: !shared && detail?.artworkOverride?.mode === 'clear'
  }
}
