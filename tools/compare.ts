import { scene } from './room'
import { blank, save, scale, type Img } from './png'
import { correct } from './correct'
const raw = scene()
const fixed: Img = { ...raw, data: raw.data.slice() }
for (let i = 0; i < fixed.data.length; i += 4) fixed.data.set(correct([fixed.data[i]!, fixed.data[i + 1]!, fixed.data[i + 2]!]), i)
const both = blank(raw.width * 2 + 8, raw.height, [40, 40, 44, 255])
for (const [img, ox] of [[raw, 0], [fixed, raw.width + 8]] as const)
  for (let y = 0; y < img.height; y++) both.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * both.width + ox) * 4)
save('out/compare_x3.png', scale(both, 3))
save('out/room_corrected_x6.png', scale(fixed, 6))
