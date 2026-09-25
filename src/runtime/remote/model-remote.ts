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
 * - NO second global-default write from the TUI;
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
  ModelProviderSummary,
  ModelSelectionDto,
  ProviderDirectoryEntry,
} from '../catalog-port.ts'
import { GATEWAY_PRE_INVOCATION_CODES, type OperationResult, type WriteOutcome } from '../write-outcome.ts'
import { GenerationCache } from './generation-cache.ts'
import { SupersededReadError } from '../read-error.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import { remoteRejected, remoteNotDispatched, remoteFailureCode, remoteFailureMessage, copyFailureDetails, settledWriteMessage, type RemoteWriteFailure } from './write-failure.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'

/** The official generated `session` Remote read/write face the catalog needs. */
export interface RemoteModelRemotes {
  modelCatalog(): Promise<RemoteResultLike<ModelDirectoryDto>>
  selectModel(request: {
    readonly sessionId: string
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }): Promise<RemoteResultLike<{ readonly selected: ModelSelectionDto }>>
}

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

/** Read `projection.next ?? projection.lastUsed` off an official face value. */
function projectedSelection(value: unknown): ModelSelectionDto | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { readonly next?: unknown; readonly lastUsed?: unknown }
  return copySelection(record.next) ?? copySelection(record.lastUsed)
}

/** The experimental Remote model catalog. */
export class RemoteModelCatalog implements ModelCatalog {
  private readonly session: RemoteModelRemotes
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
  ) {
    this.session = session
    this.sessions = sessions
    this.generation = generation
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

  listProviders(): readonly ModelProviderSummary[] {
    // Provider ENDPOINT/config discovery has no official Remote capability in
    // D2.3. The `/model` directory is NOT that capability (it drops empty and
    // failing routable providers and only exists after a read), so the Remote
    // adapter reports it UNAVAILABLE rather than faking it from the directory
    // cache. The subagent allowlist and the `/login` merge stay Direct-only.
    return []
  }

  listModels(_providerId: string): Promise<readonly ModelInfoSummary[]> {
    // Same: a per-provider list for provider discovery is not the `/model`
    // directory read; no official Remote capability → unavailable.
    return Promise.resolve([])
  }

  saveDefaultSelection(_selection: ModelSelectionDto): Promise<WriteOutcome<void>> {
    // The Remote path has NO global-default write from the TUI (plan §9.1):
    // `session.selectModel` already performs the Host's best-effort default
    // save. A sessionless /model choice therefore has no Remote expression.
    return Promise.resolve({
      kind: 'unsupported',
      reason: 'the Remote backend has no global-default model write; select a model in a Session instead',
    })
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

  discoverModels(_request: ModelDiscoveryRequest): Promise<readonly ModelInfoSummary[]> {
    // Provider discovery has no official Remote verb yet; it remains a Direct
    // capability (the add-provider wizard is not migrated in D2.3).
    return Promise.resolve([])
  }

  listConfigurableProviders(): readonly ProviderDirectoryEntry[] | undefined {
    return undefined
  }
}
