/**
 * Generation-fenced Direct-vs-Remote parity for transcript and Focus
 * presentation. It reuses the existing TUI folds at a fresh observation point;
 * it does not implement Client history, reconnect, or Assistant settlement.
 * @module @xmoon76/dsh-pi-tui/runtime/remote/presentation-read-shadow
 */

import { projectFocus, type FocusProjectedBlock } from '../../focus-activity.ts'
import { TranscriptWindowController, type TranscriptWindowSnapshot } from '../../transcript-window.ts'
import {
  TranscriptFolder,
  type TranscriptMessage,
  type TurnActivity,
} from '../../transcript.ts'
import type {
  PresentationDurableEvent,
  PresentationReadInput,
  PresentationReadSnapshot,
  PresentationReader,
} from '../presentation-read-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'

/** Comparable facts in one presentation read observation. */
export type PresentationReadMismatchField =
  | 'durable.seq'
  | 'durable.order'
  | 'durable.type'
  | 'durable.time'
  | 'durable.payload'
  | 'inputs.order'
  | 'live.inputs'
  | 'openState'
  | 'hasMore'
  | 'loadingOlder'
  | 'projection.turns'
  | 'projection.messages'
  | 'projection.activities'
  | 'projection.focus'
  | 'projection.window'

/** One bounded presentation mismatch. */
export interface PresentationReadMismatch {
  readonly field: PresentationReadMismatchField
  readonly id?: string
  readonly expected: unknown
  readonly actual: unknown
}

/** Successful presentation parity report. */
export interface PresentationReadParityReport {
  readonly generation: string
  readonly comparable: boolean
  readonly mismatches: readonly PresentationReadMismatch[]
  readonly skipped: readonly []
  readonly notComparableReason?: string
}

export type PresentationReadShadowOutcome =
  | {
    readonly status: 'compared'
    readonly report: PresentationReadParityReport
  }
  | {
    readonly status: 'unavailable'
    readonly generation?: string
    readonly reason: 'disconnected' | 'reader-unavailable'
  }
  | {
    readonly status: 'discarded'
    readonly generation?: string
    readonly reason: 'stale-generation' | 'superseded' | 'disposed'
  }
  | {
    readonly status: 'cancelled'
    readonly generation: string
  }
  | {
    readonly status: 'error'
    readonly generation: string
    readonly error: unknown
  }

/** Same observation point and Focus environment for both readers. */
export interface PresentationReadShadowOptions {
  readonly sessionId: string
  readonly signal?: AbortSignal
  readonly projection?: PresentationProjectionOptions
}

/** Pure TUI semantic projection options used by the parity comparator. */
export interface PresentationProjectionOptions {
  readonly windowTurns?: number
  readonly endTurn?: number
  readonly expandedTurns?: ReadonlySet<number>
  readonly focusMode?: boolean
}

/** Normalized semantic output; renderer details intentionally do not appear. */
export interface PresentationSemanticProjection {
  readonly turns: readonly number[]
  readonly messages: readonly unknown[]
  readonly activities: readonly unknown[]
  readonly focus: readonly unknown[]
  readonly window: {
    readonly controller: TranscriptWindowSnapshot
    readonly firstTurn?: number
    readonly lastTurn?: number
    readonly hasOlder: boolean
    readonly hasNewer: boolean
  }
}

interface CapturedOperation {
  readonly generation: RemoteConnectionGeneration
  readonly sessionId: string
  readonly epoch: number
  readonly controller: AbortController
  readonly signal: AbortSignal
}

const SKIPPED_FIELDS: readonly [] = Object.freeze([])
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

function pushMismatch(
  mismatches: PresentationReadMismatch[],
  mismatch: PresentationReadMismatch,
): void {
  if (mismatches.length >= MAX_DIAGNOSTIC_MISMATCHES) return
  mismatches.push({
    ...mismatch,
    ...(mismatch.id === undefined ? {} : { id: boundedText(mismatch.id) }),
    expected: boundedDiagnostic(mismatch.expected),
    actual: boundedDiagnostic(mismatch.actual),
  })
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameValue(value, right[index]))
  }
  const leftKeys = Object.keys(left as Record<string, unknown>)
  const rightKeys = Object.keys(right as Record<string, unknown>)
  if (leftKeys.length !== rightKeys.length || !leftKeys.every(key => Object.hasOwn(right as object, key))) return false
  return leftKeys.every(key => sameValue(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
  ))
}

function pushFieldMismatch(
  mismatches: PresentationReadMismatch[],
  field: PresentationReadMismatchField,
  id: string | undefined,
  expected: unknown,
  actual: unknown,
): void {
  if (sameValue(expected, actual)) return
  pushMismatch(mismatches, {
    field,
    ...(id === undefined ? {} : { id }),
    expected,
    actual,
  })
}

function payloadOf(event: PresentationDurableEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event)) {
    if (key !== 'type' && key !== 'seq' && key !== 'time') payload[key] = value
  }
  return payload
}

interface DurableComparison {
  readonly comparable: boolean
  readonly directEvents: readonly PresentationDurableEvent[]
  readonly firstRemoteSeq?: number
}

function compareDurable(
  mismatches: PresentationReadMismatch[],
  direct: PresentationReadSnapshot,
  remote: PresentationReadSnapshot,
): DurableComparison {
  const remoteEvents = remote.durableEvents
  if (remoteEvents.length === 0) {
    return {
      comparable: direct.durableEvents.length === 0,
      directEvents: direct.durableEvents,
    }
  }

  const firstRemoteSeq = remoteEvents[0]!.seq
  const lastRemoteSeq = remoteEvents[remoteEvents.length - 1]!.seq
  const directEvents = direct.durableEvents.filter(event => event.seq >= firstRemoteSeq && event.seq <= lastRemoteSeq)
  const expectedSeqs = directEvents.map(event => event.seq)
  const actualSeqs = remoteEvents.map(event => event.seq)
  if (!sameValue(expectedSeqs, actualSeqs)) {
    const sameMembers = expectedSeqs.length === actualSeqs.length
      && expectedSeqs.every(seq => actualSeqs.includes(seq))
    pushFieldMismatch(
      mismatches,
      sameMembers ? 'durable.order' : 'durable.seq',
      undefined,
      expectedSeqs,
      actualSeqs,
    )
  }

  const directBySeq = new Map(directEvents.map(event => [event.seq, event]))
  for (const remoteEvent of remoteEvents) {
    const directEvent = directBySeq.get(remoteEvent.seq)
    if (directEvent === undefined) continue
    pushFieldMismatch(mismatches, 'durable.type', String(remoteEvent.seq), directEvent.type, remoteEvent.type)
    pushFieldMismatch(mismatches, 'durable.time', String(remoteEvent.seq), directEvent.time, remoteEvent.time)
    pushFieldMismatch(mismatches, 'durable.payload', String(remoteEvent.seq), payloadOf(directEvent), payloadOf(remoteEvent))
  }
  return {
    comparable: directEvents.length === remoteEvents.length
      && directEvents.length > 0
      && directEvents.every((event, index) => event.seq === remoteEvents[index]!.seq),
    directEvents,
    firstRemoteSeq,
  }
}

type LivePresentationInput = Extract<PresentationReadInput, { readonly kind: 'live' }>['input']

function liveInputKey(input: LivePresentationInput): string {
  return JSON.stringify([input.kind, input.sessionId, input.attemptId, input.turn, input.step])
}

/**
 * Direct exposes the durable log and live baseline through separate existing
 * faces, so it has no shared cross-plane sequence to preserve. For a semantic
 * comparison, use the Remote source order as the template while retaining the
 * Direct payloads. Durable and live values (including their within-plane order)
 * are still compared independently; the local durable-then-live concatenation
 * is not itself a parity fact.
 */
function directInputsInRemoteOrder(
  directEvents: readonly PresentationDurableEvent[],
  directLiveInputs: readonly LivePresentationInput[],
  remoteInputs: readonly PresentationReadInput[],
): readonly PresentationReadInput[] {
  const directBySeq = new Map(directEvents.map(event => [event.seq, event]))
  const liveIndexesByKey = new Map<string, number[]>()
  for (const [index, input] of directLiveInputs.entries()) {
    const indexes = liveIndexesByKey.get(liveInputKey(input))
    if (indexes === undefined) liveIndexesByKey.set(liveInputKey(input), [index])
    else indexes.push(index)
  }
  const usedEventSeqs = new Set<number>()
  const usedLiveIndexes = new Set<number>()
  const ordered: PresentationReadInput[] = []

  for (const remoteInput of remoteInputs) {
    if (remoteInput.kind === 'durable') {
      const event = directBySeq.get(remoteInput.event.seq)
      if (event !== undefined) {
        usedEventSeqs.add(event.seq)
        ordered.push(Object.freeze({ kind: 'durable', event }))
      }
      continue
    }
    const indexes = liveIndexesByKey.get(liveInputKey(remoteInput.input))
    const index = indexes?.shift()
    if (index !== undefined) {
      usedLiveIndexes.add(index)
      ordered.push(Object.freeze({ kind: 'live', input: directLiveInputs[index]! }))
    }
  }

  // Preserve unmatched Direct facts so a membership mismatch remains visible
  // in the fresh fold instead of being hidden by normalization.
  for (const event of directEvents) {
    if (!usedEventSeqs.has(event.seq)) ordered.push(Object.freeze({ kind: 'durable', event }))
  }
  for (const [index, input] of directLiveInputs.entries()) {
    if (!usedLiveIndexes.has(index)) ordered.push(Object.freeze({ kind: 'live', input }))
  }
  return Object.freeze(ordered)
}

function directCutForRemote(
  direct: PresentationReadSnapshot,
  remote: PresentationReadSnapshot,
  comparison: DurableComparison,
): PresentationReadSnapshot | undefined {
  if (direct.coverage !== 'full' || remote.coverage !== 'bounded') return direct
  if (!comparison.comparable && remote.durableEvents.length > 0) return undefined
  if (remote.durableEvents.length === 0 && direct.durableEvents.length > 0) return undefined
  return {
    ...direct,
    durableEvents: comparison.directEvents,
    orderedInputs: directInputsInRemoteOrder(comparison.directEvents, direct.liveInputs, remote.orderedInputs),
    coverage: 'bounded',
  }
}

function normalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => normalizeValue(item))
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, item]) => [normalizeValue(key), normalizeValue(item)])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  }
  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map(key => [key, normalizeValue(object[key])]),
  )
}

function normalizeActivity(activity: TurnActivity): unknown {
  return {
    turn: activity.turn,
    startedAt: activity.startedAt,
    endedAt: activity.endedAt,
    completed: activity.completed,
    reason: normalizeValue(activity.reason),
    think: normalizeValue(activity.think),
    message: normalizeValue(activity.message),
    tool: normalizeValue(activity.tool),
    usage: normalizeValue(activity.usage),
    totalTokens: activity.totalTokens,
    lastAssistantVisible: activity.lastAssistantVisible,
    assistantMessages: activity.assistantMessages,
    toolCalls: activity.toolCalls,
    tools: normalizeValue(activity.tools),
  }
}

function normalizeFocusBlock(block: FocusProjectedBlock): unknown {
  if (block.kind === 'activity') {
    return { kind: 'activity', activity: normalizeActivity(block.activity) }
  }
  return {
    kind: 'message',
    message: normalizeValue(block.message),
    ...(block.truncated === undefined ? {} : { truncated: block.truncated }),
    ...(block.collapseFocusOwnerOnClick === undefined ? {} : { collapseFocusOwnerOnClick: block.collapseFocusOwnerOnClick }),
  }
}

function applyToFreshFolder(snapshot: PresentationReadSnapshot): TranscriptFolder {
  const folder = new TranscriptFolder()
  type FolderEvent = Parameters<TranscriptFolder['apply']>[0][number]
  for (const input of snapshot.orderedInputs) {
    if (input.kind === 'durable') {
      folder.apply([input.event as unknown as FolderEvent])
    } else {
      folder.applyLiveInput(input.input)
    }
  }
  return folder
}

/** Run existing Transcript/Window/Focus folds over one detached observation. */
export function projectPresentationSnapshot(
  snapshot: PresentationReadSnapshot,
  options: PresentationProjectionOptions = {},
): PresentationSemanticProjection {
  const folder = applyToFreshFolder(snapshot)
  const windowTurns = options.windowTurns ?? 20
  const controller = new TranscriptWindowController({
    turns: folder.turns(),
    windowTurns,
  })
  if (options.endTurn !== undefined) controller.anchorAt(options.endTurn)
  const controllerSnapshot = controller.snapshot()
  const endTurn = controller.endTurn()
  const window = folder.window({
    maxTurns: windowTurns,
    ...(endTurn === undefined ? {} : { endTurn }),
  })
  const expandedTurns = options.expandedTurns ?? new Set<number>()
  const focus = projectFocus(
    window.messages,
    folder.turnActivities(),
    expandedTurns,
    options.focusMode ?? true,
  )
  const activities = [...folder.turnActivities().entries()]
    .sort(([left], [right]) => left - right)
    .map(([, activity]) => normalizeActivity(activity))
  return {
    turns: Object.freeze([...folder.turns()]),
    messages: Object.freeze(window.messages.map(message => normalizeValue(message))),
    activities: Object.freeze(activities),
    focus: Object.freeze(focus.map(block => normalizeFocusBlock(block))),
    window: Object.freeze({
      controller: controllerSnapshot,
      firstTurn: window.firstTurn,
      lastTurn: window.lastTurn,
      hasOlder: window.hasOlder,
      hasNewer: window.hasNewer,
    }),
  }
}

function compareProjection(
  mismatches: PresentationReadMismatch[],
  direct: PresentationReadSnapshot,
  remote: PresentationReadSnapshot,
  options: PresentationProjectionOptions | undefined,
  durable: DurableComparison,
): boolean {
  const directCut = directCutForRemote(direct, remote, durable)
  if (directCut === undefined) return false
  const directProjection = projectPresentationSnapshot(directCut, options)
  const remoteProjection = projectPresentationSnapshot(remote, options)
  pushFieldMismatch(mismatches, 'projection.turns', undefined, directProjection.turns, remoteProjection.turns)
  pushFieldMismatch(mismatches, 'projection.messages', undefined, directProjection.messages, remoteProjection.messages)
  pushFieldMismatch(mismatches, 'projection.activities', undefined, directProjection.activities, remoteProjection.activities)
  pushFieldMismatch(mismatches, 'projection.focus', undefined, directProjection.focus, remoteProjection.focus)
  pushFieldMismatch(mismatches, 'projection.window', undefined, directProjection.window, remoteProjection.window)
  return true
}

function compareSnapshots(
  direct: PresentationReadSnapshot,
  remote: PresentationReadSnapshot,
  options: PresentationProjectionOptions | undefined,
): { readonly mismatches: readonly PresentationReadMismatch[]; readonly comparable: boolean; readonly reason?: string } {
  const mismatches: PresentationReadMismatch[] = []
  const durable = compareDurable(mismatches, direct, remote)
  if (!sameValue(direct.liveInputs, remote.liveInputs)) {
    pushFieldMismatch(mismatches, 'live.inputs', undefined, direct.liveInputs, remote.liveInputs)
  }
  pushFieldMismatch(mismatches, 'openState', undefined, direct.openState, remote.openState)
  pushFieldMismatch(mismatches, 'loadingOlder', undefined, direct.loadingOlder, remote.loadingOlder)

  const comparableFlags = direct.coverage === 'full' && remote.coverage === 'bounded' && remote.durableEvents.length > 0
    ? direct.durableEvents.some(event => event.seq < remote.durableEvents[0]!.seq)
    : direct.hasMore
  pushFieldMismatch(mismatches, 'hasMore', undefined, comparableFlags, remote.hasMore)
  const projectionComparable = compareProjection(mismatches, direct, remote, options, durable)
  const comparable = durable.comparable || (remote.durableEvents.length === 0 && direct.durableEvents.length === 0)
  return {
    mismatches: Object.freeze(mismatches),
    comparable: comparable && projectionComparable,
    ...(comparable ? {} : { reason: 'the bounded Remote window has no matching durable sequence anchor in the Direct observation' }),
  }
}

function generationLabel(generation: RemoteConnectionGeneration): string {
  return boundedText(String(generation.id))
}

/** Compare Direct and official Client presentation reads without taking authority. */
export class RemotePresentationReadShadow {
  private readonly direct: PresentationReader
  private readonly remote: PresentationReader
  private readonly generation: RemoteConnectionGenerationSource
  private operationEpoch = 0
  private disposed = false
  private active: CapturedOperation | undefined
  private readonly unsubscribeGeneration: () => void

  constructor(
    direct: PresentationReader,
    remote: PresentationReader,
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

  async compare(options: PresentationReadShadowOptions): Promise<PresentationReadShadowOutcome> {
    if (this.disposed) return { status: 'discarded', reason: 'disposed' }
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return { status: 'unavailable', reason: 'disconnected' }

    const operation = this.beginOperation(capturedGeneration, options)
    try {
      const [direct, remote] = await Promise.all([
        this.direct.read(options.sessionId, operation.signal),
        this.remote.read(options.sessionId, operation.signal),
      ])
      if (!this.isCurrent(operation)) return this.discarded(operation)
      operation.signal.throwIfAborted()
      if (direct === undefined || remote === undefined) {
        return {
          status: 'unavailable',
          generation: generationLabel(operation.generation),
          reason: 'reader-unavailable',
        }
      }
      const result = compareSnapshots(direct, remote, options.projection)
      if (!this.isCurrent(operation)) return this.discarded(operation)
      operation.signal.throwIfAborted()
      return {
        status: 'compared',
        report: {
          generation: generationLabel(operation.generation),
          comparable: result.comparable && result.mismatches.length === 0,
          mismatches: result.mismatches,
          skipped: SKIPPED_FIELDS,
          ...(result.reason === undefined ? {} : { notComparableReason: result.reason }),
        },
      }
    } catch (error) {
      if (!this.isCurrent(operation)) return this.discarded(operation)
      // A current provider failure ends this comparison. Abort the owned
      // sibling read before returning so no pending work outlives the epoch.
      operation.controller.abort()
      if (options.signal?.aborted === true) {
        return { status: 'cancelled', generation: generationLabel(operation.generation) }
      }
      return {
        status: 'error',
        generation: generationLabel(operation.generation),
        error,
      }
    } finally {
      if (this.active === operation) this.active = undefined
    }
  }

  /** Stop observing Connection generations and cancel the owned comparison. */
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
    options: PresentationReadShadowOptions,
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

  private discarded(operation: CapturedOperation): PresentationReadShadowOutcome {
    const current = this.generation.getSnapshot()
    return {
      status: 'discarded',
      generation: generationLabel(operation.generation),
      reason: this.disposed
        ? 'disposed'
        : current === undefined || !Object.is(current, operation.generation)
          ? 'stale-generation'
          : 'superseded',
    }
  }
}
