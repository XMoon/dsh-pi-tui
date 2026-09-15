/**
 * Experimental Remote implementation of the semantic PresetCatalog port (D2.3).
 *
 * Reads map to the official `agentPresets.list` roster (path-free rows beside
 * the Host-effective default and the mode-selection policy). The write maps to
 * the official `agentPresets.select(sessionId, presetId)`; the Host owns the
 * serialized switch ordering, the blank-session re-check, the recompose
 * transaction and the durable `agent-preset/selected` commit.
 *
 * Rules (D2.3 plan §9.2): no local blank reducer, no local recompose logic, no
 * generated setup callback, no Agent object, no retry after ambiguous dispatch.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/preset-remote
 */

import type { PresetCatalog, PresetRosterDto, PresetRosterEntry } from '../catalog-port.ts'
import { GATEWAY_PRE_INVOCATION_CODES, type OperationResult, type WriteOutcome } from '../write-outcome.ts'
import { GenerationCache } from './generation-cache.ts'
import type { RemoteConnectionGenerationSource } from './session-reader-remote.ts'
import { remoteRejected, remoteNotDispatched, remoteFailureCode, remoteFailureMessage, type RemoteWriteFailure } from './write-failure.ts'
import type { RemoteResultLike } from './session-writer-remote.ts'

/** One path-free row of the official `agentPresets.list` roster. */
export interface RemotePresetRosterRow {
  readonly id: string
  readonly trust: string
  readonly isDefault?: boolean
  readonly name?: string
  readonly description?: string
  readonly broken?: string
}

/** The official `agentPresets.list` roster value. */
export interface RemotePresetRoster {
  readonly presets: readonly RemotePresetRosterRow[]
  readonly modeSelectionEnabled: boolean
}

/** The official generated `agentPresets` Remote face. */
export interface RemotePresetRemotes {
  list(): Promise<RemoteResultLike<RemotePresetRoster>>
  select(sessionId: string, presetId: string): Promise<RemoteResultLike<string>>
}

function generationChanged(generation: RemoteConnectionGenerationSource, captured: unknown): boolean {
  return !Object.is(captured, generation.getSnapshot())
}

function copyRosterEntry(row: RemotePresetRosterRow): PresetRosterEntry {
  return {
    id: row.id,
    trust: row.trust,
    ...row.name === undefined ? {} : { name: row.name },
    ...row.description === undefined ? {} : { description: row.description },
    ...row.broken === undefined ? {} : { broken: row.broken },
  }
}

/** Detach a roster DTO for cache storage or for a caller. */
function copyRoster(roster: PresetRosterDto): PresetRosterDto {
  return {
    presets: roster.presets.map(copyRosterEntry),
    ...roster.defaultId === undefined ? {} : { defaultId: roster.defaultId },
    modeSelectionEnabled: roster.modeSelectionEnabled,
  }
}

/**
 * Operation-specific settlement for `agentPresets.select`. Only an EXACT
 * proven pre-commit refusal (`agent-preset/locked`, `agent-preset/not-found`,
 * `agent-preset/invalid`, `session/not-found`, `session/agent-busy`,
 * `gateway/bad-request`, a pre-invocation Gateway code) is `rejected`;
 * anything else is `indeterminate`. The D2.2 broad refusal helper is
 * deliberately NOT used and no namespace prefix is treated as proof.
 *
 * `session/not-found`/`session/agent-busy` are proven because the pinned Host
 * resolves the Agent via `resolveAgent()` BEFORE `agentPresets.select` enters
 * its mutation (§0.7.2). `gateway/internal` stays indeterminate: it is too
 * broad to prove no preset mutation happened.
 *
 * This classifier only ever runs AFTER dispatch, so a cancellation code is
 * likewise `indeterminate` (§0.2.4); pre-dispatch cancellation is
 * `remoteNotDispatched()`.
 */
export function classifyRemotePresetFailure(error: unknown): RemoteWriteFailure {
  const code = remoteFailureCode(error)
  const proven = code !== undefined && (
    code === 'gateway/bad-request'
    || code === 'session/not-found'
    || code === 'session/agent-busy'
    || REMOTE_PRESET_REFUSAL_CODES.has(code)
    || GATEWAY_PRE_INVOCATION_CODES.has(code)
  )
  if (proven) {
    return { kind: 'rejected', error: { code: code as string, message: remoteFailureMessage(error) } }
  }
  return {
    kind: 'indeterminate',
    error: { code: code ?? 'agent-preset/select-indeterminate', message: remoteFailureMessage(error) },
  }
}

/** The exact official preset-switch refusal codes (`agentPresets.select`). */
const REMOTE_PRESET_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'agent-preset/locked',
  'agent-preset/not-found',
  'agent-preset/invalid',
])

/** The experimental Remote preset catalog. */
export class RemotePresetCatalog implements PresetCatalog {
  private readonly presets: RemotePresetRemotes
  private readonly generation: RemoteConnectionGenerationSource
  /** The last loaded Host roster (default + rows + policy), generation-tagged,
   *  latest-read-wins, detached on read AND write. */
  private readonly rosterCache = new GenerationCache<PresetRosterDto>(copyRoster)
  /** Owner token for overlapping same-generation preset selections (v2 §0.2.5).
   *  adapter-global is accepted ONLY under the current single-live-session TUI
   *  invariant; if one adapter later serves independently writable concurrent
   *  Session surfaces, key the ownership epoch by semantic subject/sessionId. */
  private writeEpoch = 0

  constructor(presets: RemotePresetRemotes, generation: RemoteConnectionGenerationSource) {
    this.presets = presets
    this.generation = generation
  }

  available(): boolean {
    return true
  }

  async roster(signal?: AbortSignal): Promise<PresetRosterDto> {
    const captured = this.generation.getSnapshot()
    if (captured === undefined) throw new Error('remote connection is not connected')
    signal?.throwIfAborted()
    const epoch = this.rosterCache.beginRead()
    const result = await this.presets.list()
    // A generation replaced while the read was in flight must not publish a
    // roster from the previous Host — and its failure is likewise not the
    // current Host's failure.
    if (generationChanged(this.generation, captured)) {
      throw new Error('remote connection changed while loading the preset roster')
    }
    // v2 §0.2.3 order: generation, then a LOCAL abort, then Host classification
    // — an aborted caller must not surface a stale Host failure.
    signal?.throwIfAborted()
    if (!result.ok) throw new Error(`agentPresets.list failed: ${remoteFailureMessage(result.error)}`)
    const defaultId = result.value.presets.find(preset => preset.isDefault === true)?.id
    const dto: PresetRosterDto = {
      presets: result.value.presets.map(copyRosterEntry),
      ...defaultId === undefined ? {} : { defaultId },
      modeSelectionEnabled: result.value.modeSelectionEnabled,
    }
    // Latest-only read (v2 §0.2.3): a newer roster read supersedes this one.
    // Never cache or return the stale DTO; serve the newer value when present.
    if (!this.rosterCache.publish(epoch, captured, dto)) {
      const newer = this.rosterCache.snapshot(this.generation.getSnapshot())
      if (newer !== undefined) return newer
      throw new Error('the preset roster read was superseded by a newer request')
    }
    return this.rosterCache.snapshot(captured)!
  }

  async resolve(id?: string, signal?: AbortSignal): Promise<{ readonly id?: string }> {
    const roster = await this.roster(signal)
    const wanted = id ?? roster.defaultId
    if (wanted === undefined) return {}
    const found = roster.presets.find(preset => preset.id === wanted)
    if (found === undefined) {
      throw new Error(`preset "${wanted}" not found (available: ${roster.presets.map(preset => preset.id).join(', ') || 'none'})`)
    }
    return { id: found.id }
  }

  defaultId(): string | undefined {
    // The synchronous projection cannot inspect the async roster; callers that
    // need the Host-effective default use roster()/resolve(). A reconnect
    // invalidates the cached roster so a stale Host default is never exposed.
    return this.rosterCache.snapshot(this.generation.getSnapshot())?.defaultId
  }

  async selectSessionPreset(
    sessionId: string,
    presetId: string,
    signal?: AbortSignal,
  ): Promise<OperationResult<{ readonly preset: string }>> {
    if (signal?.aborted === true) return { ownership: 'current', outcome: { kind: 'cancelled' } }
    const captured = this.generation.getSnapshot()
    if (captured === undefined) return { ownership: 'current', outcome: remoteNotDispatched() }
    if (generationChanged(this.generation, captured)) {
      return { ownership: 'current', outcome: remoteNotDispatched() }
    }
    // Owner token for overlapping same-generation preset selections (§0.2.5).
    const epoch = ++this.writeEpoch
    const result = await this.presets.select(sessionId, presetId)
    // Classify FIRST (v2 §0.2.2/§0.7.2), THEN mark local ownership: a refusal
    // or success from the Host that processed the call is provable regardless
    // of a later generation change; only the local surface ownership is lost.
    const outcome: WriteOutcome<{ readonly preset: string }> = result.ok
      ? { kind: 'committed', value: { preset: result.value } }
      : classifyRemotePresetFailure(result.error)
    const superseded = generationChanged(this.generation, captured)
      || epoch !== this.writeEpoch
      || Boolean(signal?.aborted)
    return { ownership: superseded ? 'superseded' : 'current', outcome }
  }
}
