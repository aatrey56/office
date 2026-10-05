import { load, nativeScale, save, scale, shrink } from './png'
// Native-size sheet enlarged ×4 with a magenta line every 16 px and an 8 px dot grid, for picking coordinates.
const [src, dst] = process.argv.slice(2)
let img = load(src!)
const k = nativeScale(img); if (k > 1) img = shrink(img, k)
save(dst!.replace('.png', '_native.png'), img)
const Z = 4, big = scale(img, Z)
for (let y = 0; y < big.height; y++) for (let x = 0; x < big.width; x++) {
  const gx = x % (16 * Z) === 0, gy = y % (16 * Z) === 0
  const i = (y * big.width + x) * 4
  if (gx || gy) big.data.set([255, 0, 255, 255], i)
  else if (big.data[i + 3] === 0) big.data.set(((x >> 5) + (y >> 5)) % 2 ? [235, 235, 235, 255] : [250, 250, 250, 255], i)
}
save(dst!, big)
console.log(img.width, img.height)
