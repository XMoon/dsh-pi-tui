/**
 * The published Client Session reference-ownership seam.
 *
 * DSH 0.1.6-alpha.2 replaced "open moves the current selection" with explicit
 * reference ownership: `retain()` acquires one exact Client Session generation,
 * `binding()` only borrows an already-retained generation, and the last
 * reference release may immediately retire that generation. A `sessionId`
 * therefore no longer identifies a lifetime — the same id retained later is a
 * NEW binding generation.
 *
 * This module is the only place the TUI declares its own consumer identity on
 * that contract, and the only place that owns the three lifetime patterns the
 * adapters need:
 *
 * - {@link acquireMainSurfaceReference} — materialize/own the TUI's visible
 *   main surface (navigation create/open). Materializing is correct here.
 * - {@link acquireChildViewReference} — own one subagent child viewer's exact
 *   generation, addressed by its durable `SubagentAddress`. It NEVER
 *   materializes a Host Agent: the child binding is the whole lifetime.
 * - {@link pinExistingGeneration} — borrow an EXISTING generation first and
 *   retain it only to pin that exact generation for one bounded async
 *   operation (writer/paging). A plain write/read must never cold-open a
 *   Session as a side effect.
 *
 * Both patterns hand out a `release()` that must run exactly once. `ready` is
 * deliberately never awaited here: official Web navigation commits the new
 * owner before the initial history open settles, and `ready` belongs only to
 * operations that genuinely must wait for that open.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/session-reference
 */

import type { SessionReferenceSourceMap } from '@deepseek-ai/dsh-api-session-controller/client'

/**
 * The TUI's own reference sources. Official Web uses its own `mainView` source;
 * the TUI must not impersonate it, or the Client would attribute the TUI's
 * visible ownership to the Web view.
 */
declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The TUI's current visible main-surface owner. */
    tuiMainView: unknown
    /** One bounded TUI operation pinning an already-existing generation. */
    tuiOperation: unknown
    /** One TUI subagent child viewer's exact child Session generation. */
    tuiChildView: unknown
  }
}

/** The TUI-owned official reference sources. */
export type TuiSessionReferenceSource = 'tuiMainView' | 'tuiOperation' | 'tuiChildView'

/** Structural official `SessionReference` — no concrete implementation import. */
export interface RemoteSessionReferenceLike {
  readonly sessionId: string
  /** The exact generation this reference owns; identity, not a lookup. */
  readonly binding: unknown
  readonly ready: Promise<unknown>
  /** Release exactly once; idempotent afterwards. */
  release(): void
}

/**
 * Structural official Session target. The official `retain()` accepts a
 * Session id string OR a durable direct-parent subagent address; both are
 * mirrored here so a real `ISessions` stays structurally assignable while this
 * adapter only ever passes plain id strings or one exact subagent address.
 */
export type RemoteSessionTarget = string | RemoteSubagentViewAddress

/**
 * One durable direct-parent subagent address: the exact browse address the
 * official Task/subagent catalog carries. Retaining it owns one Client
 * generation without creating or activating a Host Agent.
 */
export interface RemoteSubagentViewAddress {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly mode: 'one-shot' | 'continuable' | 'unknown'
}

/** Structural official `ISessions` reference-acquisition subset. */
export interface RemoteRetainSource {
  retain(
    target: RemoteSessionTarget,
    options: { readonly source: TuiSessionReferenceSource; readonly signal?: AbortSignal },
  ): RemoteSessionReferenceLike
}

/** Structural official `ISessions` reference lifetime face: acquisition plus
 * the borrow-only binding lookup. */
export interface RemoteReferenceSessionsSource<B extends object = object> extends RemoteRetainSource {
  /**
   * Borrow an already-retained generation WITHOUT extending its lifetime.
   *
   * MUST return the very object identity a reference owns: the exact-generation
   * fences and {@link pinExistingGeneration} compare identity, so a derived or
   * ad-hoc wrapper is refused rather than silently pinned.
   */
  binding(id: string): B | undefined
}

/** A TUI-owned visible main surface: one exact generation held until release. */
export interface MainSurfaceReference {
  readonly sessionId: string
  /** Exact-generation token for the held binding (identity comparison only). */
  readonly bindingIdentity: object
  /** Release exactly once. */
  release(): void
}

/** One bounded operation's pin on an ALREADY-existing generation. */
export interface PinnedGeneration<B extends object> {
  /** The borrowed binding, still live because this pin holds its generation. */
  readonly binding: B
  /** Release exactly once. */
  release(): void
}

/**
 * One TUI-owned child-viewer generation: acquired from the exact durable
 * `SubagentAddress` the Task row carries and held for the whole viewer
 * session. It owns Client lifetime ONLY — acquiring it never creates or
 * activates a Host Agent, and `release()` is idempotent.
 */
export interface ChildViewReference<B extends object = object> {
  readonly parentSessionId: string
  readonly childSessionId: string
  /** The exact generation this reference owns; identity, not a lookup. */
  readonly bindingIdentity: B
  /** This reference's cancellable wait for the shared initial history
   *  `Session.open()` attempt to settle. A rejection means the child could
   *  not be opened; the caller releases the handle and leaves the surface
   *  untouched. */
  readonly ready: Promise<unknown>
  /** Release exactly once; idempotent afterwards. */
  release(): void
}

/**
 * Acquire ownership of the TUI's visible main surface for one Session.
 *
 * This is the navigation acquisition: it may materialize a cold generation,
 * because selecting a Session legitimately opens its history. It does NOT wait
 * for `ready` — the caller commits the owner immediately and the initial
 * history `cold`/`loading`/`error` states are presentation.
 *
 * @param sessions - official Client sessions face.
 * @param sessionId - Session identity to own.
 * @param signal - optional navigation cancellation.
 * @returns the owned reference handle.
 * @throws when the Host/Client cannot retain the identity (unknown Session,
 *   aborted signal, disposed controller); the caller classifies it.
 */
export function acquireMainSurfaceReference(
  sessions: RemoteRetainSource,
  sessionId: string,
  signal?: AbortSignal,
): MainSurfaceReference {
  const reference = sessions.retain(sessionId, {
    source: 'tuiMainView',
    ...signal === undefined ? {} : { signal },
  })
  return {
    sessionId,
    bindingIdentity: reference.binding as object,
    release: (): void => { reference.release() },
  }
}

/**
 * Acquire ownership of one subagent child viewer's exact Session generation.
 *
 * The address is the same durable `SubagentAddress` the Task row carries
 * (`parentSessionId` + `childSessionId` + catalog `mode`), so the acquisition
 * can never drift onto the main Session or fabricate a lineage. It does NOT
 * materialize a Host Agent: a subagent child is retained by its address, and
 * the official Client opens only the child's history.
 *
 * The returned handle owns Client lifetime until `release()`. A failed
 * acquisition throws (the caller's viewer stays untouched); the caller awaits
 * `ready` only when the viewer must start from a stable first window.
 *
 * @param sessions - official Client sessions face.
 * @param address - exact durable subagent view address.
 * @param signal - optional open cancellation (a viewer exit/switch).
 * @returns the owned child-view reference handle.
 */
export function acquireChildViewReference<B extends object = object>(
  sessions: RemoteRetainSource,
  address: RemoteSubagentViewAddress,
  signal?: AbortSignal,
): ChildViewReference<B> {
  const reference = sessions.retain(address, {
    source: 'tuiChildView',
    ...signal === undefined ? {} : { signal },
  })
  let released = false
  return {
    parentSessionId: address.parentSessionId,
    childSessionId: reference.sessionId,
    bindingIdentity: reference.binding as B,
    ready: reference.ready,
    release: (): void => {
      if (released) return
      released = true
      reference.release()
    },
  }
}

/**
 * Pin the EXACT Client generation currently retained for one Session.
 *
 * The existing binding is borrowed before any retain so a plain operation can
 * never materialize a cold/unowned Session as a side effect. The temporary
 * `tuiOperation` reference makes that exact generation outlive the await; a
 * same-id generation replacement cannot slip in while the pin is held, because
 * the official Client only retires a generation when its last reference is
 * released.
 *
 * @param sessions - official Client sessions face.
 * @param sessionId - Session identity to pin.
 * @returns the pinned generation, or `undefined` when no generation is
 *   currently retained (including a replacement observed between borrow and
 *   retain — never a stale binding).
 */
export function pinExistingGeneration<B extends object>(
  sessions: RemoteReferenceSessionsSource<B>,
  sessionId: string,
): PinnedGeneration<B> | undefined {
  const borrowed = sessions.binding(sessionId)
  if (borrowed === undefined) return undefined
  const reference = sessions.retain(sessionId, { source: 'tuiOperation' })
  // A replacement generation would mean the borrow is already stale; refuse it
  // rather than pinning the wrong generation.
  if (!Object.is(borrowed, reference.binding)) {
    reference.release()
    return undefined
  }
  return { binding: borrowed, release: (): void => { reference.release() } }
}
