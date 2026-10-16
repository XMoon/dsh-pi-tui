/**
 * PR3-B B2-4: the TSP renderer's TUI-builtin capability predicate.
 *
 * The TSP renderer (PR3-B) presents no PiTui chrome, so a TUI-OWNED builtin
 * whose implementation is a PiTui panel/picker cannot run there. This module
 * answers exactly ONE question, for ONE already-decided winner:
 *
 *     "is this SELECTED TUI builtin available on the mounted TSP renderer?"
 *
 * It is deliberately NOT a parser and NOT a routing authority:
 *
 * - it never inspects the raw line, never re-classifies, and never consults
 *   `hostClaimOf`/the display-completion union — the caller passes the
 *   AUTHORITATIVE winner (the existing classifier's `client-command` +
 *   `source: 'tui'` result) and the parsed name it selected;
 * - it does not decide whether a line IS a TUI builtin (the existing command
 *   authority owns that, so a genuine Host-origin command with the same
 *   spelling is never captured here);
 * - it holds no state and performs no IO.
 *
 * The unconditional set is the two exit builtins. Native Model, Preset and
 * Session Browser commands are admitted only when their mounted presenters
 * are available; every other TUI builtin is refused.
 * @module @xmoon76/dsh-pi-tui/app/command/tsp-capability
 */

import type { CommandLineClassification } from '../../domain/command/policy.ts'

/**
 * The TUI builtins the TSP renderer can execute in PR3-B. `/quit` is
 * `/exit`'s canonical alias (the runner registers both); both route the
 * EXISTING exit orchestration, which needs no PiTui chrome.
 */
export const TSP_SUPPORTED_TUI_BUILTINS: ReadonlySet<string> = new Set(['exit', 'quit'])

/**
 * Which native TUI builtin presenters the mounted renderer actually installed.
 * A capability is admitted only when the presenter exists, so a renderer that
 * lacks the node kinds (or never mounted the picker) refuses the command instead
 * of running a handler that would dereference a `TuiApp` that is not there.
 *
 * The whole `/preset` command FAMILY (`/preset`, `/preset <id>`, `/preset
 * status`, `/preset default [<id>]`) rides the ONE `preset` entry, because the
 * registered command family shares this name: no typed verb gets a raw-string
 * bypass around the classification.
 */
export interface TspBuiltinPickers {
  readonly modelPicker?: boolean
  readonly presetPicker?: boolean
  readonly sessionBrowser?: boolean
}

/**
 * What the predicate concluded. THREE states, so a caller cannot mistake
 * "this is not a TUI builtin at all" for "this TUI builtin is unsupported":
 * the family is part of the RESULT, not something the caller may forget to
 * check (the B2 review's F1 — the previous two-state shape let a consumer
 * refuse every Host/skill/extension/ordinary slash line).
 */
export type TspBuiltinAvailability =
  /** The line is not a TUI-owned builtin: the caller keeps its own routing. */
  | { readonly kind: 'not-a-tui-builtin' }
  /** A TUI-owned builtin supported by the mounted renderer. */
  | { readonly kind: 'available' }
  /** A TUI-owned builtin that needs PiTui UI the TSP renderer lacks. */
  | { readonly kind: 'unsupported' }

/**
 * Whether one ALREADY-AUTHORITATIVELY-SELECTED TUI builtin can run on the TSP
 * renderer.
 *
 * @param classification - the existing classifier's result for this exact
 *   line (the winner). Only the `client-command` + `source: 'tui'` family is
 *   in scope: a Host command, a Client extension contribution, a skill
 *   invocation or an ordinary submission is NOT this predicate's business and
 *   is reported unavailable-by-family so the caller never routes it here (the
 *   caller checks the family first — see the production consumer).
 * @param name - the parsed builtin name the classifier selected.
 * @param pickers - which native presenters the mounted renderer installed.
 */
export function tspBuiltinAvailability(
  classification: CommandLineClassification,
  name: string,
  pickers: TspBuiltinPickers = {},
): TspBuiltinAvailability {
  if (classification.kind !== 'client-command' || classification.source !== 'tui') {
    // Not a TUI builtin: a Host command, an extension contribution, a skill
    // invocation or an ordinary submission keeps its OWN routing. The caller
    // must branch on this kind — it is the family decision, made once here.
    return { kind: 'not-a-tui-builtin' }
  }
  return TSP_SUPPORTED_TUI_BUILTINS.has(name)
    || (name === 'model' && pickers.modelPicker === true)
    || (name === 'preset' && pickers.presetPicker === true)
    || ((name === 'sessions' || name === 'resume' || name === 'search') && pickers.sessionBrowser === true)
    ? { kind: 'available' }
    : { kind: 'unsupported' }
}
