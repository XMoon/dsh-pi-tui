/**
 * A REAL executable fake Herdr CLI for the H1 reporter tests.
 *
 * The fixture only owns the external-process contract of the test: it writes
 * one executable Node script into a test-owned temporary root, exposes the
 * Herdr environment that qualifies it, and parses the invocation log the script
 * appends. It deliberately knows nothing about `ProgramStatus`, the TuiApp or
 * any Agent semantic — the production reporter must do all of that work.
 *
 * Each script invocation appends one `start` line (its full argv) before the
 * configured delay and one `end` line when it exits. The ordered start/end
 * lines make concurrency observable: a reporter that spawns a second child
 * while the first is still running produces two `start` lines with no `end`
 * between them.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/herdr-cli-fixture
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { testLifecycle } from './temp-lifecycle.ts'

/** One log line a fake invocation wrote. */
export interface HerdrCliEntry {
  readonly phase: 'start' | 'end'
  readonly pid: number
  /** The args after the script path (only on `start`). */
  readonly argv?: readonly string[]
  /** The script's exit code (only on `end`). */
  readonly code?: number
}

/** The fixture options one test controls. */
export interface HerdrCliFixtureOptions {
  /** The Pane id injected as `HERDR_PANE_ID` (defaults to a unique id). */
  readonly paneId?: string
  /** Delay of the FIRST invocation, in ms (default 0). */
  readonly firstDelayMs?: number
  /** Delay of every later invocation, in ms (default 0). */
  readonly delayMs?: number
  /** Process exit code every invocation uses (default 0). */
  readonly exitCode?: number
  /** An explicit CLI path override (the `spawn ENOENT` negative control). */
  readonly binPath?: string
}

export interface HerdrCliFixture {
  /** The executable the reporter must spawn. */
  readonly binPath: string
  /** The Pane id this fixture's environment declares. */
  readonly paneId: string
  /** The complete spawned environment: process env + Herdr + fake controls. */
  readonly env: NodeJS.ProcessEnv
  /** The marker log path. */
  readonly logPath: string
  /** Every complete log line, in write order. */
  entries(): HerdrCliEntry[]
  /** Every `start` entry (one per spawned child). */
  starts(): HerdrCliEntry[]
  /** Wait until `predicate(entries)` holds. Bounded; never a busy sleep loop. */
  waitFor(predicate: (entries: readonly HerdrCliEntry[]) => boolean, label: string, deadlineMs?: number): Promise<void>
}

/** The fake CLI source: append the full argv, wait, then exit with the code. */
const FAKE_CLI_SOURCE = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'

const log = process.env.HERDR_FAKE_LOG
const argv = process.argv.slice(2)
let prior = 0
try {
  prior = readFileSync(log, 'utf8').split('\\n').filter(line => line !== '').length
} catch {
  prior = 0
}
const first = Number(process.env.HERDR_FAKE_FIRST_DELAY_MS ?? '0')
const delay = Number(process.env.HERDR_FAKE_DELAY_MS ?? '0')
const code = Number(process.env.HERDR_FAKE_EXIT_CODE ?? '0')
appendFileSync(log, JSON.stringify({ phase: 'start', pid: process.pid, argv }) + '\\n')
setTimeout(() => {
  appendFileSync(log, JSON.stringify({ phase: 'end', pid: process.pid, code }) + '\\n')
  process.exit(code)
}, prior === 0 ? first : delay)
`

/**
 * Create the fake CLI in the test's own temp root. The caller uses
 * `fixture.env` for `createHerdrReporter` and reads invocations through the
 * same fixture.
 */
export function createHerdrCliFixture(t: TestContext, options: HerdrCliFixtureOptions = {}): HerdrCliFixture {
  const life = testLifecycle(t)
  const root = life.tempDir('herdr-cli-')
  const logPath = join(root, 'invocations.jsonl')
  writeFileSync(logPath, '', { mode: 0o600 })
  const scriptPath = join(root, 'fake-herdr.mjs')
  writeFileSync(scriptPath, FAKE_CLI_SOURCE, { mode: 0o755 })
  chmodSync(scriptPath, 0o755)
  const paneId = options.paneId ?? `pane-${String(process.pid)}-${Date.now().toString(36)}`
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERDR_ENV: '1',
    HERDR_PANE_ID: paneId,
    HERDR_BIN_PATH: options.binPath ?? scriptPath,
    HERDR_SOCKET_PATH: join(root, 'herdr.sock'),
    HERDR_FAKE_LOG: logPath,
    HERDR_FAKE_FIRST_DELAY_MS: String(options.firstDelayMs ?? 0),
    HERDR_FAKE_DELAY_MS: String(options.delayMs ?? 0),
    HERDR_FAKE_EXIT_CODE: String(options.exitCode ?? 0),
  }
  const entries = (): HerdrCliEntry[] => {
    if (!existsSync(logPath)) return []
    const lines = readFileSync(logPath, 'utf8').split('\n')
    const parsed: HerdrCliEntry[] = []
    for (const line of lines) {
      if (line === '') continue
      try {
        parsed.push(JSON.parse(line) as HerdrCliEntry)
      } catch {
        // The last line can be mid-append; it is not observable evidence yet.
      }
    }
    return parsed
  }
  return {
    binPath: env.HERDR_BIN_PATH ?? '',
    paneId,
    env,
    logPath,
    entries,
    starts: () => entries().filter(entry => entry.phase === 'start'),
    async waitFor(predicate, label, deadlineMs = 10_000) {
      const deadline = Date.now() + deadlineMs
      for (;;) {
        if (predicate(entries())) return
        if (Date.now() > deadline) {
          throw new Error(`${label} did not occur within ${String(deadlineMs)}ms; the log is:\n${readFileSync(logPath, 'utf8')}`)
        }
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      }
    },
  }
}
