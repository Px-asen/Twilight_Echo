import assert from 'node:assert/strict'
import test from 'node:test'
import { EN_US_MESSAGES } from './messages/en-US.ts'
import { ZH_CN_MESSAGES } from './messages/zh-CN.ts'
import {
  catalogFor,
  createTranslator,
  ensureLocaleCatalog,
  formatMessage,
  hasMessage,
  isLocaleCatalogLoaded,
  subscribeLocaleCatalog,
  t,
  translate
} from './translateRenderer.ts'

test('lazy-loads en-US catalog on demand while safely falling back to zh-CN before load', async () => {
  assert.equal(isLocaleCatalogLoaded('zh-CN'), true)
  assert.equal(isLocaleCatalogLoaded('en-US'), false)
  assert.equal(hasMessage('settings.language.title'), true)
  assert.equal(hasMessage('nope.not.here'), false)
  assert.equal(catalogFor('en-US'), ZH_CN_MESSAGES)

  let notifications = 0
  const unsubscribe = subscribeLocaleCatalog(() => {
    notifications += 1
  })

  try {
    // Before en-US resolves, lookups fall back to zh-CN (never blank or raw key)
    // and trigger background loading of the en-US catalog.
    assert.equal(translate('en-US', 'settings.language.title'), '语言')
    assert.equal(t('en-US', 'settings.language.title'), '语言')
    assert.equal(t('en-US', 'audio.reason.source_lossy.fix', {}, ''), '')
    assert.equal(translate('en-US', 'nope.not.here'), 'nope.not.here')
    assert.equal(isLocaleCatalogLoaded('en-US'), false)
    assert.equal(notifications, 0)

    const firstLoad = ensureLocaleCatalog('en-US')
    const secondLoad = ensureLocaleCatalog('en-US')
    assert.equal(firstLoad, secondLoad)

    const loaded = await firstLoad
    assert.equal(loaded, EN_US_MESSAGES)
    assert.equal(notifications, 1)
    assert.equal(isLocaleCatalogLoaded('en-US'), true)

    assert.equal(translate('en-US', 'settings.language.title'), 'Language')
    assert.equal(t('en-US', 'settings.language.title'), 'Language')
    assert.equal(createTranslator('en-US')('settings.language.title'), 'Language')
    assert.equal(catalogFor('en-US')['settings.language.title'], 'Language')

    // Subsequent ensure calls resolve immediately without re-notifying listeners.
    assert.equal(await ensureLocaleCatalog('en-US'), EN_US_MESSAGES)
    assert.equal(await ensureLocaleCatalog('zh-CN'), ZH_CN_MESSAGES)
    assert.equal(notifications, 1)
  } finally {
    unsubscribe()
  }
})

test('formatMessage preserves unfilled placeholders and strips CJK inter-script spaces', () => {
  assert.equal(formatMessage('{a} then {b}', { a: 'one' }), 'one then {b}')
  assert.equal(formatMessage('{node} 已启用', { node: 'ReplayGain' }), 'ReplayGain 已启用')
  assert.equal(formatMessage('{node} 已启用', { node: '均衡器' }), '均衡器已启用')
})
