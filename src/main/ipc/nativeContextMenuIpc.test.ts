import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMainInvokeEvent, IpcMain } from 'electron'
import {
  normalizeNativeContextMenu,
  nativeMenuTemplate,
  registerNativeContextMenuIpc
} from './nativeContextMenuIpc.ts'

test('menu IPC accepts only labels, IDs, enabled state and bounded submenus', () => {
  const request = normalizeNativeContextMenu({
    requestId: 'one',
    items: [
      {
        id: 'parent',
        label: 'R&B',
        role: 'quit',
        click: 'arbitrary code',
        submenu: [{ id: 'song', label: '歌曲', enabled: false }]
      }
    ]
  })
  assert.deepEqual(request.items[0], {
    id: 'parent',
    label: 'R&B',
    enabled: true,
    submenu: [{ id: 'song', label: '歌曲', enabled: false }]
  })
  assert.throws(
    () =>
      normalizeNativeContextMenu({
        requestId: 'one',
        items: [
          { id: 'a', label: 'a' },
          { id: 'a', label: 'b' }
        ]
      }),
    /duplicate/
  )
  assert.throws(
    () => normalizeNativeContextMenu({ requestId: 'one', items: [{ id: 'a', label: 'a\nquit' }] }),
    /invalid/
  )
  assert.throws(
    () =>
      normalizeNativeContextMenu({
        requestId: 'one',
        items: Array(1001).fill({ id: 'a', label: 'a' })
      }),
    /Invalid/
  )
})

test('native template only returns the selected action ID and keeps disabled actions inactive', () => {
  const selected: string[] = []
  const template = nativeMenuTemplate(
    [
      { id: 'one', label: 'R&B' },
      { id: 'disabled', label: '禁用', enabled: false }
    ],
    (id) => selected.push(id)
  )
  assert.equal(template[0].label, 'R&&B')
  const click = (index: number): void => {
    ;(template[index].click as () => void)()
  }
  click(0)
  click(1)
  assert.deepEqual(selected, ['one'])
})

test('main handlers verify the sender before showing or closing menus and preserve cancellation', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>()
  const ipc = {
    handle: (channel, handler) => {
      handlers.set(channel, handler)
    }
  } as Pick<IpcMain, 'handle'>
  const event = {} as IpcMainInvokeEvent
  let trusted = true
  const closed: string[] = []
  registerNativeContextMenuIpc(ipc, {
    assertTrusted: () => {
      if (!trusted) throw new Error('Untrusted')
    },
    popup: async (_event, request) => request.items[0]?.id ?? null,
    close: (_event, id) => {
      closed.push(id)
    }
  })
  assert.equal(
    await handlers.get('contextMenu:popup')!(event, { requestId: 'one', items: [] }),
    null
  )
  assert.equal(
    await handlers.get('contextMenu:popup')!(event, {
      requestId: 'two',
      items: [{ id: 'a', label: '播放' }]
    }),
    'a'
  )
  handlers.get('contextMenu:close')!(event, 'two')
  assert.deepEqual(closed, ['two'])
  trusted = false
  assert.throws(() => handlers.get('contextMenu:popup')!(event, {}), /Untrusted/)
  assert.throws(() => handlers.get('contextMenu:close')!(event, 'two'), /Untrusted/)
})
