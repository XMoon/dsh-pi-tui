/**
 * Wait for a file to contain a line matching a pattern.
 *
 * The FILE EVENT is the signal: a fixture appends its line when it reaches a
 * known state, so a test waits for that fact instead of a clock. `deadlineMs`
 * only bounds a fixture that never writes, so a broken one fails with the log
 * it did produce instead of hanging the suite.
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
    const initial = matchingLine(file, pattern)
    if (initial !== undefined) {
      resolve(initial)
      return
    }
    let watcher: FSWatcher | undefined
    // reason: a bounded deadline around a file event, not a settle window — the
    // fixture writes its line synchronously when it reaches the state.
    const timer = setTimeout(() => {
      watcher?.close()
      const content = existsSync(file) ? readFileSync(file, 'utf8') : '(the file does not exist)'
      reject(new Error(`no line matching ${String(pattern)} within ${deadlineMs}ms; the log is:\n${content}`))
    }, deadlineMs)
    watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
      if (name !== undefined && String(name) !== basename(file)) return
      const line = matchingLine(file, pattern)
      if (line === undefined) return
      clearTimeout(timer)
      watcher?.close()
      resolve(line)
    })
  })
}
