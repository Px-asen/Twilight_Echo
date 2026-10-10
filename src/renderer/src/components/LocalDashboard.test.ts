import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('dashboard prioritizes active and last-played tracks over recommendations', () => {
  const source = readFileSync(new URL('./LocalDashboard.vue', import.meta.url), 'utf8')

  assert.match(source, /getRecentTracks/)
  assert.match(source, /const lastPlayedTrack = computed<Track \| null>/)
  assert.match(
    source,
    /if \(currentTrack\.value\) return currentTrack\.value\s*if \(lastPlayedTrack\.value\) return lastPlayedTrack\.value/
  )
  assert.match(source, /heroIsCurrent\.value && isPlaying\.value \? '正在播放' : '上次播放'/)
  assert.doesNotMatch(source, /return '为你推荐'/)
})

test('dashboard primary transport keeps its icon visible on the playbar surface', () => {
  const styles = readFileSync(new URL('./LocalDashboard.css', import.meta.url), 'utf8')

  const playRule = styles.match(/\.home \.transport-button\.transport-play\s*\{([^}]+)\}/)![1]
  assert.match(
    playRule,
    /color:\s*var\(--te-player-bar-play-text, var\(--te-transport-play-text\)\)/
  )
  assert.match(playRule, /-webkit-text-fill-color:\s*currentColor/)
  assert.match(
    playRule,
    /background:\s*var\(--te-player-bar-play-surface, var\(--te-transport-play-surface\)\)/
  )
})

test('dashboard empty-state CTA keeps its content visible on the ink surface', () => {
  const source = readFileSync(new URL('./LocalDashboard.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./LocalDashboard.css', import.meta.url), 'utf8')

  assert.match(source, /class="empty-cta-content"[\s\S]*?添加音乐库文件夹/)
  assert.match(styles, /\.home button:not\(\.empty-cta\)\s*\{[\s\S]*?color:\s*inherit/)
  assert.match(
    styles,
    /\.empty-cta\s*\{[\s\S]*?background:\s*var\(--home-ink\);[\s\S]*?color:\s*var\(--te-neutral-50, #fafafa\);[\s\S]*?-webkit-text-fill-color:\s*currentColor/
  )
  assert.match(
    styles,
    /\.empty-cta-content\s*\{[\s\S]*?color:\s*inherit;[\s\S]*?-webkit-text-fill-color:\s*currentColor/
  )
})

test('dashboard renders the resolved DSP graph from source through the output stage', () => {
  const source = readFileSync(new URL('./LocalDashboard.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./LocalDashboard.css', import.meta.url), 'utf8')

  assert.match(source, /getDspSceneState\(\)/)
  assert.match(source, /getDspGraphStatus\(\)/)
  assert.match(source, /dspSceneState\.value\.graph\.nodes/)
  assert.match(source, /type: 'resampler'/)
  assert.match(source, /stateLabel: srcActive \? '实时转换' : 'SRC 旁路'/)
  assert.doesNotMatch(source, /stateLabel: srcActive \? '实时转换' : 'Native 直通'/)
  assert.match(source, /type: 'dither'/)
  assert.match(source, /type: 'safetyClamp'/)
  assert.match(source, /v-for="stage in dspRouteStages"/)
  assert.match(source, /class="dsp-route-dialog"\s+role="dialog"/)
  assert.match(source, /dspGraphStatus\?\.meter\?\.truePeakDb/)
  assert.match(source, /averageProcessMs/)
  assert.match(source, /window\.setInterval\([\s\S]*1000\)/)
  assert.match(styles, /\.dsp-route-strip\.is-compact/)
  assert.match(styles, /\.dsp-route-dialog-backdrop/)
  assert.match(styles, /\.dialog-diagnostics/)
})
