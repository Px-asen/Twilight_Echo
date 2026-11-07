import assert from 'node:assert/strict'
import test from 'node:test'
import { isQqMusicLoginUrl, qqMusicCredentialFromCookies } from './qqmusicLogin.ts'

test('official QQ cookies yield only the music credential and its web account type', () => {
  const credential = qqMusicCredentialFromCookies([
    { name: 'qqmusic_uin', value: '123456' },
    { name: 'qqmusic_key', value: 'music-test' },
    { name: 'login_type', value: '1' },
    { name: 'p_skey', value: 'must-stay-in-browser' }
  ])
  assert.deepEqual(credential, {
    musicid: '123456',
    str_musicid: '123456',
    musickey: 'music-test',
    loginType: 2
  })
})

test('official WeChat music cookies retain the exact account ID', () => {
  const id = '1152921504606846977'
  assert.deepEqual(
    qqMusicCredentialFromCookies([
      { name: 'wxuin', value: id },
      { name: 'qm_keyst', value: 'wechat-test' },
      { name: 'login_type', value: '2' }
    ]),
    { musicid: id, str_musicid: id, musickey: 'wechat-test', loginType: 1 }
  )
})

test('partial or invalid cookies do not close the official login window as a success', () => {
  for (const changes of [
    { qqmusic_key: '' },
    { login_type: '' },
    { login_type: '0' },
    { qqmusic_uin: '0' },
    { qqmusic_uin: '1e20' },
    { qqmusic_key: 'bad;cookie' }
  ]) {
    assert.equal(
      qqMusicCredentialFromCookies(
        Object.entries({
          qqmusic_uin: '123456',
          qqmusic_key: 'test',
          login_type: '1',
          ...changes
        }).map(([name, value]) => ({ name, value }))
      ),
      null
    )
  }
})

test('official login keeps navigation on its HTTPS music and authorization origins', () => {
  for (const url of [
    'https://y.qq.com/n/ryqq/',
    'https://graph.qq.com/oauth2.0/authorize',
    'https://xui.ptlogin2.qq.com/cgi-bin/xlogin',
    'https://ssl.ptlogin2.graph.qq.com/check_sig',
    'https://open.weixin.qq.com/connect/qrconnect'
  ])
    assert.equal(isQqMusicLoginUrl(url), true, url)
  for (const url of [
    'http://y.qq.com/',
    'https://y.qq.com.evil.test/',
    'https://other.qq.com/',
    'https://user:password@y.qq.com/',
    'file:///tmp/test',
    'invalid'
  ]) {
    assert.equal(isQqMusicLoginUrl(url), false, url)
  }
})
