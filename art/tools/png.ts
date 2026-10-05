import { PNG } from 'pngjs'
import { readFileSync, writeFileSync } from 'node:fs'

export type Img = { width: number; height: number; data: Uint8Array } // RGBA

export function load(path: string): Img {
  const p = PNG.sync.read(readFileSync(path))
  return { width: p.width, height: p.height, data: new Uint8Array(p.data) }
}

export function save(path: string, img: Img) {
  const p = new PNG({ width: img.width, height: img.height })
  p.data = Buffer.from(img.data)
  writeFileSync(path, PNG.sync.write(p))
}

export const px = (img: Img, x: number, y: number) => {
  const i = (y * img.width + x) * 4
  return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!] as const
}

export function blank(width: number, height: number, rgba = [0, 0, 0, 0]): Img {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4)
  return { width, height, data }
}

// Nearest-neighbour enlarge by a whole number.
export function scale(img: Img, k: number): Img {
  const out = blank(img.width * k, img.height * k)
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const s = ((Math.floor(y / k)) * img.width + Math.floor(x / k)) * 4
      out.data.set(img.data.subarray(s, s + 4), (y * out.width + x) * 4)
    }
  return out
}

// Shrink an image that was enlarged by a whole number: find the largest k where every k×k block is one color.
export function nativeScale(img: Img): number {
  for (let k = 32; k > 1; k--) {
    if (img.width % k || img.height % k) continue
    let ok = true
    for (let by = 0; by < img.height && ok; by += k)
      for (let bx = 0; bx < img.width && ok; bx += k) {
        const c = px(img, bx, by).join()
        for (let y = by; y < by + k && ok; y++) for (let x = bx; x < bx + k && ok; x++) if (px(img, x, y).join() !== c) ok = false
      }
    if (ok) return k
  }
  return 1
}

export function shrink(img: Img, k: number): Img {
  const out = blank(img.width / k, img.height / k)
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) out.data.set(px(img, x * k, y * k), (y * out.width + x) * 4)
  return out
}

export function colors(img: Img): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < img.width * img.height; i++) {
    const a = img.data[i * 4 + 3]!
    const key = a === 0 ? 'transparent' : '#' + [0, 1, 2].map(c => img.data[i * 4 + c]!.toString(16).padStart(2, '0')).join('')
    m.set(key, (m.get(key) ?? 0) + 1)
  }
  return m
}
