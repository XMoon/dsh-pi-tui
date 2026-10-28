/**
 * Wait for a file to contain a line matching a pattern.
 *
 * The FILE CONTENT is the authority: a fixture appends its line when it reaches
 * a known state, and a watcher event only says "look again". `deadlineMs` only
 * bounds a fixture that never writes, so a broken one fails with the log it did
 * produce instead of hanging the suite.
 *
 * The caller's DIRECTORY must exist (a watcher cannot observe a path whose
 * parent does not exist yet).
 *
 * @module @xmoon76/dsh-pi-tui/test/support/wait-for-file
 */

import { existsSync, readFileSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

/** The first current line matching `pattern`, or undefined. */
function matchingLine(file: string, pattern: RegExp): string | undefined {
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8').split('\n').find((line) => pattern.test(line))
}

export function waitForFileLine(file: string, pattern: RegExp, deadlineMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let watcher: FSWatcher | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    /** Settle at MOST once: whichever path wins closes the watcher and clears the timer. */
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      finish()
    }
    /**
     * Re-read the CURRENT contents. An event is only a notification, so a stale
     * or unrelated event can never settle this wait; a read failure rejects with
     * its real error instead of being retried.
     */
    const check = (): void => {
      if (settled) return
      let line: string | undefined
      try {
        line = matchingLine(file, pattern)
      } catch (error) {
        settle(() => reject(error))
        return
      }
      if (line !== undefined) settle(() => resolve(line))
    }
    // The watcher is armed FIRST and the first content read runs LAST: a write
    // before `watch()` is still the current content that read sees, and a write
    // after it emits an event this watcher already observes. Reading before
    // registering would leave an interval in which a write produces neither a
    // matching read nor an event.
    watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
      if (name !== undefined && String(name) !== basename(file)) return
      check()
    })
    // reason: a bounded deadline around a file event, not a settle window — the
    // fixture writes its line synchronously when it reaches the state.
    timer = setTimeout(() => {
      let content: string
      try {
        content = existsSync(file) ? readFileSync(file, 'utf8') : '(the file does not exist)'
      } catch (error) {
        settle(() => reject(error))
        return
      }
      settle(() => reject(new Error(`no line matching ${String(pattern)} within ${deadlineMs}ms; the log is:\n${content}`)))
    }, deadlineMs)
    check()
  })
}
