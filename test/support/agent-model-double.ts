/**
 * The upstream-shaped `AgentModel` double for Agent fakes.
 *
 * DSH 0.2.2 moved model-selection authority INTO the Agent: the agent loop
 * registers the `modelSelection` projection and owns an `AgentModel` whose
 * `current()` is the single read and whose `select()` is the single durable
 * write. Every fake Agent in the product suite models THIS shape, exactly like
 * the fake Agent models `session`/`ctx`/`inbox`: the live status/footer read
 * goes through `Agent.model.current()`, so a fake without `model` fails exactly
 * where a real Agent without its loop would.
 *
 * The read mirrors the upstream projection's fold — and, like the projection,
 * it is INCREMENTAL: the committed log seeds it once and every later
 * `session.append('model/selection' | 'request/header')` updates it, so the
 * model read never re-scans (and never fails on) a Session log the test
 * deliberately breaks.
 *
 * ```text
 * current() = pending ?? lastUsed ?? Agent options
 *   pending  = the latest `model/selection`, retired by a matching request header
 *   lastUsed = the latest `request/header` route
 * ```
 *
 * @module @xmoon76/dsh-pi-tui/test/support/agent-model-double
 */

/** One route selection (the semantic `ModelSelection` shape). */
export interface FakeAgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** The Agent options the upstream `AgentModel` falls back to. */
export interface FakeAgentModelOptions {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

/** The upstream `Model` surface the Agent exposes. */
export interface FakeAgentModel {
  current(): FakeAgentModelSelection | undefined
  select(selection: FakeAgentModelSelection): void
}

/** The Session capabilities the double uses when the fake Session provides
 *  them: the durable append it wraps and the committed log it seeds from. Fake
 *  Sessions in the suite differ in how complete they are, so the caller hands
 *  its own Session object and this double reads/writes through it only where
 *  it can. */
interface FakeAgentModelSessionCapable {
  append?(type: string, data: unknown): unknown
  snapshotEvents?(): readonly unknown[]
}

function selectionOf(config: Partial<FakeAgentModelSelection> | undefined): FakeAgentModelSelection | undefined {
  return typeof config?.provider === 'string' && typeof config.model === 'string'
    ? {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      }
    : undefined
}

function sameSelection(left: FakeAgentModelSelection, right: FakeAgentModelSelection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/**
 * Build one Agent's model double.
 * @param session - the Agent's Session (its durable append records the choice;
 *   its committed log seeds the projection state once).
 * @param options - the Agent's own route fallback (the production
 *   `AgentOptions` the loop's `AgentModel` falls back to).
 * @returns the double, shaped like the upstream `AgentModel`.
 */
export function fakeAgentModel(
  session: unknown,
  options: FakeAgentModelOptions,
): FakeAgentModel {
  const capable = session as FakeAgentModelSessionCapable | undefined
  let pending: FakeAgentModelSelection | undefined
  let lastUsed: FakeAgentModelSelection | undefined
  /** The fallback for fake Sessions that keep no readable log. */
  let recorded: FakeAgentModelSelection | undefined
  const fallback = selectionOf(options)

  /** Apply one committed event exactly like the upstream projection fold. */
  const observe = (type: unknown, data: unknown): void => {
    if (type === 'model/selection') {
      const next = selectionOf(data as Partial<FakeAgentModelSelection> | undefined)
      if (next !== undefined) pending = next
      return
    }
    if (type !== 'request/header') return
    // The official `selectionOfHeader` never records an effort the adapter
    // defaulted: that effort was not an explicit user choice.
    const header = (data as {
      header?: { config?: Partial<FakeAgentModelSelection>; adapterDefaults?: { reasoningEffort?: unknown } }
    } | undefined)?.header
    const adapterDefaultedEffort = header?.adapterDefaults?.reasoningEffort === true
    const next = selectionOf(adapterDefaultedEffort ? { ...header?.config, reasoningEffort: undefined } : header?.config)
    if (next === undefined) return
    if (pending !== undefined && sameSelection(pending, next)) pending = undefined
    lastUsed = next
  }

  // Seed from the log the resuming Session already carries, and keep observing
  // later appends through the same gate.
  if (typeof capable?.snapshotEvents === 'function') {
    for (const raw of capable.snapshotEvents()) {
      const event = raw as { type?: unknown; data?: unknown }
      observe(event.type, event.data)
    }
  }
  const append = capable?.append
  if (capable !== undefined && typeof append === 'function') {
    const original = append
    capable.append = (type: string, data: unknown) => {
      const result = original.call(session, type, data)
      observe(type, data)
      return result
    }
  }

  return {
    current: () => pending ?? lastUsed ?? recorded ?? fallback,
    select: (selection: FakeAgentModelSelection) => {
      const normalized: FakeAgentModelSelection = {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      }
      // The official `AgentModel.select` is a no-op for a selection equal to
      // the projection's recorded choice (pending ?? lastUsed); the Agent's
      // options fallback is NOT a recorded choice.
      const recordedChoice = pending ?? lastUsed
      if (recordedChoice !== undefined && sameSelection(recordedChoice, normalized)) return
      if (typeof capable?.append === 'function') capable.append('model/selection', normalized)
      else recorded = normalized
    },
  }
}
