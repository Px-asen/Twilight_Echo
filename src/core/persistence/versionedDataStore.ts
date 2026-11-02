import { resolve } from '../../shared/portablePath.ts'
import {
  backupPathFor,
  clearJsonFileArtifacts,
  loadJsonFileWithBackup,
  PersistentJsonFileError,
  readJsonCandidate,
  writeJsonValueAtomic,
  type JsonFileLoadResult,
  type JsonFileOptions
} from './jsonFile.ts'
import {
  PersistentDataRevisionConflictError,
  isVersionedDataEnvelope,
  type VersionedDataEnvelope
} from '../../shared/versionedPersistence.ts'

export interface VersionedDataStoreOptions<T> {
  filePath: string
  label: string
  maxBytes: number
  isData: (value: unknown) => value is T
  isLegacy: (value: unknown) => value is T
  now?: () => string
  onRecovery?: (
    result: Extract<JsonFileLoadResult<VersionedDataEnvelope<T> | T>, { status: 'recovered' }>
  ) => void
  onCorrupt?: (error: PersistentJsonFileError) => void
}

/**
 * Serializes one persistence domain.  Every operation reads the authoritative
 * revision inside the queue, so callers cannot win a stale read/write race.
 */
export class VersionedDataStore<T> {
  private static readonly tails = new Map<string, Promise<void>>()
  private readonly options: JsonFileOptions<VersionedDataEnvelope<T> | T>
  private readonly now: () => string
  private readonly config: VersionedDataStoreOptions<T>
  private readonly queueKey: string

  constructor(config: VersionedDataStoreOptions<T>) {
    this.config = config
    this.queueKey = resolve(config.filePath)
    this.now = config.now ?? (() => new Date().toISOString())
    this.options = {
      label: config.label,
      maxBytes: config.maxBytes,
      validate: (value): value is VersionedDataEnvelope<T> | T =>
        isVersionedDataEnvelope(value, config.isData) || config.isLegacy(value)
    }
  }

  load(): Promise<VersionedDataEnvelope<T> | null> {
    return this.enqueue(() => this.loadCurrent())
  }

  loadBackup(): Promise<VersionedDataEnvelope<T> | null> {
    return this.enqueue(() => {
      const backup = readJsonCandidate(backupPathFor(this.config.filePath), this.options)
      if (backup.status !== 'loaded') return null
      if (isVersionedDataEnvelope(backup.value, this.config.isData)) return backup.value
      return {
        version: 2,
        revision: 0,
        savedAt: legacySavedAt(backup.value) ?? this.now(),
        data: backup.value
      }
    })
  }

  removeFiles(): Promise<void> {
    return this.enqueue(() => clearJsonFileArtifacts(this.config.filePath))
  }

  save(data: T, expectedRevision: number): Promise<VersionedDataEnvelope<T>> {
    return this.enqueue(() => {
      this.assertExpectedRevision(expectedRevision)
      const current = this.loadCurrent()
      const currentRevision = current?.revision ?? 0
      if (expectedRevision !== currentRevision) {
        throw new PersistentDataRevisionConflictError(current, expectedRevision)
      }
      const next: VersionedDataEnvelope<T> = {
        version: 2,
        revision: currentRevision + 1,
        savedAt: this.now(),
        data
      }
      this.write(next)
      return next
    })
  }

  private enqueue<R>(operation: () => R | Promise<R>): Promise<R> {
    const preceding = VersionedDataStore.tails.get(this.queueKey) ?? Promise.resolve()
    const result = preceding.catch(() => {}).then(operation)
    const next = result.then(
      () => {},
      () => {}
    )
    VersionedDataStore.tails.set(this.queueKey, next)
    return result
  }

  private loadCurrent(): VersionedDataEnvelope<T> | null {
    let loaded: JsonFileLoadResult<VersionedDataEnvelope<T> | T>
    try {
      loaded = loadJsonFileWithBackup(this.config.filePath, this.options)
    } catch (error) {
      if (error instanceof PersistentJsonFileError && this.config.onCorrupt) {
        this.config.onCorrupt(error)
        return null
      }
      throw error
    }
    if (loaded.status === 'missing') return null
    if (loaded.status === 'recovered') this.config.onRecovery?.(loaded)
    if (isVersionedDataEnvelope(loaded.value, this.config.isData)) return loaded.value

    const migrated: VersionedDataEnvelope<T> = {
      version: 2,
      revision: 0,
      savedAt: legacySavedAt(loaded.value) ?? this.now(),
      data: loaded.value
    }
    this.write(migrated)
    return migrated
  }

  private write(value: VersionedDataEnvelope<T>): void {
    writeJsonValueAtomic(this.config.filePath, value, this.options)
  }

  private assertExpectedRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('Expected persistence revision must be a non-negative safe integer')
    }
  }
}

function legacySavedAt(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const savedAt = (value as { savedAt?: unknown }).savedAt
  return typeof savedAt === 'string' ? savedAt : null
}
