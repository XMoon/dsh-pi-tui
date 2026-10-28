/**
 * The wrapper's DIRECT child that exits NORMALLY after starting a descendant
 * that keeps running.
 *
 * It is the normal-exit twin of `holder.mjs`: the leader's `close` arrives
 * while the descendant it started is still alive, which is exactly the state a
 * wrapper must not read as "the group is gone" before deleting the temp root.
 *
 * It writes its own line and the descendant's PID to `PROBE_MARKER`, then
 * exits 0 on its own.
 * @module test/fixtures/signal-tree/lingering-holder
 */

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const marker = process.env.PROBE_MARKER
appendFileSync(marker, `holder ${process.pid} ready\n`)
const descendant = spawn(
  process.execPath,
  [join(dirname(fileURLToPath(import.meta.url)), 'descendant.mjs')],
  { stdio: 'ignore', env: process.env },
)
// `unref` is what makes this a NORMAL exit: without it the live ChildProcess
// handle keeps the holder's event loop alive until the descendant ends.
descendant.unref()
appendFileSync(marker, `descendant ${descendant.pid}\n`)
