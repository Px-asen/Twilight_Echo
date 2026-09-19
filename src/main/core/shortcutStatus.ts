import { isCommandPaletteAccelerator } from '../../shared/commandPaletteShortcut.ts'

export interface PlayerShortcutDefinition<Action extends string = string> {
  accelerator: string
  action: Action
  label: string
}

export function buildPlayerShortcutStatuses<Action extends string>(
  shortcuts: Array<PlayerShortcutDefinition<Action>>,
  enabled: boolean,
  register: (accelerator: string) => boolean
): Array<PlayerShortcutDefinition<Action> & { registered: boolean; error: string | null }> {
  return shortcuts.map((shortcut) => {
    if (!enabled) {
      return {
        ...shortcut,
        registered: false,
        error: null
      }
    }

    if (isCommandPaletteAccelerator(shortcut.accelerator)) {
      return {
        ...shortcut,
        registered: false,
        error: 'Ctrl+K / ⌘K 已保留给应用内命令面板，请选择其他全局组合键'
      }
    }
    const registered = register(shortcut.accelerator)
    return {
      ...shortcut,
      registered,
      error: registered
        ? null
        : `快捷键注册失败，可能已被系统或其他应用占用：${shortcut.accelerator}`
    }
  })
}
