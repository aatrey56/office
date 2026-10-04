import type { Register } from 'claude-code'

import { installBoard } from './board'
import { installJobs } from './jobs'
import { installManga } from './manga'
import { installSpike } from './spike'

export const register: Register = (on, options) => {
  installBoard(on, options)
  installJobs(on, options)
  installManga(on)
  installSpike(on) // temporary: the drawing test, see spike.tsx
}
