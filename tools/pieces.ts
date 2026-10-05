import { load, px, type Img } from './png'
// Connected opaque regions (8-neighbour) below the tile rows, as bounding boxes.
export function pieces(img: Img, fromY = 32) {
  const seen = new Uint8Array(img.width * img.height), out: { x: number; y: number; w: number; h: number; n: number }[] = []
  const solid = (x: number, y: number) => x >= 0 && y >= fromY && x < img.width && y < img.height && px(img, x, y)[3] > 0
  for (let y = fromY; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!solid(x, y) || seen[y * img.width + x]) continue
    let [x0, y0, x1, y1, n] = [x, y, x, y, 0]; const st = [[x, y]]; seen[y * img.width + x] = 1
    while (st.length) { const [cx, cy] = st.pop()!; n++; x0 = Math.min(x0, cx!); x1 = Math.max(x1, cx!); y0 = Math.min(y0, cy!); y1 = Math.max(y1, cy!)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = cx! + dx, ny = cy! + dy
        if (solid(nx, ny) && !seen[ny * img.width + nx]) { seen[ny * img.width + nx] = 1; st.push([nx, ny]) } } }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n })
  }
  return out.filter(p => p.n > 6)
}
if (import.meta.main) {
  const img = load('out/furniture_grid_native.png')
  pieces(img).sort((a, b) => a.y - b.y || a.x - b.x).forEach((p, i) => console.log(String(i).padStart(2), `x=${p.x} y=${p.y} ${p.w}x${p.h}`))
}
