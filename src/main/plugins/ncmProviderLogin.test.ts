import assert from 'node:assert/strict'
import test from 'node:test'

type NcmRequest = {
  path: string
  cookie?: string
}

function queryValue(path: string, key: string): string | null {
  const queryStart = path.indexOf('?')
  if (queryStart < 0) return null
  const params = new URLSearchParams(path.slice(queryStart + 1))
  return params.get(key)
}

interface TestNcmProvider {
  ui: { authType: string; loginExtraActions?: unknown[] }
  checkLogin(): Promise<{ loggedIn: boolean; profile: { userId: number } | null }>
  logout(): Promise<void>
  openOfficialLogin(context?: { signal: AbortSignal }): Promise<unknown>
  getQrKey(): Promise<unknown>
  getQrImage(key: string): Promise<unknown>
  checkQrLogin(key: string): Promise<{ code: number; message?: string }>
  sendCaptcha(phone: string, countrycode?: string): Promise<{ code: number; message?: string }>
  loginByPhonePassword(
    phone: string,
    password: string,
    countrycode?: string
  ): Promise<{ loggedIn: boolean; profile: unknown }>
  loginByPhoneCaptcha(
    phone: string,
    captcha: string,
    countrycode?: string
  ): Promise<{ loggedIn: boolean; profile: unknown }>
  loginByEmailPassword(
    email: string,
    password: string
  ): Promise<{ loggedIn: boolean; profile: unknown }>
  searchSongs(keywords: string): Promise<unknown>
  getPlaybackUrl(
    track: unknown,
    options?: { force?: boolean; quality?: string }
  ): Promise<string | null>
}

test('saved NCM sessions survive host restart and status failures remain retryable', async (t) => {
  const module = await import(new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href)
  t.after(() => module.deactivate())
  let provider!: TestNcmProvider
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=saved-account']])
  const profile = { userId: 42, nickname: 'Saved account', signature: '', follows: 0, followeds: 0 }
  let response: unknown = { data: { code: 200, profile } }
  const context = {
    twilight: {
      internal: { ncm: { request: async (_path: string, cookie: string) => {
        assert.equal(cookie, 'MUSIC_U=saved-account')
        if (response instanceof Error) throw response
        return response
      } } },
      providers: { register: (value: TestNcmProvider) => { provider = value } }
    },
    settings: { get: (key: string) => settings.get(key),
      set: (key: string, value: unknown) => settings.set(key, value),
      delete: (key: string) => settings.delete(key) },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  }
  await module.activate(context)
  assert.equal((await provider.checkLogin()).profile?.userId, 42)
  module.deactivate()
  await module.activate(context)
  assert.equal((await provider.checkLogin()).loggedIn, true)

  for (const failure of [new Error('fetch failed'), { code: 503 }, { code: 460 }, { code: 200 }]) {
    module.deactivate()
    await module.activate(context)
    response = failure
    await assert.rejects(provider.checkLogin())
    assert.equal(settings.get('cookie'), 'MUSIC_U=saved-account')
    response = { data: { code: 200, profile } }
    assert.equal((await provider.checkLogin()).profile?.userId, 42, 'retry uses the saved credential')
  }
  for (const signedOut of [{ data: { code: 200, profile: null } }, { code: 301 }]) {
    module.deactivate()
    await module.activate(context)
    response = signedOut
    assert.deepEqual(await provider.checkLogin(), { loggedIn: false, profile: null })
  }
})

test('official NCM login saves a verified account and discards a cancelled browser result', async (t) => {
  const module = await import(new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href)
  t.after(() => module.deactivate())
  let provider!: TestNcmProvider
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=previous']])
  let finishBrowser!: (cookie: string) => void
  let receivedSignal: AbortSignal | undefined
  await module.activate({
    twilight: {
      internal: { ncm: {
        officialLogin: ({ signal }: { signal?: AbortSignal }) => {
          receivedSignal = signal
          return new Promise<string>(resolve => { finishBrowser = resolve })
        },
        request: async (path: string, cookie: string) => {
          assert.equal(cookie, 'MUSIC_U=official-test')
          if (path.startsWith('/login/status')) return { code: 200, profile: { userId: 123, nickname: 'Official' } }
          assert.ok(path.startsWith('/user/detail'))
          return { code: 200, profile: { signature: '', follows: 0, followeds: 0 } }
        }
      } },
      providers: { register: (value: TestNcmProvider) => { provider = value } }
    },
    settings: { get: (key: string) => settings.get(key),
      set: (key: string, value: unknown) => settings.set(key, value),
      delete: (key: string) => settings.delete(key) },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  })
  const controller = new AbortController()
  const cancelled = provider.openOfficialLogin({ signal: controller.signal })
  assert.equal(receivedSignal, controller.signal)
  controller.abort()
  finishBrowser('MUSIC_U=cancelled')
  await assert.rejects(cancelled, { name: 'AbortError' })
  assert.equal(settings.get('cookie'), 'MUSIC_U=previous')
  const login = provider.openOfficialLogin()
  finishBrowser('MUSIC_U=official-test')
  const result = await login as { loggedIn: boolean; profile: { userId: number } }
  assert.equal(result.loggedIn, true)
  assert.equal(result.profile.userId, 123)
  assert.equal(settings.get('cookie'), 'MUSIC_U=official-test')
})

test('bundled NCM provider follows documented QR login request params', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=test-token']])

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/qr/key')) {
              return { code: 200, data: { unikey: 'qr-key' } }
            }
            if (path.startsWith('/login/qr/create')) {
              return { code: 200, data: { qrimg: 'data:image/png;base64,test' } }
            }
            if (path.startsWith('/login/qr/check')) {
              return { code: 801 }
            }
            if (path.startsWith('/cloudsearch')) {
              return { code: 200, result: { songs: [], songCount: 0 } }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.ok(registeredProvider.current)
  const provider = registeredProvider.current
  assert.equal(provider.ui.authType, 'qr')
  assert.deepEqual(provider.ui.loginExtraActions, [
    { label: '使用官方网页登录', icon: 'pi pi-external-link', method: 'openOfficialLogin', primary: true }
  ])
  assert.equal(typeof provider.openOfficialLogin, 'function')

  await provider.getQrKey()
  await provider.getQrImage('qr-key')
  await provider.checkQrLogin('qr-key')

  const loginRequests = requests.filter((request) => request.path.startsWith('/login/qr/'))
  assert.equal(loginRequests.length, 3)
  assert.equal(queryValue(loginRequests[1].path, 'platform'), 'pc', loginRequests[1].path)
  for (const request of loginRequests) {
    assert.match(queryValue(request.path, 'ua') ?? '', /NeteaseMusicDesktop\//)
    assert.equal(queryValue(request.path, 'crypto'), 'eapi')
    assert.equal(request.path.includes('chainId='), false, request.path)
  }
  assert.equal(new Set(loginRequests.map(({ path }) => queryValue(path, 'ua'))).size, 1)

  await provider.searchSongs('hello')
  const searchRequest = requests.find((request) => request.path.startsWith('/cloudsearch'))
  assert.ok(searchRequest)
  assert.match(
    queryValue(searchRequest.path, 'ua') ?? '',
    /Chrome\/123\.0\.0\.0/,
    searchRequest.path
  )

  await provider.getPlaybackUrl({ id: 'ncm:1' })
  const playbackRequest = requests.find((request) => request.path.startsWith('/song/url'))
  assert.ok(playbackRequest)
  assert.equal(queryValue(playbackRequest.path, 'ua'), null, playbackRequest.path)

  providerModule.deactivate()
})

test('bundled NCM provider falls back when the preferred playback endpoint fails', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=test-token']])

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/song/url/v1') && path.includes('level=hires')) {
              throw new Error('preferred level unavailable')
            }
            if (path.startsWith('/song/url/v1') && path.includes('level=lossless')) {
              return {
                code: 200,
                data: [{ id: 2609824992, url: 'https://music.example/song.mp3', br: 320000 }]
              }
            }
            return { code: 200, data: [] }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.equal(
    await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:2609824992' }),
    'https://music.example/song.mp3'
  )
  assert.equal(requests.length, 2)
  assert.equal(requests[0].path.includes('level=hires'), true, requests[0].path)
  assert.equal(requests[1].path.includes('level=lossless'), true, requests[1].path)

  await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:2609824992' })
  assert.equal(requests.length, 2)

  providerModule.deactivate()
})

test('bundled NCM provider sends captcha with phone and country code', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/captcha/sent')) return { code: 200, data: true }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const result = await registeredProvider.current?.sendCaptcha('13800138000', '86')
  assert.equal(result?.code, 200)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path.startsWith('/captcha/sent?'), true, requests[0].path)
  assert.equal(queryValue(requests[0].path, 'phone'), '13800138000')
  assert.equal(queryValue(requests[0].path, 'ctcode'), '86')

  providerModule.deactivate()
})

test('bundled NCM provider logs in with phone password and stores returned cookie', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/cellphone')) {
              return { code: 200, cookie: 'MUSIC_U=phone-token;__csrf=csrf-token' }
            }
            if (path.startsWith('/login/status')) {
              return {
                code: 200,
                data: {
                  code: 200,
                  profile: { userId: 1001, nickname: 'phone-user', avatarUrl: 'avatar.jpg' }
                }
              }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const login = await registeredProvider.current?.loginByPhonePassword(
    '13800138000',
    'p@ss#word',
    '86'
  )
  assert.equal(login?.loggedIn, true)
  const loginRequest = requests.find((request) => request.path.startsWith('/login/cellphone'))
  assert.ok(loginRequest)
  assert.equal(queryValue(loginRequest.path, 'phone'), '13800138000')
  assert.equal(queryValue(loginRequest.path, 'countrycode'), '86')
  assert.equal(queryValue(loginRequest.path, 'password'), 'p@ss#word')
  assert.equal(settings.get('cookie'), 'MUSIC_U=phone-token;__csrf=csrf-token')

  providerModule.deactivate()
})

test('bundled NCM provider logs in with phone captcha and email password', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/cellphone') && queryValue(path, 'captcha') === '246810') {
              return { code: 200, cookie: 'MUSIC_U=captcha-token' }
            }
            if (path.startsWith('/login?')) {
              return { code: 200, cookie: 'MUSIC_U=email-token' }
            }
            if (path.startsWith('/login/status')) {
              return {
                code: 200,
                data: {
                  code: 200,
                  profile: { userId: 1002, nickname: 'login-user', avatarUrl: 'avatar.jpg' }
                }
              }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const captchaLogin = await registeredProvider.current?.loginByPhoneCaptcha(
    '13800138000',
    '246810',
    '86'
  )
  assert.equal(captchaLogin?.loggedIn, true)
  const captchaRequest = requests.find(
    (request) => queryValue(request.path, 'captcha') === '246810'
  )
  assert.ok(captchaRequest)
  assert.equal(queryValue(captchaRequest.path, 'phone'), '13800138000')
  assert.equal(settings.get('cookie'), 'MUSIC_U=captcha-token')

  const emailLogin = await registeredProvider.current?.loginByEmailPassword(
    'user@example.com',
    'email-password'
  )
  assert.equal(emailLogin?.loggedIn, true)
  const emailRequest = requests.find((request) => request.path.startsWith('/login?'))
  assert.ok(emailRequest)
  assert.equal(queryValue(emailRequest.path, 'email'), 'user@example.com')
  assert.equal(queryValue(emailRequest.path, 'password'), 'email-password')
  assert.equal(settings.get('cookie'), 'MUSIC_U=email-token')

  providerModule.deactivate()
})

test('bundled NCM provider saves the QR session, restores its profile and logs out', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/qr/check')) {
              return { code: 803, cookie: 'MUSIC_U=qr-token;__csrf=csrf-token' }
            }
            if (path.startsWith('/login/status')) {
              return {
                code: 200,
                data: {
                  code: 200,
                  profile: { userId: 1001, nickname: 'qr-user', avatarUrl: 'avatar.jpg' }
                }
              }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const provider = registeredProvider.current
  assert.ok(provider)
  assert.equal((await provider.checkQrLogin('qr-key')).code, 803)
  assert.equal(settings.get('cookie'), 'MUSIC_U=qr-token;__csrf=csrf-token')
  const state = await provider.checkLogin()
  assert.equal(state.loggedIn, true)
  assert.equal(state.profile?.userId, 1001)
  const statusRequest = requests.find((request) => request.path.startsWith('/login/status'))
  assert.equal(statusRequest?.cookie, 'MUSIC_U=qr-token;__csrf=csrf-token')

  await provider.logout()
  assert.equal(settings.has('cookie'), false)
  assert.deepEqual(await provider.checkLogin(), { loggedIn: false, profile: null })
  providerModule.deactivate()
})

test('bundled NCM provider retries QR checks without cookies after API 502', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            if (path.startsWith('/login/qr/check') && !path.includes('noCookie=true')) {
              return { code: 502, message: 'bad gateway' }
            }
            if (path.startsWith('/login/qr/check') && path.includes('noCookie=true')) {
              return { code: 801 }
            }
            return { code: 200 }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.equal((await registeredProvider.current?.checkQrLogin('qr-key'))?.code, 801)
  assert.equal(requests.length, 2)
  assert.equal(queryValue(requests[0].path, 'noCookie'), null)
  assert.equal(queryValue(requests[1].path, 'noCookie'), 'true')
  for (const { path } of requests) {
    assert.equal(queryValue(path, 'key'), 'qr-key')
    assert.match(queryValue(path, 'ua') ?? '', /NeteaseMusicDesktop\//)
    assert.equal(queryValue(path, 'crypto'), 'eapi')
  }

  providerModule.deactivate()
})

test('bundled NCM provider reports login risk-control errors to the login UI', async () => {
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(): Promise<unknown> {
            return { code: 503, message: 'Service Unavailable' }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const result = await registeredProvider.current?.checkQrLogin('qr-key')
  assert.equal(result?.code, 503)
  assert.match(result?.message ?? '', /高频|风控/)

  providerModule.deactivate()
})

test('bundled NCM provider preserves NetEase network risk messages', async () => {
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>()

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(): Promise<unknown> {
            return { code: 400, message: '您当前的网络环境存在安全风险' }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  const result = await registeredProvider.current?.sendCaptcha('13800138000', '86')
  assert.equal(result?.code, 400)
  assert.match(result?.message ?? '', /网络环境存在安全风险/)
  assert.match(result?.message ?? '', /24 小时/)

  providerModule.deactivate()
})

test('bundled NCM provider resolves authorization before reusing a matching cache file', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=test-token']])
  const cachedPath = 'D:\\TwilightCache\\ncm-cache\\2609824992.flac'

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            return {
              code: 200,
              data: [{ id: 2609824992, url: 'https://music.example/song.flac', br: 999000 }]
            }
          },
          async getCachedSong(): Promise<string> {
            return cachedPath
          },
          async cacheSong(): Promise<string> {
            return cachedPath
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.equal(
    await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:2609824992' }),
    'https://music.example/song.flac'
  )
  assert.equal(requests.length, 1)
  assert.equal(
    await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:2609824992' }),
    cachedPath
  )
  assert.equal(requests.length, 1)

  providerModule.deactivate()
})

test('bundled NCM provider does not cache empty playback lookups', async () => {
  const requests: NcmRequest[] = []
  const registeredProvider: { current?: TestNcmProvider } = {}
  const settings = new Map<string, unknown>([['cookie', 'MUSIC_U=test-token']])

  const providerModule = (await import(
    new URL('../../../resources/plugins/ncm-provider/index.mjs', import.meta.url).href
  )) as {
    activate(context: unknown): Promise<void>
    deactivate(): void
  }

  await providerModule.activate({
    twilight: {
      internal: {
        ncm: {
          async request(path: string, cookie?: string): Promise<unknown> {
            requests.push({ path, cookie })
            return { code: 200, data: [{ id: 404, url: null, msg: 'no playable url' }] }
          },
          async getCachedSong(): Promise<null> {
            return null
          },
          async cacheSong(): Promise<null> {
            return null
          }
        }
      },
      providers: {
        async register(provider: TestNcmProvider): Promise<void> {
          registeredProvider.current = provider
        }
      }
    },
    settings: {
      async get(key?: string): Promise<unknown> {
        return key ? settings.get(key) : Object.fromEntries(settings)
      },
      async set(key: string, value: unknown): Promise<void> {
        settings.set(key, value)
      },
      async delete(key: string): Promise<void> {
        settings.delete(key)
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {}
    }
  })

  assert.equal(await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:404' }), null)
  // auto quality: hires/lossless/exhigh/standard + classic br fallbacks (999/320/128)
  // + one final gray-track match. Empty results remain uncached.
  assert.equal(requests.length, 8)
  assert.equal(new URL(requests[7].path, 'http://twilight.local').pathname, '/song/url/match')

  assert.equal(await registeredProvider.current?.getPlaybackUrl({ id: 'ncm:404' }), null)
  assert.equal(requests.length, 16)

  providerModule.deactivate()
})
