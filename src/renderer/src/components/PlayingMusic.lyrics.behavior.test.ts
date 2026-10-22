import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const electronEnvironment = { ...process.env }
delete electronEnvironment.ELECTRON_RUN_AS_NODE

test('playbar lyrics manager panel manages provider tracks and projects into PlayingMusic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playing-music-lyrics-'))
  try {
    const entryPath = join(directory, 'playing-music-lyrics-entry.ts')
    const bundleDirectory = join(directory, 'bundle')
    const htmlPath = join(directory, 'playing-music-lyrics.html')
    const runnerPath = join(directory, 'playing-music-lyrics-runner.cjs')
    await writeFile(entryPath, runtimeEntrySource(), 'utf8')

    await build({
      configFile: false,
      logLevel: 'error',
      root: workspaceRoot,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspaceRoot, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
        }
      },
      build: {
        outDir: bundleDirectory,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: entryPath,
          name: 'PlayingMusicLyricsRuntime',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const bundleName = (await readdir(bundleDirectory)).find((name) => name.endsWith('.iife.js'))
    assert.ok(
      bundleName,
      'Vite should bundle the real PlayingMusic + LyricsManagerPanel components'
    )
    const styleName = (await readdir(bundleDirectory)).find((name) => name.endsWith('.css'))
    assert.ok(styleName, 'Vite lib build should emit the component stylesheet')
    const styleCss = await readFile(join(bundleDirectory, styleName), 'utf8')
    assert.match(
      styleCss,
      /mask-image:\s*linear-gradient\(/,
      'the lyric stage should fade its top and bottom edges with a gradient mask'
    )
    // The per-word sweep gradient is generated from measured glyph widths, so it
    // is set inline by the component. What the stylesheet must own is the
    // contrast the sweep reads and the escape hatches that switch it off.
    assert.match(
      styleCss,
      /--lyric-bright-mask-alpha/,
      'karaoke contrast variables should be owned by the stylesheet'
    )
    assert.match(
      styleCss,
      /lyrics-column--karaoke-disabled[\s\S]{0,200}mask-image:\s*none/,
      'disabling karaoke should clear the word mask from CSS'
    )
    assert.match(
      styleCss,
      /--lyric-line-top/,
      'absolute line positioning variable should be in the stylesheet'
    )
    assert.match(styleCss, /--lyric-line-scale/, 'line scale variable should be in the stylesheet')
    assert.doesNotMatch(styleCss, /te-lyric-focus/, 'replaced focus animation should be removed')
    assert.doesNotMatch(
      styleCss,
      /--lyric-word-progress|--lyric-depth-scale/,
      'the retired scroll-driven progress and depth variables should be gone'
    )
    await writeFile(htmlPath, runtimeHtml(bundleName, styleName), 'utf8')
    await writeFile(runnerPath, electronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      env: electronEnvironment,
      timeout: 45_000,
      windowsHide: true
    })
    assert.match(stderr, /PLAYING_MUSIC_LYRICS_RUNTIME_OK/)
    assert.doesNotMatch(stderr, /PLAYING_MUSIC_LYRICS_RUNTIME_FAILED/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

test('PlayingLyricWords advances YRC fill with the shared playback clock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-playing-lyric-words-'))
  try {
    const entryPath = join(directory, 'playing-lyric-words-entry.ts')
    const bundleDirectory = join(directory, 'bundle')
    const htmlPath = join(directory, 'playing-lyric-words.html')
    const runnerPath = join(directory, 'playing-lyric-words-runner.cjs')
    await writeFile(entryPath, lyricWordsRuntimeEntrySource(), 'utf8')

    await build({
      configFile: false,
      logLevel: 'error',
      root: workspaceRoot,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspaceRoot, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js'),
          pinia: join(resolve(require.resolve('pinia/package.json'), '..'), 'dist/pinia.mjs')
        }
      },
      build: {
        outDir: bundleDirectory,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: entryPath,
          name: 'PlayingLyricWordsRuntime',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const bundleName = (await readdir(bundleDirectory)).find((name) => name.endsWith('.iife.js'))
    assert.ok(bundleName, 'Vite should bundle the real PlayingLyricWords component')
    await writeFile(htmlPath, runtimeHtml(bundleName), 'utf8')
    await writeFile(runnerPath, lyricWordsElectronRunnerSource(), 'utf8')

    const electronPath = require('electron') as string
    const { stderr } = await execFileAsync(electronPath, ['--no-sandbox', runnerPath, htmlPath], {
      env: electronEnvironment,
      timeout: 45_000,
      windowsHide: true
    })
    assert.match(stderr, /PLAYING_LYRIC_WORDS_RUNTIME_OK/)
    assert.doesNotMatch(stderr, /PLAYING_LYRIC_WORDS_RUNTIME_FAILED/)
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
})

function lyricWordsRuntimeEntrySource(): string {
  const componentPath = join(
    workspaceRoot,
    'src/renderer/src/components/PlayingLyricWords.vue'
  ).replaceAll('\\', '/')
  return `import { createApp, h, nextTick, ref } from 'vue'
import PlayingLyricWords from ${JSON.stringify(componentPath)}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

/*
 * The sweep gradient is built from measured glyph widths, and .lyric-word gets
 * its box from PlayingMusic.vue's :deep() block, which a bare mount of this
 * component does not carry. Supply just enough of it for measurement to be real.
 */
const measurementStyle = document.createElement('style')
measurementStyle.textContent =
  '.lyric-word, .lyric-char { display: inline-block; font-size: 24px; } .lyric-space { white-space: pre; }'
document.head.appendChild(measurementStyle)

window.runPlayingLyricWordsRuntime = async () => {
  const snapshot = ref({ epoch: 1, revision: 0, position: 1 })
  const isPlaying = ref(false)
  let anchorAt = performance.now()
  const setPosition = (position) => {
    snapshot.value = { ...snapshot.value, position, revision: snapshot.value.revision + 1 }
    anchorAt = performance.now()
  }
  const clock = {
    snapshot,
    isPlaying,
    positionAt: () => snapshot.value.position + (isPlaying.value ? (performance.now() - anchorAt) * 0.001 : 0)
  }
  createApp({
    render: () => h(PlayingLyricWords, {
      active: true,
      karaokeEnabled: true,
      offsetSeconds: 0,
      clock,
      words: [
        { time: 1, endTime: 2.2, text: 'Null. ' },
        { time: 2.2, endTime: 3, text: 'No light' }
      ]
    })
  }).mount('#app')
  await nextTick()
  // The build measures glyphs, so it waits a frame. Poll rather than assume.
  const settle = async (predicate, message) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await nextTick()
      await new Promise((resolve) => requestAnimationFrame(resolve))
      if (predicate()) return
    }
    throw new Error(message)
  }

  const lyricWords = document.querySelectorAll('.lyric-word')
  const firstWord = lyricWords[0]
  const secondWord = lyricWords[1]
  expect(firstWord && secondWord, 'karaoke words were not rendered; got ' + lyricWords.length)
  expect(!document.querySelector('.lyric-word--active'), 'karaoke sweep retained a singled-out word')

  await settle(
    () => firstWord.getAnimations().length > 0,
    'karaoke sweep never handed keyframes to the compositor'
  )

  // The sweep is a mask whose position is animated; nothing is recomputed in JS.
  expect(
    /linear-gradient/.test(firstWord.style.getPropertyValue('mask-image')),
    'karaoke word did not receive its inline sweep gradient'
  )
  expect(
    firstWord.style.getPropertyValue('--lyric-word-progress') === '',
    'the retired per-frame progress variable is still being written'
  )

  const maskAnimation = (element) =>
    element.getAnimations().find((animation) => {
      const frames = animation.effect?.getKeyframes?.() ?? []
      return frames.some((frame) => frame.maskPosition !== undefined)
    })

  const firstMask = maskAnimation(firstWord)
  expect(firstMask, 'the karaoke word has no mask animation')

  // One time origin for the whole line (its start), so a single currentTime
  // keeps fill, lift and glow coherent. Line starts at 1s; position is 1s.
  expect(
    Math.abs(Number(firstMask.currentTime)) < 60,
    'karaoke timeline did not start at the line origin; currentTime=' + firstMask.currentTime
  )
  expect(
    firstMask.playState === 'paused',
    'karaoke sweep ran while playback was paused; state=' + firstMask.playState
  )

  // A seek is one currentTime assignment, not a frame-by-frame chase.
  setPosition(1.5)
  await settle(
    () => Math.abs(Number(firstMask.currentTime) - 500) < 60,
    'karaoke timeline did not seek with the shared playback clock; currentTime=' +
      firstMask.currentTime
  )

  isPlaying.value = true
  await settle(
    () => firstMask.playState === 'running',
    'karaoke sweep did not resume with playback; state=' + firstMask.playState
  )
  const beforeAdvance = Number(firstMask.currentTime)
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(
    Number(firstMask.currentTime) > beforeAdvance,
    'karaoke sweep did not advance on the compositor while playing'
  )

  const beforeLaggingSample = Number(firstMask.currentTime)
  setPosition(1.2)
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(
    Number(firstMask.currentTime) >= beforeLaggingSample - 60,
    'a lagging playback sample rewound the karaoke timeline'
  )

  isPlaying.value = false
  await settle(
    () => firstMask.playState === 'paused',
    'karaoke sweep kept running after playback stopped'
  )

  // Words share the line timeline, so the second word's sweep is the same
  // animation advanced further rather than a separately triggered one.
  const secondMask = maskAnimation(secondWord)
  expect(secondMask, 'the following karaoke word has no mask animation')
  setPosition(2)
  await settle(
    () => Math.abs(Number(secondMask.currentTime) - 1000) < 60,
    'the following word did not share the line timeline; currentTime=' + secondMask.currentTime
  )

  // A held word also emphasises per character.
  const chars = firstWord.querySelectorAll('.lyric-char')
  expect(chars.length > 1, 'a held word was not split per character for emphasis')
  expect(
    chars[0].getAnimations().length >= 2,
    'emphasised characters did not receive both a glow and a float animation'
  )

  const firstWordFloat = firstWord.getAnimations().find((animation) => {
    const frames = animation.effect?.getKeyframes?.() ?? []
    return frames.some((frame) => String(frame.transform ?? '').includes('translateY'))
  })
  expect(firstWordFloat, 'the word did not receive its lift animation')

  setPosition(4)
  await settle(
    () => Math.abs(Number(firstMask.currentTime) - 2000) < 60,
    'karaoke timeline exceeded the current line duration; currentTime=' + firstMask.currentTime
  )

  isPlaying.value = true
  await settle(
    () => firstMask.playState === 'finished' && firstWordFloat.playState === 'finished',
    'the completed karaoke sweep did not settle at the line boundary'
  )
  const completedMaskTime = Number(firstMask.currentTime)
  const completedFloatTime = Number(firstWordFloat.currentTime)
  setPosition(4.2)
  await new Promise((resolve) => setTimeout(resolve, 120))
  expect(
    Math.abs(Number(firstMask.currentTime) - completedMaskTime) < 60,
    'the completed karaoke sweep restarted after a later clock tick'
  )
  expect(
    Math.abs(Number(firstWordFloat.currentTime) - completedFloatTime) < 60,
    'the completed word lift restarted after a later clock tick; before=' +
      completedFloatTime +
      '; after=' +
      firstWordFloat.currentTime +
      '; state=' +
      firstWordFloat.playState
  )
  expect(firstMask.playState === 'finished', 'the completed karaoke sweep was played again')
  expect(firstWordFloat.playState === 'finished', 'the completed word lift was played again')

  const spacedRoot = document.createElement('div')
  document.body.appendChild(spacedRoot)
  createApp({
    render: () => h(PlayingLyricWords, {
      active: true,
      karaokeEnabled: true,
      offsetSeconds: 0,
      clock,
      words: [{ time: 4.2, endTime: 5.6, text: '啊 我的救世主' }]
    })
  }).mount(spacedRoot)
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const spacedWords = [...spacedRoot.querySelectorAll('.lyric-word')]
  expect(spacedWords.length === 2, 'the internally spaced TTML translation was not split')
  expect(
    spacedWords.every((word) => maskAnimation(word)),
    'some internally spaced TTML translation fragments did not receive karaoke highlighting'
  )

  const wrappedRoot = document.createElement('div')
  wrappedRoot.style.width = '250px'
  wrappedRoot.style.fontFamily = 'Arial, sans-serif'
  wrappedRoot.style.fontSize = '32px'
  document.body.appendChild(wrappedRoot)
  createApp({
    render: () => h(PlayingLyricWords, {
      active: true,
      karaokeEnabled: false,
      motionMode: 'off',
      offsetSeconds: 0,
      clock,
      words: [
        { time: 4.2, endTime: 4.5, text: 'Confusing,' },
        { time: 4.5, endTime: 4.8, text: ' why,' },
        { time: 4.8, endTime: 5.1, text: ' why,' },
        { time: 5.1, endTime: 5.4, text: ' why?' }
      ]
    })
  }).mount(wrappedRoot)
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const wrappedWords = [...wrappedRoot.querySelectorAll('.lyric-word')]
  const firstRect = wrappedWords[0].getBoundingClientRect()
  const firstWrappedWord = wrappedWords.find(
    (word) => word.getBoundingClientRect().top > firstRect.top + 2
  )
  expect(firstWrappedWord, 'the narrow lyric fixture did not wrap')
  const wrappedRect = firstWrappedWord.getBoundingClientRect()
  expect(
    Math.abs(wrappedRect.left - firstRect.left) < 2,
    'a preserved boundary space indented the wrapped lyric; first=' +
      firstRect.left +
      '; wrapped=' +
      wrappedRect.left
  )

  const disabledRoot = document.createElement('div')
  document.body.appendChild(disabledRoot)
  createApp({
    render: () => h(PlayingLyricWords, {
      active: true,
      karaokeEnabled: false,
      offsetSeconds: 0,
      clock,
      words: [
        { time: 1, endTime: 2.2, text: 'Null. ' },
        { time: 2.2, endTime: 3, text: 'No light' }
      ]
    })
  }).mount(disabledRoot)
  await nextTick()
  const disabledWord = disabledRoot.querySelector('.lyric-word')
  expect(disabledWord, 'disabled karaoke words were not rendered')
  await new Promise((resolve) => requestAnimationFrame(resolve))
  expect(
    disabledWord.style.getPropertyValue('mask-image') === '',
    'disabled karaoke still installed a sweep mask'
  )
  expect(
    !maskAnimation(disabledWord),
    'disabled karaoke still animated a mask position'
  )

  const reducedRoot = document.createElement('div')
  document.body.appendChild(reducedRoot)
  createApp({
    render: () => h(PlayingLyricWords, {
      active: true,
      karaokeEnabled: true,
      motionMode: 'reduced',
      offsetSeconds: 0,
      clock,
      words: [
        { time: 1, endTime: 2.2, text: 'Reduced ' },
        { time: 2.2, endTime: 3, text: 'motion' }
      ]
    })
  }).mount(reducedRoot)
  await nextTick()
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const reducedWords = [...reducedRoot.querySelectorAll('.lyric-word')]
  expect(reducedWords.length > 0, 'reduced motion lyrics were not rendered')
  expect(
    reducedWords.every((word) => word.getAnimations().length === 0),
    'reduced motion still created WAAPI animations'
  )
  expect(
    reducedWords.every((word) => word.style.getPropertyValue('mask-image') === ''),
    'reduced motion still installed a karaoke mask'
  )
  console.log('PLAYING_LYRIC_WORDS_RUNTIME_OK')
}
`
}

function lyricWordsElectronRunnerSource(): string {
  return `const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const target = process.argv.at(-1)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, nodeIntegration: false } })
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => console.error('RENDERER', sourceId + ':' + line, message))
  try {
    await window.loadFile(path.resolve(target))
    await window.webContents.executeJavaScript('window.runPlayingLyricWordsRuntime()')
    console.error('PLAYING_LYRIC_WORDS_RUNTIME_OK')
    app.exit(0)
  } catch (error) {
    console.error('PLAYING_LYRIC_WORDS_RUNTIME_FAILED', error)
    app.exit(1)
  }
})
`
}

function runtimeEntrySource(): string {
  const componentPath = join(
    workspaceRoot,
    'src/renderer/src/components/PlayingMusic.vue'
  ).replaceAll('\\', '/')
  const panelPath = join(
    workspaceRoot,
    'src/renderer/src/components/player-bar/LyricsManagerPanel.vue'
  ).replaceAll('\\', '/')
  const playerStorePath = join(
    workspaceRoot,
    'src/renderer/src/stores/usePlayerStore.ts'
  ).replaceAll('\\', '/')
  const settingsStorePath = join(
    workspaceRoot,
    'src/renderer/src/stores/useSettingsStore.ts'
  ).replaceAll('\\', '/')
  const mainStylePath = join(workspaceRoot, 'src/renderer/src/assets/main.css').replaceAll(
    '\\',
    '/'
  )
  return `import ${JSON.stringify(mainStylePath)}
import { createApp, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import PlayingMusic from ${JSON.stringify(componentPath)}
import LyricsManagerPanel from ${JSON.stringify(panelPath)}
import { usePlayerStore } from ${JSON.stringify(playerStorePath)}
import { useSettingsStore } from ${JSON.stringify(settingsStorePath)}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

const tick = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await nextTick()
}

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await tick()
    if (predicate()) return
  }
  const importControl = [...document.querySelectorAll('.lyric-manager--panel button')].find((item) => item.textContent.includes('Import'))
  const originalEditor = document.querySelector('.lyric-manager--panel textarea')
  throw new Error(message + '; importCalls=' + window.__lyricsFixture?.importCalls + '; importDisabled=' + importControl?.disabled + '; original=' + originalEditor?.value)
}

const input = (element, value) => {
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

window.runPlayingMusicLyricsRuntime = async () => {
  const pinia = createPinia()
  setActivePinia(pinia)
  const player = usePlayerStore()
  const settingsStore = useSettingsStore()
  expect(
    'compatibility store created a second playback factory'
  )
  expect(
    'compatibility store retained a second playback clock'
  )
  expect(
    'compatibility store retained a second current track'
  )
  const track = {
    id: 'fixture-provider:no-lyrics', title: 'No lyrics yet', artist: 'Twilight', album: 'Echo',
    filePath: '', fileName: '', duration: 180, size: 0, cover: null,
    lyrics: '', translatedLyrics: null, romanizedLyrics: null,
    lyricsSource: null, translatedLyricsSource: null, romanizedLyricsSource: null,
    source: 'fixture-provider'
  }
  player.currentTrack.value = structuredClone(track)
  player.queue.value = [structuredClone(track)]

  createApp({
    render: () => h('div', [
      h(PlayingMusic),
      h(LyricsManagerPanel)
    ])
  }).use(pinia).mount('#app')
  await tick()
  const beforeCurrent = JSON.stringify(player.currentTrack.value)
  const beforeQueue = JSON.stringify(player.queue.value)

  expect(document.querySelector('.layout--single'), 'provider track without lyrics should use the single-column layout')
  expect(!document.querySelector('.lyric-manage-button'), 'now-playing must not surface a Lyrics entry button')
  const panel = document.querySelector('.lyric-manager--panel')
  expect(panel, 'playbar lyrics manager panel is mounted')

  const buttons = () => [...panel.querySelectorAll('button')]
  const button = (label) => {
    const found = buttons().find((item) => item.textContent.trim() === label)
    if (!found) throw new Error('missing button ' + label + '; available: ' + buttons().map((item) => item.textContent.trim()).join(' | '))
    return found
  }
  const editorDisclosure = panel.querySelector('.lyric-editor-disclosure')
  expect(!panel.querySelector('.lyric-style-controls'), 'HiFi lyrics manager retained duplicate style controls')
  expect(editorDisclosure, 'custom lyrics editor is mounted in a disclosure')
  expect(!editorDisclosure.open, 'custom lyrics editor should start collapsed')
  editorDisclosure.open = true
  const textareas = panel.querySelectorAll('textarea')
  const source = panel.querySelector('.lyric-source-grid select')
  const importButton = button('导入 LRC')
  const saveLrcButton = button('导出 LRC')

  window.__lyricsFixture.rejectNextSave = true
  button('原文').click()
  await waitFor(
    () => document.querySelector('.lyric-manager-error')?.textContent.includes('fixture CAS conflict'),
    'CAS conflict was not surfaced in the actual manager UI'
  )
  expect(button('原文').getAttribute('aria-pressed') === 'true', 'CAS authority was not restored in the UI')

  button('音译').click()
  await waitFor(
    () => button('音译').getAttribute('aria-pressed') === 'true',
    'romanization toggle was not persisted and projected'
  )
  expect(!document.querySelector('.lyric-manager-error'), 'successful retry left a stale CAS error')

  const originalBeforeCancel = textareas[0].value
  window.__lyricsFixture.importResult = null
  importButton.click()
  await waitFor(
    () =>
      window.__lyricsFixture.importCalls === 1 &&
      !importButton.disabled &&
      buttons().some((item) => item.textContent.trim() === '导入 LRC'),
    'import cancel did not finish through the UI bridge'
  )
  expect(textareas[0].value === originalBeforeCancel, 'import cancel changed the editor')

  window.__lyricsFixture.importResult = '[00:03.00]Imported original'
  button('导入 LRC').click()
  await waitFor(
    () =>
      window.__lyricsFixture.importCalls === 2 &&
      textareas[0].value === '[00:03.00]Imported original',
    'import result did not reach the editor'
  )
  expect(source.value === 'manual', 'import did not choose Manual source')

  input(textareas[1], '[00:03.00]Imported translation')
  input(textareas[2], '[00:03.00]Imported romanization')

  window.__lyricsFixture.saveResult = null
  saveLrcButton.click()
  await waitFor(
    () =>
      window.__lyricsFixture.saveCalls === 1 &&
      buttons().some((item) => item.textContent.trim() === '导出 LRC'),
    'save cancel did not finish through the UI bridge'
  )
  expect(!document.querySelector('.lyric-manager-notice'), 'save cancel reported a successful write')

  window.__lyricsFixture.saveResult = 'D:/authorized/edited.lrc'
  saveLrcButton.click()
  await waitFor(
    () =>
      document.querySelector('.lyric-manager-notice')?.textContent.includes('edited.lrc') &&
      buttons().some((item) => item.textContent.trim() === '导出 LRC'),
    'successful LRC save was not reported'
  )
  expect(window.__lyricsFixture.lastSavedContents === '[00:03.00]Imported original', 'Save LRC did not use edited original text')

  window.__lyricsFixture.saveResult = null
  saveLrcButton.click()
  await waitFor(
    () =>
      window.__lyricsFixture.saveCalls === 3 &&
      buttons().some((item) => item.textContent.trim() === '导出 LRC'),
    'second save cancel did not complete'
  )
  expect(
    !document.querySelector('.lyric-manager-notice')?.textContent.includes('edited.lrc'),
    'save cancel retained a stale success notice'
  )

  button('保存歌词').click()
  await waitFor(
    () => window.__lyricsFixture.document.tracks[track.id]?.original === '[00:03.00]Imported original',
    'Save lyrics did not persist the draft'
  )
  expect(document.querySelector('.lyric-manager--panel'), 'manager panel remains available after save')
  const stored = window.__lyricsFixture.document.tracks[track.id]
  expect(stored.source === 'manual', 'manual source was not persisted')
  expect(stored.original === '[00:03.00]Imported original', 'edited original was not persisted')
  expect(stored.translation === '[00:03.00]Imported translation', 'edited translation was not persisted')
  expect(stored.romanization === '[00:03.00]Imported romanization', 'edited romanization was not persisted')
  await waitFor(
    () => document.querySelector('.lyric-romanization')?.textContent.includes('Imported romanization'),
    'persisted visibility and manual lyrics were not projected by the actual component'
  )
  expect(document.querySelector('.lyric-text')?.textContent.includes('Imported original'), 'manual original was not rendered')
  expect(document.querySelector('.lyric-translation')?.textContent.includes('Imported translation'), 'manual translation was not rendered')
  expect(JSON.stringify(player.currentTrack.value) === beforeCurrent, 'manual UI projection mutated currentTrack')
  expect(
    JSON.stringify(player.queue.value) === beforeQueue,
    'manual UI projection mutated queue; before=' + beforeQueue + '; after=' + JSON.stringify(player.queue.value)
  )

  const sourceSelectors = panel.querySelectorAll('.lyric-editor-content select')
  sourceSelectors[2].value = 'automatic'
  sourceSelectors[2].dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
  expect(!button('保存歌词').disabled, 'layer source change did not mark the lyric draft dirty')
  button('保存歌词').click()
  await waitFor(
    () => window.__lyricsFixture.document.tracks[track.id]?.translationSelection === 'automatic',
    'translation source did not persist independently from manual original and romanization'
  )
  const mixedStored = window.__lyricsFixture.document.tracks[track.id]
  expect(mixedStored.source === 'auto', 'mixed source selections did not keep automatic resolver active')
  expect(mixedStored.originalSelection === 'manual', 'manual original selection was lost')
  expect(mixedStored.translationSelection === 'automatic', 'automatic translation selection was lost')
  expect(mixedStored.romanizationSelection === 'manual', 'manual romanization selection was lost')

  const amllTrack = {
    ...track,
    id: 'fixture-amll:custom-overrides',
    title: 'AMLL custom overrides',
    lyrics:
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:01.00" end="00:03.00"><span begin="00:01.00" end="00:02.00">AMLL original</span><span ttm:role="x-translation">AMLL translation</span><span ttm:role="x-bg" begin="00:02.00" end="00:03.00"><span begin="00:02.00" end="00:03.00">I&amp;apos;ll see you again</span><span ttm:role="x-translation">你我必将重逢</span></span></p></div></body></tt>',
    lyricsSource: 'amll'
  }
  player.currentTrack.value = structuredClone(amllTrack)
  player.queue.value = [structuredClone(amllTrack)]
  await tick()
  expect(
    !buttons().some((item) => item.textContent.trim() === '右对齐'),
    'AMLL TTML still exposed the unsupported right-alignment action'
  )
  const defaultVoiceText = document.querySelector('.lyric-text')
  const defaultVoiceTranslation = document.querySelector('.lyric-voice-translation')
  expect(defaultVoiceText && defaultVoiceTranslation, 'AMLL original and auxiliary text were not rendered')
  expect(
    defaultVoiceTranslation.parentElement?.classList.contains('lyric-voice'),
    'AMLL auxiliary text was not grouped directly below its original voice'
  )
  expect(
    Number.parseFloat(getComputedStyle(defaultVoiceTranslation).fontSize) <
      Number.parseFloat(getComputedStyle(defaultVoiceText).fontSize),
    'AMLL auxiliary text was not smaller than its original lyric'
  )
  player.currentTime.value = 1.5
  player.seek(1.5)
  await tick()
  const supportingVoice = document.querySelector('.lyric-voice--supporting')
  expect(supportingVoice, 'AMLL background voice was not rendered')
  expect(
    !supportingVoice.classList.contains('lyric-voice--supporting-visible'),
    'a later background voice appeared before its own start time'
  )
  player.currentTime.value = 2.2
  player.seek(2.2)
  await waitFor(
    () => document.querySelector('.lyric-voice--supporting-visible') != null,
    'background voice did not fade in at its own start time'
  )
  player.currentTime.value = 3.1
  player.seek(3.1)
  await waitFor(
    () => !document.querySelector('.lyric-voice--supporting-visible'),
    'background voice did not hide after its own end time'
  )

  const originalAppearance = JSON.parse(JSON.stringify(settingsStore.settings.value.lyricsAppearance))
  const centeredLayerAppearance = JSON.parse(JSON.stringify(originalAppearance))
  centeredLayerAppearance.align = 'left'
  centeredLayerAppearance.styles.normal.align = 'center'
  await settingsStore.updateSettings({ lyricsAppearance: centeredLayerAppearance })
  await tick()
  expect(
    document.querySelector('.lyric-row-content')?.classList.contains('lyric-row-content--align-center'),
    'the stale legacy alignment overrode the normal lyric layer alignment'
  )
  expect(
    !document.querySelector('.lyrics-scroll')?.className.includes('lyric-align-'),
    'the retired global lyric alignment class remained attached to the stage'
  )

  const leftLayerAppearance = JSON.parse(JSON.stringify(centeredLayerAppearance))
  leftLayerAppearance.align = 'center'
  leftLayerAppearance.styles.normal.align = 'left'
  await settingsStore.updateSettings({ lyricsAppearance: leftLayerAppearance })
  await tick()
  expect(
    document.querySelector('.lyric-row-content')?.classList.contains('lyric-row-content--align-left'),
    'the normal lyric layer could not switch from center to left alignment'
  )
  expect(
    getComputedStyle(document.querySelector('.lyric-row-content')).alignItems === 'stretch',
    'the parent player stylesheet still shrank lyric content around centered text'
  )
  expect(
    getComputedStyle(document.querySelector('.lyric-lane--center')).alignItems === 'flex-start',
    'left alignment did not move the centered compatibility lane to a stable left edge'
  )
  player.currentTime.value = 1.5
  player.seek(1.5)
  await waitFor(
    () => document.querySelector('.lyric-row.active .lyric-row-content') != null,
    'the AMLL fixture did not expose an active row for alignment inspection'
  )
  expect(
    document
      .querySelector('.lyric-row.active .lyric-row-content')
      ?.classList.contains('lyric-row-content--align-left'),
    'the highlighted TTML row drifted away from the normal lyric alignment'
  )
  const activeAlignedContent = document.querySelector(
    '.lyric-row.active .lyric-row-content'
  ) as HTMLElement | null
  expect(
    [...document.querySelectorAll('.lyric-row-content, .lyric-char')].every(
      (node) => getComputedStyle(node).willChange === 'auto'
    ),
    'lyric rows and characters must not permanently pin scaled text textures'
  )
  expect(
    activeAlignedContent && getComputedStyle(activeAlignedContent).transformOrigin.startsWith('0px'),
    'the highlighted left-aligned row still scaled around its centre'
  )
  player.currentTime.value = 3.1
  player.seek(3.1)
  await tick()

  const styledAppearance = JSON.parse(JSON.stringify(originalAppearance))
  Object.assign(styledAppearance.styles.translation, {
    fontSize: 34,
    fontWeight: 900,
    fontStyle: 'italic',
    lineHeight: 2.1,
    letterSpacing: 0.2,
    align: 'right'
  })
  Object.assign(styledAppearance.styles.harmony, {
    fontSize: 22,
    fontWeight: 700,
    fontStyle: 'italic'
  })
  await settingsStore.updateSettings({ lyricsAppearance: styledAppearance })
  await tick()
  const amllVoiceTranslation = document.querySelector('.lyric-voice-translation')
  expect(amllVoiceTranslation, 'AMLL voice translation was not rendered')
  const amllVoiceTranslationStyle = getComputedStyle(amllVoiceTranslation)
  const inactiveVoiceTranslationColor = amllVoiceTranslationStyle.color
  expect(
    amllVoiceTranslationStyle.fontSize === '34px',
    'AMLL translation ignored its custom font size; actual=' + amllVoiceTranslationStyle.fontSize
  )
  expect(
    amllVoiceTranslationStyle.fontWeight === '900',
    'AMLL translation ignored its custom font weight; actual=' + amllVoiceTranslationStyle.fontWeight
  )
  expect(
    amllVoiceTranslationStyle.fontStyle === 'italic',
    'AMLL translation ignored its custom font style; actual=' + amllVoiceTranslationStyle.fontStyle
  )
  const styledSupportingVoice = document.querySelector('.lyric-voice--supporting')
  expect(styledSupportingVoice, 'AMLL supporting voice disappeared before style inspection')
  expect(
    getComputedStyle(styledSupportingVoice).fontSize === '22px',
    'supporting voice ignored its custom font size; actual=' + getComputedStyle(styledSupportingVoice).fontSize
  )
  const styledSupportingTranslation = styledSupportingVoice.querySelector('.lyric-voice-translation')
  expect(styledSupportingTranslation, 'supporting voice translation was not rendered')
  expect(
    getComputedStyle(styledSupportingTranslation).fontSize === '22px',
    'supporting translation did not follow the harmony font size; actual=' +
      getComputedStyle(styledSupportingTranslation).fontSize
  )
  expect(
    getComputedStyle(styledSupportingTranslation).fontWeight === '700',
    'supporting translation did not follow the harmony font weight; actual=' +
      getComputedStyle(styledSupportingTranslation).fontWeight
  )
  expect(
    amllVoiceTranslationStyle.textAlign === 'center',
    'AMLL translation did not constrain right alignment to center; actual=' +
      amllVoiceTranslationStyle.textAlign
  )
  expect(
    amllVoiceTranslation.style
      .getPropertyValue('--lyric-style-active-color')
      .includes('--te-playback-lyric-translation-active'),
    'AMLL translation did not receive the active translation color token'
  )
  const amllVoiceTranslationRow = amllVoiceTranslation.closest('.lyric-row')
  expect(amllVoiceTranslationRow, 'AMLL voice translation was not attached to a lyric row')
  amllVoiceTranslationRow.classList.add('is-singing')
  const activeVoiceTranslationColor = getComputedStyle(amllVoiceTranslation).color
  expect(
    activeVoiceTranslationColor !== inactiveVoiceTranslationColor,
    'active AMLL translation remained dim; inactive=' +
      inactiveVoiceTranslationColor +
      '; active=' +
      activeVoiceTranslationColor
  )
  amllVoiceTranslationRow.classList.remove('is-singing')
  const leftAlignedAppearance = JSON.parse(JSON.stringify(styledAppearance))
  leftAlignedAppearance.styles.translation.align = 'left'
  await settingsStore.updateSettings({ lyricsAppearance: leftAlignedAppearance })
  await tick()
  expect(
    getComputedStyle(document.querySelector('.lyric-voice-translation')).textAlign === 'left',
    'AMLL translation did not apply the allowed left alignment'
  )
  await settingsStore.updateSettings({ lyricsAppearance: originalAppearance })
  await tick()

  const amllTextareas = panel.querySelectorAll('textarea')
  const amllSourceSelectors = panel.querySelectorAll('.lyric-editor-content select')
  expect(amllTextareas[0].disabled, 'raw AMLL TTML should remain read-only as original text')
  expect(
    amllSourceSelectors[1].value === 'automatic',
    'AMLL original should retain the automatic source selection; actual=' + amllSourceSelectors[1].value
  )
  input(amllTextareas[1], '[00:01.00]AMLL manual translation')
  await tick()
  expect(
    !button('保存歌词').disabled,
    'a manual translation should remain saveable while the original is raw AMLL TTML'
  )
  button('保存歌词').click()
  await waitFor(
    () =>
      window.__lyricsFixture.document.tracks[amllTrack.id]?.translation ===
      '[00:01.00]AMLL manual translation',
    'manual translation was not persisted alongside AMLL TTML'
  )
  const amllStoredTranslation = window.__lyricsFixture.document.tracks[amllTrack.id]
  expect(amllStoredTranslation.originalSelection === 'automatic', 'AMLL original was no longer automatic')
  expect(amllStoredTranslation.translationSelection === 'manual', 'AMLL translation was not manual')
  await waitFor(
    () => document.querySelector('.lyric-translation')?.textContent.includes('AMLL manual translation'),
    'manual translation was not projected over the embedded AMLL translation'
  )
  expect(
    !document.querySelector('.lyric-voice-translation'),
    'embedded AMLL translation remained visible beside the manual translation'
  )

  button('新建手写 LRC').click()
  await tick()
  expect(!amllTextareas[0].disabled, 'new handwritten LRC draft did not unlock the original editor')
  input(amllTextareas[0], '[00:01.00]AMLL manual original')
  await tick()
  button('保存歌词').click()
  await waitFor(
    () =>
      window.__lyricsFixture.document.tracks[amllTrack.id]?.original ===
      '[00:01.00]AMLL manual original',
    'manual original was not persisted after replacing AMLL TTML'
  )
  expect(
    document.querySelector('.lyric-text')?.textContent.includes('AMLL manual original'),
    'manual original was not projected over AMLL TTML'
  )

  const playbackTrack = {
    ...track,
    id: 'fixture-provider:playback-clock',
    title: 'Playback clock',
    lyrics: '[00:00.00]Start line\\n[00:01.00]Moving line\\n[00:03.00]Seek line',
    lyricsSource: 'embedded'
  }
  player.currentTrack.value = structuredClone(playbackTrack)
  player.queue.value = [structuredClone(playbackTrack)]
  player.queueIndex.value = 0
  player.currentTime.value = 0
  player.duration.value = 180
  player.isPlaying.value = true
  player.seek(0)
  await tick()
  player.isLoading.value = true
  window.__audioFixture.emitProperty('time-pos', 0.25)
  const stalledNextSamples = window.setInterval(
    () => window.__audioFixture.emitProperty('time-pos', 0.25),
    100
  )
  await new Promise((resolve) => setTimeout(resolve, 1400))
  window.clearInterval(stalledNextSamples)
  await tick()
  expect(player.currentTime.value > 1, 'stalled engine samples froze the component playback clock')
  expect(!document.querySelector('.time-chip')?.textContent.includes('0:00'), 'lyrics time chip did not advance')
  const activeAfterStall = document.querySelector('.lyric-row.active')?.textContent ?? ''
  expect(
    activeAfterStall.includes('Moving line'),
    'active lyric did not advance; currentTime=' + player.currentTime.value + '; active=' + activeAfterStall
  )

  const seekLine = [...document.querySelectorAll('.lyric-row')].find((item) => item.textContent.includes('Seek line'))
  expect(seekLine, 'timed seek lyric was not rendered')
  seekLine.click()
  await tick()
  expect(
    document.querySelector('.lyric-row.active')?.textContent.includes('Seek line'),
    'seek left the target lyric dimmed until the normal playback highlight delay elapsed'
  )
  player.seek(1)
  await tick()
  expect(
    document.querySelector('.lyric-row.active')?.textContent.includes('Moving line'),
    'a progress seek backward left the new target lyric dimmed'
  )
  player.seek(3)
  await tick()
  expect(
    document.querySelector('.lyric-row.active')?.textContent.includes('Seek line'),
    'a progress seek forward left the new target lyric dimmed'
  )
  window.__audioFixture.emitProperty('time-pos', 3)
  const stalledSeekSamples = window.setInterval(
    () => window.__audioFixture.emitProperty('time-pos', 3),
    100
  )
  await new Promise((resolve) => setTimeout(resolve, 900))
  window.clearInterval(stalledSeekSamples)
  await tick()
  expect(player.currentTime.value > 3.4, 'lyric seek froze after repeated confirmation samples')
  expect(document.querySelector('.lyric-row.active')?.textContent.includes('Seek line'), 'clicked lyric did not stay active while time advanced')
  player.isLoading.value = false

  const singleLineAppearance = JSON.parse(
    JSON.stringify(settingsStore.settings.value.lyricsAppearance)
  )
  singleLineAppearance.focusLineCount = 1
  await settingsStore.updateSettings({ lyricsAppearance: singleLineAppearance })
  await waitFor(
    () => window.__settingsFixture.settings.lyricsAppearance?.focusLineCount === 1,
    'single-line lyric focus did not persist before the handoff regression probe'
  )
  const rapidLyricsTrack = {
    ...playbackTrack,
    id: 'fixture-provider:rapid-lyrics',
    title: 'Rapid lyrics',
    lyrics: '[00:20.00]Start line\\n[00:20.10]Brief line\\n[00:20.42]Following line'
  }
  player.currentTrack.value = structuredClone(rapidLyricsTrack)
  player.queue.value = [structuredClone(rapidLyricsTrack)]
  player.currentTime.value = 20
  player.isPlaying.value = true
  player.seek(20)
  await tick()
  const observedActiveLines = new Set()
  let maxRenderedLyricRows = 0
  const activeLineProbe = window.setInterval(() => {
    observedActiveLines.add(document.querySelector('.lyric-row.active')?.textContent ?? '')
    maxRenderedLyricRows = Math.max(
      maxRenderedLyricRows,
      document.querySelectorAll('.lyric-row').length
    )
  }, 8)
  // Brief line spans 20.10-20.42 (320ms) while the store clock publishes every
  // 250ms, so a 900ms window guarantees at least one sample inside the line
  // regardless of tick phase.
  await new Promise((resolve) => setTimeout(resolve, 900))
  window.clearInterval(activeLineProbe)
  expect(
    [...observedActiveLines].some((line) => line.includes('Brief line')),
    'rapid plain LRC line never became active between playback time samples; currentTime=' +
      player.currentTime.value +
      '; isPlaying=' +
      player.isPlaying.value +
      '; observed=' +
      [...observedActiveLines].join(' | ')
  )
  expect(
    maxRenderedLyricRows >= 3,
    'full lyric timeline did not remain mounted during rapid handoff; maxRows=' +
      maxRenderedLyricRows
  )

  // Programmatic centering must remain automatic after a track switch.
  const automaticScrollTrack = {
    ...rapidLyricsTrack,
    id: 'fixture-provider:automatic-scroll-track',
    title: 'Automatic scroll track'
  }
  const alternateScrollTrack = {
    ...automaticScrollTrack,
    id: 'fixture-provider:alternate-scroll-track',
    title: 'Alternate scroll track'
  }
  player.currentTrack.value = structuredClone(automaticScrollTrack)
  player.queue.value = [structuredClone(automaticScrollTrack)]
  player.currentTime.value = 20
  player.seek(20)
  await tick()
  expect(
    document.querySelectorAll('.lyric-row').length === 3,
    'automatic lyric scrolling did not retain the full lyric timeline'
  )
  player.currentTrack.value = structuredClone(alternateScrollTrack)
  player.queue.value = [structuredClone(alternateScrollTrack)]
  player.seek(20)
  await tick()
  player.currentTrack.value = structuredClone(automaticScrollTrack)
  player.queue.value = [structuredClone(automaticScrollTrack)]
  player.seek(20)
  await tick()
  expect(
    document.querySelectorAll('.lyric-row').length === 3,
    'track switching did not preserve the full automatic lyric timeline'
  )

  const fullLyricsAppearance = JSON.parse(
    JSON.stringify(settingsStore.settings.value.lyricsAppearance)
  )
  fullLyricsAppearance.focusLineCount = 'all'
  await settingsStore.updateSettings({ lyricsAppearance: fullLyricsAppearance })
  await waitFor(
    () => window.__settingsFixture.settings.lyricsAppearance?.focusLineCount === 'all',
    'full lyric focus did not persist before the scroll regression probe'
  )

  document.documentElement.dataset.teMotion = 'full'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible'
  })
  const yrcTrackA = {
    ...playbackTrack,
    id: 'fixture-provider:yrc-scroll-a',
    title: 'YRC scroll A',
    lyrics:
      '[0,1000](0,300,0)Line (300,300,0)zero\\n[1000,1000](1000,300,0)Line (1300,300,0)one\\n[2000,1000](2000,300,0)Line (2300,300,0)two\\n[3000,1000](3000,300,0)Line (3300,300,0)three\\n[4000,1000](4000,300,0)Line (4300,300,0)four\\n[5000,1000](5000,300,0)Line (5300,300,0)five'
  }
  const yrcTrackB = {
    ...yrcTrackA,
    id: 'fixture-provider:yrc-scroll-b',
    title: 'YRC scroll B'
  }
  /*
   * The stage is overflow:hidden and every row is absolutely positioned, so the
   * controller only needs the stage box and each row's height. It never reads or
   * writes scrollTop.
   */
  const installStageGeometry = () => {
    const stage = document.querySelector('.lyrics-scroll')
    expect(stage, 'lyric stage was not mounted for the YRC regression probe')
    Object.defineProperties(stage, {
      clientHeight: { configurable: true, value: 180 },
      clientWidth: { configurable: true, value: 640 }
    })
    document.querySelectorAll('.lyric-row').forEach((row) => {
      Object.defineProperties(row, {
        offsetHeight: { configurable: true, value: 72 }
      })
    })
    return stage
  }

  const rowTop = (row) => Number.parseFloat(row.style.getPropertyValue('--lyric-line-top'))
  const rowScale = (row) => Number.parseFloat(row.style.getPropertyValue('--lyric-line-scale'))

  player.currentTrack.value = structuredClone(yrcTrackA)
  player.queue.value = [structuredClone(yrcTrackA)]
  player.currentTime.value = 5
  player.seek(5)
  await tick()
  installStageGeometry()
  window.dispatchEvent(new Event('resize'))
  await new Promise((resolve) => setTimeout(resolve, 520))

  const activeRow = document.querySelector('.lyric-row.active')
  const rows = [...document.querySelectorAll('.lyric-row')]
  expect(activeRow, 'no lyric row became active at 5s')
  const activeIndex = rows.indexOf(activeRow)
  expect(activeIndex > 0, 'the probe needs a later active line; index=' + activeIndex)

  expect(
    activeRow.style.getPropertyValue('--lyric-line-top') !== '',
    'the layout loop did not position the active row'
  )

  // Anchoring replaces scrolling: the active line sits near the align position
  // (0.35 of the stage) rather than being scrolled to.
  const activeTop = rowTop(activeRow)
  expect(
    activeTop < 180 * 0.6,
    'active line was not anchored into the upper region of the stage; top=' + activeTop
  )

  // Culled rows stop painting, but they still keep a layout top so scrolling
  // onto them cannot discover a pile at y=0.
  const visible = rows.filter((row) => row.style.getPropertyValue('--lyric-line-in-sight') !== '0')
  expect(
    visible.length >= 2 && visible.length < rows.length,
    'expected some rows visible and some culled; visible=' +
      visible.length +
      ' of ' +
      rows.length
  )
  expect(
    rows.every((row) => row.style.getPropertyValue('--lyric-line-top') !== ''),
    'every row should keep a layout top, including culled ones'
  )
  const tops = rows.map(rowTop)
  expect(
    tops.every((top, index) => index === 0 || top > tops[index - 1]),
    'rows were not stacked in reading order; tops=' + tops.join(',')
  )
  const culled = rows.find((row) => row.style.getPropertyValue('--lyric-line-in-sight') === '0')
  expect(culled, 'no row was flagged out of sight despite the stage being shorter than the timeline')

  // Depth now comes from per-line scale and blur, not from a scroll position.
  const receding = visible.find((row) => row !== activeRow)
  expect(
    rowScale(activeRow) > rowScale(receding),
    'the active line did not scale above a receding one; active=' +
      rowScale(activeRow) +
      '; receding=' +
      rowScale(receding)
  )
  const activeBlur = Number.parseFloat(activeRow.style.getPropertyValue('--lyric-line-blur'))
  expect(activeBlur === 0, 'active row retained blur instead of staying sharp; blur=' + activeBlur)
  const recedingBlur = Number.parseFloat(receding.style.getPropertyValue('--lyric-line-blur'))
  expect(recedingBlur > 0, 'receding rows did not blur; blur=' + recedingBlur)
  expect(
    document.querySelector('.lyric-row[style*="--lyric-depth-scale"]') === null,
    'the retired depth variable is still being written'
  )

  player.currentTrack.value = structuredClone(yrcTrackB)
  player.queue.value = [structuredClone(yrcTrackB)]
  player.currentTime.value = 0
  player.seek(0)
  await tick()
  installStageGeometry()

  player.currentTrack.value = structuredClone(yrcTrackA)
  player.queue.value = [structuredClone(yrcTrackA)]
  player.currentTime.value = 5
  player.seek(5)
  await tick()
  installStageGeometry()
  await new Promise((resolve) => setTimeout(resolve, 520))
  const restoredRows = [...document.querySelectorAll('.lyric-row')]
  const restoredActive = document.querySelector('.lyric-row.active')
  expect(restoredActive, 'switching back to a YRC track left no active line')
  const restoredIndex = restoredRows.indexOf(restoredActive)
  expect(restoredIndex > 0, 'switching back did not restore the later active line')
  // A later line being anchored means earlier lines were pushed off the top,
  // which is what leaving it stuck at the top of the stage would not do.
  expect(
    restoredRows.slice(0, restoredIndex).some((row) => rowTop(row) < 0),
    'switching back left the later active line at the top of the stage; tops=' +
      restoredRows.map(rowTop).join(',')
  )

  const alternatingTrack = {
    ...track,
    id: 'fixture-provider:alternating-voices',
    title: 'Alternating voices',
    lyrics: [
      '[00:01.00][te:voice role=lead lane=start speaker=Alice]All you say is a bunch of lies',
      '[00:03.00][te:voice role=lead lane=end speaker=Bob]Dear miss genius idol, unmatched'
    ].join('\\n'),
    lyricsSource: 'embedded'
  }
  player.currentTrack.value = structuredClone(alternatingTrack)
  player.queue.value = [structuredClone(alternatingTrack)]
  player.currentTime.value = 1.5
  player.seek(1.5)
  await tick()
  installStageGeometry()
  await new Promise((resolve) => setTimeout(resolve, 120))

  const alternatingRows = [...document.querySelectorAll('.lyric-row')]
  expect(alternatingRows.length === 2, 'alternating voices did not remain on separate rows')
  for (const row of alternatingRows) {
    const grid = row.querySelector('.lyric-duet-grid')
    const lane = row.querySelector('.lyric-lane')
    const voice = row.querySelector('.lyric-voice')
    expect(grid && lane && voice, 'alternating voice row did not render its side lane')
    expect(!grid.classList.contains('lyric-duet-grid--split'), 'a single voice row still reserved two lanes')
    expect(row.querySelectorAll('.lyric-lane').length === 1, 'a single voice row rendered an empty opposite lane')
    const gridWidth = grid.getBoundingClientRect().width
    const laneWidth = lane.getBoundingClientRect().width
    const voiceWidth = voice.getBoundingClientRect().width
    const text = voice.querySelector('.lyric-text')
    expect(text, 'a single voice row did not render its lyric text')
    expect(
      laneWidth >= gridWidth - 1,
      'a single voice lane did not use the available row width; grid=' +
        gridWidth +
        '; lane=' +
        laneWidth
    )
    expect(
      voiceWidth >= gridWidth - 1,
      'a single voice still retained the narrow duet width; grid=' +
        gridWidth +
        '; voice=' +
        voiceWidth
    )
    const expectedTextAlign = lane.classList.contains('lyric-lane--end') ? 'end' : 'start'
    expect(
      getComputedStyle(text).textAlign === expectedTextAlign,
      'a side voice lost its singer-lane alignment; expected=' +
        expectedTextAlign +
        '; actual=' +
        getComputedStyle(text).textAlign
    )
  }

  const duetTrack = {
    ...track,
    id: 'fixture-provider:duet',
    title: 'Explicit duet',
    lyrics: [
      '[00:01.00][te:voice role=lead lane=start speaker=Alice group=chorus]First voice',
      '[00:01.00][te:voice role=lead lane=end speaker=Bob group=chorus]Second voice',
      '[00:01.20][te:voice role=harmony lane=end speaker=Bob group=chorus]Soft harmony',
      '[00:04.00]Ordinary line'
    ].join('\\n'),
    translatedLyrics: '[00:01.00]组合翻译',
    lyricsSource: 'embedded'
  }
  player.currentTrack.value = structuredClone(duetTrack)
  player.queue.value = [structuredClone(duetTrack)]
  player.currentTime.value = 1.5
  player.seek(1.5)
  await tick()
  installStageGeometry()
  await new Promise((resolve) => setTimeout(resolve, 120))

  const duetRows = [...document.querySelectorAll('.lyric-row')]
  expect(duetRows.length === 2, 'explicit group did not collapse to one seek row; rows=' + duetRows.length)
  const duetRow = duetRows[0]
  expect(
    duetRow.querySelector('.lyric-duet-grid')?.classList.contains('lyric-duet-grid--split'),
    'a simultaneous duet did not retain its split lanes'
  )
  expect(duetRow.querySelectorAll('.lyric-lane--start .lyric-voice--lead').length === 1, 'start lead lane missing')
  expect(duetRow.querySelectorAll('.lyric-lane--end .lyric-voice--lead').length === 1, 'end lead lane missing')
  expect(duetRow.querySelectorAll('.lyric-voice--harmony').length === 1, 'harmony layer missing')
  expect(duetRow.querySelectorAll('.lyric-translation').length === 1, 'translation was duplicated across duet lanes')
  expect(duetRow.getAttribute('aria-label').includes('First voice；Second voice；Soft harmony'), 'duet aria label omitted a voice')
  expect(duetRow.classList.contains('is-singing'), 'hot duet row did not receive singing state')
  expect(duetRow.getAttribute('aria-current') === 'true', 'duet anchor was not exposed separately')
  expect(!duetRow.textContent.includes('[te:voice'), 'internal voice marker leaked into the playing page')

  document.documentElement.dataset.teMotion = 'reduced'
  await tick()
  await new Promise((resolve) => setTimeout(resolve, 160))
  const reducedRows = [...document.querySelectorAll('.lyric-row')]
    .map((row) => row.getBoundingClientRect())
    .sort((left, right) => left.top - right.top)
  expect(reducedRows.length === 2, 'reduced-motion duet did not retain both lyric rows')
  expect(
    reducedRows[1].top >= reducedRows[0].bottom - 0.5,
    'reduced motion collapsed absolute lyric rows at top zero'
  )

  document.documentElement.dataset.teMotion = 'full'
  await tick()
  const remountRoot = document.createElement('div')
  document.body.appendChild(remountRoot)
  const remountedApp = createApp({ render: () => h(PlayingMusic) }).use(pinia)
  remountedApp.mount(remountRoot)
  await tick()
  await new Promise((resolve) => setTimeout(resolve, 160))
  const remountedRows = [...remountRoot.querySelectorAll('.lyric-row')]
  expect(remountedRows.length === 2, 'an already-active track did not render lyrics on page mount')
  expect(
    remountedRows.every((row) => row.style.getPropertyValue('--lyric-line-ready') === '1'),
    'mount activation cleared lyric row registrations before their first layout'
  )
  expect(
    remountedRows[0].style.getPropertyValue('--lyric-line-top') !==
      remountedRows[1].style.getPropertyValue('--lyric-line-top'),
    'freshly mounted lyric rows were left stacked at one position'
  )
  remountedApp.unmount()
  remountRoot.remove()

  // The real surfaces hand off without an overlapping iframe/blurred backdrop,
  // and returning preserves the cover/lyrics instance without replaying entry.
  const coverView = document.querySelector('.playback-cover-view')
  const coverFrame = document.querySelector('.cover-frame')
  const toggleView = () => document.querySelector('.visualizer-toggle-button').click()
  const visualizer = () => document.querySelector('.visualizer-panel')
  const waitMotion = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await tick()
      if (predicate()) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(message)
  }
  let samples = 0
  window.api.audioEngine.getVisualizationData = async () => {
    samples++
    return { tapStatus: 'synthetic-fallback' }
  }
  player.audioEngineReady.value = true
  player.isPlaying.value = true
  const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  for (const mode of ['full', 'reduced', 'off']) {
    document.documentElement.dataset.teMotion = mode
    await tick()
    toggleView()
    await waitMotion(() => visualizer() && getComputedStyle(document.querySelector('.playback-visualizer-view')).opacity === '1', mode + ' visualizer did not arrive')
    expect(!document.querySelector('.backdrop'), 'the live iframe overlaps the blurred backdrop')
    expect(getComputedStyle(coverView).display === 'none' && coverView.inert, 'the outgoing cover stayed visible or interactive')
    expect(document.querySelector('.cover-frame') === coverFrame, 'view switch remounted the cover')
    expect([...document.querySelectorAll('.lyric-row-content')].every(node => !node.__vueParentComponent.props.singing), 'memoized hidden lyric retained singing work')
    const iframe = document.querySelector('.visualizer-iframe')
    const samplesBeforeReady = samples
    window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { kind: 'ready' } }))
    document.dispatchEvent(new Event('visibilitychange'))
    await waitMotion(() => samples > samplesBeforeReady, 'active visualizer never polled')
    toggleView()
    await tick()
    const stoppedAt = samples
    await new Promise(resolve => setTimeout(resolve, 70))
    expect(samples === stoppedAt, 'outgoing visualizer continued polling')
    await waitMotion(() => !visualizer() && getComputedStyle(coverView).opacity === '1' && getComputedStyle(coverView).display !== 'none', mode + ' cover did not return')
    expect(document.querySelector('.cover-frame') === coverFrame, 'returning remounted artwork')
    expect(!coverFrame.getAnimations().length, 'returning replayed artwork entrance')
    expect(document.querySelector('.lyric-row.is-singing .lyric-row-content').__vueParentComponent.props.singing, 'same-line return did not reactivate memoized lyric')
    expect(document.querySelector('.lyric-row.is-singing .lyric-row-content').__vueParentComponent.props.karaokeEnabled === settingsStore.settings.value.lyricsAppearance.karaokeEnabled, 'same-line return did not restore karaoke preference')
    expect(document.querySelector('.backdrop'), 'cover backdrop was not restored after iframe unmounted')
  }
  document.documentElement.dataset.teMotion = 'full'
  // Keep the timeline moving while the retained lyric DOM is hidden, but do
  // not measure its zero-height viewport or rewrite its layout in that state.
  toggleView()
  await waitMotion(() => visualizer() && getComputedStyle(coverView).display === 'none', 'hidden-layout probe did not reach visualizer')
  const hiddenStage = document.querySelector('.lyrics-scroll')
  const previousHeight = Object.getOwnPropertyDescriptor(hiddenStage, 'clientHeight')
  const stageHeight = hiddenStage.clientHeight
  let hiddenMeasurements = 0
  Object.defineProperty(hiddenStage, 'clientHeight', { configurable: true, get() { hiddenMeasurements++; return stageHeight } })
  const hiddenTops = [...document.querySelectorAll('.lyric-row')].map(row => row.style.getPropertyValue('--lyric-line-top'))
  player.currentTime.value = 4.2
  player.seek(4.2)
  window.dispatchEvent(new Event('resize'))
  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(hiddenMeasurements === 0, 'hidden lyric viewport was measured')
  expect([...document.querySelectorAll('.lyric-row')].every((row, index) => row.style.getPropertyValue('--lyric-line-top') === hiddenTops[index]), 'hidden lyric layout was rewritten')
  if (previousHeight) Object.defineProperty(hiddenStage, 'clientHeight', previousHeight)
  else delete hiddenStage.clientHeight
  toggleView()
  await waitMotion(() => !visualizer() && getComputedStyle(coverView).opacity === '1', 'hidden clock advance stranded return')
  expect([...document.querySelectorAll('.lyric-row')].every(row => row.style.getPropertyValue('--lyric-line-ready') === '1'), 'reattached lyric rows were not laid out')
  toggleView();await tick();toggleView();await tick();toggleView()
  await waitMotion(() => visualizer() && getComputedStyle(document.querySelector('.playback-visualizer-view')).opacity === '1', 'rapid handoff did not converge to latest view')
  toggleView();await tick();document.documentElement.dataset.teMotion = 'off'
  await waitMotion(() => !visualizer() && getComputedStyle(coverView).display !== 'none', 'off mid-handoff left a blank surface')
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden)
  else delete document.hidden
  window.beginPlaybackMotionCapture = async () => {
    document.documentElement.dataset.teMotion = 'full'
    await tick()
    await waitMotion(() => getComputedStyle(coverView).opacity === '1' && !coverView.getAnimations().length, 'capture cover did not settle')
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    toggleView()
    await waitMotion(() => coverView.getAnimations().length > 0, 'capture handoff did not animate')
    coverView.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 25 })
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
  }
  window.endPlaybackMotionCapture = async () => {
    coverView.getAnimations().forEach(animation => animation.play())
    await waitMotion(() => visualizer() && getComputedStyle(document.querySelector('.playback-visualizer-view')).opacity === '1', 'capture visualizer did not arrive')
    toggleView()
    await waitMotion(() => !visualizer() && getComputedStyle(coverView).opacity === '1' && getComputedStyle(coverView).display !== 'none', 'capture did not restore cover')
  }
  window.setPlayingMusicLayoutFixture = async (hasLyrics, appearance = {}) => {
    document.documentElement.dataset.teMotion = 'off'
    document.documentElement.dataset.tePlayerLayout = 'standard'
    settingsStore.settings.value.lyricsAppearance = { ...originalAppearance, ...appearance }
    player.currentTrack.value = {
      ...duetTrack,
      id: 'fixture-provider:responsive-layout',
      title: 'When the Bird Meets the Sky',
      artist: 'Whilist',
      album: '夜想録',
      lyrics: hasLyrics ? duetTrack.lyrics : '',
      translatedLyrics: hasLyrics ? duetTrack.translatedLyrics : null
    }
    await tick()
    window.dispatchEvent(new Event('resize'))
  }
  console.log('PLAYING_MUSIC_LYRICS_RUNTIME_OK')
}
`
}

function runtimeHtml(bundleName: string, styleName?: string): string {
  const stylesheet = styleName ? `<link rel="stylesheet" href="bundle/${styleName}">` : ''
  return `<!doctype html><html><head><meta charset="utf-8">${stylesheet}</head><body><div id="app"></div>
<script>
window.process = { env: {} }
window.__lyricsFixture = {
  revision: 1,
  rejectNextSave: false,
  importResult: null,
  importCalls: 0,
  saveResult: null,
  saveCalls: 0,
  lastSavedContents: null,
  document: {
    schemaVersion: 1, globalOffsetMs: 0,
    showOriginal: true, showTranslation: true, showRomanization: false,
    tracks: {}
  }
}
const clone = (value) => JSON.parse(JSON.stringify(value))
const envelope = () => ({ version: 2, revision: window.__lyricsFixture.revision, savedAt: '2026-07-18T00:00:00.000Z', data: clone(window.__lyricsFixture.document) })
window.__settingsFixture = { settings: {}, patches: [] }
const settingsSnapshot = () => ({
  settings: clone(window.__settingsFixture.settings),
  defaults: { cachePath: '' },
  paths: { settingsFile: '', userDataPath: '', activeCachePath: '' },
  appVersion: 'test',
  platform: 'win32',
  restartRequired: false,
  restartReasons: []
})
window.__audioFixture = {
  propertyCallbacks: [],
  playbackInfoCallbacks: [],
  playbackInfo: { state: 'stopped', position: 0, duration: 0, source: '', queueIndex: -1, nativePlaybackActive: false },
  emitProperty(name, data) {
    for (const cb of this.propertyCallbacks) cb({ name, data })
  },
  emitPlaybackInfo(info) {
    this.playbackInfo = info
    for (const cb of this.playbackInfoCallbacks) cb(info)
  }
}
const subscribe = (list, cb) => {
  list.push(cb)
  return () => {
    const index = list.indexOf(cb)
    if (index >= 0) list.splice(index, 1)
  }
}
const noopSubscribe = () => () => {}
window.api = {
  ncmCloud: { onProgress: noopSubscribe },
  library: {
    getStorageMode: async () => 'json',
    onChanged: noopSubscribe,
    database: {
      queryTracks: async () => ({ tracks: [], total: 0, offset: 0, limit: 100, revision: 0 }),
      queryCollections: async () => ({ items: [], total: 0, offset: 0, limit: 100, revision: 0 }),
      getTracksByIds: async () => ({ tracks: [], revision: 0 }),
      readQueue: async () => { throw new Error('lyrics fixture has no database queue') }
    }
  },
  settings: {
    get: async () => settingsSnapshot(),
    update: async (patch) => {
      window.__settingsFixture.patches.push(clone(patch))
      window.__settingsFixture.settings = {
        ...window.__settingsFixture.settings,
        ...patch,
        lyricsAppearance: {
          ...window.__settingsFixture.settings.lyricsAppearance,
          ...patch.lyricsAppearance
        }
      }
      return settingsSnapshot()
    },
    onChanged: () => () => {}
  },
  audioEngine: {
    onPropertyChange: (cb) => subscribe(window.__audioFixture.propertyCallbacks, cb),
    onPlaybackInfo: (cb) => subscribe(window.__audioFixture.playbackInfoCallbacks, cb),
    onEndFile: noopSubscribe,
    onStartFile: noopSubscribe,
    onReady: noopSubscribe,
    onError: noopSubscribe,
    onDisconnected: noopSubscribe,
    getPlaybackInfo: async () => window.__audioFixture.playbackInfo,
    setVolume: async () => {},
    getAudioOutputState: async () => { throw new Error('fixture output unavailable') },
    getAudioProcessing: async () => { throw new Error('fixture processing unavailable') },
    seek: async (position) => { window.__audioFixture.seekPosition = position }
  },
  data: {
    loadLyricsManagement: async () => envelope(),
    saveLyricsManagement: async (next, expectedRevision) => {
      const fixture = window.__lyricsFixture
      if (fixture.rejectNextSave) {
        fixture.rejectNextSave = false
        fixture.revision += 1
        const error = new Error('fixture CAS conflict')
        error.code = 'ERR_PERSISTENCE_REVISION_CONFLICT'
        error.expectedRevision = expectedRevision
        error.current = envelope()
        throw error
      }
      if (expectedRevision !== fixture.revision) throw new Error('unexpected lyrics revision')
      fixture.document = clone(next)
      fixture.revision += 1
      return envelope()
    },
    importLyrics: async () => {
      window.__lyricsFixture.importCalls += 1
      return window.__lyricsFixture.importResult
    },
    saveLyrics: async (contents) => {
      window.__lyricsFixture.saveCalls += 1
      window.__lyricsFixture.lastSavedContents = contents
      return window.__lyricsFixture.saveResult
    },
    getLyrics: async () => null,
    searchOnlineLyrics: async () => ({ candidates: [] })
  },
  providers: { list: async () => [], call: async () => null }
}
</script><script src="bundle/${bundleName}"></script></body></html>`
}

function electronRunnerSource(): string {
  const readySource = `(() => {
    const row = document.querySelector('.lyric-row.is-singing')
    const cover = document.querySelector('.cover-frame')
    const metadata = document.querySelector('.cover-meta')
    if (!row || !cover || !metadata || row.style.getPropertyValue('--lyric-line-ready') !== '1') {
      return false
    }
    const rowRect = row.getBoundingClientRect()
    const coverRect = cover.getBoundingClientRect()
    const metadataRect = metadata.getBoundingClientRect()
    return (
      rowRect.bottom > 0 &&
      rowRect.top < innerHeight &&
      coverRect.width > 0 &&
      coverRect.bottom > 0 &&
      metadataRect.width > 0 &&
      Number.parseFloat(getComputedStyle(cover).opacity) > 0.99 &&
      Number.parseFloat(getComputedStyle(metadata).opacity) > 0.99
    )
  })()`
  const resetFixtureGeometrySource = `(() => {
    const stage = document.querySelector('.lyrics-scroll')
    if (stage) {
      delete stage.clientHeight
      delete stage.clientWidth
    }
    document.querySelectorAll('.lyric-row').forEach((row) => {
      delete row.offsetHeight
    })
    window.dispatchEvent(new Event('resize'))
  })()`
  const layoutDiagnosticsSource = `(() => {
    const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect()
    const page = rect('.playing-music')
    const layout = rect('.layout')
    const column = rect('.cover-column')
    const cover = rect('.cover-frame')
    const lyrics = rect('.lyrics-column')
    const time = rect('.time-chip')
    const center = (box) => (box.left + box.right) / 2
    const gap = Number.parseFloat(getComputedStyle(document.querySelector('.layout')).columnGap)
    return {
      viewport: [innerWidth, innerHeight],
      centered: Math.abs(center(layout) - center(page)) < 1,
      coverCentered: Math.abs(center(cover) - center(column)) < 1,
      coverVerticallyCentered: Math.abs((column.top + column.bottom - layout.top - layout.bottom) / 2) < 1,
      coverFits: cover.width > 0 && Math.abs(cover.width - cover.height) < 1 && column.top >= layout.top - 1 && column.bottom <= layout.bottom + 1,
      columnsSeparated: !lyrics || (innerWidth > 1120 ? lyrics.left >= column.right + gap - 1 : lyrics.top >= column.bottom + gap - 1),
      timeAtEdge: Math.abs(page.right - time.right - (innerWidth <= 760 ? 16 : 42)) < 1 && Math.abs(time.top - page.top - (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--te-titlebar-inset')) || 40) - 16) < 1,
      controlsClear: innerWidth > 1120 || time.bottom <= column.top,
      single: document.querySelector('.layout').classList.contains('layout--single'),
      overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
      cover: [cover.left, cover.right, cover.top, cover.bottom],
      column: [column.left, column.right, column.top, column.bottom],
      layout: [layout.left, layout.right, layout.top, layout.bottom],
      time: [time.left, time.right, time.top, time.bottom]
    }
  })()`
  const _diagnosticsSource = `(() => {
    const page = document.querySelector('.playing-music')
    const stage = document.querySelector('.lyrics-scroll')
    const cover = document.querySelector('.cover-frame')
    const metadata = document.querySelector('.cover-meta')
    const row = document.querySelector('.lyric-row.is-singing')
    const start = row?.querySelector('.lyric-lane--start')
    const end = row?.querySelector('.lyric-lane--end')
    const pageRect = page?.getBoundingClientRect()
    const rowRect = row?.getBoundingClientRect()
    const startRect = start?.getBoundingClientRect()
    const endRect = end?.getBoundingClientRect()
    const rowElements = [...document.querySelectorAll('.lyric-row')]
    const rowMetrics = rowElements.map((entry) => {
      const rect = entry.getBoundingClientRect()
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        offsetHeight: entry.offsetHeight,
        scrollHeight: entry.scrollHeight,
        lineTop: entry.style.getPropertyValue('--lyric-line-top'),
        scale: entry.style.getPropertyValue('--lyric-line-scale')
      }
    })
    const rows = rowElements
      .map((entry) => entry.getBoundingClientRect())
      .filter((rect) => rect.bottom > 0 && rect.top < innerHeight)
      .sort((left, right) => left.top - right.top)
    return {
      viewport: [innerWidth, innerHeight],
      page: pageRect ? [pageRect.left, pageRect.right, pageRect.top, pageRect.bottom] : null,
      row: rowRect ? [rowRect.left, rowRect.right, rowRect.top, rowRect.bottom] : null,
      fixtureGeometryVisible: Boolean(
        stage &&
        (Object.hasOwn(stage, 'clientHeight') || Object.hasOwn(stage, 'clientWidth'))
      ) || rowElements.some((entry) => Object.hasOwn(entry, 'offsetHeight')),
      coverVisible: Boolean(
        cover &&
        metadata &&
        cover.getBoundingClientRect().width > 0 &&
        metadata.getBoundingClientRect().width > 0 &&
        Number.parseFloat(getComputedStyle(cover).opacity) > 0.99 &&
        Number.parseFloat(getComputedStyle(metadata).opacity) > 0.99
      ),
      lanesOverlap: Boolean(startRect && endRect && startRect.right > endRect.left && startRect.bottom > endRect.top && startRect.top < endRect.bottom),
      rowMetrics,
      rowsOverlap: rows.some((rect, index) => index > 0 && rect.top < rows[index - 1].bottom - 0.5),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
      markerVisible: document.body.innerText.includes('[te:voice')
    }
  })()`
  return `const { app, BrowserWindow } = require('electron')
const { mkdir, writeFile } = require('node:fs/promises')
const path = require('node:path')
const target = process.argv.at(-1)
const visualDir = process.env.TWILIGHT_LYRIC_VISUAL_DIR || ''
const motionVisualDir = process.env.TWILIGHT_MOTION_VISUAL_DIR || ''
// Keep requested CSS viewport sizes exact on Windows displays with fractional DPI.
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const userDataDir = process.env.TWILIGHT_ELECTRON_USER_DATA_DIR || path.join(__dirname, 'profile')
app.setPath('userData', userDataDir)
app.commandLine.appendSwitch('disk-cache-dir', path.join(userDataDir, 'cache'))
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  // Native resize acknowledgement can lag behind setContentSize on Windows CI.
  // Wait for the actual CSS viewport instead of inspecting the previous frame.
  const resizeViewport = async (width, height) => {
    window.setContentSize(width, height)
    const deadline = Date.now() + 2400
    while (Date.now() < deadline) {
      const viewport = await window.webContents.executeJavaScript('[innerWidth, innerHeight]')
      if (viewport[0] === width && viewport[1] === height) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('viewport resize did not reach ' + width + 'x' + height)
  }
  window.webContents.on('console-message', (_event, _level, message, line, sourceId) => console.error('RENDERER', sourceId + ':' + line, message))
  try {
    await window.loadFile(path.resolve(target))
    const runtimeResult = await window.webContents.executeJavaScript(
      'window.runPlayingMusicLyricsRuntime().then(() => ({ ok: true }), (error) => ({ ok: false, message: error?.stack ?? error?.message ?? String(error) }))'
    )
    if (!runtimeResult.ok) throw new Error(runtimeResult.message)
    if (motionVisualDir) {
      await mkdir(motionVisualDir, { recursive: true })
      await window.webContents.executeJavaScript('window.beginPlaybackMotionCapture()')
      await writeFile(path.join(motionVisualDir, 'playback-view-handoff.png'), (await window.webContents.capturePage()).toPNG())
      await window.webContents.executeJavaScript('window.endPlaybackMotionCapture()')
      await writeFile(path.join(motionVisualDir, 'playback-view-return.png'), (await window.webContents.capturePage()).toPNG())
    }
    await window.webContents.executeJavaScript(${JSON.stringify(resetFixtureGeometrySource)})
    const layoutViewports = [[2560, 1440], [1920, 1080], [1440, 900], [1366, 768], [1280, 600], [1121, 720], [1120, 720], [1024, 768], [960, 540], [760, 600], [390, 844]]
    for (const [width, height] of layoutViewports) {
      await resizeViewport(width, height)
      for (const hasLyrics of [true, false]) {
        await window.webContents.executeJavaScript('window.setPlayingMusicLayoutFixture(' + hasLyrics + ')')
        await new Promise((resolve) => setTimeout(resolve, 80))
        const diagnostics = await window.webContents.executeJavaScript(${JSON.stringify(layoutDiagnosticsSource)})
        if (diagnostics.viewport[0] !== width || diagnostics.viewport[1] !== height || !diagnostics.centered || !diagnostics.coverFits || !diagnostics.columnsSeparated || !diagnostics.timeAtEdge || !diagnostics.controlsClear || diagnostics.overflow || diagnostics.single === hasLyrics || ((width > 1120 || !hasLyrics) && (!diagnostics.coverCentered || !diagnostics.coverVerticallyCentered))) {
          throw new Error('responsive layout failed: ' + JSON.stringify({ hasLyrics, ...diagnostics }))
        }
        if (visualDir && hasLyrics) {
          await mkdir(visualDir, { recursive: true })
          const image = await window.webContents.capturePage()
          await writeFile(path.join(visualDir, 'playing-layout-' + width + 'x' + height + '.png'), image.toPNG())
        }
      }
    }
    await resizeViewport(1920, 1080)
    for (const appearance of [{ coverGap: 160, lyricsMaxWidth: 420, coverSize: 60 }, { coverGap: 0, lyricsMaxWidth: 1200, lyricsOffsetX: 160 }]) {
      await window.webContents.executeJavaScript('window.setPlayingMusicLayoutFixture(true, ' + JSON.stringify(appearance) + ')')
      await new Promise((resolve) => setTimeout(resolve, 80))
      const diagnostics = await window.webContents.executeJavaScript(${JSON.stringify(layoutDiagnosticsSource)})
      if (diagnostics.viewport[0] !== 1920 || diagnostics.viewport[1] !== 1080 || !diagnostics.centered || !diagnostics.coverFits || !diagnostics.coverCentered || !diagnostics.timeAtEdge) {
        throw new Error('custom lyric geometry failed: ' + JSON.stringify({ appearance, ...diagnostics }))
      }
    }
    await window.webContents.executeJavaScript('window.setPlayingMusicLayoutFixture(true)')
    if (visualDir) {
      await mkdir(visualDir, { recursive: true })
      await window.webContents.executeJavaScript(${JSON.stringify(resetFixtureGeometrySource)})
      const viewports = [[1440, 900], [1024, 768], [760, 900], [390, 844]]
      for (const [width, height] of viewports) {
        await resizeViewport(width, height)
        await window.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))')
        const readyDeadline = Date.now() + 2400
        while (Date.now() < readyDeadline) {
          const ready = await window.webContents.executeJavaScript(${JSON.stringify(readySource)})
          if (ready) break
          await new Promise((resolve) => setTimeout(resolve, 80))
        }
        await new Promise((resolve) => setTimeout(resolve, 520))
        const diagnostics = await window.webContents.executeJavaScript(${JSON.stringify(_diagnosticsSource)})
        if (
          diagnostics.fixtureGeometryVisible ||
          !diagnostics.coverVisible ||
          diagnostics.horizontalOverflow ||
          diagnostics.markerVisible ||
          diagnostics.rowsOverlap
        ) {
          throw new Error('visual diagnostics failed at ' + width + 'x' + height + ': ' + JSON.stringify(diagnostics))
        }
        if (width >= 620 && diagnostics.lanesOverlap) {
          throw new Error('duet lanes overlap at ' + width + 'x' + height + ': ' + JSON.stringify(diagnostics))
        }
        const image = await window.webContents.capturePage()
        await writeFile(path.join(visualDir, 'playing-lyrics-' + width + 'x' + height + '.png'), image.toPNG())
        console.error('LYRIC_VISUAL', width + 'x' + height, JSON.stringify(diagnostics))
      }
    }
    app.exit(0)
  } catch (error) {
    console.error(
      'PLAYING_MUSIC_LYRICS_RUNTIME_FAILED',
      error?.stack ?? error?.message ?? String(error)
    )
    app.exit(1)
  }
})`
}
