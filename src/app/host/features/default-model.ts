/**
 * The private `piTuiDefaultModel` Host service (M6) — the ONE authority that
 * persists the sessionless default model by delegating to the OFFICIAL
 * `agentDefaultModel.saveSelection()` business service.
 *
 * ```text
 * service    piTuiDefaultModel                    (Host Cordis service key)
 * method     saveSelection(selection, signal)     -> saved | refused
 * authority  ctx.agentDefaultModel + ctx.configEditor + the live Loader row
 * ```
 *
 * This is NOT a settings/config writer: it never calls `settings.replace`,
 * `ConfigEditor.edit`, a Session-create or `session.selectModel`. It reads the
 * official service faces PER CALL (no cached snapshot), proves the Host is a
 * profile-backed deployment that can actually persist (the upstream
 * `saveSelection` silently resolves when it has no profile entry or no
 * configEditor), and then makes EXACTLY ONE `agentDefaultModel.saveSelection`
 * call. A refusal is a definite PRE-write fact; once the official call starts,
 * a throw / lost ACK is the Client's `indeterminate`, never a Host `refused`.
 *
 * OWNER-ONLY: a non-Owner (or absent/ended) invocation is refused BEFORE any
 * Host service is read, so a caller that may not write cannot even probe which
 * services the Host runs.
 *
 * LAYER NOTE: this row lives in `app/host/features/**` because the built-in
 * Host Runtime owns the row and its lifetime; its wire contract lives in
 * `runtime/remote/**`, the direction the architecture gate permits.
 *
 * @module @xmoon76/dsh-pi-tui/app/host/features/default-model
 */

import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import {
  PI_TUI_DEFAULT_MODEL_NAMESPACE,
  type PiTuiDefaultModelSaveResult,
  type PiTuiDefaultModelSelection,
} from '../../../runtime/remote/pi-tui-default-model-contract.ts'

/** Cordis `FiberState.ACTIVE` (the enum is a const enum with no runtime value). */
const FIBER_ACTIVE = 2

/** The base-profile row package whose ACTIVE entry makes the write persistent
 *  (rc.3 package identity: `@deepseek-ai/dsh-agent-default-model`). */
const DEFAULT_MODEL_ROW_PACKAGE = '@deepseek-ai/dsh-agent-default-model'

/** The structural `agentDefaultModel` busines-service face this bridge needs. */
interface AgentDefaultModelLike {
  currentSelection(): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
  saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void>
}

/** Minimal structural view of one Loader entry (the live row object). */
interface LoaderEntryLike {
  readonly options: { readonly id: string; readonly name: string }
  readonly fiber?: { readonly state: number }
}

/** Minimal structural view of the Host's own Loader. */
interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
}

/**
 * The private sessionless-default-model writer. One instance per built-in Host
 * Runtime; the service leaves with the owning fiber.
 */
export class PiTuiDefaultModelHostService extends TypertRemoteService {
  /** The Typert registry owns the descriptors. The official services
   *  (`agentDefaultModel`, `configEditor`, `loader`) are resolved PER CALL
   *  through `ctx.reflect.get`, so a Host that lacks one is a truthful refusal
   *  rather than a hard inject that would keep the whole Host from starting. */
  static readonly inject = ['typert']
  /** The row lifetime: aborts an in-flight save fence when the service is
   *  disposed (Host unload/HMR). */
  private readonly lifecycle = new AbortController()
  private disposal: Promise<void> | undefined

  /**
   * @param ctx - the Host context this row is mounted in.
   */
  constructor(ctx: Context) {
    super(ctx, PI_TUI_DEFAULT_MODEL_NAMESPACE)
    ctx.effect(() => () => this.dispose(), 'pi-tui-default-model')
  }

  /**
   * The private Remote method (`piTuiDefaultModel/saveSelection`, see
   * `pi-tui-default-model-contract.ts`). A refusal is a definite pre-write
   * fact; after the official save starts there is no refusal/cancellation.
   */
  async saveSelection(
    selection: PiTuiDefaultModelSelection,
    signal: AbortSignal,
  ): Promise<PiTuiDefaultModelSaveResult> {
    signal.throwIfAborted()
    const invocation = this.ctx.invocation
    // OWNER-ONLY, BEFORE any Host read: a non-Owner must not even learn which
    // default-model services this Host runs.
    if (!this.isOwnerInvocation(invocation)) {
      return { kind: 'refused', reason: 'owner-required' }
    }
    const runSignal = AbortSignal.any([signal, invocation.signal, invocation.peer.signal, this.lifecycle.signal])
    runSignal.throwIfAborted()
    // The OFFICIAL default-model service face, read per call (never snapshotted).
    const defaultModel = this.ctx.reflect.get('agentDefaultModel') as AgentDefaultModelLike | undefined
    if (defaultModel === undefined
      || typeof defaultModel.saveSelection !== 'function'
      || typeof defaultModel.currentSelection !== 'function') {
      return { kind: 'refused', reason: 'default-model-service-unavailable' }
    }
    // Save-capability preflight: upstream `saveSelection` SILENTLY resolves when
    // it has no `configEditor` or no profile entry, so a `saved` reply is only
    // truthful on a profile-backed Host that can actually persist.
    if (this.ctx.reflect.get('configEditor') === undefined) {
      return { kind: 'refused', reason: 'profile-persistence-unavailable' }
    }
    if (!this.hasSingleActiveDefaultModelRow()) {
      return { kind: 'refused', reason: 'profile-entry-unavailable' }
    }
    // Re-check every fence immediately before the ONE official call.
    runSignal.throwIfAborted()
    if (!this.isOwnerInvocation(this.ctx.invocation)) {
      return { kind: 'refused', reason: 'owner-required' }
    }
    // The ONE official write. A fresh object (never the wire DTO by reference).
    // From here a throw or a lost ACK is the Client's `indeterminate`; the Host
    // never fabricates a `refused`/`cancelled` for a started save.
    await defaultModel.saveSelection({
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    })
    return { kind: 'saved' }
  }

  async dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifecycle.abort()
    this.disposal = Promise.resolve()
    return this.disposal
  }

  /** The Host's profile must own EXACTLY ONE ACTIVE `agent-default-model` row:
   *  the upstream save is a silent no-op without the profile entry. */
  private hasSingleActiveDefaultModelRow(): boolean {
    const loader = this.ctx.reflect.get('loader') as LoaderLike | undefined
    if (loader === undefined) return false
    let active = 0
    for (const entry of loader.entries()) {
      if (entry.options.name === DEFAULT_MODEL_ROW_PACKAGE && entry.fiber?.state === FIBER_ACTIVE) active += 1
    }
    return active === 1
  }

  private isOwnerInvocation(invocation: RemoteInvocation | undefined): invocation is RemoteInvocation {
    return invocation !== undefined
      && invocation.peer.principal.kind === 'owner'
      && !invocation.signal.aborted
      && !invocation.peer.signal.aborted
  }
}
