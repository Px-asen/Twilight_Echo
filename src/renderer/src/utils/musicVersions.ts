export type VersionScope = 'tracks' | 'albums'
export interface MusicVersion {
  id: string
  label: string
  sources: string[]
  preferredSource: string | null
}
export interface VersionFamily {
  id: string
  versions: string[]
  preferredVersion: string | null
}
export interface VersionDomain {
  versions: MusicVersion[]
  families: VersionFamily[]
}
export interface MusicVersionsDocument {
  version: 1
  tracks: VersionDomain
  albums: VersionDomain
}
export type VersionOperation =
  | 'sources'
  | 'family'
  | 'split'
  | 'reset'
  | 'label'
  | 'prefer-source'
  | 'prefer-version'
  | 'clear-preference'

export function emptyMusicVersions(): MusicVersionsDocument {
  return {
    version: 1,
    tracks: { versions: [], families: [] },
    albums: { versions: [], families: [] }
  }
}

export function parseMusicVersions(raw: string | null): MusicVersionsDocument {
  if (!raw) return emptyMusicVersions()
  if (raw.length > 8 * 1024 * 1024) throw new Error('版本记录超过 8 MiB')
  const value = JSON.parse(raw) as MusicVersionsDocument
  if (!value || value.version !== 1) throw new Error('不支持的版本记录格式')
  for (const scope of ['tracks', 'albums'] as const) {
    const domain = value[scope]
    if (
      !domain ||
      !Array.isArray(domain.versions) ||
      !Array.isArray(domain.families) ||
      domain.versions.length > 20000
    )
      throw new Error('版本记录结构无效')
    const ids = new Set<string>(),
      sources = new Set<string>()
    for (const version of domain.versions) {
      if (
        !version ||
        typeof version.id !== 'string' ||
        !version.id ||
        ids.has(version.id) ||
        typeof version.label !== 'string' ||
        version.label.length > 100 ||
        !Array.isArray(version.sources) ||
        !version.sources.length
      )
        throw new Error('版本信息无效')
      ids.add(version.id)
      for (const source of version.sources) {
        if (typeof source !== 'string' || !source || source.length > 8192 || sources.has(source))
          throw new Error('来源身份重复或无效')
        sources.add(source)
      }
      if (version.preferredSource !== null && !version.sources.includes(version.preferredSource))
        throw new Error('偏好来源不属于该版本')
    }
    if (sources.size > 40000) throw new Error('版本来源超过 40,000 项')
    const familyIds = new Set<string>(),
      assigned = new Set<string>()
    for (const family of domain.families) {
      if (
        !family ||
        typeof family.id !== 'string' ||
        !family.id ||
        familyIds.has(family.id) ||
        !Array.isArray(family.versions) ||
        family.versions.length < 2
      )
        throw new Error('版本集合无效')
      familyIds.add(family.id)
      for (const id of family.versions) {
        if (!ids.has(id) || assigned.has(id)) throw new Error('版本集合引用无效')
        assigned.add(id)
      }
      if (family.preferredVersion !== null && !family.versions.includes(family.preferredVersion))
        throw new Error('偏好版本不属于该集合')
    }
  }
  return value
}

export function editMusicVersions(
  document: MusicVersionsDocument,
  scope: VersionScope,
  operation: VersionOperation,
  keys: string[],
  label: string,
  newId: () => string = () => crypto.randomUUID()
): MusicVersionsDocument {
  const selected = [...new Set(keys)]
  if (!selected.length) throw new Error('请先选择来源')
  if (label.trim().length > 100) throw new Error('版本标签最多 100 字')
  if (['sources', 'family'].includes(operation) && selected.length < 2)
    throw new Error('请至少选择两个来源或版本')
  if (
    ['label', 'prefer-source', 'prefer-version', 'clear-preference'].includes(operation) &&
    selected.length !== 1
  )
    throw new Error('此操作只选择一个来源')
  const next = structuredClone(document)
  const domain = next[scope]
  const bySource = new Map(
    domain.versions.flatMap((version) =>
      version.sources.map((source) => [source, version] as const)
    )
  )
  const ensure = (key: string): MusicVersion => {
    const existing = bySource.get(key)
    if (existing) return existing
    const version: MusicVersion = {
      id: newId(),
      label: label.trim() || '未命名版本',
      sources: [key],
      preferredSource: null
    }
    domain.versions.push(version)
    bySource.set(key, version)
    return version
  }
  if (operation === 'reset' || operation === 'split') {
    const chosen = new Set(selected)
    for (const version of domain.versions) {
      version.sources = version.sources.filter((key) => !chosen.has(key))
      if (version.preferredSource && chosen.has(version.preferredSource))
        version.preferredSource = null
    }
    if (operation === 'split')
      for (const key of selected) {
        bySource.delete(key)
        ensure(key)
      }
  } else {
    const versions = [...new Set(selected.map(ensure))]
    if (operation === 'sources') {
      const target = versions[0]
      const merged = new Set(versions.map((version) => version.id))
      target.sources = versions.flatMap((version) => version.sources)
      if (label.trim()) target.label = label.trim()
      for (const family of domain.families) {
        family.versions = [
          ...new Set(family.versions.map((id) => (merged.has(id) ? target.id : id)))
        ]
        if (family.preferredVersion && merged.has(family.preferredVersion))
          family.preferredVersion = target.id
      }
      domain.versions = domain.versions.filter(
        (version) => version === target || !merged.has(version.id)
      )
      const related = domain.families.filter((family) => family.versions.includes(target.id))
      if (related.length > 1) {
        related[0].versions = [...new Set(related.flatMap((family) => family.versions))]
        domain.families = domain.families.filter(
          (family) => !related.includes(family) || family === related[0]
        )
      }
    } else if (operation === 'family') {
      const chosen = new Set(versions.map((version) => version.id))
      const related = domain.families.filter((family) =>
        family.versions.some((id) => chosen.has(id))
      )
      for (const family of related) for (const id of family.versions) chosen.add(id)
      if (chosen.size < 2) throw new Error('所选来源已属于同一版本，请先拆分')
      domain.families = domain.families.filter((family) => !related.includes(family))
      domain.families.push({
        id: related[0]?.id ?? newId(),
        versions: [...chosen],
        preferredVersion: related[0]?.preferredVersion ?? null
      })
    } else if (operation === 'label') {
      if (!label.trim()) throw new Error('请输入版本标签')
      versions[0].label = label.trim()
    } else if (operation === 'prefer-source') versions[0].preferredSource = selected[0]
    else {
      const family = domain.families.find((item) => item.versions.includes(versions[0].id))
      if (operation === 'prefer-version') {
        if (!family) throw new Error('请先关联不同版本')
        family.preferredVersion = versions[0].id
      } else {
        versions[0].preferredSource = null
        if (family) family.preferredVersion = null
      }
    }
  }
  domain.versions = domain.versions.filter((version) => version.sources.length)
  const ids = new Set(domain.versions.map((version) => version.id))
  for (const family of domain.families) {
    family.versions = family.versions.filter((id) => ids.has(id))
    if (family.preferredVersion && !ids.has(family.preferredVersion)) family.preferredVersion = null
  }
  domain.families = domain.families.filter((family) => family.versions.length > 1)
  return parseMusicVersions(JSON.stringify(next))
}
