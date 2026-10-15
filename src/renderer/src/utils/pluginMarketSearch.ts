export interface PluginMarketEntry {
  id: string
  name: string
  author: string
  description: string
  tags?: string[]
  type: string[]
}

export interface PluginMarketIndex<T extends PluginMarketEntry> {
  entries: T[]
  textById: Map<string, string>
  grams: Map<string, Set<string>>
  byType: Map<string, Set<string>>
  byAuthor: Map<string, Set<string>>
  byTag: Map<string, Set<string>>
  authors: string[]
  tags: string[]
}

function addToIndex(index: Map<string, Set<string>>, key: string, id: string): void {
  const ids = index.get(key) ?? new Set<string>()
  ids.add(id)
  index.set(key, ids)
}

function bigrams(value: string): string[] {
  const chars = Array.from(value)
  const result: string[] = []
  for (let index = 0; index < chars.length - 1; index += 1) {
    result.push(chars[index] + chars[index + 1])
  }
  return result
}

export function createPluginMarketIndex<T extends PluginMarketEntry>(
  entries: T[]
): PluginMarketIndex<T> {
  const textById = new Map<string, string>()
  const grams = new Map<string, Set<string>>()
  const byType = new Map<string, Set<string>>()
  const byAuthor = new Map<string, Set<string>>()
  const authors = new Set<string>()
  const byTag = new Map<string, Set<string>>()
  const tags = new Map<string, string>()
  for (const entry of entries) {
    const text = [entry.name, entry.author, entry.id, entry.description, ...(entry.tags ?? [])]
      .join(' ')
      .toLocaleLowerCase()
    textById.set(entry.id, text)
    for (const gram of new Set(bigrams(text))) addToIndex(grams, gram, entry.id)
    for (const type of entry.type) addToIndex(byType, type, entry.id)
    addToIndex(byAuthor, entry.author, entry.id)
    authors.add(entry.author)
    for (const rawTag of entry.tags ?? []) {
      const tag = rawTag.trim()
      if (!tag) continue
      const key = tag.toLocaleLowerCase()
      addToIndex(byTag, key, entry.id)
      if (!tags.has(key)) tags.set(key, tag)
    }
  }
  return {
    entries,
    textById,
    grams,
    byType,
    byAuthor,
    byTag,
    authors: [...authors].sort((left, right) => left.localeCompare(right, 'zh-CN')),
    tags: [...tags.values()].sort((left, right) => left.localeCompare(right, 'zh-CN'))
  }
}

export function searchPluginMarket<T extends PluginMarketEntry>(
  index: PluginMarketIndex<T>,
  query: string,
  type = '',
  author = '',
  tag = ''
): T[] {
  const normalized = query.trim().toLocaleLowerCase()
  const sets: Set<string>[] = []
  if (type) sets.push(index.byType.get(type) ?? new Set())
  if (author) sets.push(index.byAuthor.get(author) ?? new Set())
  if (tag.trim()) sets.push(index.byTag.get(tag.trim().toLocaleLowerCase()) ?? new Set())
  for (const gram of new Set(bigrams(normalized))) sets.push(index.grams.get(gram) ?? new Set())
  sets.sort((left, right) => left.size - right.size)
  const matches: T[] = []
  for (const entry of index.entries) {
    if (sets.some((ids) => !ids.has(entry.id))) continue
    if (normalized && !index.textById.get(entry.id)?.includes(normalized)) continue
    matches.push(entry)
  }
  matches.sort((left, right) => {
    if (normalized) {
      const leftName = left.name.toLocaleLowerCase().includes(normalized)
      const rightName = right.name.toLocaleLowerCase().includes(normalized)
      if (leftName !== rightName) return leftName ? -1 : 1
    }
    return left.name.localeCompare(right.name, 'zh-CN')
  })
  return matches
}
