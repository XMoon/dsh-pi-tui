/** The narrow `/preset` presentation contract. The command retains every read,
 *  write, scope and default-config owner; presenters hold only local UI state.
 * @module app/command/preset-presentation
 */
import type { PresetRosterDto } from '../../runtime/catalog-port.ts'
import type { OwnedTaskOptions } from '../../runtime/process/tasks.ts'

/**
 * The write subject, captured by the command at `open()`: whether the user was
 * sessionless. It is fixed for the panel's whole life (a subject that moves
 * invalidates the panel through {@link PresetPickerRequest.isCurrent}), so a
 * presenter never re-derives the subject from a later read.
 */
export interface PresetPickerSubject {
  readonly sessionless: boolean
}

/** One hydrated roster read: the Host fact plus the display facts the command
 *  captured at open. Every field is a DERIVED presentation fact — the durable
 *  authorities stay in the roster port, the Session and the Config owner. */
export interface PresetPickerRoster {
  readonly roster: PresetRosterDto
  /** The live Session's preset (`Current session`); absent without a Session. */
  readonly currentId: string | undefined
  /** The run-local pending preset (`Next session`); sessionless subjects only. */
  readonly pendingId: string | undefined
  /** The effective new-session default (`New-session default`). */
  readonly defaultId: string | undefined
  /** Whether the Config owner can persist a new-session default at all. */
  readonly canSetDefault: boolean
}

/**
 * The `/preset <id>` (or picker `Use`) settlement — the existing semantic
 * outcomes of the command's session-preset write, never a Web-shaped DTO.
 */
export type PresetApplyOutcome =
  /** Sessionless: staged as the run-local pending preset (no Session created). */
  | { readonly kind: 'pending'; readonly preset: string }
  /** A still-blank live Session's durable preset selection committed. */
  | { readonly kind: 'switched'; readonly preset: string }
  /** A newer `/preset` or a moved subject owns the surface: nothing to report. */
  | { readonly kind: 'superseded' }
  /** The Host refused because the Session already started. */
  | { readonly kind: 'locked'; readonly sessionId: string }
  | { readonly kind: 'rejected'; readonly message: string }
  | { readonly kind: 'indeterminate'; readonly message: string }

/**
 * The `Set as default for new sessions` settlement. `unconfirmed` is deliberate: the
 * Config owner's write is an awaited settings mutation that raises on failure,
 * so a throw proves NEITHER commit nor rollback — the presenter must not claim
 * a failed save left the previous default in place, and must not retry it.
 */
export type PresetDefaultOutcome =
  | { readonly kind: 'saved'; readonly preset: string }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'unconfirmed'; readonly message: string }

export interface PresetPickerRequest {
  readonly subject: PresetPickerSubject
  /** One explicit `Use` / row-key activation, through the ORIGINAL apply owner. */
  apply(id: string): Promise<PresetApplyOutcome>
  /**
   * One explicit `Set as default for new sessions` (the TSP Overview's own row),
   * through the ORIGINAL default writer.
   */
  setDefault(id: string): Promise<PresetDefaultOutcome>
  /**
   * Re-read the SAME roster authority after a failed read. The command's single
   * read owner re-enters loading itself; a presenter only asks.
   */
  retry(): void
  /** Recheck both the captured subject and the command's presentation token. */
  isCurrent(): boolean
  runOwned<T>(
    label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void
}

export interface PresetPickerHandle {
  /** Enter the loading state again: the command's read owner started a read. */
  setLoading(): void
  setRoster(roster: PresetPickerRoster): void
  setLoadError(message: string): void
  isDisposed(): boolean
  /** Retire only this handle; never cancel an admitted business operation. */
  close(): void
}

export interface PresetPresentation {
  open(request: PresetPickerRequest): PresetPickerHandle
  notify(message: string, kind?: 'info' | 'error'): void
}
