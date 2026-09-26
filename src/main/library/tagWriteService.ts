import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadTaglib, type Taglib } from './taglib.ts'
import {
  loadJsonFileWithBackup,
  writeJsonFileAtomic,
  type JsonFileOptions
} from '../persistence/jsonFile.ts'

const TAG_WRITE_JOURNAL_FILE = 'tag-write-journal.json'
const TAG_WRITE_JOURNAL_MAX_BYTES = 2 * 1024 * 1024

export interface TagWriteInput {
  filePath: string
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  track?: number
  disc?: number
  year?: number
  genre?: string
  coverData?: Uint8Array
  coverMimeType?: 'image/jpeg' | 'image/png'
}

export interface TagWriteResult {
  filePath: string
  backupPath: string
}

export type TagWriteJournalEntryStatus =
  | 'pending'
  | 'backedUp'
  | 'written'
  | 'rolledBack'
  | 'failed'

export interface TagWriteJournalEntry extends TagWriteResult {
  status: TagWriteJournalEntryStatus
  error?: string
}

export interface TagWriteJournal {
  version: 2
  state: 'writing' | 'completed' | 'rolledBack'
  entries: TagWriteJournalEntry[]
}

export class TagWriteBatchError extends Error {
  readonly journal: TagWriteJournal

  constructor(message: string, journal: TagWriteJournal, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'TagWriteBatchError'
    this.journal = cloneJournal(journal)
  }
}

const TAG_WRITE_JOURNAL_OPTIONS: JsonFileOptions<TagWriteJournal> = {
  label: 'tag write journal',
  maxBytes: TAG_WRITE_JOURNAL_MAX_BYTES,
  validate: isTagWriteJournal
}

export function tagBackupPath(filePath: string, backupRoot: string): string {
  return join(backupRoot, `${Buffer.from(filePath).toString('base64url')}.bak`)
}

export function getTagWriteJournalPath(backupRoot: string): string {
  return join(backupRoot, TAG_WRITE_JOURNAL_FILE)
}

export function writeTagsWithBackup(input: TagWriteInput, backupRoot: string): TagWriteResult {
  mkdirSync(backupRoot, { recursive: true })
  const result = { filePath: input.filePath, backupPath: tagBackupPath(input.filePath, backupRoot) }
  copyFileSync(input.filePath, result.backupPath)
  try {
    writeTags(input)
    return result
  } catch (error) {
    copyFileSync(result.backupPath, input.filePath)
    throw error
  }
}

export function writeTagsBatchWithRollback(
  inputs: readonly TagWriteInput[],
  backupRoot: string
): TagWriteJournalEntry[] {
  const journal: TagWriteJournal = {
    version: 2,
    state: 'writing',
    entries: inputs.map((input) => ({
      filePath: input.filePath,
      backupPath: tagBackupPath(input.filePath, backupRoot),
      status: 'pending'
    }))
  }
  persistTagWriteJournal(backupRoot, journal)

  try {
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index]
      const entry = journal.entries[index]
      try {
        copyFileSync(input.filePath, entry.backupPath)
      } catch (error) {
        entry.status = 'failed'
        entry.error = errorMessage(error)
        persistTagWriteJournal(backupRoot, journal)
        throw error
      }
      entry.status = 'backedUp'
      persistTagWriteJournal(backupRoot, journal)

      try {
        writeTags(input)
      } catch (error) {
        entry.error = errorMessage(error)
        persistTagWriteJournal(backupRoot, journal)
        throw error
      }
      entry.status = 'written'
      persistTagWriteJournal(backupRoot, journal)
    }
    journal.state = 'completed'
    persistTagWriteJournal(backupRoot, journal)
    return cloneJournal(journal).entries
  } catch (error) {
    rollbackJournalEntries(journal, backupRoot)
    journal.state = 'rolledBack'
    persistTagWriteJournal(backupRoot, journal)
    throw new TagWriteBatchError('Tag write batch failed', journal, error)
  }
}

export function readTagWriteJournal(backupRoot: string): TagWriteJournal {
  const loaded = loadJsonFileWithBackup(
    getTagWriteJournalPath(backupRoot),
    TAG_WRITE_JOURNAL_OPTIONS
  )
  if (loaded.status === 'missing') throw new Error('Tag write journal does not exist')
  return cloneJournal(loaded.value)
}

export function getTagWriteJournalRecoveryEntries(backupRoot: string): TagWriteJournalEntry[] {
  const journal = readTagWriteJournal(backupRoot)
  return journal.entries.filter(
    (entry) => entry.status === 'backedUp' || entry.status === 'written'
  )
}

export function restoreTagsFromBackup(filePath: string, backupRoot: string): void {
  const backupPath = tagBackupPath(filePath, backupRoot)
  if (!existsSync(backupPath)) throw new Error('Tag backup does not exist')
  mkdirSync(dirname(filePath), { recursive: true })
  copyFileSync(backupPath, filePath)
}

export function clearTagBackup(filePath: string, backupRoot: string): void {
  rmSync(tagBackupPath(filePath, backupRoot), { force: true })
}

function writeTags(input: TagWriteInput): void {
  const { ByteVector, File, Picture, PictureType } = loadTaglib()
  let media: Taglib.File | undefined
  try {
    media = File.createFromPath(input.filePath)
    if (input.title !== undefined) media.tag.title = input.title
    if (input.artist !== undefined) media.tag.performers = [input.artist]
    if (input.album !== undefined) media.tag.album = input.album
    if (input.albumArtist !== undefined) media.tag.albumArtists = [input.albumArtist]
    if (input.track !== undefined) media.tag.track = input.track
    if (input.disc !== undefined) media.tag.disc = input.disc
    if (input.year !== undefined) media.tag.year = input.year
    if (input.genre !== undefined) media.tag.genres = [input.genre]
    if (input.coverData && input.coverMimeType) {
      media.tag.pictures = [
        Picture.fromFullData(
          ByteVector.fromByteArray(input.coverData),
          PictureType.FrontCover,
          input.coverMimeType,
          ''
        )
      ]
    }
    media.save()
  } finally {
    media?.dispose()
  }
}

function rollbackJournalEntries(journal: TagWriteJournal, backupRoot: string): void {
  for (const entry of [...journal.entries].reverse()) {
    if (entry.status !== 'backedUp' && entry.status !== 'written') continue
    try {
      restoreTagsFromBackup(entry.filePath, backupRoot)
      entry.status = 'rolledBack'
    } catch (error) {
      entry.status = 'failed'
      entry.error = `Rollback failed: ${errorMessage(error)}`
    }
    persistTagWriteJournal(backupRoot, journal)
  }
}

function persistTagWriteJournal(backupRoot: string, journal: TagWriteJournal): void {
  const journalPath = getTagWriteJournalPath(backupRoot)
  const value = cloneJournal(journal)
  writeJsonFileAtomic(journalPath, JSON.stringify(value), TAG_WRITE_JOURNAL_OPTIONS, value)
}

function isTagWriteJournal(value: unknown): value is TagWriteJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    record.version !== 2 ||
    (record.state !== 'writing' && record.state !== 'completed' && record.state !== 'rolledBack') ||
    !Array.isArray(record.entries)
  ) {
    return false
  }
  return record.entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const candidate = entry as Record<string, unknown>
    return (
      typeof candidate.filePath === 'string' &&
      !!candidate.filePath &&
      typeof candidate.backupPath === 'string' &&
      !!candidate.backupPath &&
      (candidate.status === 'pending' ||
        candidate.status === 'backedUp' ||
        candidate.status === 'written' ||
        candidate.status === 'rolledBack' ||
        candidate.status === 'failed') &&
      (candidate.error === undefined || typeof candidate.error === 'string')
    )
  })
}

function cloneJournal(journal: TagWriteJournal): TagWriteJournal {
  return {
    version: 2,
    state: journal.state,
    entries: journal.entries.map((entry) => ({ ...entry }))
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
