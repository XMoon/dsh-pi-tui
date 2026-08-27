/**
 * The renderer registry (M7, plan §12): plugin transcript/tool renderers.
 *
 * Two extension points:
 * - `transcript.message.renderer` — a CHAIN: renderers are consulted in
 *   registration order (order ASC, id ASC); the first non-undefined
 *   `ExtensionView` wins; undefined abdicates to the next renderer, then
 *   the host fallback.
 * - `transcript.tool.renderer.<toolName>` — KEYED: one winner per tool
 *   name (lowest priority wins, a tie is an error); the winner's
 *   `undefined` abdicates to the next tool renderer, then the host
 *   fallback.
 *
 * Contract (plan §12):
 * - renderers receive ONLY semantic snapshots (never mutable
 *   TranscriptMessage, never the messages container, never the terminal);
 * - a renderer that THROWS is isolated (recorded in the health ledger)
 *   and the chain continues — a plugin can never stall the transcript;
 * - renderer registration/unload bumps the registry revision; the host's
 *   message cache embeds rendererId + rendererRevision in its identity, so
 *   an HMR/unload rebuilds exactly the affected components (plan §12.1);
 * - unload removes the renderer (fiber-bound).
 * @module @xmoon76/dsh-pi-tui/renderer-registry
 */

import type {
  ExtensionView,
  MessagePresentationSnapshot,
  ToolPresentationSnapshot,
  TuiMessageRendererContribution,
  TuiRendererHandle,
  TuiRendererRegistrySnapshot,
  TuiToolRendererContribution,
} from './extension/public-types.ts'

/** Internal message-renderer record. */
interface MessageRendererRecord {
  readonly id: string
  readonly kind: MessagePresentationSnapshot['kind'] | undefined
  readonly render: (snapshot: MessagePresentationSnapshot) => ExtensionView | undefined
  readonly description: string | undefined
  readonly owner: string
  readonly order: number
  disposed: boolean
}

/** Internal tool-renderer record. */
interface ToolRendererRecord {
  readonly id: string
  readonly toolName: string
  readonly render: (snapshot: ToolPresentationSnapshot) => ExtensionView | undefined
  readonly description: string | undefined
  readonly owner: string
  readonly priority: number
  disposed: boolean
}

/**
 * The renderer registry. One instance backs the runner; the extension
 * service exposes registration; the TuiApp asks {@link renderMessage} /
 * {@link renderTool} when building the transcript cache.
 */
export class RendererRegistry {
  private readonly messageRenderers = new Map<string, MessageRendererRecord>()
  private readonly toolRenderers = new Map<string, ToolRendererRecord>()
  private revision = 0
  private readonly onInvalidate: () => void

  constructor(onInvalidate: () => void = () => {}) {
    this.onInvalidate = onInvalidate
  }

  /**
   * Register a message renderer (chain slot). A duplicate id is an error.
   * @param contribution - the renderer.
   * @param owner - the Cordis fiber name.
   * @returns a handle to remove the renderer.
   */
  registerMessageRenderer(contribution: TuiMessageRendererContribution, owner: string): TuiRendererHandle {
    if (this.messageRenderers.has(contribution.id)) {
      throw new Error(`duplicate message renderer id "${contribution.id}"`)
    }
    this.messageRenderers.set(contribution.id, {
      id: contribution.id,
      kind: contribution.kind,
      render: contribution.render,
      description: contribution.description,
      owner,
      order: contribution.order ?? 0,
      disposed: false,
    })
    this.revision += 1
    this.onInvalidate()
    return { id: contribution.id, dispose: () => this.disposeMessageRenderer(contribution.id) }
  }

  /**
   * Register a tool renderer (keyed slot). A duplicate id OR a priority
   * TIE on the same tool name is an explicit error (never a registration-
   * time guess — plan §5.3 single semantics).
   * @param contribution - the renderer.
   * @param owner - the Cordis fiber name.
   * @returns a handle to remove the renderer.
   */
  registerToolRenderer(contribution: TuiToolRendererContribution, owner: string): TuiRendererHandle {
    if (this.toolRenderers.has(contribution.id)) {
      throw new Error(`duplicate tool renderer id "${contribution.id}"`)
    }
    for (const record of this.toolRenderers.values()) {
      if (record.disposed) continue
      if (record.toolName === contribution.toolName && record.priority === (contribution.priority ?? 0)) {
        throw new Error(
          `tool renderer priority tie on "${contribution.toolName}": "${record.id}" and "${contribution.id}" both have priority ${contribution.priority ?? 0}`,
        )
      }
    }
    this.toolRenderers.set(contribution.id, {
      id: contribution.id,
      toolName: contribution.toolName,
      render: contribution.render,
      description: contribution.description,
      owner,
      priority: contribution.priority ?? 0,
      disposed: false,
    })
    this.revision += 1
    this.onInvalidate()
    return { id: contribution.id, dispose: () => this.disposeToolRenderer(contribution.id) }
  }

  private disposeMessageRenderer(id: string): void {
    const record = this.messageRenderers.get(id)
    if (record === undefined || record.disposed) return
    record.disposed = true
    this.messageRenderers.delete(id)
    this.revision += 1
    this.onInvalidate()
  }

  private disposeToolRenderer(id: string): void {
    const record = this.toolRenderers.get(id)
    if (record === undefined || record.disposed) return
    record.disposed = true
    this.toolRenderers.delete(id)
    this.revision += 1
    this.onInvalidate()
  }

  /** Dispose every renderer owned by one fiber (owner unload). */
  disposeOwner(owner: string): void {
    for (const [id, record] of [...this.messageRenderers]) {
      if (record.owner === owner) this.disposeMessageRenderer(id)
    }
    for (const [id, record] of [...this.toolRenderers]) {
      if (record.owner === owner) this.disposeToolRenderer(id)
    }
  }

  /**
   * Render one transcript message through the message-renderer chain.
   * Returns the first non-undefined view, or undefined (the host fallback
   * renders). A throwing renderer is isolated: its error is recorded via
   * onError and the chain continues (plan §18 — a renderer can never
   * stall the transcript).
   *
   * The PUBLIC contract (the Stable TuiRendererRegistryView ABI) is
   * owner-LESS: a third-party caller's `(id, error)` callback must never
   * receive the host's owner in the error slot (the review's P1 — the
   * same class as the autocomplete ABI drift: TS parameter contravariance
   * let a wider internal signature satisfy the narrower public one, so a
   * v1 plugin's second callback parameter silently became the owner).
   * The host's OWNER-scoped path is renderMessageOwned.
   * @param snapshot - the semantic message snapshot.
   * @param onError - records a renderer failure (health).
   */
  renderMessage(
    snapshot: MessagePresentationSnapshot,
    onError: (id: string, error: unknown) => void,
    canUse?: (id: string, view: ExtensionView) => boolean,
  ): { view: ExtensionView; rendererId: string } | undefined {
    const rendered = this.renderMessageOwned(
      snapshot,
      onError === undefined ? undefined : (id, _owner, error) => onError(id, error),
      canUse === undefined ? undefined : (id, _owner, view) => canUse(id, view),
    )
    return rendered === undefined ? undefined : { view: rendered.view, rendererId: rendered.rendererId }
  }

  /** HOST-ONLY variant: the callbacks and the result carry the SNAPSHOT
   * owner (the health ledger keys renderer records by (slot, owner, id)).
   * Not part of the public view. */
  renderMessageOwned(
    snapshot: MessagePresentationSnapshot,
    onError?: (id: string, owner: string, error: unknown) => void,
    canUse?: (id: string, owner: string, view: ExtensionView) => boolean,
  ): { view: ExtensionView; rendererId: string; owner: string } | undefined {
    const records = [...this.messageRenderers.values()]
      .filter(record => !record.disposed && (record.kind === undefined || record.kind === snapshot.kind))
      .sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    for (const record of records) {
      try {
        const view = record.render(snapshot)
        if (view !== undefined && (canUse === undefined || canUse(record.id, record.owner, view))) {
          return { view, rendererId: record.id, owner: record.owner }
        }
      } catch (error) {
        try { onError?.(record.id, record.owner, error) } catch {}
      }
    }
    return undefined
  }

  /**
   * Render one tool card through the tool-renderer chain (the winner for
   * the tool name first, then the remaining renderers as a fallback chain
   * — plan §12: keyed + fallback chain). Owner-less public ABI — see
   * renderMessage; the host path is renderToolOwned.
   */
  renderTool(
    snapshot: ToolPresentationSnapshot,
    onError: (id: string, error: unknown) => void,
    canUse?: (id: string, view: ExtensionView) => boolean,
  ): { view: ExtensionView; rendererId: string } | undefined {
    const rendered = this.renderToolOwned(
      snapshot,
      onError === undefined ? undefined : (id, _owner, error) => onError(id, error),
      canUse === undefined ? undefined : (id, _owner, view) => canUse(id, view),
    )
    return rendered === undefined ? undefined : { view: rendered.view, rendererId: rendered.rendererId }
  }

  /** HOST-ONLY variant: the callbacks and the result carry the SNAPSHOT
   * owner. Not part of the public view. */
  renderToolOwned(
    snapshot: ToolPresentationSnapshot,
    onError?: (id: string, owner: string, error: unknown) => void,
    canUse?: (id: string, owner: string, view: ExtensionView) => boolean,
  ): { view: ExtensionView; rendererId: string; owner: string } | undefined {
    const records = [...this.toolRenderers.values()]
      .filter(record => !record.disposed && record.toolName === snapshot.toolName)
      .sort((left, right) => left.priority - right.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    for (const record of records) {
      try {
        const view = record.render(snapshot)
        if (view !== undefined && (canUse === undefined || canUse(record.id, record.owner, view))) {
          return { view, rendererId: record.id, owner: record.owner }
        }
      } catch (error) {
        try { onError?.(record.id, record.owner, error) } catch {}
      }
    }
    return undefined
  }

  /** Whether any renderer is live (health /status). */
  hasAny(): boolean {
    for (const record of this.messageRenderers.values()) {
      if (!record.disposed) return true
    }
    for (const record of this.toolRenderers.values()) {
      if (!record.disposed) return true
    }
    return false
  }

  /** The current registry revision — O(1), for the host's render-path
   * staleness gate (a full snapshot() is O(contributions), so the frame
   * loop must never call it; P1-1 dynamic renderer invalidation). */
  revisionOf(): number {
    return this.revision
  }

  /** An immutable snapshot (diagnostics + /status). */
  snapshot(): TuiRendererRegistrySnapshot {
    const messageRenderers = [...this.messageRenderers.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(record => ({
        id: record.id,
        kind: record.kind,
        description: record.description,
        owner: record.owner,
      }))
    const toolRenderers = [...this.toolRenderers.values()]
      .filter(record => !record.disposed)
      .sort((left, right) => left.toolName.localeCompare(right.toolName) || left.id.localeCompare(right.id))
      .map(record => ({
        id: record.id,
        toolName: record.toolName,
        description: record.description,
        owner: record.owner,
      }))
    return { messageRenderers, toolRenderers, revision: this.revision }
  }
}
