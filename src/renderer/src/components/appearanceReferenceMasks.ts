const REFERENCE_COPY_SELECTOR =
  '.masthead-kicker,.hero-album,.hero-audio-meta,.fresh-name,.fresh-artist,' +
  '.chart-sub,.chart-plays,.cal-month,.panel-head small,' +
  '.online-eyebrow,.online-hero-description,.online-record-caption,' +
  '.online-track-info small,.home-local-card small'

/** Preserve the component's native line boxes while simplifying secondary sample copy. */
export function applyAppearanceReferenceMasks(root: ParentNode | undefined): void {
  for (const element of root?.querySelectorAll<HTMLElement>(REFERENCE_COPY_SELECTOR) ?? []) {
    element.classList.add('appearance-reference-masked')
    if (element.querySelector(':scope > .appearance-reference-mask')) continue
    const mask = element.ownerDocument.createElement('span')
    mask.className = 'appearance-reference-mask'
    mask.dataset.previewShape = ''
    mask.setAttribute('aria-hidden', 'true')
    element.append(mask)
  }
}

export function clearAppearanceReferenceMasks(root: ParentNode | undefined): void {
  for (const element of root?.querySelectorAll('.appearance-reference-masked') ?? []) {
    element.classList.remove('appearance-reference-masked')
    element.querySelector(':scope > .appearance-reference-mask')?.remove()
  }
}
