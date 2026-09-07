import type { ThemeLibrarySnapshot } from '../../../shared/theme.ts'

export function isThemeLibrarySnapshotNewer(
  current: ThemeLibrarySnapshot | null,
  next: ThemeLibrarySnapshot
): boolean {
  return current === null || next.revision > current.revision
}
