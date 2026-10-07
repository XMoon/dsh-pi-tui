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
 * truth refined by the canonical RunPhase (plan §6.2). This is a
 * presentation-only mapping: `running` stays PR #230's main-Agent fence, and
 * the phase only WIDENS an already-running state to Tern's `waiting_input`
 * (`paused`). Idle wins over any phase, so a stale phase can never keep a
 * retired owner busy:
 *
 * - not running          -> `clear`
 * - running + a wait     -> `paused` (Tern `waiting_input`)
 * - running + any other  -> `indeterminate` (Tern `working`)
 */
export function ternProgressState(running: boolean, phase: RunPhase): TerminalProgressState {
  if (!running) return 'clear'
  if (phase === 'waiting-approval' || phase === 'waiting-question') return 'paused'
  return 'indeterminate'
}
