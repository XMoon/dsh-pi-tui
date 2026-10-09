/**
 * PR3-B B2-4: the TSP renderer's TUI-builtin capability predicate.
 *
 * The TSP renderer (PR3-B) presents no PiTui chrome, so a TUI-OWNED builtin
 * whose implementation is a PiTui panel/picker cannot run there. This module
 * answers exactly ONE question, for ONE already-decided winner:
 *
 *     "is this SELECTED TUI builtin available on the TSP renderer in B?"
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
 * The B2 supported set is exactly the two exit builtins; every other
 * TUI-origin builtin is refused with the caller's actionable notice.
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
 * What the predicate concluded. THREE states, so a caller cannot mistake
 * "this is not a TUI builtin at all" for "this TUI builtin is unsupported":
 * the family is part of the RESULT, not something the caller may forget to
 * check (the B2 review's F1 — the previous two-state shape let a consumer
 * refuse every Host/skill/extension/ordinary slash line).
 */
export type TspBuiltinAvailability =
  /** The line is not a TUI-owned builtin: the caller keeps its own routing. */
  | { readonly kind: 'not-a-tui-builtin' }
  /** A TUI-owned builtin the TSP renderer can run (the exit pair). */
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
 */
export function tspBuiltinAvailability(
  classification: CommandLineClassification,
  name: string,
): TspBuiltinAvailability {
  if (classification.kind !== 'client-command' || classification.source !== 'tui') {
    // Not a TUI builtin: a Host command, an extension contribution, a skill
    // invocation or an ordinary submission keeps its OWN routing. The caller
    // must branch on this kind — it is the family decision, made once here.
    return { kind: 'not-a-tui-builtin' }
  }
  return TSP_SUPPORTED_TUI_BUILTINS.has(name)
    ? { kind: 'available' }
    : { kind: 'unsupported' }
}
