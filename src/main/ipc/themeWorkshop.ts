import { app, dialog, ipcMain, nativeImage } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, isAbsolute } from 'node:path'
import { getCoreApplication } from '../app/coreApplication.ts'
import { runtime } from '../core/runtime.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { WorkshopRepository } from '../themes/workshopRepository.ts'
import { writeStoredZip, resolveThemeAssetFile } from '../themes/themeArchive.ts'
import { resolveBackgroundImageFile } from '../library/coverCache.ts'
import { customThemeSnapshot } from '../themes/customThemeSnapshot.ts'
import { loadThemeLibrary } from '../themes/themeLibrary.ts'
import { getBuiltInThemePreset } from '../../shared/theme.ts'
import { cloneAppearance } from '../../shared/appAppearance.ts'
import { workshopTemplate } from '../../shared/themeWorkshopTemplates.ts'
import {
  diagnoseWorkshopProject,
  workshopDiagnosticReport
} from '../../shared/themeWorkshopDiagnostics.ts'
import { diagnoseWorkshopAssetEncoding } from '../themes/workshopAssetValidation.ts'
import {
  createWorkshopProject,
  compileWorkshopTheme,
  workshopProjectSummary,
  exportWorkshopEditor,
  isWorkshopProject,
  normalizeThemeEditor,
  type CustomThemeInput,
  type WorkshopBase,
  type WorkshopProject,
  type WorkshopThemeSource
} from '../../shared/themeWorkshop.ts'

/** The workshop owns editing drafts; installed packages always use Core's manager. */
function pluginAccess() {
  const core = getCoreApplication()
  return core
    ? {
        list: () => core.request('plugins.list', {}),
        listExtensions: () => core.request('extensions.list', {}),
        installFromPath: (path: string) => core.request('plugins.installSource', { path }),
        enable: (id: string) => core.request('plugins.enable', { id })
      }
    : runtime.pluginManager!
}

const MAX_BYTES = 64 * 1024 * 1024
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
}

async function assetData(path: string): Promise<string> {
  const mime = MIME[extname(path).toLowerCase()]
  if (!mime) throw new Error('支持 PNG、JPEG、WebP 和 WOFF2')
  const bytes = await readFile(path)
  if (bytes.length > 20 * 1024 * 1024) throw new Error('单个素材不能超过 20 MB')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function readLocalThemeAsset(source: string): Promise<string> {
  const url = new URL(source)
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const path =
    url.protocol === 'background:'
      ? resolveBackgroundImageFile(url.hostname + url.pathname)
      : url.protocol === 'theme-asset:' && url.hostname === 'asset'
        ? resolveThemeAssetFile(segments.shift() ?? '', segments.join('/'))
        : null
  if (!path) throw new Error('主题图片或字体已丢失，请重新导入')
  return assetData(path)
}

async function portableProject(project: WorkshopProject): Promise<WorkshopProject> {
  const images = new Map<string, Promise<string>>()
  async function embed(value: unknown): Promise<unknown> {
    if (typeof value === 'string' && /^(?:background|theme-asset):\/\//.test(value)) {
      if (!images.has(value)) images.set(value, readLocalThemeAsset(value))
      return images.get(value)!
    }
    if (Array.isArray(value)) return Promise.all(value.map(embed))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, entry]) => [key, await embed(entry)])
        )
      )
    return value
  }
  return (await embed(project)) as WorkshopProject
}

async function snapshot(source: WorkshopThemeSource): Promise<WorkshopBase> {
  const manager = pluginAccess()
  const plugin = (await manager.list()).find((p) => p.id === source.pluginId)
  if (!plugin) throw new Error('来源主题插件已卸载')
  const extensions = await manager.listExtensions()
  const theme = extensions
    .find((p) => p.pluginId === source.pluginId)
    ?.themes.find((t) => t.id === source.themeId)
  if (!theme) throw new Error('请先启用来源主题插件')
  const root = await realpath(plugin.paths.versionRoot)
  const inside = async (path: string): Promise<string> => {
    const canonical = await realpath(path)
    const rel = relative(root, canonical)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('主题素材超出插件目录')
    return canonical
  }
  let css = theme.stylesheet ? await readFile(await inside(theme.stylesheet), 'utf8') : ''
  if (/@import\b/i.test(css)) throw new Error('请将主题 @import 合并为单一 stylesheet 后再导入')
  const embed = async (text: string): Promise<string> => {
    const matches = [...text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)]
    for (const match of matches.reverse()) {
      const url = match[2].trim()
      if (url.startsWith('data:') || url.startsWith('#')) continue
      if (/^[a-z]+:|^\/\//i.test(url))
        throw new Error('独立主题需要使用包内素材，不能引用远程或绝对 URL')
      const data = await assetData(
        await inside(
          resolve(theme.stylesheet ? dirname(theme.stylesheet) : root, decodeURIComponent(url))
        )
      )
      text =
        text.slice(0, match.index) + `url('${data}')` + text.slice(match.index! + match[0].length)
    }
    return text
  }
  css = await embed(css)
  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries(theme.variables ?? {}))
    variables[key] = await embed(value)
  const manifest = JSON.parse(await readFile(plugin.paths.manifestPath, 'utf8'))
  const rawTheme = manifest.contributes?.themes?.find((t: { id: string }) => t.id === theme.id)
  const editor = normalizeThemeEditor(rawTheme?.editor)
  for (const control of editor?.controls ?? []) {
    if (control.type !== 'image' || !control.variable) continue
    const match = css.match(new RegExp(control.variable + String.raw`\s*:\s*(url\([^)]*\))`))
    if (match) {
      if (control.defaults.pureWhite === 'none') control.defaults.pureWhite = match[1]
      if (control.defaults.dark === 'none') control.defaults.dark = match[1]
    }
    control.defaults = {
      pureWhite: await embed(control.defaults.pureWhite),
      dark: await embed(control.defaults.dark)
    }
  }
  const notices: Record<string, string> = {}
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ATTRIBUTION.json']) {
    try {
      notices[name] = await readFile(await inside(join(root, name)), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return {
    notices,
    pluginId: plugin.id,
    themeId: theme.id,
    version: plugin.version,
    digest: createHash('sha256')
      .update(css)
      .update(JSON.stringify({ structured: theme.structured, variables, editor }))
      .digest('hex'),
    author: plugin.author,
    license: plugin.license,
    css,
    variables,
    structured: theme.structured as WorkshopBase['structured'],
    editor
  }
}

async function packageProject(project: WorkshopProject, work: string): Promise<string> {
  project = await portableProject(project)
  const invalid = diagnoseWorkshopAssetEncoding(
    project,
    (value) => !nativeImage.createFromDataURL(value).isEmpty()
  )
  if (invalid.length) throw new Error(invalid[0].message)
  const pluginId = `com.twilightecho.theme.user-${project.id}`
  const compiled = compileWorkshopTheme(project)
  const structured = compiled.structured
  const completeAppearance =
    structured?.schemaVersion === 3 &&
    (structured.appearance ||
      structured.toneSchedule ||
      Object.keys(structured.iconAssets ?? {}).length > 0)
  await writeFile(join(work, 'theme.css'), compiled.css)
  await writeFile(
    join(work, 'plugin.json'),
    JSON.stringify(
      {
        id: pluginId,
        name: project.name,
        description: project.description || '自定义主题',
        version: project.version,
        author: project.author || project.base.author || '个人主题',
        license: project.base.license || 'UNLICENSED',
        type: ['theme'],
        apiVersion: 3,
        engines: { twilightEcho: completeAppearance ? '>=1.4.0-0' : '>=1.2.0' },
        permissions: [],
        contributes: {
          themes: [
            {
              id: 'custom',
              name: project.name,
              stylesheet: 'theme.css',
              structured: compiled.structured,
              variables: compiled.variables,
              editor: exportWorkshopEditor(project)
            }
          ]
        }
      },
      null,
      2
    )
  )
  await writeFile(
    join(work, 'ATTRIBUTION.json'),
    JSON.stringify(
      {
        sourcePlugin: project.base.pluginId,
        sourceVersion: project.base.version,
        author: project.base.author,
        license: project.base.license,
        notices: project.base.notices,
        assets: project.assets?.map(({ name, license, source }) => ({ name, license, source }))
      },
      null,
      2
    )
  )
  return pluginId
}

export function setupThemeWorkshopIpc(): void {
  let repository: WorkshopRepository | undefined
  const repo = (): WorkshopRepository =>
    (repository ??= new WorkshopRepository(
      join(app.getPath('userData'), 'theme-workshop', 'projects')
    ))
  const checked = (id: string, revision?: number): WorkshopProject => {
    const project = repo().require(id, revision)
    const report = workshopDiagnosticReport([
      ...diagnoseWorkshopProject(project).diagnostics,
      ...diagnoseWorkshopAssetEncoding(
        project,
        (dataUrl) => !nativeImage.createFromDataURL(dataUrl).isEmpty()
      )
    ])
    if (report.errors)
      throw new Error(
        `主题有 ${report.errors} 个错误：${report.diagnostics.find((item) => item.severity === 'error')!.message}`
      )
    return project
  }
  const capture = async (input: CustomThemeInput): Promise<WorkshopProject> => {
    stringifyJsonForIpcStorage(input, 'custom theme snapshot', MAX_BYTES)
    if (!input || !input.appearance || !input.selection) throw new Error('自定义主题快照无效')
    const selection = input.selection
    let profile = input.profile
    let base: WorkshopBase | undefined
    if (selection.kind === 'plugin') {
      await runtime.pluginManagerReady
      base = await snapshot({
        pluginId: selection.pluginId,
        themeId: selection.themeId,
        name: '',
        version: ''
      })
    } else if (!profile) {
      if (selection.kind === 'builtin') profile = getBuiltInThemePreset(selection.id) ?? undefined
      else if (selection.kind === 'user')
        profile = (await loadThemeLibrary()).data.profiles.find((p) => p.id === selection.id)
      if (!profile) throw new Error('来源主题已不可用')
    }
    const cache = new Map<string, Promise<string>>()
    return customThemeSnapshot(randomUUID(), input, profile, base, (source) => {
      if (!cache.has(source))
        cache.set(
          source,
          (async () => {
            return readLocalThemeAsset(source)
          })()
        )
      return cache.get(source)!
    })
  }
  const exportTep = async (project: WorkshopProject): Promise<string | null> => {
    const result = await dialog.showSaveDialog({
      title: '导出主题插件',
      defaultPath: `${project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'theme'}.tep`,
      filters: [{ name: 'Twilight Echo 主题插件', extensions: ['tep'] }]
    })
    if (result.canceled || !result.filePath) return null
    const target =
      extname(result.filePath).toLowerCase() === '.tep' ? result.filePath : result.filePath + '.tep'
    const work = await mkdtemp(join(tmpdir(), 'te-custom-theme-'))
    try {
      await packageProject(project, work)
      await writeStoredZip(work, target, 'plugin-theme')
    } finally {
      await rm(work, { recursive: true, force: true })
    }
    return target
  }
  const handlers = {
    createFromAppearance: async (input: CustomThemeInput) => {
      stringifyJsonForIpcStorage(input, 'custom theme snapshot', MAX_BYTES)
      const projectId =
        input.selection?.kind === 'plugin'
          ? input.selection.pluginId.match(/^com\.twilightecho\.theme\.user-([a-f0-9-]{36})$/)?.[1]
          : undefined
      const existing = projectId && !input.profile ? repo().get(projectId) : undefined
      if (existing) {
        const appearance = cloneAppearance(input.appearance)
        existing.base.structured = {
          ...existing.base.structured,
          schemaVersion: 3,
          variants: existing.base.structured?.variants ?? {},
          appearance,
          appearanceLayers: appearance.appearanceLayers
        }
        return repo().save(await portableProject(existing))
      }
      return repo().save(await capture(input))
    },
    exportAppearance: async (input: CustomThemeInput) => {
      const project = await capture(input)
      const report = diagnoseWorkshopProject(project)
      if (report.errors)
        throw new Error(report.diagnostics.find((d) => d.severity === 'error')!.message)
      return exportTep(project)
    },
    list: async () => repo().list().map(workshopProjectSummary),
    get: async (id: string) => {
      const project = repo().get(id)
      if (!project) throw new Error('项目不存在')
      return project
    },
    restoreApplied: async (id: string) => repo().restoreApplied(id),
    duplicate: async (id: string, revision: number) => repo().duplicate(id, revision),
    remove: async (id: string, revision: number) => repo().remove(id, revision),
    preflight: async (id: string, revision: number) => {
      if (!Number.isSafeInteger(revision)) throw new Error('无效项目 revision')
      const project = repo().require(id, revision)
      return workshopDiagnosticReport([
        ...diagnoseWorkshopProject(project).diagnostics,
        ...diagnoseWorkshopAssetEncoding(
          project,
          (dataUrl) => !nativeImage.createFromDataURL(dataUrl).isEmpty()
        )
      ])
    },
    sources: async () => {
      const plugins = await pluginAccess().list()
      const extensions = await pluginAccess().listExtensions()
      return extensions.flatMap((p) =>
        p.themes.map((t) => ({
          pluginId: p.pluginId,
          themeId: t.id,
          name: t.name,
          version: plugins.find((entry) => entry.id === p.pluginId)!.version
        }))
      )
    },
    create: async (template: string, source?: WorkshopThemeSource) =>
      repo().save(
        source
          ? createWorkshopProject(randomUUID(), `${source.name} 自定义`, await snapshot(source))
          : workshopTemplate(randomUUID(), template)
      ),
    save: async (project: WorkshopProject) => {
      stringifyJsonForIpcStorage(project, 'workshop project', MAX_BYTES)
      return repo().save(project)
    },
    importAsset: async (type: 'image' | 'font' = 'image') => {
      if (!['image', 'font'].includes(type)) throw new Error('无效素材类型')
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [
          {
            name: '主题素材',
            extensions: type === 'font' ? ['woff2'] : ['png', 'jpg', 'jpeg', 'webp']
          }
        ]
      })
      if (result.canceled) return null
      return {
        id: randomUUID(),
        name: basename(result.filePaths[0]),
        type,
        dataUrl: await assetData(result.filePaths[0]),
        license: '',
        source: ''
      }
    },
    importProject: async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: '主题编辑项目', extensions: ['teworkshop'] }]
      })
      if (result.canceled) return null
      const bytes = await readFile(result.filePaths[0])
      if (bytes.length > MAX_BYTES) throw new Error('项目超过 64 MB')
      const parsed = tryParseJsonWithNestingLimit(bytes.toString('utf8'))
      if (!parsed.ok || !isWorkshopProject(parsed.value)) throw new Error('无效主题项目')
      return repo().save({ ...parsed.value, id: randomUUID(), revision: 0 })
    },
    updateBase: async (id: string) => {
      const project = repo().get(id)
      if (!project?.base.pluginId || !project.base.themeId) throw new Error('该项目没有来源插件')
      return snapshot({
        pluginId: project.base.pluginId,
        themeId: project.base.themeId,
        name: project.name,
        version: ''
      })
    },
    exportProject: async (id: string, format: 'project' | 'tep', revision?: number) => {
      const project = format === 'tep' ? checked(id, revision) : repo().require(id, revision)
      if (format !== 'project' && format !== 'tep') throw new Error('无效导出格式')
      if (format === 'tep') return exportTep(project)
      const extension = 'teworkshop'
      const result = await dialog.showSaveDialog({
        defaultPath: `theme-${id}.${extension}`,
        filters: [{ name: '主题', extensions: [extension] }]
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, JSON.stringify(await portableProject(project)))
      return result.filePath
    },
    apply: async (id: string, revision?: number) => {
      const project = checked(id, revision)
      const work = await mkdtemp(join(tmpdir(), 'te-workshop-'))
      try {
        const pluginId = await packageProject(project, work)
        await pluginAccess().installFromPath(work)
        await pluginAccess().enable(pluginId)
        const saved = repo().saveApplied({
          ...project,
          lastApplied: { version: project.version, at: new Date().toISOString() }
        })
        return { pluginId, themeId: 'custom', project: saved }
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    }
  }
  const guarded =
    (handler: (...args: never[]) => Promise<unknown>) =>
    async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
      assertTrustedIpcSender(event, 'theme workshop IPC')
      return (handler as (...values: unknown[]) => Promise<unknown>)(...args)
    }
  ipcMain.handle('themeWorkshop:createFromAppearance', guarded(handlers.createFromAppearance))
  ipcMain.handle('themeWorkshop:exportAppearance', guarded(handlers.exportAppearance))
  ipcMain.handle('themeWorkshop:get', guarded(handlers.get))
  ipcMain.handle('themeWorkshop:duplicate', guarded(handlers.duplicate))
  ipcMain.handle('themeWorkshop:remove', guarded(handlers.remove))
  ipcMain.handle('themeWorkshop:preflight', guarded(handlers.preflight))
  ipcMain.handle('themeWorkshop:restoreApplied', guarded(handlers.restoreApplied))
  ipcMain.handle('themeWorkshop:list', guarded(handlers.list))
  ipcMain.handle('themeWorkshop:sources', guarded(handlers.sources))
  ipcMain.handle('themeWorkshop:create', guarded(handlers.create))
  ipcMain.handle('themeWorkshop:save', guarded(handlers.save))
  ipcMain.handle('themeWorkshop:importAsset', guarded(handlers.importAsset))
  ipcMain.handle('themeWorkshop:importProject', guarded(handlers.importProject))
  ipcMain.handle('themeWorkshop:updateBase', guarded(handlers.updateBase))
  ipcMain.handle('themeWorkshop:exportProject', guarded(handlers.exportProject))
  ipcMain.handle('themeWorkshop:apply', guarded(handlers.apply))
}
