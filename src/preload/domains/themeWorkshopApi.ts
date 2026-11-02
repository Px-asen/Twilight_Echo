import { ipcRenderer } from 'electron'
import type { ThemeWorkshopApi } from '../../shared/themeWorkshop.ts'

export const themeWorkshopApi: ThemeWorkshopApi = {
  createFromAppearance: (input) => ipcRenderer.invoke('themeWorkshop:createFromAppearance', input),
  exportAppearance: (input) => ipcRenderer.invoke('themeWorkshop:exportAppearance', input),
  get: (id) => ipcRenderer.invoke('themeWorkshop:get', id),
  restoreApplied: (id) => ipcRenderer.invoke('themeWorkshop:restoreApplied', id),
  list: () => ipcRenderer.invoke('themeWorkshop:list'),
  sources: () => ipcRenderer.invoke('themeWorkshop:sources'),
  create: (template, source) => ipcRenderer.invoke('themeWorkshop:create', template, source),
  save: (project) => ipcRenderer.invoke('themeWorkshop:save', project),
  duplicate: (id, revision) => ipcRenderer.invoke('themeWorkshop:duplicate', id, revision),
  remove: (id, revision) => ipcRenderer.invoke('themeWorkshop:remove', id, revision),
  preflight: (id, revision) => ipcRenderer.invoke('themeWorkshop:preflight', id, revision),
  importProject: () => ipcRenderer.invoke('themeWorkshop:importProject'),
  exportProject: (id, format, revision) =>
    ipcRenderer.invoke('themeWorkshop:exportProject', id, format, revision),
  importAsset: (type) => ipcRenderer.invoke('themeWorkshop:importAsset', type),
  updateBase: (id) => ipcRenderer.invoke('themeWorkshop:updateBase', id),
  apply: (id, revision) => ipcRenderer.invoke('themeWorkshop:apply', id, revision)
}
