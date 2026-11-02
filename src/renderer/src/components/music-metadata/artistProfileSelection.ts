import type { CatalogEntity, CatalogPage, CatalogQuery } from '../../../../shared/musicCatalog.ts'
import type { MusicIdentityDetail } from '../../../../shared/musicIdentification.ts'

interface ArtistProfileSelection {
  selected: CatalogEntity | null
  shared: boolean
  /** Undefined for an explicit source or a single member, read directly from metadata. */
  targetId?: string | null
}
interface ConfirmedProfile {
  entity: CatalogEntity
  strength: number
  members: number
  sources: number
}
const sourceOrder = (a: CatalogEntity, b: CatalogEntity) =>
  b.sourceCount - a.sourceCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const profileOrder = (a: ConfirmedProfile, b: ConfirmedProfile) =>
  b.strength - a.strength ||
  b.members - a.members ||
  b.sources - a.sources ||
  sourceOrder(a.entity, b.entity)

/**
 * Choose display metadata, never confirm or merge identities. There is no numeric
 * confidence in the catalog: explicit confirmation outranks automatic proof,
 * then legacy confirmation; agreement and source coverage break ties.
 */
export async function selectArtistProfile(
  api: {
    catalog(query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage>
    identity?(id: string, signal: AbortSignal): Promise<MusicIdentityDetail>
  },
  query: CatalogQuery,
  first: CatalogPage,
  signal: AbortSignal,
  preferred: string | null = null
): Promise<ArtistProfileSelection> {
  const none = { selected: null, shared: false }
  if (!first.total) return none
  if (!preferred && first.total === 1 && first.items.length === 1)
    return { selected: first.items[0], shared: false }
  if (!preferred && !api.identity) return none

  const profiles = new Map<string, ConfirmedProfile>()
  let page = first,
    count = 0,
    fallback: CatalogEntity | null = null
  while (page.items.length) {
    signal.throwIfAborted()
    if (preferred) {
      const selected = page.items.find((item) => item.id === preferred)
      if (selected) return { selected, shared: false }
    } else {
      for (let i = 0; i < page.items.length; i += 8) {
        const entities = page.items.slice(i, i + 8)
        const identities = await Promise.all(entities.map((item) => api.identity!(item.id, signal)))
        signal.throwIfAborted()
        for (const [index, entity] of entities.entries()) {
          if (!fallback || sourceOrder(entity, fallback) < 0) fallback = entity
          const link = identities[index].link
          if (link?.state !== 'confirmed' || !link.targetId) continue
          const strength =
            link.confirmation?.mode === 'manual'
              ? 3
              : link.confirmation?.mode === 'automatic'
                ? 2
                : 1
          const profile = profiles.get(link.targetId)
          if (!profile) {
            profiles.set(link.targetId, {
              entity,
              strength,
              members: 1,
              sources: entity.sourceCount
            })
            continue
          }
          if (
            strength > profile.strength ||
            (strength === profile.strength && sourceOrder(entity, profile.entity) < 0)
          )
            profile.entity = entity
          profile.strength = Math.max(profile.strength, strength)
          profile.members++
          profile.sources += entity.sourceCount
        }
      }
    }
    count += page.items.length
    if (count >= first.total) break
    page = await api.catalog({ ...query, offset: count, revision: first.revision }, signal)
    if (page.total !== first.total || page.revision !== first.revision)
      throw new Error('人物引用已变化，请重新读取')
  }
  if (count !== first.total) throw new Error('人物引用不完整，请重新读取')
  if (preferred) return none
  const winner = [...profiles].sort(([, a], [, b]) => profileOrder(a, b))[0]
  // With no confirmed person, retain an editor anchor but publish no shared facts.
  return { selected: winner?.[1].entity ?? fallback, targetId: winner?.[0] ?? null, shared: true }
}
