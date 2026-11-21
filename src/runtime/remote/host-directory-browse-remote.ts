/**
 * The Remote Host directory-browse adapter: the semantic
 * {@link HostDirectoryBrowsePort} over the official generated
 * `directoryPicker.list` namespace the ONE authenticated
 * `@deepseek-ai/dsh-api-workspace-controller/remote` contribution publishes.
 *
 * Currentness: every read captures the Connection generation BEFORE dispatch
 * and compares it after settlement. A reply OR refusal belonging to a
 * superseded generation becomes the repository's existing
 * `SupersededReadError`, never the new generation's listing or availability.
 * The adapter owns no cache, no retry and no second Remote namespace.
 *
 * The official namespace object is called on its own receiver: its methods are
 * generated instance methods, so destructuring or proxying them would lose the
 * service binding.
 *
 * Full contract: docs/architecture/host-client.md (Host Workspace
 * composition).
 * @module @xmoon76/dsh-pi-tui/runtime/remote/host-directory-browse-remote
 */

import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import { SupersededReadError } from '../read-error.ts'
import {
  hostDirectoryBrowseFailureOutcome,
  type HostDirectoryBrowseOutcome,
  type HostDirectoryBrowsePort,
} from '../host-directory-browse-port.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'

/** The generated `directoryPicker` namespace slice this adapter calls. */
export interface RemoteDirectoryPickerNamespace {
  list(
    path: string | undefined,
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<DirectoryListing>>
}

/** The ONE statement of the Remote capability gap (presentation reads it). */
export const REMOTE_HOST_DIRECTORY_BROWSE_UNAVAILABLE_REASON =
  'This Client is not connected to an official Host directory-picker namespace.'

/** The Remote `HostDirectoryBrowsePort` over the generated Client namespace. */
export class RemoteHostDirectoryBrowsePort implements HostDirectoryBrowsePort {
  private readonly directoryPicker: RemoteDirectoryPickerNamespace
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    directoryPicker: RemoteDirectoryPickerNamespace,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.directoryPicker = directoryPicker
    this.generation = generation
  }

  async list(path: string | undefined, signal: AbortSignal): Promise<HostDirectoryBrowseOutcome> {
    signal.throwIfAborted()
    const captured = this.generation.getSnapshot()
    if (captured === undefined) {
      return {
        kind: 'unavailable',
        reason: REMOTE_HOST_DIRECTORY_BROWSE_UNAVAILABLE_REASON,
        code: 'directory-picker/unavailable',
      }
    }
    const stillCurrent = (): boolean => Object.is(captured, this.generation.getSnapshot())
    let result: RemoteResultLike<DirectoryListing>
    try {
      result = await this.directoryPicker.list(path, signal)
    } catch (error) {
      // Cancellation and supersession outrank the carrier's own failure: a
      // stale throw must never surface as the new generation's state.
      signal.throwIfAborted()
      if (!stillCurrent()) throw new SupersededReadError('Host directory browse superseded')
      throw error
    }
    signal.throwIfAborted()
    if (!stillCurrent()) throw new SupersededReadError('Host directory browse superseded')
    if (result.ok) return { kind: 'ready', listing: result.value }
    const outcome = hostDirectoryBrowseFailureOutcome(result.error)
    if (outcome === undefined) throw result.error
    return outcome
  }
}
