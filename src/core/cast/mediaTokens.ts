import { randomBytes } from '../../shared/portableCrypto.ts'
import { REMOTE_MEDIA_TOKEN_TTL_MS } from '../../shared/remoteControl.ts'

export type MediaStreamGrantKind = 'file' | 'remote'

export interface MediaStreamGrant {
  kind: MediaStreamGrantKind
  /** Local filesystem path when kind === 'file'. */
  filePath?: string
  /** Upstream http(s) URL when kind === 'remote'. */
  remoteUrl?: string
  contentType: string
  title?: string
  expiresAt: number
  /** Only the new phone-stream contract uses authenticated, version-pinned bounded reads. */
  stream?: { principal: string; libraryId: string; sourceId: string; sourceVersion: string }
}

export interface IssueMediaGrantOptions {
  contentType?: string
  title?: string
  ttlMs?: number
  stream?: MediaStreamGrant['stream']
}

export class MediaStreamGrantStore {
  private readonly grants = new Map<string, MediaStreamGrant>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxGrants = 1024

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? REMOTE_MEDIA_TOKEN_TTL_MS
  }

  /** Issue a token for a local file path (library / managed cache). */
  issue(filePath: string, options: IssueMediaGrantOptions = {}): string {
    return this.issueFile(filePath, options)
  }

  issueFile(filePath: string, options: IssueMediaGrantOptions = {}): string {
    this.pruneForIssue()
    const token = randomBytes(18).toString('base64url')
    this.grants.set(token, {
      kind: 'file',
      filePath,
      contentType: options.contentType ?? 'application/octet-stream',
      title: options.title,
      stream: options.stream,
      expiresAt: this.now() + (options.ttlMs ?? this.ttlMs)
    })
    return token
  }

  /** Issue a token that proxies an upstream http(s) media URL for DLNA cast. */
  issueRemote(remoteUrl: string, options: IssueMediaGrantOptions = {}): string {
    this.pruneForIssue()
    const token = randomBytes(18).toString('base64url')
    this.grants.set(token, {
      kind: 'remote',
      remoteUrl,
      contentType: options.contentType ?? 'audio/*',
      title: options.title,
      expiresAt: this.now() + (options.ttlMs ?? this.ttlMs)
    })
    return token
  }

  private pruneForIssue(): void {
    const now = this.now()
    for (const [token, grant] of this.grants) {
      if (now >= grant.expiresAt) this.grants.delete(token)
    }
    // Map insertion order evicts the oldest grant; current casts keep their
    // newest token even during a long-running remote-control session.
    while (this.grants.size >= this.maxGrants) {
      const oldest = this.grants.keys().next().value
      if (oldest !== undefined) this.grants.delete(oldest)
    }
  }

  resolve(token: string): MediaStreamGrant | null {
    if (typeof token !== 'string' || !token) return null
    const grant = this.grants.get(token)
    if (!grant) return null
    if (this.now() >= grant.expiresAt) {
      this.grants.delete(token)
      return null
    }
    return grant
  }

  revoke(token: string): void {
    this.grants.delete(token)
  }

  revokeStreams(principal?: string): void {
    for (const [token, grant] of this.grants)
      if (grant.stream && (!principal || grant.stream.principal === principal)) this.grants.delete(token)
  }

  clear(): void {
    this.grants.clear()
  }
}

export function guessAudioContentType(filePathOrUrl: string): string {
  const lower = filePathOrUrl.toLowerCase().split('?')[0] ?? filePathOrUrl.toLowerCase()
  if (lower.endsWith('.flac')) return 'audio/flac'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.wav') || lower.endsWith('.wave')) return 'audio/wav'
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg'
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4') || lower.endsWith('.alac')) {
    return 'audio/mp4'
  }
  if (lower.endsWith('.aac')) return 'audio/aac'
  if (lower.endsWith('.aiff') || lower.endsWith('.aif')) return 'audio/aiff'
  if (lower.endsWith('.opus')) return 'audio/opus'
  if (lower.endsWith('.ape')) return 'audio/x-ape'
  if (lower.endsWith('.wv')) return 'audio/x-wavpack'
  if (lower.endsWith('.dsf') || lower.endsWith('.dff')) return 'application/octet-stream'
  return 'application/octet-stream'
}
