/**
 * Generation-fenced Direct-vs-Remote parity for live Session command and
 * human-skill authority metadata. Direct remains authoritative; this module
 * only reports detached diagnostics and owns no TUI catalog state.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/surface-authority-shadow
 */

import type { SurfaceAuthorityReader, SurfaceAuthoritySnapshot } from '../surface-authority-port.ts'
import type { SurfaceCommandSummary } from '../../surface-catalog.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'

/** Comparable fields in the command/skill authority snapshots. */
export type SurfaceAuthorityMismatchField =
  | 'commands.ids'
  | 'commands.order'
  | 'command.definitionId'
  | 'command.description'
  | 'command.input.presence'
  | 'command.input.hint'
  | 'command.input.attachments'
  | 'skills.ids'
  | 'skills.order'
  | 'skill.description'
  | 'skill.whenToUse'
  | 'skill.modelInvocable'

/** One bounded parity mismatch. */
export interface SurfaceAuthorityMismatch {
  readonly field: SurfaceAuthorityMismatchField
  readonly name?: string
  readonly expected: unknown
  readonly actual: unknown
}

/** The metadata-derived claim policy for one command name. */
export interface SurfaceAuthorityCommandClaim {
  readonly name: string
  readonly claim: {
    readonly bare: true
    readonly withArguments: boolean
  }
}

/** A successful command/skill authority comparison. */
export interface SurfaceAuthorityParityReport {
  readonly generation: string
  readonly comparable: boolean
  readonly mismatches: readonly SurfaceAuthorityMismatch[]
  /** Claims are derived from descriptor input metadata; no command is run. */
  readonly commandClaims: {
    readonly direct: readonly SurfaceAuthorityCommandClaim[]
    readonly remote: readonly SurfaceAuthorityCommandClaim[]
  }
}

/** Why one comparison could not read an authoritative side. */
export type SurfaceAuthorityUnavailableReason =
  | 'disconnected'
  | 'direct-unavailable'
  | 'remote-unavailable'

/** Outcome of one generation-fenced authority comparison. */
export type SurfaceAuthorityShadowOutcome =
  | { readonly status: 'compared'; readonly report: SurfaceAuthorityParityReport }
  | { readonly status: 'unavailable'; readonly reason: SurfaceAuthorityUnavailableReason }
  | {
    readonly status: 'discarded'
    readonly reason: 'stale-generation' | 'superseded' | 'disposed'
  }
  | { readonly status: 'cancelled' }
  | { readonly status: 'error'; readonly error: unknown }

/** One live Session comparison request. */
export interface SurfaceAuthorityShadowOptions {
  readonly sessionId: string
  readonly signal?: AbortSignal
}

interface CapturedOperation {
  readonly generation: RemoteConnectionGeneration
  readonly sessionId: string
  readonly epoch: number
  readonly controller: AbortController
  readonly signal: AbortSignal
}

const MAX_DIAGNOSTIC_ITEMS = 64
const MAX_DIAGNOSTIC_TEXT = 512
const MAX_DIAGNOSTIC_MISMATCHES = 256

function boundedText(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_TEXT
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_TEXT - 1)}…`
}

function boundedDiagnostic(value: unknown): unknown {
  if (typeof value === 'string') return boundedText(value)
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (!Array.isArray(value)) return '[non-scalar diagnostic value]'
  const values = value.slice(0, MAX_DIAGNOSTIC_ITEMS).map(item => boundedDiagnostic(item))
  return value.length <= MAX_DIAGNOSTIC_ITEMS
    ? values
    : { total: value.length, values, truncated: true }
}

function generationLabel(generation: RemoteConnectionGeneration): string {
  return boundedText(String(generation.id))
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every(value => rightSet.has(value))
}

function pushMismatch(
  mismatches: SurfaceAuthorityMismatch[],
  mismatch: SurfaceAuthorityMismatch,
): void {
  if (mismatches.length >= MAX_DIAGNOSTIC_MISMATCHES) return
  mismatches.push({
    ...mismatch,
    ...(mismatch.name === undefined ? {} : { name: boundedText(mismatch.name) }),
    expected: boundedDiagnostic(mismatch.expected),
    actual: boundedDiagnostic(mismatch.actual),
  })
}

function pushFieldMismatch(
  mismatches: SurfaceAuthorityMismatch[],
  field: SurfaceAuthorityMismatchField,
  name: string | undefined,
  expected: unknown,
  actual: unknown,
): void {
  if (Object.is(expected, actual)) return
  pushMismatch(mismatches, {
    field,
    ...(name === undefined ? {} : { name }),
    expected,
    actual,
  })
}

/** Derive PR120's bare/argument claim policy without executing a command. */
export function commandClaimOf(command: SurfaceCommandSummary): SurfaceAuthorityCommandClaim {
  return Object.freeze({
    name: command.name,
    claim: Object.freeze({
      bare: true,
      withArguments: command.input !== undefined,
    }),
  })
}

function boundedCommandClaims(commands: readonly SurfaceCommandSummary[]): readonly SurfaceAuthorityCommandClaim[] {
  return Object.freeze(commands.slice(0, MAX_DIAGNOSTIC_ITEMS).map(command => {
    const claim = commandClaimOf(command)
    return Object.freeze({
      name: boundedText(claim.name),
      claim: claim.claim,
    })
  }))
}

function compareCommands(
  direct: readonly SurfaceCommandSummary[],
  remote: readonly SurfaceCommandSummary[],
): SurfaceAuthorityMismatch[] {
  const mismatches: SurfaceAuthorityMismatch[] = []
  const directIds = direct.map(command => command.name)
  const remoteIds = remote.map(command => command.name)
  if (!sameStrings(directIds, remoteIds)) {
    pushMismatch(mismatches, {
      field: sameSet(directIds, remoteIds) ? 'commands.order' : 'commands.ids',
      expected: directIds,
      actual: remoteIds,
    })
  }

  const remoteByName = new Map(remote.map(command => [command.name, command]))
  for (const directCommand of direct) {
    const remoteCommand = remoteByName.get(directCommand.name)
    if (remoteCommand === undefined) continue
    pushFieldMismatch(
      mismatches,
      'command.definitionId',
      directCommand.name,
      directCommand.definitionId,
      remoteCommand.definitionId,
    )
    pushFieldMismatch(
      mismatches,
      'command.description',
      directCommand.name,
      directCommand.description,
      remoteCommand.description,
    )
    const directHasInput = directCommand.input !== undefined
    const remoteHasInput = remoteCommand.input !== undefined
    pushFieldMismatch(
      mismatches,
      'command.input.presence',
      directCommand.name,
      directHasInput,
      remoteHasInput,
    )
    if (!directHasInput || !remoteHasInput) continue
    pushFieldMismatch(
      mismatches,
      'command.input.hint',
      directCommand.name,
      directCommand.input?.hint,
      remoteCommand.input?.hint,
    )
    pushFieldMismatch(
      mismatches,
      'command.input.attachments',
      directCommand.name,
      directCommand.input?.attachments,
      remoteCommand.input?.attachments,
    )
  }
  return mismatches
}

function compareSkills(
  direct: SurfaceAuthoritySnapshot['skills'],
  remote: SurfaceAuthoritySnapshot['skills'],
): SurfaceAuthorityMismatch[] {
  const mismatches: SurfaceAuthorityMismatch[] = []
  const directIds = direct.map(skill => skill.name)
  const remoteIds = remote.map(skill => skill.name)
  if (!sameStrings(directIds, remoteIds)) {
    pushMismatch(mismatches, {
      field: sameSet(directIds, remoteIds) ? 'skills.order' : 'skills.ids',
      expected: directIds,
      actual: remoteIds,
    })
  }

  const remoteByName = new Map(remote.map(skill => [skill.name, skill]))
  for (const directSkill of direct) {
    const remoteSkill = remoteByName.get(directSkill.name)
    if (remoteSkill === undefined) continue
    pushFieldMismatch(
      mismatches,
      'skill.description',
      directSkill.name,
      directSkill.description,
      remoteSkill.description,
    )
    pushFieldMismatch(
      mismatches,
      'skill.whenToUse',
      directSkill.name,
      directSkill.whenToUse,
      remoteSkill.whenToUse,
    )
    pushFieldMismatch(
      mismatches,
      'skill.modelInvocable',
      directSkill.name,
      directSkill.modelInvocable,
      remoteSkill.modelInvocable,
    )
  }
  return mismatches
}

function compareSnapshots(
  direct: SurfaceAuthoritySnapshot,
  remote: SurfaceAuthoritySnapshot,
  generation: RemoteConnectionGeneration,
): SurfaceAuthorityParityReport {
  const mismatches = [
    ...compareCommands(direct.commands, remote.commands),
    ...compareSkills(direct.skills, remote.skills),
  ]
  return Object.freeze({
    generation: generationLabel(generation),
    comparable: mismatches.length === 0,
    mismatches: Object.freeze(mismatches),
    commandClaims: Object.freeze({
      direct: boundedCommandClaims(direct.commands),
      remote: boundedCommandClaims(remote.commands),
    }),
  })
}

/**
 * Compares Direct and official-Client authority reads without changing
 * production state. A later compare, generation reset, or dispose invalidates
 * an earlier operation; stale successes and failures are discarded.
 */
export class RemoteSurfaceAuthorityShadow {
  private readonly direct: SurfaceAuthorityReader
  private readonly remote: SurfaceAuthorityReader
  private readonly generation: RemoteConnectionGenerationSource
  private operationEpoch = 0
  private disposed = false
  private active: CapturedOperation | undefined
  private readonly unsubscribeGeneration: () => void

  constructor(
    direct: SurfaceAuthorityReader,
    remote: SurfaceAuthorityReader,
    generation: RemoteConnectionGenerationSource,
  ) {
    this.direct = direct
    this.remote = remote
    this.generation = generation
    this.unsubscribeGeneration = generation.subscribe(() => {
      this.operationEpoch += 1
      this.active?.controller.abort()
    })
  }

  async compare(options: SurfaceAuthorityShadowOptions): Promise<SurfaceAuthorityShadowOutcome> {
    if (this.disposed) return { status: 'discarded', reason: 'disposed' }
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return { status: 'unavailable', reason: 'disconnected' }

    const operation = this.beginOperation(capturedGeneration, options)
    try {
      const [direct, remote] = await Promise.all([
        this.direct.read(operation.sessionId, operation.signal),
        this.remote.read(operation.sessionId, operation.signal),
      ])
      if (!this.isCurrent(operation)) return this.discarded(operation)
      operation.signal.throwIfAborted()
      if (direct === undefined) return { status: 'unavailable', reason: 'direct-unavailable' }
      if (remote === undefined) return { status: 'unavailable', reason: 'remote-unavailable' }

      const report = compareSnapshots(direct, remote, operation.generation)
      if (!this.isCurrent(operation)) return this.discarded(operation)
      operation.signal.throwIfAborted()
      return { status: 'compared', report }
    } catch (error) {
      const current = this.isCurrent(operation)
      if (!current) return this.discarded(operation)
      // A current provider failure ends this comparison. Abort the owned
      // sibling read before returning so no pending work outlives the epoch.
      operation.controller.abort()
      if (options.signal?.aborted === true) return { status: 'cancelled' }
      return { status: 'error', error }
    } finally {
      if (this.active === operation) this.active = undefined
    }
  }

  /** Stop observing Connection generations and cancel the owned operation. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.operationEpoch += 1
    this.active?.controller.abort()
    this.active = undefined
    this.unsubscribeGeneration()
  }

  private beginOperation(
    generation: RemoteConnectionGeneration,
    options: SurfaceAuthorityShadowOptions,
  ): CapturedOperation {
    this.active?.controller.abort()
    const controller = new AbortController()
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal])
    const operation = {
      generation,
      sessionId: options.sessionId,
      epoch: ++this.operationEpoch,
      controller,
      signal,
    }
    this.active = operation
    return operation
  }

  private isCurrent(operation: CapturedOperation): boolean {
    return !this.disposed
      && this.active === operation
      && this.operationEpoch === operation.epoch
      && Object.is(this.generation.getSnapshot(), operation.generation)
  }

  private discarded(operation: CapturedOperation): SurfaceAuthorityShadowOutcome {
    const current = this.generation.getSnapshot()
    return {
      status: 'discarded',
      reason: this.disposed
        ? 'disposed'
        : current === undefined || !Object.is(current, operation.generation)
          ? 'stale-generation'
          : 'superseded',
    }
  }
}
