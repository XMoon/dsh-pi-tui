/**
 * The DIRECT child of a wrapper under test: it starts the signal-ignoring
 * descendant and stays alive itself, so a signal forwarded to this process
 * reaches a LIVE leader — and only a process-group signal reaches the
 * descendant.
 *
 * It writes `holder <pid> ready` and `descendant <pid>` to `PROBE_MARKER`,
 * then inherits the wrapper's TMPDIR for its descendant.
 * @module test/fixtures/signal-tree/holder
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = process.env.PROBE_MARKER
const say = (line) => appendFileSync(marker, `${line}\n`)

say(`holder ${process.pid} ready`)
const descendant = spawn(
  process.execPath,
  [join(dirname(fileURLToPath(import.meta.url)), 'descendant.mjs')],
  { stdio: 'ignore', env: process.env },
)
say(`descendant ${descendant.pid}`)
setInterval(() => {}, 1 << 30)
