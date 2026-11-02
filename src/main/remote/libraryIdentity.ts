import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Lives with the library profile, independently of discovery and device trust. */
export function persistentLibraryId(root: string): string {
  const path = join(root, 'library-identity.json')
  if (existsSync(path)) {
    try {
      const { libraryId } = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof libraryId !== 'string' || !/^lib-[a-f0-9-]{36}$/.test(libraryId))
        throw new Error('Invalid library identity file')
      return libraryId
    } catch {
      try {
        renameSync(path, `${path}.corrupt`)
      } catch {
        // Best-effort quarantine of corrupt identity file.
      }
      console.warn('[remote.identity] Regenerating corrupt library-identity.json')
    }
  }
  const libraryId = `lib-${randomUUID()}`
  writeFileSync(`${path}.tmp`, JSON.stringify({ libraryId }), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
  return libraryId
}
