/** Android document IDs are provider-local; a tree URI is only an access grant.
 * Keep the legacy fingerprint (including CUE sheet/track or SACD area/track) so
 * stored records can migrate without scanning or reinterpreting audio ranges. */
const SAF_TRACK_ID = /^(local:(?:saf|cue):[a-f0-9]{24}|local:sacd:[a-f0-9]{24}:(?:stereo|multichannel):[1-9]\d*)(?:@(.+))?$/
const DOCUMENT_SOURCE = /^content:\/\/([^/?#]+)\/(?:tree\/[^/?#]+\/)?document\/([^/?#]+)(?:[?#].*)?$/
const EXTERNAL_STORAGE = 'com.android.externalstorage.documents'

export function safDocumentKey(source: string): string | null {
  const match = DOCUMENT_SOURCE.exec(source)
  return match ? JSON.stringify([match[1], decodeURIComponent(match[2])]) : null
}

export function qualifySafTrackId(id: string, source: string): string {
  const match = SAF_TRACK_ID.exec(id)
  const authority = DOCUMENT_SOURCE.exec(source)?.[1]
  if (!match || match[2] || !authority || authority === EXTERNAL_STORAGE) return id
  return `${id}@${authority}`
}

/** App-generated document track IDs already include the logical subtrack.
 * Unlike a source URI, this key survives overlapping/replaced folder grants. */
export function safBookmarkTrackKey(id: string, source: string): string | null {
  return SAF_TRACK_ID.test(id) && DOCUMENT_SOURCE.test(source)
    ? `saf:${qualifySafTrackId(id, source)}`
    : null
}
