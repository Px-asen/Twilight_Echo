export function registerIconTests({ page, active, tick, until, expect, choose, setPart }) {
  const pane = () => document.querySelector('.studio-icon-popup')
  const open = async () => {
    document.querySelector('.studio-context-icons').click()
    await tick()
    expect(pane(), 'direct icon entry does not open the editor')
  }
  const click = async (selector) => {
    const button = pane()?.querySelector(selector)
    expect(button, 'missing icon action ' + selector)
    button.click()
    await tick()
  }
  window.iconTests = async () => {
    await setPart('navigation')
    await open()
    expect(
      document.querySelector('[aria-label="图标分组"]').value === 'navigation',
      'sidebar group'
    )
    await choose('图标分组', 'playback')
    await choose('选择图标', 'playback.play')
    const profileId = window.lastPreview.id
    const savedCount = window.commits.saved.length
    window.iconImportMode = 'png'
    await click('[data-icon-upload]')
    await until(
      () => window.lastPreview.iconBindings?.['playback.play'] === 'uploaded-icon',
      'upload does not bind selected icon in the real draft'
    )
    await until(
      () => pane().querySelector('img')?.naturalWidth === 1,
      'PNG preview does not decode'
    )
    const defaultSample = pane().querySelector('.theme-icon-settings-sample')
    expect(
      defaultSample.querySelector('[data-playback-icon="play"]') &&
        !defaultSample.querySelector('image'),
      'default comparison is replaced by uploaded icon or loses original SVG'
    )
    expect(
      window.assetRequests.at(-1).profileId === profileId &&
        window.assetRequests.at(-1).type === 'image' &&
        window.commits.saved.length === savedCount,
      'upload targets another profile or saves early'
    )
    await page.value.perform('undo')
    await until(
      () =>
        !window.lastPreview.iconBindings?.['playback.play'] &&
        !window.lastPreview.assets?.some((asset) => asset.id === 'uploaded-icon'),
      'upload undo leaves partial binding or asset'
    )
    await page.value.perform('redo')
    await until(
      () => window.lastPreview.iconBindings?.['playback.play'] === 'uploaded-icon',
      'upload redo loses binding'
    )
    await click('[data-icon-reset]')
    await until(() => !window.lastPreview.iconBindings?.['playback.play'], 'reset does not preview')
    expect(
      window.lastPreview.assets.some((asset) => asset.id === 'uploaded-icon'),
      'reset removes reusable assets'
    )
    await page.value.perform('undo')
    await until(
      () => window.lastPreview.iconBindings?.['playback.play'] === 'uploaded-icon',
      'reset cannot be undone'
    )
    await page.value.perform('redo')
    await until(() => !window.lastPreview.iconBindings?.['playback.play'], 'reset cannot be redone')
    await choose('使用已导入图标图片', 'uploaded-icon')
    await until(
      () => window.lastPreview.iconBindings?.['playback.play'] === 'uploaded-icon',
      'existing image cannot be reused'
    )
    window.failSave = true
    await page.value.perform('apply')
    expect(
      page.value.state.hasUnsavedChanges &&
        window.lastPreview.iconBindings['playback.play'] === 'uploaded-icon' &&
        page.value.state.error.includes('Context save failed'),
      'failed apply discards icon draft'
    )
    window.failSave = false
    await page.value.perform('apply')
    expect(
      !page.value.state.hasUnsavedChanges &&
        window.commits.saved.at(-1).iconBindings['playback.play'] === 'uploaded-icon',
      'apply does not persist binding'
    )
    await click('[data-icon-reset]')
    await until(() => !window.lastPreview.iconBindings?.['playback.play'], 'second reset lost')
    const originalConfirm = window.confirm
    window.confirm = () => false
    expect(
      !(await page.value.prepareLeave()) && page.value.state.hasUnsavedChanges,
      'denied leave drops icon draft'
    )
    window.confirm = originalConfirm
    await page.value.discard()
    await until(
      () =>
        window.lastPreview.iconBindings?.['playback.play'] === 'uploaded-icon' &&
        !page.value.state.hasUnsavedChanges,
      'discard does not restore persisted icon'
    )
    const baseline = JSON.stringify(window.lastPreview)
    for (const mode of ['cancel', 'fail', 'jpeg']) {
      window.iconImportMode = mode
      await click('[data-icon-upload]')
      await until(() => !page.value.state.busy, 'cancel/failure leaves busy')
      expect(
        JSON.stringify(window.lastPreview) === baseline,
        'cancel/failure changes draft: ' + mode
      )
      if (mode !== 'cancel') expect(pane().querySelector('[role=alert]'), 'missing import error')
    }
    window.iconImportMode = 'deferred'
    await click('[data-icon-upload]')
    expect(page.value.state.busy && pane().querySelector('fieldset').disabled, 'upload lacks lock')
    const saveCount = window.commits.saveAttempts
    const key = page.value.state.key
    const tone = page.value.state.tone
    await page.value.perform('apply')
    await page.value.discard()
    await page.value.setTone(tone === 'dark' ? 'pureWhite' : 'dark')
    await page.value.selectKey('preset:builtin:twilight-echo-default')
    expect(
      !(await page.value.prepareLeave()) &&
        window.commits.saveAttempts === saveCount &&
        page.value.state.key === key &&
        page.value.state.tone === tone &&
        JSON.stringify(window.lastPreview) === baseline,
      'busy upload permits apply/discard/tone/theme/leave'
    )
    // Force a reroute while the controlled native-picker promise is outstanding.
    await choose('选择图标', 'playback.pause')
    window.resolveIconImport({ id: 'late-slot', path: 'assets/late-slot.png', type: 'image' })
    await tick()
    expect(
      !page.value.state.busy && JSON.stringify(window.lastPreview) === baseline,
      'late upload binds after target changes'
    )
    await click('[data-icon-upload]')
    await setPart('material')
    window.resolveIconImport({ id: 'late-part', path: 'assets/late-part.png', type: 'image' })
    await tick()
    expect(
      !page.value.state.busy && JSON.stringify(window.lastPreview) === baseline && !pane(),
      'late upload survives part reroute'
    )
    await open()
    expect(document.querySelector('[aria-label="图标分组"]').value === 'titlebar', 'titlebar group')
    await click('[data-icon-upload]')
    active.value = false
    await tick()
    window.rejectIconImport(Error('Stale import failure'))
    await tick()
    expect(
      !page.value.state.busy &&
        JSON.stringify(window.lastPreview) === baseline &&
        !pane() &&
        !page.value.state.error.includes('Stale import'),
      'inactive editor accepts stale failure'
    )
    active.value = true
    await tick()
    await setPart('player-bar')
    await open()
    expect(document.querySelector('[aria-label="图标分组"]').value === 'playback', 'playback group')
    await setPart('card')
    expect(!document.querySelector('.studio-context-icons'), 'unrelated card exposes icon editor')
    window.iconImportMode = undefined
    return {
      uploadRestoreHistory: true,
      applyDiscard: true,
      cancelFailurePreserveDraft: true,
      busyAndStaleProtected: true
    }
  }
  window.iconLayout = async (tone, font) => {
    document.documentElement.dataset.theme = tone === 'dark' ? 'dark' : 'pureWhite'
    document.documentElement.style.setProperty('--te-control-font-size', font + 'px')
    document.documentElement.style.setProperty('--te-font-size-body', font + 'px')
    await setPart('card')
    await setPart('player-bar')
    await open()
    const host = pane()
    const editor = host.querySelector('.theme-icon-settings')
    const editorRoot = document.querySelector('#app')
    const tokenColor = (name) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      editorRoot.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }
    const text = getComputedStyle(editor).color
    const field = getComputedStyle(editor.querySelector('select')).backgroundColor
    const menu = getComputedStyle(host).backgroundColor
    expect(text === tokenColor('--appearance-edit-text'), 'teleport loses editor text color')
    expect(field === tokenColor('--appearance-edit-field'), 'teleport loses editor field color')
    expect(menu === tokenColor('--appearance-edit-menu'), 'teleport loses editor menu color')
    const popup = host.closest('.appearance-popover')
    const clip = host.closest('.appearance-popover-content')
    expect(
      editor.scrollWidth <= editor.clientWidth + 1 && host.scrollWidth <= host.clientWidth + 1,
      'icon options overflow horizontally'
    )
    const rect = popup.getBoundingClientRect()
    expect(
      rect.left >= 11 &&
        rect.right <= innerWidth - 11 &&
        rect.top >= 53 &&
        rect.bottom <= innerHeight - 11,
      'icon popover outside viewport'
    )
    const controls = [...editor.querySelectorAll('select,button')]
    for (const control of controls) {
      const bounds = control.getBoundingClientRect()
      expect(
        bounds.width > 0 && bounds.left >= rect.left && bounds.right <= rect.right + 1,
        'icon control clips horizontally'
      )
    }
    const last = controls.at(-1)
    last.focus()
    last.scrollIntoView({ block: 'nearest' })
    await tick()
    const lastRect = last.getBoundingClientRect()
    const clipRect = clip.getBoundingClientRect()
    expect(
      lastRect.bottom <= clipRect.bottom + 1 && lastRect.top >= clipRect.top - 1,
      'last icon option unreachable in short window'
    )
    const actualFont = parseFloat(getComputedStyle(editor).fontSize)
    expect(actualFont >= font, 'icon editor shrinks accessible text')
    const result = {
      tone,
      font,
      actualFont,
      windowWidth: innerWidth,
      windowHeight: innerHeight,
      width: rect.width,
      height: rect.height,
      text,
      field,
      menu
    }
    await setPart('card')
    document.documentElement.style.removeProperty('--te-control-font-size')
    document.documentElement.style.removeProperty('--te-font-size-body')
    return result
  }
  window.prepareIconKeyboard = async () => {
    await setPart('navigation')
    document.querySelector('.studio-context-icons').focus()
  }
  window.finishIconKeyboard = async () => {
    await tick()
    expect(
      pane() && document.activeElement === pane().querySelector('[aria-label="图标分组"]'),
      'native Enter does not open and focus icons'
    )
  }
  window.finishIconEscape = async () => {
    await tick()
    expect(
      !pane() && document.activeElement === document.querySelector('.studio-context-icons'),
      'icon Escape does not restore trigger focus'
    )
  }
}
