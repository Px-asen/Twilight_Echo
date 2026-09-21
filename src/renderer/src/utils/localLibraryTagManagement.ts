export { normalizePortableLibraryPath as tagWritePathKey } from '@renderer/stores/library/musicStoreData.ts'
import type {
  DuplicateActionPlan,
  DuplicateDetectionResult,
  DuplicateGroup
} from '../../../shared/duplicateDetection.ts'
import type {
  LocalLibraryTagOperationResult,
  LocalLibraryTagPatch
} from '../../../shared/localLibraryTags.ts'

export const MAX_TAG_COVER_BYTES = 8 * 1024 * 1024

export type TagWriteSummary = {
  successCount: number
  failedCount: number
  rolledBackCount: number
  notAttemptedCount: number
}

export function validateTagCoverFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
    return '封面只支持 PNG 或 JPEG 图片'
  }
  if (file.size <= 0) return '封面文件为空'
  if (file.size > MAX_TAG_COVER_BYTES) return '封面不能超过 8 MiB'
  return null
}

export function summarizeTagWriteResults(
  results: readonly LocalLibraryTagOperationResult[]
): TagWriteSummary {
  const summary: TagWriteSummary = {
    successCount: 0,
    failedCount: 0,
    rolledBackCount: 0,
    notAttemptedCount: 0
  }
  for (const result of results) {
    switch (result.status) {
      case 'success':
        summary.successCount++
        break
      case 'failed':
        summary.failedCount++
        break
      case 'rolledBack':
        summary.rolledBackCount++
        break
      case 'notAttempted':
        summary.notAttemptedCount++
        break
    }
  }
  return summary
}

export function successfulTagPaths(results: readonly LocalLibraryTagOperationResult[]): string[] {
  return results.filter((result) => result.status === 'success').map((result) => result.filePath)
}

export function tagPatchFromForm(
  values: Record<keyof LocalLibraryTagPatch, unknown>
): LocalLibraryTagPatch {
  const patch: LocalLibraryTagPatch = {}
  for (const field of ['title', 'artist', 'album', 'albumArtist', 'genre'] as const) {
    const value = values[field]
    if (typeof value === 'string' && value.trim()) patch[field] = value.trim()
  }
  for (const field of ['track', 'disc', 'year'] as const) {
    const value = values[field]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) patch[field] = value
  }
  if (values.coverData instanceof Uint8Array) patch.coverData = values.coverData
  return patch
}

export function hasTagPatch(patch: LocalLibraryTagPatch): boolean {
  return Object.keys(patch).length > 0
}

export type DuplicateReviewGroup = {
  group: DuplicateGroup
  suggestion: DuplicateActionPlan | undefined
  label: string
}

export function toDuplicateReviewGroups(result: DuplicateDetectionResult): DuplicateReviewGroup[] {
  const suggestions = new Map(
    result.suggestions.map((suggestion) => [suggestion.group.key, suggestion])
  )
  return result.groups.map((group) => ({
    group,
    suggestion: suggestions.get(group.key),
    label: duplicateGroupLabel(group)
  }))
}

export function duplicateGroupLabel(group: DuplicateGroup): string {
  const evidence = {
    path: '相同路径',
    contentHash: '相同文件 hash',
    audioFingerprint: '相同音频指纹',
    metadataCandidate: '相近元数据',
    logicalTrack: '相同曲目'
  }[group.kind]
  const confidence = { exact: '精确', probable: '较高', possible: '待确认' }[group.confidence]
  return `${evidence} · ${confidence}置信度`
}
