/**
 * The current git branch of a working directory, read from the nearest
 * `.git/HEAD` (the footer/status git item's source fact). Never a subprocess:
 * the file read is enough for the display value and keeps the TUI start free
 * of child spawns.
 * @module @xmoon76/dsh-pi-tui/git-branch
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
/** Current git branch from the nearest .git/HEAD, or empty outside a checkout. */
export function gitBranch(cwd: string): string {
  let dir = cwd
  for (let depth = 0; depth < 10; depth += 1) {
    try {
      const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
      if (!head.startsWith('ref: refs/heads/')) return ''
      return head.slice('ref: refs/heads/'.length)
    } catch {
      const parent = join(dir, '..')
      if (parent === dir) return ''
      dir = parent
    }
  }
  return ''
}
