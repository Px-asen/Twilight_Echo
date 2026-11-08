import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { normalizeAudioDeviceOptions } from './player/audioOutputNormalize.ts'

// Playback-owner behavior now belongs to Core integration tests. These contracts
// exercise the renderer presentation that survives the ownership switch.

test('desktop lyrics consumes normalized lines and never parses raw lyrics in its window', () => {
  const app = readFileSync(
    new URL('../desktop-lyrics/DesktopLyricsApp.vue', import.meta.url),
    'utf8'
  )
  const shared = readFileSync(new URL('../../../shared/desktopLyrics.ts', import.meta.url), 'utf8')

  assert.match(shared, /export function resolveDesktopLyricsSlots/)
  assert.match(shared, /const activeSlot = \(displayIndex % 2\)/)
  assert.match(app, /resolveDesktopLyricsSlots/)
  assert.doesNotMatch(app, /buildLyricLines|parseLrc|parseTtml/)
})

test('local dashboard keeps a concise Chinese masthead', () => {
  const source = readFileSync(new URL('../components/LocalDashboard.vue', import.meta.url), 'utf8')

  assert.match(source, /class="masthead-kicker"/)
  assert.match(source, /class="masthead-title"/)
  assert.doesNotMatch(source, /class="masthead-sub"/)
  assert.match(source, /本地音乐库/)
  assert.doesNotMatch(source, /Good (morning|afternoon|evening)/i)
})

test('audio visualizer iframe controls are wired to the player store', () => {
  const panelSource = readFileSync(
    new URL('../components/AudioVisualizerPanel.vue', import.meta.url),
    'utf8'
  )
  const visualizerSource = readFileSync(
    new URL('../../../../resources/audio-visualizer/index.html', import.meta.url),
    'utf8'
  )

  assert.match(panelSource, /togglePlay,\s*next,\s*prev,\s*seek/)
  assert.match(panelSource, /const visualizerSrc = ref\(buildVisualizerSrc\(\)\)/)
  assert.match(panelSource, /function buildVisualizerSrc\(\): string/)
  assert.match(panelSource, /visualizerSrc\.value = buildVisualizerSrc\(\)/)
  assert.match(panelSource, /iframeReady\.value = false/)
  assert.match(panelSource, /event\.data\?\.kind !== 'control'/)
  assert.match(panelSource, /case 'togglePlay':\s*void togglePlay\(\)/)
  assert.match(panelSource, /case 'previous':\s*prev\(\)/)
  assert.match(panelSource, /case 'next':\s*next\(\)/)
  assert.match(panelSource, /case 'seek':[\s\S]*seek\(position\)/)
  assert.match(panelSource, /playbackStore\.acquireVisualizationConsumer\(visualizationOptions\)/)
  assert.match(panelSource, /watch\(playbackStore\.visualizationData, publishVisualizationFrame\)/)
  assert.match(panelSource, /releaseVisualization\?\.\(\)/)
  assert.doesNotMatch(panelSource, /window\.api\.audioEngine|setInterval|setTimeout/)
  assert.doesNotMatch(panelSource, /Float32Array\.from\(v\.spectrum\)/)
  assert.match(panelSource, /Float32Array\.from\(v\.waveform\)/)
  assert.match(
    panelSource,
    /if \(v\.tapStatus === 'synthetic-fallback'\) \{[\s\S]*postInactiveVisualizationFrame\(\)[\s\S]*return/
  )
  assert.doesNotMatch(
    panelSource,
    /if \(v\.tapStatus !== 'synthetic-fallback'\) \{[\s\S]*tempoEstimator\.pushFrame/
  )
  assert.match(panelSource, /v\.visualizerBars/)
  assert.doesNotMatch(panelSource, /function mapSpectrumToVisualizerBars/)
  assert.match(panelSource, /const bars = Float32Array\.from\(v\.visualizerBars \?\? \[\]\)/)
  assert.doesNotMatch(panelSource, /function spectrumValueToAmplitude/)
  assert.doesNotMatch(panelSource, /function amplitudeToVisualizerLevel/)
  assert.doesNotMatch(panelSource, /function applyVisualizerSpectralContrast/)
  assert.doesNotMatch(panelSource, /spectralTilt/)
  assert.doesNotMatch(panelSource, /subBinTexture/)
  assert.match(panelSource, /\[bars\.buffer, waveform\.buffer\]/)
  assert.match(panelSource, /kind: 'spectrum'/)
  assert.doesNotMatch(panelSource, /data: spectrum/)
  assert.match(panelSource, /bars,/)
  assert.match(panelSource, /waveform,/)

  assert.match(visualizerSource, /let dataArray = new Float32Array\(4096\)/)
  assert.match(visualizerSource, /let precomputedBars = new Float32Array\(SPECTRUM_BAR_COUNT\)/)
  assert.match(
    visualizerSource,
    /let previousPrecomputedBars = new Float32Array\(SPECTRUM_BAR_COUNT\)/
  )
  assert.match(
    visualizerSource,
    /let displayPrecomputedBars = new Float32Array\(SPECTRUM_BAR_COUNT\)/
  )
  assert.match(visualizerSource, /let precomputedBarsTransitionStartedAt = performance\.now\(\)/)
  assert.match(visualizerSource, /const PRECOMPUTED_BAR_TRANSITION_MS = 48/)
  assert.match(visualizerSource, /let usingPrecomputedBars = false/)
  assert.match(visualizerSource, /function currentPrecomputedBarValue\(/)
  assert.match(visualizerSource, /function retargetPrecomputedBars\(/)
  assert.match(visualizerSource, /progress \* progress \* \(3 - 2 \* progress\)/)
  assert.match(visualizerSource, /const binWidth = sampleRate \/ fftSize/)
  assert.doesNotMatch(visualizerSource, /function spectrumValueToAmplitude\(value\)/)
  assert.doesNotMatch(visualizerSource, /function amplitudeToVisualizerLevel\(amplitude\)/)
  assert.doesNotMatch(visualizerSource, /function applyVisualizerSpectralContrast\(bars\)/)
  assert.doesNotMatch(visualizerSource, /weightedSquares \+= amplitude \* amplitude \* overlap/)
  assert.doesNotMatch(
    visualizerSource,
    /amplitudeToVisualizerLevel\(rms \* 0\.85 \+ peak \* 0\.15\)/
  )
  assert.doesNotMatch(
    visualizerSource,
    /rawComputedBars = applyVisualizerSpectralContrast\(rawComputedBars\)/
  )
  assert.doesNotMatch(visualizerSource, /subBinTexture/)
  assert.doesNotMatch(visualizerSource, /spectralTilt/)
  assert.match(visualizerSource, /const barSpacing = 1\.5/)
  assert.match(visualizerSource, /const totalSpacing = barSpacing \* \(barCount - 1\)/)
  assert.match(visualizerSource, /const barWidth = \(width - totalSpacing\) \/ barCount/)
  assert.match(
    visualizerSource,
    /function buildLogFrequencyBinCenters\(barCount, sampleRate, fftSize\)/
  )
  assert.match(
    visualizerSource,
    /const frequency = minF \* Math\.pow\(frequencyRatio, i \/ frequencyStepCount\)/
  )
  assert.match(visualizerSource, /spectrumBinCenters\[i\] = frequency \/ binWidth/)
  assert.match(visualizerSource, /const valLow = \(dataArray\[indexLow\] \|\| 0\) \* 255/)
  assert.match(visualizerSource, /const valHigh = \(dataArray\[indexHigh\] \|\| 0\) \* 255/)
  assert.match(visualizerSource, /const val = valLow \+ \(valHigh - valLow\) \* fract/)
  assert.match(visualizerSource, /let sourceLevels = new Float32Array\(SPECTRUM_BAR_COUNT\)/)
  assert.match(visualizerSource, /currentPrecomputedBarValue\(i, now\)/)
  assert.match(
    visualizerSource,
    /sourceLevels = applyLowFrequencyShelfContour\(rawComputedBars, binCenters, contourPhase\)/
  )
  assert.match(
    visualizerSource,
    /sourceLevels = applyLowFrequencyShelfContour\(rawPrecomputedBars, binCenters, contourPhase\)/
  )
  assert.doesNotMatch(visualizerSource, /SPECTRUM_GAIN_TARGET_MIX/)
  assert.doesNotMatch(visualizerSource, /const sourceFloorLevel = frameContrastFloor/)
  assert.doesNotMatch(visualizerSource, /const sourceLevel = expandFrameContrast/)
  assert.doesNotMatch(visualizerSource, /adaptiveDisplayGain/)
  assert.match(visualizerSource, /const val = visualizerDisplayLevel\(sourceLevels\[i\]\) \* 255/)
  assert.doesNotMatch(visualizerSource, /Math\.max\(lastSpectrumHeights\[i\], 2\)/)
  assert.match(visualizerSource, /i \* \(barWidth \+ barSpacing\)/)
  assert.match(visualizerSource, /specCtx\.setTransform\(dpr, 0, 0, dpr, 0, 0\)/)
  assert.match(visualizerSource, /new ResizeObserver\(resizeCanvases\)/)
  assert.match(visualizerSource, /function isNumericSequence\(value\)/)
  assert.match(visualizerSource, /ArrayBuffer\.isView\(value\)/)
  assert.match(
    visualizerSource,
    /const incomingBars = isNumericSequence\(msg\.bars\) \? msg\.bars : null/
  )
  assert.match(visualizerSource, /\? Math\.max\(0, Math\.min\(1, incomingBars\[i\]\)\)/)
  assert.match(visualizerSource, /retargetPrecomputedBars\(incomingBars\)/)
  assert.doesNotMatch(visualizerSource, /\? Math\.max\(0, incomingBars\[i\]\)/)
  assert.match(visualizerSource, /usingPrecomputedBars = true/)
  assert.match(visualizerSource, /usingPrecomputedBars = false/)
  assert.match(visualizerSource, /if \(msg\.active === false\) \{/)
  assert.doesNotMatch(visualizerSource, /msg\.active === false \|\| !isPlaying/)
  assert.match(visualizerSource, /let spectrumAnimationFrame = 0/)
  assert.match(visualizerSource, /const SPECTRUM_ATTACK_SECONDS = 0\.014/)
  assert.match(visualizerSource, /const SPECTRUM_DECAY_SECONDS = 0\.16/)
  assert.match(visualizerSource, /const SPECTRUM_BAR_COUNT = 140/)
  assert.match(visualizerSource, /const SPECTRUM_DISPLAY_GAIN = 1\.32\b/)
  assert.match(visualizerSource, /const SPECTRUM_DISPLAY_RANGE = 1\.42/)
  assert.match(visualizerSource, /const SPECTRUM_DISPLAY_GAMMA = 0\.78/)
  assert.match(visualizerSource, /const SPECTRUM_DISPLAY_HEADROOM = 1/)
  assert.match(visualizerSource, /const SPECTRUM_CONTRAST_FLOOR = 0\.16/)
  assert.match(visualizerSource, /const SPECTRUM_CONTRAST_POWER = 0\.68/)
  assert.match(visualizerSource, /let lowFrequencyContourPhase = 0/)
  assert.match(visualizerSource, /function updateLowFrequencyContourPhase\(rawBars, deltaSeconds\)/)
  assert.match(visualizerSource, /justify-content: flex-start;/)
  assert.match(visualizerSource, /flex: 0 0 calc\(250px \+ var\(--spectrum-top-growth\)\);/)
  assert.match(visualizerSource, /height: calc\(250px \+ var\(--spectrum-top-growth\)\);/)
  assert.doesNotMatch(visualizerSource, /\.spectrum-outer-container \{[^}]*flex-grow: 1;/)
  assert.match(visualizerSource, /const SPECTRUM_HEIGHT_SCALE = 1/)
  assert.match(visualizerSource, /const LOW_FREQUENCY_CONTOUR_BAR_LIMIT = 72/)
  assert.match(visualizerSource, /const LOW_FREQUENCY_CONTOUR_FLAT_RANGE = 0\.2/)
  assert.match(visualizerSource, /const LOW_FREQUENCY_CONTOUR_BASE_DEPTH = 0\.24/)
  assert.match(visualizerSource, /const LOW_FREQUENCY_CONTOUR_DEPTH = 0\.52/)
  assert.match(
    visualizerSource,
    /const tertiary = Math\.sin\(\(barIndex \+ 1\) \* 2\.37 \+ phase \* 0\.9\)/
  )
  assert.match(visualizerSource, /function visualizerDisplayLevel\(value\)/)
  assert.doesNotMatch(visualizerSource, /function smoothPeakSourceLevel/)
  assert.doesNotMatch(visualizerSource, /function frameContrastFloor/)
  assert.doesNotMatch(visualizerSource, /function expandFrameContrast/)
  assert.match(
    visualizerSource,
    /return Math\.pow\(level, SPECTRUM_DISPLAY_GAMMA\) \* SPECTRUM_DISPLAY_HEADROOM/
  )
  assert.match(
    visualizerSource,
    /function applyLowFrequencyShelfContour\(rawBars, binCenters, contourPhase\)/
  )
  assert.match(
    visualizerSource,
    /sourceLevels = applyLowFrequencyShelfContour\(rawComputedBars, binCenters, contourPhase\)/
  )
  assert.match(
    visualizerSource,
    /sourceLevels = applyLowFrequencyShelfContour\(rawPrecomputedBars, binCenters, contourPhase\)/
  )
  assert.match(visualizerSource, /lowFrequencyContourPhase: contourPhase/)
  assert.match(visualizerSource, /const val = visualizerDisplayLevel\(sourceLevels\[i\]\) \* 255/)
  assert.match(
    visualizerSource,
    /const targetHeight = \(val \/ 255\) \* height \* SPECTRUM_HEIGHT_SCALE/
  )
  assert.match(visualizerSource, /window\.__twilightVisualizerDebug = \(\) => lastSpectrumDebug/)
  assert.match(visualizerSource, /function smoothSpectrumHeight\(/)
  assert.match(visualizerSource, /1 - Math\.exp\(-deltaSeconds \/ smoothingSeconds\)/)
  assert.match(
    visualizerSource,
    /lastSpectrumHeights\[i\] = smoothSpectrumHeight\(\s*lastSpectrumHeights\[i\],\s*targetHeight,\s*deltaSeconds\s*\)/
  )
  assert.match(visualizerSource, /function startSpectrumLoop\(\)/)
  assert.match(visualizerSource, /function stopSpectrumLoop\(\)/)
  assert.match(visualizerSource, /cancelAnimationFrame\(spectrumAnimationFrame\)/)
  assert.match(visualizerSource, /spectrumAnimationFrame = requestAnimationFrame\(drawSpectrum\)/)
  assert.doesNotMatch(
    visualizerSource,
    /function drawSpectrum\(\) \{\s*requestAnimationFrame\(drawSpectrum\)/
  )
  assert.match(
    visualizerSource,
    /if \(msg\.active === false\) \{[\s\S]*if \(isPlaying\) \{[\s\S]*dataArray\.fill\(0\)[\s\S]*startSpectrumLoop\(\)[\s\S]*\} else \{[\s\S]*lastSpectrumHeights\.fill\(0\)[\s\S]*stopSpectrumLoop\(\)[\s\S]*renderSpectrumFrame\(performance\.now\(\)\)/
  )
  assert.match(visualizerSource, /function postHostControl\(action, payload = \{\}\)/)
  assert.match(visualizerSource, /waveCtx\.strokeStyle = 'rgba\(60, 62, 68, 0\.78\)'/)
  assert.match(visualizerSource, /waveCtx\.lineWidth = 1\.35/)
  assert.match(visualizerSource, /waveCtx\.lineTo\(x, y\)/)
  assert.match(visualizerSource, /const amplitudeScale = height \* 0\.38/)
  assert.match(visualizerSource, /const visualGain = maxAbs > 0/)
  assert.match(visualizerSource, /Math\.min\(3\.2, Math\.max\(1, 0\.72 \/ maxAbs\)\)/)
  assert.doesNotMatch(visualizerSource, /const barWidth = Math\.max\(1, step - gap\)/)
  assert.doesNotMatch(visualizerSource, /waveCtx\.fillRect\(x, y, barWidth, h\)/)
  assert.doesNotMatch(visualizerSource, /background: #111827/)
  assert.match(visualizerSource, /kind: 'control'/)
  assert.match(visualizerSource, /btnPlayPause\.addEventListener\('click'[\s\S]*'togglePlay'/)
  assert.match(visualizerSource, /btn-prev'\)\.addEventListener\('click'[\s\S]*'previous'/)
  assert.match(visualizerSource, /btn-next'\)\.addEventListener\('click'[\s\S]*'next'/)
  assert.match(
    visualizerSource,
    /scrubber\.addEventListener\('click'[\s\S]*postHostControl\('seek', \{ position \}\)/
  )
})

test('player bar exposes a HiFi console drawer instead of visualization meters', () => {
  const playerBarSource = readFileSync(
    new URL('../components/PlayerBar.vue', import.meta.url),
    'utf8'
  )
  const hifiSidebarSource = readFileSync(
    new URL('../components/player-bar/HiFiSidebar.vue', import.meta.url),
    'utf8'
  )

  assert.match(
    playerBarSource,
    /const HiFiSidebar = defineAsyncComponent\(\(\) => import\('\.\/player-bar\/HiFiSidebar\.vue'\)\)/
  )
  assert.match(playerBarSource, /<HiFiSidebar/)
  assert.match(playerBarSource, /class="hifi-overlay"/)
  assert.match(playerBarSource, /title="HiFi 控制台"/)
  assert.match(playerBarSource, /<PlayerControlIcon name="hifi"/)
  assert.match(playerBarSource, /openEqualizer/)
  assert.match(playerBarSource, /onReloadLyrics/)
  assert.match(playerBarSource, /setAudioDevice/)
  assert.match(playerBarSource, /setUnityVolume/)
  assert.match(playerBarSource, /volume-unity-btn/)
  assert.match(playerBarSource, /@set-unity-volume="setUnityVolume"/)
  assert.doesNotMatch(playerBarSource, /const visualizationStateText = computed/)
  assert.doesNotMatch(playerBarSource, /class="visualization-panel"/)
  assert.doesNotMatch(playerBarSource, /oscilloscopeCanvasRef/)
  assert.doesNotMatch(playerBarSource, /spectrogramCanvasRef/)
  assert.match(hifiSidebarSource, /链路|Signal Path/)
  assert.match(hifiSidebarSource, /Master DSP|DSP/)
  assert.match(hifiSidebarSource, /输出|Devices/)
  assert.match(hifiSidebarSource, /歌词|Lyrics/)
  assert.match(hifiSidebarSource, /Sleep Timer|定时/)
  assert.match(hifiSidebarSource, /Playback Rate|倍速/)
  assert.match(hifiSidebarSource, /A-B Loop|A-B/)
  assert.match(hifiSidebarSource, /Cast \/ DLNA|投送|DLNA/)
  assert.match(hifiSidebarSource, /Bookmarks|书签/)
  assert.match(hifiSidebarSource, /id: 'tools'/)
  assert.match(playerBarSource, /@cycle-playback-rate="cyclePlaybackRate"/)
  assert.match(playerBarSource, /@toggle-ab-loop="toggleAbLoopAtCurrentTime"/)
  assert.match(playerBarSource, /@sleep-timer-select="onSleepTimerSelectValue"/)
  assert.match(playerBarSource, /@refresh-cast-devices="refreshCastDevices"/)
  assert.match(playerBarSource, /@add-bookmark="onAddBookmark"/)
  // Playbar destroys the left rail on track identity change so cover art remounts.
  // The rail is a region in the layout `v-for` now, so the track identity rides
  // that region's key instead of sitting on a hand-written `.player-left`.
  assert.match(playerBarSource, /playerLeftKey/)
  assert.match(playerBarSource, /key: name === 'left' \? `left:\$\{playerLeftKey\.value\}` : name/)
  assert.match(playerBarSource, /:key="region\.key"/)
  assert.match(playerBarSource, /CoverImg/)
  assert.doesNotMatch(playerBarSource, /coverLoadFailed/)
  assert.match(playerBarSource, /progress:\$\{currentTrack\.id\}/)
  assert.doesNotMatch(playerBarSource, /class="sleep-timer-select"/)
  assert.doesNotMatch(playerBarSource, /class="cast-anchor"/)
  assert.doesNotMatch(playerBarSource, /class="ctrl-btn ab-loop-btn"/)
  assert.doesNotMatch(playerBarSource, /class="ctrl-btn rate-btn"/)
  assert.doesNotMatch(playerBarSource, /class="ctrl-btn bookmark-btn"/)
  assert.doesNotMatch(playerBarSource, /@click="toggleMute"/)
  assert.match(hifiSidebarSource, /setUnityVolume/)
  assert.match(hifiSidebarSource, /HIFI_STATUS_COPY\.unityButton/)
  assert.match(hifiSidebarSource, /volume_not_unity/)
  assert.match(hifiSidebarSource, /VOLUME_NORMALIZATION_OPTIONS/)
  assert.match(hifiSidebarSource, /openEqualizer/)
  assert.match(hifiSidebarSource, /DSP_OUTPUT_SAMPLE_RATE_OPTIONS/)
  assert.match(hifiSidebarSource, /OUTPUT STAGE|Output Stage|采样率锁/)
  assert.match(playerBarSource, /dsp-output-stage/)
  assert.match(playerBarSource, /@set-output-stage="setOutputStage"/)
})

test('renderer audio device normalization uses native names and omits stale selected devices', () => {
  const canonicalAsioId = 'asio:{6b3ba606-8664-4426-8994-0f1d9d12a345}'
  const options = normalizeAudioDeviceOptions(
    [
      {
        id: 'auto',
        label: '系统默认',
        isDefault: true
      },
      {
        id: canonicalAsioId,
        label: '',
        name: 'FiiO ASIO Driver',
        backend: 'asio',
        isDefault: false,
        pathKind: 'asio'
      }
    ],
    'asio:{stale-device}',
    'asio'
  )

  assert.equal(options.find((device) => device.id === canonicalAsioId)?.label, 'FiiO ASIO Driver')
  assert.equal(
    options.some((device) => device.id === 'asio:{stale-device}'),
    false
  )
})
