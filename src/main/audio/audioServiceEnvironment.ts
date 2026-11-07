import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { getNativeAddonCandidates } from './nativeBinding.ts'

/**
 * Electron 自带 Chromium 的 libffmpeg.so，与引擎链接的系统 libav* 同名符号
 * 抢占全局符号表，导致音频服务（utility 进程）里 FFmpeg 协议注册表损坏
 * —— avformat_open_input 对本地文件/HTTP 一律报 “Protocol not found”
 * （-1330794744 / AVERROR_PROTOCOL_NOT_FOUND）。
 * 在 fork 前用 LD_PRELOAD 预载系统 libav*，保证引擎的 FFmpeg 符号解析一致。
 * 仅 Linux + 动态链接系统 FFmpeg 时生效；静态链接构建下 ldd 无 libav* 输出，自动跳过。
 */
function systemFfmpegPreloadPaths(): string[] {
  if (process.platform !== 'linux') return []
  try {
    const addon = getNativeAddonCandidates().find((candidate) => existsSync(candidate))
    if (!addon) return []
    const result = spawnSync('ldd', [addon], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout) return []
    const wanted = new Set(['libavformat', 'libavcodec', 'libavutil', 'libswresample'])
    const paths: string[] = []
    for (const line of result.stdout.split('\n')) {
      const match = /^\s*(\S+\.so[^\s]*)\s*=>\s*(\/\S+)/.exec(line)
      if (!match) continue
      const base = match[1].split('.')[0]
      if (wanted.has(base) && !paths.includes(match[2])) paths.push(match[2])
    }
    return paths
  } catch {
    return []
  }
}

export function audioServiceEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (process.platform === 'linux') {
    const preload = systemFfmpegPreloadPaths()
    if (preload.length > 0) {
      const existing =
        typeof env.LD_PRELOAD === 'string' && env.LD_PRELOAD ? env.LD_PRELOAD + ':' : ''
      env.LD_PRELOAD = existing + preload.join(':')
    }
  }
  return env
}
