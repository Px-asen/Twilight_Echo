import {
  PersistentJsonFileError,
  loadJsonFileWithBackup,
  writeJsonFileAtomic,
  type JsonFileOptions
} from './jsonFile.ts'

export const MAX_SETTINGS_FILE_BYTES = 2 * 1024 * 1024

type SettingsRecord = Record<string, unknown>

const SETTINGS_JSON_OPTIONS: JsonFileOptions<SettingsRecord> = {
  label: 'application settings',
  maxBytes: MAX_SETTINGS_FILE_BYTES,
  validate: isSettingsRecord
}

export type SettingsFileLoadIssue =
  | {
      kind: 'recovered'
      filePath: string
      corruptCopyPath: string | null
      restoreError: string | null
    }
  | {
      kind: 'corrupt'
      filePath: string
      backupPath: string
      primaryError: string
      backupError: string
      corruptCopyPath: string | null
      corruptBackupCopyPath: string | null
    }

export interface SettingsFileLoadResult<T> {
  settings: T
  issue: SettingsFileLoadIssue | null
}

export function loadSettingsFile<T extends object>(
  filePath: string,
  defaults: T,
  normalize: (settings: Partial<T>) => T
): SettingsFileLoadResult<T> {
  try {
    const loaded = loadJsonFileWithBackup(filePath, SETTINGS_JSON_OPTIONS)
    if (loaded.status === 'missing') {
      return { settings: normalize({ ...defaults }), issue: null }
    }

    const settings = normalize(loaded.value as Partial<T>)
    if (loaded.status === 'loaded') return { settings, issue: null }
    return {
      settings,
      issue: {
        kind: 'recovered',
        filePath,
        corruptCopyPath: loaded.corruptCopyPath,
        restoreError: loaded.restoreError
      }
    }
  } catch (error) {
    if (!(error instanceof PersistentJsonFileError)) throw error
    return {
      settings: normalize({ ...defaults }),
      issue: {
        kind: 'corrupt',
        filePath,
        backupPath: error.backupPath,
        primaryError: error.primaryError,
        backupError: error.backupError,
        corruptCopyPath: error.corruptCopyPath,
        corruptBackupCopyPath: error.corruptBackupCopyPath
      }
    }
  }
}

export function writeSettingsFile<T extends object>(filePath: string, settings: T): void {
  const record = settings as SettingsRecord
  writeJsonFileAtomic(filePath, JSON.stringify(settings, null, 2), SETTINGS_JSON_OPTIONS, record)
}

function isSettingsRecord(value: unknown): value is SettingsRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
