/**
 * Experimental Remote implementation of the semantic ModelCatalog port (D2.3).
 *
 * Reads map to the official Host-generation `session.modelCatalog()` one-shot
 * directory (default + routable providers + grouped models + isolated provider
 * failures) and the Session binding's `modelSelection` projection. Writes map
 * to the official `session.selectModel`; the Host owns provider/model
 * validation, reasoning-effort normalization, the durable Session-local commit
 * and the best-effort global-default save.
 *
 * Rules (D2.3 plan §9.1):
 * - no Host imports, no Direct model owner, no custom reasoning normalization;
 * - the Session write has NO second global-default write from the TUI (the
 *   official `session.selectModel` already performs the Host's best-effort save);
 * - the SESSIONLESS default write goes through the ONE private, Owner-only
 *   `piTuiDefaultModel/saveSelection` service, which delegates to the official
 *   `agentDefaultModel.saveSelection`; it is the only expression of a
 *   sessionless `/model Save default`;
 * - no blind retry; a captured Connection generation fences the binding;
 * - the Host return supplies the normalized accepted selection and the durable
 *   projection remains display authority.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/model-remote
 */

import type {
  ModelCatalog,
  ModelDirectoryDto,
  ModelDirectoryFailureDto,
  ModelDirectoryGroupDto,
  ModelDiscoveryRequest,
  ModelInfoSummary,
  ModelSelectionDto,
  ProviderDirectoryEntry,
} from '../catalog-port.ts'
import { GATEWAY_PRE_INVOCATION_CODES, type OperationResult, type WriteOutcome } from '../write-outcome.ts'
import { GenerationCache } from './generation-cache.ts'
import { SupersededReadError } from '../read-error.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import { remoteRejected, remoteNotDispatched, remoteFailureCode, remoteFailureMessage, copyFailureDetails, settledWriteMessage, type RemoteWriteFailure } from './write-failure.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'
import { normalizeModelSelection } from '../../domain/session/model-selection.ts'
import type {
  PiTuiDefaultModelNamespace,
  PiTuiDefaultModelSaveRefusal,
  PiTuiDefaultModelSaveResult,
  PiTuiDefaultModelSelection,
} from './pi-tui-default-model-contract.ts'

/** The official generated `session` Remote read/write face the catalog needs. */
export interface RemoteModelRemotes {
  modelCatalog(): Promise<RemoteResultLike<ModelDirectoryDto>>
  selectModel(request: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<RemoteResultLike<{ readonly selected: ModelSelectionDto }>>
  /** The official Host-authoritative Session list (WS-2): the fail-closed read
   *  for a historical Session's persisted header cwd. */
  list(
    request: { readonly cursor?: string },
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<{
    readonly items: readonly { readonly sessionId: string; readonly cwd?: string }[]
  }>>
}

/** The official generated `llm` Remote namespace the wizard probe needs
 *  (`llm/discoverModels(settingsNs, request, signal)`; `llm.listModels` is a
 *  Host method with no public Remote — the grouped directory above is the
 *  only selectable catalog). */
export interface RemoteLlmRemotes {
  discoverModels(
    settingsNs: string,
    request: ModelDiscoveryRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResultLike<readonly { readonly id: string; readonly name?: string }[]>>
}

/** The TUI add-provider wizard's settings family (the Direct adapter probes
 *  the same namespace; the wizard's provider profiles live under it). */
const WIZARD_SETTINGS_NS = 'llm-pi-ai'

/** The official Client Session projection face subset used by the read. */
export interface RemoteModelProjectionFace {
  getSnapshot(): unknown
}

/** The official Client Session binding subset consumed by this adapter. */
export interface RemoteModelBinding {
  readonly session: {
    readonly projections: {
      faceOf(key: string): RemoteModelProjectionFace
    }
  }
}

/** The official `ClientSessions` identity face. */
export interface RemoteModelSessionsSource {
  binding(sessionId: string): RemoteModelBinding | undefined
}

function generationChanged(generation: RemoteConnectionGenerationSource, captured: unknown): boolean {
  return !Object.is(captured, generation.getSnapshot())
}

/** Detach an official selection into the semantic DTO (never the Host object). */
function copySelection(value: unknown): ModelSelectionDto | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown }
  // Untrusted success payloads must MATCH the normalized shape, not be coerced:
  // an empty provider/model or a present-but-non-string effort is unusable
  // (never a fabricated committed selection).
  if (typeof record.provider !== 'string' || record.provider === '') return undefined
  if (typeof record.model !== 'string' || record.model === '') return undefined
  // Any PRESENT effort must be a non-empty string: `null` (or any other
  // non-string) is unusable, never silently equivalent to "absent".
  if (record.reasoningEffort !== undefined
    && (typeof record.reasoningEffort !== 'string' || record.reasoningEffort === '')) return undefined
  return {
    provider: record.provider,
    model: record.model,
    ...typeof record.reasoningEffort === 'string' ? { reasoningEffort: record.reasoningEffort } : {},
  }
}

/** Detach an official catalog value into the semantic directory DTO. */
function copyDirectory(value: ModelDirectoryDto): ModelDirectoryDto {
  return {
    default: copySelection(value.default) ?? { provider: '', model: '' },
    routableProviders: [...value.routableProviders],
    groups: value.groups.map((group): ModelDirectoryGroupDto => ({
      id: group.id,
      name: group.name,
      models: group.models.map(model => ({
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...model.reasoning === undefined ? {} : {
          reasoning: {
            efforts: model.reasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...effort.description === undefined ? {} : { description: effort.description },
            })),
            ...model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
          },
        },
      })),
    })),
    failures: value.failures.map((failure): ModelDirectoryFailureDto => ({
      id: failure.id,
      name: failure.name,
      message: failure.message,
    })),
  }
}

/**
 * Operation-specific settlement for `session.selectModel`. Only an EXACT
 * refusal code that PROVES the selection never committed is `rejected`;
 * anything else stays `indeterminate`. The D2.2 broad refusal helper is
 * deliberately NOT used, and no namespace prefix is treated as proof: a
 * future post-commit `session/model-*` code must not be silently downgraded
 * to a rejection.
 *
 * This classifier is only ever invoked AFTER `session.selectModel` was
 * dispatched, so a cancellation code (`gateway/cancelled`, an AbortError) is
 * NOT a proven pre-commit cancellation — §0.2.4/§0.7.1 require
 * `indeterminate`. Pre-dispatch cancellation is `remoteNotDispatched()`.
 */
export function classifyRemoteModelFailure(error: unknown): RemoteWriteFailure {
  const code = remoteFailureCode(error)
  const details = copyFailureDetails(error)
  const proven = code !== undefined && (
    code === 'gateway/bad-request'
    || code === 'session/not-found'
    || code === 'session/agent-busy'
    // The Host resolves the Session Agent BEFORE selectModel runs, so a
    // writer held elsewhere is a proven pre-commit refusal (`session/writer-held`
    // carries `{ sessionId }`), never an indeterminate write.
    || code === 'session/writer-held'
    || code === 'session/model-unavailable'
    || GATEWAY_PRE_INVOCATION_CODES.has(code)
  )
  if (proven) {
    return {
      kind: 'rejected',
      error: {
        code: code as string,
        message: settledWriteMessage(code, error),
        ...details === undefined ? {} : { details },
      },
    }
  }
  return {
    kind: 'indeterminate',
    error: {
      code: code ?? 'session/model-indeterminate',
      message: remoteFailureMessage(error),
      ...details === undefined ? {} : { details },
    },
  }
}

/** User-facing message for one Host default-model refusal reason (the reason
 *  code stays machine-readable on the semantic error). */
const DEFAULT_MODEL_REFUSAL_MESSAGES: Readonly<Record<PiTuiDefaultModelSaveRefusal, string>> = {
  'owner-required': 'only the authenticated Owner peer may change the Host default model',
  'default-model-service-unavailable': 'the Host default-model service is not available',
  'profile-persistence-unavailable': 'this Host has no persisted profile to store the default model',
  'profile-entry-unavailable': 'the Host profile has no active agent-default-model entry to save into',
}

/**
 * Settlement for ONE dispatched `piTuiDefaultModel/saveSelection` failure.
 *
 * Only a PROVEN Gateway pre-invocation code (the Gateway refused BEFORE the Host
 * method ran) is a rejection. Every other dispatched failure — `gateway/internal`,
 * `gateway/cancelled`, `gateway/result-invalid`, a code-less HTTP drop — leaves
 * the commit state unproven and stays `indeterminate`. The generic D2.2
 * `isRemoteBusinessRefusalCode` is deliberately NOT used: no domain code on this
 * endpoint proves the official save did not run.
 */
export function classifyRemoteDefaultModelFailure(error: unknown): RemoteWriteFailure {
  const code = remoteFailureCode(error)
  const details = copyFailureDetails(error)
  if (code !== undefined && (code === 'gateway/bad-request' || GATEWAY_PRE_INVOCATION_CODES.has(code))) {
    return {
      kind: 'rejected',
      error: { code, message: settledWriteMessage(code, error), ...details === undefined ? {} : { details } },
    }
  }
  return {
    kind: 'indeterminate',
    error: {
      code: code ?? 'piTuiDefaultModel/indeterminate',
      message: remoteFailureMessage(error),
      ...details === undefined ? {} : { details },
    },
  }
}

/** Read `projection.next ?? projection.lastUsed` off an official face value. */
function projectedSelection(value: unknown): ModelSelectionDto | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { readonly next?: unknown; readonly lastUsed?: unknown }
  return copySelection(record.next) ?? copySelection(record.lastUsed)
}

/** The experimental Remote model catalog. */
export class RemoteModelCatalog implements ModelCatalog {
  private readonly session: RemoteModelRemotes
  private readonly llm: RemoteLlmRemotes | undefined
  private readonly piTuiDefaultModel: PiTuiDefaultModelNamespace | undefined
  private readonly sessions: RemoteModelSessionsSource
  private readonly generation: RemoteConnectionGenerationSource
  /** The last successfully loaded Host-generation directory (default fallback):
   *  generation-tagged, latest-read-wins, detached on read AND write, and
   *  invalidated by a reconnect or a committed `session.selectModel`. */
  private readonly directoryCache = new GenerationCache<ModelDirectoryDto>(copyDirectory)
  /** The Connection generation of the last successful directory load. A
   *  reconnect hides the (possibly not-yet-reset) live binding projection too,
   *  so the previous Host's model can never become authoritative. */
  private lastLoadedGeneration: unknown
  /** Owner token for overlapping same-generation selections (v2 §0.2.5).
   *  adapter-global is accepted ONLY under the current single-live-session TUI
   *  invariant; if one adapter later serves independently writable concurrent
   *  Session surfaces, key the ownership epoch by semantic subject/sessionId. */
  private writeEpoch = 0

  constructor(
    session: RemoteModelRemotes,
    sessions: RemoteModelSessionsSource,
    generation: RemoteConnectionGenerationSource,
    llm?: RemoteLlmRemotes,
    piTuiDefaultModel?: PiTuiDefaultModelNamespace,
  ) {
    this.session = session
    this.sessions = sessions
    this.generation = generation
    this.llm = llm
    this.piTuiDefaultModel = piTuiDefaultModel
  }

  available(): boolean {
    return true
  }

  async loadDirectory(signal?: AbortSignal): Promise<ModelDirectoryDto> {
    const captured = this.generation.getSnapshot()
    if (captured === undefined) throw new Error('remote connection is not connected')
    signal?.throwIfAborted()
    const epoch = this.directoryCache.beginRead()
    const result = await this.session.modelCatalog()
    // A generation replaced while the read was in flight must not publish a
    // directory from the previous Host — and its FAILURE is likewise not the
    // current Host's failure.
    if (generationChanged(this.generation, captured)) {
      throw new SupersededReadError('remote connection changed while loading the model catalog')
    }
    // v2 §0.2.3 order: generation, then a LOCAL abort, then Host classification
    // — an aborted caller must not surface a stale Host failure.
    signal?.throwIfAborted()
    if (!result.ok) throw new Error(`session.modelCatalog failed: ${remoteFailureMessage(result.error)}`)
    // Latest-only read (v2 §0.2.3): a newer read — or a select invalidation —
    // that started during the await supersedes this one. Never write the cache
    // and never return the stale DTO; serve the NEWER value when one exists.
    if (!this.directoryCache.publish(epoch, captured, result.value)) {
      const newer = this.directoryCache.snapshot(this.generation.getSnapshot())
      if (newer !== undefined) return newer
      throw new SupersededReadError('the model catalog read was superseded by a newer request')
    }
    this.lastLoadedGeneration = captured
    return this.directoryCache.snapshot(captured)!
  }

  /** Whether the cached directory still belongs to the live Connection
   *  generation (a reconnect invalidates the synchronous projection). */
  private cachedDirectory(): ModelDirectoryDto | undefined {
    return this.directoryCache.snapshot(this.generation.getSnapshot())
  }

  defaultSelection(): ModelSelectionDto | undefined {
    const directory = this.cachedDirectory()
    return directory === undefined ? undefined : { ...directory.default }
  }

  /**
   * Persist the sessionless default through the ONE private, Owner-only
   * `piTuiDefaultModel/saveSelection` service (which delegates to the official
   * `agentDefaultModel.saveSelection`). Exactly one dispatch; the Client only
   * maps the settlement, it never retains a second authority.
   */
  async saveDefaultSelection(selection: ModelSelectionDto): Promise<WriteOutcome<void>> {
    // Client-boundary validation: the SAME normalizeModelSelection contract the
    // Direct adapter applies (provider/model non-empty, effort present-or-absent).
    const next = normalizeModelSelection(selection)
    if (next === undefined) {
      return { kind: 'rejected', error: { code: 'session/model-invalid', message: 'invalid model selection' } }
    }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) return remoteNotDispatched()
    const remotes = this.piTuiDefaultModel
    if (remotes === undefined) {
      // A Client without the mounted private namespace must not claim a write.
      return {
        kind: 'rejected',
        error: { code: 'piTuiDefaultModel/unsupported', message: 'the Host sessionless default-model service is not mounted' },
      }
    }
    const wire: PiTuiDefaultModelSelection = {
      provider: next.provider,
      model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort },
    }
    // ONE private dispatch. The generated Remote THROWS on transport/envelope
    // failure, so normalize the throw to the result shape: a post-dispatch
    // failure is classified (never leaked as a bare rejection).
    const result = await remotes.saveSelection(wire).catch((error: unknown) => ({ ok: false as const, error }))
    let outcome: WriteOutcome<void>
    if (!result.ok) {
      outcome = classifyRemoteDefaultModelFailure(result.error)
    } else {
      const value: PiTuiDefaultModelSaveResult | undefined = result.value
      if (value !== undefined && value.kind === 'saved') {
        outcome = { kind: 'committed', value: undefined }
      } else if (value !== undefined && value.kind === 'refused') {
        outcome = {
          kind: 'rejected',
          error: { code: `piTuiDefaultModel/${value.reason}`, message: DEFAULT_MODEL_REFUSAL_MESSAGES[value.reason] },
        }
      } else {
        // A malformed success payload is never a fabricated commit.
        outcome = {
          kind: 'indeterminate',
          error: { code: 'piTuiDefaultModel/result-invalid', message: 'the Host returned an unusable default-model save result' },
        }
      }
    }
    // A committed/indeterminate write invalidates the SAME-generation cached
    // default (it may have changed without a provable value); a replacement
    // generation's cache is never touched. A proven rejection invalidates
    // nothing.
    if (!generationChanged(this.generation, captured)
      && (outcome.kind === 'committed' || outcome.kind === 'indeterminate')) {
      this.invalidateDirectory()
    }
    return outcome
  }

  sessionSelection(sessionId: string): ModelSelectionDto | undefined {
    const current = this.generation.getSnapshot()
    // A disconnected generation must never expose the previous Host's model as
    // authoritative; nor may a reconnect reuse a binding projection that was
    // established under a previous Host generation.
    if (current === undefined) return undefined
    if (this.lastLoadedGeneration !== undefined && !Object.is(this.lastLoadedGeneration, current)) return undefined
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) return undefined
    // The durable projection is display authority; the Host catalog default is
    // the fallback only while the Session carries no selection.
    return projectedSelection(binding.session.projections.faceOf('modelSelection').getSnapshot())
      ?? this.defaultSelection()
  }

  async selectSessionModel(
    sessionId: string,
    selection: ModelSelectionDto,
    signal?: AbortSignal,
  ): Promise<OperationResult<ModelSelectionDto>> {
    // A provable PRE-dispatch cancellation is `cancelled` (never a throw: the
    // port settles, it does not reject).
    if (signal?.aborted === true) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) return { ownership: 'current', outcome: remoteNotDispatched() }
    const binding = this.sessions.binding(sessionId)
    if (binding === undefined) {
      return {
        ownership: 'current',
        outcome: remoteRejected('session/not-found', `session "${sessionId}" is not available`),
      }
    }    if (generationChanged(this.generation, captured)) {
      return { ownership: 'current', outcome: remoteNotDispatched() }
    }
    // Same-generation overlapping selections need their own owner token
    // (v2 §0.2.5): only the newest one still owns the surface.
    const epoch = ++this.writeEpoch
    // The official generated Remote THROWS on a transport/HTTP/envelope failure
    // (it does not resolve `{ok:false}`). Normalize the throw to the failure
    // shape so a post-dispatch transport failure is classified (v2 §0.7.1:
    // code-less/transport after dispatch = indeterminate), never a rejected
    // Promise.
    const result = await this.session.selectModel({
      sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }).catch((error: unknown) => ({ ok: false as const, error }))
    // Classify FIRST (v2 §0.2.2/§0.7.1: a Host refusal/success is provable
    // regardless of the generation), THEN mark local ownership. A superseded
    // result must not repaint or notify, but its settlement (including a
    // committed Session-local selection) is real and stays non-retryable.
    const normalized = !result.ok ? undefined : copySelection(result.value.selected)
    const outcome: WriteOutcome<ModelSelectionDto> = !result.ok
      ? classifyRemoteModelFailure(result.error)
      : normalized !== undefined
        ? { kind: 'committed', value: normalized }
        // §9.1/§0.3.1: the Host return supplies the normalized accepted
        // selection. Never fabricate the REQUESTED value as authority.
        : {
            kind: 'indeterminate',
            error: { code: 'session/model-result-invalid', message: 'the Host returned an unusable normalized selection' },
          }
    // Local ownership is lost by a reconnect, a newer selection, a REPLACED
    // binding generation for the same id, or a post-dispatch abort — none of
    // which proves non-commit (v2 §0.2.4). `binding(id)` is borrow-only,
    // so the exact-generation fence is IDENTITY, never mere presence: a same-id
    // release/re-retain yields a NEW binding on the same connection.
    const superseded = generationChanged(this.generation, captured)
      || epoch !== this.writeEpoch
      || !Object.is(binding, this.sessions.binding(sessionId))
      || Boolean(signal?.aborted)
    // Cache invalidation is a HOST-GENERATION fact, independent of UI
    // ownership: the Host best-effort saved (or may have saved) the global
    // default, so the cached default is no longer provable. A same-generation
    // operation must invalidate EVEN when it lost local ownership (`epoch`,
    // binding or abort) — only a real generation REPLACEMENT must not touch the
    // replacement generation's cache.
    if (!generationChanged(this.generation, captured)
      && (outcome.kind === 'committed' || outcome.kind === 'indeterminate')) {
      this.invalidateDirectory()
    }
    return { ownership: superseded ? 'superseded' : 'current', outcome }
  }

  /** Drop the cached Host-generation directory (its default may have changed
   *  without a provable result); `invalidate` also supersedes any in-flight
   *  read so it can neither repopulate the pre-select cache nor be returned. */
  private invalidateDirectory(): void {
    this.directoryCache.invalidate()
  }

  /** Assembly disposal seam: drop the cache (and any in-flight read's
   *  publication right) before the Client Context disposal. */
  disposeCache(): void {
    this.directoryCache.invalidate()
    this.lastLoadedGeneration = undefined
  }

  async discoverModels(request: ModelDiscoveryRequest): Promise<readonly ModelInfoSummary[]> {
    // The official `llm/discoverModels(settingsNs, request, signal)` — the
    // same settings family the Direct adapter probes. A missing llm source,
    // a replaced Connection generation, or a Host refusal SURFACES as a
    // rejection: the wizard must distinguish a real failure from an empty
    // fallback list (never `[]`).
    if (this.llm === undefined) throw new Error('remote llm namespace is not available')
    const { signal, ...probe } = request
    signal?.throwIfAborted()
    const captured = this.generation.getSnapshot()
    if (captured === undefined) throw new Error('remote connection is not connected')
    const result = await this.llm.discoverModels(WIZARD_SETTINGS_NS, probe, signal).catch(
      (error: unknown) => ({ ok: false as const, error }),
    )
    signal?.throwIfAborted()
    if (generationChanged(this.generation, captured)) {
      throw new SupersededReadError('remote connection changed while discovering models')
    }
    if (!result.ok) throw new Error(`llm.discoverModels failed: ${remoteFailureMessage(result.error)}`)
    return result.value.map(model => ({
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
    }))
  }

  listConfigurableProviders(): readonly ProviderDirectoryEntry[] | undefined {
    return undefined
  }
}
