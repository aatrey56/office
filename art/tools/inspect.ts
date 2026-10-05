import { colors, load, nativeScale, save, scale, shrink } from './png'
for (const f of process.argv.slice(2)) {
  const img = load(f)
  const k = nativeScale(img)
  const native = k > 1 ? shrink(img, k) : img
  const cs = [...colors(native).entries()].sort((a, b) => b[1] - a[1])
  console.log(`${f}: ${img.width}x${img.height}, native scale ${k} → ${native.width}x${native.height}, ${cs.length} colors: ${cs.slice(0, 8).map(([c, n]) => `${c}(${n})`).join(' ')}`)
}
