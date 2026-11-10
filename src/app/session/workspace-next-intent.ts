import type { WorkspaceSelectionIntent } from '../../runtime/session-lifecycle-port.ts'

export interface WorkspaceNextIntentCapture {
  readonly intent: WorkspaceSelectionIntent
  readonly revision: number
  isCurrent(): boolean
}

export type WorkspaceNextIntentStatus = 'proposed' | 'verifying' | 'confirmed' | 'rejected'

export interface WorkspaceNextIntentSnapshot {
  readonly intent: WorkspaceSelectionIntent
  readonly revision: number
  readonly status: WorkspaceNextIntentStatus
  readonly displayPath?: string
  readonly workspaceId?: string
  readonly error?: string
}

export interface WorkspaceNextIntentOwner {
  capture(): WorkspaceNextIntentCapture
  snapshot(): WorkspaceNextIntentSnapshot
  setResolvedWorkspace(workspaceId: string, displayPath?: string): void
  proposeHostPath(path: string): WorkspaceNextIntentCapture
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

/** Owns the Client-local intent for the next create; Host resolution stays at each create boundary. */
export function createWorkspaceNextIntentOwner(launchCwd: string): WorkspaceNextIntentOwner {
  let intent: WorkspaceSelectionIntent = { kind: 'host-path', path: launchCwd }
  let revision = 0
  let pathGeneration = 0
  let verificationPath: string | undefined
  let status: WorkspaceNextIntentStatus = 'proposed'
  let displayPath: string | undefined = launchCwd
  let workspaceId: string | undefined
  let error: string | undefined
  let disposed = false

  const capture = (): WorkspaceNextIntentCapture => {
    if (disposed) throw new Error('workspace next-intent owner is disposed')
    const capturedRevision = revision
    const capturedIntent = intent
    return {
      intent: capturedIntent,
      revision: capturedRevision,
      isCurrent: () => !disposed && revision === capturedRevision,
    }
  }

  const snapshot = (): WorkspaceNextIntentSnapshot => ({
    intent,
    revision,
    status,
    ...(displayPath === undefined ? {} : { displayPath }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(error === undefined ? {} : { error }),
  })

  const setWorkspace = (id: string, path: string | undefined): void => {
    pathGeneration += 1
    verificationPath = undefined
    intent = { kind: 'workspace-id', workspaceId: id }
    revision += 1
    status = 'confirmed'
    displayPath = path
    workspaceId = id
    error = undefined
  }

  const resetToLaunchCwd = (): void => {
    pathGeneration += 1
    verificationPath = undefined
    intent = { kind: 'host-path', path: launchCwd }
    revision += 1
    status = 'proposed'
    displayPath = launchCwd
    workspaceId = undefined
    error = undefined
  }

  return {
    capture,
    snapshot,
    setResolvedWorkspace(workspaceId, path) {
      if (disposed) throw new Error('workspace next-intent owner is disposed')
      setWorkspace(workspaceId, path)
    },
    proposeHostPath(path) {
      if (disposed) throw new Error('workspace next-intent owner is disposed')
      pathGeneration += 1
      verificationPath = undefined
      intent = { kind: 'host-path', path }
      revision += 1
      status = 'proposed'
      displayPath = path
      workspaceId = undefined
      error = undefined
      return capture()
    },
    beginPathVerification(path) {
      if (disposed) throw new Error('workspace next-intent owner is disposed')
      pathGeneration += 1
      const generation = pathGeneration
      const capturedRevision = revision
      const candidate = path ?? displayPath ?? launchCwd
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
      pathGeneration += 1
      verificationPath = undefined
      setWorkspace(id, canonicalPath)
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
      if (token.isCurrent() && !disposed && token.revision === revision) resetToLaunchCwd()
    },
    dispose() {
      disposed = true
      revision += 1
      pathGeneration += 1
      verificationPath = undefined
    },
  }
}
