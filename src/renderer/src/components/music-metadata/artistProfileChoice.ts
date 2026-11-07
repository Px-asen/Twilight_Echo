import { shallowRef } from 'vue'

export interface ArtistProfileChoice {
  entityId: string
  targetId: string | null
}
const key = 'twilight-echo:artist-profile-choices:v1'
function read(): Record<string, ArtistProfileChoice> {
  try {
    const entries = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]')
    if (!Array.isArray(entries)) return {}
    return Object.fromEntries(
      entries.filter(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          typeof entry[1]?.entityId === 'string' &&
          (entry[1].targetId === null || typeof entry[1].targetId === 'string')
      )
    )
  } catch {
    return {}
  }
}
// This is a display choice, never an identity confirmation or a copied override.
export const artistProfileChoices = shallowRef<Record<string, ArtistProfileChoice>>({})
let loaded = false
function ensureLoaded(): void {
  if (loaded) return
  artistProfileChoices.value = read()
  loaded = true
}
export function artistProfileChoice(name: string): ArtistProfileChoice | null {
  ensureLoaded()
  return Object.hasOwn(artistProfileChoices.value, name) ? artistProfileChoices.value[name] : null
}
export function saveArtistProfileChoice(name: string, choice: ArtistProfileChoice | null): void {
  ensureLoaded()
  const entries = Object.entries(artistProfileChoices.value).filter(([n]) => n !== name)
  if (choice) entries.push([name, choice])
  // Publish only after the durable write succeeds; quota errors remain actionable.
  if (!globalThis.localStorage) throw new Error('当前无法保存人物资料选择')
  globalThis.localStorage.setItem(key, JSON.stringify(entries))
  artistProfileChoices.value = Object.fromEntries(entries)
}
