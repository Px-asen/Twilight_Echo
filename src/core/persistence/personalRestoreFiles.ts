import { join } from '../../shared/portablePath.ts'

export const personalRestoreFiles = {
  pending: 'personal-restore-pending.json',
  journal: 'personal-restore-journal.json',
  renderer: 'personal-restore-renderer.json',
  review: 'personal-restore-needs-review.json'
} as const

type Exists = (path: string) => boolean

function exists(root: string, name: string, existsSync: Exists): boolean {
  return existsSync(join(root, name)) || existsSync(join(root, `${name}.bak`))
}

export function hasPendingPersonalRestore(root: string, existsSync: Exists): boolean {
  return exists(root, personalRestoreFiles.pending, existsSync) || exists(root, personalRestoreFiles.journal, existsSync)
}

export function personalRestoreNeedsReview(root: string, existsSync: Exists): boolean {
  return exists(root, personalRestoreFiles.review, existsSync)
}
