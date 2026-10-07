/**
 * Pure Tern terminal facts (plan §3.1): the ANSI-path terminal identity and
 * the terminal sequences Tern consumes. Tern is recognized ONLY by
 * `TERM_PROGRAM=tern` — never by TSP probing, plugin IPC, a version gate or
 * an SSH heuristic, and never by a generic terminal-capability framework.
 *
 * The sequences built here are TERMINAL PROTOCOL output: callers own the
 * terminal-presentation lifecycle (when a sequence may physically be
 * written). This module never writes.
 * @module @xmoon76/dsh-pi-tui/tui/terminal/tern
 */

import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TerminalProgressState } from '@xmoon76/pi-tui'
import type { RunPhase } from '../../domain/status/types.ts'

/**
 * Whether the terminal identifies itself as Tern. Matched case-insensitively
 * (`TERM_PROGRAM=tern`); every other program — and an absent one — is false.
 * The ONE Tern identity implementation, shared by the notification method
 * resolver and the terminal-cwd/progress projections.
 */
export function isTernTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TERM_PROGRAM ?? '').toLowerCase() === 'tern'
}

/**
 * The OSC 7 sequence reporting `cwd` as the pane's current directory, or
 * `undefined` when `cwd` is not a usable absolute path. The payload is a
 * `file://` URL built through Node's path/URL primitives — spaces, `#`, `%`,
 * Unicode and every control character are percent-encoded, so an arbitrary
 * cwd can never terminate or escape the OSC sequence. No hostname is
 * synthesized: an empty authority means "this host", which is exactly the
 * pane's own host.
 */
export function ternCwdSequence(cwd: string): string | undefined {
  if (cwd === '' || cwd.includes('\0') || !isAbsolute(cwd)) return undefined
  return `\x1b]7;${pathToFileURL(cwd).href}\x07`
}

/**
 * The OSC 9;4 state Tern should show for the authoritative main-Agent running
 * truth, the canonical surface `RunPhase` and the PROVENANCE of the wait that
 * owns the response surface (plan §6.2 + the Agent-blocking-wait addendum §20).
 * This is a presentation-only mapping — the running flag stays PR #230's
 * main-Agent fence and no second semantic authority is introduced:
 *
 * - not running               -> `clear`
 * - running + an Agent-BLOCKING wait phase -> `paused` (Tern `waiting_input`)
 * - running + anything else   -> `indeterminate` (Tern `working`)
 *
 * The phase alone is NOT enough: `waiting-question` only means "a question owns
 * the response surface", which is also true for a Client-local flow (`/login`
 * authorization, a plugin confirm) AND for a CONTINUED late-answer form whose
 * Agent already continued. Only a caller that owns the interaction lifecycle can
 * prove the main Agent is BLOCKED on the input (`agentInputWait`), so neither a
 * local dialog nor a continued question can claim the pane's `waiting_input`.
 */
export function ternProgressState(
  running: boolean,
  phase: RunPhase,
  agentInputWait: boolean,
): TerminalProgressState {
  if (!running) return 'clear'
  const waitPhase = phase === 'waiting-approval' || phase === 'waiting-question'
  return waitPhase && agentInputWait ? 'paused' : 'indeterminate'
}
