/**
 * The ONE Client-local Exit Choice surface (M6 UX PR1).
 *
 * This module owns the renderer-neutral model and copy of the exit/disconnect
 * choice. It is a CLIENT-LOCAL presentation surface: the business decision
 * (which choice is legal, which Session it addresses, whether work is really
 * stopped) stays with the exit-intent coordinator
 * (`src/app/bootstrap/exit-intent.ts`); a renderer only paints the model and
 * forwards the ONE selection callback. No Host port, Remote RPC or extension
 * API is introduced here.
 *
 * The model is deliberately small: one of two exit families (daemon/direct)
 * times the proven activity (busy / unknown), plus the Client-owned user-shell
 * blocker and the transient phases one choice can pass through (asking,
 * stopping, unconfirmed). Options are
 * semantic ids so a renderer never derives a business action from a label.
 *
 * @module @xmoon76/dsh-pi-tui/app/surface/exit-choice
 */

/** The exit family and proven state one choice presents. */
export type ExitChoiceKind = 'daemon-busy' | 'direct-busy' | 'daemon-unknown' | 'direct-unknown'

/**
 * One actable option of the choice.
 * - `keep-and-disconnect`: leave THIS daemon Client, send no Host cancel.
 * - `stop-and-disconnect`: stop the captured Session once, prove it idle,
 *   then leave the daemon Client.
 * - `stay`: close the choice with zero Host writes and zero exit.
 * - `disconnect-without-stop`: the only daemon act after an unconfirmable
 *   stop (or an unobservable running state); never claims work was stopped.
 * - `stop-and-exit`: Direct Stop through the EXISTING exit controller (its
 *   owned-session retirement does the only cancel).
 * - `exit-local`: Direct exit that retires the in-process local Host; used
 *   when the activity cannot be verified, without claiming work was stopped.
 */
export type ExitChoiceOption =
  | 'keep-and-disconnect'
  | 'stop-and-disconnect'
  | 'stay'
  | 'disconnect-without-stop'
  | 'stop-and-exit'
  | 'exit-local'

/** One painted option: the full label and the compact narrow-width label. */
export interface ExitChoiceOptionView {
  readonly id: ExitChoiceOption
  readonly label: string
  readonly shortLabel: string
}

/** The transient phase of one open choice. */
export type ExitChoicePhase = 'choose' | 'stopping' | 'unconfirmed'

/**
 * The complete renderer-facing model of ONE open choice. Every field is a
 * value the coordinator committed; a renderer never reads a Host fact.
 */
export interface ExitChoiceModel {
  readonly kind: ExitChoiceKind
  readonly phase: ExitChoicePhase
  /** One-line overlay title. */
  readonly title: string
  /** Body paragraphs, already final English copy. */
  readonly body: readonly string[]
  /** The ONE short risk/status line used when the box cannot host the full body
   *  (a low-height terminal). Always a subset of the same contract. */
  readonly shortBody: string
  /** One status/detail line (a proven refusal, or the Stop progress line). */
  readonly status: string | undefined
  /** Whether the asking frame carries the running-user-shell reminder. */
  readonly shellRunning: boolean
  /** The actable options in keyboard order; empty while stopping. */
  readonly options: readonly ExitChoiceOptionView[]
  /** The initial focus (never a destructive Stop for a busy Direct exit). */
  readonly focus: ExitChoiceOption | undefined
  /** Commit one selection. The coordinator re-validates before acting. */
  select(option: ExitChoiceOption): void
  /** Withdraw with ZERO business action (Host modal preemption / dispose). */
  dismiss(): void
}

/** The renderer-side seam the coordinator presents through. */
export interface SurfaceExitChoiceSeam {
  /** Present one choice; a second open replaces the previous one. */
  open(model: ExitChoiceModel): void
  /** Replace the painted model of the OPEN choice (a phase transition). */
  update(model: ExitChoiceModel): void
  /** Hide the open choice. Never a business action. */
  close(): void
}

/** The fixed option copy shared by both renderers. */
const OPTION_LABELS: Readonly<Record<ExitChoiceOption, { label: string; shortLabel: string }>> = {
  'keep-and-disconnect': { label: 'Keep working and disconnect', shortLabel: 'Keep running & disconnect' },
  'stop-and-disconnect': { label: 'Stop current work and disconnect', shortLabel: 'Stop work & disconnect' },
  stay: { label: 'Stay in the TUI', shortLabel: 'Stay' },
  'disconnect-without-stop': { label: 'Disconnect without stopping', shortLabel: 'Disconnect' },
  'stop-and-exit': { label: 'Stop current work and exit', shortLabel: 'Stop & exit' },
  'exit-local': { label: 'Exit and retire local Host', shortLabel: 'Exit & retire' },
}

/** Fixed title per family. */
export function exitChoiceTitle(kind: ExitChoiceKind): string {
  return kind === 'daemon-busy' || kind === 'daemon-unknown'
    ? 'Disconnect from dsh-pi-tui'
    : 'Exit dsh-pi-tui'
}

/** The options of one family in its base (asking) phase. */
function baseOptions(kind: ExitChoiceKind): readonly ExitChoiceOption[] {
  switch (kind) {
    case 'daemon-busy': return ['keep-and-disconnect', 'stop-and-disconnect', 'stay']
    // Direct has no Keep: leaving the process always retires the local Host.
    // The safe default is Stay.
    case 'direct-busy': return ['stop-and-exit', 'stay']
    case 'daemon-unknown': return ['disconnect-without-stop', 'stay']
    case 'direct-unknown': return ['exit-local', 'stay']
  }
}

/** The safe initial focus of one family. */
function baseFocus(kind: ExitChoiceKind): ExitChoiceOption {
  switch (kind) {
    case 'daemon-busy': return 'keep-and-disconnect'
    case 'direct-busy': return 'stay'
    case 'daemon-unknown': return 'disconnect-without-stop'
    case 'direct-unknown': return 'stay'
  }
}

function viewOptions(options: readonly ExitChoiceOption[]): readonly ExitChoiceOptionView[] {
  return options.map(id => ({ id, label: OPTION_LABELS[id].label, shortLabel: OPTION_LABELS[id].shortLabel }))
}

/** The fixed body copy of the asking phase. */
function body(kind: ExitChoiceKind): readonly string[] {
  switch (kind) {
    case 'daemon-busy': return ['The current session is still working.']
    case 'direct-busy': return ['The current session is still working.', 'Exiting stops the in-process local Host.']
    case 'daemon-unknown': return ["The current session's running state cannot be verified."]
    case 'direct-unknown': return ["The current session's activity cannot be verified.", 'Exiting retires the in-process local Host.']
  }
}

/** Build the model of one asking-phase choice. */
export function exitChoiceAsking(
  kind: ExitChoiceKind,
  select: (option: ExitChoiceOption) => void,
  dismiss: () => void,
  shellRunning = false,
): ExitChoiceModel {
  return {
    kind,
    phase: 'choose',
    title: exitChoiceTitle(kind),
    body: shellRunning
      ? [...body(kind), 'A user shell is still running; leaving aborts it. Agent idle does not prove the shell finished.']
      : body(kind),
    shortBody: shellRunning
      ? 'A user shell is running; leaving aborts it.'
      : kind === 'daemon-busy' || kind === 'direct-busy'
        ? 'Session is working.'
        : 'State cannot be verified.',
    shellRunning,
    status: undefined,
    options: viewOptions(baseOptions(kind)),
    focus: baseFocus(kind),
    select,
    dismiss,
  }
}

/**
 * The daemon Stop-in-flight presentation: the SAME seat, no actable option,
 * and the fixed progress copy. No second window is ever opened.
 */
export function exitChoiceStopping(
  select: (option: ExitChoiceOption) => void,
  dismiss: () => void,
): ExitChoiceModel {
  return {
    kind: 'daemon-busy',
    phase: 'stopping',
    title: exitChoiceTitle('daemon-busy'),
    body: [
      'Stopping current work…',
      'Waiting for the current session to become idle.',
      'No other session will be stopped.',
    ],
    shortBody: 'Stopping current work…',
    shellRunning: false,
    status: undefined,
    options: [],
    focus: undefined,
    select,
    dismiss,
  }
}

/**
 * The unconfirmable-Stop presentation: the daemon may still be working, so
 * only Keep/Disconnect and Stay remain. The optional `detail` states a proven
 * refusal; an indeterminate result carries no claim of its own.
 */
export function exitChoiceUnconfirmed(
  detail: string | undefined,
  select: (option: ExitChoiceOption) => void,
  dismiss: () => void,
  shellRunning = false,
): ExitChoiceModel {
  return {
    kind: 'daemon-busy',
    phase: 'unconfirmed',
    title: exitChoiceTitle('daemon-busy'),
    body: shellRunning
      ? [
        'Stop could not be confirmed. The daemon may still be working.',
        'A user shell is still running; leaving aborts it. Agent idle does not prove the shell finished.',
      ]
      : ['Stop could not be confirmed. The daemon may still be working.'],
    shortBody: shellRunning
      ? 'Stop could not be confirmed; a user shell is running.'
      : 'Stop could not be confirmed.',
    shellRunning,
    status: detail,
    options: viewOptions(['disconnect-without-stop', 'stay']),
    focus: 'disconnect-without-stop',
    select,
    dismiss,
  }
}
