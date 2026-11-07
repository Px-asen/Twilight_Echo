import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseWindowsFontFamilies,
  listInstalledFontFamilies,
  createFontFamilyLoader,
  repairShiftJisGbkMojibake,
  extractFontFamiliesFromFile
} from './fontRegistry.ts'

test('font loader shares one pending query and caches the successful catalog', async () => {
  let calls = 0
  let complete!: (fonts: string[]) => void
  const loader = createFontFamilyLoader(() => {
    calls++
    return new Promise((resolve) => {
      complete = resolve
    })
  })
  const first = loader.list()
  const second = loader.list()
  await Promise.resolve()
  assert.equal(calls, 1)
  complete(['宋体', 'Segoe UI'])
  assert.deepEqual(await first, ['宋体', 'Segoe UI'])
  assert.deepEqual(await second, ['宋体', 'Segoe UI'])
  assert.deepEqual(await loader.list(), ['宋体', 'Segoe UI'])
  assert.equal(calls, 1)
})

test('font loader retries a failed or empty query rather than caching absence', async () => {
  let calls = 0
  const loader = createFontFamilyLoader(async () => {
    calls++
    if (calls === 1) throw new Error('cold registry startup timed out')
    return calls === 2 ? [] : ['宋体']
  })
  assert.deepEqual(await loader.list(), [])
  assert.deepEqual(await loader.list(), [])
  assert.deepEqual(await loader.list(), ['宋体'])
  assert.deepEqual(await loader.list(), ['宋体'])
  assert.equal(calls, 3)
})

test('clearing during a font query cannot replace a newer catalog with stale results', async () => {
  const completions: Array<(fonts: string[]) => void> = []
  const loader = createFontFamilyLoader(() => new Promise((resolve) => completions.push(resolve)))
  const first = loader.list()
  await Promise.resolve()
  loader.clear()
  const second = loader.list()
  await Promise.resolve()
  completions[1]!(['Segoe UI'])
  await second
  completions[0]!(['Old font'])
  await first
  assert.deepEqual(await loader.list(), ['Segoe UI'])
})

test(
  'Windows font registry uses Unicode names without replacement characters',
  { skip: process.platform !== 'win32' },
  async () => {
    let fonts = await listInstalledFontFamilies()
    // A busy Windows runner may time out the first PowerShell startup; the API permits retry.
    if (fonts.length === 0) fonts = await listInstalledFontFamilies()
    assert.ok(fonts.length > 0)
    assert.ok(fonts.every((font) => !font.includes('\ufffd')))
  }
)

const REGISTRY_SAMPLE = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  '    Arial (TrueType)    REG_SZ    arial.ttf',
  '    Arial Bold (TrueType)    REG_SZ    arialbd.ttf',
  '    Arial Bold Italic (TrueType)    REG_SZ    arialbi.ttf',
  '    Segoe UI Semibold (TrueType)    REG_SZ    segoeuisb.ttf',
  '    宋体 & 新宋体 & 仿宋 (TrueType)    REG_SZ    simsun.ttc',
  // Windows registers the vertical-writing alias alongside the real family.
  '    Microsoft YaHei & Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc',
  '    @Microsoft YaHei & @Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc',
  '    Cascadia Mono (OpenType)    REG_SZ    CascadiaMono.ttf',
  ''
].join('\r\n')

test('parseWindowsFontFamilies collapses styles into one family entry', () => {
  const families = parseWindowsFontFamilies(REGISTRY_SAMPLE)

  assert.equal(
    families.filter((family) => family === 'Arial').length,
    1,
    'Arial, Arial Bold and Arial Bold Italic are one family'
  )
  assert.ok(families.includes('Segoe UI'), 'Semibold is a weight, not a family')
  assert.ok(families.includes('Cascadia Mono'), 'OpenType tag is stripped like TrueType')
})

test('parseWindowsFontFamilies splits localized aliases and drops vertical variants', () => {
  const families = parseWindowsFontFamilies(REGISTRY_SAMPLE)

  for (const family of ['宋体', '新宋体', '仿宋']) {
    assert.ok(families.includes(family), `${family} is registered under a shared value`)
  }
  assert.ok(
    !families.some((family) => family.startsWith('@')),
    '@-prefixed vertical writing aliases duplicate an existing family'
  )
  assert.ok(families.includes('Microsoft YaHei'), 'the family behind the @ alias still resolves')
})

test('parseWindowsFontFamilies returns a sorted, deduplicated list', () => {
  const families = parseWindowsFontFamilies(
    [
      '    Verdana (TrueType)    REG_SZ    verdana.ttf',
      '    Calibri (TrueType)    REG_SZ    calibri.ttf',
      '    Verdana Italic (TrueType)    REG_SZ    verdanai.ttf'
    ].join('\n')
  )

  assert.deepEqual(families, ['Calibri', 'Verdana'])
})

test('parseWindowsFontFamilies ignores registry chrome and malformed rows', () => {
  const families = parseWindowsFontFamilies(
    [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      '',
      'ERROR: The system was unable to find the specified registry key or value.',
      '    (TrueType)    REG_SZ    orphan.ttf',
      '    Tahoma (TrueType)    REG_SZ    tahoma.ttf'
    ].join('\n')
  )

  assert.deepEqual(families, ['Tahoma'])
})

test('parseWindowsFontFamilies keeps a style-only name rather than dropping it', () => {
  // "Bold" as an entire family name must survive: stripping it would leave an
  // empty string and silently lose the font.
  const families = parseWindowsFontFamilies('    Bold (TrueType)    REG_SZ    bold.ttf')

  assert.deepEqual(families, ['Bold'])
})

test('parseWindowsFontFamilies retains more than 600 families without truncating English fonts after M', () => {
  const lines: string[] = []
  for (let i = 0; i < 650; i++) {
    lines.push(`    中文字体${String(i).padStart(4, '0')} (TrueType)    REG_SZ    zh${i}.ttf`)
  }
  lines.push('    Microsoft JhengHei UI (TrueType)    REG_SZ    msjh.ttc')
  lines.push('    Segoe Print (TrueType)    REG_SZ    segoepr.ttf')
  lines.push('    Source Han Sans JP (OpenType)    REG_SZ    SourceHanSansJP.otf')
  lines.push('    Yu Gothic (TrueType)    REG_SZ    YuGothR.ttc')
  lines.push('    Symbol (TrueType)    REG_SZ    symbol.ttf')

  const families = parseWindowsFontFamilies(lines.join('\r\n'))
  assert.equal(families.length, 655)
  for (const expected of [
    'Microsoft JhengHei UI',
    'Segoe Print',
    'Source Han Sans JP',
    'Yu Gothic',
    'Symbol'
  ]) {
    assert.ok(families.includes(expected), `expected ${expected} not to be truncated`)
  }
})

test('parseWindowsFontFamilies repairs Shift-JIS-as-GBK mojibake and strips OpenType Pro/Std weight suffixes', () => {
  assert.equal(repairShiftJisGbkMojibake('FOT-拀巼柧挬 Pro M'), 'FOT-筑紫明朝 Pro M')
  assert.equal(repairShiftJisGbkMojibake('宋体'), '宋体')
  assert.equal(repairShiftJisGbkMojibake('微软雅黑'), '微软雅黑')

  const families = parseWindowsFontFamilies(
    [
      '    FOT-拀巼柧挬 Pro M (OpenType)    REG_SZ    FOT-TsukuMinPro-M.otf',
      '    FOT-TsukuMin Pro M (OpenType)    REG_SZ    FOT-TsukuMinPro-M.otf',
      '    A-OTF Shin Go Pro DB (OpenType)    REG_SZ    A-OTF-ShinGoPro-DeBold.otf'
    ].join('\r\n')
  )

  assert.ok(families.includes('FOT-筑紫明朝 Pro'))
  assert.ok(families.includes('FOT-TsukuMin Pro'))
  assert.ok(families.includes('A-OTF Shin Go Pro'))
  assert.ok(!families.includes('FOT-拀巼柧挬 Pro M'))
  assert.ok(!families.includes('FOT-TsukuMin Pro M'))
})

test('extractFontFamiliesFromFile prefers OpenType Name ID 16 typographic family over GDI per-weight Name ID 1', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-font-test-'))
  try {
    const fontPath = path.join(tmpDir, 'FOT-TsukuMinPro-M.otf')
    const encodeUtf16Be = (text: string): Buffer => {
      const buf = Buffer.allocUnsafe(text.length * 2)
      for (let i = 0; i < text.length; i++) {
        buf.writeUInt16BE(text.charCodeAt(i), i * 2)
      }
      return buf
    }
    // Padded Shift-JIS for "FOT-筑紫明朝 Pro": ASCII with 0x00 high byte + Shift-JIS 2-byte kanji
    const paddedSjisJa = Buffer.from([
      0x00, 0x46, 0x00, 0x4f, 0x00, 0x54, 0x00, 0x2d, 0x92, 0x7d, 0x8e, 0x87, 0x96, 0xbe, 0x92,
      0xa9, 0x00, 0x20, 0x00, 0x50, 0x00, 0x72, 0x00, 0x6f
    ])
    const records = [
      { platformId: 3, encodingId: 1, languageId: 0x0409, nameId: 1, data: encodeUtf16Be('FOT-TsukuMin Pro M') },
      { platformId: 3, encodingId: 1, languageId: 0x0409, nameId: 16, data: encodeUtf16Be('FOT-TsukuMin Pro') },
      { platformId: 3, encodingId: 2, languageId: 0x0411, nameId: 16, data: paddedSjisJa }
    ]

    const stringPool = Buffer.concat(records.map((r) => r.data))
    const nameHeader = Buffer.alloc(6 + records.length * 12)
    nameHeader.writeUInt16BE(0, 0)
    nameHeader.writeUInt16BE(records.length, 2)
    nameHeader.writeUInt16BE(nameHeader.length, 4)
    let strOffset = 0
    records.forEach((rec, idx) => {
      const off = 6 + idx * 12
      nameHeader.writeUInt16BE(rec.platformId, off)
      nameHeader.writeUInt16BE(rec.encodingId, off + 2)
      nameHeader.writeUInt16BE(rec.languageId, off + 4)
      nameHeader.writeUInt16BE(rec.nameId, off + 6)
      nameHeader.writeUInt16BE(rec.data.length, off + 8)
      nameHeader.writeUInt16BE(strOffset, off + 10)
      strOffset += rec.data.length
    })
    const nameTable = Buffer.concat([nameHeader, stringPool])

    const sfntHeader = Buffer.alloc(12 + 16)
    sfntHeader.write('OTTO', 0, 'ascii')
    sfntHeader.writeUInt16BE(1, 4)
    sfntHeader.write('name', 12, 'ascii')
    sfntHeader.writeUInt32BE(0, 16)
    sfntHeader.writeUInt32BE(28, 20)
    sfntHeader.writeUInt32BE(nameTable.length, 24)

    fs.writeFileSync(fontPath, Buffer.concat([sfntHeader, nameTable]))

    const extracted = extractFontFamiliesFromFile(fontPath)
    assert.deepEqual(extracted.sort(), ['FOT-TsukuMin Pro', 'FOT-筑紫明朝 Pro'].sort())

    const parsed = parseWindowsFontFamilies(
      `    FOT-拀巼柧挬 Pro M (OpenType)    REG_SZ    ${fontPath}`,
      { resolveFileFamilies: (file) => extractFontFamiliesFromFile(file) }
    )
    assert.deepEqual(new Set(parsed), new Set(['FOT-TsukuMin Pro', 'FOT-筑紫明朝 Pro']))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
