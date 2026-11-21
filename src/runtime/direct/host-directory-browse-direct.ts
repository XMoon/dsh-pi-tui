/**
 * The Direct Host directory-browse adapter: the semantic
 * {@link HostDirectoryBrowsePort} over the OFFICIAL in-process
 * `ctx.directoryPickerController` service.
 *
 * That service is the Host handler behind the generated
 * `directoryPicker/list` Remote verb: it resolves the composed
 * `ctx.directoryPicker` capability, runs the Host filesystem scan and
 * projects the seam's closed failure codes onto the wire vocabulary. This
 * adapter therefore owns NO directory scanner, no home lookup and no path
 * arithmetic — it calls the same official method a Remote caller reaches.
 *
 * The adapter is read-only by construction: it resolves one service and calls
 * one method. It never creates a Workspace, a directory or a Session.
 *
 * Full contract: docs/architecture/host-client.md (Host Workspace
 * composition).
 * @module @xmoon76/dsh-pi-tui/runtime/direct/host-directory-browse-direct
 */

import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { DirectoryPickerController } from '@deepseek-ai/dsh-api-workspace-controller'
import {
  hostDirectoryBrowseFailureOutcome,
  type HostDirectoryBrowseOutcome,
  type HostDirectoryBrowsePort,
} from '../host-directory-browse-port.ts'

/** The narrow Host context seam this adapter borrows (read-only resolution). */
export interface DirectHostDirectoryBrowseContext {
  get(name: string): unknown
}

/** The official controller surface this adapter consumes — one method. */
export type HostDirectoryPickerControllerLike = Pick<DirectoryPickerController, 'list'>

/** The ONE statement of the Direct capability gap (presentation reads it). */
export const DIRECT_HOST_DIRECTORY_BROWSE_UNAVAILABLE_REASON =
  'This Host did not mount the official directory-picker controller.'

/** The Direct `HostDirectoryBrowsePort` over the in-process official service. */
export class DirectHostDirectoryBrowsePort implements HostDirectoryBrowsePort {
  private readonly ctx: DirectHostDirectoryBrowseContext

  constructor(ctx: DirectHostDirectoryBrowseContext) {
    this.ctx = ctx
  }

  async list(path: string | undefined, signal: AbortSignal): Promise<HostDirectoryBrowseOutcome> {
    signal.throwIfAborted()
    const controller = this.ctx.get('directoryPickerController') as HostDirectoryPickerControllerLike | undefined
    if (controller === undefined) {
      return {
        kind: 'unavailable',
        reason: DIRECT_HOST_DIRECTORY_BROWSE_UNAVAILABLE_REASON,
        code: 'directory-picker/unavailable',
      }
    }
    let listing: DirectoryListing
    try {
      listing = await controller.list(path, signal)
    } catch (error) {
      signal.throwIfAborted()
      const outcome = hostDirectoryBrowseFailureOutcome(error)
      if (outcome === undefined) throw error
      return outcome
    }
    signal.throwIfAborted()
    return { kind: 'ready', listing }
  }
}
