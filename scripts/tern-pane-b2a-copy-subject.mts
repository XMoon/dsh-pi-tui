/**
 * PR4-B2-A: the real-Tern `/copy` subject.
 *
 * Boots the production Direct/TSP composition on the Tern-owned stdio
 * (`externalTern: true`) and records the facts the flow needs from INSIDE the
 * process:
 *
 *  - the process tty fact the OSC 52 leg is gated on (`stdout.isTTY`);
 *  - every chunk the application wrote to ITS OWN stdout that carried an OSC 52
 *    clipboard sequence — a ONE-TO-ONE recorder: the original write is still
 *    performed, unchanged, so the bytes really travel to the Tern-managed tty.
 *
 * Everything else (composer keys, dock/transcript observation, post-copy input
 * liveness, close flow and the tmux-buffer readback) belongs to the flow.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const paneRoot = process.env.TERN_PANE_DIR
if (paneRoot === undefined) throw new Error('TERN_PANE_DIR is required by the real Tern subject')
const workRoot = join(paneRoot, 'dsh-home')
mkdirSync(workRoot, { recursive: true })
// Set isolation before dynamically importing the DSH Host composition.
process.env.DSH_HOME = workRoot

const eventsPath = join(paneRoot, 'events.jsonl')
const note = (event: Record<string, unknown>): void => {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`)
}
process.once('exit', code => note({ kind: 'process.exit', code }))
let resolveExit!: () => void
const exitRequested = new Promise<void>(resolve => { resolveExit = resolve })
process.once('SIGTERM', () => setImmediate(resolveExit))
process.once('SIGINT', () => setImmediate(resolveExit))
let setupCleanup: (() => unknown) | undefined

const life: import('../test/support/temp-lifecycle.ts').TestLifecycle = {
  tempDir: (prefix) => { throw new Error(`external Tern fixture requires explicit workRoot, got ${prefix}`) },
  defer: cleanup => { setupCleanup = cleanup },
}

// The ONE-TO-ONE stdout recorder: record the OSC 52 payload that leaves the
// process, then perform the ORIGINAL write unchanged.
const originalWrite = process.stdout.write.bind(process.stdout)
const recorder = ((chunk: unknown, ...rest: unknown[]): boolean => {
  if (typeof chunk === 'string' && chunk.includes('\u001b]52;')) {
    note({ kind: 'stdout.osc52', chunk: JSON.stringify(chunk) })
  }
  return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest)
}) as typeof process.stdout.write
process.stdout.write = recorder

const { createDirectTspFixture } = await import('../test/support/direct-tsp-fixture.ts')

try {
  const fixture = await createDirectTspFixture(life, {
    externalTern: true,
    workRoot,
    deltas: ['COPY-ME-REAL-TERN'],
    appExit: () => {
      note({ kind: 'app.exit' })
      setImmediate(resolveExit)
    },
  })
  void fixture
  note({
    kind: 'fixture.ready',
    workRoot,
    stdoutIsTTY: process.stdout.isTTY === true,
    tmux: process.env.TMUX !== undefined,
  })
  await exitRequested
  await setupCleanup!()
  note({ kind: 'fixture.settled' })
} finally {
  await setupCleanup?.()
  process.stdout.write = originalWrite
}
