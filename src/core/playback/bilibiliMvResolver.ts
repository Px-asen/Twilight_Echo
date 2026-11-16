import type { TrackData } from '../../shared/track.ts'
import {
  normalizeProviderMvStream,
  type MediaProviderMvOptions,
  type MediaProviderMvQuality,
  type MediaProviderMvStream,
  type PluginMediaProviderMvResult
} from '../../shared/providerMv.ts'

const BILI_API_ORIGIN = 'https://api.bilibili.com'
const BILI_REFERER = 'https://www.bilibili.com/'
const BILI_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const SESSION_TTL_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
const BVID_EXACT_RE = /^BV1[0-9A-Za-z]{9}$/
const BVID_EXTRACT_RE = /\b(BV1[0-9A-Za-z]{9})\b/

const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
] as const

const DERIVATIVE_REJECT_PATTERNS: ReadonlyArray<{ token: string; pattern: RegExp }> = [
  { token: 'カラオケ', pattern: /カラオケ/i },
  { token: '伴奏', pattern: /伴奏/ },
  { token: 'off vocal', pattern: /\boff[\s_-]*vocal\b/i },
  { token: 'instrumental', pattern: /\binstrumental\b/i },
  { token: '消音', pattern: /消音/ },
  { token: '合集', pattern: /合集/ },
  { token: '串烧', pattern: /串烧/ },
  { token: '全曲', pattern: /全曲/ },
  { token: '盘点', pattern: /盘点/ },
  { token: 'reaction', pattern: /\breaction\b|リアクション/i },
  { token: '教程', pattern: /教程|教学|扒谱/ },
  { token: '翻唱', pattern: /翻唱|歌ってみた|ai翻唱/i },
  { token: 'cover', pattern: /\bcover\b/i },
  { token: '弹唱', pattern: /弹唱|钢琴版|吉他版/ },
  { token: '手书', pattern: /手书|鬼畜/ }
]

export interface BilibiliSearchVideoItem {
  bvid?: string
  title?: string
  author?: string
  duration?: string | number
  play?: number | string
  pic?: string
  description?: string
}

interface BilibiliWbiSession {
  cookie: string
  imgKey: string
  subKey: string
  expiresAt: number
}

interface BilibiliViewData {
  bvid: string
  cid: number
  title: string
  pic: string | null
  durationSeconds: number | null
  width: number | null
  height: number | null
}

interface BilibiliDashVideoItem {
  id?: number
  baseUrl?: string
  base_url?: string
  codecid?: number
  bandwidth?: number
  width?: number
  height?: number
}

interface BilibiliDashAudioItem {
  id?: number
  baseUrl?: string
  base_url?: string
  bandwidth?: number
}

interface BilibiliPlayurlData {
  quality?: number
  durl?: Array<{
    url?: string
    length?: number
    size?: number
  }>
  dash?: {
    duration?: number
    video?: BilibiliDashVideoItem[]
    audio?: BilibiliDashAudioItem[]
  }
}

export interface BilibiliMvResolverOptions {
  fetch?: typeof globalThis.fetch
  now?: () => number
  protectResult: (
    value: PluginMediaProviderMvResult,
    signal?: AbortSignal
  ) => Promise<unknown> | unknown
}

export interface BilibiliMvResolver {
  resolveTrackMv(
    track: Partial<TrackData>,
    options?: MediaProviderMvOptions,
    signal?: AbortSignal
  ): Promise<MediaProviderMvStream | null>
}

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
] as const

const MD5_K = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
)

function rotl32(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0
}

/**
 * Pure portable RFC 1321 MD5 digest over UTF-8 bytes so `src/core/` stays free
 * of Node-only `node:crypto` imports.
 */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input)
  const bitLenLo = (bytes.length * 8) >>> 0
  const bitLenHi = Math.floor((bytes.length * 8) / 0x100000000) >>> 0
  const totalLen = (((bytes.length + 8) >>> 6) + 1) << 6
  const padded = new Uint8Array(totalLen)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(totalLen - 8, bitLenLo, true)
  view.setUint32(totalLen - 4, bitLenHi, true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let offset = 0; offset < totalLen; offset += 64) {
    let a = a0
    let b = b0
    let c = c0
    let d = d0

    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const m = view.getUint32(offset + g * 4, true)
      const sum = (a + f + MD5_K[i] + m) >>> 0
      a = d
      d = c
      c = b
      b = (b + rotl32(sum, MD5_SHIFT[i])) >>> 0
    }

    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }

  const out = new Uint8Array(16)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, a0, true)
  outView.setUint32(4, b0, true)
  outView.setUint32(8, c0, true)
  outView.setUint32(12, d0, true)
  let hex = ''
  for (let i = 0; i < 16; i++) {
    hex += out[i].toString(16).padStart(2, '0')
  }
  return hex
}

export function encodeBilibiliWbiQuery(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  wtsSeconds: number
): string {
  const rawKey = imgKey + subKey
  let mixinKey = ''
  for (const index of WBI_MIXIN_TAB) {
    if (index < rawKey.length) mixinKey += rawKey[index]
  }
  mixinKey = mixinKey.slice(0, 32)

  const signedParams: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    signedParams[key] = String(value).replace(/[!'()*]/g, '')
  }
  signedParams.wts = String(Math.trunc(wtsSeconds))

  const query = Object.keys(signedParams)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(signedParams[key])}`)
    .join('&')
  const wRid = md5Hex(query + mixinKey)
  return `${query}&w_rid=${wRid}`
}

function stripHtmlTags(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim()
}

export function parseBilibiliDurationSeconds(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw)
  }
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const direct = Number(trimmed)
    return Number.isFinite(direct) && direct > 0 ? direct : null
  }
  const parts = trimmed.split(':').map((part) => Number(part.trim()))
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return null
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

function normalizeMatchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_/\\|·•・,，.。!！?？:：;；'"“”‘’`~()（）[\]【】「」『』《》〈〉]+/g, '')
}

function extractCoreSongTitle(title: string): string {
  const stripped = title
    .replace(/\s*(?:\(|（|\[|【)[^)\]）】]*(?:ver\.?|version|remix|remaster|live|feat\.?|ft\.?|ost|tv\s*size|伴奏|inst)[^)\]）】]*(?:\)|）|\]|】)\s*$/gi, '')
    .trim()
  return stripped.length >= 2 ? stripped : title.trim()
}

function splitArtistTokens(artist: string | undefined): string[] {
  if (!artist) return []
  return artist
    .split(/\s*(?:[/,&、×]|\b(?:feat\.?|ft\.?|x)\b)\s*/i)
    .map((part) => normalizeMatchText(part))
    .filter((part) => part.length >= 2)
}

function normalizeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (trimmed.startsWith('http://')) return `https://${trimmed.slice('http://'.length)}`
  if (trimmed.startsWith('https://')) return trimmed
  return null
}

function extractDirectBvid(track: Partial<TrackData>): string | null {
  if (typeof track.mvId === 'string') {
    const trimmedMvId = track.mvId.trim()
    if (BVID_EXACT_RE.test(trimmedMvId)) return trimmedMvId
    const match = BVID_EXTRACT_RE.exec(trimmedMvId)
    if (match) return match[1]
  }
  if (track.source === 'bili' || String(track.id ?? '').startsWith('bili:')) {
    const match = BVID_EXTRACT_RE.exec(String(track.id ?? ''))
    if (match) return match[1]
  }
  return null
}

function buildSearchKeyword(track: Partial<TrackData>): string | null {
  const rawTitle = typeof track.title === 'string' ? track.title.trim() : ''
  if (!rawTitle) return null
  const cleanArtist =
    typeof track.artist === 'string'
      ? track.artist
          .split(/[/,、&]+/)
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 2)
          .join(' ')
      : ''
  return [rawTitle, cleanArtist, 'MV'].filter(Boolean).join(' ')
}

export function rankBilibiliMvCandidates(
  track: Pick<Partial<TrackData>, 'title' | 'artist' | 'duration'>,
  items: readonly BilibiliSearchVideoItem[]
): Array<{ bvid: string; title: string; pic: string | null; durationSeconds: number }> {
  const rawTrackTitle = typeof track.title === 'string' ? track.title.trim() : ''
  if (!rawTrackTitle) return []

  const normalizedFullTitle = normalizeMatchText(rawTrackTitle)
  const normalizedCoreTitle = normalizeMatchText(extractCoreSongTitle(rawTrackTitle))
  if (!normalizedCoreTitle && !normalizedFullTitle) return []

  const artistTokens = splitArtistTokens(track.artist)
  const trackDuration =
    typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0
      ? track.duration
      : null
  const lowerTrackTitle = rawTrackTitle.toLowerCase()
  const trackIsLive = /\blive\b|现场|演唱会/i.test(rawTrackTitle)

  const scored: Array<{
    score: number
    bvid: string
    title: string
    pic: string | null
    durationSeconds: number
  }> = []
  const seenBvids = new Set<string>()

  for (const item of items) {
    const bvid = typeof item.bvid === 'string' ? item.bvid.trim() : ''
    if (!BVID_EXACT_RE.test(bvid) || seenBvids.has(bvid)) continue

    const cleanTitle = stripHtmlTags(typeof item.title === 'string' ? item.title : '')
    if (!cleanTitle) continue

    const durationSeconds = parseBilibiliDurationSeconds(item.duration)
    if (durationSeconds === null || durationSeconds <= 30 || durationSeconds > 1800) continue

    if (trackDuration !== null && trackDuration > 35) {
      const minAllowed = Math.max(40, trackDuration * 0.55)
      const maxAllowed = Math.max(trackDuration * 1.85, trackDuration + 150)
      if (durationSeconds < minAllowed || durationSeconds > maxAllowed) continue
    }

    let rejectedDerivative = false
    for (const rule of DERIVATIVE_REJECT_PATTERNS) {
      if (rule.pattern.test(cleanTitle) && !lowerTrackTitle.includes(rule.token)) {
        rejectedDerivative = true
        break
      }
    }
    if (rejectedDerivative) continue

    const normalizedCandidateTitle = normalizeMatchText(cleanTitle)
    const normalizedAuthor = normalizeMatchText(typeof item.author === 'string' ? item.author : '')

    let titleScore = 0
    if (normalizedFullTitle && normalizedCandidateTitle.includes(normalizedFullTitle)) {
      titleScore = 58
    } else if (normalizedCoreTitle && normalizedCandidateTitle.includes(normalizedCoreTitle)) {
      titleScore = 52
    }
    if (titleScore === 0) continue

    let score = titleScore

    if (artistTokens.length > 0) {
      const inAuthor = artistTokens.some((token) => normalizedAuthor.includes(token))
      const inTitle = artistTokens.some((token) => normalizedCandidateTitle.includes(token))
      if (inAuthor) score += 34
      if (inTitle) score += 24
    }

    const hasMvKeyword = /\bmv\b|music\s*video|\bpv\b/i.test(cleanTitle)
    const hasOfficialKeyword = /官方|公式|\bofficial\b/i.test(cleanTitle)
    if (hasMvKeyword) {
      score += 22
    } else if (!hasOfficialKeyword) {
      score -= 12
    }
    if (hasOfficialKeyword) {
      score += 18
    }
    if (/\b4k\b|\b1080p\b|原画|高码|无损/i.test(cleanTitle)) {
      score += 6
    }
    if (/中字|字幕/.test(cleanTitle)) {
      score -= 3
    }
    if (!trackIsLive && /\blive\b|现场|演唱会/i.test(cleanTitle)) {
      score -= 25
    }

    if (trackDuration !== null && trackDuration > 30) {
      const diff = durationSeconds - trackDuration
      const absDiff = Math.abs(diff)
      if (absDiff <= 8) {
        score += 30
      } else if (absDiff <= 25) {
        score += 24
      } else if (diff > 25 && diff <= 65) {
        score += 16
      } else if (absDiff <= 90) {
        score += 6
      } else {
        score -= 10
      }
    }

    const playCount = typeof item.play === 'number' ? item.play : Number(item.play ?? 0)
    if (Number.isFinite(playCount) && playCount > 0) {
      score += Math.min(18, Math.log10(Math.max(1, playCount)) * 3)
    }

    if (score < 45) continue
    seenBvids.add(bvid)
    scored.push({
      score,
      bvid,
      title: cleanTitle,
      pic: normalizeHttpsUrl(item.pic),
      durationSeconds
    })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.map(({ bvid, title, pic, durationSeconds }) => ({
    bvid,
    title,
    pic,
    durationSeconds
  }))
}

export function pickBestBilibiliMvCandidate(
  track: Pick<Partial<TrackData>, 'title' | 'artist' | 'duration'>,
  items: readonly BilibiliSearchVideoItem[]
): { bvid: string; title: string; pic: string | null; durationSeconds: number } | null {
  return rankBilibiliMvCandidates(track, items)[0] ?? null
}

function targetQnForQuality(quality: MediaProviderMvQuality | undefined): number {
  switch (quality) {
    case '480p':
      return 32
    case '720p':
      return 64
    case '1080p':
    case 'auto':
    default:
      return 80
  }
}

function qualityLabelFromQn(qn: number | undefined, height?: number | null): string {
  if ((qn && qn >= 120) || (height && height >= 2000)) return '4K'
  if ((qn && qn >= 80) || (height && height >= 1000)) return '1080p'
  if ((qn && qn >= 64) || (height && height >= 700)) return '720p'
  return '480p'
}

function approximateDimensionsForQn(
  qn: number,
  viewWidth: number | null,
  viewHeight: number | null
): { width: number | null; height: number | null } {
  const targetHeight = qn >= 80 ? 1080 : qn >= 64 ? 720 : 480
  if (viewWidth && viewHeight && viewWidth > 0 && viewHeight > 0) {
    const ratio = viewWidth / viewHeight
    if (ratio >= 1) {
      const height = Math.min(viewHeight, targetHeight)
      return { width: Math.round(height * ratio), height }
    }
    const width = Math.min(viewWidth, targetHeight)
    return { width, height: Math.round(width / ratio) }
  }
  return { width: Math.round((targetHeight * 16) / 9), height: targetHeight }
}

function pickDashStream(
  data: BilibiliPlayurlData | null | undefined,
  targetQn: number
): {
  url: string
  audioUrl: string | null
  qn: number
  width: number | null
  height: number | null
} | null {
  const videos = Array.isArray(data?.dash?.video) ? data.dash.video : []
  const validVideos = videos
    .map((entry) => {
      const url = normalizeHttpsUrl(entry.baseUrl ?? entry.base_url)
      const qn = typeof entry.id === 'number' && Number.isFinite(entry.id) ? entry.id : 0
      const codecId = typeof entry.codecid === 'number' ? entry.codecid : 0
      const codecRank = codecId === 7 ? 3 : codecId === 13 ? 2 : codecId === 12 ? 1 : 0
      return url && qn > 0
        ? {
            url,
            qn,
            codecRank,
            bandwidth: typeof entry.bandwidth === 'number' ? entry.bandwidth : 0,
            width: typeof entry.width === 'number' && entry.width > 0 ? entry.width : null,
            height: typeof entry.height === 'number' && entry.height > 0 ? entry.height : null
          }
        : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  if (validVideos.length === 0) return null

  const withinCap = validVideos.filter((v) => v.qn <= targetQn)
  const pool = withinCap.length > 0 ? withinCap : validVideos
  pool.sort((a, b) => {
    if (withinCap.length > 0) {
      if (b.qn !== a.qn) return b.qn - a.qn
    } else if (a.qn !== b.qn) {
      return a.qn - b.qn
    }
    if (b.codecRank !== a.codecRank) return b.codecRank - a.codecRank
    return b.bandwidth - a.bandwidth
  })
  const chosenVideo = pool[0]

  const audios = Array.isArray(data?.dash?.audio) ? data.dash.audio : []
  const validAudios = audios
    .map((entry) => {
      const url = normalizeHttpsUrl(entry.baseUrl ?? entry.base_url)
      return url
        ? {
            url,
            bandwidth: typeof entry.bandwidth === 'number' ? entry.bandwidth : 0
          }
        : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => b.bandwidth - a.bandwidth)

  return {
    url: chosenVideo.url,
    audioUrl: validAudios[0]?.url ?? null,
    qn: chosenVideo.qn,
    width: chosenVideo.width,
    height: chosenVideo.height
  }
}

function extractKeyStem(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const lastSegment = url.split('/').pop() ?? ''
  const stem = lastSegment.split('.')[0]?.trim() ?? ''
  return stem.length >= 8 ? stem : null
}

export function createBilibiliMvResolver(options: BilibiliMvResolverOptions): BilibiliMvResolver {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  let cachedSession: BilibiliWbiSession | null = null
  let inFlightSession: Promise<BilibiliWbiSession> | null = null

  async function fetchJson(
    url: string,
    headers: Record<string, string>,
    callerSignal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    callerSignal?.throwIfAborted()
    const timeoutController = new AbortController()
    const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS)
    const onCallerAbort = () => timeoutController.abort()
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          Referer: BILI_REFERER,
          'User-Agent': BILI_USER_AGENT,
          ...headers
        },
        signal: timeoutController.signal
      })
      if (!response.ok) {
        throw new Error(`Bilibili HTTP ${response.status}`)
      }
      const parsed = (await response.json()) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Bilibili API returned malformed JSON')
      }
      return parsed as Record<string, unknown>
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
      callerSignal?.throwIfAborted()
    }
  }

  async function getSession(
    forceRefresh: boolean,
    signal?: AbortSignal
  ): Promise<BilibiliWbiSession> {
    if (!forceRefresh && cachedSession && cachedSession.expiresAt > now()) {
      return cachedSession
    }
    if (!forceRefresh && inFlightSession) {
      return inFlightSession
    }
    const loadPromise = (async (): Promise<BilibiliWbiSession> => {
      let cookie = `buvid3=${crypto.randomUUID().toUpperCase()}infoc`
      try {
        const spi = await fetchJson(`${BILI_API_ORIGIN}/x/frontend/finger/spi`, {}, signal)
        const spiData = spi.data as Record<string, unknown> | undefined
        const b3 = typeof spiData?.b_3 === 'string' ? spiData.b_3.trim() : ''
        const b4 = typeof spiData?.b_4 === 'string' ? spiData.b_4.trim() : ''
        if (b3) {
          cookie = b4 ? `buvid3=${b3}; buvid4=${b4}` : `buvid3=${b3}`
        }
      } catch {
        signal?.throwIfAborted()
      }

      const nav = await fetchJson(
        `${BILI_API_ORIGIN}/x/web-interface/nav`,
        { Cookie: cookie },
        signal
      )
      const navData = nav.data as Record<string, unknown> | undefined
      const wbiImg = navData?.wbi_img as Record<string, unknown> | undefined
      const imgKey = extractKeyStem(wbiImg?.img_url)
      const subKey = extractKeyStem(wbiImg?.sub_url)
      if (!imgKey || !subKey) {
        throw new Error('Failed to obtain Bilibili WBI signing keys')
      }

      const session: BilibiliWbiSession = {
        cookie,
        imgKey,
        subKey,
        expiresAt: now() + SESSION_TTL_MS
      }
      cachedSession = session
      return session
    })()

    inFlightSession = loadPromise
    try {
      return await loadPromise
    } finally {
      if (inFlightSession === loadPromise) {
        inFlightSession = null
      }
    }
  }

  async function callWbiApi(
    pathname: string,
    params: Record<string, string | number>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await getSession(attempt > 0, signal)
      const query = encodeBilibiliWbiQuery(
        params,
        session.imgKey,
        session.subKey,
        Math.floor(now() / 1000)
      )
      const payload = await fetchJson(
        `${BILI_API_ORIGIN}${pathname}?${query}`,
        { Cookie: session.cookie },
        signal
      )
      const code = typeof payload.code === 'number' ? payload.code : -1
      if (code === 0) return payload
      if (attempt === 0 && (code === -352 || code === -412 || code === -403)) {
        cachedSession = null
        continue
      }
      throw new Error(`Bilibili API ${pathname} failed with code ${code}`)
    }
    throw new Error(`Bilibili API ${pathname} exhausted retries`)
  }

  async function fetchVideoView(bvid: string, signal?: AbortSignal): Promise<BilibiliViewData | null> {
    const session = await getSession(false, signal)
    const payload = await fetchJson(
      `${BILI_API_ORIGIN}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { Cookie: session.cookie },
      signal
    )
    if (payload.code !== 0 || !payload.data || typeof payload.data !== 'object') {
      return null
    }
    const data = payload.data as Record<string, unknown>
    const pages = Array.isArray(data.pages) ? (data.pages as Array<Record<string, unknown>>) : []
    const rawCid = pages[0]?.cid ?? data.cid
    const cid = typeof rawCid === 'number' && Number.isFinite(rawCid) && rawCid > 0 ? rawCid : 0
    if (!cid) return null

    const dimension = (pages[0]?.dimension ?? data.dimension) as Record<string, unknown> | undefined
    const width =
      typeof dimension?.width === 'number' && dimension.width > 0 ? dimension.width : null
    const height =
      typeof dimension?.height === 'number' && dimension.height > 0 ? dimension.height : null
    const durationSeconds = parseBilibiliDurationSeconds(pages[0]?.duration ?? data.duration)
    const title = typeof data.title === 'string' ? data.title.trim() : bvid

    return {
      bvid,
      cid,
      title,
      pic: normalizeHttpsUrl(data.pic),
      durationSeconds,
      width,
      height
    }
  }

  async function resolveStreamByBvid(
    bvid: string,
    quality: MediaProviderMvQuality,
    fallbackCover: string | null,
    signal?: AbortSignal
  ): Promise<MediaProviderMvStream | null> {
    const view = await fetchVideoView(bvid, signal)
    if (!view) return null

    const targetQn = targetQnForQuality(quality)
    let html5Candidate: {
      url: string
      qn: number
      width: number | null
      height: number | null
    } | null = null

    // Unauthenticated `platform=html5&high_quality=1` unlocks direct 1080p/720p progressive MP4
    // whereas unauthenticated DASH (`try_look=1`) often caps guests at 480p.
    if (targetQn >= 64) {
      try {
        const html5Payload = await callWbiApi(
          '/x/player/wbi/playurl',
          {
            bvid: view.bvid,
            cid: view.cid,
            qn: targetQn,
            fnval: 1,
            fourk: 1,
            platform: 'html5',
            high_quality: 1
          },
          signal
        )
        const html5Data = html5Payload.data as BilibiliPlayurlData | undefined
        const durlEntry = html5Data?.durl?.[0]
        const durlUrl = normalizeHttpsUrl(durlEntry?.url)
        const durlLengthMs = typeof durlEntry?.length === 'number' ? durlEntry.length : 0
        const isTruncatedPreview =
          durlLengthMs > 0 &&
          view.durationSeconds !== null &&
          view.durationSeconds > 60 &&
          durlLengthMs < 45_000
        const qn =
          typeof html5Data?.quality === 'number' && html5Data.quality > 0 ? html5Data.quality : 0
        if (durlUrl && qn > 0 && !isTruncatedPreview) {
          const dims = approximateDimensionsForQn(qn, view.width, view.height)
          html5Candidate = {
            url: durlUrl,
            qn,
            width: dims.width,
            height: dims.height
          }
        }
      } catch {
        signal?.throwIfAborted()
      }
    }

    if (html5Candidate && html5Candidate.qn >= 64 && html5Candidate.qn <= targetQn) {
      const raw: PluginMediaProviderMvResult = {
        url: html5Candidate.url,
        ...(view.pic || fallbackCover ? { coverUrl: view.pic ?? fallbackCover } : {}),
        quality: qualityLabelFromQn(html5Candidate.qn, html5Candidate.height),
        ...(html5Candidate.width ? { width: html5Candidate.width } : {}),
        ...(html5Candidate.height ? { height: html5Candidate.height } : {}),
        ...(view.durationSeconds ? { durationSeconds: view.durationSeconds } : {}),
        providerId: 'bili',
        mvId: view.bvid,
        ...(view.title ? { title: view.title } : {}),
        referer: BILI_REFERER
      }
      const protectedValue = await options.protectResult(raw, signal)
      signal?.throwIfAborted()
      return normalizeProviderMvStream(protectedValue, 'bili')
    }

    let dashCandidate: ReturnType<typeof pickDashStream> = null
    try {
      const dashPayload = await callWbiApi(
        '/x/player/wbi/playurl',
        {
          bvid: view.bvid,
          cid: view.cid,
          qn: targetQn,
          fnval: 4048,
          fourk: 1,
          otype: 'json',
          try_look: 1
        },
        signal
      )
      dashCandidate = pickDashStream(dashPayload.data as BilibiliPlayurlData | undefined, targetQn)
    } catch {
      signal?.throwIfAborted()
    }

    if (!dashCandidate && !html5Candidate) return null

    const useDash =
      dashCandidate !== null &&
      (!html5Candidate ||
        (html5Candidate.qn > targetQn && dashCandidate.qn <= targetQn) ||
        (dashCandidate.qn <= targetQn && dashCandidate.qn >= html5Candidate.qn))
    const chosenUrl = useDash ? dashCandidate!.url : html5Candidate!.url
    const chosenAudioUrl = useDash ? dashCandidate!.audioUrl : null
    const chosenQn = useDash ? dashCandidate!.qn : html5Candidate!.qn
    const fallbackDims = approximateDimensionsForQn(chosenQn, view.width, view.height)
    const chosenWidth = (useDash ? dashCandidate!.width : html5Candidate!.width) ?? fallbackDims.width
    const chosenHeight =
      (useDash ? dashCandidate!.height : html5Candidate!.height) ?? fallbackDims.height

    const raw: PluginMediaProviderMvResult = {
      url: chosenUrl,
      ...(chosenAudioUrl ? { audioUrl: chosenAudioUrl } : {}),
      ...(view.pic || fallbackCover ? { coverUrl: view.pic ?? fallbackCover } : {}),
      quality: qualityLabelFromQn(chosenQn, chosenHeight),
      ...(chosenWidth ? { width: chosenWidth } : {}),
      ...(chosenHeight ? { height: chosenHeight } : {}),
      ...(view.durationSeconds ? { durationSeconds: view.durationSeconds } : {}),
      providerId: 'bili',
      mvId: view.bvid,
      ...(view.title ? { title: view.title } : {}),
      referer: BILI_REFERER
    }
    const protectedValue = await options.protectResult(raw, signal)
    signal?.throwIfAborted()
    return normalizeProviderMvStream(protectedValue, 'bili')
  }

  return {
    async resolveTrackMv(
      track: Partial<TrackData>,
      mvOptions?: MediaProviderMvOptions,
      signal?: AbortSignal
    ): Promise<MediaProviderMvStream | null> {
      signal?.throwIfAborted()
      const quality: MediaProviderMvQuality = mvOptions?.quality ?? 'auto'

      const directBvid = extractDirectBvid(track)
      if (directBvid) {
        return resolveStreamByBvid(directBvid, quality, null, signal)
      }

      const keyword = buildSearchKeyword(track)
      if (!keyword) return null

      const searchPayload = await callWbiApi(
        '/x/web-interface/wbi/search/type',
        {
          search_type: 'video',
          keyword,
          page: 1,
          page_size: 20
        },
        signal
      )
      const searchData = searchPayload.data as Record<string, unknown> | undefined
      const results = Array.isArray(searchData?.result)
        ? (searchData.result as BilibiliSearchVideoItem[])
        : []
      const candidates = rankBilibiliMvCandidates(track, results).slice(0, 3)
      for (const candidate of candidates) {
        signal?.throwIfAborted()
        try {
          const stream = await resolveStreamByBvid(candidate.bvid, quality, candidate.pic, signal)
          if (stream) return stream
        } catch {
          signal?.throwIfAborted()
        }
      }
      return null
    }
  }
}
