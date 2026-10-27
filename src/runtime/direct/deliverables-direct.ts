/**
 * The Direct delivered-file read adapter (Delivered files PR2 / M10): the
 * in-process {@link DeliveredFileReadPort} over the OFFICIAL Host file service.
 *
 * ```text
 * SessionId -> scope resolution (the SAME lookup the official Remote performs)
 *              live ctx.sessions.get(id)?.header
 *              ?? persisted ctx.sessionPersistence.stat(id)?.header
 *              -> { sessionId, workspaceRoot: header.cwd ?? ctx.sandboxPolicy.workspaceRoot }
 *           -> ctx.workspaceFiles.stat/read (bounded page, official refusals)
 * ```
 *
 * The adapter owns NO workspace truth: it never guesses a root from the Client
 * cwd, never reads the file with `node:fs`, and never re-windows a page. Scope
 * resolution deliberately reproduces the official `workspaceFileScope` lookup
 * (the same services, the same live-then-persisted order, the same fallback) so
 * Direct and Remote cannot answer differently for one Session.
 *
 * Full contract: docs/architecture/host-client.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/deliverables-direct
 */

import { DELIVERED_FILE_PAGE_LINES, DeliveredFileReadError, deliveredFileReadErrorFrom, type DeliveredFilePage, type DeliveredFileReadPort, type DeliveredFileStat } from '../deliverables-port.ts'

/** One Session header's workspace-relevant field, when the Host reports it. */
interface SessionHeaderLike {
  readonly cwd?: string
}

/** The `sessions` service slice this adapter reads. */
interface SessionsServiceLike {
  get(sessionId: string): { readonly header?: SessionHeaderLike } | undefined
}

/** The durable Session store slice (the persisted-header fallback). */
interface SessionPersistenceLike {
  stat(sessionId: string): Promise<{ readonly header?: SessionHeaderLike } | undefined>
}

/** The Host sandbox policy slice (the no-cwd workspace fallback). */
interface SandboxPolicyLike {
  readonly workspaceRoot: string
}

/** The official Host service slice the adapter maps (structural). */
interface WorkspaceFilesServiceLike {
  stat(scope: WorkspaceFileScopeLike, path: string, signal: AbortSignal): Promise<WorkspaceFileStatLike>
  read(
    scope: WorkspaceFileScopeLike,
    path: string,
    range: { readonly offset?: number; readonly limit?: number },
    signal: AbortSignal,
  ): Promise<WorkspaceFileTextLike>
}

/** The official scope record (the Host derives it from the Session identity). */
interface WorkspaceFileScopeLike {
  readonly sessionId: string
  readonly workspaceRoot: string
}

/** The official `WorkspaceFileStat` fields the preview consumes. */
interface WorkspaceFileStatLike {
  readonly version: string
  readonly bytes?: number
}

/** The official `WorkspaceFileText` fields the preview consumes. */
interface WorkspaceFileTextLike extends WorkspaceFileStatLike {
  readonly offset: number
  readonly text: string
  readonly lines: number
  readonly eof: boolean
}

/** The minimal Host context surface (structural — services resolve from dsh). */
export interface DirectDeliveredFileContextLike {
  get(name: string): unknown
}

function statOf(value: WorkspaceFileStatLike): DeliveredFileStat {
  return value.bytes === undefined
    ? { version: value.version }
    : { version: value.version, bytes: value.bytes }
}

/** Direct delivered-file reads over the official in-process Host service. */
export class DirectDeliveredFileReadPort implements DeliveredFileReadPort {
  private readonly ctx: DirectDeliveredFileContextLike

  constructor(ctx: DirectDeliveredFileContextLike) {
    this.ctx = ctx
  }

  async stat(sessionId: string, path: string, signal: AbortSignal): Promise<DeliveredFileStat> {
    const scope = await this.scopeOf(sessionId)
    const files = this.files()
    try {
      return statOf(await files.stat(scope, path, signal))
    } catch (error) {
      throw deliveredFileReadErrorFrom(error)
    }
  }

  async read(
    sessionId: string,
    path: string,
    offset: number,
    signal: AbortSignal,
  ): Promise<DeliveredFilePage> {
    const limit = DELIVERED_FILE_PAGE_LINES
    const scope = await this.scopeOf(sessionId)
    const files = this.files()
    try {
      const page = await files.read(scope, path, { offset, limit }, signal)
      return {
        stat: statOf(page),
        offset,
        limit,
        text: page.text,
        lines: page.lines,
        eof: page.eof,
      }
    } catch (error) {
      throw deliveredFileReadErrorFrom(error)
    }
  }

  /** The official `workspaceFiles` Host service, or a definite refusal. */
  private files(): WorkspaceFilesServiceLike {
    const service = this.ctx.get('workspaceFiles') as WorkspaceFilesServiceLike | undefined
    if (service === undefined) {
      throw new DeliveredFileReadError('service-unavailable', 'the Host file service is not mounted')
    }
    return service
  }

  /**
   * The official Session-derived scope: the LIVE header first, then the
   * persisted header, then the deployment's workspace root — and a definite
   * refusal when the Session has no header at all (the preview must never read
   * another Session's tree).
   */
  private async scopeOf(sessionId: string): Promise<WorkspaceFileScopeLike> {
    const sessions = this.ctx.get('sessions') as SessionsServiceLike | undefined
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    const live = sessions?.get(sessionId)?.header
    const stored = live === undefined ? await persistence?.stat(sessionId) : undefined
    const header = live ?? stored?.header
    if (header === undefined) {
      throw new DeliveredFileReadError('session-unavailable', `the Host has no header for session "${sessionId}"`)
    }
    const sandbox = this.ctx.get('sandboxPolicy') as SandboxPolicyLike | undefined
    const workspaceRoot = header.cwd ?? sandbox?.workspaceRoot
    if (workspaceRoot === undefined) {
      throw new DeliveredFileReadError('session-unavailable', 'the Host cannot resolve a workspace root')
    }
    return { sessionId, workspaceRoot }
  }
}
