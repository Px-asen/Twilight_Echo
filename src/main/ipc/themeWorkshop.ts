import { app, dialog, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, isAbsolute } from 'node:path'
import { runtime } from '../core/runtime.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'
import { tryParseJsonWithNestingLimit } from '../security/jsonSafety.ts'
import { WorkshopRepository } from '../themes/workshopRepository.ts'
import { writeStoredZip } from '../themes/themeArchive.ts'
import { workshopTemplate } from '../../shared/themeWorkshopTemplates.ts'
import {
  THEME_WORKSHOP_ID,
  createWorkshopProject,
  compileWorkshopTheme,
  workshopProjectSummary,
  exportWorkshopEditor,
  isWorkshopProject,
  normalizeThemeEditor,
  type WorkshopBase,
  type WorkshopProject,
  type WorkshopThemeSource
} from '../../shared/themeWorkshop.ts'

const MAX_BYTES = 64 * 1024 * 1024
const editors = new Map<number, WebContents>()
const pendingDisables = new Map<
  string,
  { senderId: number; finish: (error: string | null) => void }
>()

export async function prepareThemeWorkshopDisable(): Promise<void> {
  await Promise.all(
    [...editors.values()]
      .filter((contents) => !contents.isDestroyed())
      .map(
        (contents) =>
          new Promise<void>((resolveRequest, rejectRequest) => {
            const requestId = randomUUID()
            const timer = setTimeout(() => finish('工坊尚未完成保存，请稍后重试停用'), 8000)
            function finish(error: string | null): void {
              clearTimeout(timer)
              pendingDisables.delete(requestId)
              if (error) rejectRequest(new Error(error))
              else resolveRequest()
            }
            pendingDisables.set(requestId, { senderId: contents.id, finish })
            contents.send('themeWorkshop:prepareDisable', requestId)
          })
      )
  )
}
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
  if (bytes.length > 16 * 1024 * 1024) throw new Error('单个素材不能超过 16 MB')
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function snapshot(source: WorkshopThemeSource): Promise<WorkshopBase> {
  const manager = runtime.pluginManager!
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
  const pluginId = `com.twilightecho.theme.user-${project.id}`
  const compiled = compileWorkshopTheme(project)
  await writeFile(join(work, 'theme.css'), compiled.css)
  await writeFile(
    join(work, 'plugin.json'),
    JSON.stringify(
      {
        id: pluginId,
        name: project.name,
        description: project.description || '主题插件工坊创建的主题',
        version: project.version,
        author: project.author || project.base.author || '个人主题',
        license: project.base.license || 'UNLICENSED',
        type: ['theme'],
        apiVersion: 3,
        engines: { twilightEcho: '>=1.2.0' },
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
  ipcMain.handle('themeWorkshop:editorSession', async (event, active: boolean) => {
    assertTrustedIpcSender(event, 'theme workshop session')
    if (typeof active !== 'boolean') throw new Error('无效编辑器会话')
    if (!active) {
      editors.delete(event.sender.id)
      return
    }
    await runtime.pluginManagerReady
    const enabled = (await runtime.pluginManager!.list()).some(
      (plugin) => plugin.id === THEME_WORKSHOP_ID && plugin.enabled
    )
    if (!enabled) throw new Error('请先启用主题插件工坊')
    if (!editors.has(event.sender.id)) {
      const senderId = event.sender.id
      event.sender.once('destroyed', () => {
        editors.delete(senderId)
      })
    }
    editors.set(event.sender.id, event.sender)
  })
  ipcMain.handle(
    'themeWorkshop:readyToDisable',
    async (event, requestId: string, error: string | null) => {
      assertTrustedIpcSender(event, 'theme workshop session')
      if (typeof requestId !== 'string' || (error !== null && typeof error !== 'string'))
        throw new Error('无效保存响应')
      const request = pendingDisables.get(requestId)
      if (request?.senderId === event.sender.id) request.finish(error)
    }
  )
  let repository: WorkshopRepository | undefined
  const repo = (): WorkshopRepository =>
    (repository ??= new WorkshopRepository(
      join(app.getPath('userData'), 'theme-workshop', 'projects')
    ))
  const handlers = {
    list: async () => repo().list().map(workshopProjectSummary),
    get: async (id: string) => {
      const project = repo().get(id)
      if (!project) throw new Error('项目不存在')
      return project
    },
    restoreApplied: async (id: string) => repo().restoreApplied(id),
    sources: async () => {
      const plugins = await runtime.pluginManager!.list()
      const extensions = await runtime.pluginManager!.listExtensions()
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
        filters: [{ name: '工坊项目', extensions: ['teworkshop'] }]
      })
      if (result.canceled) return null
      const bytes = await readFile(result.filePaths[0])
      if (bytes.length > MAX_BYTES) throw new Error('项目超过 64 MB')
      const parsed = tryParseJsonWithNestingLimit(bytes.toString('utf8'))
      if (!parsed.ok || !isWorkshopProject(parsed.value)) throw new Error('无效工坊项目')
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
    exportProject: async (id: string, format: 'project' | 'tep') => {
      const project = repo().get(id)
      if (!project) throw new Error('项目不存在')
      if (format !== 'project' && format !== 'tep') throw new Error('无效导出格式')
      const extension = format === 'tep' ? 'tep' : 'teworkshop'
      const result = await dialog.showSaveDialog({
        defaultPath: `theme-${id}.${extension}`,
        filters: [{ name: '主题', extensions: [extension] }]
      })
      if (result.canceled || !result.filePath) return null
      if (format === 'project') await writeFile(result.filePath, JSON.stringify(project))
      else {
        const work = await mkdtemp(join(tmpdir(), 'te-workshop-'))
        try {
          await packageProject(project, work)
          await writeStoredZip(work, result.filePath)
        } finally {
          await rm(work, { recursive: true, force: true })
        }
      }
      return result.filePath
    },
    apply: async (id: string) => {
      const project = repo().get(id)
      if (!project) throw new Error('项目不存在')
      const work = await mkdtemp(join(tmpdir(), 'te-workshop-'))
      try {
        const pluginId = await packageProject(project, work)
        await runtime.pluginManager!.installFromPath(work)
        await runtime.pluginManager!.enable(pluginId)
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
      await runtime.pluginManagerReady
      const plugin = (await runtime.pluginManager!.list()).find((p) => p.id === THEME_WORKSHOP_ID)
      if (!plugin?.enabled) throw new Error('请先启用主题插件工坊')
      return (handler as (...values: unknown[]) => Promise<unknown>)(...args)
    }
  ipcMain.handle('themeWorkshop:get', guarded(handlers.get))
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
