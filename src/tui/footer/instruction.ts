/**
 * The Host Instruction Surface: Host-owned temporary prompts that the user
 * can NEVER hide through footer configuration — the keyboard
 * exit-confirmation hint first, more later. The instruction is a transient
 * OVERLAY of the Footer's last EXISTING physical row: the normal layout is
 * rendered first with its full budget, then that final row is replaced for
 * the duration of the state and the original row returns when it clears.
 * The only exception is an otherwise row-less Footer with a positive
 * budget, where the instruction paints one line so the exit confirmation
 * never becomes invisible.
 * @module @xmoon76/dsh-pi-tui/tui/footer/instruction
 */

import type { FooterSpan } from './presentation-types.ts'

/** One Host instruction. */
export interface FooterInstruction {
  readonly id: string
  readonly text: readonly FooterSpan[]
  readonly priority: number
}

/** The host state the resolver reads (structural — the TuiApp's fields). */
export interface FooterInstructionHostState {
  /** The formatted effective key whose exit confirmation is armed. */
  readonly exitConfirmKeyLabel?: string
  /** Whether the subagent viewer is open (the exit hint is meaningless
   * there — parent exit requests are inert inside the viewer). */
  readonly viewing: boolean
  /** The M6 which-key hint for a PENDING leader sequence, already
   * formatted by the caller. It resolves BESIDE the exit hint (the armed
   * exit hint outranks it), and whichever wins transiently REPLACES the
   * last existing Footer physical row — it never reserves or appends a row
   * of its own. Suppressed while viewing, like the exit hint. */
  readonly leaderHint?: string
}

/** Resolve the active Host instruction, if any. */
export function resolveFooterInstruction(
  state: FooterInstructionHostState,
): FooterInstruction | undefined {
  if (state.exitConfirmKeyLabel !== undefined && !state.viewing) {
    return {
      id: 'exit-confirm',
      text: [
        { text: 'Press ' },
        { text: state.exitConfirmKeyLabel, emphasis: 'strong' },
        { text: ' again to exit' },
      ],
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
