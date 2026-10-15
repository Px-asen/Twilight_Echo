import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from 'electron'

export const DSP_EDITOR_WINDOW_NAME = 'twilight-dsp-editor'
const editorWindows = new WeakMap<BrowserWindow, BrowserWindow>()

export function registerDspEditorWindow(owner: BrowserWindow, child: BrowserWindow): void {
  editorWindows.set(owner, child)
  child.once('closed', () => {
    if (editorWindows.get(owner) === child) editorWindows.delete(owner)
  })
}

export function dspEditorInteractionWindow(
  owner: BrowserWindow,
  focused: BrowserWindow | null
): BrowserWindow {
  const editor = editorWindows.get(owner)
  return editor && editor === focused && !editor.isDestroyed() ? editor : owner
}

export function isDspEditorWindowRequest(url: string, frameName: string): boolean {
  return url === 'about:blank' && frameName === DSP_EDITOR_WINDOW_NAME
}

export function dspEditorWindowOptions(workArea: Rectangle): BrowserWindowConstructorOptions {
  const width = Math.min(1120, workArea.width)
  const height = Math.min(800, workArea.height)
  return {
    title: 'DSP · Twilight Echo',
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    minWidth: Math.min(600, width),
    minHeight: Math.min(480, height),
    frame: true,
    transparent: false,
    backgroundColor: '#202024',
    autoHideMenuBar: true,
    alwaysOnTop: false,
    modal: false
  }
}
