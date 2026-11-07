import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  LibraryQueueSnapshot,
  LibraryQueuePage,
  LibraryQueueReadOptions,
  LibraryQueueEdit,
  LibraryQueueEditResult,
  LibraryQueueInsertItem
} from '../../shared/libraryDatabase.ts'
import {
  libraryPageBounds,
  validateLibraryQueueBuild,
  validateLibraryQueueEdit
} from './libraryDatabaseValidation.ts'
import {
  isLibraryPlaybackQueueReference,
  type LibraryPlaybackQueueReference
} from '../../shared/playbackSession.ts'
import { personalBackupJsonReplacer } from '../../shared/personalBackup.ts'
import type { PlaylistQueuePlan } from './libraryDatabasePlaylistViews.ts'
import {
  LIBRARY_QUEUE_BUILD_IDLE_MS,
  LIBRARY_QUEUE_BUILD_MAX_ENTRIES,
  type LibraryQueueBuildCommand,
  type LibraryQueueBuildReply
} from '../../shared/libraryQueueBuild.ts'
import { compactPlaylistRecord } from '../../shared/playlistSnapshot.ts'
import type { CoreQueueImportCommand, CoreQueueImportReply } from '../../shared/coreQueueImport.ts'
import { legacyQueueImportOwner } from '../../shared/coreQueueImport.ts'
import type { CoreQueueRestoreCommand } from '../../shared/coreQueueRestore.ts'
import { MAX_QUEUE_OCCURRENCE_ID_LENGTH } from '../../shared/nativeQueue.ts'
import { shuffleArray } from '../../shared/shuffleArray.ts'
import type { CoreQueueSourceReplacement } from '../../shared/coreSourceRecovery.ts'

type Row = Record<string, string | number | null>
type QueueHistory = {
  id: number
  kind: 'insert' | 'remove' | 'clear' | 'move' | 'order'
  payload: Record<string, unknown>
}
const MAX_QUEUE_HISTORY = 20
const QUEUE_GC_AGE_MS = 60 * 60 * 1000
type StreamBuild = {
  id: string
  offset: number
  sequence: number
  revision: number
  order: LibraryQueueSnapshot['order']
  mode?: LibraryQueueSnapshot['playMode']
  touched: number
}
type Owner = {
  sql: DatabaseSync
  transaction<T>(action: () => T): T
  stagingTransaction<T>(action: () => T): T
  revision(): number
}
const entryId = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 128
const occurrenceId = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  value.length <= MAX_QUEUE_OCCURRENCE_ID_LENGTH &&
  !value.includes('\0')

export type LibraryQueueBuildPlan =
  | { kind: 'tracks'; ids: string[]; index: number }
  | ({ kind: 'playlist' } & PlaylistQueuePlan)
export type LibraryQueueBuild = { id: string; offset: number; plan: LibraryQueueBuildPlan }
export type LibraryQueueBuildResult =
  | { ready: false }
  | { ready: true; queue: LibraryQueueSnapshot }

/** Queue orders and cursor live in SQLite. Reordering moves only lightweight
 * occurrence IDs inside SQL; no Track[] or full ordering crosses the boundary. */
export class LibraryDatabaseQueues {
  private readonly owner: Owner
  private readonly cancelling = new Set<string>()
  private readonly streams = new Map<string, StreamBuild>()
  constructor(owner: Owner) {
    this.owner = owner
  }
  private run(sql: string, ...args: (string | number | null)[]) {
    return this.owner.sql.prepare(sql).run(...args)
  }
  private row(sql: string, ...args: (string | number)[]) {
    return this.owner.sql.prepare(sql).get(...args) as Row | undefined
  }
  private assertId(id: unknown): asserts id is string {
    if (!entryId(id)) throw new Error('Invalid library queue identity')
  }
  get(id: string): LibraryQueueSnapshot {
    this.assertId(id)
    const row = this.row(
      `SELECT q.id,q.revision,q.ordering,q.selected_entry,q.play_mode,
      q.total_count AS total,
      (SELECT position FROM queue_entries WHERE queue_id=q.id AND entry_id=q.selected_entry) AS position
      FROM queues q WHERE id=? AND state='ready'`,
      id
    )
    if (!row) throw new Error('Library queue does not exist')
    const undo = this.row(
      'SELECT kind FROM queue_history WHERE queue_id=? AND revision=? ORDER BY id DESC LIMIT 1',
      id,
      Number(row.revision)
    )
    return {
      id,
      canUndo: !!undo,
      undoLabel: undo
        ? ({
            insert: '添加歌曲',
            remove: '移除歌曲',
            clear: '清空队列',
            move: '移动歌曲',
            order: '更改顺序'
          }[String(undo.kind)] ?? null)
        : null,
      revision: Number(row.revision),
      total: Number(row.total),
      index: row.position === null ? -1 : Number(row.position),
      selectedEntryId: row.selected_entry as string | null,
      order: row.ordering as LibraryQueueSnapshot['order'],
      ...(row.play_mode ? { playMode: row.play_mode as LibraryQueueSnapshot['playMode'] } : {})
    }
  }
  create(ids: string[], selectedIndex: number): LibraryQueueSnapshot {
    // orderedIds already validated the query. This array contains only identities.
    const id = randomUUID()
    this.run('INSERT INTO queues(id,created_at) VALUES(?,?)', id, Date.now())
    this.appendTracks(id, ids, 0)
    this.publish(id, ids.length, selectedIndex)
    return this.get(id)
  }
  private appendTracks(id: string, ids: string[], offset: number): number {
    // Frozen occurrences are globally unique by queue + original input offset.
    // Insert their identity index sequentially instead of dirtying random index
    // pages for every 200-row batch. Editing never derives positions from IDs.
    return Number(
      this.run(
        `INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position)
      SELECT ?,CAST(key AS INTEGER)+?,?||printf(':%016x',CAST(key AS INTEGER)+?),value,CAST(key AS INTEGER)+? FROM json_each(?)`,
        id,
        offset,
        id,
        offset,
        offset,
        JSON.stringify(ids)
      ).changes
    )
  }
  private publish(id: string, total: number, index: number): void {
    this.run(
      "UPDATE queues SET state='ready',total_count=?,selected_entry=(SELECT entry_id FROM queue_entries WHERE queue_id=? AND position=?) WHERE id=?",
      total,
      id,
      index,
      id
    )
  }
  createPlaylist(plan: PlaylistQueuePlan): LibraryQueueSnapshot {
    const id = randomUUID()
    this.run('INSERT INTO queues(id,created_at) VALUES(?,?)', id, Date.now())
    const inserted = this.appendPlaylist(id, plan.viewId, plan.members, 0)
    if (inserted !== plan.members.length)
      throw new Error('Playlist membership changed during queue construction')
    this.publish(id, plan.members.length, plan.index)
    return this.get(id)
  }
  private appendPlaylist(id: string, viewId: string, entries: number[], offset: number): number {
    const members = JSON.stringify(entries)
    const inserted = Number(
      this.run(
        `INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position)
      SELECT ?,CAST(j.key AS INTEGER)+?,?||printf(':%016x',CAST(j.key AS INTEGER)+?),m.id,CAST(j.key AS INTEGER)+?
      FROM json_each(?) j CROSS JOIN playlist_members m ON m.view_id=? AND m.seq=CAST(j.value AS INTEGER)`,
        id,
        offset,
        id,
        offset,
        offset,
        members,
        viewId
      ).changes
    )
    this.run(
      `INSERT INTO queue_snapshots(queue_id,entry_id,payload)
      SELECT q.queue_id,q.entry_id,m.snapshot FROM json_each(?) j
      CROSS JOIN playlist_members m ON m.view_id=? AND m.seq=CAST(j.value AS INTEGER)
      CROSS JOIN queue_entries q ON q.queue_id=? AND q.position=CAST(j.key AS INTEGER)+?
      WHERE m.snapshot IS NOT NULL`,
      members,
      viewId,
      id,
      offset
    )
    return inserted
  }
  beginBuild(plan: LibraryQueueBuildPlan): LibraryQueueBuild {
    const id = randomUUID()
    this.beginHidden(id)
    return { id, plan, offset: 0 }
  }
  private beginHidden(id: string): void {
    this.owner.transaction(() => {
      const count = Number(
        this.row("SELECT count(*) AS n FROM queues WHERE state IN ('building','abandoned')")!.n
      )
      if (count >= 4) throw new Error('Too many queue builds; wait for construction or cleanup')
      this.run("INSERT INTO queues(id,created_at,state) VALUES(?,?,'building')", id, Date.now())
    })
  }

  /** Stream into the existing hidden builder/tables, not a second queue store.
   * Every append is bounded and once-only; invalid/uncertain continuations are
   * abandoned rather than replayed. Both occurrence orders publish together. */
  importLegacyPlaybackQueue(input: CoreQueueImportCommand): CoreQueueImportReply {
    legacyQueueImportOwner(input?.id)
    validateLibraryQueueBuild(input, true)
    if (input.kind === 'begin') {
      const previous = this.row('SELECT state FROM queues WHERE id=?', input.id)
      if (previous?.state === 'ready')
        return { kind: 'ready', id: input.id, queue: this.get(input.id) }
      if (previous) {
        if (this.row('SELECT 1 FROM queue_references WHERE queue_id=?', input.id))
          throw new Error('An incomplete import is still referenced')
        // Restart only this uncommitted import, retiring 200 rows per request.
        // A reply lost during retirement is resolved by inspecting the same ID.
        this.streams.delete(input.id)
        this.owner.transaction(() => {
          this.run("UPDATE queues SET state='abandoned' WHERE id=?", input.id)
          this.cleanupRows(input.id)
        })
        return { kind: 'retiring', id: input.id }
      }
    }
    return this.stream(input, 'legacy')
  }
  restoreNamedPlaybackQueue(input: CoreQueueRestoreCommand): LibraryQueueBuildReply {
    if (!input || !/^core-restore-[\w-]+$/.test(input.id))
      throw new Error('Invalid Core named queue restore identity')
    if (
      input.kind === 'begin' &&
      !['sequential', 'listLoop', 'repeat', 'shuffle'].includes(input.playMode)
    )
      throw new Error('Invalid named queue restore mode')
    return this.stream(input, 'named')
  }
  /** Private SQL snapshot for a Zone handoff. Keep duplicate occurrences and both
   * orders, but never share the mutable cursor or export the full queue to JS. */
  clonePlaybackQueue(reference: LibraryPlaybackQueueReference): LibraryQueueSnapshot {
    if (!isLibraryPlaybackQueueReference(reference))
      throw new Error('Invalid handoff queue reference')
    return this.owner.transaction(() => {
      const source = this.expected(reference.id, reference.revision)
      if (
        !source.total ||
        source.index !== reference.index ||
        source.selectedEntryId !== reference.entryId
      )
        throw Object.assign(new Error('Handoff queue selection changed concurrently'), {
          code: 'STALE_REVISION'
        })
      const id = randomUUID()
      this.run(
        `INSERT INTO queues(id,revision,ordering,selected_entry,created_at,state,total_count,play_mode)
        SELECT ?,0,ordering,selected_entry,?,'ready',total_count,play_mode FROM queues WHERE id=?`,
        id,
        Date.now(),
        source.id
      )
      this.run(
        `INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position)
        SELECT ?,position,entry_id,track_id,original_position FROM queue_entries WHERE queue_id=?`,
        id,
        source.id
      )
      this.run(
        `INSERT INTO queue_snapshots(queue_id,entry_id,payload)
        SELECT ?,entry_id,payload FROM queue_snapshots WHERE queue_id=?`,
        id,
        source.id
      )
      return this.get(id)
    })
  }
  restoreHeartBaseQueue(base: LibraryPlaybackQueueReference, selectedTrackId: string) {
    if (
      !isLibraryPlaybackQueueReference(base) ||
      typeof selectedTrackId !== 'string' ||
      !selectedTrackId ||
      selectedTrackId.length > 32768
    )
      throw new Error('Invalid heart base selection')
    return this.owner.transaction(() => {
      const source = this.expected(base.id, base.revision)
      if (!source.total) throw new Error('Heart base queue is empty')
      const match = this.row(
        'SELECT entry_id FROM queue_entries WHERE queue_id=? AND track_id=? ORDER BY position LIMIT 1',
        base.id,
        selectedTrackId
      )
      const selected =
        match ??
        this.row(
          `SELECT q.entry_id FROM queue_entries q WHERE q.queue_id=? AND
          (EXISTS(SELECT 1 FROM tracks t WHERE t.id=q.track_id) OR EXISTS(
            SELECT 1 FROM queue_snapshots s WHERE s.queue_id=q.queue_id AND s.entry_id=q.entry_id))
          ORDER BY q.position LIMIT 1`,
          base.id
        ) ??
        this.row(
          'SELECT entry_id FROM queue_entries WHERE queue_id=? ORDER BY position LIMIT 1',
          base.id
        )!
      const id = randomUUID()
      this.run(
        `INSERT INTO queues(id,revision,ordering,selected_entry,created_at,state,total_count,play_mode)
        VALUES(?,0,'original',?,?,'ready',?,'sequential')`,
        id,
        String(selected.entry_id),
        Date.now(),
        source.total
      )
      this.run(
        `INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position)
        SELECT ?,position,entry_id,track_id,position FROM queue_entries WHERE queue_id=?`,
        id,
        base.id
      )
      this.run(
        `INSERT INTO queue_snapshots(queue_id,entry_id,payload)
        SELECT ?,entry_id,payload FROM queue_snapshots WHERE queue_id=?`,
        id,
        base.id
      )
      return { queue: this.get(id), matched: !!match }
    })
  }
  /** Replace an occurrence's source, not its identity. Positions, selection, duplicates
   * and original order retain their meaning. Undo must not resurrect its dead
   * identity from a move/remove/clear snapshot. */
  replaceSource(command: CoreQueueSourceReplacement): LibraryQueueSnapshot {
    if (
      !command ||
      !isLibraryPlaybackQueueReference(command.queue) ||
      !occurrenceId(command.occurrenceId) ||
      typeof command.expectedTrackId !== 'string' ||
      !command.expectedTrackId ||
      command.expectedTrackId.length > 32768 ||
      !Number.isSafeInteger(command.contentRevision) ||
      command.contentRevision < 0
    )
      throw new Error('Invalid playback source replacement')
    validateLibraryQueueBuild({
      kind: 'append',
      id: 'core-source-replacement',
      sequence: 1,
      items: [command.replacement]
    })
    return this.owner.transaction(() => {
      const { queue: reference, replacement } = command
      const queue = this.expected(reference.id, reference.revision)
      if (
        this.owner.revision() !== command.contentRevision ||
        queue.index !== reference.index ||
        queue.selectedEntryId !== reference.entryId
      )
        throw new Error('Playback source selection changed concurrently')
      const entry = this.row(
        'SELECT track_id FROM queue_entries WHERE queue_id=? AND entry_id=?',
        reference.id,
        command.occurrenceId
      )
      if (entry?.track_id !== command.expectedTrackId)
        throw new Error('Playback source occurrence changed concurrently')
      if (
        !replacement.snapshot &&
        !replacement.localSnapshot &&
        !this.row('SELECT 1 FROM tracks WHERE id=?', replacement.id)
      )
        throw new Error('Cannot replace a source with a missing library track')
      const record = replacement.localSnapshot ?? replacement.snapshot
      const snapshot = record ? compactPlaylistRecord(record) : null
      if (snapshot) {
        delete snapshot.streamUrl
        for (const field of ['cover', 'coverSmall', 'coverSource', 'coverSmallSource'])
          if (
            typeof snapshot[field] === 'string' &&
            /^(data:|blob:|twilight-media:)/i.test(snapshot[field])
          )
            delete snapshot[field]
      }
      const payload = snapshot ? JSON.stringify(snapshot, personalBackupJsonReplacer) : null
      this.run(
        'UPDATE queue_entries SET track_id=? WHERE queue_id=? AND entry_id=?',
        replacement.id,
        reference.id,
        command.occurrenceId
      )
      this.run(
        'DELETE FROM queue_snapshots WHERE queue_id=? AND entry_id=?',
        reference.id,
        command.occurrenceId
      )
      if (payload)
        this.run(
          'INSERT INTO queue_snapshots(queue_id,entry_id,payload) VALUES(?,?,?)',
          reference.id,
          command.occurrenceId,
          payload
        )
      this.run(
        `UPDATE queue_history_entries SET track_id=?,snapshot=? WHERE entry_id=?
         AND history_id IN (SELECT id FROM queue_history WHERE queue_id=?)`,
        replacement.id,
        payload,
        command.occurrenceId,
        reference.id
      )
      this.run(
        'UPDATE queue_history SET revision=revision+1 WHERE queue_id=? AND revision=?',
        reference.id,
        reference.revision
      )
      this.run('UPDATE queues SET revision=revision+1 WHERE id=?', reference.id)
      return this.get(reference.id)
    })
  }
  stream(
    input: LibraryQueueBuildCommand,
    occurrenceOwner?: 'legacy' | 'named'
  ): LibraryQueueBuildReply {
    const value = input as unknown as Record<string, unknown> | null
    const id = value && typeof value.id === 'string' ? value.id : ''
    const build = this.streams.get(id)
    try {
      const preserveOccurrenceIds = occurrenceOwner !== undefined
      validateLibraryQueueBuild(input, preserveOccurrenceIds)
      if (!preserveOccurrenceIds && /^(core-session-|core-restore-)/.test(id))
        throw new Error('Core import namespace is reserved')
      if (input.kind === 'abort') {
        if (build) this.abandonStream(build)
        return { kind: 'aborted', id }
      }
      if (input.kind === 'begin') {
        if (build) throw new Error('Library queue stream already exists')
        if (input.contentRevision !== this.owner.revision())
          throw new Error('Library changed during queue construction')
        this.beginHidden(id)
        this.streams.set(id, {
          id,
          offset: 0,
          sequence: 0,
          revision: input.contentRevision,
          order: input.order,
          ...(occurrenceOwner === 'named'
            ? { mode: (input as CoreQueueRestoreCommand & { kind: 'begin' }).playMode }
            : {}),
          touched: Date.now()
        })
        return { kind: 'building', id, sequence: 0, total: 0 }
      }
      if (!build || build.touched + LIBRARY_QUEUE_BUILD_IDLE_MS <= Date.now())
        throw new Error('Library queue stream expired')
      if (input.sequence !== build.sequence + 1)
        throw new Error('Library queue stream sequence changed; do not replay a batch')
      if (build.revision !== this.owner.revision())
        throw new Error('Library changed during queue construction')
      if (
        this.cancelling.has(id) ||
        this.row('SELECT state FROM queues WHERE id=?', id)?.state !== 'building'
      )
        throw new Error('Library queue construction expired')
      if (input.kind === 'append') {
        const total = build.offset + input.items.length
        if (total > LIBRARY_QUEUE_BUILD_MAX_ENTRIES)
          throw new Error('Library queue stream is too large')
        this.owner.stagingTransaction(() => {
          const localIds = input.items
            .filter((item) => !item.snapshot && !item.localSnapshot)
            .map((item) => item.id)
          if (
            Number(
              this.row(
                'SELECT count(*) AS n FROM json_each(?) j JOIN tracks t ON t.id=j.value',
                JSON.stringify(localIds)
              )!.n
            ) !== localIds.length
          )
            throw new Error('Cannot queue a missing library track')
          const items = input.items.map((item, index) => {
            const record = item.localSnapshot ?? item.snapshot
            const snapshot = record ? compactPlaylistRecord(record) : undefined
            if (item.localSnapshot && snapshot) delete snapshot.streamUrl
            if (snapshot)
              for (const field of ['cover', 'coverSmall', 'coverSource', 'coverSmallSource'])
                if (
                  typeof snapshot[field] === 'string' &&
                  /^(data:|blob:|twilight-media:)/i.test(snapshot[field])
                )
                  delete snapshot[field]
            return {
              id: item.id,
              ...(preserveOccurrenceIds
                ? { occurrenceId: (item as typeof item & { occurrenceId: string }).occurrenceId }
                : {}),
              originalPosition: item.originalPosition ?? build.offset + index,
              ...(snapshot ? { snapshot } : {})
            }
          })
          const payload = JSON.stringify(items, personalBackupJsonReplacer)
          this.run(
            `INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position)
             SELECT ?,CAST(j.key AS INTEGER)+?,COALESCE(json_extract(j.value,'$.occurrenceId'),?||printf(':%016x',CAST(j.key AS INTEGER)+?)),
             json_extract(j.value,'$.id'),json_extract(j.value,'$.originalPosition') FROM json_each(?) j`,
            id,
            build.offset,
            id,
            build.offset,
            payload
          )
          this.run(
            `INSERT INTO queue_snapshots(queue_id,entry_id,payload)
             SELECT q.queue_id,q.entry_id,json_extract(j.value,'$.snapshot') FROM json_each(?) j
             CROSS JOIN queue_entries q ON q.queue_id=? AND q.position=CAST(j.key AS INTEGER)+?
             WHERE json_type(j.value,'$.snapshot')='object'`,
            payload,
            id,
            build.offset
          )
        })
        build.offset = total
        build.sequence = input.sequence
        build.touched = Date.now()
        return { kind: 'building', id, sequence: build.sequence, total }
      }
      const queue = this.owner.transaction(() => {
        if (
          build.offset === 0
            ? input.selectedIndex !== -1
            : input.selectedIndex < 0 || input.selectedIndex >= build.offset
        )
          throw new Error('Selected occurrence is not in the queue stream')
        const positions = this.row(
          `SELECT count(DISTINCT original_position) AS n,min(original_position) AS first,
           max(original_position) AS last FROM queue_entries WHERE queue_id=?`,
          id
        )!
        if (
          Number(positions.n) !== build.offset ||
          (build.offset > 0 &&
            (Number(positions.first) !== 0 || Number(positions.last) !== build.offset - 1))
        )
          throw new Error('Original queue order is not a complete permutation')
        if (
          occurrenceOwner !== 'named' &&
          build.order === 'original' &&
          this.row(
            'SELECT 1 AS n FROM queue_entries WHERE queue_id=? AND position<>original_position LIMIT 1',
            id
          )
        )
          throw new Error('Original queue order does not match its displayed order')
        this.run(
          'UPDATE queues SET ordering=?,play_mode=? WHERE id=?',
          build.order,
          build.mode ?? null,
          id
        )
        this.publish(id, build.offset, input.selectedIndex)
        if (occurrenceOwner === 'legacy')
          this.run(
            'INSERT INTO queue_references VALUES (?,?,?)',
            legacyQueueImportOwner(id),
            id,
            Date.now()
          )
        return this.get(id)
      })
      this.streams.delete(id)
      return { kind: 'ready', id, queue }
    } catch (error) {
      // A duplicate begin must not overwrite or retire the live continuation.
      if (build && value?.kind !== 'begin') {
        try {
          this.abandonStream(build)
        } catch {
          /* maintenance retains cancellation */
        }
      }
      throw error
    }
  }
  private abandonStream(build: StreamBuild): void {
    this.cancelling.add(build.id)
    this.streams.delete(build.id)
    this.markAbandoned(build.id)
  }
  get nextStreamExpiry(): number | undefined {
    if (!this.streams.size) return undefined
    return Math.min(
      ...[...this.streams.values()].map((build) => build.touched + LIBRARY_QUEUE_BUILD_IDLE_MS)
    )
  }
  advanceBuild(build: LibraryQueueBuild): LibraryQueueBuildResult {
    const { id, plan, offset } = build,
      total = plan.kind === 'tracks' ? plan.ids.length : plan.members.length
    const end = Math.min(offset + 200, total)
    const transaction =
      end === total
        ? <T>(action: () => T) => this.owner.transaction(action)
        : <T>(action: () => T) => this.owner.stagingTransaction(action)
    const result: LibraryQueueBuildResult = transaction(() => {
      if (
        this.cancelling.has(id) ||
        this.row('SELECT state FROM queues WHERE id=?', id)?.state !== 'building'
      )
        throw new Error('Library queue construction expired')
      const inserted =
        plan.kind === 'tracks'
          ? this.appendTracks(id, plan.ids.slice(offset, end), offset)
          : this.appendPlaylist(id, plan.viewId, plan.members.slice(offset, end), offset)
      if (inserted !== end - offset)
        throw new Error('Playlist membership changed during queue construction')
      if (end < total) return { ready: false }
      this.publish(id, total, plan.index)
      return { ready: true, queue: this.get(id) }
    })
    // Failed transactions must leave the continuation at its previous cursor.
    build.offset = end
    return result
  }
  abandonBuild(build: LibraryQueueBuild): void {
    this.cancelling.add(build.id)
    this.markAbandoned(build.id)
  }
  private markAbandoned(id: string): void {
    this.run("UPDATE queues SET state='abandoned' WHERE id=? AND state='building'", id)
    this.cancelling.delete(id)
  }
  recoverBuilds(): void {
    this.run("UPDATE queues SET state='abandoned' WHERE state='building'")
  }
  get needsMaintenance(): boolean {
    return (
      this.cancelling.size > 0 ||
      (this.nextStreamExpiry !== undefined && this.nextStreamExpiry <= Date.now()) ||
      !!this.row("SELECT id FROM queues WHERE state='abandoned' LIMIT 1") ||
      !!this.row(
        `SELECT q.id FROM queues q
         WHERE q.state='ready' AND q.created_at<?
         AND NOT EXISTS(SELECT 1 FROM queue_references r WHERE r.queue_id=q.id)
         LIMIT 1`,
        Date.now() - QUEUE_GC_AGE_MS
      )
    )
  }
  maintenance(): void {
    for (const build of this.streams.values())
      if (build.touched + LIBRARY_QUEUE_BUILD_IDLE_MS <= Date.now()) this.abandonStream(build)
    const pending = this.cancelling.values().next().value
    if (pending !== undefined) this.markAbandoned(pending)
    let row = this.row("SELECT id FROM queues WHERE state='abandoned' ORDER BY id LIMIT 1")
    if (!row) {
      this.collectGarbage(QUEUE_GC_AGE_MS)
      row = this.row("SELECT id FROM queues WHERE state='abandoned' ORDER BY id LIMIT 1")
    }
    if (!row) return
    const id = String(row.id)
    this.owner.stagingTransaction(() => this.cleanupRows(id))
  }
  private cleanupRows(id: string): void {
    // Snapshots cascade per occurrence. Never cascade-delete a whole large
    // queue on cancellation, explicit disposal, or startup recovery.
    this.run(
      `DELETE FROM queue_entries WHERE queue_id=? AND position IN
        (SELECT position FROM queue_entries WHERE queue_id=? ORDER BY position LIMIT 200)`,
      id,
      id
    )
    if (!this.row('SELECT 1 FROM queue_entries WHERE queue_id=? LIMIT 1', id))
      this.run("DELETE FROM queues WHERE id=? AND state='abandoned'", id)
  }
  read(
    id: string,
    offset?: number,
    limit?: number,
    options?: LibraryQueueReadOptions
  ): LibraryQueuePage {
    if (
      options !== undefined &&
      (!options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some(
          (key) => !['search', 'expectedRevision', 'occurrenceId'].includes(key)
        ) ||
        (options.occurrenceId !== undefined && !occurrenceId(options.occurrenceId)) ||
        (options.search !== undefined &&
          (typeof options.search !== 'string' || options.search.length > 32768)))
    )
      throw new Error('Invalid library queue read options')
    const bounds = libraryPageBounds(offset, limit),
      snapshot =
        options?.expectedRevision === undefined
          ? this.get(id)
          : this.expected(id, options.expectedRevision)
    const search = options?.search?.trim().toLocaleLowerCase('zh-CN') ?? ''
    const from = `FROM queue_entries q
      LEFT JOIN tracks t ON t.id=q.track_id LEFT JOIN queue_snapshots s ON s.queue_id=q.queue_id AND s.entry_id=q.entry_id`
    const matches = `library_metadata_contains(
      CASE WHEN s.entry_id IS NOT NULL THEN json_extract(s.payload,'$.title') ELSE t.title END,
      CASE WHEN s.entry_id IS NOT NULL THEN json_extract(s.payload,'$.artist') ELSE t.artist END,
      CASE WHEN s.entry_id IS NOT NULL THEN json_extract(s.payload,'$.album') ELSE t.album END,?)=1`
    const rows = this.owner.sql
      .prepare(
        `SELECT q.entry_id,q.position,COALESCE(s.payload,t.payload) AS payload ${from}
      WHERE q.queue_id=? AND ${options?.occurrenceId ? 'q.entry_id=?' : search ? matches : 'q.position>=?'} ORDER BY q.position LIMIT ? ${!options?.occurrenceId && search ? 'OFFSET ?' : ''}`
      )
      .all(
        ...(options?.occurrenceId
          ? [id, options.occurrenceId, 1]
          : search
            ? [id, search, bounds.limit, bounds.offset]
            : [id, bounds.offset, bounds.limit])
      ) as Row[]
    const total = search
      ? Number(
          this.owner.sql
            .prepare(`SELECT count(*) AS n ${from} WHERE q.queue_id=? AND ${matches}`)
            .get(id, search)!.n
        )
      : snapshot.total
    return {
      items: rows.map((row) => ({
        queueEntryId: String(row.entry_id),
        position: Number(row.position),
        track: row.payload ? JSON.parse(String(row.payload)) : null
      })),
      lastPlayablePosition: Number(
        this.row(
          `SELECT q.position FROM queue_entries q
        WHERE q.queue_id=? AND (EXISTS(SELECT 1 FROM tracks WHERE id=q.track_id)
          OR EXISTS(SELECT 1 FROM queue_snapshots WHERE queue_id=q.queue_id AND entry_id=q.entry_id))
        ORDER BY q.position DESC LIMIT 1`,
          id
        )?.position ?? -1
      ),
      total,
      revision: snapshot.revision,
      libraryRevision: this.owner.revision(),
      offset: bounds.offset
    }
  }
  neighbor(id: string, revision: number, index: number, direction: 1 | -1, wrap: boolean) {
    const queue = this.expected(id, revision)
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= queue.total ||
      ![1, -1].includes(direction) ||
      typeof wrap !== 'boolean'
    )
      throw new Error('Invalid queue navigation preview')
    const forward = direction === 1
    const from = `FROM queue_entries q WHERE q.queue_id=?
      AND (EXISTS(SELECT 1 FROM tracks WHERE id=q.track_id)
        OR EXISTS(SELECT 1 FROM queue_snapshots WHERE queue_id=q.queue_id AND entry_id=q.entry_id))`
    const order = `ORDER BY q.position ${forward ? 'ASC' : 'DESC'} LIMIT 1`
    const row =
      this.row(
        `SELECT q.position ${from} AND q.position ${forward ? '>' : '<'} ? ${order}`,
        id,
        index
      ) ?? (wrap ? this.row(`SELECT q.position ${from} ${order}`, id) : undefined)
    if (!row) return null
    const page = this.read(id, Number(row.position), 1, { expectedRevision: revision })
    return { ...page.items[0], logicalQueueEnd: Number(row.position) === page.lastPlayablePosition }
  }
  playbackWindow(id: string, revision: number, index: number, wrap: boolean) {
    const queue = this.expected(id, revision)
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= queue.total ||
      typeof wrap !== 'boolean'
    )
      throw new Error('Invalid queue playback window')
    const current = this.read(id, index, 1, { expectedRevision: revision })
    const next = this.neighbor(id, revision, index, 1, wrap)
    return {
      queue,
      libraryRevision: current.libraryRevision,
      lastPlayablePosition: current.lastPlayablePosition,
      items: next && next.position !== index ? [...current.items, next] : current.items
    }
  }
  exportPlayback(
    reference: LibraryPlaybackQueueReference,
    maxBytes: number,
    includeOriginalOrder = false
  ) {
    if (
      !isLibraryPlaybackQueueReference(reference) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 2 ||
      maxBytes > 32 * 1024 * 1024
    )
      throw new Error('Invalid playback queue export')
    return this.owner.transaction(() => {
      const snapshot = this.get(reference.id)
      if (snapshot.revision !== reference.revision)
        throw new Error('播放队列已变化，请保存播放会话后重新导出')
      const position = this.position(reference.id, reference.entryId)
      if (position !== reference.index || snapshot.selectedEntryId !== reference.entryId)
        throw new Error('播放队列已变化，请保存播放会话后重新导出')
      const queue: Record<string, unknown>[] = []
      let bytes = 2
      const rows = this.owner.sql
        .prepare(
          `SELECT q.entry_id,q.track_id,COALESCE(s.payload,t.payload) AS payload FROM queue_entries q
        LEFT JOIN tracks t ON t.id=q.track_id LEFT JOIN queue_snapshots s ON s.queue_id=q.queue_id AND s.entry_id=q.entry_id
        WHERE q.queue_id=? ORDER BY q.position`
        )
        .iterate(reference.id)
      for (const row of rows) {
        const track = row.payload
          ? JSON.parse(String(row.payload))
          : {
              id: String(row.track_id),
              source: 'local',
              filePath: ''
            }
        // Match the small portable queue contract: lyrics/analysis live in
        // their own domains and inline covers in the library/cache.
        const {
          lyrics: _lyrics,
          translatedLyrics: _translated,
          bpmAnalysis: _analysis,
          ...data
        } = track
        if (typeof data.cover === 'string' && /^(data:|blob:|twilight-media:)/i.test(data.cover))
          data.cover = null
        const json = JSON.stringify(
          { ...data, queueEntryId: String(row.entry_id) },
          personalBackupJsonReplacer
        )
        bytes += Buffer.byteLength(json, 'utf8') + (queue.length ? 1 : 0)
        if (bytes > maxBytes) throw new Error('播放快照超过保存容量，未截断导出')
        queue.push(JSON.parse(json))
      }
      if (queue.length !== snapshot.total) throw new Error('Incomplete playback queue export')
      if (includeOriginalOrder) {
        const originalQueueEntryIds = this.owner.sql
          .prepare('SELECT entry_id FROM queue_entries WHERE queue_id=? ORDER BY original_position')
          .all(reference.id)
          .map((row) => String(row.entry_id))
        if (bytes + Buffer.byteLength(JSON.stringify(originalQueueEntryIds)) + 64 > maxBytes)
          throw new Error('含原始顺序的播放快照超过保存容量，未截断导出')
        return {
          queue,
          queueIndex: position,
          libraryRevision: this.owner.revision(),
          originalQueueEntryIds
        }
      }
      return { queue, queueIndex: position, libraryRevision: this.owner.revision() }
    })
  }
  private expected(id: string, revision: number): LibraryQueueSnapshot {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid queue revision')
    const queue = this.get(id)
    if (queue.revision !== revision)
      throw Object.assign(new Error('Library queue changed concurrently'), {
        code: 'STALE_REVISION'
      })
    return queue
  }
  delete(id: string, revision: number): void {
    this.owner.transaction(() => {
      this.expected(id, revision)
      if (this.row('SELECT 1 FROM queue_references WHERE queue_id=? LIMIT 1', id))
        throw new Error('Library queue is still referenced')
      this.run("UPDATE queues SET state='abandoned' WHERE id=?", id)
      // Discard is immediately visible, but a late/stale play request must not
      // block the current queue while cascading through hundreds of thousands.
      this.cleanupRows(id)
    })
  }

  syncReferences(owner: string, ids: string[]): void {
    if (
      typeof owner !== 'string' ||
      !owner.trim() ||
      owner.length > 128 ||
      !Array.isArray(ids) ||
      ids.length > 100
    )
      throw new Error('Invalid library queue references')
    const unique = [...new Set(ids)]
    if (unique.some((id) => !entryId(id))) throw new Error('Invalid library queue reference')
    this.owner.transaction(() => {
      this.run('DELETE FROM queue_references WHERE owner=?', owner)
      if (unique.length)
        this.run(
          `INSERT INTO queue_references(owner,queue_id,updated_at)
           SELECT ?,id,? FROM queues WHERE state='ready' AND id IN (SELECT value FROM json_each(?))`,
          owner,
          Date.now(),
          JSON.stringify(unique)
        )
    })
  }

  collectGarbage(olderThanMs = 60 * 60 * 1000): number {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)
      throw new Error('Invalid queue GC age')
    const cutoff = Date.now() - olderThanMs
    let retired = 0
    this.owner.transaction(() => {
      const rows = this.owner.sql
        .prepare(
          `SELECT q.id FROM queues q WHERE q.state='ready' AND q.created_at<?
           AND NOT EXISTS(SELECT 1 FROM queue_references r WHERE r.queue_id=q.id)`
        )
        .all(cutoff) as Row[]
      for (const row of rows) {
        this.run("UPDATE queues SET state='abandoned' WHERE id=? AND state='ready'", String(row.id))
        retired++
      }
    })
    return retired
  }
  private position(id: string, entry: unknown, column = 'position'): number {
    if (!occurrenceId(entry)) throw new Error('Invalid queue entry identity')
    const row = this.row(
      `SELECT ${column} AS position FROM queue_entries WHERE queue_id=? AND entry_id=?`,
      id,
      entry
    )
    if (!row) throw new Error('Queue entry does not exist')
    return Number(row.position)
  }
  private normalize(id: string, column: 'position' | 'original_position', start: number): void {
    // Primary-key positions cannot be changed in place: SQLite checks each row
    // immediately. A disjoint negative staging domain prevents collisions.
    this.run(
      `INSERT INTO queue_reorder SELECT entry_id,row_number() OVER (ORDER BY ${column})-1+?
       FROM queue_entries WHERE queue_id=? AND ${column}>=?`,
      start,
      id,
      start
    )
    this.applyOrder(id, column)
  }
  private applyOrder(id: string, column: 'position' | 'original_position'): void {
    // Reorder only the affected suffix/permutation. Unchanged occurrences must
    // not dirty the whole queue's table and indexes for a one-row edit.
    this.run(
      `UPDATE queue_entries SET ${column}=-${column}-1 WHERE rowid IN (
        SELECT q.rowid FROM queue_reorder r CROSS JOIN queue_entries q ON q.entry_id=r.entry_id
        WHERE q.queue_id=? AND q.${column}>=0 AND q.${column}<>r.position)`,
      id
    )
    this.run(
      `UPDATE queue_entries SET ${column}=(SELECT position FROM queue_reorder WHERE queue_reorder.entry_id=queue_entries.entry_id)
       WHERE queue_id=? AND ${column}<0`,
      id
    )
    this.run('DELETE FROM queue_reorder')
  }
  private removeEntries(id: string, entries: unknown[]): void {
    const json = JSON.stringify(entries)
    const first = this.row(
      `SELECT min(position) AS position,min(original_position) AS original_position
       FROM queue_entries WHERE queue_id=? AND entry_id IN (SELECT value FROM json_each(?))`,
      id,
      json
    )!
    this.run(
      'DELETE FROM queue_entries WHERE queue_id=? AND entry_id IN (SELECT value FROM json_each(?))',
      id,
      json
    )
    if (first.position === null) return
    this.normalize(id, 'position', Number(first.position))
    this.normalize(id, 'original_position', Number(first.original_position))
  }
  private moveColumn(
    id: string,
    entry: string,
    column: 'position' | 'original_position',
    target: number
  ): void {
    const from = this.position(id, entry, column)
    if (target === from || target === from + 1) return
    const forward = target > from,
      start = forward ? from + 1 : target,
      end = forward ? target - 1 : from - 1
    // Park the moving occurrence outside the affected interval, then shift
    // only its neighbours through a collision-free negative staging domain.
    this.run(
      `UPDATE queue_entries SET ${column}=-${column}-1 WHERE queue_id=? AND entry_id=?`,
      id,
      entry
    )
    this.run(
      `UPDATE queue_entries SET ${column}=-${column}-1 WHERE queue_id=? AND ${column} BETWEEN ? AND ?`,
      id,
      start,
      end
    )
    this.run(
      `UPDATE queue_entries SET ${column}=-${column}-1+? WHERE queue_id=? AND ${column} BETWEEN ? AND ?`,
      forward ? -1 : 1,
      id,
      -end - 1,
      -start - 1
    )
    this.run(
      `UPDATE queue_entries SET ${column}=? WHERE queue_id=? AND entry_id=?`,
      forward ? target - 1 : target,
      id,
      entry
    )
  }
  private shift(
    id: string,
    column: 'position' | 'original_position',
    start: number,
    by: number
  ): void {
    this.run(
      `UPDATE queue_entries SET ${column}=-${column}-1 WHERE queue_id=? AND ${column}>=?`,
      id,
      start
    )
    this.run(
      `UPDATE queue_entries SET ${column}=-${column}-1+? WHERE queue_id=? AND ${column}<0`,
      by,
      id
    )
  }
  private restoreCursor(id: string, previous: LibraryQueueSnapshot): void {
    if (
      previous.selectedEntryId &&
      this.row(
        'SELECT 1 AS n FROM queue_entries WHERE queue_id=? AND entry_id=?',
        id,
        previous.selectedEntryId
      )
    )
      return
    const next = this.row(
      'SELECT entry_id FROM queue_entries WHERE queue_id=? ORDER BY abs(position-?),position DESC LIMIT 1',
      id,
      Math.max(0, previous.index)
    )
    this.run('UPDATE queues SET selected_entry=? WHERE id=?', next?.entry_id ?? null, id)
  }

  private history(
    id: string,
    revision: number,
    kind: QueueHistory['kind'],
    payload: Record<string, unknown>,
    rows: true | string[] | false = false
  ): number {
    const result = this.run(
      'INSERT INTO queue_history(queue_id,revision,kind,payload) VALUES(?,?,?,?)',
      id,
      revision,
      kind,
      JSON.stringify(payload)
    )
    const historyId = Number(result.lastInsertRowid)
    if (rows) {
      const filter = rows === true ? '' : ' AND q.entry_id IN (SELECT value FROM json_each(?))'
      this.run(
        `INSERT INTO queue_history_entries(history_id,position,original_position,entry_id,track_id,snapshot)
         SELECT ?,q.position,q.original_position,q.entry_id,q.track_id,s.payload
         FROM queue_entries q LEFT JOIN queue_snapshots s ON s.queue_id=q.queue_id AND s.entry_id=q.entry_id
         WHERE q.queue_id=?${filter}`,
        ...(rows === true ? [historyId, id] : [historyId, id, JSON.stringify(rows)])
      )
    }
    this.run(
      `DELETE FROM queue_history WHERE queue_id=? AND id NOT IN
       (SELECT id FROM queue_history WHERE queue_id=? ORDER BY id DESC LIMIT ?)`,
      id,
      id,
      MAX_QUEUE_HISTORY
    )
    return historyId
  }

  private latestHistory(id: string, revision: number): QueueHistory | null {
    const row = this.row(
      'SELECT id,kind,payload FROM queue_history WHERE queue_id=? AND revision=? ORDER BY id DESC LIMIT 1',
      id,
      revision
    )
    if (!row) return null
    return {
      id: Number(row.id),
      kind: row.kind as QueueHistory['kind'],
      payload: JSON.parse(String(row.payload)) as Record<string, unknown>
    }
  }

  private prepareReorder(): void {
    this.owner.sql.exec(
      'CREATE TEMP TABLE IF NOT EXISTS queue_reorder(entry_id TEXT PRIMARY KEY,position INTEGER NOT NULL); DELETE FROM queue_reorder;'
    )
  }

  private restoreHistoryRows(id: string, historyId: number, clearExisting: boolean): void {
    const temporary = this.get(id).total
    if (clearExisting) this.run('DELETE FROM queue_entries WHERE queue_id=?', id)
    // Deleted rows use a negative temporary position so the queue primary key
    // remains collision-free until both historical orders are applied.
    this.run(
      `INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position)
       SELECT ?,-?-row_number() OVER (ORDER BY h.position),h.entry_id,h.track_id,
         -?-row_number() OVER (ORDER BY h.position)
       FROM queue_history_entries h WHERE h.history_id=?
       AND NOT EXISTS(SELECT 1 FROM queue_entries q WHERE q.queue_id=? AND q.entry_id=h.entry_id)`,
      id,
      temporary,
      temporary,
      historyId,
      id
    )
    this.run(
      `INSERT INTO queue_snapshots(queue_id,entry_id,payload)
       SELECT q.queue_id,h.entry_id,h.snapshot FROM queue_history_entries h
       JOIN queue_entries q ON q.entry_id=h.entry_id
       WHERE h.history_id=? AND q.queue_id=? AND q.position<0 AND h.snapshot IS NOT NULL`,
      historyId,
      id
    )
    this.owner.sql.exec(`CREATE TEMP TABLE IF NOT EXISTS queue_restore_gaps(
      position INTEGER PRIMARY KEY,delta INTEGER NOT NULL);`)
    for (const column of ['position', 'original_position'] as const) {
      this.run('DELETE FROM queue_restore_gaps')
      // The kth removed position h opens a gap at h-k in the compressed order,
      // not at h. Consecutive removals share a threshold; retain its full delta.
      this.run(
        `INSERT INTO queue_restore_gaps
         SELECT threshold,max(delta) FROM (
           SELECT ${column}-row_number() OVER (ORDER BY ${column})+1 AS threshold,
             row_number() OVER (ORDER BY ${column}) AS delta
           FROM queue_history_entries WHERE history_id=?) GROUP BY threshold`,
        historyId
      )
      this.run(
        `INSERT INTO queue_reorder(entry_id,position)
         SELECT q.entry_id,q.${column}+COALESCE((SELECT delta FROM queue_restore_gaps
           WHERE position<=q.${column} ORDER BY position DESC LIMIT 1),0)
         FROM queue_entries q WHERE q.queue_id=?
           AND q.${column}>=(SELECT min(position) FROM queue_restore_gaps)
           AND NOT EXISTS(SELECT 1 FROM queue_history_entries h WHERE h.history_id=? AND h.entry_id=q.entry_id)
         UNION ALL SELECT entry_id,${column} FROM queue_history_entries WHERE history_id=?`,
        id,
        historyId,
        historyId
      )
      this.applyOrder(id, column)
    }
    this.run('DELETE FROM queue_restore_gaps')
  }

  private undo(id: string, revision: number): LibraryQueueEditResult {
    return this.owner.transaction(() => {
      const current = this.expected(id, revision)
      const history = this.latestHistory(id, revision)
      if (!history) throw new Error('没有可撤销的队列操作')
      this.prepareReorder()
      const payload = history.payload
      switch (history.kind) {
        case 'insert': {
          const ids = Array.isArray(payload.entryIds) ? payload.entryIds : []
          this.removeEntries(id, ids)
          this.run('UPDATE queues SET total_count=total_count-? WHERE id=?', ids.length, id)
          break
        }
        case 'remove':
          this.restoreHistoryRows(id, history.id, false)
          break
        case 'clear':
          this.restoreHistoryRows(id, history.id, true)
          break
        case 'order':
          this.restoreHistoryRows(id, history.id, false)
          break
        case 'move': {
          const entryId = String(payload.entryId)
          for (const [column, before] of [
            ['position', payload.beforePositionEntryId],
            ['original_position', payload.beforeOriginalEntryId]
          ] as const)
            this.moveColumn(
              id,
              entryId,
              column,
              typeof before === 'string' ? this.position(id, before, column) : current.total
            )
          break
        }
      }
      this.run(
        'UPDATE queues SET total_count=?,ordering=?,selected_entry=?,play_mode=? WHERE id=?',
        Number(payload.total ?? current.total),
        payload.order === 'shuffle' ? 'shuffle' : 'original',
        typeof payload.selectedEntryId === 'string' ? payload.selectedEntryId : null,
        typeof payload.playMode === 'string' ? payload.playMode : null,
        id
      )
      this.run('UPDATE queues SET revision=revision+1 WHERE id=?', id)
      this.run('DELETE FROM queue_history WHERE id=?', history.id)
      // Undo advances CAS rather than restoring an old revision. Rebase only
      // the recorded adjacent predecessor; cursor edits must still break undo.
      if (typeof payload.previousHistoryId === 'number')
        this.run(
          'UPDATE queue_history SET revision=? WHERE queue_id=? AND id=?',
          revision + 1,
          id,
          payload.previousHistoryId
        )
      return { queue: this.get(id), reachedEnd: false }
    })
  }
  extend(id: string, revision: number, items: LibraryQueueInsertItem[]): LibraryQueueEditResult {
    if (!Array.isArray(items) || items.length > 200)
      throw new Error('Invalid or oversized automatic queue extension')
    validateLibraryQueueEdit({ kind: 'insert', items }, true)
    return this.edit(id, revision, { kind: 'insert', items }, true)
  }
  edit(
    id: string,
    revision: number,
    edit: LibraryQueueEdit,
    extension = false,
    coreOwned = false
  ): LibraryQueueEditResult {
    if (edit?.kind === 'undo') return this.undo(id, revision)
    return this.owner.transaction(() => {
      const previous = this.expected(id, revision)
      if (!edit || typeof edit !== 'object' || Array.isArray(edit))
        throw new Error('Invalid queue edit')
      if (!extension) validateLibraryQueueEdit(edit, coreOwned, coreOwned)
      if (extension && edit.kind === 'insert') {
        const items = edit.items!
        const known = new Set(
          (
            this.owner.sql
              .prepare(
                'SELECT DISTINCT track_id FROM queue_entries WHERE queue_id=? AND track_id IN (SELECT value FROM json_each(?))'
              )
              .all(id, JSON.stringify(items.map((item) => item.id))) as Row[]
          ).map((row) => row.track_id)
        )
        edit = {
          kind: 'insert',
          items: items.filter((item) => {
            if (known.has(item.id)) return false
            known.add(item.id)
            return true
          })
        }
      }
      this.prepareReorder()
      let changed = false,
        reachedEnd = false,
        historyId: number | null = null
      let historyKind: QueueHistory['kind'] | null = null
      const historyPayload: Record<string, unknown> = {
        previousHistoryId: this.latestHistory(id, previous.revision)?.id ?? null,
        total: previous.total,
        order: previous.order,
        playMode: previous.playMode ?? null,
        selectedEntryId: previous.selectedEntryId
      }
      switch (edit.kind) {
        case 'select': {
          this.position(id, edit.entryId)
          changed = edit.entryId !== previous.selectedEntryId
          if (changed) this.run('UPDATE queues SET selected_entry=? WHERE id=?', edit.entryId, id)
          break
        }
        case 'step': {
          if (![1, -1].includes(edit.direction) || typeof edit.wrap !== 'boolean')
            throw new Error('Invalid queue navigation')
          const forward = edit.direction === 1
          const row = this.row(
            `SELECT q.entry_id FROM queue_entries q
            WHERE q.queue_id=? AND q.position ${forward ? '>' : '<'} ?
            AND (EXISTS(SELECT 1 FROM tracks WHERE id=q.track_id) OR EXISTS(SELECT 1 FROM queue_snapshots WHERE queue_id=q.queue_id AND entry_id=q.entry_id))
            ORDER BY q.position ${forward ? 'ASC' : 'DESC'} LIMIT 1`,
            id,
            previous.index < 0 ? (forward ? -1 : previous.total) : previous.index
          )
          const next =
            row ??
            (edit.wrap
              ? this.row(
                  `SELECT q.entry_id FROM queue_entries q WHERE q.queue_id=?
                  AND (EXISTS(SELECT 1 FROM tracks WHERE id=q.track_id) OR EXISTS(SELECT 1 FROM queue_snapshots WHERE queue_id=q.queue_id AND entry_id=q.entry_id))
                  ORDER BY q.position ${forward ? 'ASC' : 'DESC'} LIMIT 1`,
                  id
                )
              : undefined)
          reachedEnd = !next
          changed = !!next && next.entry_id !== previous.selectedEntryId
          if (changed) this.run('UPDATE queues SET selected_entry=? WHERE id=?', next!.entry_id, id)
          break
        }
        case 'insert': {
          let items: Array<LibraryQueueInsertItem & { entryId: string; originalOffset: number }> = (
            edit.items ?? edit.trackIds!.map((id) => ({ id }))
          ).map((item, originalOffset) => ({ ...item, entryId: randomUUID(), originalOffset }))
          if (extension && previous.order === 'shuffle') items = shuffleArray(items)
          const localIds = items.filter((item) => !item.snapshot).map((item) => item.id)
          const found = Number(
            this.row(
              'SELECT count(*) AS n FROM json_each(?) j JOIN tracks t ON t.id=j.value',
              JSON.stringify(localIds)
            )!.n
          )
          if (found !== localIds.length) throw new Error('Cannot queue a missing library track')
          if (!items.length) break
          const anchor = edit.beforeEntryId ?? edit.afterEntryId
          const delta = edit.afterEntryId !== undefined ? 1 : 0
          const position = anchor === undefined ? previous.total : this.position(id, anchor) + delta
          const original =
            anchor === undefined
              ? previous.total
              : this.position(id, anchor, 'original_position') + delta
          this.shift(id, 'position', position, items.length)
          this.shift(id, 'original_position', original, items.length)
          this.run(
            `INSERT INTO queue_entries(queue_id,position,entry_id,track_id,original_position)
            SELECT ?,CAST(j.key AS INTEGER)+?,json_extract(j.value,'$.entryId'),json_extract(j.value,'$.id'),json_extract(j.value,'$.originalOffset')+? FROM json_each(?) j`,
            id,
            position,
            original,
            JSON.stringify(items)
          )
          this.run(
            `INSERT INTO queue_snapshots(queue_id,entry_id,payload)
            SELECT q.queue_id,q.entry_id,json_extract(j.value,'$.snapshot')
            FROM json_each(?) j
            CROSS JOIN queue_entries q ON q.queue_id=? AND q.position=CAST(j.key AS INTEGER)+?
            WHERE json_type(j.value,'$.snapshot')='object'`,
            JSON.stringify(items),
            id,
            position
          )
          this.run('UPDATE queues SET total_count=total_count+? WHERE id=?', items.length, id)
          historyKind = 'insert'
          historyPayload.entryIds = items.map(
            (item) => (item as LibraryQueueInsertItem & { entryId: string }).entryId
          )
          changed = true
          break
        }
        case 'remove': {
          if (
            !Array.isArray(edit.entryIds) ||
            edit.entryIds.length > 1000 ||
            edit.entryIds.some((value) => !occurrenceId(value))
          )
            throw new Error('Invalid queue removal batch')
          const count = Number(
            this.row(
              'SELECT count(*) AS n FROM queue_entries WHERE queue_id=? AND entry_id IN (SELECT value FROM json_each(?))',
              id,
              JSON.stringify(edit.entryIds)
            )!.n
          )
          if (count !== new Set(edit.entryIds).size) throw new Error('Queue entry does not exist')
          if (!count) break
          historyKind = 'remove'
          historyId = this.history(
            id,
            previous.revision + 1,
            historyKind,
            historyPayload,
            edit.entryIds
          )
          this.removeEntries(id, edit.entryIds)
          this.run('UPDATE queues SET total_count=total_count-? WHERE id=?', count, id)
          changed = true
          break
        }
        case 'move': {
          const from = this.position(id, edit.entryId)
          const beforePositionEntryId =
            (this.row(
              'SELECT entry_id FROM queue_entries WHERE queue_id=? AND position=?',
              id,
              from + 1
            )?.entry_id as string | undefined) ?? null
          const fromOriginal = this.position(id, edit.entryId, 'original_position')
          const beforeOriginalEntryId =
            (this.row(
              'SELECT entry_id FROM queue_entries WHERE queue_id=? AND original_position=?',
              id,
              fromOriginal + 1
            )?.entry_id as string | undefined) ?? null
          const target =
            edit.beforeEntryId === null ? previous.total : this.position(id, edit.beforeEntryId)
          if (target === from || target === from + 1) break
          historyKind = 'move'
          historyPayload.entryId = edit.entryId
          historyPayload.beforePositionEntryId = beforePositionEntryId
          historyPayload.beforeOriginalEntryId = beforeOriginalEntryId
          historyId = this.history(id, previous.revision + 1, historyKind, historyPayload)
          // Apply the same occurrence-anchor move to both orders, preserving
          // explicit edits when leaving shuffle (matching the small-array queue).
          for (const column of ['position', 'original_position'] as const) {
            const anchor =
              edit.beforeEntryId === null
                ? previous.total
                : this.position(id, edit.beforeEntryId, column)
            this.moveColumn(id, edit.entryId, column, anchor)
          }
          changed = true
          break
        }
        case 'mode':
        case 'order': {
          const order =
            edit.kind === 'mode' ? (edit.mode === 'shuffle' ? 'shuffle' : 'original') : edit.order
          if (!['original', 'shuffle'].includes(order)) throw new Error('Invalid queue ordering')
          // Existing order-only callers retain their ordering contract. Once a
          // mode is bound, keep it consistent when those callers exit shuffle.
          const mode =
            edit.kind === 'mode'
              ? edit.mode
              : previous.playMode === undefined
                ? undefined
                : order === 'shuffle'
                  ? 'shuffle'
                  : previous.playMode === 'shuffle'
                    ? 'sequential'
                    : previous.playMode
          if (mode !== previous.playMode) {
            this.run('UPDATE queues SET play_mode=? WHERE id=?', mode ?? null, id)
            changed = true
          }
          if (order === previous.order) break
          historyKind = 'order'
          historyId = this.history(id, previous.revision + 1, historyKind, historyPayload, true)
          if (order === 'shuffle')
            this.run(
              `INSERT INTO queue_reorder SELECT entry_id,row_number() OVER (ORDER BY entry_id IS NOT ?,random())-1 FROM queue_entries WHERE queue_id=?`,
              previous.selectedEntryId,
              id
            )
          else
            this.run(
              'INSERT INTO queue_reorder SELECT entry_id,original_position FROM queue_entries WHERE queue_id=?',
              id
            )
          this.applyOrder(id, 'position')
          this.run('UPDATE queues SET ordering=? WHERE id=?', order, id)
          changed = true
          break
        }
        case 'clear':
          changed = previous.total > 0
          if (changed) {
            historyKind = 'clear'
            historyId = this.history(id, previous.revision + 1, historyKind, historyPayload, true)
            this.run('DELETE FROM queue_entries WHERE queue_id=?', id)
            this.run('UPDATE queues SET total_count=0 WHERE id=?', id)
          }
          break
        default:
          throw new Error('Unknown queue edit')
      }
      if (changed) {
        this.restoreCursor(id, previous)
        this.run('UPDATE queues SET revision=revision+1 WHERE id=?', id)
        if (historyKind === 'insert' && !extension)
          historyId = this.history(id, previous.revision + 1, historyKind, historyPayload)
      } else if (historyId !== null) {
        this.run('DELETE FROM queue_history WHERE id=?', historyId)
      }
      return { queue: this.get(id), reachedEnd }
    })
  }
}
