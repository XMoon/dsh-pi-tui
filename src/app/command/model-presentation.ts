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

export interface ModelPickerDirectory {
  readonly directory: ModelDirectoryDto
  readonly current: ModelSelectionDto | undefined
  readonly sessionless: boolean
}

export interface ModelPickerRequest {
  apply(selection: ModelSelectionDto): Promise<ModelApplyOutcome> | ModelApplyOutcome
  /** Recheck both the captured subject and the command's presentation token. */
  isCurrent(): boolean
  runOwned<T>(
    label: string,
    task: () => T | Promise<T>,
    options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
  ): void
}

export interface ModelPickerHandle {
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
