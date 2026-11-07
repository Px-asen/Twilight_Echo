const assert = require('node:assert/strict')
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const {
  generateKeyPairSync,
  publicEncrypt,
  constants,
  createDecipheriv,
  sign
} = require('node:crypto')
const { createRequire } = require('node:module')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  PNPM_PACKAGE_MANAGER,
  resolveBundledCorepackScript
} = require('./verify-production-dependency-audit.cjs')

const candidate = process.env.TWILIGHT_AUDIT_INTEGRATION_CANDIDATE
const candidateRoot = candidate ? resolve(candidate) : resolve(__dirname, '..')
const candidateRequire = createRequire(join(candidateRoot, 'package.json'))
const { assertNodeForgeVersion } = require('./verify-install-policy.cjs')

// Official PR #1152 vector at ceba34402e329f0365134f23fe19898756527d65.
// The upstream test bypasses padding checks to isolate nested DigestAlgorithm
// validation; normal signatures below use the default strict verification.
const FORGE_ATTACK = {
  modulus: [
    'E932AC92252F585B3A80A4DD76A897C8B7652952FE788F6EC8DD640587A1EE56',
    '47670A8AD4C2BE0F9FA6E49C605ADF77B5174230AF7BD50E5D6D6D6D28CCF0A8',
    '86A514CC72E51D209CC772A52EF419F6A953F3135929588EBE9B351FCA61CED7',
    '8F346FE00DBB6306E5C2A4C6DFC3779AF85AB417371CF34D8387B9B30AE46D7A',
    '5FF5A655B8D8455F1B94AE736989D60A6F2FD5CADBFFBD504C5A756A2E6BB5CE',
    'CC13BCA7503F6DF8B52ACE5C410997E98809DB4DC30D943DE4E812A47553DCE5',
    '4844A78E36401D13F77DC650619FED88D8B3926E3D8E319C80C744779AC5D6AB',
    'E252896950917476ECE5E8FC27D5F053D6018D91B502C4787558A002B9283DA7'
  ].join(''),
  signature: [
    'a4ae63dd5e7712b78f4870d0f51e294df5503d4f16c5d27ae33370981fb57f0de49f',
    '50f3d6a04666774cd984cd13972db9bf8e12bd294ef0ddc916c7c86cbae63efd7b6b',
    '97885e69760c208a40f1aecc76a90d7af5145177efce1bb55807a8d05c20b1596753',
    'ba710642fc9acdde6c160232654662c77cc4466c8257a38edb49f894e8845d0fd987',
    'b857ced88f4b62505a080bd87ef700d35d392a6e8f6fde34250c50b86fae606cb551',
    '215e8f4813239b77651d5565ad453698c071d48c31e8e526fb4a37610f64b3e1fb8e',
    '5be5898e408ad08197a0947794a530b54f84485377ce4a7488ed485ce4e5e105dd89',
    '698a472f390c3b1b76bc16b73276c4d1c81d'
  ].join('')
}

test('installed node-forge rejects the upstream nested DigestAlgorithm attack accepted without the fix', () => {
  assertNodeForgeVersion(candidateRoot)
  const forge = candidateRequire('node-forge')
  const rsaPath = candidateRequire.resolve('node-forge/lib/rsa.js')
  const key = forge.pki.rsa.setPublicKey(
    new forge.jsbn.BigInteger(FORGE_ATTACK.modulus, 16),
    new forge.jsbn.BigInteger('3')
  )
  const digest = forge.md.sha256.create().update('hello world!').digest().getBytes()
  assert.throws(
    () =>
      key.verify(digest, forge.util.hexToBytes(FORGE_ATTACK.signature), undefined, {
        _parseAllDigestBytes: true,
        _skipPaddingChecks: true
      }),
    /ASN\.1 object does not contain a valid RSASSA-PKCS1-v1_5 DigestInfo value/
  )

  // Remove only the upstream canonical DER check in an isolated child module, never on disk or
  // in the application's module cache, to prove the attack fixture is useful.
  const controlScript = `(${function (rsaPath, attack) {
    const assert = require('node:assert/strict')
    const { readFileSync } = require('node:fs')
    const Module = require('node:module')
    const { dirname } = require('node:path')
    const forge = require('node-forge')
    const patched = readFileSync(rsaPath, 'utf8')
    const unpatched = patched.replace(
      /if\(d\.substring\(0, withParameters\.length\) !== withParameters &&\s*d\.substring\(0, withoutParameters\.length\) !== withoutParameters\)/,
      'if(false)'
    )
    assert.notEqual(unpatched, patched, 'control must remove exactly the canonical DER check')
    const control = new Module(rsaPath)
    control.filename = rsaPath
    control.paths = Module._nodeModulePaths(dirname(rsaPath))
    control._compile(unpatched, rsaPath)
    const key = forge.pki.rsa.setPublicKey(
      new forge.jsbn.BigInteger(attack.modulus, 16),
      new forge.jsbn.BigInteger('3')
    )
    const digest = forge.md.sha256.create().update('hello world!').digest().getBytes()
    assert.equal(
      key.verify(digest, forge.util.hexToBytes(attack.signature), undefined, {
        _parseAllDigestBytes: true,
        _skipPaddingChecks: true
      }),
      true
    )
    console.log('unpatched-control-accepted')
  }.toString()})(${JSON.stringify(rsaPath)}, ${JSON.stringify(FORGE_ATTACK)})`
  const control = spawnSync(process.execPath, ['-e', controlScript], {
    cwd: candidateRoot,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  })
  assert.equal(control.error, undefined, control.error?.message)
  assert.equal(control.status, 0, `${control.stdout}\n${control.stderr}`)
  assert.match(control.stdout, /unpatched-control-accepted/)
})

test('fixed node-forge retains strict valid signatures and optional NULL algorithm parameters', () => {
  const forge = candidateRequire('node-forge')
  const keys = generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 65537 })
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const publicKey = forge.pki.publicKeyFromPem(pem)
  const message = 'TwilightEcho signature compatibility'
  const digest = forge.md.sha256.create().update(message).digest().getBytes()
  const signature = sign('sha256', Buffer.from(message), keys.privateKey)
  assert.equal(publicKey.verify(digest, signature.toString('binary')), true)
  assert.equal(
    publicKey.verify(
      forge.md.sha256.create().update('different').digest().getBytes(),
      signature.toString('binary')
    ),
    false
  )

  const asn1 = forge.asn1
  const digestInfo = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
      asn1.create(
        asn1.Class.UNIVERSAL,
        asn1.Type.OID,
        false,
        asn1.oidToDer(forge.pki.oids.sha256).getBytes()
      )
    ]),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest)
  ])
  const privateKey = forge.pki.privateKeyFromPem(
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
  )
  const withoutNull = privateKey.sign(asn1.toDer(digestInfo).getBytes(), 'NONE')
  assert.equal(publicKey.verify(digest, withoutNull), true)
})

test('NCM real encryption retains weapi RSA NONE and AES/eapi/linuxapi payloads', () => {
  const ncmPath = candidateRequire.resolve('@neteasecloudmusicapienhanced/api/util/crypto.js')
  const ncmRequire = createRequire(ncmPath)
  assert.equal(ncmRequire.resolve('node-forge'), candidateRequire.resolve('node-forge'))
  const ncm = candidateRequire(ncmPath)
  const payload = { ids: [101, 202], text: 'TwilightEcho 音乐 & <metadata>', enabled: true }
  const originalRandom = Math.random
  let weapi
  Math.random = () => 0
  try {
    weapi = ncm.weapi(payload)
  } finally {
    Math.random = originalRandom
  }
  const secret = 'aaaaaaaaaaaaaaaa'
  function decodeAes(bytes, key, mode = 'cbc') {
    const cipher = createDecipheriv(
      `aes-128-${mode}`,
      Buffer.from(key),
      mode === 'ecb' ? null : Buffer.from('0102030405060708')
    )
    return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8')
  }
  const inner = decodeAes(Buffer.from(weapi.params, 'base64'), secret)
  assert.deepEqual(JSON.parse(decodeAes(Buffer.from(inner, 'base64'), '0CoJUm6Qyw8W8jud')), payload)
  const pem =
    '-----BEGIN PUBLIC KEY-----\nMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB\n-----END PUBLIC KEY-----'
  assert.equal(
    weapi.encSecKey,
    publicEncrypt(
      { key: pem, padding: constants.RSA_NO_PADDING },
      Buffer.concat([Buffer.alloc(112), Buffer.from(secret)])
    ).toString('hex')
  )
  assert.deepEqual(ncm.eapiReqDecrypt(ncm.eapi('/api/song/detail', payload).params), {
    url: '/api/song/detail',
    data: payload
  })
  assert.deepEqual(
    JSON.parse(
      decodeAes(Buffer.from(ncm.linuxapi(payload).eparams, 'hex'), 'rFgB&h#%2?^eDg:Q', 'ecb')
    ),
    payload
  )
})

test(
  'production audit starts from a real pinned pnpm process in an isolated candidate',
  { skip: !candidate && 'set TWILIGHT_AUDIT_INTEGRATION_CANDIDATE to run this integration test' },
  () => {
    const candidateRoot = resolve(candidate)
    const corepackScript = resolveBundledCorepackScript()
    assert.ok(corepackScript, 'the active Node runtime must provide Corepack')
    assert.ok(
      existsSync(join(candidateRoot, 'package.json')),
      'candidate must contain package.json'
    )
    const forbiddenCandidateOutputPath = join(
      candidateRoot,
      'output',
      'production-dependency-audit.integration.json'
    )
    assert.equal(
      existsSync(forbiddenCandidateOutputPath),
      false,
      'candidate source scope must start without integration audit output'
    )

    const outputRoot = mkdtempSync(join(tmpdir(), 'twilight-production-audit-'))
    const outputPath = join(outputRoot, 'production-dependency-audit.integration.json')
    try {
      const outputFromCandidate = relative(candidateRoot, outputRoot)
      assert.ok(
        outputFromCandidate === '..' ||
          outputFromCandidate.startsWith(`..${sep}`) ||
          isAbsolute(outputFromCandidate),
        'integration audit output root must be outside the candidate source scope'
      )
      const result = spawnSync(
        process.execPath,
        [
          corepackScript,
          PNPM_PACKAGE_MANAGER,
          'run',
          'audit:production',
          '--',
          '--output',
          outputPath
        ],
        { cwd: candidateRoot, encoding: 'utf8', timeout: 240_000, windowsHide: true }
      )

      assert.equal(result.error, undefined, result.error?.message)
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
      assert.match(result.stdout, /Production dependency audit passed/)
      assert.ok(existsSync(outputPath), 'the real candidate audit must emit its JSON report')
      const report = JSON.parse(readFileSync(outputPath, 'utf8'))
      // metadata.vulnerabilities keeps the raw registry totals even when
      // auditConfig.ignoreGhsas filters advisories; the gate counts the filtered
      // advisories map, so that is what the candidate report must prove empty.
      assert.deepEqual(Object.keys(report.advisories ?? {}), [])
    } finally {
      rmSync(outputRoot, { recursive: true, force: true })
      assert.equal(existsSync(outputPath), false, 'integration audit output must be removed')
      assert.equal(existsSync(outputRoot), false, 'integration audit temp root must be removed')
      assert.equal(
        existsSync(forbiddenCandidateOutputPath),
        false,
        'integration audit must not add output to the candidate source scope'
      )
    }
  }
)
