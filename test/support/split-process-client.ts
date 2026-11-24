/**
 * The native terminal, official-record and exit primitives the two real
 * non-Pilot scenes share.
 *
 * This module owns exactly three questions:
 *   - how one `xtermjs` tui-test handle is created for a Scene,
 *   - how the official surface-Client JSONL ledger is parsed,
 *   - how the real native child exit fact is awaited.
 *
 * It holds no business Scene, Host, install target or registry: the calling
 * owner performs `run()`, registers the session/ownership and decides when a
 * Client may be closed. It is deliberately Vitest-free and plain TypeScript
 * with erasable syntax only, so the Upgrade probe worker and the Split
 * Supervisor can load it through the pinned Node type-stripping loader.
 *
 * @module split-process-client
 */

import { existsSync, readFileSync } from 'node:fs'

import { TuiTest } from '@microsoft/tui-test'

/** One Scene-owned native terminal handle and its process-local session name. */
export interface SplitTerminal {
  readonly terminal: TuiTest
  /** `terminal.session`: the native session identity, never a PID. */
  readonly sessionId: string
}

export interface SplitTerminalOptions {
  /** Session-name prefix; tui-test appends `-<pid>-<random>-<counter>` (max 64 chars). */
  readonly prefix: string
  /** Existing Scene-owned directory for on-failure traces. */
  readonly traceDirectory: string
  /** Existing Scene-owned directory for on-failure `text` artifacts. */
  readonly artifactsDirectory: string
}

/**
 * Create the ONE native terminal handle for a Scene-owned Client.
 *
 * The handle starts no process: the owner calls `run()` and registers the
 * returned session identity before any await, exactly like the Pilot, Upgrade
 * and Split-process scenes each do for their own lifecycle.
 */
export function createSplitTerminal(options: SplitTerminalOptions): SplitTerminal {
  const terminal = TuiTest.ephemeral(options.prefix, {
    backend: 'xtermjs',
    trace: { mode: 'on-failure', directory: options.traceDirectory },
    artifacts: { dir: options.artifactsDirectory, onFailure: 'text' },
  })
  return { terminal, sessionId: terminal.session }
}

/**
 * Parse the official surface-Client JSONL ledger.
 *
 * - a missing or empty file is `[]` (the producer creates it on the first
 *   record, so a startup read legitimately precedes it);
 * - a final line without `\n` is a torn append: it throws by default, and only
 *   a STREAMING consumer that will read again may pass
 *   `{ allowIncompleteTail: true }` to ignore that tail;
 * - every complete line must be one JSON object, otherwise this throws with its
 *   1-based line number and the parser message — a malformed complete line is
 *   never skipped.
 *
 * The reader deliberately performs no schema, PID, ownership or symlink
 * validation: those belong to the caller's business contract.
 */
export function readOfficialClientRecords(
  recordFile: string,
  label: string,
  options: { allowIncompleteTail?: boolean } = {},
): Record<string, any>[] {
  if (!existsSync(recordFile)) return []
  const text = readFileSync(recordFile, 'utf8')
  if (text === '') return []
  let complete = text
  if (!text.endsWith('\n')) {
    if (options.allowIncompleteTail !== true) {
      throw new Error(`${label}: the official client record file has an incomplete trailing line`)
    }
    const lastBreak = text.lastIndexOf('\n')
    complete = lastBreak < 0 ? '' : text.slice(0, lastBreak + 1)
    if (complete === '') return []
  }
  return complete.slice(0, -1).split('\n').map((line, index) => {
    try {
      return JSON.parse(line) as Record<string, any>
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${label}: client record line ${String(index + 1)} is invalid JSON: ${message}`)
    }
  })
}

/** The real native tui-test child exit fact. */
export interface TerminalExitFacts {
  /** The native exit code, returned only once `state().exited !== null`. */
  readonly code: number | null
  /** The native exit signal name, `null` when the child was not signalled. */
  readonly signal: string | null
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Await the real native child exit fact.
 *
 * A rejected `state()` read is "not observed yet", never a verdict. This never
 * submits `/exit`, never closes the session and never asserts the exit code;
 * the caller owns every exit/close policy.
 */
export async function waitForTerminalExit(
  terminal: TuiTest,
  label: string,
  timeoutMs = 120_000,
): Promise<TerminalExitFacts> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = await terminal.state().catch(() => undefined)
    if (state !== undefined && state.exited !== null) {
      return { code: state.exited, signal: state.exit_signal ?? null }
    }
    await sleep(50)
  }
  throw new Error(`${label}: the real tui-test shell did not exit within ${String(timeoutMs)}ms`)
}
