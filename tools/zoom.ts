import { load, save, scale } from './png'
const [src, dst, k] = process.argv.slice(2)
save(dst!, scale(load(src!), Number(k)))
