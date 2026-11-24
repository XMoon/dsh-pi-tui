/**
 * Pure ACP command/catalog semantics shared by the Host access seat and the
 * connection-scoped Session View.
 *
 * This module owns NO registry, Agent, Session, queue or durable state:
 * - the leading command classification (the official DSH parser, never a
 *   local alias grammar);
 * - the complete wire catalog projection (stable name order, no slash);
 * - the frozen command/compact outcome taxonomy.
 *
 * The exact Host services remain the only authority. The View passes detached
 * read results through these pure functions and never treats a previously
 * delivered catalog as an execution capability.
 *
 * @module app/remote-process/local-acp-commands
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'

/** One approved Host command row this Host may advertise. */
export interface AcpCommandCatalogRow {
  readonly kind: 'command'
  readonly name: string
  readonly description: string
  readonly inputHint?: string
}

/** One advertised native human-invocable Skill row. */
export interface AcpSkillCatalogRow {
  readonly kind: 'skill'
  readonly name: string
  readonly description: string
}

/** One detached catalog row, carrying its real origin discriminant. */
export type AcpCatalogRow = AcpCommandCatalogRow | AcpSkillCatalogRow

/**
 * The approved Host command states. `missing` means the effective registry
 * has no definition with that name; `shadowed` means a real definition exists
 * but is not the audited official identity/variant; `unavailable` means the
 * audited identity exists but its required Host service cannot be proven.
 */
export type AcpApprovedCommandState = 'available' | 'shadowed' | 'missing' | 'unavailable'

/** One synchronous read of the live effective command registry. */
export interface AcpCommandCatalogRead {
  /** Every effective Host command name, including unsupported definitions. */
  readonly effectiveNames: readonly string[]
  /** Approved `/feedback` support. */
  readonly feedback: AcpApprovedCommandState
  /** Approved `/compact` support. */
  readonly compact: AcpApprovedCommandState
  /** The approved rows safe to advertise (never unsupported definitions). */
  readonly rows: readonly AcpCommandCatalogRow[]
}

/** One async native-Skill read of the exact attached Agent/Session. */
export type AcpNativeSkillCatalog =
  | { readonly kind: 'absent' }
  | { readonly kind: 'available'; readonly cwd: string; readonly skills: readonly AcpSkillCatalogRow[] }

/** The raw first wire block is a command candidate. */
export interface AcpLeadingCommand {
  /** The complete original text block, preserved verbatim. */
  readonly line: string
  /** The official parsed name without the leading slash. */
  readonly name: string
  /** The official parser's verbatim trailing input. */
  readonly rawInput: string
}

/** One classified prompt route before any Host admission. */
export type AcpCommandRoute =
  | { readonly kind: 'prose' }
  | { readonly kind: 'standalone'; readonly line: string }
  | { readonly kind: 'compact' }
  | { readonly kind: 'skill'; readonly name: string }
  | { readonly kind: 'error'; readonly code: AcpCommandFailureCode; readonly message: string }

/** The approved command failure taxonomy visible to the View wire boundary. */
export type AcpCommandFailureCode =
  | 'LOCAL_ACP_COMMAND_UNSUPPORTED'
  | 'LOCAL_ACP_COMMAND_INVALID_INPUT'
  | 'LOCAL_ACP_COMMAND_STALE'
  | 'LOCAL_ACP_COMMAND_UNAVAILABLE'
  | 'LOCAL_ACP_COMMAND_BUSY'
  | 'LOCAL_ACP_COMMAND_FAILED'
  | 'LOCAL_ACP_COMMAND_COMMITTED_WITH_ERROR'
  | 'LOCAL_ACP_COMMAND_INDETERMINATE'
  | 'LOCAL_ACP_COMMAND_OUTPUT_FAILED'
  | 'LOCAL_ACP_COMMAND_CANCEL_UNCONFIRMED'

/** One classified command outcome. */
export type AcpCommandOutcome =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'no-op'; readonly text: string }
  | { readonly kind: 'cancelled' }
  | {
    readonly kind: 'failure'
    readonly code: AcpCommandFailureCode
    readonly message: string
    /** The official handler's user-facing text, when it classified one. */
    readonly text?: string
  }

/** One failed Host access pre-dispatch check (never a post-dispatch guess). */
export class AcpHostCommandError extends Error {
  readonly code: 'stale' | 'unavailable' | 'unsupported'

  constructor(code: 'stale' | 'unavailable' | 'unsupported', message: string) {
    super(message)
    this.name = 'AcpHostCommandError'
    this.code = code
  }
}

/** The exact operational reasons one compact controller may carry. */
export const ACP_COMPACT_CANCEL_REASON: unique symbol = Symbol('local-acp-compact-cancel')

/** The compact facts observed synchronously from the exact Session event stream. */
export interface AcpCompactObservedFacts {
  readonly compactionId?: string
  readonly startSeq?: number
  readonly summarySeq?: number
  readonly endSeq?: number
  readonly endError?: string
  readonly checkpointSeen: boolean
  /** A conflicting second identity/order was observed for this operation. */
  readonly conflict: boolean
}

/** The original official Promise settlement. */
export type AcpCommandSettlement =
  | { readonly kind: 'resolved'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly error: unknown }

/** The exact official parser injected by the Host access composition. */
export type AcpCommandParser = (line: string) => { readonly name: string; readonly rawInput: string } | undefined

/** Read the official leading command from the raw first wire block ONLY. */
export function readLeadingCommand(
  prompt: readonly unknown[],
  parseCommand: AcpCommandParser,
): AcpLeadingCommand | undefined {
  const first = prompt[0]
  const block = first as { readonly type?: unknown; readonly text?: unknown } | null | undefined
  if (block?.type !== 'text' || typeof block.text !== 'string') return undefined
  const parsed = parseCommand(block.text)
  if (parsed === undefined) return undefined
  return { line: block.text, name: parsed.name, rawInput: parsed.rawInput }
}

/**
 * Route one leading command from the CURRENT effective registry and the LAST
 * DELIVERED catalog. The precedence is fixed:
 * effective Host definition (including unsupported shadows) > approved-name
 * miss > delivered Skill intent > ordinary prose.
 */
export function routeLeadingCommand(
  command: AcpLeadingCommand,
  catalog: AcpCommandCatalogRead,
  deliveredSkillNames: ReadonlySet<string>,
  blockCount: number,
): AcpCommandRoute {
  const effective = new Set(catalog.effectiveNames)
  if (effective.has(command.name)) {
    if (command.name === 'feedback') {
      if (catalog.feedback !== 'available') {
        return { kind: 'error', code: 'LOCAL_ACP_COMMAND_UNSUPPORTED', message: 'the effective /feedback definition is not the approved Host contract' }
      }
      return singleTextCommand(command, blockCount, 'standalone')
    }
    if (command.name === 'compact') {
      if (catalog.compact === 'unavailable') {
        return { kind: 'error', code: 'LOCAL_ACP_COMMAND_UNAVAILABLE', message: 'the approved /compact Host service is unavailable' }
      }
      if (catalog.compact !== 'available') {
        return { kind: 'error', code: 'LOCAL_ACP_COMMAND_UNSUPPORTED', message: 'the effective /compact definition is not the approved Host contract' }
      }
      if (command.rawInput.trim().length > 0) {
        return { kind: 'error', code: 'LOCAL_ACP_COMMAND_INVALID_INPUT', message: '/compact accepts no arguments' }
      }
      return singleTextCommand(command, blockCount, 'compact')
    }
    // A real, non-approved Host definition shadows the same-name Skill. It
    // must never fall through to native prose.
    return { kind: 'error', code: 'LOCAL_ACP_COMMAND_UNSUPPORTED', message: 'this Host command is not supported by the ACP command contract' }
  }
  if (command.name === 'feedback' || command.name === 'compact') {
    return { kind: 'error', code: 'LOCAL_ACP_COMMAND_UNAVAILABLE', message: 'the approved Host command is not present on the exact live Agent' }
  }
  if (deliveredSkillNames.has(command.name)) return { kind: 'skill', name: command.name }
  return { kind: 'prose' }
}

function singleTextCommand(
  command: AcpLeadingCommand,
  blockCount: number,
  kind: 'standalone' | 'compact',
): AcpCommandRoute {
  if (blockCount !== 1) {
    return { kind: 'error', code: 'LOCAL_ACP_COMMAND_INVALID_INPUT', message: 'an approved command accepts exactly one text block' }
  }
  return kind === 'compact' ? { kind: 'compact' } : { kind: 'standalone', line: command.line }
}

/** Build the complete stable `available_commands_update` for one read. */
export function catalogUpdate(rows: readonly AcpCatalogRow[]): SessionUpdate {
  const sorted = [...rows].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  return {
    sessionUpdate: 'available_commands_update',
    availableCommands: sorted.map(row => row.kind === 'command'
      ? {
        name: row.name,
        description: row.description,
        ...row.inputHint === undefined ? {} : { input: { hint: row.inputHint } },
      }
      : {
        name: row.name,
        description: row.description,
        input: { hint: 'Optional instructions' },
      }),
  }
}

/** Compare the exact visible wire fields (metadata origin is not wire identity). */
export function sameCatalogRows(left: readonly AcpCatalogRow[], right: readonly AcpCatalogRow[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined || b === undefined
      || a.kind !== b.kind || a.name !== b.name || a.description !== b.description
      || (a.kind === 'command' ? a.inputHint : undefined) !== (b.kind === 'command' ? b.inputHint : undefined)) {
      return false
    }
  }
  return true
}

/** Detached fallback when the Host has no approved command rows. */
export const EMPTY_COMMAND_CATALOG: AcpCommandCatalogRead = {
  effectiveNames: [],
  feedback: 'missing',
  compact: 'missing',
  rows: [],
}

/** Read one official `ManualCompactionError` code without importing the class. */
export function compactionErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as { readonly name?: unknown; readonly code?: unknown }
  if (candidate.name !== 'ManualCompactionError') return undefined
  return typeof candidate.code === 'string' ? candidate.code : undefined
}

/** Whether one compact rejection was caused by THIS ACP operation's own abort. */
export function isAcpCompactAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason === ACP_COMPACT_CANCEL_REASON
}

/** Validate one official `CommandExecution` shape without trusting it. */
function standaloneExecution(value: unknown): { readonly kind: 'success'; readonly text?: string } | { readonly kind: 'error'; readonly text: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const result = (value as { readonly result?: unknown }).result
  if (typeof result !== 'object' || result === null || !('kind' in result)) return undefined
  const kind = (result as { readonly kind?: unknown }).kind
  const text = (result as { readonly text?: unknown }).text
  if (kind === 'success') return text === undefined || typeof text === 'string' ? { kind, ...text === undefined ? {} : { text } } : undefined
  if (kind === 'error') return typeof text === 'string' ? { kind, text } : undefined
  return undefined
}

/** Classify the original `/feedback` execution Promise. */
export function classifyStandaloneOutcome(settlement: AcpCommandSettlement): AcpCommandOutcome {
  if (settlement.kind === 'rejected') {
    return {
      kind: 'failure',
      code: 'LOCAL_ACP_COMMAND_INDETERMINATE',
      message: 'the command outcome could not be confirmed; it was not retried',
    }
  }
  if (settlement.value === undefined) {
    return { kind: 'failure', code: 'LOCAL_ACP_COMMAND_UNAVAILABLE', message: 'the command is no longer present on the exact live Agent' }
  }
  const result = standaloneExecution(settlement.value)
  if (result === undefined) {
    return {
      kind: 'failure',
      code: 'LOCAL_ACP_COMMAND_INDETERMINATE',
      message: 'the command returned an unconfirmed result; it was not retried',
    }
  }
  if (result.kind === 'success') return result.text === undefined ? { kind: 'success' } : { kind: 'success', text: result.text }
  return { kind: 'failure', code: 'LOCAL_ACP_COMMAND_FAILED', message: result.text, text: result.text }
}

/** The compact result fields this adapter relies on. */
interface CompactResultLike {
  readonly compactionId?: unknown
  readonly startSeq?: unknown
  readonly summarySeq?: unknown
  readonly endSeq?: unknown
  readonly shadowedSeqs?: unknown
  readonly shadowedTokenCount?: unknown
}

/**
 * Classify the original `compactNow` Promise against ONLY this operation's
 * exact facts. A previous Session compaction can never satisfy the identity
 * checks, and a missing observed fact is indeterminate rather than optimistic.
 */
export function classifyCompactOutcome(
  settlement: AcpCommandSettlement,
  facts: AcpCompactObservedFacts,
  acpAborted: boolean,
): AcpCommandOutcome {
  if (facts.conflict) return indeterminateCompact()
  if (settlement.kind === 'resolved') {
    if (settlement.value === null) {
      if (facts.startSeq !== undefined) return indeterminateCompact()
      return { kind: 'no-op', text: 'No compactable history yet.' }
    }
    const result = settlement.value as CompactResultLike
    if (typeof result.compactionId !== 'string'
      || typeof result.startSeq !== 'number'
      || typeof result.summarySeq !== 'number'
      || typeof result.endSeq !== 'number'
      || !Array.isArray(result.shadowedSeqs)
      || typeof result.shadowedTokenCount !== 'number') {
      return indeterminateCompact()
    }
    if (facts.compactionId !== result.compactionId
      || facts.startSeq !== result.startSeq
      || facts.summarySeq !== result.summarySeq
      || facts.endSeq !== result.endSeq
      || facts.endError !== undefined) {
      return indeterminateCompact()
    }
    return {
      kind: 'success',
      text: `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).`,
    }
  }
  const code = compactionErrorCode(settlement.error)
  // A real official busy refusal is a precondition failure, never a client
  // cancellation, even if the abort microtask ran in the same turn.
  if (code === 'busy' && facts.startSeq === undefined && facts.summarySeq === undefined) {
    return {
      kind: 'failure',
      code: 'LOCAL_ACP_COMMAND_BUSY',
      message: 'compaction is unavailable because this process has an active compaction, or the agent is not idle',
    }
  }
  // The ONLY client-cancelled outcome is an ACP-owned abort that provably did
  // not write the irreversible summary. A committed summary wins even when the
  // abort raced the same synchronous stack.
  if (acpAborted && facts.summarySeq === undefined) {
    return { kind: 'cancelled' }
  }
  if (facts.summarySeq !== undefined) {
    // A summary without the matching replacement/end is a PARTIAL commit:
    // classify it as indeterminate, never as a whole successful compaction.
    if (facts.endSeq === undefined) return indeterminateCompact()
    if (facts.endError !== undefined) {
      return {
        kind: 'failure',
        code: 'LOCAL_ACP_COMMAND_COMMITTED_WITH_ERROR',
        message: 'the compaction changed the session history but did not complete cleanly',
      }
    }
    if (code === 'persistence') {
      return {
        kind: 'failure',
        code: 'LOCAL_ACP_COMMAND_COMMITTED_WITH_ERROR',
        message: 'the compaction changed the session history, but its persistence outcome failed',
      }
    }
    return {
      kind: 'failure',
      code: 'LOCAL_ACP_COMMAND_COMMITTED_WITH_ERROR',
      message: 'the compaction changed the session history but did not complete cleanly',
    }
  }
  if (facts.startSeq !== undefined) {
    // A durable start without a summary is still reversible: the official
    // failed bracket is the real terminal, never a fabricated cancellation.
    if (acpAborted) return { kind: 'cancelled' }
    if (facts.endSeq !== undefined) {
      return {
        kind: 'failure',
        code: 'LOCAL_ACP_COMMAND_FAILED',
        message: 'the compaction did not produce a usable summary',
      }
    }
    return indeterminateCompact()
  }
  if (code === 'changed' || code === 'summary') {
    return {
      kind: 'failure',
      code: 'LOCAL_ACP_COMMAND_FAILED',
      message: 'the compaction did not produce a usable summary',
    }
  }
  if (code === 'cancelled') {
    // An independent Host cancellation is not the client's cancellation.
    return {
      kind: 'failure',
      code: 'LOCAL_ACP_COMMAND_FAILED',
      message: 'the compaction was cancelled by the Host before it committed',
    }
  }
  return indeterminateCompact()
}

function indeterminateCompact(): AcpCommandOutcome {
  return {
    kind: 'failure',
    code: 'LOCAL_ACP_COMMAND_INDETERMINATE',
    message: 'the compaction outcome could not be confirmed; session history may be partially changed',
  }
}
