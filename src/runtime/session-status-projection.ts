/**
 * The detached mapping for the Session-scoped official status projection
 * (M3-3A, consumed by M3-4/M3-5): shared by the Direct Host projection read
 * and the Remote binding projection read so both express the ONE semantic.
 * Host-import-free by construction (pure unknown-narrowing over projection
 * values).
 * @module @xmoon76/dsh-pi-tui/runtime/session-status-projection
 */

import type { SessionStatusProjection } from './session-reader-port.ts'

/**
 * Detach the official projection values into the status DTO. Fields are
 * only present when their official projection value is well-formed; nothing
 * is coerced, defaulted or copied from another subject.
 */
export function detachedSessionStatus(
  sessionId: string,
  values: Readonly<Record<string, unknown>>,
  cwd: string | undefined,
): SessionStatusProjection {
  const record: {
    sessionId: string
    cwd?: string
    model?: SessionStatusProjection['model']
    preset?: string
    title?: string
    permission?: string
    goal?: SessionStatusProjection['goal']
    context?: SessionStatusProjection['context']
    todos?: SessionStatusProjection['todos']
    usage?: SessionStatusProjection['usage']
  } = { sessionId }
  if (typeof cwd === 'string' && cwd !== '') record.cwd = cwd
  const model = modelSelectionFact(values.modelSelection)
  if (model !== undefined) record.model = model
  if (typeof values.agentPreset === 'string' && values.agentPreset !== '') record.preset = values.agentPreset
  // The official `title` projection: a non-empty string; its LEGAL null ("no
  // title yet") and an absent value both read absent (never "").
  if (typeof values.title === 'string' && values.title !== '') record.title = values.title
  // The official `permissions` projection VIEW: `{ currentValue }`. Only a
  // well-formed non-empty string crosses (§6.1 — projection-authoritative,
  // never guessed).
  const permissionValue = values.permissions
  if (typeof permissionValue === 'object' && permissionValue !== null) {
    const current = (permissionValue as { readonly currentValue?: unknown }).currentValue
    if (typeof current === 'string' && current !== '') record.permission = current
  }
  // The official `goal` projection VIEW: `{goal:{objective,phase}} | null`. The
  // LEGAL null ("no goal") is preserved; an absent/foreign value reads absent
  // (unavailable), never `null` — the two dispositions differ.
  if ('goal' in values) {
    const goal = goalFact(values.goal)
    if (goal !== undefined) record.goal = goal
  }
  const pressure = numericRecord(values.contextPressure)
  const breakdownValue = values.contextBreakdown
  const breakdown = typeof breakdownValue === 'object' && breakdownValue !== null
    ? numericRecord(breakdownValue)
    : undefined
  const hasBreakdown = breakdown !== undefined
    && typeof breakdown.systemTokens === 'number'
    && typeof breakdown.toolsTokens === 'number'
    && typeof breakdown.messageTokens === 'number'
  const hasPressure = pressure !== undefined && Object.keys(pressure).length > 0
  if (hasPressure || hasBreakdown) {
    record.context = {
      ...pressure ?? {},
      ...(hasBreakdown
        ? { breakdown: { systemTokens: breakdown!.systemTokens!, toolsTokens: breakdown!.toolsTokens!, messageTokens: breakdown!.messageTokens! } }
        : {}),
    }
  }
  const todos = detachedTodos(values.todos)
  if (todos !== undefined) record.todos = todos
  const usageValue = numericRecord(values.tokenUsage)
  if (usageValue !== undefined
    && typeof usageValue.uncachedInputTokens === 'number'
    && typeof usageValue.outputTokens === 'number'
    && typeof usageValue.cacheReadTokens === 'number'
    && typeof usageValue.cacheWriteTokens === 'number') {
    record.usage = {
      uncachedInputTokens: usageValue.uncachedInputTokens,
      outputTokens: usageValue.outputTokens,
      cacheReadTokens: usageValue.cacheReadTokens,
      cacheWriteTokens: usageValue.cacheWriteTokens,
    }
  }
  return record
}

/** Narrow the official `goal` projection view: `null` (no goal) is a LEGAL
 *  value and stays distinct from `undefined` (unavailable); the current goal
 *  is read from `goal.{objective,phase}` with the phase vocabulary validated. */
function goalFact(value: unknown): SessionStatusProjection['goal'] | undefined {
  if (value === null) return null
  if (typeof value !== 'object') return undefined
  const current = (value as { readonly goal?: unknown }).goal
  if (typeof current !== 'object' || current === null) return undefined
  const goal = current as { readonly objective?: unknown; readonly phase?: unknown }
  if (typeof goal.objective !== 'string' || goal.objective === '') return undefined
  if (goal.phase !== 'active' && goal.phase !== 'paused' && goal.phase !== 'blocked' && goal.phase !== 'complete') {
    return undefined
  }
  return { objective: goal.objective, phase: goal.phase }
}

/** Narrow an unknown projection value to its numeric fields (no coercion). */
function numericRecord(value: unknown): Record<string, number | undefined> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Readonly<Record<string, unknown>>
  const out: Record<string, number | undefined> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === 'number') out[key] = entry
  }
  return out
}

/** The effective selection off the official `modelSelection` fold:
 * `next ?? lastUsed`, validated to the normalized shape. */
function modelSelectionFact(value: unknown): SessionStatusProjection['model'] {
  if (typeof value !== 'object' || value === null) return undefined
  const fold = value as { readonly next?: unknown; readonly lastUsed?: unknown }
  for (const candidate of [fold.next, fold.lastUsed]) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const selection = candidate as { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown }
    if (typeof selection.provider !== 'string' || selection.provider === '') continue
    if (typeof selection.model !== 'string' || selection.model === '') continue
    return {
      provider: selection.provider,
      model: selection.model,
      ...typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
        ? { reasoningEffort: selection.reasoningEffort }
        : {},
    }
  }
  return undefined
}

/** Detach the official `todos` whole-list snapshot. The projection's
 * LEGAL `null` (no `todo/write` yet) stays `null`; only `undefined` (the
 * projection value was absent — capability unavailable) reads absent. */
function detachedTodos(value: unknown): SessionStatusProjection['todos'] | undefined {
  if (value === null) return null
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined
    const todo = item as { readonly content?: unknown; readonly status?: unknown }
    if (typeof todo.content !== 'string') return undefined
    if (todo.status !== 'pending' && todo.status !== 'in_progress' && todo.status !== 'completed') return undefined
    todos.push({ content: todo.content, status: todo.status })
  }
  return Object.freeze(todos)
}
