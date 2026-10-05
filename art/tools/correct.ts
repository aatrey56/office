// Gambatte's "accurate" GBC colour correction (Pokefan531): linear light, a mixing matrix, 0.94 gain.
export function correct([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = [r, g, b].map(v => Math.pow(v / 255, 2.2))
  const M = [[0.82, 0.24, -0.06], [0.125, 0.665, 0.21], [0.195, 0.075, 0.73]]
  return M.map(row => {
    const v = (row[0]! * lin[0]! + row[1]! * lin[1]! + row[2]! * lin[2]!) * 0.94
    return Math.round(Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2) * 255)
  }) as [number, number, number]
}
