/** Local imports and self-contained raster images in exported themes. */
export function isThemeImageSource(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (/^background:\/\/[a-zA-Z0-9_-]+\.(?:png|webp|jpe?g)$/i.test(value)) return true
  const match =
    value.length <= 28 * 1024 * 1024 &&
    value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/)
  if (!match || match[2].length < 32) return false
  try {
    const header = atob(match[2].slice(0, 32))
    return match[1] === 'png'
      ? header.startsWith('\x89PNG\r\n\x1a\n')
      : match[1] === 'jpeg'
        ? header.startsWith('\xff\xd8\xff')
        : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP'
  } catch {
    return false
  }
}
