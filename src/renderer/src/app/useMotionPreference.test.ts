import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveDocumentMotionMode } from './useMotionPreference.ts'

const NATIVE_INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'label'])
const PASSIVE_CLICK_STOP_CLASSES = [
  'playlist-row-actions',
  'context-menu',
  'create-playlist-dialog',
  'create-aggregate-dialog',
  'aggregate-dialog',
  'aggregate-variant-menu',
  'excluded-tracks-dialog',
  'streaming-context-menu'
]
const CLICKABLE_TEMPLATE_ELEMENT =
  /<(?<tag>[a-z][\w-]*)\b(?<attributes>[^>]*\s@click(?:[.=]|\s)[^>]*)>/gs

async function readVueSources(directory: URL): Promise<Array<{ path: string; source: string }>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const sources = await Promise.all(
    entries.map(async (entry) => {
      const location = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory)
      if (entry.isDirectory()) return readVueSources(location)
      if (!entry.name.endsWith('.vue')) return []
      return [{ path: fileURLToPath(location), source: await readFile(location, 'utf8') }]
    })
  )
  return sources.flat()
}

test('resolves motion preference against the system reduced-motion setting', () => {
  assert.equal(resolveDocumentMotionMode('system', false), 'full')
  assert.equal(resolveDocumentMotionMode('system', true), 'reduced')
  assert.equal(resolveDocumentMotionMode('full', true), 'full')
  assert.equal(resolveDocumentMotionMode('reduced', false), 'reduced')
  assert.equal(resolveDocumentMotionMode('off', false), 'off')
})

test('motion stylesheet covers native and custom interactive controls', async () => {
  const baseCss = await readFile(new URL('../assets/base.css', import.meta.url), 'utf8')
  const songList = await readFile(new URL('../components/SongList.vue', import.meta.url), 'utf8')
  const playerBar = await readFile(new URL('../components/PlayerBar.vue', import.meta.url), 'utf8')
  const streamingSearch = await readFile(
    new URL('../components/StreamingSearch.vue', import.meta.url),
    'utf8'
  )
  const playingMusic = await readFile(
    new URL('../components/PlayingMusic.vue', import.meta.url),
    'utf8'
  )
  const miniPlayerCss = await readFile(
    new URL('../mini-player/MiniPlayer.css', import.meta.url),
    'utf8'
  )

  assert.match(baseCss, /\[role='switch'\]/)
  assert.match(baseCss, /\[data-te-interactive\]/)
  assert.match(baseCss, /transition: translate var\(--te-motion-hover\)/)
  assert.match(baseCss, /--te-ease-spring/)
  assert.match(baseCss, /\[aria-disabled='true'\]/)
  // Press feedback must retarget mid-flight: a transition, never a keyframe.
  assert.match(baseCss, /transform: scale\(var\(--te-motion-press-scale\)\)/)
  // Lyric rows drive their position through `transform` springs: the global
  // press scale would replace that transform mid-press, teleport the row away
  // from the pointer, and the click would land on the gap between rows, so
  // lyric rows are excluded from every global press/hover transform rule.
  const pressRule = baseCss.match(
    /html\[data-te-motion='full'\][^{]*:active \{\s*transform: scale\(var\(--te-motion-press-scale\)\)/
  )?.[0]
  assert.ok(pressRule, 'global press rule should exist')
  assert.match(pressRule, /:where\(:not\(\.lyric-row\)\)/)
  assert.doesNotMatch(baseCss, /te-interactive-press/)
  assert.match(baseCss, /html\[data-te-motion='off'\]/)
  // Reduced motion keeps property-scoped feedback instead of nuking everything.
  assert.match(
    baseCss,
    /html\[data-te-motion='reduced'\][\s\S]{0,400}transition-property: opacity, color, background-color, border-color/
  )
  assert.match(baseCss, /html\[data-te-motion='reduced'\] \.pi-spin/)
  assert.doesNotMatch(baseCss, /animation-iteration-count: 1 !important/)
  assert.match(playingMusic, /te-playing-artwork-arrive/)
  assert.match(playingMusic, /lyrics-column--depth/)
  assert.doesNotMatch(playingMusic, /transition: all/)
  assert.match(miniPlayerCss, /html\[data-te-motion='reduced'\] .mini-player-root/)
  assert.match(songList, /data-te-interactive/)
  assert.match(playerBar, /data-te-interactive/)
  assert.match(streamingSearch, /data-te-interactive/)
})

test('every custom renderer click target declares motion coverage', async () => {
  const rendererRoot = new URL('../', import.meta.url)
  const missingCoverage: string[] = []

  for (const { path, source } of await readVueSources(rendererRoot)) {
    for (const match of source.matchAll(CLICKABLE_TEMPLATE_ELEMENT)) {
      const tag = match.groups?.tag ?? ''
      const attributes = match.groups?.attributes ?? ''
      if (NATIVE_INTERACTIVE_TAGS.has(tag)) continue
      if (attributes.includes('@click.self')) continue
      if (attributes.includes('data-reorder-group') && attributes.includes('@click.capture='))
        continue
      if (
        attributes.includes('@click.stop') &&
        PASSIVE_CLICK_STOP_CLASSES.some((className) => attributes.includes(className))
      ) {
        continue
      }
      if (attributes.includes('data-te-interactive')) continue
      if (/role\s*=\s*['"](?:button|switch)['"]/.test(attributes)) continue

      const line = source.slice(0, match.index).split('\n').length
      missingCoverage.push(`${path}:${line} <${tag}>`)
    }
  }

  assert.deepEqual(missingCoverage, [])
})

test('mini player receives the selected motion preference at bootstrap and runtime', async () => {
  const miniPlayerApp = await readFile(
    new URL('../mini-player/MiniPlayerApp.vue', import.meta.url),
    'utf8'
  )
  const miniPlayerIntegration = await readFile(
    new URL('../../../main/integrations/miniPlayer.ts', import.meta.url),
    'utf8'
  )

  assert.match(miniPlayerApp, /onMotionPreference/)
  assert.match(miniPlayerApp, /bootstrap\.motionPreference/)
  assert.match(miniPlayerIntegration, /miniPlayer:motionPreference/)
  assert.match(miniPlayerIntegration, /motionPreference: runtime\.appSettings\.motionPreference/)
})
