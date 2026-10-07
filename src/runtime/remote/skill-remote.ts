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
 * Explicitly unsupported on the wire (
 * requalified through 0.2.0-rc.2): the sessionless STANDING catalog (every
 * skills endpoint is Session-addressed), the Client skill-body read (no
 * `skills/read`; human gestures stay literal and the Host pre-step owns
 * injection), and `onSkillsChange` hot invalidation (no `skills/*` entry in
 * the forwarded Remote-event selection — strong re-read on Session/binding
 * entry, explicit `/reload` and `connection/reset` instead). No private
 * event, no Client filesystem scan, no second catalog authority.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/skill-remote
 */

import { cancellationError } from '../process/tasks.ts'
import { remoteFailureMessage } from './write-failure.ts'
import type { HumanSkillCatalog, HumanSkillSummary } from '../../domain/catalog/skill.ts'
import type { SkillCatalogCapability, SkillDefinitionResult } from '../catalog-port.ts'
import type { StandingSkillRead } from '../../runtime/catalog-port.ts'
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
  private readonly generation: RemoteConnectionGenerationSource

  constructor(skills: RemoteSkillRemotes, generation: RemoteConnectionGenerationSource) {
    this.skills = skills
    this.generation = generation
  }

  async standing(_presetId: string | undefined, _cwd: string, _signal?: AbortSignal): Promise<StandingSkillRead> {
    // No sessionless official catalog exists on the wire: this is an
    // explicit unsupported capability, never a Client filesystem scan and
    // never a fabricated empty catalog.
    throw new Error('the Remote backend has no sessionless standing skill catalog; open a Session or use /reload')
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

  onSkillsChange(_listener: () => void): void {
    // No `skills/*` forwarded Remote event exists (through 0.2.0-rc.2). No private
    // event seam: the consumers' strong re-read boundaries (Session/binding
    // entry, explicit /reload, connection/reset) own freshness instead.
  }
}
