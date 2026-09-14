import type { Track } from '@renderer/types/music'
import type { useAppNavigation } from '@renderer/app/useAppNavigation.ts'
import { SETTINGS_SEARCH_INDEX } from '@renderer/components/settings-page/types.ts'
import { normalizeSearchText } from '@renderer/utils/localLibrarySearch.ts'

export interface CommandPaletteAction {
  id: string
  title: string
  description: string
  terms: string
  group: '操作' | '设置'
  disabledReason?: string
  run: () => unknown
}

export function createCommandPaletteActions(controls: {
  navigation: ReturnType<typeof useAppNavigation>
  currentTrack: Track | null
  playing: boolean
  loading: boolean
  lyricsVisible: boolean
  showLyrics: () => Promise<void>
  togglePlay: () => Promise<void>
}): CommandPaletteAction[] {
  const { navigation } = controls
  const playbackReason = !controls.currentTrack
    ? '当前没有歌曲'
    : controls.loading
      ? '正在加载歌曲'
      : undefined
  return [
    {
      id: 'now-playing',
      title: '定位正在播放',
      description: controls.currentTrack?.title ?? '打开播放页',
      terms: 'now playing 当前 歌曲',
      group: '操作',
      disabledReason: !controls.currentTrack ? '当前没有歌曲' : undefined,
      run: navigation.openPlayingPage
    },
    {
      id: 'play-pause',
      title: controls.playing ? '暂停播放' : '继续播放',
      description: '控制当前歌曲',
      terms: 'play pause 播放 暂停',
      group: '操作',
      disabledReason: playbackReason,
      run: controls.togglePlay
    },
    {
      id: 'equalizer',
      title: '打开均衡器',
      description: 'EQ 与耳机补偿',
      terms: 'eq equalizer 均衡器 音效',
      group: '操作',
      run: navigation.openEqualizerPage
    },
    {
      id: 'dsp',
      title: '打开 DSP 机架',
      description: '查看处理链与场景',
      terms: 'dsp 音效 机架 场景',
      group: '操作',
      run: navigation.openDspRackPage
    },
    {
      id: 'lyrics',
      title: '显示桌面歌词',
      description: controls.lyricsVisible ? '桌面歌词已显示' : '在桌面显示当前歌曲的歌词',
      terms: 'desktop lyrics 歌词 桌面',
      group: '操作',
      disabledReason: controls.lyricsVisible ? '桌面歌词已显示' : undefined,
      run: controls.showLyrics
    },
    {
      id: 'settings',
      title: '进入设置',
      description: '应用偏好与音乐库设置',
      terms: 'settings 偏好 配置',
      group: '操作',
      run: () => navigation.openSettingsPage()
    },
    {
      id: 'device-profiles',
      title: '管理设备档案',
      description: '查看与选择设备、输出策略和 DSP',
      terms: 'device profile dac 耳机 输出 声卡 档案',
      group: '操作',
      run: () => navigation.openSettingsPage('playback', { anchor: 'device-profiles' })
    },
    ...SETTINGS_SEARCH_INDEX.map(
      (entry, index): CommandPaletteAction => ({
        id: `setting:${index}`,
        title: entry.title,
        description: '定位设置项',
        terms: entry.terms,
        group: '设置',
        run: () => navigation.openSettingsPage(entry.section, { entry })
      })
    )
  ]
}

export function filterCommandPaletteActions(
  actions: readonly CommandPaletteAction[],
  query: string
): CommandPaletteAction[] {
  const q = normalizeSearchText(query.replace(/^\s*>/, ''))
  if (!q) return actions.filter((action) => action.group === '操作')
  return actions.filter((action) =>
    normalizeSearchText(`${action.title}\u0000${action.terms}`).includes(q)
  )
}
