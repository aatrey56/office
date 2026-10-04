import type { Register } from 'claude-code'

import { installBoard } from './board'
import { installJobs } from './jobs'
import { installManga } from './manga'

export const register: Register = (on, options) => {
  installBoard(on, options)
  installJobs(on, options)
  installManga(on)
}
