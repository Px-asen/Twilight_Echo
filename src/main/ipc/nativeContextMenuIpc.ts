import type { IpcMain, IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import type {
  NativeContextMenuItem,
  NativeContextMenuRequest
} from '../../shared/nativeContextMenu.ts'
import { normalizeIpcString } from '../security/ipcValidation.ts'

export function normalizeNativeContextMenu(value: unknown): NativeContextMenuRequest {
  const input = value as NativeContextMenuRequest
  const requestId = normalizeIpcString(input?.requestId, 'menu request', 128)
  const ids = new Set<string>()
  function items(value: unknown, depth: number): NativeContextMenuItem[] {
    if (!Array.isArray(value) || depth > 3 || value.length > 1000)
      throw new Error('Invalid menu items')
    return value.map((item) => {
      const id = normalizeIpcString(item?.id, 'menu item id', 128)
      if (ids.has(id) || ids.size >= 1000)
        throw new Error('Invalid menu item count or duplicate id')
      ids.add(id)
      return {
        id,
        label: normalizeIpcString(item?.label, 'menu label', 512),
        enabled: item?.enabled !== false,
        ...(item?.submenu === undefined ? {} : { submenu: items(item.submenu, depth + 1) })
      }
    })
  }
  return { requestId, items: items(input.items, 0) }
}

export function nativeMenuTemplate(
  items: NativeContextMenuItem[],
  select: (id: string) => void
): MenuItemConstructorOptions[] {
  return items.map((item) => ({
    label: item.label.replace(/&/g, '&&'),
    enabled: item.enabled,
    ...(item.submenu
      ? { submenu: nativeMenuTemplate(item.submenu, select) }
      : {
          click: () => {
            if (item.enabled !== false) select(item.id)
          }
        })
  }))
}

export function registerNativeContextMenuIpc(
  ipc: Pick<IpcMain, 'handle'>,
  services: {
    assertTrusted: (event: IpcMainInvokeEvent, scope: string) => void
    popup: (event: IpcMainInvokeEvent, request: NativeContextMenuRequest) => Promise<string | null>
    close: (event: IpcMainInvokeEvent, requestId: string) => void
  }
): void {
  ipc.handle('contextMenu:popup', (event, value: unknown) => {
    services.assertTrusted(event, 'native context menu')
    return services.popup(event, normalizeNativeContextMenu(value))
  })
  ipc.handle('contextMenu:close', (event, requestId: unknown) => {
    services.assertTrusted(event, 'native context menu')
    services.close(event, normalizeIpcString(requestId, 'menu request', 128))
  })
}
