import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('local companion lyrics IPC handlers keep authorization and file suffixes', () => {
  const source = readFileSync(new URL('./lyricsIpc.ts', import.meta.url), 'utf8')

  assert.match(source, /ipcMain\.handle\(\s*'lyrics:getTranslated'/)
  assert.match(source, /ipcMain\.handle\(\s*'lyrics:getRomanized'/)
  assert.match(source, /assertTrustedIpcSender\(event, 'lyrics translated IPC'\)/)
  assert.match(source, /assertTrustedIpcSender\(event, 'lyrics romanized IPC'\)/)
  assert.match(source, /resolveAuthorizedAudioFile\(normalizeLocalPath\(filePath/)
  assert.match(source, /resolveAuthorizedLibraryDirectory\(\s*normalizeLocalPath\(dir/)
  assert.match(source, /normalizeIpcString\(fileName, 'lyrics file name'/)
  assert.match(source, /_trans\.lrc/)
  assert.match(source, /_roma\.lrc/)
})
