import { load, px } from './png'
const [f, fx, fy, size] = process.argv.slice(2)
const img = load(f!), s = Number(size ?? 16)
const map = new Map<string, string>(); const keys = '.#sabcdefgh'
for (let y = 0; y < s; y++) {
  let row = ''
  for (let x = 0; x < s; x++) {
    const p = px(img, Number(fx) * s + x, Number(fy) * s + y)
    const k = p[3] === 0 ? 'T' : p.slice(0, 3).join()
    if (!map.has(k)) map.set(k, k === 'T' ? '.' : k === '0,0,0' ? '#' : keys[map.size + 1] ?? '?')
    row += map.get(k)
  }
  console.log(String(y).padStart(2), row)
}
console.log([...map].map(([k, v]) => `${v}=${k}`).join('  '))
