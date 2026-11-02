/* eslint-disable vue/one-component-per-file */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createRenderer, h, nextTick, ref, shallowRef, type Component } from 'vue'
import * as editorModel from './entityIntroductionEditor.ts'
import * as personalEditorModel from './entityPersonalMetadataEditor.ts'
import { parsePersonalMusicArtwork } from '../../../../shared/personalMusicArtwork.ts'
import * as settingsModel from '../settings-page/musicMetadataSettings.ts'
import * as referenceModel from './entityMetadataView.ts'
import * as creditsModel from './musicCreditsView.ts'
import { getTrackSource } from '../../../../shared/trackSourceIdentity.ts'
import type { MusicCredit, MusicCreditsQuery } from '../../../../shared/musicCredits.ts'
import type { MusicArtwork } from '../../../../shared/musicArtwork.ts'
import type {
  EntityMetadataDetail,
  EntityMetadataJob,
  EntityMetadataOverride,
  EntityMetadataPolicyView
} from '../../../../shared/entityMetadata.ts'
import { defaultMusicIdentificationSettings } from '../../../../shared/musicIdentificationSchedule.ts'
import type { AppSettings } from '../../../../shared/appSettings.ts'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import * as identityModel from './identityReviewView.ts'
import * as identityHistoryModel from './identityHistoryView.ts'
import * as ratingsModel from '../music-ratings/personalRatingsView.ts'
import * as identityInboxModel from './identityInboxView.ts'
import * as tasksModel from './metadataTasksView.ts'
import * as requeryModel from './metadataRequeryView.ts'
import * as updateModel from '../song-list/artistMetadataUpdate.ts'
import * as providerLabels from '../../../../shared/metadataProviders.ts'
import * as taskContract from '../../../../shared/entityMetadataTasks.ts'
import * as inboxLabels from '../library-inbox/libraryInbox.ts'

function taskFixture(t: test.TestContext) {
  const f = identityFixture(t)
  const request = { entityId: f.entity.id, type: 'resolve' as const, language: 'en' as const,
    mbid: 'a223958d-5c56-4b2c-a30a-87e357bc121b' }
  const job = f.db.metadataEnqueue({ ...request, batchId: 'one' }, 1000)
  f.db.metadataEnqueue({ ...request, batchId: 'two' }, 1000)
  const core = {
    ...f.core,
    query: async (name: string, query: any) => {
      if (name === 'metadata.entity.tasks' || name === 'metadata.entity.demands') {
        f.queries.push({ name, query })
        return name === 'metadata.entity.tasks' ? f.db.metadataTasks(query) : f.db.metadataTaskDemands(query)
      }
      return f.core.query(name, query)
    },
    command: async (name: string, query: any) => {
      if (name === 'metadata.entity.cancel') {
        f.commands.push({ name, query })
        return f.db.metadataCancel(query.jobId, query.batchId, 2000, query.generation)
      }
      return f.core.command(name, query)
    }
  }
  const List = component('./MetadataTaskList.vue', {
    './MetadataRequeryPanel.vue': { default: { render: () => null } },
    './metadataTasksView.ts': tasksModel,
    '../../../../shared/entityMetadataTasks.ts': taskContract,
    './identityReviewView.ts': identityModel,
    './IdentityReviewPanel.vue': { default: f.Panel },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return { ...f, job, core, List }
}

test('compiled requery controls require a real chosen source before networking and persist the exact source generation', async t => {
  const f = identityFixture(t)
  f.db.identificationDecide({ candidateId: f.candidate.id, revision: f.candidate.revision,
    linkRevision: f.candidate.linkRevision, decision: 'confirm' }, 1001)
  const original = f.db.metadataEnqueue({ entityId: f.entity.id, type: 'enrich', provider: 'platform.ncm',
    providerContext: 'fixture', language: 'en', batchId: 'original' }, 1002)
  const work = f.db.metadataClaim(1002)!
  f.db.metadataFinish(work, { state: 'failed', reason: 'transient' }, 1003)
  const queries: string[] = [], writes: any[] = []
  const Panel = component('./MetadataRequeryPanel.vue', {
    './metadataRequeryView.ts': requeryModel,
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({
      query: async (name: string, query: any) => { queries.push(name); return name === 'metadata.entity.sources' ? f.db.metadataTaskSources(query) : f.db.metadataTasks(query) },
      command: async (name: string, query: any) => { writes.push({ name, query }); return f.db.metadataRequery(query, { 'platform.ncm': 'fixture' }, 2000) }
    }) }
  })
  let changed = 0
  const ui = mount(t, () => h(Panel, { tasks: f.db.metadataTasks({}).items, batchId: 'original', scope: 'epoch', onChanged: () => changed++ }))
  await settle()
  assert.equal(queries.length, 0)
  assert.equal(ui.button('联网重新查询所选（0）').props.disabled, true)
  ui.button('选择库内条目').props.onClick(); await settle()
  assert.equal(writes.length, 0)
  const choice = ui.nodes().find(node => node.tag === 'button' && node.props['aria-pressed'] === false)!
  choice.props.onClick(); await settle()
  assert.equal(ui.button('联网重新查询所选（1）').props.disabled, false)
  ui.button('联网重新查询所选（1）').props.onClick(); await settle()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].name, 'metadata.entity.requery')
  assert.equal(writes[0].query.items[0].entityId, f.entity.id)
  assert.equal(writes[0].query.items[0].generation, original.generation)
  assert.equal(f.db.metadataJobs({ jobId: original.id }).items[0].generation, original.generation + 1)
  assert.equal(changed, 1)
})

test('compiled persistent task controls read actual consumers, cancel only one and open review by the catalog ID', async t => {
  const f = taskFixture(t)
  const active = ref(true), filter = ref<'all' | 'active' | 'attention'>('all')
  let counts = { active: 0, visible: 0 }
  const ui = mount(t, () => h(f.List, { active: active.value, filter: filter.value, expanded: true, onCounts: value => { counts = value } }))
  await settle()
  assert.equal(counts.active, 1)
  assert.equal(f.commands.length, 0)
  assert.match(ui.text(), /后台查询 1 条/)
  assert.doesNotMatch(ui.text(), /需处理/)
  const beforeRefresh = f.db.sql.prepare('SELECT total_changes() n').get()!.n
  const taskReads = f.queries.filter(q => q.name === 'metadata.entity.tasks').length
  ui.button('刷新状态').props.onClick(); await settle()
  assert.equal(f.queries.filter(q => q.name === 'metadata.entity.tasks').length, taskReads + 1)
  assert.equal(f.db.sql.prepare('SELECT total_changes() n').get()!.n, beforeRefresh)
  assert.equal(f.commands.length, 0, 'refresh reads saved progress without starting a scan or lookup')
  ui.button('当前需求（2）').props.onClick(); await settle()
  assert.match(ui.text(), /显式需求 · one/)
  assert.equal(ui.nodes().filter(n => n.tag === 'button' && n.text.trim() === '取消此项需求').length, 2)
  ui.button('取消此项需求').props.onClick(); await settle()
  assert.deepEqual(f.commands[0], { name: 'metadata.entity.cancel', query: { jobId: f.job.id, batchId: 'one', generation: f.job.generation } })
  assert.equal(f.db.metadataJobs({ jobId: f.job.id }).items[0].state, 'queued')
  assert.match(ui.text(), /显式需求 · two/)
  ui.button('管理身份').props.onClick(); await settle()
  assert.equal(f.queries.find(q => q.name === 'identification.detail')!.query.entityId, f.entity.id)
  assert.equal(f.commands.length, 1, 'opening review must not enqueue identification')
  const reads = f.queries.length
  f.snapshot.value = { ...f.snapshot.value, sequence: 2 }; await settle()
  assert.equal(f.queries.length, reads)
  active.value = false; await settle()
  const work = f.db.metadataClaim(3000)!
  f.db.metadataFinish(work, { state: 'failed', reason: 'fixture_failure' }, 3001)
  f.snapshot.value = { ...f.snapshot.value, entityMetadataRevision: 2 }; await settle()
  assert.equal(counts.active, 0, 'closing the dropdown must not stop persistent counts')
  filter.value = 'attention'; active.value = true; await settle()
  assert.match(ui.text(), /查询未成功/)
  assert.match(ui.text(), /fixture_failure/)
  assert.ok(ui.button('重新查询'))
  assert.doesNotMatch(ui.text(), /核对身份/)
})

test('task records start folded without demand or identity reads; retry is a distinct explicit action', async t => {
  const f = taskFixture(t)
  const work = f.db.metadataClaim(3000)!
  f.db.metadataFinish(work, { state: 'failed', reason: 'metadata_http_503' }, 3001)
  const ui = mount(t, () => h(f.List, { active: true, filter: 'all' }))
  await settle()
  assert.equal(ui.nodes().filter(n => n.tag === 'article').length, 0)
  assert.equal(f.queries.some(q => ['metadata.entity.demands', 'identification.detail'].includes(q.name)), false)
  assert.equal(f.commands.length, 0)
  ui.nodes().find(n => n.tag === 'details' && n.props.class === 'task-records')!.props.onToggle({ target: { open: true } })
  await settle()
  assert.match(ui.text(), /查询未成功/)
  assert.doesNotMatch(ui.text(), /核对身份/)
  ui.button('重新查询').props.onClick()
  await settle()
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0].name, 'identification.start')
  assert.equal(f.commands[0].query.entityId, f.entity.id)
  assert.match(f.commands[0].query.batchId, /^retry:/)
})

test('background task and demand refreshes keep the painted list without inserting loading rows', async t => {
  const f = taskFixture(t)
  const query = f.core.query
  const pending: Array<() => void> = []
  f.core.query = async (name, payload) => {
    const result = await query(name, payload)
    if (name === 'metadata.entity.tasks' || name === 'metadata.entity.demands')
      await new Promise<void>(resolve => pending.push(resolve))
    return result
  }
  const ui = mount(t, () => h(f.List, { active: true, filter: 'all', expanded: true }))
  const release = async () => {
    assert.ok(pending.length)
    pending.splice(0).forEach(resolve => resolve())
    await settle()
  }
  await settle()
  assert.match(ui.text(), /正在读取资料任务/)
  await release()
  const row = ui.nodes().find(node => node.tag === 'article')!
  ui.button('当前需求（2）').props.onClick(); await settle()
  assert.match(ui.text(), /正在读取当前需求/)
  await release()
  const demands = ui.nodes().find(node => node.props['aria-label'] === '任务当前需求')!
  const painted = ui.text()
  for (let revision = 2; revision <= 4; revision++) {
    f.snapshot.value = { ...f.snapshot.value, entityMetadataRevision: revision }
    await settle()
    assert.equal(pending.length, 2)
    assert.equal(ui.text(), painted, 'background reads must not add or remove visible content')
    assert.equal(ui.nodes().find(node => node.tag === 'article'), row)
    assert.equal(ui.nodes().find(node => node.props['aria-label'] === '任务当前需求'), demands)
    assert.equal(ui.nodes().find(node => node.props['aria-label'] === '音乐资料持久任务')!.props['aria-busy'], true)
    assert.equal(demands.props['aria-busy'], true)
    await release()
    assert.equal(demands.props['aria-busy'], false)
    assert.equal(ui.text(), painted)
  }
  f.db.metadataClaim(3000)
  f.snapshot.value = { ...f.snapshot.value, entityMetadataRevision: 5 }
  await settle()
  assert.equal(ui.text(), painted)
  await release()
  assert.match(ui.text(), /后台查询 1 条/)
  assert.equal(ui.nodes().find(node => node.tag === 'article'), row)
  assert.equal(ui.nodes().some(node => node.tag === 'span' && node.text === '进行中'), true)
  assert.equal(f.commands.length, 0)
})

test('refreshing a saved empty task page does not flash an empty panel or visible count', async t => {
  const f = taskFixture(t)
  let release: (() => void) | undefined
  let hold = false
  f.core.query = async (_name, payload) => {
    if (hold) await new Promise<void>(resolve => { release = resolve })
    return f.db.metadataTasks(payload)
  }
  let visible = -1
  const ui = mount(t, () => h(f.List, {
    active: true, filter: 'attention', onCounts: value => { visible = value.visible }
  }))
  await settle()
  assert.equal(visible, 0)
  assert.equal(ui.nodes().some(node => node.props['aria-label'] === '音乐资料持久任务'), false)
  hold = true
  f.snapshot.value = { ...f.snapshot.value, entityMetadataRevision: 2 }
  await settle()
  assert.equal(visible, 0)
  assert.equal(ui.nodes().some(node => node.props['aria-label'] === '音乐资料持久任务'), false)
  release!(); await settle()
  assert.equal(visible, 0)
})

test('the original TaskCenter includes persistent counts while closed and clearing notices does not cancel or erase jobs', async t => {
  const f = taskFixture(t)
  const notices = { activeTaskCount: ref(0), noticeHistory: ref([]), clearedTaskResultKeys: ref(new Set()), pushNotice() {} }
  const empty = { state: 'idle', completed: 0, failed: 0, skipped: 0, current: 0, total: 0 }
  const Center = component('../TaskCenter.vue', {
    './music-metadata/MetadataTaskList.vue': { default: f.List },
    '../stores/coreConnection': { useCoreConnection: () => f.core },
    '../stores/useMusicStore': { useMusicStore: () => ({ libraryScanStatus: ref(empty), libraryMetadataEnrichmentStatus: ref(empty) }) },
    '../stores/useAppNoticeStore': { useAppNoticeStore: () => notices },
    '../stores/useDownloadTasks': { useDownloadTasks: () => ({ tasks: ref([]), error: ref(''), connect: () => () => {} }) },
    '../stores/useAppUpdateStore': { useAppUpdateStore: () => ({ state: ref({ progress: { phase: 'idle' } }), error: ref(''), connectionError: ref(''), connect: () => () => {} }) },
    './streaming-page/DownloadResultActions.vue': { default: { render: () => null } },
    './streaming-page/streamingDownloads': { downloadStatusLabel: () => '' }
  })
  const instance = ref<any>(), active = ref(false)
  let visible = 0
  const ui = mount(t, () => h(Center, { ref: instance, active: active.value, filter: 'active', onVisibleCount: value => { visible = value } }))
  await settle()
  assert.equal(notices.activeTaskCount.value, 1)
  assert.equal(visible, 1)
  instance.value.clearCompletedTasks()
  assert.equal(f.db.metadataTasks({}).total, 1)
  assert.equal(f.commands.length, 0)
  active.value = true; await settle()
  assert.match(ui.text(), /音乐资料/)
  f.snapshot.value = { ...f.snapshot.value, epoch: 'two', entityMetadataRevision: 3 }; await settle()
  assert.equal(notices.activeTaskCount.value, 1)
  assert.equal(f.commands.length, 0)
})

// Exercise compiled Vue templates and handlers without a desktop process.
// Layout, focus and native keyboard acceptance remain with the Electron gate.
function component(path: string, imports: Record<string, unknown>): Component {
  const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, {
    id: path, inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } }
  })
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const require = createRequire(import.meta.url)
  const module = { exports: {} as { default: Component } }
  new Function('require', 'module', 'exports', code)(
    (name: string) => (Object.hasOwn(imports, name) ? imports[name] : require(name)),
    module,
    module.exports
  )
  return module.exports.default
}
interface Element {
  tag: string
  text: string
  props: Record<string, any>
  parent: Element | null
  children: Element[]
  style: Record<string, string>
  readonly value: unknown
  readonly options: Element[]
  addEventListener(name: string, listener: unknown): void
  focus(): void
}
const element = (tag: string, text = ''): Element => ({
  tag,
  text,
  props: {},
  parent: null,
  children: [],
  style: {},
  get value() { return this.props.value },
  get options() { return this.children.filter(child => child.tag === 'option') },
  addEventListener(name, listener) { this.props[`dom:${name}`] = listener },
  focus() {
    this.props.focused = true
  }
})
function mount(t: test.TestContext, render: () => ReturnType<typeof h>) {
  function remove(node: Element) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  }
  const renderer = createRenderer<Element, Element>({
    createElement: element,
    createText: (text) => element('#text', text),
    createComment: () => element('#comment'),
    setText: (node, text) => {
      node.text = text
    },
    setElementText: (node, text) => {
      node.text = text
      node.children = []
    },
    insert(node, parent, anchor) {
      remove(node)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
      node.parent = parent
    },
    remove,
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _previous, value) => {
      node.props[key] = value
    }
  })
  const app = renderer.createApp({ render }),
    root = element('root')
  app.mount(root)
  t.after(() => app.unmount())
  const nodes = (): Element[] => {
    const visit = (node: Element): Element[] => [node, ...node.children.flatMap(visit)]
    return visit(root)
  }
  const text = (node: Element): string => node.text + node.children.map(text).join('')
  const button = (label: string) => {
    const found = nodes().find((n) => n.tag === 'button' && text(n).trim() === label)
    assert.ok(found, `Missing ${label}: ${text(root)}`)
    return found
  }
  return { nodes, text: () => text(root), button }
}
const settle = async () => {
  await nextTick()
  await new Promise<void>((r) => setImmediate(r))
  await nextTick()
}
function identityFixture(t: test.TestContext) {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        source: 'local',
        filePath: 'D:/one.flac',
        title: 'One',
        artist: 'Same name',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const entity = db.catalogQuery({ kind: 'artist' }).items[0]
  const publish = (id: string) =>
    db.identificationPublish(
      db.identificationInput(entity.id),
      [
        {
          provider: 'ncm',
          name: 'Same name',
          summary: `Independent artist ${id}`,
          matcherVersion: 'fixture1',
          references: [{ provider: 'ncm', kind: 'artist', idType: 'native', value: id }],
          evidence: {
            origin: 'search',
            matches: ['name'],
            missing: ['cross_reference'],
            conflicts: [],
            incomplete: true,
            provenance: 'saved provider response'
          }
        }
      ],
      1000
    )[0]
  const candidate = publish('42')
  const snapshot = shallowRef({
    epoch: 'one',
    catalogRevision: 1,
    libraryRevision: 1,
    entityMetadataRevision: 1,
    sequence: 0
  })
  const commands: Array<{ name: string; query: any }> = [],
    queries: Array<{ name: string; query: any }> = []
  let stalePreview = false
  const core = {
    state: snapshot,
    query: async (name: string, query: any) => {
      queries.push({ name, query })
      if (name === 'identification.detail') return db.identificationDetail(query.entityId)
      if (name === 'identification.candidates') return db.identificationCandidates(query)
      if (name === 'identification.inbox') return db.identificationInbox(query)
      if (name === 'identification.history') return db.identificationHistory(query)
      if (name === 'identification.restorePreview') return db.identificationRestorePreview(query)
      assert.equal(name, 'identification.preview')
      const preview = db.identificationPreview(query)
      return stalePreview
        ? {
            ...preview,
            stale: true,
            canConfirm: false,
            conflicts: ['conflicting_ids_in_same_namespace']
          }
        : preview
    },
    command: async (name: string, query: any) => {
      commands.push({ name, query })
      let result: unknown
      if (name === 'identification.decide') result = db.identificationDecide(query, 2000)
      else if (name === 'identification.detach')
        result = db.identificationDetach(query.linkId, query.revision, 2001)
      else if (name === 'identification.restore') result = db.identificationRestore(query, 2002)
      else assert.equal(name, 'identification.start')
      snapshot.value = {
        ...snapshot.value,
        entityMetadataRevision: snapshot.value.entityMetadataRevision + 1
      }
      return result
    }
  }
  const References = component('./IdentityReferences.vue', {
    './musicCreditsView.ts': creditsModel
  })
  const RatingImpact = component('../music-ratings/IdentityRatingImpact.vue', {
    './personalRatingsView.ts': ratingsModel
  })
  const HistoryPanel = component('./IdentityHistoryPanel.vue', {
    './identityHistoryView.ts': identityHistoryModel,
    './identityReviewView.ts': identityModel,
    './IdentityReferences.vue': { default: References },
    '../music-ratings/IdentityRatingImpact.vue': { default: RatingImpact },
    '../music-preferences/IdentityPreferenceImpact.vue': { default: { render: () => null } },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  const Panel = component('./IdentityReviewPanel.vue', {
    './identityReviewView.ts': identityModel,
    './IdentityReferences.vue': { default: References },
    './IdentityHistoryPanel.vue': { default: HistoryPanel },
    '../music-ratings/IdentityRatingImpact.vue': { default: RatingImpact },
    '../music-preferences/IdentityPreferenceImpact.vue': { default: { render: () => null } },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return {
    db,
    entity,
    candidate,
    publish,
    snapshot,
    commands,
    queries,
    core,
    Panel,
    stale: () => {
      stalePreview = true
    }
  }
}

test('compiled history controls compare current and historical IDs before explicit restore and ignore playback ticks', async t => {
  const f = identityFixture(t)
  f.db.identificationDecide({ candidateId: f.candidate.id, revision: f.candidate.revision,
    linkRevision: f.candidate.linkRevision, decision: 'confirm' }, 1001)
  const first = f.db.identificationHistory({ entityId: f.entity.id }).items[0]
  const other = f.publish('84')
  f.db.identificationDecide({ candidateId: other.id, revision: other.revision,
    linkRevision: other.linkRevision, decision: 'confirm' }, 1002)
  const ui = mount(t, () => h(f.Panel, { entityId: f.entity.id, scope: 'local:one' }))
  await settle()
  assert.equal(f.queries.some(query => query.name === 'identification.history'), false, 'history is lazy')
  ui.button('查看关联历史').props.onClick(); await settle()
  assert.match(ui.text(), /被替换/)
  assert.equal(f.commands.length, 0)
  const compare = ui.nodes().filter(node => node.tag === 'button' && node.text.trim() === '比较并恢复').at(-1)!
  compare.props.onClick(); await settle()
  assert.match(ui.text(), /当前关联/)
  assert.match(ui.text(), /恢复后的关联/)
  assert.equal(ui.button('确认恢复此关联').props.disabled, false)
  const reads = f.queries.length
  f.snapshot.value = { ...f.snapshot.value, sequence: 1 }; await settle()
  assert.equal(f.queries.length, reads)
  ui.button('确认恢复此关联').props.onClick(); await settle()
  assert.equal(f.commands.length, 1)
  assert.equal(f.commands[0].name, 'identification.restore')
  assert.equal(f.commands[0].query.historySeq, first.seq)
  assert.equal(f.db.identificationDetail(f.entity.id).references[0].value, '42')
  assert.match(ui.text(), /已恢复历史身份关联/)
  assert.equal(ui.nodes().some(node => node.props['aria-label'] === '历史与当前关联比较'), false)
})

test('compiled identity controls preview, reject, reverse a rejection, confirm and detach without writing on entry', async (t) => {
  const f = identityFixture(t)
  const ui = mount(t, () => h(f.Panel, { entityId: f.entity.id, scope: 'local:one' }))
  await settle()
  assert.equal(f.commands.length, 0)
  assert.equal(f.queries.filter((q) => q.name === 'identification.preview').length, 0)
  ui.button('复核此候选').props.onClick()
  await settle()
  assert.equal(
    ui.nodes().find((n) => n.props['aria-label'] === '候选与当前关联比较')!.props.focused,
    true
  )
  assert.match(ui.text(), /相符依据名称/)
  assert.match(ui.text(), /缺少依据交叉引用/)
  assert.match(ui.text(), /saved provider response/)
  ui.button('拒绝此候选').props.onClick()
  await settle()
  assert.equal(f.commands.length, 1)
  const select = ui.nodes().find((n) => n.tag === 'select')!
  select.props.onChange({ target: { value: 'rejected' } })
  await settle()
  ui.button('复核此候选').props.onClick()
  await settle()
  assert.match(ui.text(), /此身份曾被拒绝或解除/)
  ui.button('确认关联').props.onClick()
  await settle()
  assert.equal(f.db.identificationDetail(f.entity.id).link!.state, 'confirmed')
  assert.deepEqual(f.commands[1].query, {
    candidateId: f.candidate.id,
    revision: 2,
    linkRevision: 0,
    decision: 'confirm',
    preferenceResolution: { revision: 0, choice: 'target' }
  })
  ui.button('解除关联').props.onClick()
  await settle()
  assert.equal(f.commands.length, 2)
  assert.equal(ui.button('确认解除关联').props.focused, true)
  ui.button('取消').props.onClick()
  await settle()
  assert.equal(f.commands.length, 2)
  ui.button('解除关联').props.onClick()
  await settle()
  ui.button('确认解除关联').props.onClick()
  await settle()
  assert.equal(f.db.identificationDetail(f.entity.id).link!.state, 'detached')
  assert.match(ui.text(), /已解除关联/)
  const reads = f.queries.length
  f.snapshot.value = { ...f.snapshot.value, sequence: 2 }
  await settle()
  assert.equal(f.queries.length, reads)
  ui.button('联网重新识别').props.onClick()
  await settle()
  assert.equal(f.commands.at(-1)!.name, 'identification.start')
  assert.equal(f.commands.at(-1)!.query.entityId, f.entity.id)
})

test('compiled review disables stale or conflicting confirmations and keeps both current and replacement identities visible', async (t) => {
  const f = identityFixture(t)
  f.db.identificationDecide(
    {
      candidateId: f.candidate.id,
      revision: f.candidate.revision,
      linkRevision: f.candidate.linkRevision,
      decision: 'confirm'
    },
    1001
  )
  const replacement = f.publish('99')
  const ui = mount(t, () => h(f.Panel, { entityId: f.entity.id, scope: 'local:one' }))
  await settle()
  ui.button('复核此候选').props.onClick()
  await settle()
  assert.match(ui.text(), /“确认替换关联”会替换上方当前身份/)
  assert.match(ui.text(), /42/)
  assert.match(ui.text(), /99/)
  assert.equal(ui.button('确认替换关联').props.disabled, false)
  f.stale()
  ui.button('取消复核').props.onClick()
  await settle()
  ui.button('复核此候选').props.onClick()
  await settle()
  assert.match(ui.text(), /候选依据已过期/)
  assert.match(ui.text(), /同一来源存在冲突 ID/)
  assert.equal(ui.button('确认替换关联').props.disabled, true)
  assert.equal(ui.button('拒绝此候选').props.disabled, true)
  ui.button('确认替换关联').props.onClick()
  await settle()
  assert.equal(f.commands.length, 0)
  assert.equal(f.db.identificationDetail(f.entity.id).references[0].value, '42')
  assert.ok(replacement.id)
})

test('compiled review adds an explicitly confirmed NCM fallback without replacing the current MB identity', async t => {
  const f = identityFixture(t)
  const [mb] = f.db.identificationPublish(f.db.identificationInput(f.entity.id), [{
    provider: 'musicbrainz', name: 'Same name', summary: 'Original person', matcherVersion: 'fixture',
    references: [{provider:'musicbrainz',kind:'artist',idType:'mbid',value:'151bb385-1af0-40b6-9269-bf2ed982311f'}],
    evidence:{origin:'search',matches:[],missing:['review'],conflicts:[],incomplete:true,provenance:'fixture'}
  }], 1001)
  f.db.identificationDecide({candidateId:mb.id,revision:mb.revision,linkRevision:mb.linkRevision,decision:'confirm'},1002)
  const target=f.db.identificationDetail(f.entity.id).link!.targetId
  f.publish('42')
  const ui=mount(t,()=>h(f.Panel,{entityId:f.entity.id,scope:'local'}))
  await settle()
  assert.equal(f.commands.length,0)
  ui.button('复核此候选').props.onClick();await settle()
  assert.match(ui.text(),/共享此身份的曲库条目/)
  const action=ui.button('确认同一身份，补充网易云引用')
  assert.equal(action.props.disabled,false)
  action.props.onClick();await settle()
  assert.equal(f.commands.length,1)
  assert.equal(f.commands[0].query.attachToCurrent,true)
  const result=f.db.identificationDetail(f.entity.id)
  assert.equal(result.link!.targetId,target)
  assert.deepEqual(result.references.map(r=>r.provider).sort(),['musicbrainz','ncm'])
})

test('compact decisions count source entities once, open evidence explicitly and remove resolved chores', async t => {
  const f = identityFixture(t)
  f.publish('84')
  const Inbox = component('./IdentityReviewInbox.vue', {
    './identityInboxView.ts': identityInboxModel,
    './identityReviewView.ts': identityModel,
    './IdentityReviewPanel.vue': { default: f.Panel },
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core }
  })
  const ui = mount(t, () => h(Inbox, { compact: true }))
  await settle()
  assert.match(ui.text(), /1 个条目待确认/)
  assert.match(ui.text(), /2 个候选/)
  assert.equal(f.queries.find(q => q.name === 'identification.inbox')!.query.unresolvedOnly, true)
  assert.equal(f.queries.some(q => q.name === 'identification.detail'), false)
  assert.equal(f.commands.length, 0)
  ui.button('查看候选').props.onClick()
  await settle()
  assert.equal(f.queries.find(q => q.name === 'identification.detail')!.query.entityId, f.entity.id)
  ui.button('复核此候选').props.onClick()
  await settle()
  ui.button('确认关联').props.onClick()
  await settle()
  assert.match(ui.text(), /暂时没有需要你决定的事/)
  assert.doesNotMatch(ui.text(), /个条目待确认/)
  assert.equal(f.db.identificationInbox({}).total, 1, 'remaining candidates remain available in advanced tools')
})

test('the original inbox switches between file problems and durable entity review without reclassifying tracks or selecting the first name', async (t) => {
  const f = identityFixture(t)
  const Inbox = component('./IdentityReviewInbox.vue', {
    './identityInboxView.ts': identityInboxModel,
    './identityReviewView.ts': identityModel,
    './IdentityReviewPanel.vue': { default: f.Panel },
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core }
  })
  const Dialog = component('../library-inbox/LibraryInboxDialog.vue', {
    './LibraryHealthPanel.vue': { __esModule: true, default: { render: () => null } },
    '../music-metadata/IdentityReviewInbox.vue': { default: Inbox },
    '@renderer/components/LocalLibraryTagManager.vue': { default: { render: () => null } },
    '@renderer/app/useDismissLayer.ts': { useEscapeToClose() {}, useFocusTrap() {} },
    '@renderer/components/library-inbox/libraryInbox.ts': inboxLabels,
    '@renderer/stores/coreConnection.ts': {
      useCoreConnection: () => ({ ...f.core, attach: async () => {} })
    }
  })
  const ui = mount(t, () => h(Dialog, { tracks: [], rescan: async () => {}, scanning: false }))
  await settle()
  ui.button('文件问题').props.onClick()
  await settle()
  assert.ok(ui.button('检查疑似重复'))
  ui.button('音乐资料复核').props.onClick()
  await settle()
  assert.equal(f.commands.filter(c => c.name !== 'library.inbox.refresh').length, 0)
  assert.equal(f.queries.filter((q) => q.name === 'identification.detail').length, 0)
  assert.match(ui.text(), /1 个候选/)
  ui.nodes()
    .find(
      (n) =>
        n.tag === 'button' &&
        n.props['aria-pressed'] === false &&
        n.children.some((c) => c.tag === 'strong')
    )!
    .props.onClick()
  await settle()
  assert.equal(
    f.queries.find((q) => q.name === 'identification.detail')!.query.entityId,
    f.entity.id
  )
  assert.match(ui.text(), /身份与候选复核/)
  const reads = f.queries.length
  f.snapshot.value = { ...f.snapshot.value, sequence: 5 }
  await settle()
  assert.equal(f.queries.length, reads)
  ui.button('文件问题').props.onClick()
  await settle()
  assert.ok(ui.button('检查疑似重复'))
  assert.equal(f.commands.filter(c => c.name !== 'library.inbox.refresh').length, 0)
})
const detail = (revision = 0): EntityMetadataDetail => ({
  entityId: 'artist-a',
  targetId: null,
  revision,
  link: null,
  name: 'A',
  introduction: null,
  override: null,
  facts: []
})

const attribution = {
  provider: 'musicbrainz',
  externalId: 'fixture',
  url: 'https://musicbrainz.org/',
  license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'MusicBrainz contributors',
  revision: 'fixture1',
  retrievedAt: 1000
}
const reference = (value: string) =>
  ({ provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value }) as const
const credit = (index: number): MusicCredit => ({
  personRef: reference(
    index === 0 ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'
  ),
  name: '同名参与者',
  targetRef: {
    ...reference('33333333-3333-4333-8333-333333333333'),
    kind: index === 0 ? 'recording' : 'work'
  },
  role: index === 0 ? 'vocal' : 'other',
  rawRole: index === 0 ? 'vocal' : 'mixing assistant',
  relationTypeId: '',
  direction: 'backward',
  order: index,
  joinphrase: index === 0 ? ' & ' : '',
  attributes: [{ name: 'guest', value: 'piano' }],
  begin: '1997',
  end: '1998',
  attribution
})
const Attribution = component('./MetadataAttribution.vue', {
  './entityMetadataView.ts': referenceModel
})

test('compiled credits controls select exact recordings, paginate with revisions, preserve distinct people and clear revoked data', async (t) => {
  const snapshot = shallowRef({
    epoch: 'one',
    catalogRevision: 1,
    libraryRevision: 1,
    entityMetadataRevision: 1,
    settingsRevision: 1,
    sequence: 0
  })
  const track = ref({
    id: 'plugin.test:track-1',
    source: 'plugin.test',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    duration: 1
  })
  const queries: Array<{ name: string; query: any }> = []
  let revoked = false
  const explored: unknown[] = []
  const Credits = component('./TrackCreditsPanel.vue', {
    '../music-exploration/MusicExplorationPanel.vue': { __esModule: true, default: {
      props: ['reference'], setup: (props: any) => () => {
        explored.push(props.reference)
        return h('p', `探索 ${props.reference.value}`)
      }
    } },
    '../../../../shared/trackSourceIdentity.ts': { getTrackSource },
    './entityMetadataView.ts': referenceModel,
    './musicCreditsView.ts': creditsModel,
    './MetadataAttribution.vue': { default: Attribution },
    './IdentityReviewPanel.vue': { default: { render: () => null } },
    '../../app/useLocale.ts': { useLocale: () => ({ locale: ref('zh-CN') }) },
    '../../stores/useSettingsStore.ts': {
      useSettingsStore: () => ({
        settings: ref({ musicIdentification: defaultMusicIdentificationSettings() })
      })
    },
    '../../stores/coreConnection.ts': {
      useCoreConnection: () => ({
        state: snapshot,
        query: async (name: string, query: any) => {
          queries.push({ name, query })
          if (name === 'catalog.query')
            return {
              revision: 1,
              total: 2,
              offset: 0,
              items: ['a', 'b'].map((id) => ({
                id,
                kind: 'recording',
                title: `录音 ${id}`,
                artist: 'Artist',
                identity: 'source',
                sourceCount: 1
              }))
            }
          if (name === 'catalog.sources') return { revision: 1, total: 0, offset: 0, items: [] }
          if (name === 'metadata.entity.detail')
            return {
              ...detail(4),
              entityId: query.entityId,
              targetId: 'target-b',
              link: { state: revoked ? 'detached' : 'confirmed', revision: 4, mbid: '' }
            }
          assert.equal(name, 'metadata.entity.credits')
          return {
            revision: 'credits-r1',
            total: 21,
            offset: query.offset,
            truncated: true,
            items: query.offset ? [credit(20)] : Array.from({ length: 20 }, (_, i) => credit(i))
          }
        }
      })
    }
  })
  const ui = mount(t, () => h(Credits, { track: track.value }))
  await settle()
  assert.deepEqual(queries[0].query.context, {
    type: 'track',
    provider: 'plugin.test',
    id: track.value.id
  })
  assert.equal(queries[0].query.kind, 'recording')
  assert.equal(queries.filter((q) => q.name === 'metadata.entity.credits').length, 0)
  assert.match(ui.text(), /请先选择/)
  ui.nodes()
    .filter((n) => n.tag === 'button' && Object.hasOwn(n.props, 'aria-pressed'))[1]
    .props.onClick()
  await settle()
  const first = queries.find((q) => q.name === 'metadata.entity.credits')!
    .query as MusicCreditsQuery
  assert.equal(first.entityId, 'b')
  assert.equal(first.entityRevision, 4)
  assert.equal(first.limit, 20)
  assert.match(ui.text(), /来源名单不完整/)
  assert.match(ui.text(), /作品级关系/)
  assert.match(ui.text(), /mixing assistant/)
  assert.match(ui.text(), /guest：piano/)
  assert.match(ui.text(), /1997 — 1998/)
  assert.match(ui.text(), /署名连接符：“ & ”/)
  assert.match(ui.text(), /MusicBrainz contributors/)
  const people = ui.nodes().filter((n) => n.tag === 'button' && n.text === '同名参与者')
  assert.equal(people.length, 20)
  people[0].props.onClick(); await settle()
  assert.deepEqual(explored.at(-1), credit(0).personRef)
  people[1].props.onClick(); await settle()
  assert.deepEqual(explored.at(-1), credit(1).personRef)
  ui.button('探索作品').props.onClick(); await settle()
  assert.deepEqual(explored.at(-1), credit(1).targetRef)
  ui.button('收起探索').props.onClick(); await settle()
  const sources = ui.nodes().filter((n) => n.tag === 'a' && n.text === '来源')
  assert.notEqual(
    sources[0].props.href,
    sources[1].props.href,
    'identical names do not merge identities'
  )
  ui.button('下一页').props.onClick()
  await settle()
  assert.equal(queries.at(-1)!.query.revision, 'credits-r1')
  assert.equal(queries.at(-1)!.query.offset, 20)
  assert.equal(ui.nodes().filter((n) => n.tag === 'button' && n.text === '同名参与者').length, 1)
  const reads = queries.length
  snapshot.value = { ...snapshot.value, sequence: 10 }
  await settle()
  assert.equal(queries.length, reads)
  revoked = true
  snapshot.value = { ...snapshot.value, entityMetadataRevision: 2 }
  await settle()
  assert.match(ui.text(), /尚未确认录音身份/)
  assert.doesNotMatch(ui.text(), /同名参与者/)
  track.value = { ...track.value, id: 'plugin.test:track-2' }
  await settle()
  assert.match(ui.text(), /请先选择/)
  assert.equal(queries.at(-3)!.query.context.id, 'plugin.test:track-2')
})

test('compiled artwork uses the existing image loader, shows actual scope and attribution, and offers a bounded retry without a track-cover fallback', async (t) => {
  const covers: string[] = []
  const Cover = component('../CoverImg.vue', {
    '../assets/images/default-track-cover-light.webp': { default: 'default-track-cover.webp' },
    '../assets/default-track-cover.css': {},
    '../stores/library/coreArtwork.ts': {
      coreArtworkEpoch: () => '',
      coreArtworkKey: () => '',
      readCoreArtwork: async () => null
    },
    '../utils/coverDiagnostics.ts': { recordCoverDiagnostic() {} },
    '../utils/coverLoader.ts': {
      readCachedCover: () => null,
      clearLocalCoverDataCache() {},
      invalidateRemoteCoverGrant() {},
      resolveCover: async (handle: string) => {
        covers.push(handle)
        return handle
      }
    }
  })
  const Artwork = component('./EntityArtwork.vue', {
    '../CoverImg.vue': { default: Cover },
    './MetadataAttribution.vue': { default: Attribution },
    './musicCreditsView.ts': creditsModel
  })
  const artwork = shallowRef<MusicArtwork>({
    handle: 'twilight-media://image/artist-session',
    scope: 'artist',
    targetRef: reference('11111111-1111-4111-8111-111111111111'),
    attribution,
    usage: { display: true, cache: true, crossSource: true, export: false }
  })
  let rereads = 0
  const ui = mount(t, () =>
    h(Artwork, { artwork: artwork.value, name: 'Artist', onRefresh: () => rereads++ })
  )
  await settle()
  const img = ui.nodes().find((n) => n.tag === 'img')!
  assert.equal(img.props.src, artwork.value.handle)
  assert.equal(img.props.alt, 'Artist · 人物图片')
  assert.match(ui.text(), /MusicBrainz contributors/)
  await img.props.onError(new Event('error'))
  await settle()
  assert.equal(
    ui.nodes().some((n) => n.tag === 'img'),
    false
  )
  assert.match(ui.text(), /图片暂不可用/)
  assert.equal(covers.length, 1, 'no durable URL or automatic metadata retry is invented')
  ui.button('重新读取图片').props.onClick()
  await settle()
  assert.equal(rereads, 1)
  artwork.value = {
    ...artwork.value,
    handle: 'twilight-media://image/release-session',
    scope: 'release',
    sourceReleaseId: '33333333-3333-4333-8333-333333333333'
  }
  await settle()
  assert.match(ui.text(), /具体发行封面/)
  assert.match(ui.text(), /图片所属发行/)
  assert.doesNotMatch(ui.text(), /不代表当前具体发行/)
  artwork.value = {
    ...artwork.value,
    handle: 'twilight-media://image/project-session',
    scope: 'album_project',
    sourceReleaseId: '33333333-3333-4333-8333-333333333333'
  }
  await settle()
  assert.match(ui.text(), /专辑作品图片/)
  assert.match(ui.text(), /取自关联发行，不代表当前具体发行/)
  assert.equal(ui.nodes().find((n) => n.tag === 'img')!.props.src, artwork.value.handle)
  assert.equal(
    ui
      .nodes()
      .some(
        (n) =>
          n.tag === 'a' &&
          n.props.href === 'https://musicbrainz.org/release/33333333-3333-4333-8333-333333333333'
      ),
    true
  )
})

test('compiled artwork removes an already-painted image at expiry and never polls metadata', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 5000 })
  const Artwork = component('./EntityArtwork.vue', {
    '../CoverImg.vue': {
      default: {
        props: ['cover'],
        setup: (props: { cover: string }) => () => h('img', { src: props.cover })
      }
    },
    './MetadataAttribution.vue': { default: Attribution },
    './musicCreditsView.ts': creditsModel
  })
  const artwork: MusicArtwork = {
    handle: 'twilight-media://image/expiring',
    scope: 'artist',
    targetRef: reference('11111111-1111-4111-8111-111111111111'),
    attribution,
    usage: { display: true, cache: true, crossSource: true, export: false, expiresAt: 6000 }
  }
  let reads = 0
  const ui = mount(t, () => h(Artwork, { artwork, name: 'Artist', onRefresh: () => reads++ }))
  assert.equal(
    ui.nodes().some((n) => n.tag === 'img'),
    true
  )
  t.mock.timers.tick(1000)
  await nextTick()
  assert.equal(
    ui.nodes().some((n) => n.tag === 'img'),
    false
  )
  assert.match(ui.text(), /图片授权已过期/)
  assert.equal(reads, 0)
  ui.button('重新读取图片').props.onClick()
  assert.equal(reads, 1)
})

test('the original track dialog mounts credits for local and streaming tracks and keeps its edit and dismissal modes', async (t) => {
  const track = ref({
    id: 'one',
    source: 'local',
    filePath: 'D:/one.flac',
    title: 'One',
    artist: 'Artist',
    album: 'Album',
    duration: 60
  })
  let canEscape!: () => boolean
  let escape!: () => void
  let closed = 0
  const Dialog = component('../TrackInfoDialog.vue', {
    '@renderer/composables/useNativeDialog': { useNativeDialog() {} },
    '@renderer/app/useDismissLayer': {
      useEscapeToClose: (enabled: () => boolean, close: () => void) => {
        canEscape = enabled
        escape = close
      }
    },
    '@renderer/stores/useMusicStore.ts': {
      useMusicStore: () => ({ refreshLibraryIndex: async () => {} })
    },
    '@renderer/utils/localTrackRemovalPolicy.ts': {
      selectLocalLibraryActionTracks: (tracks: unknown[]) => tracks
    },
    '@renderer/components/CoverImg.vue': { default: { render: () => h('img') } },
    '@renderer/components/LocalLibraryTagManager.vue': {
      default: { render: () => h('div', '标签编辑') }
    },
    '@renderer/components/music-ratings/TrackRatingsPanel.vue': { default: { render: () => null } },
    '@renderer/components/music-metadata/TrackCreditsPanel.vue': {
      default: {
        props: ['track'],
        setup: (props: { track: { id: string } }) => () =>
          h('section', { 'aria-label': '歌曲参与人员' }, props.track.id)
      }
    }
  })
  const ui = mount(t, () => h(Dialog, { track: track.value, onClose: () => closed++ }))
  assert.equal(ui.nodes().find((n) => n.props['aria-label'] === '歌曲参与人员')!.text, 'one')
  assert.equal(canEscape(), true)
  ui.button('编辑歌曲信息').props.onClick()
  await settle()
  assert.equal(
    ui.nodes().some((n) => n.props['aria-label'] === '歌曲参与人员'),
    false
  )
  assert.equal(canEscape(), false)
  ui.nodes()
    .find((n) => n.tag === 'dialog')!
    .props.onCancel({ preventDefault() {} })
  await settle()
  assert.equal(canEscape(), true)
  assert.equal(closed, 0)
  track.value = { ...track.value, id: 'ncm:42', source: 'ncm', filePath: '' }
  await settle()
  assert.equal(ui.nodes().find((n) => n.props['aria-label'] === '歌曲参与人员')!.text, 'ncm:42')
  assert.equal(
    ui.nodes().some((n) => n.tag === 'button' && n.text === '编辑歌曲信息'),
    false
  )
  assert.ok(ui.button('歌曲与专辑版本'))
  escape()
  assert.equal(closed, 1)
})

test('compiled introduction controls edit, keep a conflicting draft, confirm clear/reset, and submit only through the original command', async (t) => {
  const current = shallowRef<EntityMetadataDetail | null>(detail())
  const available = ref(true)
  const calls: Array<{ name: string; request: EntityMetadataOverride }> = []
  const Editor = component('./IntroductionEditor.vue', {
    './entityIntroductionEditor.ts': editorModel,
    '../../stores/coreConnection.ts': {
      useCoreConnection: () => ({
        command: async (name: string, request: EntityMetadataOverride) => {
          calls.push({ name, request })
          current.value = {
            ...detail(request.revision + 1),
            override:
              request.mode === 'reset'
                ? null
                : { mode: request.mode, value: request.value ?? '', language: request.language }
          }
        }
      })
    }
  })
  const ui = mount(t, () =>
    h(Editor, {
      scope: 'local-artist-en-epoch1',
      selected: 'artist-a',
      detail: current.value,
      available: available.value,
      language: 'en',
      refresh: async () => {}
    })
  )
  const editButton = ui.button('编辑介绍')
  available.value = false
  await settle()
  assert.equal(ui.button('编辑介绍'), editButton, 'refresh disables the existing control instead of removing its row')
  assert.equal(editButton.props.disabled, true)
  available.value = true
  await settle()
  ui.button('编辑介绍').props.onClick()
  await settle()
  assert.equal(ui.button('保存介绍').props.disabled, true)
  const textarea = ui.nodes().find((n) => n.tag === 'textarea')!
  assert.equal(textarea.props.focused, true)
  assert.equal(textarea.props.maxlength, '20000')
  textarea.props.onInput({ target: { value: 'My draft' } })
  await settle()
  current.value = detail(1)
  await settle()
  assert.equal(ui.button('保存介绍').props.disabled, true)
  assert.equal(ui.nodes().find((n) => n.tag === 'textarea')!.props.value, 'My draft')
  ui.button('已核对最新资料，保留草稿').props.onClick()
  await settle()
  ui.nodes()
    .find((n) => n.tag === 'form')!
    .props.onSubmit({ preventDefault() {} })
  await settle()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'metadata.entity.override')
  assert.equal(calls[0].request.revision, 1)
  assert.match(ui.text(), /介绍已保存/)
  assert.equal(ui.button('编辑介绍').props.focused, true)
  for (const [action, confirmation, mode] of [
    ['清空介绍', '确认清空', 'clear'],
    ['恢复自动', '确认恢复自动', 'reset']
  ] as const) {
    const before = calls.length
    ui.button(action).props.onClick()
    await settle()
    assert.equal(calls.length, before, 'opening a confirmation does not write')
    assert.equal(ui.button(confirmation).props.disabled, false)
    ui.nodes()
      .find((n) => n.tag === 'form')!
      .props.onSubmit({ preventDefault() {} })
    await settle()
    assert.equal(calls.at(-1)!.request.mode, mode)
    assert.equal(Object.hasOwn(calls.at(-1)!.request, 'value'), false)
  }
})

test('compiled settings controls use actual capabilities, retain unavailable choices and persist via the original settings store', async (t) => {
  const saved = ref({ musicIdentification: { ...defaultMusicIdentificationSettings(), sources: ['musicbrainz'] } })
  const writes: Partial<AppSettings>[] = []
  const snapshot = shallowRef({
    epoch: 'epoch1',
    entityMetadataRevision: 1,
    settingsRevision: 1,
    pluginsRevision: 1,
    sequence: 1
  })
  let reads = 0
  const policy: EntityMetadataPolicyView = {
    enabled: true,
    identity: false,
    introduction: false,
    reason: 'public_service_not_approved',
    sources: [
      {
        provider: 'musicbrainz',
        identification: [{ kind: 'artist', reason: 'public_service_not_approved' }],
        enrichment: []
      },
      {
        provider: 'platform.test',
        identification: [{ kind: 'artist', reason: null }],
        enrichment: []
      }
    ]
  }
  const Settings = component('../settings-page/MusicMetadataSettings.vue', {
    './musicMetadataSettings.ts': settingsModel,
    './SettingsGroup.vue': {
      default: {
        setup(_props: unknown, { slots }: any) {
          return () => h('section', slots.default())
        }
      }
    },
    '../../stores/useSettingsStore.ts': {
      useSettingsStore: () => ({
        settings: saved,
        updateSettings: async (patch: Partial<AppSettings>) => {
          writes.push(patch)
          saved.value = { musicIdentification: patch.musicIdentification! }
        }
      })
    },
    '../../stores/coreConnection.ts': {
      useCoreConnection: () => ({
        state: snapshot,
        query: async (name: string) => {
          assert.equal(name, 'metadata.entity.policy')
          reads++
          return policy
        }
      })
    }
  })
  const ui = mount(t, () => h(Settings))
  await settle()
  const inputs = () => ui.nodes().filter((n) => n.tag === 'input')
  assert.equal(inputs()[0].props.checked, true)
  assert.equal(
    inputs()[0].props.disabled,
    false,
    'can remove a previously selected unavailable source'
  )
  inputs()[0].props.onChange({ target: { checked: false } })
  await settle()
  assert.equal(inputs()[0].props.disabled, true)
  inputs()[1].props.onChange({ target: { checked: true } })
  await settle()
  const toggle = ui.nodes().find((n) => n.props['aria-label'] === '自动补全新入库资料')!
  assert.equal(toggle.props['aria-checked'], false)
  assert.equal(toggle.props['aria-describedby'], 'music-metadata-privacy')
  toggle.props.onClick()
  await settle()
  assert.equal(saved.value.musicIdentification.newImports, true)
  assert.equal(saved.value.musicIdentification.history, false)
  const language = ui.nodes().find((n) => n.tag === 'select')!
  language.props.onChange({ target: { value: 'zh-Hant' } })
  await settle()
  assert.equal(saved.value.musicIdentification.language, 'zh-Hant')
  assert.deepEqual(saved.value.musicIdentification.sources, ['platform.test'])
  assert.equal(writes.length, 4)
  snapshot.value = { ...snapshot.value, sequence: 2 }
  await settle()
  assert.equal(reads, 1, 'playback-only ticks never query capability policy')
  snapshot.value = { ...snapshot.value, pluginsRevision: 2 }
  await settle()
  assert.equal(reads, 2)
})

test('compiled personal metadata controls select a source and save, clear and reset user-owned image bytes', async t => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII='
  const current = shallowRef<EntityMetadataDetail>({ ...detail(), sourcePreference: { provider: 'platform.ncm', available: false }, sourceOptions: ['wikipedia'] })
  const available = ref(true)
  const calls: Array<{ name: string; request: any }> = []
  const Editor = component('./PersonalMetadataEditor.vue', {
    './entityPersonalMetadataEditor.ts': personalEditorModel,
    '../../../../shared/personalMusicArtwork.ts': { parsePersonalMusicArtwork },
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({ command: async (name: string, request: any) => {
      calls.push({ name, request })
      current.value = { ...current.value, revision: current.value.revision + 1,
        ...(name.endsWith('sourcePreference') ? { sourcePreference: { provider: request.provider, available: true } } :
          { artworkOverride: request.mode === 'reset' ? null : { mode: request.mode },
            manualArtwork: request.mode === 'value' ? parsePersonalMusicArtwork(request.dataUrl) : null }) }
      return { ...detail(), entityId: 'wrong-command-context' }
    } }) }
  })
  const previousReader = globalThis.FileReader
  const previousImage = globalThis.Image
  let decodeFailure = false
  class Reader {
    result = png
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL() { queueMicrotask(() => this.onload?.()) }
  }
  globalThis.FileReader = Reader as unknown as typeof FileReader
  class Bitmap {
    src = ''
    naturalWidth = 1
    naturalHeight = 1
    async decode() { if (decodeFailure) throw new Error('decode failed') }
  }
  globalThis.Image = Bitmap as unknown as typeof Image
  t.after(() => { globalThis.FileReader = previousReader; globalThis.Image = previousImage })
  const ui = mount(t, () => h(Editor, { scope: 'local-artist', selected: 'artist-a', detail: current.value,
    language: 'en', available: available.value, refresh: async () => {} }))
  assert.match(ui.text(), /首选资料源当前没有可用介绍/)
  const sourceChoice = ui.nodes().find(n => n.tag === 'select')!
  available.value = false
  await settle()
  assert.equal(ui.nodes().find(n => n.tag === 'select'), sourceChoice)
  assert.equal(sourceChoice.props.disabled, true)
  assert.match(ui.text(), /首选资料源当前没有可用介绍/)
  available.value = true
  await settle()
  ui.nodes().find(n => n.tag === 'select')!.props.onChange({ target: { value: 'wikipedia' } })
  await settle()
  ui.button('保存资料源首选').props.onClick(); await settle()
  assert.deepEqual(calls[0], { name: 'metadata.entity.sourcePreference', request: { entityId: 'artist-a', revision: 0, language: 'en', provider: 'wikipedia' } })
  const file = ui.nodes().find(n => n.tag === 'input' && n.props.type === 'file')!
  file.props.onChange({ target: { files: [{ size: 68, type: 'image/png' }], value: 'selection' } }); await settle()
  assert.equal(ui.nodes().find(n => n.tag === 'img')!.props.src, png)
  ui.button('保存图片').props.onClick(); await settle()
  assert.equal(current.value.manualArtwork?.dataUrl, png)
  assert.equal(calls[1].request.revision, 1)
  assert.equal(calls[1].name, 'metadata.entity.artworkOverride')
  ui.button('隐藏资料图片').props.onClick(); await settle()
  assert.equal(calls.length, 2, 'selecting clear is not yet a write')
  ui.button('确认隐藏').props.onClick(); await settle()
  assert.equal(calls[2].request.mode, 'clear')
  assert.equal(current.value.manualArtwork, null)
  ui.button('恢复自动图片').props.onClick(); await settle()
  ui.button('确认恢复自动图片').props.onClick(); await settle()
  assert.equal(calls[3].request.mode, 'reset')
  assert.equal(current.value.artworkOverride, null)
  decodeFailure = true
  ui.nodes().find(n => n.tag === 'input' && n.props.type === 'file')!.props.onChange({ target: { files: [{ size: 68, type: 'image/png' }], value: 'broken' } }); await settle()
  assert.match(ui.text(), /图片无法解码/)
  assert.equal(ui.button('保存图片').props.disabled, true)
  assert.equal(calls.length, 4, 'a failed browser decode never publishes corrupt picture bytes')
})

test('compiled album updates use confirmed native IDs, submit durable tasks and read back their status', async t => {
  const snapshot = shallowRef({ entityMetadataRevision: 1 })
  const selected = ref('album-a')
  const writes: Array<{ name: string; request: any }> = []
  const jobs: EntityMetadataJob[] = []
  const policy = { enabled: true, sources: [
    { provider: 'vocadb', enrichment: [{ provider: 'vocadb', kind: 'album_project', reason: null }] },
    { provider: 'musicbrainz', enrichment: [{ provider: 'musicbrainz-details', kind: 'album_project', reason: null }] }
  ] }
  const Controls = component('./MetadataUpdateControls.vue', {
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({
      state: snapshot,
      query: async (name: string, query: any) => {
        if (name === 'metadata.entity.policy') return policy
        if (name === 'metadata.entity.jobs') return { items: jobs, total: jobs.length }
        assert.equal(name, 'identification.detail')
        return { entityId: query.entityId, kind: 'album_project', references: query.entityId === 'album-a'
          ? [{ provider: 'vocadb', kind: 'album_project', idType: 'native', value: '10' }] : [] }
      },
      command: async (name: string, request: any) => {
        writes.push({ name, request })
        assert.equal(name, 'metadata.entity.enrich')
        const task = { id: 'native-album-job', provider: request.provider, type: 'enrich', state: 'queued', generation: 1 } as EntityMetadataJob
        jobs.push(task)
        return task
      }
    }) },
    '../song-list/artistMetadataUpdate.ts': updateModel,
    '../../../../shared/metadataProviders.ts': providerLabels,
    './metadataTasksView.ts': tasksModel
  })
  const ui = mount(t, () => h(Controls, { entityId: selected.value, kind: 'album_project', language: 'zh-Hans', scope: selected.value }))
  await settle()
  assert.equal(writes.length, 0)
  assert.equal(ui.button('更新资料').props.disabled, false)
  ui.button('更新资料').props.onClick(); await settle()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].request.provider, 'vocadb')
  assert.equal(writes[0].request.entityId, 'album-a')
  assert.match(ui.text(), /VocaDB.*排队/)
  jobs[0] = { ...jobs[0], state: 'completed' }
  snapshot.value = { entityMetadataRevision: 2 }; await settle()
  assert.match(ui.text(), /已完成/)
  selected.value = 'album-without-identity'; await settle()
  assert.equal(ui.button('更新资料').props.disabled, true)
})

test('album metadata can omit public and manual artwork without removing the introduction or standalone artwork', async t => {
  const state = shallowRef({ page: { revision: 1, total: 1, offset: 0, items: [] }, samples: {},
    selected: null, detail: { ...detail(), name: 'Album',
      introduction: { value: 'Album introduction', language: 'en', origin: 'manual', attribution: null },
      artwork: [{ handle: 'cover-handle' }], manualArtwork: { dataUrl: 'manual-cover' } },
    loading: false, detailLoading: false, error: '', detailError: '', detailNotice: '' })
  const noop = { default: { setup: () => () => null } }
  const Panel = component('./EntityMetadataPanel.vue', {
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({ state: shallowRef({ epoch: 'one' }) }) },
    '../../stores/useSettingsStore.ts': { useSettingsStore: () => ({ settings: shallowRef({ musicIdentification: { language: 'en' } }) }) },
    '../../app/useLocale.ts': { useLocale: () => ({ locale: ref('en-US') }) },
    './entityMetadataView.ts': { createEntityMetadataView: () => ({ state, dispose() {} }),
      observeEntityMetadataView: () => () => {}, METADATA_REFERENCE_PAGE_SIZE: 6 },
    './AlbumMetadataDialog.vue': noop,
    './MetadataAttribution.vue': noop, './IntroductionEditor.vue': noop, './PersonalMetadataEditor.vue': noop,
    './MetadataUpdateControls.vue': noop, './IdentityReviewPanel.vue': noop,
    '../music-preferences/PersonalPreferencesPanel.vue': noop,
    './EntityArtwork.vue': { default: { render: () => h('img', { src: 'public-cover' }) } },
    '../../../../shared/entityMetadata.ts': { validMusicBrainzArtistId: () => false }
  })
  const showArtwork = ref<boolean | undefined>(false)
  const ui = mount(t, () => h(Panel, { target: { kind: 'release', sourceProvider: 'local',
    context: { type: 'collection', collection: 'albums', id: 'album-a' } }, showArtwork: showArtwork.value,
    albumSummary: { name: 'Album', durationText: '3 分钟', formatText: 'FLAC' } }))
  assert.equal(ui.nodes().filter(n => n.tag === 'img').length, 0)
  assert.equal(ui.nodes().some(n => n.props.class === 'overview-artwork-col'), false)
  assert.match(ui.text(), /Album introduction/)
  assert.match(ui.text(), /FLAC/)
  ui.button('专辑作品').props.onClick(); await settle()
  assert.equal(ui.nodes().filter(n => n.tag === 'img').length, 0)
  assert.match(ui.text(), /Album introduction/)
  showArtwork.value = undefined; await settle()
  assert.deepEqual(ui.nodes().filter(n => n.tag === 'img').map(n => n.props.src), ['public-cover', 'manual-cover'])
})

test('compiled entity panel honours imported manual clear and conflict without resurrecting native page fallback', async t => {
  const state = shallowRef({ page: { revision: 1, total: 1, offset: 0, items: [] }, samples: {},
    selected: { id: 'artist-a', kind: 'artist', title: 'Artist' }, detail: detail(),
    loading: false, detailLoading: false, error: '', detailError: '', detailNotice: '' })
  const noop = { default: { setup: () => () => null } }
  const Panel = component('./EntityMetadataPanel.vue', {
    '../../stores/coreConnection.ts': { useCoreConnection: () => ({ state: shallowRef({ epoch: 'one' }), query: async () => { throw new Error('unexpected query') } }) },
    '../../stores/useSettingsStore.ts': { useSettingsStore: () => ({ settings: shallowRef({ musicIdentification: { language: 'en' } }) }) },
    '../../app/useLocale.ts': { useLocale: () => ({ locale: ref('en-US') }) },
    './entityMetadataView.ts': { createEntityMetadataView: () => ({ state, refresh: async () => {}, refreshDetail: async () => {}, dispose() {} }),
      observeEntityMetadataView: () => () => {}, METADATA_REFERENCE_PAGE_SIZE: 6 },
    './AlbumMetadataDialog.vue': noop,
    './MetadataAttribution.vue': noop, './IntroductionEditor.vue': noop, './PersonalMetadataEditor.vue': noop,
    './MetadataUpdateControls.vue': noop,
    './EntityArtwork.vue': noop, './IdentityReviewPanel.vue': noop, '../music-preferences/PersonalPreferencesPanel.vue': noop,
    '../../../../shared/entityMetadata.ts': { validMusicBrainzArtistId: () => false }
  })
  const ui = mount(t, () => h(Panel, { target: { kind: 'artist', sourceProvider: 'ncm',
    context: { type: 'native', provider: 'ncm', id: '42' } }, fallbackIntro: 'Native platform fallback must not return' }))
  assert.match(ui.text(), /Native platform fallback must not return/)
  const imported = { pluginId: 'rhine', albumId: 'old-album', revision: 1, disposition: 'bound' as const,
    method: 'manual' as const, description: null, descriptionCleared: true, localNote: null, truncated: false, sources: [], credits: [] }
  state.value = { ...state.value, detail: { ...detail(), imports: [imported] } }; await settle()
  assert.match(ui.text(), /已隐藏介绍/)
  assert.doesNotMatch(ui.text(), /Native platform fallback must not return/)
  state.value = { ...state.value, detail: { ...detail(), imports: [{ ...imported, disposition: 'conflict' }] } }; await settle()
  assert.match(ui.text(), /历史手工介绍存在冲突/)
  assert.doesNotMatch(ui.text(), /Native platform fallback must not return/)
})
