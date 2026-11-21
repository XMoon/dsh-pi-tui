/**
 * The shared per-Agent TUI system-prompt section installer (M6 PR-C C2).
 *
 * Direct and Split Host both install the FOUR TUI-owned communication
 * sections through this one neutral `app/` implementation, so the assembled
 * model-facing text can never diverge between the backends. The pure text and
 * policy derivation stays in `domain/communication/**`; this module owns only
 * the per-Turn eligibility/focus evaluation and the section registration.
 *
 * Per-Turn policy (the accepted Owner Focus ruling):
 *
 * ```text
 * turn/start  -> snapshotVoters(agent.session)  => { eligible, focus } FROZEN
 *               for exactly this Turn (the three preference axes stay LIVE
 *               provider reads at each assembly)
 * turn/end    -> the latch clears
 * eligible    -> all four section texts participate (progress empty under focus)
 * !eligible   -> NONE of the four section texts participates (empty text)
 * ```
 *
 * The registrations may exist per Agent while their text is empty on
 * non-TUI turns: section presence is not a claim of rendered text. The
 * `{{provider}}`/`{{model}}` variables stay owned by the official
 * `dsh-system-prompt` seam; this module never interpolates.
 *
 * `src/app/direct/system-prompt.ts` is the compatibility adapter for the
 * public `composeAgent` helper and the existing tests; the Host installer is
 * `src/app/host/features/agent-prompt.ts`. Neither may duplicate the section
 * names, orders or texts owned here.
 *
 * @module @xmoon76/dsh-pi-tui/app/agent/prompt-sections
 */

import {
  PROGRESS_UPDATES_SECTION_NAME,
  PROGRESS_UPDATES_SECTION_ORDER,
  RESPONSE_STYLE_SECTION_NAME,
  RESPONSE_STYLE_SECTION_ORDER,
  progressUpdatesPromptText,
  responseStylePromptText,
  type ProgressUpdatesState,
  type ResponseStyleState,
} from '../../domain/communication/policy.ts'
import {
  FOCUS_SECTION_NAME,
  FOCUS_SECTION_ORDER,
  focusPromptText,
} from '../../domain/communication/focus.ts'
import {
  GIT_ATTRIBUTION_SECTION_NAME,
  GIT_ATTRIBUTION_SECTION_ORDER,
  gitAttributionPromptText,
  type GitAttributionState,
} from '../../domain/communication/git-attribution.ts'
import type { DisplayState } from '../../domain/display/preset.ts'

/** The turn-scoped eligibility snapshot the shared evaluator folds. */
export interface TuiPromptTurnSnapshot {
  /** Whether at least one current verified TUI viewer exists for this Turn. */
  readonly eligible: boolean
  /** Whether at least one such viewer's display is Focus (any-Focus-wins). */
  readonly focus: boolean
}

/**
 * The caller-owned per-Turn policy input: the FROZEN turn snapshot, or
 * `undefined` outside a Turn (every section text then stays empty).
 */
export interface TuiPromptTurnPolicy {
  currentTurn(): TuiPromptTurnSnapshot | undefined
}

/** The caller-owned LIVE preference reads (providers, never snapshots). */
export interface TuiPromptLiveStates {
  readonly progressUpdates: () => ProgressUpdatesState
  readonly responseStyle: () => ResponseStyleState
  readonly gitAttribution: () => GitAttributionState
}

/** The `systemPrompt.section` surface this installer needs (structural). */
export interface SystemPromptLike {
  section(section: {
    name: string
    order: number
    text: string | ((context: unknown) => string)
    complete?: boolean
  }): () => void
}

/**
 * The always-eligible live-display policy used by the public `composeAgent`
 * compatibility adapter and the existing section tests: the display state IS
 * the frozen snapshot, evaluated live (the pre-C2 semantics).
 */
export function liveDisplayTurnPolicy(displayState: DisplayState): TuiPromptTurnPolicy {
  return {
    currentTurn: () => ({
      eligible: true,
      focus: displayState.preset === 'focus',
    }),
  }
}

/** The ephemeral display input one frozen Turn focus implies. */
function turnDisplay(turn: TuiPromptTurnSnapshot): DisplayState {
  return { preset: turn.focus ? 'focus' : 'full' }
}

/** The effective progress text of one Turn (empty when not eligible). */
export function turnProgressText(
  turn: TuiPromptTurnSnapshot | undefined,
  state: ProgressUpdatesState,
): string {
  if (turn === undefined || !turn.eligible) return ''
  return progressUpdatesPromptText(turnDisplay(turn), state)
}

/** The effective response-style text of one Turn (empty when not eligible). */
export function turnResponseStyleText(
  turn: TuiPromptTurnSnapshot | undefined,
  state: ResponseStyleState,
): string {
  if (turn === undefined || !turn.eligible) return ''
  return responseStylePromptText(state)
}

/** The effective git-attribution text of one Turn (empty when not eligible). */
export function turnGitAttributionText(
  turn: TuiPromptTurnSnapshot | undefined,
  state: GitAttributionState,
): string {
  if (turn === undefined || !turn.eligible) return ''
  return gitAttributionPromptText(state)
}

/** The effective Focus text of one Turn (empty when not eligible). */
export function turnFocusText(
  turn: TuiPromptTurnSnapshot | undefined,
): string {
  if (turn === undefined || !turn.eligible) return ''
  return focusPromptText(turnDisplay(turn))
}

/**
 * Register the progress-updates section under one Turn policy. The state is a
 * PROVIDER read at every assembly: a preference change is seen by the next
 * model step without re-composition (the Host reads the canonical refs per
 * call; Direct passes its live holder).
 */
export function installProgressUpdatesSection(
  systemPrompt: SystemPromptLike,
  turn: TuiPromptTurnPolicy,
  state: () => ProgressUpdatesState,
): () => void {
  return systemPrompt.section({
    name: PROGRESS_UPDATES_SECTION_NAME,
    order: PROGRESS_UPDATES_SECTION_ORDER,
    text: () => turnProgressText(turn.currentTurn(), state()),
  })
}

/** Register the response-style section; each assembly reads the live state. */
export function installResponseStyleSection(
  systemPrompt: SystemPromptLike,
  turn: TuiPromptTurnPolicy,
  state: () => ResponseStyleState,
): () => void {
  return systemPrompt.section({
    name: RESPONSE_STYLE_SECTION_NAME,
    order: RESPONSE_STYLE_SECTION_ORDER,
    text: () => turnResponseStyleText(turn.currentTurn(), state()),
  })
}

/** Register the git-attribution section; each assembly reads the live state. */
export function installGitAttributionSection(
  systemPrompt: SystemPromptLike,
  turn: TuiPromptTurnPolicy,
  state: () => GitAttributionState,
): () => void {
  return systemPrompt.section({
    name: GIT_ATTRIBUTION_SECTION_NAME,
    order: GIT_ATTRIBUTION_SECTION_ORDER,
    text: () => turnGitAttributionText(turn.currentTurn(), state()),
  })
}

/**
 * Register the Focus behavioral section under one Turn policy. It is
 * deliberately NOT `complete` (it must never replace the harness
 * identity/persona/tool guidance) and NOT dynamic context.
 */
export function installFocusSection(
  systemPrompt: SystemPromptLike,
  turn: TuiPromptTurnPolicy,
): () => void {
  return systemPrompt.section({
    name: FOCUS_SECTION_NAME,
    order: FOCUS_SECTION_ORDER,
    text: () => turnFocusText(turn.currentTurn()),
  })
}

/** The four TUI section registrations ONE agent composition installs. */
export interface TuiPromptSectionInput {
  readonly systemPrompt: SystemPromptLike
  readonly turn: TuiPromptTurnPolicy
  readonly live: TuiPromptLiveStates
}

/**
 * Register the four TUI-owned sections on one Agent's scoped prompt registry.
 * Names and orders are fixed (progress 80 / response 81 / git 82 / Focus 90);
 * every text provider reads the LIVE preference state AND the frozen Turn
 * snapshot at each assembly. The disposer list is registration order.
 */
export function installTuiPromptSections(input: TuiPromptSectionInput): readonly (() => void)[] {
  const { systemPrompt, turn, live } = input
  return [
    installProgressUpdatesSection(systemPrompt, turn, live.progressUpdates),
    installResponseStyleSection(systemPrompt, turn, live.responseStyle),
    installGitAttributionSection(systemPrompt, turn, live.gitAttribution),
    installFocusSection(systemPrompt, turn),
  ]
}
