import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import {
  DEFAULT_DESKTOP_LYRICS_SETTINGS,
  DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE,
  resolveDesktopLyricsPaletteColors
} from '../../../../shared/desktopLyrics.ts'

test('incoming position snapshots preserve a width or height still being dragged', async (t) => {
  const source = readFileSync(
    new URL('./DesktopLyricsSettingsSection.vue', import.meta.url),
    'utf8'
  )
  const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
  const body = script.slice(script.indexOf('const props ='))
  const props = reactive({ desktopLyrics: { ...DEFAULT_DESKTOP_LYRICS_SETTINGS } })
  const emits: unknown[][] = []
  const scope = effectScope()
  t.after(() => scope.stop())
  const entry = scope.run(() =>
    runInNewContext(stripTypeScriptTypes(`${body}\n;({draft,updatePatch,flushPendingPatch})`), {
      computed,
      reactive,
      ref,
      watch,
      DEFAULT_DESKTOP_LYRICS_SETTINGS,
      DESKTOP_LYRICS_VERTICAL_WINDOW_SIZE,
      resolveDesktopLyricsPaletteColors,
      defineProps: () => props,
      defineEmits:
        () =>
        (...args: unknown[]) =>
          emits.push(args),
      onBeforeUnmount: () => {},
      registerSettingsDisclosure: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {}
    })
  )!
  entry.updatePatch({ windowWidth: 1770 })
  entry.updatePatch({ windowHeight: 256 })
  props.desktopLyrics = { ...props.desktopLyrics, windowX: 0, windowY: 500, fontSize: 53 }
  await nextTick()
  assert.equal(entry.draft.windowWidth, 1770)
  assert.equal(entry.draft.windowHeight, 256)
  assert.equal(entry.draft.windowX, 0)
  assert.equal(entry.draft.fontSize, 53)
  entry.flushPendingPatch()
  assert.deepEqual(JSON.parse(JSON.stringify(emits)), [
    ['update', { windowWidth: 1770, windowHeight: 256 }]
  ])

  props.desktopLyrics = { ...props.desktopLyrics, windowWidth: 1760, windowHeight: 252 }
  await nextTick()
  assert.equal(
    entry.draft.windowWidth,
    1760,
    'confirmed settings apply after the pending edit is sent'
  )
  assert.equal(entry.draft.windowHeight, 252)
})
