export function orderPlaylistEntries<T extends { id: string | number; pinned?: boolean }>(
  entries: readonly T[],
  order: readonly string[],
  pinnedIds: ReadonlySet<string> = new Set()
): T[] {
  const positions = new Map(order.map((id, index) => [id, index]))
  return [...entries].sort(
    (left, right) =>
      Number(right.pinned === true || pinnedIds.has(String(right.id))) -
        Number(left.pinned === true || pinnedIds.has(String(left.id))) ||
      (positions.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER) -
        (positions.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER)
  )
}

export function movePlaylistEntry(order: readonly string[], from: string, to: string): string[] {
  const result = [...order]
  const fromIndex = result.indexOf(from)
  const toIndex = result.indexOf(to)
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return result
  result.splice(fromIndex, 1)
  result.splice(toIndex, 0, from)
  return result
}
