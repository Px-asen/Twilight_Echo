export const QQMUSIC_PLUGIN_ID = 'com.twilightecho.provider.qqmusic'

export interface QqMusicOfficialCredential {
  musicid: string
  str_musicid: string
  musickey: string
  loginType: 1 | 2
}

export function qqMusicCredentialFromCookies(
  cookies: Array<{ name: string; value: string }>
): QqMusicOfficialCredential | null {
  const values = new Map(cookies.map((cookie) => [cookie.name, cookie.value]))
  const accountType = values.get('login_type')
  if (accountType !== '1' && accountType !== '2') return null
  const musicid = (
    values.get('qqmusic_uin') ||
    values.get(accountType === '2' ? 'wxuin' : 'uin') ||
    ''
  ).replace(/^o/, '')
  const musickey = values.get('qqmusic_key') || values.get('qm_keyst') || ''
  if (
    !/^[0-9]{1,20}$/.test(musicid) ||
    /^0+$/.test(musicid) ||
    !musickey ||
    /[;\r\n]/.test(musickey)
  ) {
    return null
  }
  return { musicid, str_musicid: musicid, musickey, loginType: accountType === '2' ? 1 : 2 }
}

export function isQqMusicLoginUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (['y.qq.com', 'graph.qq.com', 'open.weixin.qq.com', 'ssl.ptlogin2.graph.qq.com'].includes(
        url.hostname
      ) ||
        url.hostname.endsWith('.ptlogin2.qq.com'))
    )
  } catch {
    return false
  }
}
