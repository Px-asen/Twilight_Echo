import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { computed } from 'vue'
import {
  EQ_BAND_MIN_FREQUENCY_HZ,
  EQ_BAND_MAX_FREQUENCY_HZ
} from '../../../../shared/audioProcessingOptions.ts'
import type { EqualizerBand } from '../../types/settings'

const source = readFileSync(new URL('./EqBandTable.vue', import.meta.url), 'utf8')
type Field = 'frequency' | 'gain' | 'q'

function fixture(graphic: boolean) {
  const script = source.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)![1]
  const ast = ts.createSourceFile('table.ts', script, ts.ScriptTarget.Latest, true)
  const body = ast.statements
    .filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(ast))
    .join('\n')
  const patches: Partial<EqualizerBand>[] = []
  const view = runInNewContext(
    ts.transpileModule(body + '\n({ number })', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText,
    {
      computed,
      EQ_BAND_MIN_FREQUENCY_HZ,
      EQ_BAND_MAX_FREQUENCY_HZ,
      defineProps: () => ({
        bands: [{ frequency: 96000, gain: 0, q: 1, filterType: 'peak' }],
        selectedIndices: [0],
        graphic
      }),
      defineEmits: () => (event: string, index: number, patch: Partial<EqualizerBand>) => {
        assert.equal(event, 'patch')
        assert.equal(index, 0)
        patches.push({ ...patch })
      }
    }
  )
  return {
    patches,
    input(field: Field, value: number) {
      const input = { valueAsNumber: value, value: String(value) }
      view.number(0, field, { target: input })
      return input
    }
  }
}

test('numeric table preserves the full stored frequency range in both EQ modes', () => {
  for (const graphic of [false, true]) {
    const f = fixture(graphic)
    for (const frequency of [10, 15, 20000, 24000, 96000]) f.input('frequency', frequency)
    f.input('frequency', 1)
    f.input('frequency', 100000)
    assert.deepEqual(
      f.patches,
      [10, 15, 20000, 24000, 96000, 10, 96000].map((frequency) => ({ frequency }))
    )
    assert.equal(f.input('frequency', NaN).value, '96000')
    assert.equal(f.patches.length, 7)
  }
})

test('table inputs and handlers share mode-specific gain and Q limits', () => {
  for (const graphic of [false, true]) {
    const f = fixture(graphic)
    f.input('gain', -100)
    f.input('gain', 100)
    f.input('q', 0)
    f.input('q', 100)
    assert.deepEqual(f.patches, [
      { gain: graphic ? -12 : -24 },
      { gain: graphic ? 12 : 24 },
      { q: graphic ? 0.25 : 0.1 },
      { q: graphic ? 8 : 20 }
    ])
  }
  for (const field of ['frequency', 'gain', 'q']) {
    assert.ok(source.includes(`:min="limits.${field}.min"`))
    assert.ok(source.includes(`:max="limits.${field}.max"`))
  }
})
