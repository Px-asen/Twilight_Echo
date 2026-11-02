import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipcChannels.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { registerWindowIpc } from './windowIpc.ts'
import { registerShellIpc } from './shellIpc.ts'
import { registerDiscordIpc } from './discordIpc.ts'
import { registerAppIpc } from './appIpc.ts'
import { registerFontsIpc } from './fonts.ts'
import { registerSettingsIpc } from './settingsIpc.ts'
import { registerFilesystemIpc } from './filesystemIpc.ts'
import { registerCoverIpc } from './coverIpc.ts'
import { registerAfterglowModeIpc } from './afterglowModeIpc.ts'
import { registerCoreAudioDiagnosticsIpc } from './coreAudioDiagnosticsIpc.ts'

/** Window/OS capabilities only; music commands use the finite Core bridge. */
export function setupCoreShellIpc(): void {
  ipcMain.handle(IPC.audioEngine.isHtmlAudioFallbackAllowed, (event) => {
    assertTrustedIpcSender(event, 'audio capability IPC')
    return false
  })
  registerCoreAudioDiagnosticsIpc(ipcMain)
  registerWindowIpc(ipcMain)
  registerShellIpc(ipcMain)
  registerDiscordIpc(ipcMain)
  registerAppIpc(ipcMain)
  registerFontsIpc(ipcMain)
  registerSettingsIpc(ipcMain)
  registerFilesystemIpc(ipcMain)
  registerCoverIpc(ipcMain)
  registerAfterglowModeIpc(ipcMain)
}
