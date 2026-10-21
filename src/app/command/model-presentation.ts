/** The narrow /model presentation contract. The command retains every read,
 * write, scope and default-intent owner; presenters hold only local UI state.
 * @module app/command/model-presentation
 */
import type { ModelDirectoryDto, ModelSelectionDto } from '../../runtime/catalog-port.ts'
import type { OwnedTaskOptions } from '../../runtime/process/tasks.ts'

export type ModelApplyOutcome =
  | 'committed'
  | 'rejected'
  | 'cancelled'
  | 'indeterminate'
  | 'unsupported'
  | 'superseded'

/**
 * The write subject, captured by the command at `open()`: whether the user was
 * sessionless. It is fixed for the panel's whole life (a subject that moves
 * invalidates the panel through {@link ModelPickerRequest.isCurrent}), so a
 * presenter never re-derives the subject from a later read.
 */
export interface ModelPickerSubject {
  readonly sessionless: boolean
}

/** One hydrated directory read: the Host fact plus the semantic current value. */
export interface ModelPickerDirectory {
  readonly directory: ModelDirectoryDto
  readonly current: ModelSelectionDto | undefined
}

export interface ModelPickerRequest {
  readonly subject: ModelPickerSubject
  apply(selection: ModelSelectionDto): Promise<ModelApplyOutcome> | ModelApplyOutcome
  /**
   * Re-read the SAME directory authority after a failed or partial read. The
   * command's single read owner re-enters loading itself; a presenter only asks.
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

export interface ModelPickerHandle {
  /** Enter the loading state again: the command's read owner started a read. */
  setLoading(): void
  setDirectory(input: ModelPickerDirectory): void
  setLoadError(message: string): void
  isDisposed(): boolean
  /** Retire only this handle; never cancel an admitted business operation. */
  close(): void
}

export interface ModelPresentation {
  open(request: ModelPickerRequest): ModelPickerHandle
  notify(message: string, kind?: 'info' | 'error'): void
}
