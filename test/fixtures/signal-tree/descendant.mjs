/**
 * A descendant that deliberately IGNORES every signal a wrapper forwards to
 * its process group: only the SIGKILL escalation can end it.
 *
 * It records its own start line and, on each ignored signal, whether the
 * wrapper's disposable temp root (its TMPDIR) still accepts a write. A wrapper
 * that deletes the root while this process runs fails that observation, which
 * is exactly the orphan it must not create.
 *
 * The log is `PROBE_MARKER`; every line starts with `descendant <pid>`.
 * @module test/fixtures/signal-tree/descendant
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const marker = process.env.PROBE_MARKER
const say = (line) => appendFileSync(marker, `${line}\n`)

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    say(`descendant ${process.pid} ignored ${signal}`)
    // During the wrapper's grace period the root MUST still accept a write:
    // this process is a live user of it, so deleting the root now would be
    // the orphan-with-a-deleted-TMPDIR the wrapper's contract forbids.
    try {
      writeFileSync(join(process.env.TMPDIR, `still-owned-${process.pid}.txt`), 'the temp root was still the child\'s')
      say(`descendant ${process.pid} tmpdir ok`)
    } catch (error) {
      say(`descendant ${process.pid} tmpdir failed ${error.code}`)
    }
  })
}

say(`descendant ${process.pid} ready tmpdir=${process.env.TMPDIR}`)
setInterval(() => {}, 1 << 30)
