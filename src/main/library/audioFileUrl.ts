export function encodeAudioFileUrlPath(filePath: string): string {
  return Buffer.from(filePath, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function decodeAudioFileUrlPath(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='), 'base64').toString(
    'utf-8'
  )
}
