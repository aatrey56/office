import { blank, load, save, scale } from './png'
// Crop a region (native px) of a PNG and enlarge it: bun tools/crop.ts in.png out.png x y w h k
const [src, dst, x, y, w, h, k] = process.argv.slice(2)
const img = load(src!), [X, Y, W, H] = [x, y, w, h].map(Number)
const out = blank(W!, H!)
for (let j = 0; j < H!; j++) for (let i = 0; i < W!; i++) out.data.set(img.data.subarray(((Y! + j) * img.width + X! + i) * 4, ((Y! + j) * img.width + X! + i) * 4 + 4), (j * W! + i) * 4)
save(dst!, scale(out, Number(k ?? 8)))
