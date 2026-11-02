// Self-contained artwork for the Windows taskbar thumbnail toolbar. Run with:
// node scripts/generate-smtc-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const { PNG } = createRequire(import.meta.url)('pngjs')
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'smtc')
const SIZES = [16, 24, 32]
const SAMPLES = 4

function rectangle(x, y, width, height) {
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height]
  ]
}

function heartOutline() {
  const points = [[12, 20.2]]
  const curves = [
    [10.7, 19.2, 3, 13.8, 3, 8.7],
    [3, 3.7, 9.2, 2.5, 12, 7],
    [14.8, 2.5, 21, 3.7, 21, 8.7],
    [21, 13.8, 13.3, 19.2, 12, 20.2]
  ]
  for (const [x1, y1, x2, y2, x3, y3] of curves) {
    const [x0, y0] = points.at(-1)
    for (let i = 1; i <= 32; i++) {
      const t = i / 32
      const u = 1 - t
      points.push([
        u ** 3 * x0 + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3,
        u ** 3 * y0 + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3
      ])
    }
  }
  return points
}

const heart = heartOutline()
const ICONS = {
  play: {
    polygons: [
      [
        [7, 4],
        [20, 12],
        [7, 20]
      ]
    ]
  },
  pause: { polygons: [rectangle(5.5, 4, 4.5, 16), rectangle(14, 4, 4.5, 16)] },
  previous: {
    polygons: [
      rectangle(4, 4, 3, 16),
      [
        [19, 4],
        [7, 12],
        [19, 20]
      ]
    ]
  },
  next: {
    polygons: [
      rectangle(17, 4, 3, 16),
      [
        [5, 4],
        [17, 12],
        [5, 20]
      ]
    ]
  },
  heart: { stroke: heart },
  'heart-filled': { polygons: [heart], liked: true }
}

function inside(x, y, polygon) {
  let covered = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) covered = !covered
  }
  return covered
}

function nearStroke(x, y, points) {
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const dx = bx - ax
    const dy = by - ay
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    if ((x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= 0.9 ** 2) return true
  }
  return false
}

function rasterize(icon, size, color) {
  const png = new PNG({ width: size, height: size })
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = ((px + (sx + 0.5) / SAMPLES) * 24) / size
          const y = ((py + (sy + 0.5) / SAMPLES) * 24) / size
          if (
            icon.stroke ? nearStroke(x, y, icon.stroke) : icon.polygons.some((p) => inside(x, y, p))
          )
            covered++
        }
      }
      const offset = (py * size + px) * 4
      png.data.set([...color, Math.round((covered * 255) / SAMPLES ** 2)], offset)
    }
  }
  return PNG.sync.write(png)
}

function createIco(icon, color) {
  const images = SIZES.map((size) => rasterize(icon, size, color))
  const directory = Buffer.alloc(6 + SIZES.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(SIZES.length, 4)
  let offset = directory.length
  for (const [i, size] of SIZES.entries()) {
    const entry = 6 + i * 16
    directory[entry] = directory[entry + 1] = size
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(images[i].length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += images[i].length
  }
  return Buffer.concat([directory, ...images])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, icon] of Object.entries(ICONS)) {
  for (const darkGlyph of [false, true]) {
    const color = icon.liked
      ? darkGlyph
        ? [197, 45, 68]
        : [255, 126, 148]
      : darkGlyph
        ? [40, 44, 52]
        : [245, 246, 248]
    const file = `${name}${darkGlyph ? '-dark' : ''}.ico`
    writeFileSync(join(OUT_DIR, file), createIco(icon, color))
    console.log(`[taskbar] wrote build/smtc/${file}`)
  }
}
