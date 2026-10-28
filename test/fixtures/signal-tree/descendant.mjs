/**
 * A descendant that deliberately IGNORES every signal a wrapper forwards to
 * its process group: only the SIGKILL escalation can end it.
 *
 * It records its own start line and, on each ignored signal, whether the
 * wrapper's disposable temp root (its TMPDIR) still accepts a write. A wrapper
 * that deletes the root while this process runs fails that observation, which
 * is exactly the orphan it must not create.
 *
 * The log is `PROBE_MARKER`; every line starts with `descendant <pid>`. The
 * descendant ALSO records its durable identity (PID plus Linux start time) as a
 * `readPidRecords` line in the sibling `pids.log`, BEFORE it announces
 * readiness: a test-owned cleanup must never infer a start time for an old PID.
 * @module test/fixtures/signal-tree/descendant
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const marker = process.env.PROBE_MARKER
const say = (line) => appendFileSync(marker, `${line}\n`)

/**
 * This process's Linux start time, or `-` where `/proc` does not exist. Only
 * THIS process can read that field while it certainly names itself.
 */
const startTime = () => {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '-'
  } catch { return '-' }
}

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

// The identity line is written by THIS process, synchronously, and is complete
// before readiness is announced. It lives next to the marker, in the same
// per-test fixture directory, so it can never be shared across tests.
appendFileSync(join(dirname(marker), 'pids.log'), `descendant ${process.pid} ${startTime()}\n`)
say(`descendant ${process.pid} ready tmpdir=${process.env.TMPDIR}`)
setInterval(() => {}, 1 << 30)
