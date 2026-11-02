import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

/** Persist only output intent, never a Bridge bearer token. A restart requires
 * a fresh connection or an explicit local selection, not a speaker fallback. */
export async function bridgeSelectionStore(root: string) {
  const path = join(root, 'bridge-output-selection.json')
  let selected = false
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !('version' in value) ||
      value.version !== 1 ||
      !('selected' in value) ||
      typeof value.selected !== 'boolean'
    ) {
      throw new Error('Invalid Bridge output selection')
    }
    selected = value.selected
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[audio.bridge] Quarantining unreadable bridge selection:', cause)
      // An unreadable record may have selected a remote DAC. Keep playback
      // blocked until an explicit choice rather than guessing "local".
      selected = true
    }
  }
  return {
    selected,
    async save(value: boolean) {
      await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, selected: value }), {
        mode: 0o600
      })
      await rename(`${path}.tmp`, path)
    }
  }
}
