/**
 * Read-only Remote implementation of the live Session surface-authority port.
 *
 * The source faces mirror the pinned DSH generated Remotes structurally. This
 * module has no Host runtime imports and never executes a command, loads a
 * skill body, creates a Session, or installs TUI state.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/surface-authority-remote
 */

import { safeErrorMessage } from '../../error-boundary.ts'
import type {
  SurfaceAuthorityReader,
  SurfaceAuthoritySnapshot,
} from '../surface-authority-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
  RemoteReadResult,
} from './session-reader-remote.ts'

/** Handler-free command metadata returned by the official command Remote. */
export interface RemoteCommandDescriptor {
  readonly definitionId?: string
  readonly name: string
  readonly description: string
  readonly input?: {
    readonly hint: string
    readonly attachments?: boolean
  }
}

/** Human-invocable skill metadata returned by the official skill Remote. */
export interface RemoteSkillEntry {
  readonly path?: string
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

/** Value returned by `ctx.remote.skills.list({ sessionId }, signal)`. */
export interface RemoteSkillListValue {
  readonly skills: readonly RemoteSkillEntry[]
}

/** The two generated Remote namespaces consumed by this adapter. */
export interface RemoteSurfaceAuthoritySource {
  readonly commands: {
    list(sessionId: string): Promise<RemoteReadResult<readonly RemoteCommandDescriptor[]>>
  }
  readonly skills: {
    list(
      request: { readonly sessionId: string },
      signal: AbortSignal,
    ): Promise<RemoteReadResult<RemoteSkillListValue>>
  }
}

const MAX_REMOTE_ERROR_TEXT = 512

function boundedText(value: string): string {
  return value.length <= MAX_REMOTE_ERROR_TEXT
    ? value
    : `${value.slice(0, MAX_REMOTE_ERROR_TEXT - 1)}…`
}

function remoteFailureText(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null) {
      const record = error as { readonly code?: unknown; readonly message?: unknown }
      if (typeof record.code === 'string' && typeof record.message === 'string') {
        return boundedText(`${record.code}: ${record.message}`)
      }
      if (typeof record.message === 'string') return boundedText(record.message)
    }
  } catch {
    // Fall through to the total error formatter.
  }
  return boundedText(safeErrorMessage(error))
}

class RemoteSurfaceAuthorityReadError extends Error {
  constructor(operation: string, error: unknown) {
    super(`${operation} failed: ${remoteFailureText(error)}`)
    this.name = 'RemoteSurfaceAuthorityReadError'
  }
}

function remoteReadError(operation: string, error: unknown): Error {
  return error instanceof RemoteSurfaceAuthorityReadError
    ? error
    : new RemoteSurfaceAuthorityReadError(operation, error)
}

function unwrapRemote<T>(operation: string, result: RemoteReadResult<T>): T {
  if (!result.ok) throw remoteReadError(operation, result.error)
  return result.value
}

function commandSummaryOf(descriptor: RemoteCommandDescriptor) {
  return Object.freeze({
    ...(descriptor.definitionId === undefined ? {} : { definitionId: descriptor.definitionId }),
    name: descriptor.name,
    description: descriptor.description,
    ...(descriptor.input === undefined
      ? {}
      : {
          input: Object.freeze({
            hint: descriptor.input.hint,
            ...(descriptor.input.attachments === true ? { attachments: true } : {}),
          }),
        }),
  })
}

function skillSummaryOf(skill: RemoteSkillEntry) {
  return Object.freeze({
    name: skill.name,
    description: skill.description,
    ...(typeof skill.whenToUse === 'string' && skill.whenToUse !== ''
      ? { whenToUse: skill.whenToUse }
      : {}),
    modelInvocable: skill.modelInvocable,
  })
}

function generationMatches(
  generation: RemoteConnectionGenerationSource,
  captured: RemoteConnectionGeneration,
): boolean {
  return Object.is(captured, generation.getSnapshot())
}

/** The structural binding face the authority read pins (the same
 *  per-operation binding fence the presentation reader uses: a same-id
 *  release/re-retain must not hand a settled read to a replacement). */
interface RemoteAuthorityBindingSource {
  binding(id: string): { readonly session: unknown } | undefined
}

function pinExistingBinding(
  sessions: RemoteAuthorityBindingSource,
  sessionId: string,
): { readonly binding: { readonly session: unknown } } | undefined {
  const binding = sessions.binding(sessionId)
  return binding === undefined ? undefined : { binding }
}

/** Read command and human-skill authority for one current Connection generation. */
export class RemoteSurfaceAuthorityReader implements SurfaceAuthorityReader {
  private readonly source: RemoteSurfaceAuthoritySource
  private readonly generation: RemoteConnectionGenerationSource
  private readonly bindings: RemoteAuthorityBindingSource | undefined

  constructor(
    source: RemoteSurfaceAuthoritySource,
    generation: RemoteConnectionGenerationSource,
    bindings?: RemoteAuthorityBindingSource,
  ) {
    this.source = source
    this.generation = generation
    this.bindings = bindings
  }

  /**
   * Read ONLY the Host command catalog metadata for one current Connection
   * generation (M3-4 PR4 §2.2): the coordinator maps the command provider
   * through this reader and the skill provider through
   * \`SkillCatalogCapability\`, so one failing provider cannot zero the
   * other. Metadata-only and generation-fenced; \`undefined\` = superseded.
   */
  async readCommands(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly import('../surface-authority-port.ts').SurfaceAuthoritySnapshot['commands'][number][] | undefined> {
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined
    // §16 binding fence: pin the EXACT binding for the whole round-trip so a
    // same-id release/re-retain cannot hand the settled read to a
    // replacement (the generation check alone misses a binding-only
    // rollover within one generation).
    const pinned = this.bindings === undefined ? undefined : pinExistingBinding(this.bindings, sessionId)
    if (this.bindings !== undefined && pinned === undefined) return undefined
    const requestSignal = signal ?? new AbortController().signal
    let descriptors: readonly RemoteCommandDescriptor[]
    try {
      descriptors = unwrapRemote('commands/list', await this.source.commands.list(sessionId))
      requestSignal.throwIfAborted()
    } catch (error) {
      requestSignal.throwIfAborted()
      if (!this.stillCurrent(capturedGeneration, sessionId, pinned)) return undefined
      throw error
    }
    if (!this.stillCurrent(capturedGeneration, sessionId, pinned)) return undefined
    return Object.freeze(descriptors.map(commandSummaryOf))
  }

  async read(sessionId: string, signal?: AbortSignal): Promise<SurfaceAuthoritySnapshot | undefined> {
    signal?.throwIfAborted()
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return undefined
    const pinned = this.bindings === undefined ? undefined : pinExistingBinding(this.bindings, sessionId)
    if (this.bindings !== undefined && pinned === undefined) return undefined
    const requestSignal = signal ?? new AbortController().signal

    // Unwrap each RemoteResult before aggregation so a failed provider settles
    // this read immediately; the other promise remains observed by Promise.all.
    const commands = Promise.resolve()
      .then(() => this.source.commands.list(sessionId))
      .then(result => unwrapRemote('commands/list', result))
      .catch(error => { throw remoteReadError('commands/list', error) })
    const skills = Promise.resolve()
      .then(() => this.source.skills.list({ sessionId }, requestSignal))
      .then(result => unwrapRemote('skills/list', result))
      .catch(error => { throw remoteReadError('skills/list', error) })

    let commandDescriptors: readonly RemoteCommandDescriptor[]
    let skillEntries: readonly RemoteSkillEntry[]
    try {
      const [resolvedCommands, resolvedSkills] = await Promise.all([commands, skills])
      commandDescriptors = resolvedCommands
      skillEntries = resolvedSkills.skills
      requestSignal.throwIfAborted()
    } catch (error) {
      requestSignal.throwIfAborted()
      if (!this.stillCurrent(capturedGeneration, sessionId, pinned)) return undefined
      throw error
    }
    if (!this.stillCurrent(capturedGeneration, sessionId, pinned)) return undefined

    const snapshot = {
      commands: Object.freeze(commandDescriptors.map(commandSummaryOf)),
      skills: Object.freeze(skillEntries.map(skillSummaryOf)),
    }
    return Object.freeze(snapshot)
  }

  /** The combined §2.2/§16 fence: the Connection generation AND (when a
   *  binding source is provided) the exact binding object must both still
   *  be live for the settled read to belong to this operation. */
  private stillCurrent(
    capturedGeneration: RemoteConnectionGeneration,
    sessionId: string,
    pinned: { readonly binding: { readonly session: unknown } } | undefined,
  ): boolean {
    if (!generationMatches(this.generation, capturedGeneration)) return false
    if (this.bindings !== undefined && pinned !== undefined
      && this.bindings.binding(sessionId) !== pinned.binding) return false
    return true
  }
}
