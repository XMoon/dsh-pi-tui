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
 * - it never RE-parses the line, never re-classifies, and never consults
 *   `hostClaimOf`/the display-completion union — the caller passes the
 *   AUTHORITATIVE winner (the existing classifier's `client-command` +
 *   `source: 'tui'` result), the parsed name it selected and that same parse's
 *   `rawInput`. The raw input is read for its SHAPE alone (does this exact line
 *   carry an explicit argument), never to reconstruct a command or a target;
 * - it does not decide whether a line IS a TUI builtin (the existing command
 *   authority owns that, so a genuine Host-origin command with the same
 *   spelling is never captured here);
 * - it holds no state and performs no IO.
 *
 * The unconditional set is the exit pair plus the PR4-B2-A business builtins
 * whose ENTIRE outcome is carried by the existing business owner (Session
 * runtime, SessionWriter, permission writer, credential port, clipboard
 * policy) and needs no PiTui pane. Native Model, Preset and Session Browser
 * commands are admitted only when their mounted presenters are available;
 * every other TUI builtin is refused. `/logout` is the ONE input-shaped
 * member: only its explicit-target form is admitted (see the predicate).
 * @module @xmoon76/dsh-pi-tui/app/command/tsp-capability
 */

import type { CommandLineClassification } from '../../domain/command/policy.ts'

/**
 * The TUI builtins the TSP renderer can execute without any PiTui chrome.
 * `/quit` is `/exit`'s canonical alias (the runner registers both); both
 * route the EXISTING exit orchestration.
 *
 * PR4-B2-A adds the builtins whose WHOLE closure is the existing business
 * owner — `/new` and `/fork` (Session runtime), `/title` and `/rename` (the
 * authoritative SessionWriter title write) and `/copy` (the existing
 * Client-local Clipboard Policy) and `/yolo` (the official permission-preset
 * writer). Membership here is NOT a routing authority: the caller has already
 * established the authoritative TUI winner, and the handler it then reaches
 * is the unchanged production one.
 */
export const TSP_SUPPORTED_TUI_BUILTINS: ReadonlySet<string> = new Set([
  'exit', 'quit',
  'new', 'fork', 'title', 'rename', 'copy', 'yolo',
])

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
 * @param rawInput - the SAME parsed line's `rawInput` (the text after the
 *   command name). It is the INPUT SHAPE of one exact line, never a second
 *   parse: the predicate only needs "does this line carry an explicit
 *   argument" for `/logout`, and the target itself stays the handler's own
 *   `resolveCredentialArg` business check. `/logout` is admitted ONLY in its
 *   explicit-target form — the bare command opens the credential picker the
 *   TSP renderer does not have, so it stays `unsupported` (draft restored,
 *   zero credential mutation).
 */
export function tspBuiltinAvailability(
  classification: CommandLineClassification,
  name: string,
  pickers: TspBuiltinPickers,
  rawInput: string,
): TspBuiltinAvailability {
  if (classification.kind !== 'client-command' || classification.source !== 'tui') {
    // Not a TUI builtin: a Host command, an extension contribution, a skill
    // invocation or an ordinary submission keeps its OWN routing. The caller
    // must branch on this kind — it is the family decision, made once here.
    return { kind: 'not-a-tui-builtin' }
  }
  if (TSP_SUPPORTED_TUI_BUILTINS.has(name)) return { kind: 'available' }
  if (name === 'logout') {
    // The ONE input-shaped member: `/logout <target>` runs the unchanged
    // handler's own resolver; bare `/logout` (and whitespace-only) needs the
    // credential picker and is refused BEFORE any credential read or mutation.
    return rawInput.trim().length > 0 ? { kind: 'available' } : { kind: 'unsupported' }
  }
  return (name === 'model' && pickers.modelPicker === true)
    || (name === 'preset' && pickers.presetPicker === true)
    || ((name === 'sessions' || name === 'resume' || name === 'search') && pickers.sessionBrowser === true)
    ? { kind: 'available' }
    : { kind: 'unsupported' }
}

/**
 * PR4-B2-A: whether the ADDITIONAL inline outcome notice for a `/title` /
 * `/rename` result is suppressed on this mount because the official Direct
 * command-result card already carries the same text.
 *
 * Both terms are composition facts, not renderer guesses:
 *
 * - `backendKind === 'direct'`: a TUI-owned `/title` is NOT sessionless, so on
 *   the Direct branch it always executes through `commandPlane.execute` — the
 *   official executor appends the `command/run` + `command/done` pair, and
 *   `src/tui/tsp/transcript-view.ts` paints that pair as the command card whose
 *   body IS the handler's `CommandResult.text` (success text and error text
 *   alike). The Remote branch executes the same command through the Client
 *   registry, which appends no lifecycle event and therefore paints no card —
 *   there the handler's notice is the only feedback.
 * - `!pituiPresentation`: the PiTui surface keeps its long-standing notice
 *   beside that card, unchanged.
 *
 * This is deliberately NOT a general "the card owns the outcome" capability:
 * it answers the suppression question for the title handler alone (the
 * `notifyTitleResult` sink), and it must not be inferred for other commands or
 * for sessionless local invocations (those paint no card even on Direct — the
 * controller notifies their errors itself).
 *
 * @param facts - the composition root's declared inputs: whether a PiTui
 *   presentation is mounted and which backend the command plane belongs to.
 */
export function titleResultNoticeSuppressed(facts: {
  readonly pituiPresentation: boolean
  readonly backendKind: 'direct' | 'remote'
}): boolean {
  return !facts.pituiPresentation && facts.backendKind === 'direct'
}
