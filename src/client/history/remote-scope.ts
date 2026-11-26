/**
 * The structural per-open Host scope the Remote Ctrl+R seat receives.
 *
 * It is deliberately a narrow view: the current Directory availability, the
 * already-decided default Scope, one synchronous invalidation subscription and
 * disposal. The TUI never sees a Session, a binding, a Connection or a
 * Workspace registry; the application-owned capture implements this face.
 *
 * @module @xmoon76/dsh-pi-tui/client/history/remote-scope
 */

export interface RemoteHistoryDirectoryState {
  readonly available: boolean
  /** The exact Host path captured at this open; present only when available. */
  readonly cwd?: string
  /** A safe reason shown only while Directory is not available. */
  readonly reason?: string
}

export interface RemoteHistoryOpenScope {
  /** The already-decided default Scope for this open. */
  readonly initialScope: 'session' | 'all'
  directory(): RemoteHistoryDirectoryState
  isCurrent(): boolean
  subscribe(listener: () => void): () => void
  dispose(): void
}
