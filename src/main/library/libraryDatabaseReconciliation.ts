import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { getTrackSource, versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import { emptyMusicVersions, parseMusicVersions } from '../../shared/musicVersions.ts'

export type ReconciliationSeverity = 'error' | 'pending' | 'retained' | 'inventory'
export interface MusicLibraryReconciliationCheck {
  id: string
  severity: ReconciliationSeverity
  meaning: string
  count: number
  examples: Record<string, string | number | null>[]
}
export interface MusicLibraryReconciliationReport {
  format: 'twilight-music-library-reconciliation'
  version: 1
  schema: number
  exampleLimit: number
  revisions: Record<string, string | number | null>
  coverage: { versionsAuthority: boolean; versionsAuthoritySource: 'none' | 'snapshot' | 'core-state'; coreStateMigration: string | null; limits: string[] }
  checks: MusicLibraryReconciliationCheck[]
  summary: { errorChecks: number; pendingChecks: number; state: 'needs-repair' | 'needs-review' | 'consistent' }
}
export interface MusicLibraryReconciliationOptions {
  /** The existing versions document, explicitly selected by the operator; never discovered on disk. */
  versionsJson?: string
  versionsRevision?: number
  /** Production authority, explicitly selected; mutually exclusive with a JSON snapshot. */
  coreStatePath?: string
  exampleLimit?: number
}

interface CoreVersionsSnapshot { json: string; revision: number; migration: 'complete' | 'pending' | 'absent' }
function withCoreVersions<T>(path: string, action: (snapshot: CoreVersionsSnapshot) => T): T {
  const sql = new DatabaseSync(path, { readOnly: true })
  try {
    sql.exec('PRAGMA query_only=ON;BEGIN')
    const revision = Number(sql.prepare("SELECT revision FROM core_domain_revisions WHERE domain='versions'").get()?.revision)
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Core state has no valid versions revision')
    const budget = sql.prepare("SELECT count(*) rows,coalesce(sum(length(CAST(value AS BLOB))+length(CAST(key AS BLOB))),0) bytes FROM core_state WHERE domain='versions'").get()!
    if (Number(budget.rows) > 60000 || Number(budget.bytes) > 8 * 1024 * 1024) throw new Error('Core versions authority exceeds its bounded document budget')
    const document = emptyMusicVersions()
    for (const row of sql.prepare("SELECT key,value FROM core_state WHERE domain='versions' ORDER BY key").iterate()) {
      const match = /^(tracks|albums):(versions|families):(.+)$/u.exec(String(row.key))
      const value = JSON.parse(String(row.value))
      if (!match || !value || value.id !== match[3]) throw new Error('Invalid Core versions row identity')
      const scope = match[1] as 'tracks' | 'albums', kind = match[2] as 'versions' | 'families'
      ;(document[scope][kind] as unknown[]).push(value)
    }
    // Current Core state has a singleton unique index. Aggregating also keeps a
    // caller-selected old/inconsistent file from hiding a pending migration.
    const migration = sql.prepare('SELECT count(*) rows,min(complete) complete FROM core_migrations').get()!
    const result = action({ json: JSON.stringify(document), revision, migration: Number(migration.rows) ? migration.complete === 1 ? 'complete' : 'pending' : 'absent' })
    sql.exec('COMMIT')
    return result
  } catch (error) { if (sql.isTransaction) sql.exec('ROLLBACK'); throw error }
  finally { sql.close() }
}

const safeJson = (expression: string, fallback = '{}') => `(CASE WHEN json_valid(${expression}) THEN ${expression} ELSE '${fallback}' END)`
const json = (expression: string, path: string) => `json_extract(${safeJson(expression)},'${path}')`
const targetCte = (table: string) => `WITH targets AS (SELECT *,${safeJson('target_key', '[]')} decoded FROM ${table}), decoded AS (
  SELECT *,json_extract(decoded,'$[0]') scope,json_extract(decoded,'$[1]') target_kind,json_extract(decoded,'$[2]') target_id FROM targets)`
const validTarget = `json_type(decoded)='array' AND json_array_length(decoded)=3
  AND scope IN ('entity','identity') AND target_kind=kind AND json_type(decoded,'$[2]')='text' AND length(target_id)>0`
const legacySnapshots = `WITH snapshots AS (
  SELECT plugin_id,legacy_id,-1 snapshot_revision,payload FROM metadata_legacy_albums
  UNION ALL SELECT h.plugin_id,a.key,h.revision,a.value FROM metadata_legacy_history h,
    json_each(${safeJson('h.payload')},'$.albums') a WHERE a.type='object'
), provenance AS (SELECT s.*,p.disposition provenance FROM snapshots s LEFT JOIN metadata_legacy_provenance p
  ON p.plugin_id=s.plugin_id AND p.legacy_id=s.legacy_id AND p.snapshot_revision=s.snapshot_revision
  AND p.field='description' AND p.value=json_quote(${json('s.payload', '$.description')}))`

/** Audit inputs and retained order of the existing default-collection overlay,
 * without loading the playlist or all Track DTOs into JS. */
const favoritesCte = `WITH documents AS (
  SELECT d.default_id,p.value playlist FROM personal_preference_playlists d,
    json_each(${safeJson('d.payload', '[]')}) p WHERE ${json('p.value', '$.id')}=d.default_id
), rows AS (
  SELECT d.default_id,CAST(i.key AS INTEGER) position,i.value track_id,
    coalesce((SELECT s.value FROM json_each(d.playlist,'$.trackSnapshots') s WHERE s.key=i.value),
      (SELECT json_set(payload,'$.source',coalesce(json_extract(payload,'$.source'),'local')) FROM tracks WHERE id=i.value),
      (SELECT min(payload) FROM catalog_sources WHERE track_id=i.value HAVING count(*)=1)) snapshot
  FROM documents d,json_each(d.playlist,'$.trackIds') i
), resolved AS (
  SELECT r.*,s.id source_id,s.recording_id,
    CASE WHEN l.state='confirmed' THEN json_array('identity','recording',l.target_id)
      ELSE json_array('entity','recording',s.recording_id) END target_key,
    EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id) in_library
  FROM rows r LEFT JOIN catalog_sources s ON s.source_key=twilight_reconciliation_source_key(r.snapshot)
  LEFT JOIN metadata_identity_links l ON l.entity_id=s.recording_id AND l.kind='recording'
), valued AS (SELECT r.*,v.state FROM resolved r LEFT JOIN personal_preference_values v
  ON v.profile_id='default' AND v.target_key=r.target_key),
visible AS (SELECT * FROM valued WHERE source_id IS NULL OR state IS NULL OR state='favorite'),
candidates AS (
  SELECT s.id source_id,s.track_id,
    CASE WHEN l.state='confirmed' THEN json_array('identity','recording',l.target_id)
      ELSE json_array('entity','recording',s.recording_id) END target_key
  FROM catalog_sources s LEFT JOIN metadata_identity_links l ON l.entity_id=s.recording_id AND l.kind='recording'
), appendable AS (
  SELECT c.*,row_number() OVER(PARTITION BY c.target_key ORDER BY c.source_id) choice
  FROM candidates c JOIN personal_preference_values v ON v.profile_id='default' AND v.target_key=c.target_key AND v.state='favorite'
  WHERE NOT EXISTS(SELECT 1 FROM visible r WHERE r.source_id IS NOT NULL AND r.state='favorite' AND r.target_key=c.target_key)
    AND NOT EXISTS(SELECT 1 FROM visible r WHERE r.track_id=c.track_id)
)`

/** A read-only, consistent SQLite snapshot. Counts run over the complete tables;
 * only a fixed number of scalar examples leave SQLite. No migration, backfill,
 * source resolution, networking or file-existence probe is performed. */
export function reconcileMusicLibrary(sql: DatabaseSync, options: MusicLibraryReconciliationOptions = {}): MusicLibraryReconciliationReport {
  if (options.coreStatePath !== undefined) {
    if (!options.coreStatePath || options.versionsJson !== undefined || options.versionsRevision !== undefined) throw new Error('Select either --core-state or a versions JSON snapshot, not both')
    return withCoreVersions(options.coreStatePath, snapshot => reconcileSnapshot(sql, {
      ...options, coreStatePath: undefined, versionsJson: snapshot.json, versionsRevision: snapshot.revision
    }, snapshot))
  }
  return reconcileSnapshot(sql, options)
}

function reconcileSnapshot(sql: DatabaseSync, options: MusicLibraryReconciliationOptions, coreSnapshot?: CoreVersionsSnapshot): MusicLibraryReconciliationReport {
  const limit = options.exampleLimit ?? 10
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100) throw new Error('exampleLimit must be between 0 and 100')
  if (options.versionsRevision !== undefined && (!Number.isSafeInteger(options.versionsRevision) || options.versionsRevision < 0 || options.versionsJson === undefined))
    throw new Error('versionsRevision requires an explicit versions document and a non-negative integer')
  const authority = options.versionsJson === undefined ? undefined : parseMusicVersions(options.versionsJson)
  const authorityJson = authority ? JSON.stringify(authority) : undefined
  // The shared identity function avoids a second interpretation of CUE, path case,
  // provider aliases or native IDs. SQL invokes it per row, never on a JS array.
  sql.function('twilight_reconciliation_source_key', { deterministic: true }, raw => {
    try {
      const value = JSON.parse(String(raw))
      return value && typeof value.id === 'string' && (value.source === undefined || typeof value.source === 'string')
        ? versionSourceKey(value) : null
    } catch { return null }
  })
  sql.function('twilight_reconciliation_provider', { deterministic: true }, raw => {
    try { const value = JSON.parse(String(raw)); return value && typeof value.id === 'string' ? getTrackSource(value) : null }
    catch { return null }
  })
  if (sql.isTransaction) throw new Error('Reconciliation requires its own read snapshot')
  sql.exec('BEGIN')
  try {
    const schema = Number(sql.prepare('PRAGMA user_version').get()!.user_version)
    if (schema !== 28 && schema !== 29 && schema !== 30) throw new Error(`Reconciliation supports library schemas 28, 29 and 30, received ${schema}; it does not migrate databases`)
    const scalar = (query: string, args: SQLInputValue[] = []) => Number(sql.prepare(query).get(...args)!.n)
    const revisions: MusicLibraryReconciliationReport['revisions'] = {}
    for (const row of sql.prepare(`SELECT 'catalog:'||key name,value FROM catalog_state WHERE key IN ('revision','versions_revision','playlists_revision','local_cursor','local_horizon','project_cursor','project_horizon')
      UNION ALL SELECT 'metadata:'||key,value FROM meta WHERE key IN ('revision','metadata_revision')
      UNION ALL SELECT 'ratings',revision FROM personal_ratings_state
      UNION ALL SELECT 'preferences',revision FROM personal_preferences_state
      UNION ALL SELECT 'tags',revision FROM personal_tags_state
      UNION ALL SELECT 'metadata:browse',metadata_revision FROM music_browse_state
      UNION ALL SELECT 'genres:'||key,value FROM music_genre_state WHERE key IN ('revision','dictionary_version')
      UNION ALL SELECT 'exploration',revision FROM music_exploration_state`).all()) revisions[String(row.name)] = row.value as string | number | null
    const checks: MusicLibraryReconciliationCheck[] = []
    const add = (id: string, severity: ReconciliationSeverity, meaning: string, query: string, args: SQLInputValue[] = []) => {
      const count = scalar(`SELECT count(*) n FROM (${query})`, args)
      const examples = count && limit ? sql.prepare(`SELECT * FROM (${query}) ORDER BY 1,2 LIMIT ?`).all(...args, limit).map(row =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' || value === null ? value : String(value).slice(0, 400)]))) : []
      checks.push({ id, severity, meaning, count, examples })
    }
    if (coreSnapshot) {
      revisions['versions:core-state'] = coreSnapshot.revision
      add('versions.core-migration', 'pending', 'Core browser 迁移未完成或尚未发布，当前版本权威须等正常初始化完成后复跑。',
        `SELECT 'core-state' owner,? state WHERE ?<>'complete'`, [coreSnapshot.migration, coreSnapshot.migration])
    }
    add('references.foreign-key', 'error', '真实外键断裂；可与下列领域检查重叠，不能相加当作损坏实体数。',
      `SELECT "table" object,rowid row_id,parent, fkid FROM pragma_foreign_key_check`)
    add('metadata.invalid-json', 'error', '权威资料 JSON 无法解析时不把缺失字段计为合法清空。',
      `SELECT 'metadata_overrides' object,entity_id record_id FROM metadata_overrides WHERE NOT json_valid(payload)
      UNION ALL SELECT 'metadata_artwork_overrides',entity_id FROM metadata_artwork_overrides WHERE NOT json_valid(payload)
      UNION ALL SELECT 'metadata_legacy_albums',plugin_id||':'||legacy_id FROM metadata_legacy_albums WHERE NOT json_valid(payload)
      UNION ALL SELECT 'metadata_legacy_history',plugin_id||':'||revision FROM metadata_legacy_history WHERE NOT json_valid(payload)`)
    add('catalog.actual-members', 'inventory', '已发布的真实成员；同一来源属于多个 owner 时仅计一次。未完成本地索引另列 pending。',
      `SELECT s.id source_id,s.provider,s.track_id,s.availability FROM catalog_sources s WHERE EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
      AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id) AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))`)
    add('catalog.retained-nonmembers', 'retained', '缓存目录或个人数据保留的来源，不是实际库成员。',
      `SELECT s.id source_id,s.provider,s.track_id FROM catalog_sources s WHERE NOT EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)`)
    add('catalog.offline-members', 'retained', '来源标为 missing/unknown 的成员；不探测磁盘或流媒体账号，不视为坏引用。',
      `SELECT s.id source_id,s.provider,s.availability FROM catalog_sources s WHERE s.availability<>'indexed' AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)`)
    add('catalog.pending-local', 'pending', '本地变更尚未完成投影；先由正常索引推进，再重新对账。', `SELECT track_id, 'queued' state FROM catalog_pending`)
    add('catalog.local-backfill', 'pending', '尚未完成的初次本地目录回填。', `SELECT 'local' stage,h.value horizon,c.value cursor FROM catalog_state h JOIN catalog_state c ON c.key='local_cursor' WHERE h.key='local_horizon' AND CAST(c.value AS INTEGER)<CAST(h.value AS INTEGER)`)
    add('catalog.project-backfill', 'pending', '尚未完成的专辑项目回填；对账不会推进或改写索引。', `SELECT 'project' stage,h.value horizon,c.value cursor FROM catalog_state h JOIN catalog_state c ON c.key='project_cursor' WHERE h.key='project_horizon' AND CAST(c.value AS INTEGER)<CAST(h.value AS INTEGER)`)
    add('catalog.members-without-local-track', 'error', '非 pending 的 local 成员缺少本地权威记录；正常删除后应保留来源但移除成员。',
      `SELECT s.id source_id,s.track_id FROM catalog_sources s JOIN catalog_memberships m ON m.source_id=s.id AND m.owner='local'
      WHERE s.provider='local' AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id) AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)`)
    add('catalog.source-mapping', 'error', '来源键、provider、track ID 和录音别名必须匹配精确身份。本地公开快照不含路径，仅核对有权威记录且非 pending 的活跃成员；离线键保留。',
      `SELECT s.id source_id,s.provider,s.track_id FROM catalog_sources s WHERE
      (s.provider<>'local' AND s.source_key IS NOT twilight_reconciliation_source_key(s.payload))
      OR (s.provider='local' AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id AND m.owner='local')
        AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)
        AND EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id AND s.source_key IS NOT twilight_reconciliation_source_key(json_set(t.payload,'$.source',coalesce(json_extract(t.payload,'$.source'),'local')))))
      OR s.provider IS NOT twilight_reconciliation_provider(s.payload) OR s.track_id IS NOT ${json('s.payload', '$.id')}
      OR NOT EXISTS(SELECT 1 FROM catalog_aliases a WHERE a.namespace='source.recording' AND a.key=s.source_key AND a.entity_id=s.recording_id)`)
    add('catalog.source-entity-kind', 'error', '来源录音/发行/人物引用必须指向对应种类。',
      `SELECT s.id source_id,'recording/release' reference FROM catalog_sources s LEFT JOIN catalog_entities r ON r.id=s.recording_id LEFT JOIN catalog_entities a ON a.id=s.release_id
      WHERE r.kind IS NOT 'recording' OR (s.release_id IS NOT NULL AND a.kind IS NOT 'release')
      UNION ALL SELECT a.source_id,'artist' FROM catalog_source_artists a LEFT JOIN catalog_entities e ON e.id=a.artist_id WHERE e.kind IS NOT 'artist'`)
    add('catalog.project-kind', 'error', '专辑项目和具体发行保持不同层级。', `SELECT p.release_id,p.project_id FROM catalog_release_projects p
      LEFT JOIN catalog_entities r ON r.id=p.release_id LEFT JOIN catalog_entities a ON a.id=p.project_id WHERE r.kind IS NOT 'release' OR a.kind IS NOT 'album_project'`)
    add('catalog.retained-entities', 'retained', '无直接来源的稳定锚点包括便携恢复、人物作品、已拆分版本及历史个人数据。',
      `SELECT e.id entity_id,e.kind,e.identity FROM catalog_entities e WHERE NOT EXISTS(SELECT 1 FROM catalog_entity_sources s WHERE s.entity_id=e.id)`)
    add('restore.offline-sources', 'retained', '只恢复 music 域留下的来源描述，不会自动变为可播放曲目。',
      `SELECT json_extract(j.value,'$.id') source_id,json_extract(j.value,'$.provider') provider FROM meta m,json_each(json_extract(${safeJson('m.value', '[]')},'$')) j WHERE m.key='music_backup_offline_sources'`)
    for (const [name, table] of [['ratings', 'personal_rating_values'], ['preferences', 'personal_preference_values']] as const) {
      const cte = targetCte(table)
      add(`${name}.invalid-target`, 'error', '个人值的稳定目标必须是有效三元组，目标锚点仍须保留；离线或解除关联不要求活跃来源。', `${cte}
        SELECT target_key,kind FROM decoded d WHERE coalesce((${validTarget}),0)=0 OR (${validTarget} AND
        ((scope='entity' AND NOT EXISTS(SELECT 1 FROM catalog_entities e WHERE e.id=d.target_id AND e.kind=d.kind)) OR
         (scope='identity' AND NOT EXISTS(SELECT 1 FROM metadata_entities e WHERE e.id=d.target_id AND e.kind=d.kind))))`)
      add(`${name}.values`, 'inventory', '当前个人值；清除记录单列并保留，不等同于缺行。', `SELECT target_key,kind,${name === 'ratings' ? 'steps' : 'state'} value FROM ${table}`)
      add(`${name}.clears`, 'retained', '明确清除是用户状态，不应被自动补充或恢复时省略。', `SELECT target_key,kind,revision FROM ${table} WHERE ${name === 'ratings' ? 'steps IS NULL' : "state='none'"}`)
      add(`${name}.history`, 'inventory', '按审计序列计数，保留过去的个人值与清除记录，不要求它们与当前值相同。',
        `SELECT seq,target_key,${name === 'ratings' ? 'steps' : 'state'} value FROM ${name === 'ratings' ? 'personal_rating_history' : 'personal_preference_history'}`)
      add(`${name}.invalid-history-target`, 'error', '历史记录也应保留有效稳定锚点；历史目标不要求仍有关联或在线来源。', `${targetCte(name === 'ratings' ? 'personal_rating_history' : 'personal_preference_history')}
        SELECT seq,target_key FROM decoded d WHERE coalesce((${validTarget}),0)=0 OR (${validTarget} AND
        ((scope='entity' AND NOT EXISTS(SELECT 1 FROM catalog_entities e WHERE e.id=d.target_id AND e.kind=d.kind)) OR
         (scope='identity' AND NOT EXISTS(SELECT 1 FROM metadata_entities e WHERE e.id=d.target_id AND e.kind=d.kind))))`)
    }
    add('identity.invalid-confirmed', 'error', '已确认映射必须有同种类实体与身份目标。unresolved/detached 不要求活跃目标。',
      `SELECT l.entity_id,l.kind,l.target_id FROM metadata_identity_links l LEFT JOIN metadata_entities t ON t.id=l.target_id LEFT JOIN catalog_entities e ON e.id=l.entity_id
      WHERE l.state='confirmed' AND (t.id IS NULL OR t.kind IS NOT l.kind OR e.kind IS NOT l.kind)`)
    add('identity.unresolved', 'retained', '未确认/已解除身份为正常可管理状态；对账不自动确认候选。', `SELECT entity_id,kind,state FROM metadata_identity_links WHERE state<>'confirmed'`)
    add('identity.unlinked-targets', 'retained', '未被当前确认关联使用的身份可保留评分、历史和自动事实，不视为孤儿损坏。',
      `SELECT e.id target_id,e.kind FROM metadata_entities e WHERE NOT EXISTS(SELECT 1 FROM metadata_identity_links l WHERE l.state='confirmed' AND l.target_id=e.id)`)
    add('tags.members', 'inventory', '标签的稳定物理成员数，不等同于按身份去重后可播放曲目数。', `SELECT tag_id,entity_id FROM personal_tag_members`)
    add('tags.invalid-kind', 'error', '标签只接受具体歌曲/发行/人物/作品，不接受版本导航实体。',
      `SELECT m.tag_id,m.entity_id FROM personal_tag_members m JOIN catalog_entities e ON e.id=m.entity_id WHERE e.kind NOT IN ('recording','release','artist','work') OR e.identity<>'source'`)
    add('tags.offline-members', 'retained', '没有直接真实来源的标签引用仍保留；人物/作品还可经关系展开，不能据此宣称不可播放。',
      `SELECT m.tag_id,m.entity_id FROM personal_tag_members m WHERE NOT EXISTS(SELECT 1 FROM catalog_entity_sources s JOIN catalog_memberships cm ON cm.source_id=s.source_id WHERE s.entity_id=m.entity_id)`)
    add('genres.user-nodes', 'inventory', '用户流派节点/层级覆盖仍是持久数据，不从可清缓存推断。', `SELECT id,parent_id,dictionary_version FROM music_genres WHERE user_modified=1`)
    const selections = `WITH selections AS (SELECT target_kind,target_id,'personal' origin,genre_ids FROM music_genre_overrides
      UNION ALL SELECT target_kind,target_id,import_key,genre_ids FROM music_genre_import_overrides)`
    add('genres.invalid-selection', 'error', '人工/导入流派选择应为数组并引用保留的字典节点；空数组是合法明确清空。', `${selections}
      SELECT target_kind,target_id,origin FROM selections o WHERE NOT json_valid(genre_ids) OR json_type(${safeJson('genre_ids', '[]')})<>'array'
      OR EXISTS(SELECT 1 FROM json_each(${safeJson('o.genre_ids', '[]')}) j WHERE j.type<>'text' OR NOT EXISTS(SELECT 1 FROM music_genres g WHERE g.id=j.value))`)
    add('genres.selections', 'retained', '来源/专辑分类覆盖，包括空数组清空；离线或未归属目标不自动删除。', `${selections} SELECT target_kind,target_id,origin FROM selections`)
    add('favorites.invalid-document', 'error', '默认收藏权威存在时，必须有且仅有匹配 default_id 的系统视图和 trackIds 数组。',
      `SELECT default_id,revision FROM personal_preference_playlists d WHERE NOT json_valid(payload) OR json_type(${safeJson('payload')})<>'array'
      OR (SELECT count(*) FROM json_each(${safeJson('payload', '[]')}) p WHERE ${json('p.value', '$.id')}=d.default_id AND ${json('p.value', '$.isDefault')}=1 AND json_type(${safeJson('p.value')},'$.trackIds')='array')<>1`)
    add('favorites.invalid-snapshots', 'error', '引用到的收藏快照必须与原 track ID 相同；仅缺快照仍为合法未解析条目。', `${favoritesCte}
      SELECT i.key position,i.value track_id FROM documents d,json_each(d.playlist,'$.trackIds') i
      LEFT JOIN json_each(d.playlist,'$.trackSnapshots') s ON s.key=i.value
      WHERE i.type<>'text' OR length(i.value)=0 OR (s.key IS NOT NULL AND (s.type<>'object' OR ${json('s.value', '$.id')} IS NOT i.value))`)
    add('favorites.stored-order', 'inventory', '原始默认收藏 occurrence，position 是保存顺序；重复 occurrence 合法。', `${favoritesCte} SELECT position,track_id,source_id FROM valued`)
    add('favorites.duplicate-occurrences', 'retained', '按 track ID 计算超过首次出现的重复项；不自动去重或改变顺序。', `${favoritesCte} SELECT position,track_id FROM (SELECT *,row_number() OVER(PARTITION BY track_id ORDER BY position) occurrence FROM valued) WHERE occurrence>1`)
    add('favorites.unresolved', 'retained', '原 ID/快照没有精确来源映射，保持可见；不能按同名猜绑定。', `${favoritesCte} SELECT position,track_id FROM valued WHERE source_id IS NULL`)
    add('favorites.offline', 'retained', '能精确映射但已不属于曲库的收藏仍由偏好/快照保留。', `${favoritesCte} SELECT position,track_id,source_id FROM visible WHERE source_id IS NOT NULL AND in_library=0`)
    add('favorites.suppressed-by-preference', 'retained', '已取消收藏/禁播的旧 occurrence 被偏好覆盖隐藏，不是顺序损坏。', `${favoritesCte} SELECT position,track_id,state FROM valued WHERE source_id IS NOT NULL AND state IN ('none','ban')`)
    add('favorites.retained-order', 'inventory', '经过 none/ban 覆盖后保留的 occurrence 顺序；缺失快照仍保留原 ID。', `${favoritesCte} SELECT position,track_id,source_id FROM visible`)
    add('favorites.unrepresented-targets', 'inventory', '偏好中新收藏、原视图尚未表示的候选身份；播放列表读取会按 source ID 追加，并处理跨来源 track ID 冲突。此计数不是最终追加 occurrence 数。', `${favoritesCte} SELECT source_id,track_id,target_key FROM appendable WHERE choice=1`)
    add('versions.invalid-preference', 'error', '首选来源必须属于版本；首选版本必须属于同一版本集合。',
      `SELECT v.scope,v.id,v.preferred_source,v.preferred_version FROM catalog_versions v WHERE
      (v.preferred_source IS NOT NULL AND NOT EXISTS(SELECT 1 FROM catalog_version_sources s WHERE s.scope=v.scope AND s.version_id=v.id AND s.source_key=v.preferred_source)) OR
      (v.preferred_version IS NOT NULL AND (v.family_id IS NULL OR NOT EXISTS(SELECT 1 FROM catalog_versions p WHERE p.scope=v.scope AND p.id=v.preferred_version AND p.family_id=v.family_id)))`)
    add('versions.invalid-projection', 'error', '版本导航实体种类与 scope 一致；集合至少含两个版本，且首选定义一致。', `SELECT v.scope,v.id FROM catalog_versions v
      LEFT JOIN catalog_entities e ON e.id=v.entity_id WHERE v.scope NOT IN ('tracks','albums') OR e.identity IS NOT 'manual'
      OR e.kind IS NOT CASE WHEN v.scope='tracks' THEN 'recording' ELSE 'release' END
      OR (v.family_id IS NOT NULL AND ((SELECT count(*) FROM catalog_versions p WHERE p.scope=v.scope AND p.family_id=v.family_id)<2
        OR EXISTS(SELECT 1 FROM catalog_versions p WHERE p.scope=v.scope AND p.family_id=v.family_id AND p.preferred_version IS NOT v.preferred_version)))`)
    add('versions.offline-sources', 'retained', '版本可引用未入库/已离线的精确来源键；无来源不等于首选版本损坏。',
      `SELECT v.scope,v.version_id,substr(v.source_key,1,400) source_key FROM catalog_version_sources v WHERE NOT EXISTS(SELECT 1 FROM catalog_sources s WHERE (v.scope='tracks' AND s.source_key=v.source_key) OR (v.scope='albums' AND s.album_key=v.source_key))`)
    if (authorityJson !== undefined) {
      const cte = `WITH authority AS (SELECT 'tracks' scope,j.value version FROM json_each(?,'$.tracks.versions') j UNION ALL SELECT 'albums',j.value FROM json_each(?,'$.albums.versions') j),
        expected AS (SELECT a.scope,json_extract(a.version,'$.id') id,json_extract(a.version,'$.label') label,json_extract(a.version,'$.preferredSource') preferred_source,
          (SELECT json_extract(f.value,'$.id') FROM json_each(?, '$.'||a.scope||'.families') f,json_each(f.value,'$.versions') m WHERE m.value=json_extract(a.version,'$.id')) family_id,
          (SELECT json_extract(f.value,'$.preferredVersion') FROM json_each(?, '$.'||a.scope||'.families') f,json_each(f.value,'$.versions') m WHERE m.value=json_extract(a.version,'$.id')) preferred_version FROM authority a)`
      const args = [authorityJson, authorityJson, authorityJson, authorityJson]
      add('versions.authority-drift', 'error', '显式版本权威与目录投影的 ID/标签/来源/首选/集合必须一致；缺失来源仍合法。', `${cte}
        SELECT e.scope,e.id,'version' difference FROM expected e LEFT JOIN catalog_versions v ON v.scope=e.scope AND v.id=e.id WHERE v.id IS NULL OR v.label IS NOT e.label OR v.preferred_source IS NOT e.preferred_source OR v.family_id IS NOT e.family_id OR v.preferred_version IS NOT e.preferred_version
        UNION ALL SELECT v.scope,v.id,'extra-version' FROM catalog_versions v WHERE NOT EXISTS(SELECT 1 FROM expected e WHERE e.scope=v.scope AND e.id=v.id)
        UNION ALL SELECT a.scope,json_extract(a.version,'$.id'),'source' FROM authority a,json_each(a.version,'$.sources') s WHERE NOT EXISTS(SELECT 1 FROM catalog_version_sources v WHERE v.scope=a.scope AND v.version_id=json_extract(a.version,'$.id') AND v.source_key=s.value)
        UNION ALL SELECT v.scope,v.version_id,'extra-source' FROM catalog_version_sources v WHERE NOT EXISTS(SELECT 1 FROM authority a,json_each(a.version,'$.sources') s WHERE a.scope=v.scope AND json_extract(a.version,'$.id')=v.version_id AND s.value=v.source_key)`, args)
      if (options.versionsRevision !== undefined) add('versions.authority-revision', 'error', '仅在输入了明确权威 revision 时核对该修订；相同内容可有不同修订。',
        `SELECT 'versions' authority,coalesce((SELECT value FROM catalog_state WHERE key='versions_revision'),'absent') projected_revision WHERE coalesce((SELECT value FROM catalog_state WHERE key='versions_revision'),'absent')<>?`, [String(options.versionsRevision)])
    }
    add('metadata.manual-values', 'inventory', '人工正文值，仅报告状态与实体，不输出正文或图片字节。', `SELECT entity_id,${json('payload', '$.mode')} mode FROM metadata_overrides WHERE ${json('payload', '$.mode')}='value'`)
    add('metadata.explicit-clears', 'retained', '人工明确清空优先于自动资料。', `SELECT entity_id,'description' field FROM metadata_overrides WHERE ${json('payload', '$.mode')}='clear' UNION ALL SELECT entity_id,'artwork' FROM metadata_artwork_overrides WHERE ${json('payload', '$.mode')}='clear'`)
    add('metadata.artwork-values', 'inventory', '用户图片按实体计数，不输出图片、缓存句柄或 URL。', `SELECT entity_id,'artwork' field FROM metadata_artwork_overrides WHERE ${json('payload', '$.mode')}='value'`)
    add('metadata.source-preferences', 'retained', '资料源首选（包括 null 清除）可在来源离线时保留，不代表网络授权。', `SELECT entity_id,provider FROM metadata_source_preferences`)
    add('legacy.unassigned', 'retained', '没有确定实体映射的旧 ID 保留可管理；不会按专辑名称自动归属。', `SELECT a.plugin_id,a.legacy_id,a.disposition FROM metadata_legacy_albums a WHERE NOT EXISTS(SELECT 1 FROM metadata_legacy_bindings b WHERE b.plugin_id=a.plugin_id AND b.legacy_id=a.legacy_id)`)
    add('legacy.conflicts', 'pending', '多个旧 ID 的正文/清空等冲突，需要人工复核；不是丢失引用。', `SELECT plugin_id,legacy_id,disposition FROM metadata_legacy_albums WHERE disposition='conflict'`)
    add('legacy.unknown-provenance', 'pending', '带旧来源标记的未知正文留在主库、等待逐快照出处复核，不推定为人工资料。', `${legacySnapshots}
      SELECT plugin_id,legacy_id,snapshot_revision FROM provenance WHERE json_type(${safeJson('payload')},'$.description')='text' AND length(${json('payload', '$.description')})>0
      AND (provenance='unverified' OR (provenance IS NULL AND json_type(${safeJson('payload')},'$.descriptionSource') IS NOT NULL AND coalesce(${json('payload', '$.descriptionSource.method')},'')<>'external-ai'))`)
    add('legacy.manual-values', 'inventory', '经逐值来历确认的人工正文（当前及历史分开计）。', `${legacySnapshots} SELECT plugin_id,legacy_id,snapshot_revision FROM provenance WHERE provenance='manual' AND length(${json('payload', '$.description')})>0`)
    add('legacy.explicit-clears', 'retained', '经 exact value 来历确认的人工清空，包括 description 缺字段/null/空串。', `${legacySnapshots} SELECT plugin_id,legacy_id,snapshot_revision FROM provenance WHERE provenance='manual' AND coalesce(${json('payload', '$.description')},'')=''`)
    const errorChecks = checks.filter(c => c.severity === 'error' && c.count > 0).length
    const pendingChecks = checks.filter(c => c.severity === 'pending' && c.count > 0).length
    const report: MusicLibraryReconciliationReport = {
      format: 'twilight-music-library-reconciliation', version: 1, schema, exampleLimit: limit, revisions,
      coverage: { versionsAuthority: !!authority, versionsAuthoritySource: coreSnapshot ? 'core-state' : authority ? 'snapshot' : 'none', coreStateMigration: coreSnapshot?.migration ?? null, limits: [
        ...(!authority ? ['未指定 versions 权威：仅核对目录内部首选/引用，不能证明跨存储版本投影一致。'] : []),
        ...(authority && !coreSnapshot ? ['versions JSON 是操作人显式提供的快照，不是当前生产 Core state；当前生产首选版本尚未核对。'] : []),
        ...(coreSnapshot ? ['Core state 与曲库各自持有只读一致快照；两个文件不具备同一事务时间点。正在修改版本时的投影差异需在正常发布完成后复跑。'] : []),
        '默认收藏报告当前保存顺序、偏好覆盖后的保留顺序与新增候选身份；不物化最终追加列表，也不是迁移前后差异证明。普通歌单不纳入此报告。',
        '不探测磁盘、账户或联网服务可用性，不验证外部资料授权/正文真实性，也不执行桌面或包内验收。',
        '计数是每类记录/occurrence，领域错误可与外键错误重叠；examples 仅含有界标识和状态，最多每字段 400 字。'
      ] }, checks, summary: { errorChecks, pendingChecks, state: errorChecks ? 'needs-repair' : pendingChecks ? 'needs-review' : 'consistent' }
    }
    sql.exec('COMMIT')
    return report
  } catch (error) { sql.exec('ROLLBACK'); throw error }
}

/** Open the operator-selected SQLite file without invoking LibraryDatabase's migrations. */
export function reconcileMusicLibraryFile(path: string, options: MusicLibraryReconciliationOptions = {}): MusicLibraryReconciliationReport {
  const sql = new DatabaseSync(path, { readOnly: true })
  try { sql.exec('PRAGMA query_only=ON'); return reconcileMusicLibrary(sql, options) }
  finally { sql.close() }
}
