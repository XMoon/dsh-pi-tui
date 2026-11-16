/** Detached typed projections of the FR5-B official Host-owned Settings
 * sections (Agent loop, Shell execution, Session log upload). The adapters own
 * the descriptor access; every projection reports `undefined` for a value it
 * cannot prove instead of inventing a schema default. */
import type {
  AgentLoopSettings,
  HostShellExecutor,
  SessionLogUpload,
  ShellExecutionSettings,
} from './config-port.ts'

/** The typed effective/inherited facts of ONE current Settings descriptor. */
export interface SectionFacts<T extends object> {
  readonly effective: T
  readonly inherited: T
  /** Effective-to-inherited difference; not USER patch key presence. */
  readonly overridden: Readonly<Record<keyof T, boolean>>
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : undefined
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

export function projectAgentLoopSettings(
  effectiveValue: unknown,
  inheritedValue: unknown,
): SectionFacts<AgentLoopSettings> | undefined {
  const effectiveRecord = plainRecord(effectiveValue)
  const inheritedRecord = plainRecord(inheritedValue)
  if (effectiveRecord === undefined || inheritedRecord === undefined) return undefined
  const effectiveBudget = effectiveRecord.maxParallelToolCalls
  const inheritedBudget = inheritedRecord.maxParallelToolCalls
  if (!positiveSafeInteger(effectiveBudget) || !positiveSafeInteger(inheritedBudget)) return undefined
  return Object.freeze({
    effective: Object.freeze({ maxParallelToolCalls: effectiveBudget }),
    inherited: Object.freeze({ maxParallelToolCalls: inheritedBudget }),
    overridden: Object.freeze({ maxParallelToolCalls: effectiveBudget !== inheritedBudget }),
  })
}

export function projectShellExecutionSettings(
  executor: HostShellExecutor,
): (effectiveValue: unknown, inheritedValue: unknown) => SectionFacts<ShellExecutionSettings> | undefined {
  return (effectiveValue, inheritedValue) => {
    const effectiveRecord = plainRecord(effectiveValue)
    const inheritedRecord = plainRecord(inheritedValue)
    if (effectiveRecord === undefined || inheritedRecord === undefined) return undefined
    const timeoutMs = effectiveRecord.timeoutMs
    const maxOutputBytes = effectiveRecord.maxOutputBytes
    const inheritedTimeoutMs = inheritedRecord.timeoutMs
    const inheritedMaxOutputBytes = inheritedRecord.maxOutputBytes
    if (!positiveSafeInteger(timeoutMs) || !positiveSafeInteger(maxOutputBytes)
      || !positiveSafeInteger(inheritedTimeoutMs) || !positiveSafeInteger(inheritedMaxOutputBytes)) return undefined
    return Object.freeze({
      effective: Object.freeze({ executor, timeoutMs, maxOutputBytes }),
      inherited: Object.freeze({ executor, timeoutMs: inheritedTimeoutMs, maxOutputBytes: inheritedMaxOutputBytes }),
      overridden: Object.freeze({
        // The executor is a Host observation, never an override comparison.
        executor: false,
        timeoutMs: timeoutMs !== inheritedTimeoutMs,
        maxOutputBytes: maxOutputBytes !== inheritedMaxOutputBytes,
      }),
    })
  }
}

export function projectSessionLogUpload(
  effectiveValue: unknown,
  inheritedValue: unknown,
): SectionFacts<SessionLogUpload> | undefined {
  const effectiveRecord = plainRecord(effectiveValue)
  const inheritedRecord = plainRecord(inheritedValue)
  if (effectiveRecord === undefined || inheritedRecord === undefined) return undefined
  if (typeof effectiveRecord.enabled !== 'boolean' || typeof inheritedRecord.enabled !== 'boolean') return undefined
  return Object.freeze({
    effective: Object.freeze({ enabled: effectiveRecord.enabled }),
    inherited: Object.freeze({ enabled: inheritedRecord.enabled }),
    overridden: Object.freeze({ enabled: effectiveRecord.enabled !== inheritedRecord.enabled }),
  })
}
