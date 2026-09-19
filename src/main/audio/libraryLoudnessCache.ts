import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadJsonFileWithBackup, writeJsonValueAtomic } from '../persistence/jsonFile.ts'
import {
  isLoudnessGroupMeasurement,
  type LoudnessGroupMeasurement
} from '../../shared/libraryLoudness.ts'

interface LoudnessRecord {
  version: 1
  fingerprint: string
  measurement: unknown
}

const recordOptions = {
  label: '库内响度结果',
  maxBytes: 512 * 1024,
  validate: (value: unknown): value is LoudnessRecord => {
    if (!value || typeof value !== 'object') return false
    const record = value as LoudnessRecord
    return (
      record.version === 1 &&
      typeof record.fingerprint === 'string' &&
      /^[a-f0-9]{64}$/.test(record.fingerprint) &&
      !!record.measurement
    )
  }
}

export function loudnessDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class LibraryLoudnessCache {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  get(id: string, fingerprint: string): LoudnessGroupMeasurement | null {
    const loaded = loadJsonFileWithBackup(this.pathFor(id), recordOptions)
    if (loaded.status === 'missing') return null
    const record = loaded.value
    return record.fingerprint === fingerprint && isLoudnessGroupMeasurement(record.measurement)
      ? record.measurement
      : null
  }

  set(id: string, fingerprint: string, measurement: LoudnessGroupMeasurement): void {
    if (!isLoudnessGroupMeasurement(measurement)) throw new Error('缺少有效的原始响度测量')
    writeJsonValueAtomic(this.pathFor(id), { version: 1, fingerprint, measurement }, recordOptions)
  }

  clear(ids: readonly string[]): void {
    for (const id of new Set(ids)) {
      const path = this.pathFor(id)
      for (const suffix of ['', '.bak', '.tmp', '.corrupt']) rmSync(path + suffix, { force: true })
    }
  }

  private pathFor(id: string): string {
    return join(this.directory, `${loudnessDigest(id)}.json`)
  }
}
