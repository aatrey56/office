import { load, nativeScale, px, shrink } from './png'
const a0 = load('raw/monkeyimage-interior/2367227'), b0 = load('raw/monkeyimage-interior/2367228')
const a = shrink(a0, nativeScale(a0)), b = shrink(b0, nativeScale(b0))
let same = 0, blackToDark = 0, other = 0
for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
  const p = px(a, x, y).join(), q = px(b, x, y).join()
  if (p === q) same++; else if (p === '0,0,0,255' && q === '33,65,58,255') blackToDark++; else other++
}
console.log({ same, blackToDark, other })
