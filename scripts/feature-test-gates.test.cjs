const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const { join, relative } = require('node:path')
const test = require('node:test')
const { PRODUCT_SCRIPTS } = require('./run-product-quality-gate.cjs')

const root = join(__dirname, '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const workflow = readFileSync(join(root, '.github', 'workflows', 'audio-engine.yml'), 'utf8')
const finalIntegratedGate = readFileSync(
  join(root, 'scripts', 'run-final-integrated-gate.ps1'),
  'utf8'
)
const windowsReleaseGate = readFileSync(join(root, 'docs', 'windows-release-gate.md'), 'utf8')
const windowsRequiredCommands = markdownSection(windowsReleaseGate, 'Required Commands')

const lyricsTests = [
  'src/main/lyrics/importLyrics.test.ts',
  'src/main/lyrics/saveLyrics.test.ts',
  'src/main/ipc/lyricsIpc.test.ts',
  'src/main/persistence/lyricsManagementPersistence.test.ts',
  'src/shared/lyricsEncoding.test.ts',
  'src/shared/lyricsManagement.test.ts',
  'src/shared/desktopLyrics.test.ts',
  'src/renderer/src/desktop-lyrics/desktopLyricsClock.test.ts',
  'src/renderer/src/desktop-lyrics/DesktopLyricsApp.behavior.test.ts',
  'src/renderer/src/app/useDesktopLyricsPublisher.test.ts',
  'src/renderer/src/utils/lyrics.test.ts',
  'src/renderer/src/utils/lyricSourceResolution.test.ts',
  'src/renderer/src/utils/lyricSpring.test.ts',
  'src/renderer/src/utils/lyricWordChunks.test.ts',
  'src/renderer/src/utils/lyricTimeline.test.ts',
  'src/renderer/src/utils/lyricLineLayout.test.ts',
  'src/renderer/src/utils/lyricEmphasis.test.ts',
  'src/renderer/src/utils/managedLyricsSource.test.ts',
  'src/renderer/src/utils/nowPlayingLayout.test.ts',
  'src/renderer/src/stores/lyricsManagement.test.ts',
  'src/renderer/src/stores/lyricsPlayerStore.behavior.test.ts',
  'src/renderer/src/components/PlayingMusic.test.ts',
  'src/renderer/src/components/PlayingMusic.lyrics.behavior.test.ts'
]

const radioRemoteTests = [
  'src/main/library/watcher.test.ts',
  'src/main/network/entryKinds.test.ts',
  'src/main/network/networkCache.test.ts',
  'src/main/network/networkCover.test.ts',
  'src/main/network/networkLibrary.test.ts',
  'src/main/network/networkMetadata.test.ts',
  'src/main/network/networkPath.test.ts',
  'src/main/network/profileStore.test.ts',
  'src/main/network/sourcesManager.test.ts',
  'src/main/network/textValidation.test.ts',
  'src/main/network/adapters/dlnaAdapter.test.ts',
  'src/main/network/adapters/ftpAdapter.test.ts',
  'src/main/network/adapters/nfsMountAdapter.test.ts',
  'src/main/network/adapters/sftpSystemAdapter.test.ts',
  'src/main/network/adapters/smbMountAdapter.test.ts',
  'src/main/network/adapters/webdavAdapter.test.ts',
  'src/main/radio/playlistImport.test.ts',
  'src/main/radio/radioBrowserClient.test.ts',
  'src/main/radio/radioMediaIpc.test.ts',
  'src/main/radio/radioMediaService.test.ts',
  'src/main/radio/rssParser.test.ts',
  'src/main/remote/auth.test.ts',
  'src/main/remote/chromecastClient.test.ts',
  'src/main/remote/didl.test.ts',
  'src/main/remote/httpServer.mediaOnly.test.ts',
  'src/main/remote/mediaTokens.test.ts',
  'src/main/remote/soap.test.ts',
  'src/main/remote/ssdp.test.ts',
  'src/renderer/src/utils/coverLoader.test.ts',
  'src/renderer/src/utils/trackCoverDisplay.test.ts',
  'src/shared/podcastSubscriptions.test.ts',
  'src/shared/radioStations.test.ts',
  'src/shared/remoteControl.test.ts'
]

const networkSourceTests = [
  'src/main/network/entryKinds.test.ts',
  'src/main/network/networkCache.test.ts',
  'src/main/network/networkCover.test.ts',
  'src/main/network/networkLibrary.test.ts',
  'src/main/network/networkMetadata.test.ts',
  'src/main/network/networkPath.test.ts',
  'src/main/network/profileStore.test.ts',
  'src/main/network/sourcesManager.test.ts',
  'src/main/network/textValidation.test.ts',
  'src/main/network/adapters/dlnaAdapter.test.ts',
  'src/main/network/adapters/ftpAdapter.test.ts',
  'src/main/network/adapters/nfsMountAdapter.test.ts',
  'src/main/network/adapters/sftpSystemAdapter.test.ts',
  'src/main/network/adapters/smbMountAdapter.test.ts',
  'src/main/network/adapters/webdavAdapter.test.ts'
]

const playlistLifecycleTests = [
  'src/renderer/src/components/SongList.playlist-lifecycle.behavior.test.ts',
  'src/renderer/src/stores/playlistCasPersistence.test.ts',
  'src/renderer/src/stores/playlistPersistence.test.ts',
  'src/renderer/src/utils/playlistLifecycle.test.ts',
  'src/renderer/src/utils/playlistExport.test.ts',
  'src/renderer/src/utils/playlistFileValidation.test.ts'
]

const tagDuplicateTests = [
  'src/main/library/tagWriteIpc.test.ts',
  'src/main/library/duplicateDetection.test.ts',
  'src/main/library/duplicateDetectionIpc.test.ts',
  'src/renderer/src/utils/localLibraryTagManagement.test.ts',
  'src/renderer/src/components/LocalLibraryTagManager.a11y.test.ts'
]

const themeTests = [
  'scripts/theme-visual-regression.test.cjs',
  'src/shared/theme.test.ts',
  'src/main/themes/themeArchiveValidation.test.ts',
  'src/main/themes/themeLibraryRepository.test.ts',
  'src/renderer/src/app/useAppNavigation.test.ts',
  'src/renderer/src/components/SettingsPage.theme.test.ts',
  'src/renderer/src/components/themeColorAudit.test.ts',
  'src/renderer/src/components/themeTokenization.test.ts',
  'src/renderer/src/components/song-list/themeSwitchVirtualizationStress.test.ts',
  'src/renderer/src/utils/themePerformance.test.ts',
  'src/renderer/src/utils/themePreviewScheduler.test.ts'
]

const recursivelyOwnedTestFiles = ['scripts', 'src', 'packages', 'resources']
  .flatMap((directory) => collectTestFiles(join(root, directory)))
  .sort()

test('lyrics management gate owns every core, persistence, source, and real UI behavior test', () => {
  const command = packageJson.scripts['test:lyrics-management']
  assert.equal(typeof command, 'string')
  assert.match(command, /^node --experimental-strip-types --test /)
  for (const file of lyricsTests) assert.match(command, new RegExp(escapeRegExp(file)))
})

test('radio and remote gate owns library watcher, radio, podcast, cover, and remote control tests', () => {
  const command = packageJson.scripts['test:radio-remote']
  assert.equal(typeof command, 'string')
  for (const file of radioRemoteTests) assert.match(command, new RegExp(escapeRegExp(file)))
})

test('network source gate owns profile, path, cache, metadata, and adapter tests', () => {
  const command = packageJson.scripts['test:network-sources']
  assert.equal(typeof command, 'string')
  assert.match(command, /^node --experimental-strip-types --test /)
  for (const file of networkSourceTests) assert.match(command, new RegExp(escapeRegExp(file)))
})

test('playlist lifecycle gate retains production DOM, persistence, format, and validation tests', () => {
  const command = packageJson.scripts['test:playlist-lifecycle']
  assert.equal(typeof command, 'string')
  for (const file of playlistLifecycleTests) assert.match(command, new RegExp(escapeRegExp(file)))
})

test('tag and duplicate gate owns mutation, authorization, inspection, cache, and real UI tests', () => {
  const command = packageJson.scripts['test:tag-duplicate-management']
  assert.equal(typeof command, 'string')
  for (const file of tagDuplicateTests) assert.match(command, new RegExp(escapeRegExp(file)))
})

test('theme gate owns contracts, archive preflight, and navigation integration', () => {
  const command = packageJson.scripts['test:themes']
  assert.equal(typeof command, 'string')
  assert.match(command, /^node --experimental-strip-types --test /)
  for (const file of themeTests) assert.match(command, new RegExp(escapeRegExp(file)))
})

test('duplicate benchmark scripts retain the authenticated contract and isolated live runner', () => {
  const contract = packageJson.scripts['test:duplicate-detection-benchmark']
  const live = packageJson.scripts['benchmark:duplicate-detection:ci']
  const archive = packageJson.scripts['benchmark:duplicate-detection']
  assert.match(contract, /scripts\/duplicate-detection-benchmark\.test\.ts/)
  assert.match(live, /--expose-gc scripts\/duplicate-detection-benchmark\.ts$/)
  assert.match(
    archive,
    /--output docs\/audit-evidence\/te-4\.4-duplicate-detection-2026-09-30\.json/
  )
  assert.match(
    archive,
    /--manifest docs\/audit-evidence\/te-4\.4-duplicate-detection-2026-09-30\.manifest\.json/
  )
})

test('required Windows CI runs complete product outcomes with native fixtures and bounded workers', () => {
  assert.match(packageJson.scripts['test:local-perf'], /--test-concurrency=2\b/)
  assert.match(packageJson.scripts['test:plugins'], /--test-concurrency=2\b/)
  assert.ok(workflow, 'the required CI workflow must exist')
  for (const job of ['repository', 'native-audio', 'required']) {
    const jobBlock = workflow.match(
      new RegExp(`^  ${job}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|(?![\\s\\S]))`, 'm')
    )?.[1]
    assert.ok(jobBlock, `${job} must remain a required job`)
    assert.match(jobBlock, /runs-on: windows-latest/)
    assert.doesNotMatch(jobBlock, /matrix:|runs-on: (?:ubuntu|macos)-latest/)
  }
  assert.doesNotMatch(workflow, /xvfb-run/)
  assert.match(workflow, /W64DEVKIT_ROOT=/)
  assert.match(workflow, /run: pnpm run test:product/)
  const productStep = workflow.match(
    /name: Test product behavior\r?\n([\s\S]*?)(?=\r?\n\s+- name:)/
  )?.[1]
  assert.ok(productStep, 'the product test step must exist')
  for (const name of ['TEMP', 'TMP']) {
    assert.match(
      productStep,
      new RegExp(`^\\s+${name}: \\$\\{\\{ runner\\.temp \\}\\}\\r?$`, 'm'),
      'Windows product fixtures must use the runner temporary directory without user aliases'
    )
  }
  // These checks already run inside test:product, and build includes typecheck.
  assert.doesNotMatch(workflow, /run: pnpm run (?:test:quality-policy|typecheck)\b/)
  assert.match(workflow, /product-quality-gate\.json/)
  for (const script of [
    'test:plugins',
    'test:playlist-lifecycle',
    'test:lyrics-management',
    'test:tag-duplicate-management',
    'test:local-perf',
    'test:app',
    'test:themes',
    'test:dsp-graph'
  ]) {
    assert.ok(
      PRODUCT_SCRIPTS.includes(script),
      `${script} must run inside the Windows product gate`
    )
  }
  assert.match(workflow, /pnpm run test:duplicate-detection-benchmark/)
  assert.match(workflow, /pnpm run benchmark:duplicate-detection:ci --/)
  assert.match(
    workflow,
    /name: Run isolated duplicate detection 10k benchmark\r?\n\s+id: duplicate-benchmark\r?\n\s+if: github\.event_name == 'workflow_dispatch'/
  )
  assert.match(workflow, /if: always\(\) && steps\.duplicate-benchmark\.outcome != 'skipped'/)
  assert.match(workflow, /duplicate-detection-benchmark\.manifest\.json/)
  assert.ok(
    workflow.indexOf('Test product behavior') >= 0 &&
      workflow.indexOf('Test product behavior') <
        workflow.indexOf('Run isolated duplicate detection 10k benchmark')
  )
})

test('CI keeps Windows checks automatic and package workflows manual with release builds', () => {
  assert.doesNotMatch(workflow, /mac-release:|runs-on: (?:macos|ubuntu)|build:(?:mac|linux)/)
  for (const file of ['build-linux.yml', 'build-macos.yml']) {
    const packaging = readFileSync(join(root, '.github', 'workflows', file), 'utf8')
    const triggers = packaging.match(/^on:\r?\n([\s\S]*?)(?=^[^\s#])/m)?.[1]
    assert.match(triggers ?? '', /^\s*workflow_dispatch:/, `${file} must support manual packaging`)
    assert.match(triggers ?? '', /push:\s+tags:\s+- ['"]v\*['"]/, `${file} builds release tags`)
  }
  const macPackaging = readFileSync(join(root, '.github', 'workflows', 'build-macos.yml'), 'utf8')
  assert.match(macPackaging, /runner: macos-15-intel/)
  assert.match(macPackaging, /runner: macos-15\r?\n/)
  assert.match(workflow, /needs: \[repository, native-audio\]/)
  assert.ok(PRODUCT_SCRIPTS.includes('test:app'))
  assert.ok(PRODUCT_SCRIPTS.includes('test:renderer-data-tooling'))
  for (const file of [
    'feature-test-gates.test.cjs',
    'architecture-boundaries.test.cjs',
    'ipc-channel-consistency.test.cjs'
  ]) {
    assert.ok(packageJson.scripts['test:app'].includes(file))
  }
  assert.ok(
    packageJson.scripts['test:renderer-data-tooling'].includes('run-product-quality-gate.test.cjs')
  )
  assert.match(packageJson.scripts.build, /^pnpm run typecheck &&/)
})

test('Windows no-device and release gates cannot omit product suites or the live duplicate benchmark', () => {
  const noDevice = packageJson.scripts['test:no-real-device']
  assert.match(noDevice, /pnpm run test:playlist-lifecycle/)
  assert.match(noDevice, /pnpm run test:lyrics-management/)
  assert.match(noDevice, /pnpm run test:radio-remote/)
  assert.match(noDevice, /pnpm run test:network-sources/)
  assert.match(noDevice, /pnpm run test:tag-duplicate-management/)
  assert.match(noDevice, /pnpm run test:themes/)
  assert.match(noDevice, /pnpm run test:duplicate-detection-benchmark/)
  assert.match(noDevice, /pnpm run benchmark:duplicate-detection:ci/)
  assert.match(windowsReleaseGate, /pnpm run test:playlist-lifecycle/)
  assert.match(windowsReleaseGate, /pnpm run test:lyrics-management/)
  assert.match(windowsReleaseGate, /pnpm run test:radio-remote/)
  assert.match(windowsReleaseGate, /pnpm run test:network-sources/)
  assert.match(windowsReleaseGate, /pnpm run test:tag-duplicate-management/)
  assert.match(windowsReleaseGate, /pnpm run test:themes/)
  assert.match(windowsReleaseGate, /pnpm run test:duplicate-detection-benchmark/)
  assert.match(windowsReleaseGate, /pnpm run benchmark:duplicate-detection:ci/)
})

test('every repository test file is explicitly owned by a package test script', () => {
  const testCommands = Object.entries(packageJson.scripts)
    .filter(([name]) => name.startsWith('test:'))
    .map(([, command]) => command)
    .join('\n')
  const appearanceRunner = packageJson.scripts['test:appearance-workspace']?.includes(
    'run-appearance-tests.cjs'
  )
    ? readFileSync(join(root, 'scripts', 'run-appearance-tests.cjs'), 'utf8')
    : ''
  const missing = recursivelyOwnedTestFiles.filter(
    (file) => !testCommands.includes(file) && !appearanceRunner.includes(file)
  )
  assert.deepEqual(missing, [], `Unowned test files: ${missing.join(', ')}`)
})

test('CI and the final integrated gate retain all newly owned regression suites', () => {
  assert.ok(workflow, 'the required CI workflow must exist')
  for (const script of [
    'test:renderer-data-tooling',
    'test:sleep-timer',
    'test:cross-cutting-regressions',
    'test:radio-remote',
    'test:network-sources',
    'test:themes'
  ]) {
    assert.ok(PRODUCT_SCRIPTS.includes(script), `${script} must remain a product outcome`)
    assert.match(
      finalIntegratedGate,
      new RegExp(`corepack pnpm@11\\.7\\.0 run ${escapeRegExp(script)}`)
    )
  }
})

test('Windows release documentation fail-closes on every newly owned regression suite', () => {
  const commandBlock = windowsRequiredCommands.match(/```powershell\r?\n([\s\S]*?)\r?\n```/)?.[1]
  assert.equal(typeof commandBlock, 'string', 'Required Commands must contain a PowerShell block')
  const explanation = windowsRequiredCommands.replace(/```powershell[\s\S]*?```/, '')

  for (const script of [
    'test:renderer-data-tooling',
    'test:sleep-timer',
    'test:cross-cutting-regressions',
    'test:radio-remote',
    'test:network-sources',
    'test:themes'
  ]) {
    assert.match(commandBlock, new RegExp(`^pnpm run ${escapeRegExp(script)}$`, 'm'))
    assert.match(explanation, new RegExp('`' + escapeRegExp(script) + '`'))
  }
})

function collectTestFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...collectTestFiles(path))
    else if (/\.test\.(?:ts|cjs|mjs)$/.test(entry.name)) {
      files.push(relative(root, path).replaceAll('\\', '/'))
    }
  }
  return files
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function markdownSection(markdown, heading) {
  const match = markdown.match(
    new RegExp(`^## ${escapeRegExp(heading)}\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm')
  )
  assert.ok(match, `Missing markdown section: ${heading}`)
  return match[1]
}
