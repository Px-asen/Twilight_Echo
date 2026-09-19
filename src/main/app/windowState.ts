import { readFileSync } from 'node:fs'
import { writeJsonFileAtomic } from '../persistence/jsonFile.ts'

export interface WindowState {
  width: number
  height: number
  maximized: boolean
}

export function readWindowState(path: string): WindowState | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (
      Number.isFinite(value.width) &&
      value.width > 0 &&
      Number.isFinite(value.height) &&
      value.height > 0
    )
      return { width: value.width, height: value.height, maximized: value.maximized === true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.warn('[window] Unable to restore window size:', error)
  }
  return undefined
}

export function restoreWindowSize(
  state: WindowState | undefined,
  workArea: { width: number; height: number }
): { width: number; height: number } {
  return {
    width: Math.min(workArea.width, Math.max(760, Math.round(state?.width ?? 1495))),
    height: Math.min(workArea.height, Math.max(692, Math.round(state?.height ?? 883)))
  }
}

export function saveWindowState(path: string, state: WindowState): void {
  writeJsonFileAtomic(path, JSON.stringify(state), {
    label: 'window state',
    maxBytes: 1024,
    validate: (value): value is WindowState =>
      typeof value === 'object' &&
      value !== null &&
      'width' in value &&
      typeof value.width === 'number' &&
      Number.isFinite(value.width) &&
      'height' in value &&
      typeof value.height === 'number' &&
      Number.isFinite(value.height)
  })
}
