export function backgroundBlurTier(blurPx = 0): 0 | 8 | 20 {
  const value = Number.isFinite(blurPx) ? blurPx : 0
  if (value >= 20) return 20
  if (value >= 8) return 8
  return 0
}

/** Version the display URL so previously cached full-resolution wallpapers are bypassed. */
export function backgroundDisplayUrl(source: string, blurPx = 0): string {
  if (!source.startsWith('background://')) return source
  const url = new URL(source)
  url.searchParams.set('display', 'v1')
  const tier = backgroundBlurTier(blurPx)
  if (tier > 0) url.searchParams.set('blur', String(tier))
  else url.searchParams.delete('blur')
  return url.toString()
}
