/**
 * OSC 7501 Program Status encoding (protocol revision 0.3).
 *
 * Pure terminal-TERMINAL protocol output: this module maps the authoritative
 * presentation facts onto the closed record vocabulary and encodes the exact
 * escape sequence. It never writes, never probes the terminal and never holds
 * state — the terminal-presentation lifecycle stays owned by the caller.
 *
 * Only the ROOT record is emitted (`id` omitted, `app` fixed): `state` (and
 * `kind` for `blocked`) already distinguishes the semantic situations, so the
 * free-text fields would add privacy and escaping burden without a consumer.
 * @module @xmoon76/dsh-pi-tui/tui/terminal/program-status
 */

import type { TerminalProgressOutcome } from '../../domain/terminal-progress/settings.ts'
import type { RunPhase } from '../../domain/status/types.ts'

/** The closed OSC 7501 root-record vocabulary this TUI reports. */
export type ProgramStatus =
  | { state: 'idle' | 'working' | 'done' | 'error' }
  | { state: 'blocked'; kind: 'permission' | 'question' }
  | { state: 'clear' }

/** The fixed application identity carried by every non-clear record. */
const PROGRAM_STATUS_APP = 'dsh-pi-tui'

/** Encode one program-status record as its exact OSC 7501 sequence. `clear`
 *  retires the root record with no further fields; every other state carries
 *  the fixed `app` identity and, for `blocked`, its `kind`. */
export function programStatusSequence(report: ProgramStatus): string {
  if (report.state === 'clear') return '\x1b]7501;state=clear\x1b\\'
  const pairs = [`state=${report.state}`]
  if (report.state === 'blocked') pairs.push(`kind=${report.kind}`)
  pairs.push(`app=${PROGRAM_STATUS_APP}`)
  return `\x1b]7501;${pairs.join(':')}\x1b\\`
}

/**
 * Derive the OSC 7501 record from the authoritative presentation facts:
 * the main-Agent running truth, the canonical surface `RunPhase`, the
 * lifecycle-owned `agentInputWait` fact and the already-settled outcome of the
 * current running interval.
 *
 * A non-running Agent can only report `idle`/`done`/`error` — a true
 * `blocked` requires a LIVE wait the Agent is stopped on. `working` covers
 * everything else, including a Client-local modal and a CONTINUED late answer
 * whose Agent already moved on.
 *
 * Pure.
 */
export function deriveProgramStatus(
  running: boolean,
  phase: RunPhase,
  agentInputWait: boolean,
  settled: TerminalProgressOutcome,
): ProgramStatus {
  if (!running) return { state: settled }
  if (agentInputWait && phase === 'waiting-approval') return { state: 'blocked', kind: 'permission' }
  if (agentInputWait && phase === 'waiting-question') return { state: 'blocked', kind: 'question' }
  return { state: 'working' }
}

/** Whether two records are the SAME semantic presentation (state + kind), the
 *  only dedupe key the writer needs. */
export function sameProgramStatus(left: ProgramStatus, right: ProgramStatus): boolean {
  if (left.state !== right.state) return false
  if (left.state === 'blocked' && right.state === 'blocked') return left.kind === right.kind
  return true
}
