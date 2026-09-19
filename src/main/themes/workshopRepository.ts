import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isWorkshopProject, type WorkshopProject } from '../../shared/themeWorkshop.ts'
import { loadJsonFileWithBackup, writeJsonValueAtomic } from '../persistence/jsonFile.ts'

const options = { label: '主题工坊项目', maxBytes: 64 * 1024 * 1024, validate: isWorkshopProject }

export class WorkshopRepository {
  constructor(privateRoot: string) {
    this.root = privateRoot
    mkdirSync(this.root, { recursive: true })
  }
  private readonly root: string

  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效项目 ID')
    return join(this.root, `${id}.json`)
  }

  get(id: string): WorkshopProject | null {
    const result = loadJsonFileWithBackup(this.path(id), options)
    return result.status === 'missing' ? null : result.value
  }

  list(): WorkshopProject[] {
    return readdirSync(this.root)
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => this.get(name.slice(0, -5))!)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  saveApplied(project: WorkshopProject): WorkshopProject {
    const next = this.save(project)
    writeJsonValueAtomic(join(this.root, next.id + '.applied.json'), next, options)
    return next
  }

  restoreApplied(id: string): WorkshopProject {
    const current = this.get(id)
    if (!current) throw new Error('项目不存在')
    const result = loadJsonFileWithBackup(join(this.root, id + '.applied.json'), options)
    if (result.status === 'missing') throw new Error('还没有应用过这个项目')
    return this.save({ ...result.value, revision: current.revision })
  }

  save(project: WorkshopProject): WorkshopProject {
    if (!isWorkshopProject(project)) throw new Error('无效工坊项目')
    const previous = this.get(project.id)
    if (previous && previous.revision !== project.revision)
      throw new Error('项目已在其他窗口修改，请重新打开')
    const next = { ...project, revision: project.revision + 1, updatedAt: new Date().toISOString() }
    writeJsonValueAtomic(this.path(project.id), next, options)
    return next
  }
}
