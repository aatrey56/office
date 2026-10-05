import type { Register } from 'claude-code'

import { installBoard } from './board'
import { installJobs } from './jobs'
import { installManage } from './manage'
import { installManga } from './manga'
import { installScene } from './scene'

export const register: Register = (on, options) => {
  installBoard(on, options)
  installJobs(on, options)
  installManage(on)
  installManga(on)
  installScene(on)
}
