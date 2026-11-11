import type { WorkspaceSelectionIntent } from '../../runtime/session-lifecycle-port.ts'

/** How the CURRENT next-create proposal came into existence. The provenance is
 *  Client-local policy: it decides what a committed create does to the
 *  proposal (a one-shot AUTO adoption must not survive as an assumed
 *  selection; an explicit user choice must), never what the Host is asked.
 *
 *  - `launch`: the Direct/sessionless launch directory (same Host machine).
 *  - `auto`: a verified local Client launch cwd adopted for THIS create only.
 *  - `manual`: an explicit Host picker/path choice by the user. */
export type WorkspaceNextIntentProvenance = 'launch' | 'auto' | 'manual'

export interface WorkspaceNextIntentCapture {
  readonly intent: WorkspaceSelectionIntent
  readonly revision: number
  /** How THIS create target came into existence (`undefined` for a legacy
   *  structural caller). The auto provenance is what a create boundary must
   *  re-prove before consuming the id. */
  readonly provenance?: WorkspaceNextIntentProvenance
  isCurrent(): boolean
}

/** `unselected` is a REAL state: there is no legal Host request to make (no
 *  Host-issued WorkspaceId and no verified auto candidate), so `capture()`
 *  returns `undefined` instead of fabricating an intent. */
export type WorkspaceNextIntentStatus = 'unselected' | 'proposed' | 'verifying' | 'confirmed' | 'rejected'

export interface WorkspaceNextIntentSnapshot {
  /** Absent exactly when `status === 'unselected'`.
   *
   *  IDENTITY RULE: `intent` (and its `workspace-id` member) is the CURRENT
   *  create target's authority. `status` is TRANSIENT verification state: an
   *  in-flight or refused Add of a DIFFERENT path neither replaces nor
   *  disables the still-confirmed target, so consumers of the confirmed
   *  WorkspaceId (completion, standing skills) read `intent`, never `status`.
   */
  readonly intent?: WorkspaceSelectionIntent
  readonly revision: number
  readonly status: WorkspaceNextIntentStatus
  readonly provenance?: WorkspaceNextIntentProvenance
  readonly displayPath?: string
  readonly workspaceId?: string
  readonly error?: string
}

export interface WorkspaceNextIntentOwner {
  /** The current Host-resolvable proposal, or `undefined` when unselected.
   *  EVERY caller must refuse the Host request on `undefined`. */
  capture(): WorkspaceNextIntentCapture | undefined
  snapshot(): WorkspaceNextIntentSnapshot
  setResolvedWorkspace(workspaceId: string, displayPath?: string): void
  proposeHostPath(path: string, provenance?: WorkspaceNextIntentProvenance): WorkspaceNextIntentCapture
  beginPathVerification(path?: string): WorkspaceNextIntentCapture
  commitVerifiedPath(
    capture: WorkspaceNextIntentCapture,
    workspaceId: string,
    canonicalPath: string,
  ): WorkspaceNextIntentCapture | undefined
  rejectCreateResolution(capture: WorkspaceNextIntentCapture, message: string): void
  rejectPathVerification(capture: WorkspaceNextIntentCapture, message: string): void
  resetToLaunchCwd(): void
  consumeAfterCommittedCreate(capture: WorkspaceNextIntentCapture): void
  dispose(): void
}

/** Owns the Client-local intent for the next create; Host resolution stays at each create boundary.
 *
 *  `launchCwd === undefined` starts UNSELECTED (the Remote sessionless surface
 *  before a verified auto candidate or an explicit user choice). A string is
 *  the launch-directory proposal: `launch` on Direct/sessionless, `auto` for a
 *  verified local Client cwd adopted for one create. */
export function createWorkspaceNextIntentOwner(
  launchCwd: string | undefined,
  initialProvenance: WorkspaceNextIntentProvenance = 'launch',
): WorkspaceNextIntentOwner {
  let intent: WorkspaceSelectionIntent | undefined = launchCwd === undefined
    ? undefined
    : { kind: 'host-path', path: launchCwd }
  let revision = 0
  let pathGeneration = 0
  let verificationPath: string | undefined
  let verificationProvenance: WorkspaceNextIntentProvenance | undefined
  let status: WorkspaceNextIntentStatus = intent === undefined ? 'unselected' : 'proposed'
  let provenance: WorkspaceNextIntentProvenance | undefined = intent === undefined ? undefined : initialProvenance
  let displayPath: string | undefined = launchCwd
  let workspaceId: string | undefined
  let error: string | undefined
  let disposed = false

  const capture = (): WorkspaceNextIntentCapture | undefined => {
    if (disposed) throw new Error('workspace next-intent owner is disposed')
    if (intent === undefined) return undefined
    const capturedRevision = revision
    const capturedIntent = intent
    return {
      intent: capturedIntent,
      revision: capturedRevision,
      ...(provenance === undefined ? {} : { provenance }),
      isCurrent: () => !disposed && revision === capturedRevision,
    }
  }

  const snapshot = (): WorkspaceNextIntentSnapshot => ({
    ...(intent === undefined ? {} : { intent }),
    revision,
    status,
    ...(provenance === undefined ? {} : { provenance }),
    ...(displayPath === undefined ? {} : { displayPath }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(error === undefined ? {} : { error }),
  })

  const setWorkspace = (id: string, path: string | undefined, source: WorkspaceNextIntentProvenance): void => {
    pathGeneration += 1
    verificationPath = undefined
    verificationProvenance = undefined
    intent = { kind: 'workspace-id', workspaceId: id }
    revision += 1
    status = 'confirmed'
    provenance = source
    displayPath = path
    workspaceId = id
    error = undefined
  }

  /** Drop every proposal: the surface has no legal Host target until a new
   *  manual choice or a freshly verified auto candidate arrives. */
  const clearToUnselected = (): void => {
    pathGeneration += 1
    verificationPath = undefined
    verificationProvenance = undefined
    intent = undefined
    revision += 1
    status = 'unselected'
    provenance = undefined
    displayPath = undefined
    workspaceId = undefined
    error = undefined
  }

  const resetToLaunchCwd = (): void => {
    // A revoked/consumed AUTO candidate never degrades into a raw launch-cwd
    // proposal: the Client cwd is not a Host Workspace until it is re-proved.
    if (launchCwd === undefined || provenance === 'auto') {
      clearToUnselected()
      return
    }
    pathGeneration += 1
    verificationPath = undefined
    verificationProvenance = undefined
    intent = { kind: 'host-path', path: launchCwd }
    revision += 1
    status = 'proposed'
    provenance = 'launch'
    displayPath = launchCwd
    workspaceId = undefined
    error = undefined
  }

  return {
    capture,
    snapshot,
    setResolvedWorkspace(id, path) {
      if (disposed) throw new Error('workspace next-intent owner is disposed')
      setWorkspace(id, path, 'manual')
    },
    proposeHostPath(path, source = 'manual') {
      if (disposed) throw new Error('workspace next-intent owner is disposed')
      pathGeneration += 1
      verificationPath = undefined
      verificationProvenance = undefined
      intent = { kind: 'host-path', path }
      revision += 1
      status = 'proposed'
      provenance = source
      displayPath = path
      workspaceId = undefined
      error = undefined
      const captured = capture()
      if (captured === undefined) throw new Error('a proposed Host path must capture')
      return captured
    },
    beginPathVerification(path) {
      if (disposed) throw new Error('workspace next-intent owner is disposed')
      pathGeneration += 1
      const generation = pathGeneration
      const capturedRevision = revision
      // Verifying the CURRENT proposal keeps its provenance (the auto preflight
      // must not turn a one-shot adoption into a user choice); verifying a NEW
      // path is an explicit user decision.
      const candidate = path ?? (intent?.kind === 'host-path' ? intent.path : displayPath)
      if (candidate === undefined) throw new Error('there is no Host path to verify')
      verificationProvenance = path === undefined ? (provenance ?? 'manual') : 'manual'
      verificationPath = candidate
      displayPath = candidate
      status = 'verifying'
      error = undefined
      return {
        intent: { kind: 'host-path', path: candidate },
        revision: capturedRevision,
        isCurrent: () => !disposed && revision === capturedRevision && pathGeneration === generation,
      }
    },
    commitVerifiedPath(token, id, canonicalPath) {
      if (!token.isCurrent() || disposed || token.revision !== revision) return undefined
      setWorkspace(id, canonicalPath, verificationProvenance ?? 'manual')
      return capture()
    },
    rejectCreateResolution(capture, message) {
      if (!capture.isCurrent() || disposed || capture.revision !== revision) return
      status = 'rejected'
      error = message
    },
    rejectPathVerification(token, message) {
      if (!token.isCurrent() || disposed || token.revision !== revision) return
      status = 'rejected'
      displayPath = verificationPath
      error = message
    },
    resetToLaunchCwd() {
      if (disposed) throw new Error('workspace next-intent owner is disposed')
      resetToLaunchCwd()
    },
    consumeAfterCommittedCreate(token) {
      if (!token.isCurrent() || disposed || token.revision !== revision) return
      switch (provenance) {
        case 'auto':
          // A one-shot auto adoption never becomes an assumed selection.
          clearToUnselected()
          return
        case 'launch':
          resetToLaunchCwd()
          return
        case 'manual':
          // An explicit user Workspace choice persists across this Client's
          // next sessionless create until an explicit switch or a lost Host
          // eligibility.
          return
        default:
          return
      }
    },
    dispose() {
      disposed = true
      revision += 1
      pathGeneration += 1
      verificationPath = undefined
      verificationProvenance = undefined
    },
  }
}
