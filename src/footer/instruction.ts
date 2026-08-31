/**
 * The Host Instruction Surface (plan §2.4/§19): Host-owned temporary
 * prompts that the user can NEVER hide through footer configuration —
 * the Ctrl+C exit hint first, more later. Since the 2026-08-31 footer
 * rework the instruction is an INDEPENDENT surface: it reserves its own
 * physical line from the footer's global budget and appends AFTER the
 * layout rows — it never replaces (or shares a "line-2 slot" with) a
 * user row, and it always survives the height budget.
 * @module @xmoon76/dsh-pi-tui/footer/instruction
 */

import type { FooterSpan } from './types.ts'

/** One Host instruction. */
export interface FooterInstruction {
  readonly id: string
  readonly text: readonly FooterSpan[]
  readonly priority: number
}

/** The host state the resolver reads (structural — the TuiApp's fields). */
export interface FooterInstructionHostState {
  /** Whether the Ctrl+C exit chord is armed. */
  readonly ctrlCExitArmed: boolean
  /** Whether the subagent viewer is open (the exit hint is meaningless
   * there — Ctrl+C is inert inside the viewer). */
  readonly viewing: boolean
  /** The M6 which-key hint for a PENDING leader sequence, already
   * formatted by the caller. It resolves BESIDE the exit hint (an
   * explicit interaction temporarily covers spare layout lines; the
   * armed exit hint outranks it), and whichever wins APPENDS as the
   * independent reserved physical line — never a line-2 slot
   * replacement of a user row. Suppressed while viewing, like the
   * exit hint. */
  readonly leaderHint?: string
}

/** Resolve the active Host instruction, if any. */
export function resolveFooterInstruction(
  state: FooterInstructionHostState,
): FooterInstruction | undefined {
  if (state.ctrlCExitArmed && !state.viewing) {
    return {
      id: 'ctrl-c-exit',
      text: [{ text: 'Press Ctrl+C again to exit' }],
      priority: 100,
    }
  }
  if (state.leaderHint !== undefined && !state.viewing) {
    return {
      id: 'leader-which-key',
      text: [{ text: state.leaderHint }],
      priority: 90,
    }
  }
  return undefined
}
