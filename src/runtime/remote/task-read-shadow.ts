/**
 * Generation-fenced Direct-vs-Remote parity for the Task Center read surface.
 *
 * Direct remains authoritative. The shadow compares only the official
 * direct-child catalog and status-only job snapshots, then checks the existing
 * pure `buildTaskRows` projection. The complete descendant tree is recorded as
 * an explicit upstream gap rather than inferred from partial Client data.
 * @module @xmoon76/dsh-pi-tui/runtime/remote/task-read-shadow
 */

import {
  buildTaskRows,
  type TaskBrowserAgentInput,
  type TaskBrowserRow,
} from '../../tasks-browser.ts'
import type {
  TaskJobEntry,
  TaskReader,
  TaskReadSnapshot,
  TaskSubagentEntry,
} from '../task-read-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from './session-reader-remote.ts'

/** Comparable fields in one Task Center read snapshot. */
export type TaskReadMismatchField =
  | 'children.ids'
  | 'children.order'
  | 'child.kind'
  | 'child.label'
  | 'child.mode'
  | 'child.activity'
  | 'child.hasChildren'
  | 'diagnostic.reason'
  | 'jobs.ids'
  | 'jobs.order'
  | 'job.kind'
  | 'job.label'
  | 'job.status'
  | 'job.detail'
  | 'job.startedAt'
  | 'job.finishedAt'
  | 'parentAvailable'
  | 'task.rows'

/** One bounded parity mismatch. */
export interface TaskReadMismatch {
  readonly field: TaskReadMismatchField
  readonly id?: string
  readonly expected: unknown
  readonly actual: unknown
}

/** The upstream capability not represented by the official Client model. */
export interface TaskReadSkippedField {
  readonly field: 'subagent.descendantTree'
  readonly reason: string
}

/** Successful comparison report for one Connection generation. */
export interface TaskReadParityReport {
  readonly generation: string
  readonly comparable: boolean
  readonly mismatches: readonly TaskReadMismatch[]
  readonly skipped: readonly TaskReadSkippedField[]
}

export type TaskReadShadowUnavailableReason = 'disconnected' | 'reader-unavailable'

/** Outcome of one generation/operation-fenced Task read comparison. */
export type TaskReadShadowOutcome =
  | {
    readonly status: 'compared'
    readonly report: TaskReadParityReport
  }
  | {
    readonly status: 'unavailable'
    readonly generation?: string
    readonly reason: TaskReadShadowUnavailableReason
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

/** One direct-child Task read comparison request. */
export interface TaskReadShadowOptions {
  readonly parentSessionId: string
  readonly signal?: AbortSignal
}

interface CapturedOperation {
  readonly generation: RemoteConnectionGeneration
  readonly parentSessionId: string
  readonly epoch: number
  readonly controller: AbortController
  readonly signal: AbortSignal
}

const SKIPPED_FIELDS: readonly TaskReadSkippedField[] = Object.freeze([
  Object.freeze({
    field: 'subagent.descendantTree',
    reason: 'the official Client exposes only direct-child catalogs; exact ordinary-Session traversal and stable pre-order remain a D5/upstream seam',
  }),
])
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
  mismatches: TaskReadMismatch[],
  mismatch: TaskReadMismatch,
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

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const rightSet = new Set(right)
  return left.every(value => rightSet.has(value))
}

function pushFieldMismatch(
  mismatches: TaskReadMismatch[],
  field: TaskReadMismatchField,
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

function childById(snapshot: TaskReadSnapshot): Map<string, TaskSubagentEntry> {
  return new Map(snapshot.children.map(entry => [entry.id, entry]))
}

function jobById(snapshot: TaskReadSnapshot): Map<string, TaskJobEntry> {
  return new Map(snapshot.jobs.map(job => [job.id, job]))
}

function compareChild(
  mismatches: TaskReadMismatch[],
  expected: TaskSubagentEntry,
  actual: TaskSubagentEntry,
): void {
  if (expected.kind !== actual.kind) {
    pushFieldMismatch(mismatches, 'child.kind', expected.id, expected.kind, actual.kind)
    return
  }
  if (expected.kind === 'diagnostic' && actual.kind === 'diagnostic') {
    pushFieldMismatch(mismatches, 'diagnostic.reason', expected.id, expected.reason, actual.reason)
    return
  }
  if (expected.kind !== 'child' || actual.kind !== 'child') return
  pushFieldMismatch(mismatches, 'child.label', expected.id, expected.label, actual.label)
  pushFieldMismatch(mismatches, 'child.mode', expected.id, expected.mode, actual.mode)
  pushFieldMismatch(mismatches, 'child.activity', expected.id, expected.activity, actual.activity)
  pushFieldMismatch(mismatches, 'child.hasChildren', expected.id, expected.hasChildren, actual.hasChildren)
}

function compareChildren(
  mismatches: TaskReadMismatch[],
  expected: TaskReadSnapshot,
  actual: TaskReadSnapshot,
): void {
  const expectedIds = expected.children.map(entry => entry.id)
  const actualIds = actual.children.map(entry => entry.id)
  if (!sameStrings(expectedIds, actualIds)) {
    pushFieldMismatch(
      mismatches,
      sameSet(expectedIds, actualIds) ? 'children.order' : 'children.ids',
      undefined,
      expectedIds,
      actualIds,
    )
  }
  const actualById = childById(actual)
  for (const entry of expected.children) {
    const candidate = actualById.get(entry.id)
    if (candidate !== undefined) compareChild(mismatches, entry, candidate)
  }
}

function compareJobs(
  mismatches: TaskReadMismatch[],
  expected: TaskReadSnapshot,
  actual: TaskReadSnapshot,
): void {
  const expectedIds = expected.jobs.map(job => job.id)
  const actualIds = actual.jobs.map(job => job.id)
  if (!sameStrings(expectedIds, actualIds)) {
    pushFieldMismatch(
      mismatches,
      sameSet(expectedIds, actualIds) ? 'jobs.order' : 'jobs.ids',
      undefined,
      expectedIds,
      actualIds,
    )
  }
  const actualById = jobById(actual)
  for (const job of expected.jobs) {
    const candidate = actualById.get(job.id)
    if (candidate === undefined) continue
    pushFieldMismatch(mismatches, 'job.kind', job.id, job.kind, candidate.kind)
    pushFieldMismatch(mismatches, 'job.label', job.id, job.label, candidate.label)
    pushFieldMismatch(mismatches, 'job.status', job.id, job.status, candidate.status)
    pushFieldMismatch(mismatches, 'job.detail', job.id, job.detail, candidate.detail)
    pushFieldMismatch(mismatches, 'job.startedAt', job.id, job.startedAt, candidate.startedAt)
    pushFieldMismatch(mismatches, 'job.finishedAt', job.id, job.finishedAt, candidate.finishedAt)
  }
}

function taskRowsOf(snapshot: TaskReadSnapshot): readonly TaskBrowserRow[] {
  const agents: TaskBrowserAgentInput[] = snapshot.children.map(entry => entry.kind === 'child'
    ? {
      kind: 'child',
      id: entry.id,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      mode: entry.mode,
      activity: entry.activity,
      hasChildren: entry.hasChildren,
      depth: 1,
    }
    : {
      kind: 'diagnostic',
      id: entry.id,
      reason: entry.reason,
      depth: 1,
    })
  return buildTaskRows(snapshot.jobs, agents)
}

function compareSnapshots(
  expected: TaskReadSnapshot,
  actual: TaskReadSnapshot,
): TaskReadMismatch[] {
  const mismatches: TaskReadMismatch[] = []
  pushFieldMismatch(mismatches, 'parentAvailable', undefined, expected.parentAvailable, actual.parentAvailable)
  compareChildren(mismatches, expected, actual)
  compareJobs(mismatches, expected, actual)
  pushFieldMismatch(mismatches, 'task.rows', undefined, taskRowsOf(expected), taskRowsOf(actual))
  return mismatches
}

function generationLabel(generation: RemoteConnectionGeneration): string {
  return boundedText(String(generation.id))
}

/** Compare Direct and official Client Task read faces without changing production state. */
export class RemoteTaskReadShadow {
  private readonly direct: TaskReader
  private readonly remote: TaskReader
  private readonly generation: RemoteConnectionGenerationSource
  private operationEpoch = 0
  private disposed = false
  private active: CapturedOperation | undefined
  private readonly unsubscribeGeneration: () => void

  constructor(
    direct: TaskReader,
    remote: TaskReader,
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

  async compare(options: TaskReadShadowOptions): Promise<TaskReadShadowOutcome> {
    if (this.disposed) return { status: 'discarded', reason: 'disposed' }
    const capturedGeneration = this.generation.getSnapshot()
    if (capturedGeneration === undefined) return { status: 'unavailable', reason: 'disconnected' }

    const operation = this.beginOperation(capturedGeneration, options)
    try {
      const [direct, remote] = await Promise.all([
        this.direct.readDirectChildren(options.parentSessionId, operation.signal),
        this.remote.readDirectChildren(options.parentSessionId, operation.signal),
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
      const mismatches = compareSnapshots(direct, remote)
      if (!this.isCurrent(operation)) return this.discarded(operation)
      operation.signal.throwIfAborted()
      return {
        status: 'compared',
        report: {
          generation: generationLabel(operation.generation),
          comparable: mismatches.length === 0,
          mismatches: Object.freeze(mismatches),
          skipped: SKIPPED_FIELDS,
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
    options: TaskReadShadowOptions,
  ): CapturedOperation {
    this.active?.controller.abort()
    const controller = new AbortController()
    const signal = options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal])
    const operation = {
      generation,
      parentSessionId: options.parentSessionId,
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

  private discarded(operation: CapturedOperation): TaskReadShadowOutcome {
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
