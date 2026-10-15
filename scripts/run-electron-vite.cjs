#!/usr/bin/env node
/**
 * electron-vite dev / preview 启动包装。
 *
 * 在 KDE Plasma Wayland 且 KWin 未配置输入法（kwinrc [Wayland] 组无
 * InputMethod）时，向 electron 透传 --ozone-platform=x11，强制应用以
 * X11（XWayland）后端运行 —— fcitx5/ibus 才能通过 GTK_IM_MODULE / XIM
 * 输入中文。原因：
 *  - Electron 43 在 Wayland 会话默认使用 Wayland ozone；
 *  - OZONE_PLATFORM 等环境变量对 Electron 无效；
 *  - app.commandLine.appendSwitch() 无法改变 browser 进程的 ozone 平台；
 *  - 只有真实命令行参数 --ozone-platform=x11 有效。
 * electron-vite 会把 `--` 之后的参数原样传给 electron
 * （ELECTRON_CLI_ARGS 机制），因此这里只需要在启动时追加即可。
 *
 * 用法：node scripts/run-electron-vite.cjs dev | preview
 * 对应 package.json 中的 "dev" / "start" 脚本。
 */
'use strict'

const { spawn } = require('node:child_process')
const { homedir } = require('node:os')
const { dirname, join } = require('node:path')
const { readFileSync } = require('node:fs')

const command = process.argv[2]
if (command !== 'dev' && command !== 'preview') {
  console.error('用法：node scripts/run-electron-vite.cjs <dev|preview>')
  process.exit(2)
}

function kwinHasInputMethodConfigured() {
  try {
    const content = readFileSync(join(homedir(), '.config', 'kwinrc'), 'utf8')
    const waylandSection = content.match(/^\[Wayland\]([\s\S]*?)(?=^\s*\[|$)/m)
    if (!waylandSection) return false
    return /^\s*InputMethod\s*=/m.test(waylandSection[1])
  } catch {
    return false
  }
}

function shouldUseX11Backend() {
  if (process.platform !== 'linux' || process.env.XDG_SESSION_TYPE !== 'wayland') {
    return false
  }
  const desktop = (
    process.env.XDG_CURRENT_DESKTOP ||
    process.env.XDG_SESSION_DESKTOP ||
    ''
  ).toLowerCase()
  const isKWin = desktop.includes('kde') || desktop.includes('plasma')
  return isKWin && !kwinHasInputMethodConfigured()
}

// 用户通过 `pnpm run dev -- <electron参数>` 透传的额外 electron 参数
const electronArgs = process.argv.slice(3)
if (shouldUseX11Backend()) {
  electronArgs.unshift('--ozone-platform=x11')
}
// 统一放在 `--` 之后，交给 electron-vite 原样传给 electron
const args = [command, '--', ...electronArgs]

// Invoke the installed CLI directly. Shell metacharacters in forwarded Electron
// arguments must stay literal, and installation paths can contain spaces.
const entry = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [entry, ...args], {
  stdio: 'inherit',
  shell: false,
  windowsHide: true
})
child.on('error', (error) => {
  console.error('启动失败:', error.message)
  process.exitCode = 1
})
child.on('close', (code) => {
  process.exit(code ?? process.exitCode ?? 0)
})
