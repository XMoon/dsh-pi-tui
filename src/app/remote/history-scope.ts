/**
 * The per-open Host scope capture behind the Remote Ctrl+R seat.
 *
 * It owns exactly the two authorities the search can trust:
 * - an active Session's exact retained binding: the official
 *   `workingDirectory` face is subscribed BEFORE one passive projection read,
 *   and any relevant publication permanently revokes this open even when the
 *   value later returns to the initial one (A→B→A);
 * - a sessionless confirmed Workspace intent: the existing create target is
 *   never re-interpreted as a Host path, and the seat-lifetime official
 *   `workspace.follow` baseline supplies the canonical path. A status/revision
 *   exit, a path change, a removal or a lost generation revokes the capture.
 *
 * The capture is not a second Session/Workspace authority and never polls: it
 * synchronously forwards the official notifications to the seat, which retires
 * itself. `dispose()` releases every observation exactly once.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/history-scope
 */

import { isAbsolute } from 'node:path'
import type { SessionWorkspaceFactsPort } from '../../runtime/session-workspace-facts-port.ts'
import { type Diag } from '../../runtime/process/diagnostics.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import type { WorkspaceNextIntentOwner } from '../session/workspace-next-intent.ts'
import type {
  RemoteHistoryDirectoryState,
  RemoteHistoryOpenScope,
} from '../../client/history/remote-scope.ts'
import type { RemoteSessionFacts } from './presentation-source.ts'

export interface RemoteHistoryScopeDeps {
  readonly sessionId: string | undefined
  /** The ONE existing Session-scope currentness authority for this open. */
  readonly isScopeCurrent: () => boolean
  readonly sessionFacts: RemoteSessionFacts | undefined
  /** The owning port object: its methods may be receiver-sensitive. */
  readonly workspaceFacts: SessionWorkspaceFactsPort
  readonly workspaceIntent: WorkspaceNextIntentOwner | undefined
  readonly diag: Diag
}

class RemoteHistoryScope implements RemoteHistoryOpenScope {
  readonly initialScope: 'session' | 'all'
  private readonly listeners = new Set<() => void>()
  private readonly abort = new AbortController()
  private directoryState: RemoteHistoryDirectoryState
  private disposed = false
  private invalidated = false
  private unsubscribeFace: (() => void) | undefined
  private unsubscribeIntent: (() => void) | undefined
  /** The exact transport token captured at open; re-proved on every read. */
  private transportToken: unknown
  private transportSessionId: string | undefined
  private transportFacts: RemoteSessionFacts | undefined

  private readonly deps: RemoteHistoryScopeDeps

  constructor(
    deps: RemoteHistoryScopeDeps,
    initialDirectory: RemoteHistoryDirectoryState,
  ) {
    this.deps = deps
    this.initialScope = deps.sessionId === undefined ? 'all' : 'session'
    this.directoryState = initialDirectory
    if (deps.sessionId !== undefined) this.observeActiveSession(deps.sessionId)
    else this.observeSessionlessWorkspace()
  }

  directory(): RemoteHistoryDirectoryState {
    return this.directoryState
  }

  isCurrent(): boolean {
    if (this.disposed || this.invalidated) return false
    if (this.transportFacts !== undefined && this.transportSessionId !== undefined
      && !this.transportFacts.isTransportTokenCurrent(this.transportSessionId, this.transportToken)) {
      this.invalidate('session-transport-replaced')
      return false
    }
    return this.deps.isScopeCurrent()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    this.unsubscribeFace?.()
    this.unsubscribeFace = undefined
    this.unsubscribeIntent?.()
    this.unsubscribeIntent = undefined
    this.listeners.clear()
  }

  private setDirectory(next: RemoteHistoryDirectoryState): void {
    if (this.disposed || this.invalidated) return
    const current = this.directoryState
    if (current.available === next.available && current.cwd === next.cwd && current.reason === next.reason) return
    this.directoryState = next
    this.publish()
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * A relevant publication permanently revokes THIS open. The seat retires; no
   * later value (including the original A) can revive it.
   */
  private invalidate(reason: string): void {
    if (this.disposed || this.invalidated) return
    this.invalidated = true
    this.directoryState = { available: false, reason }
    this.abort.abort()
    this.publish()
  }

  private observeActiveSession(sessionId: string): void {
    const facts = this.deps.sessionFacts
    if (facts === undefined) {
      this.directoryState = { available: false, reason: 'directory-unavailable' }
      return
    }
    // Subscribe BEFORE the passive value read: a change after this point is a
    // permanent revocation even if the value later returns to its initial one.
    this.unsubscribeFace = facts.subscribeWorkingDirectory(sessionId, () => {
      this.invalidate('working-directory-changed')
    })
    if (this.unsubscribeFace === undefined) {
      this.directoryState = { available: false, reason: 'session-not-retained' }
      return
    }
    const token = facts.captureTransportToken(sessionId)
    this.transportToken = token
    this.transportSessionId = sessionId
    this.transportFacts = facts
    if (!facts.isTransportTokenCurrent(sessionId, token)) {
      this.invalidate('session-transport-replaced')
      return
    }
    // The exact retained binding's own face is the first authority. The
    // official Session status carries the SAME effective directory when the
    // face has not materialized yet; it is never the Client cwd or the header.
    const cwd = facts.workingDirectory(sessionId) ?? facts.sessionStatus(sessionId)?.cwd
    if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) {
      this.directoryState = { available: false, reason: 'directory-unavailable' }
      return
    }
    this.directoryState = { available: true, cwd }
  }

  private observeSessionlessWorkspace(): void {
    const intent = this.deps.workspaceIntent
    const follow = this.deps.workspaceFacts.followWorkspaces
    if (intent === undefined || follow === undefined) {
      this.directoryState = { available: false, reason: 'directory-unavailable' }
      return
    }
    const snapshot = intent.snapshot()
    if (snapshot.status !== 'confirmed' || snapshot.intent?.kind !== 'workspace-id') {
      this.directoryState = { available: false, reason: 'workspace-not-confirmed' }
      return
    }
    const workspaceId = snapshot.intent.workspaceId
    const revision = snapshot.revision
    // Subscribe BEFORE reading the snapshot used by `follow`: a status/revision
    // change in that window is a real revocation, never an undetected gap.
    this.unsubscribeIntent = intent.subscribe(() => {
      const next = intent.snapshot()
      if (next.revision !== revision
        || next.status !== 'confirmed'
        || next.intent?.kind !== 'workspace-id'
        || next.intent.workspaceId !== workspaceId) {
        this.invalidate('workspace-intent-changed')
      }
    })
    const handle = follow.call(this.deps.workspaceFacts, this.abort.signal, 'single-generation')
    let baseline = false
    runDetached('history open scope workspace', async () => {
      try {
        for await (const frame of handle) {
          if (this.disposed || this.invalidated) return
          if (frame.type === 'invalidated') {
            this.invalidate('workspace-generation-lost')
            return
          }
          if (frame.type === 'baseline' || frame.type === 'replace') {
            const match = frame.items.find(item => item.workspaceId === workspaceId)
            if (match === undefined || !handle.isCurrent()) {
              this.invalidate('workspace-not-current')
              return
            }
            baseline = true
            this.setDirectory({ available: true, cwd: match.path })
            continue
          }
          if (frame.type === 'upsert' && frame.workspace.workspaceId === workspaceId) {
            if (!baseline) continue
            // The captured identity must keep the exact canonical path. A
            // same-id path mutation (not producible by the current controller)
            // is a real revocation, never silently adopted.
            const captured = this.directoryState.cwd
            if (captured !== frame.workspace.path) {
              this.invalidate('workspace-path-changed')
              return
            }
            continue
          }
          if (frame.type === 'remove' && frame.workspaceId === workspaceId) {
            this.invalidate('workspace-removed')
            return
          }
        }
        if (!this.disposed && !this.invalidated) this.invalidate('workspace-stream-ended')
      } catch {
        if (!this.disposed && !this.invalidated) this.invalidate('workspace-stream-failed')
      } finally {
        handle.dispose()
      }
    }, { diag: this.deps.diag })
  }
}

/** Build one caller-owned capture; the caller must dispose it with the seat. */
export function createRemoteHistoryOpenScope(deps: RemoteHistoryScopeDeps): RemoteHistoryOpenScope {
  return new RemoteHistoryScope(deps, deps.sessionId === undefined
    ? { available: false, reason: 'workspace-not-confirmed' }
    : { available: false, reason: 'directory-checking' })
}
