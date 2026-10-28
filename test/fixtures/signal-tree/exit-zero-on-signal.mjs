/**
 * The wrapper's DIRECT child that HANDLES the forwarded interruption and exits
 * 0, the way a command with its own cleanup can.
 *
 * A wrapper that reports the child's success as its own would turn an
 * interrupted run into a pass; this fixture is the positive control for the
 * rule that the received signal owns the wrapper's status.
 *
 * It writes `child <pid> ready tmpdir=<TMPDIR>` to `PROBE_MARKER`, installs the
 * handlers, then stays alive until one of them arrives.
 * @module test/fixtures/signal-tree/exit-zero-on-signal
 */

import { appendFileSync } from 'node:fs'

const marker = process.env.PROBE_MARKER
appendFileSync(marker, `child ${process.pid} ready tmpdir=${process.env.TMPDIR}\n`)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => process.exit(0))
}
setInterval(() => {}, 1 << 30)
