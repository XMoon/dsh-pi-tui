/**
 * Remote implementation of the semantic `SkillCatalogCapability` port
 * (M3-3A).
 *
 * `listHumanSkills` maps to the official Session-addressed `skills/list`
 * Remote (`remote.skills.list({ sessionId }, signal)`) — the same generated
 * face dsh-web's composer consumes. The TUI DTO is detached from the wire
 * value; a Host/domain error surfaces as a rejection (never an empty
 * success), and caller cancellation is honored.
 *
 * Sessionless standing reads use the private `piTuiSkills/standing` Host
 * Workspace endpoint; Live Session reads remain on the official
 * `remote.skills.list({sessionId})`. Host `skills/change` invalidation is
 * consumed through the same package contribution and never carries Skill data.
 * The Client does not scan its own filesystem or read Skill bodies.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/skill-remote
 */

import { cancellationError } from '../process/tasks.ts'
import { remoteFailureMessage } from './write-failure.ts'
import { SupersededReadError } from '../read-error.ts'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { HumanSkillCatalog, HumanSkillSummary } from '../../domain/catalog/skill.ts'
import type { SkillCatalogCapability, SkillDefinitionResult, StandingSkillLocation, StandingSkillRead } from '../catalog-port.ts'
import {
  parsePiTuiSkillsInvalidationFrame,
  type PiTuiSkillsInvalidationFrame,
  type PiTuiSkillsStandingCall,
  type PiTuiSkillsStandingRequest,
} from './pi-tui-skills-contract.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
  RemoteReadResult,
} from './session-reader-remote.ts'

/** One human-invocable skill row returned by the official skills Remote. */
export interface RemoteSkillListEntry {
  readonly path?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

/** Value returned by the official `skills/list`. */
export interface RemoteSkillListValue {
  readonly skills: readonly RemoteSkillListEntry[]
}

/** The official generated `skills` Remote namespace consumed here. */
export interface RemoteSkillRemotes {
  list(
    request: { readonly sessionId: string },
    signal?: AbortSignal,
  ): Promise<RemoteReadResult<RemoteSkillListValue>>
}

/** The private Host Skills namespace mounted by the package's ONE contribution. */
export interface PiTuiSkillsRemotes {
  standing(
    request: PiTuiSkillsStandingRequest,
    signal?: AbortSignal,
  ): Promise<PiTuiSkillsStandingCall>
  watchInvalidations(signal?: AbortSignal): RemoteStreamHandle<PiTuiSkillsInvalidationFrame, never>
}

/** One detached summary per wire row — only the fields the TUI catalog DTO
 * carries (the wire `path` is Host-side display metadata the picker never
 * reads; untrusted rows are refused rather than coerced). */
function detachedSummary(entry: RemoteSkillListEntry): HumanSkillSummary | undefined {
  if (typeof entry.name !== 'string' || entry.name === '') return undefined
  if (typeof entry.description !== 'string') return undefined
  return {
    name: entry.name,
    description: entry.description,
    ...typeof entry.whenToUse === 'string' && entry.whenToUse !== '' ? { whenToUse: entry.whenToUse } : {},
    ...typeof entry.modelInvocable === 'boolean' ? { modelInvocable: entry.modelInvocable } : {},
  }
}

/** The Remote skill catalog: official `skills/list` only. */
export class RemoteSkillCatalog implements SkillCatalogCapability {
  private readonly skills: RemoteSkillRemotes
  private readonly piTuiSkills: PiTuiSkillsRemotes
  private readonly generation: RemoteConnectionGenerationSource

  constructor(
    skills: RemoteSkillRemotes,
    piTuiSkills: PiTuiSkillsRemotes,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.skills = skills
    this.piTuiSkills = piTuiSkills
    this.generation = generation
  }

  async standing(
    presetId: string | undefined,
    location: StandingSkillLocation,
    signal?: AbortSignal,
  ): Promise<StandingSkillRead> {
    signal?.throwIfAborted()
    if (location.kind !== 'host-workspace') {
      throw new Error('the Remote standing skill catalog requires a Host workspace identity')
    }
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) {
      throw new SupersededReadError('the Remote connection is unavailable for a standing skill read')
    }
    const requestSignal = signal ?? new AbortController().signal
    let result: PiTuiSkillsStandingCall
    try {
      result = await this.piTuiSkills.standing({
        workspaceId: location.workspaceId,
        ...(presetId === undefined ? {} : { presetId }),
      }, requestSignal)
      requestSignal.throwIfAborted()
    } catch (error) {
      requestSignal.throwIfAborted()
      if (!Object.is(capturedGeneration, this.generation.getSnapshot())) {
        throw new SupersededReadError('the Remote connection changed during a standing skill read')
      }
      throw error
    }
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) {
      throw new SupersededReadError('the Remote connection changed during a standing skill read')
    }
    if (!result.ok) {
      const error = result.error
      const code = typeof error === 'object' && error !== null
        ? (error as { readonly code?: unknown }).code
        : undefined
      if (code === 'ABORT_ERR' || code === 'gateway/cancelled') {
        throw cancellationError('remote standing skill read was aborted')
      }
      throw new Error(`piTuiSkills/standing failed: ${remoteFailureMessage(error)}`)
    }
    return {
      catalog: { skills: result.value.skills, complete: result.value.complete },
      ...(result.value.notice === undefined ? {} : { notice: result.value.notice }),
    }
  }

  async listHumanSkills(sessionId: string, signal?: AbortSignal): Promise<HumanSkillCatalog | undefined> {
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined
    const requestSignal = signal ?? new AbortController().signal

    let result: RemoteReadResult<RemoteSkillListValue>
    try {
      result = await this.skills.list({ sessionId }, requestSignal)
      requestSignal.throwIfAborted()
    } catch (error) {
      requestSignal.throwIfAborted()
      // A replaced Connection is an unavailable read, never a Host failure
      // the new generation must answer for.
      if (!Object.is(capturedGeneration, this.generation.getSnapshot())) return undefined
      throw error
    }
    if (!Object.is(capturedGeneration, this.generation.getSnapshot())) return undefined
    if (!result.ok) {
      const error = result.error
      const code = typeof error === 'object' && error !== null
        ? (error as { readonly code?: unknown }).code
        : undefined
      if (code === 'ABORT_ERR' || code === 'gateway/cancelled') {
        throw cancellationError('remote skill catalog read was aborted')
      }
      // A Host/domain error is an error, not an empty success.
      throw new Error(`skills/list failed: ${remoteFailureMessage(error)}`)
    }
    // The official list is one complete observation; malformed rows are
    // refused individually rather than coerced.
    const skills: HumanSkillSummary[] = []
    for (const entry of result.value.skills) {
      const summary = detachedSummary(entry)
      if (summary !== undefined) skills.push(summary)
    }
    return { skills, complete: true }
  }

  async resolveSkill(_sessionId: string, _name: string): Promise<SkillDefinitionResult> {
    // No Client skill-body read exists on the wire (no `skills/read`):
    // unavailable, never a local SKILL.md load.
    return { kind: 'unavailable' }
  }

  hostLoadsSkillBody(_sessionId: string): boolean {
    // A composition-owned invariant, not a wire probe: the supported M3
    // Host compositions mount the Host pre-step skill loader, so human skill
    // gestures stay literal and the HOST performs body injection. M5
    // external attach must re-evaluate this assumption, not inherit it.
    return true
  }

  onSkillsChange(listener: () => void, onError: (error: unknown) => void): () => void {
    let disposed = false
    let observedGeneration = this.generation.getSnapshot()
    let active: { readonly controller: AbortController } | undefined

    const open = (generation: RemoteConnectionGeneration): void => {
      const controller = new AbortController()
      active = { controller }
      const consume = async (): Promise<void> => {
        const stream = this.piTuiSkills.watchInvalidations(controller.signal)
        try {
          for await (const value of stream) {
            controller.signal.throwIfAborted()
            if (!Object.is(generation, this.generation.getSnapshot())) return
            parsePiTuiSkillsInvalidationFrame(value)
            listener()
          }
          if (!controller.signal.aborted && Object.is(generation, this.generation.getSnapshot())) {
            throw new Error('piTuiSkills/watchInvalidations ended unexpectedly')
          }
        } finally {
          stream.dispose()
        }
      }
      consume().catch(error => {
        if (disposed || controller.signal.aborted || !Object.is(generation, this.generation.getSnapshot())) return
        if (active?.controller === controller) active = undefined
        onError(error)
      })
    }

    const restart = (generation: RemoteConnectionGeneration | undefined): void => {
      active?.controller.abort()
      active = undefined
      if (generation !== undefined && !disposed) open(generation)
    }

    if (observedGeneration !== undefined) open(observedGeneration)
    const unsubscribe = this.generation.subscribe(() => {
      const next = this.generation.getSnapshot()
      if (Object.is(next, observedGeneration)) return
      observedGeneration = next
      restart(next)
    })

    return () => {
      if (disposed) return
      disposed = true
      unsubscribe()
      active?.controller.abort()
      active = undefined
    }
  }
}
