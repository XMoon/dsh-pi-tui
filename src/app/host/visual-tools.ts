/**
 * The visual tool row: `dsh_pi_tui_chart`, `dsh_pi_tui_svg` and
 * `present_visual`.
 *
 * This is the HOST-plane Loader row (`@xmoon76/dsh-pi-tui/visual-tools`), not a
 * TUI module: the three definitions live in the official `ctx.tools` registry.
 * They are NOT gated by Tern, a renderer, a client capability, a session or a
 * resize — a Direct and a Remote Host load the same definitions, and a plain
 * terminal still sees all three tools.
 *
 * The row's `.volatile()` `enabled` field is the ONE profile-wide availability
 * authority: it defaults to ON, the Settings service projects it as the
 * `pi-tui-visual-tools` form section, and the Loader commits a live form write
 * into the running reference and then dispatches `loader/volatile-update` to
 * THIS fiber. The row reconciles the THREE registry registrations from that one
 * reference as one atomic group:
 *
 * - Off (or a restart with a persisted Off) releases all three registrations, so
 *   the next model request neither sees the tools nor pays their schema tokens;
 * - On registers all three definitions again under their original identity.
 *
 * Group consistency is guaranteed for the SETTLED state after the outermost
 * synchronous reconciliation drain completes: a successful On holds all three
 * registrations, a successful Off holds none, and a failed registration removes
 * the definitions this transition already added when its rollback succeeds. The
 * official registry publishes one `tools/change` notification per registration
 * and exposes no transactional seam, so a SYNCHRONOUS observer can see the
 * intermediate states while a transition is running; notifications are not
 * transactional. What the contract forbids is a half-enabled group AFTER the
 * drain — that state is what {@link VISUAL_TOOLS_STATUS_SERVICE} reports, so the
 * Direct adapter never claims a registration the registry does not hold (a
 * Remote Client has no equivalent wire and must not claim runtime success).
 *
 * The result contract follows the revised PR-D D0 decision: no
 * `presentationMeta` at all. Each `output.render` produces the readable text
 * plus one versioned machine line in a separate TEXT block; the final durable
 * content is the only admission source for a drawing, so a content-only
 * post-execute replacement removes the drawing instead of leaving stale visual
 * metadata behind.
 *
 * `present_visual` is the explicit publication intent: it validates references
 * against the SAME committed session events cold replay reads, through the one
 * domain authority (`domain/visual/publication.ts`), and adds no durable event
 * of its own.
 * @module @xmoon76/dsh-pi-tui/app/host/visual-tools
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolDefinition, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  chartArgsProblem,
  chartContentBlocks,
  chartFactFromArgs,
  type ChartArgs,
} from '../../domain/visual/chart.ts'
import { svgArgsProblem, svgContentBlocks, svgFactFromArgs, type SvgArgs } from '../../domain/visual/svg.ts'
import {
  VISUAL_TOOLS_STATUS_SERVICE,
  type VisualToolsRuntimeStatus,
} from '../../domain/visual/runtime-status.ts'
import {
  asVisualSessionEvents,
  decidePublication,
  MAX_PUBLISHED_VISUALS,
  VISUAL_PUBLISHED_PREFIX,
  type PublicationDecision,
} from '../../domain/visual/publication.ts'
import { visualReference, visualReferenceLine } from '../../domain/visual/reference.ts'
import {
  CHART_TOOL_NAME,
  PRESENT_VISUAL_TOOL_NAME,
  SVG_TOOL_NAME,
} from '../../domain/visual/tools.ts'

/** Stable Cordis plugin name (the Loader row id in `cordis.patch.yml`). */
export const name = 'pi-tui-visual-tools'

/**
 * The Host services this row uses: the registry it owns, the live Agent (the
 * executing Session identity) and the official Session read service that
 * returns a committed observation.
 */
export const inject = ['tools', 'agents', 'sessionQuery', 'sessionProjections']

export { CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME }

/**
 * The row's profile-wide availability switch. `enabled` is a volatile field:
 * the Settings service projects it into an editable form section, and a write
 * is committed into this live reference without remounting the row. The
 * default is ON, so an existing profile needs no migration.
 */
export interface Config {
  readonly enabled: Volatile<boolean>
}

/** The Config schema the Loader resolves (default ON, live form field). */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).volatile(),
}) as unknown as z<Config>

const CHART_POINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    label: { type: 'string', required: true },
    value: { type: 'number', required: true },
  },
} as const

const CHART_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1, required: true },
    type: { type: 'string', const: 'chart', required: true },
    kind: { type: 'string', enum: ['bars', 'spark'], required: true },
    title: { type: 'string', required: true },
    unit: { type: 'string' },
    series: { type: 'array', required: true, items: CHART_POINT_SCHEMA },
  },
} as const

const SVG_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1, required: true },
    type: { type: 'string', const: 'svg', required: true },
    title: { type: 'string', required: true },
    description: { type: 'string', required: true },
    digest: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
  },
} as const

/** One published reference in the canonical output value. */
const PUBLISHED_VISUAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', required: true },
  },
} as const

const PUBLISHED_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1, required: true },
    published: { type: 'array', required: true, items: PUBLISHED_VISUAL_SCHEMA },
  },
} as const

/** The executing turn/step fence a generating `projectContent` reads. */
interface TurnBoundary {
  readonly openTurnStartSeq: number | null
  readonly lastStepStartSeq: number | null
  readonly lastStepBoundary: { readonly kind: 'start' | 'end'; readonly seq: number } | null
  readonly lastTurn: number
}

/**
 * The narrow official `sessionQuery` read this row uses.
 *
 * Declared structurally (the same discipline `runtime/direct/session-direct.ts`
 * documents): importing the Host package's type graph here would add a second
 * physical copy of `dsh-session` and new Client-boundary coupling.
 */
interface SessionQueryObservationLike {
  observeSession(
    sessionId: string,
    options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' },
  ): Promise<{
    readonly source: 'live' | 'prepared'
    readonly header: { readonly id: string }
    readonly events: readonly { readonly type: string }[]
    [Symbol.dispose](): void
  }>
}

/** The narrow official `sessionProjections` read this row uses. */
interface SessionProjectionReaderLike {
  stateOf(session: unknown, key: 'turnBoundary'): TurnBoundary | undefined
}

/**
 * Insert the model-visible reference block before the final `visual-v1:` block
 * of one generating result.
 *
 * The reference is injected ONLY when the call has a real Agent, is a root
 * call, is inside an open turn whose latest boundary is an open `step/start`,
 * succeeded, and already ends with a valid `visual-v1:` fact line. Otherwise
 * the original projection is preserved verbatim — an agentless or failed call
 * keeps its exact previous behaviour.
 */
function projectVisualReference(
  projections: SessionProjectionReaderLike,
  exec: Parameters<NonNullable<ToolDefinition['projectContent']>>[0],
  result: Parameters<NonNullable<ToolDefinition['projectContent']>>[1],
): ContentBlock[] | undefined {
  if (exec.agent === undefined || exec.parent !== undefined) return undefined
  if (result.isError) return undefined
  const boundary = projections.stateOf(exec.agent.session, 'turnBoundary')
  if (boundary === undefined) return undefined
  if (boundary.openTurnStartSeq === null || boundary.lastStepStartSeq === null) return undefined
  if (boundary.lastStepBoundary === null || boundary.lastStepBoundary.kind !== 'start') return undefined
  const blocks = result.content
  let lastText = -1
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]!.type === 'text') {
      lastText = index
      break
    }
  }
  if (lastText === -1) return undefined
  const factBlock = blocks[lastText] as Extract<ContentBlock, { type: 'text' }>
  if (!factBlock.text.startsWith('visual-v1:')) return undefined
  const reference = visualReference({
    sessionId: exec.agent.session.id as unknown as string,
    turn: boundary.lastTurn,
    stepStartSeq: boundary.lastStepStartSeq,
    callId: exec.callId as unknown as string,
  })
  return [
    ...blocks.slice(0, lastText),
    { type: 'text', text: visualReferenceLine(reference) },
    ...blocks.slice(lastText),
  ]
}

/**
 * Define the chart tool. The tool body is a pure canonical projection of the
 * caller's supplied numbers: no filesystem, network, model or workspace access.
 * @param projections - the turn-boundary reader the reference projection uses.
 */
function chartTool(projections: SessionProjectionReaderLike) {
  return defineTool({
    name: CHART_TOOL_NAME,
    description: 'Render a small static chart from numbers supplied by the user or by an explicitly labelled example. '
      + 'Use only when a visual comparison is clearer than prose; never invent data, query a monitor, or imply the values are live measurements. '
      + 'Supports bars or a sparkline with 2 to 12 labelled points and an optional unit. '
      + 'The result always includes every exact label and value as readable text, and carries a stable visual ref '
      + '(`visual-ref-v1:sv1_…`) you may later pass to present_visual.',
    parameters: {
      kind: { type: 'string', enum: ['bars', 'spark'], required: true, description: 'Chart shape: bars or spark.' },
      title: { type: 'string', required: true, description: 'Short chart title (at most 100 Unicode code points).' },
      unit: { type: 'string', description: 'Optional unit shown after each value (at most 32 Unicode code points).' },
      series: {
        type: 'array',
        required: true,
        description: 'The supplied points in display order (2 to 12).',
        items: CHART_POINT_SCHEMA,
      },
    },
    output: {
      schema: CHART_OUTPUT_SCHEMA,
      render: (_args, value) => chartContentBlocks(value),
    },
    projectContent: (exec, result) => projectVisualReference(projections, exec, result),
    isConcurrencySafe: () => true,
    async execute(args) {
      const problem = chartArgsProblem(args)
      if (problem !== undefined) throw new Error(problem)
      const fact = chartFactFromArgs(args as ChartArgs)
      // The executable output carries a mutable array (the registry's inferred
      // value shape); the read-only fact stays the renderer's view.
      return {
        version: fact.version,
        type: fact.type,
        kind: fact.kind,
        title: fact.title,
        ...fact.unit === undefined ? {} : { unit: fact.unit },
        series: fact.series.map(point => ({ label: point.label, value: point.value })),
      }
    },
  })
}

/**
 * Define the SVG tool. The body admits a bounded static subset and returns the
 * short credential; the source itself stays in the durable call arguments.
 * @param projections - the turn-boundary reader the reference projection uses.
 */
function svgTool(projections: SessionProjectionReaderLike) {
  return defineTool({
    name: SVG_TOOL_NAME,
    description: 'Render one static, self-contained SVG figure. Use only when a diagram communicates better than text. '
      + 'The document must have an explicit viewBox or absolute width/height and use only static shapes, paths, text, gradients, masks and local references. '
      + 'Scripts, foreignObject, CSS/style elements, animation, DOCTYPE, external files or URLs are rejected. '
      + 'Use absolute units (px/pt/pc/mm/cm/in or unitless); relative units (percentages, em/ex/ch/rem/vw/vh) are rejected (a gradient stop offset may be a 0-100% fraction). '
      + 'Always provide a short readable description; the result keeps the description and a short source credential, '
      + 'while the SVG source itself stays in the tool call. The result carries a stable visual ref '
      + '(`visual-ref-v1:sv1_…`) you may later pass to present_visual.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short figure title (at most 100 code points).' },
      description: { type: 'string', required: true, description: 'Short readable description (at most 500 code points).' },
      svg: { type: 'string', required: true, description: 'The complete standalone SVG document (at most 128 KiB UTF-8).' },
    },
    output: {
      schema: SVG_OUTPUT_SCHEMA,
      render: (_args, value) => svgContentBlocks(value),
    },
    projectContent: (exec, result) => projectVisualReference(projections, exec, result),
    isConcurrencySafe: () => true,
    async execute(args) {
      const problem = svgArgsProblem(args)
      if (problem !== undefined) throw new Error(problem)
      return svgFactFromArgs(args as SvgArgs)
    },
  })
}

/** One requested `visuals` entry, already shape-validated by `defineTool`. */
interface RequestedVisual {
  readonly ref: string
}

/** The validated `present_visual` arguments. */
interface PresentVisualArgs {
  readonly visuals: readonly RequestedVisual[]
}

/** Validate the requested references beyond the JSON schema (uniqueness). */
function presentVisualArgsProblem(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object with a visuals array'
  const record = args as Record<string, unknown>
  const visuals = record.visuals
  if (!Array.isArray(visuals)) return 'visuals must be an array'
  if (visuals.length === 0 || visuals.length > MAX_PUBLISHED_VISUALS) {
    return `visuals must contain between 1 and ${MAX_PUBLISHED_VISUALS} items`
  }
  const refs = visuals.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const ref = (entry as Record<string, unknown>).ref
    return typeof ref === 'string' ? ref : undefined
  })
  if (refs.some(ref => ref === undefined)) return 'every visual must carry a string ref'
  if (new Set(refs).size !== refs.length) return 'the same visual ref appears more than once'
  return undefined
}

/**
 * Define the publication tool.
 *
 * The body reads the committed Session through the official observation lease,
 * fences the turn/step boundary before and after the read, and delegates the
 * whole qualification decision to the domain authority — the same function cold
 * replay uses. A refusal throws one readable error; there is no partial
 * publication.
 * @param ctx - the Host context (recorded so the tool body reads the live Host).
 * @param projections - the turn-boundary reader used for the boundary fences.
 */
function presentVisualTool(ctx: Context, projections: SessionProjectionReaderLike) {
  return defineTool({
    name: PRESENT_VISUAL_TOOL_NAME,
    description: 'Select previously generated chart/SVG visuals for presentation to the user. '
      + 'First call dsh_pi_tui_chart or dsh_pi_tui_svg and read the `visual-ref-v1:sv1_…` reference in its result. '
      + 'Wait until that generating call has finished, then in a LATER model step pass 1 to '
      + `${MAX_PUBLISHED_VISUALS} refs (usually the 1-2 figures that genuinely help the explanation) `
      + 'and briefly explain their content in your final answer. '
      + 'Only visuals generated in the current turn of this session may be selected; the whole call fails if any ref is unknown, repeated, from an earlier turn, or not committed yet.',
    parameters: {
      visuals: {
        type: 'array',
        required: true,
        description: `The visuals to present, in display order (1 to ${MAX_PUBLISHED_VISUALS}).`,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', required: true, description: 'The `sv1_…` reference from a chart/SVG tool result.' },
          },
        },
      },
    },
    output: {
      schema: PUBLISHED_OUTPUT_SCHEMA,
      render: (_args, value) => publicationBlocks(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('present_visual requires an agent Session')
      if (exec.parent !== undefined) throw new Error('present_visual is only available as a top-level model tool call')
      const problem = presentVisualArgsProblem(args)
      if (problem !== undefined) throw new Error(problem)
      const requested = args as PresentVisualArgs
      const session = exec.agent.session
      const before = requireOpenStep(projections, session, 'present_visual')
      const query = ctx.reflect.get('sessionQuery') as SessionQueryObservationLike
      const observation = await query.observeSession(session.id as unknown as string, {
        signal: exec.signal,
        projectionMode: 'none',
      })
      let events: ReturnType<typeof asVisualSessionEvents>
      try {
        exec.signal.throwIfAborted()
        if (observation.header.id !== session.id) {
          throw new Error('present_visual could not confirm the executing Session identity')
        }
        if (observation.source !== 'live') {
          throw new Error('present_visual requires a live Session observation')
        }
        events = asVisualSessionEvents(observation.events)
      } finally {
        observation[Symbol.dispose]()
      }
      exec.signal.throwIfAborted()
      const after = requireOpenStep(projections, session, 'present_visual')
      if (!sameBoundary(before, after)) {
        throw new Error('present_visual aborted: the turn/step boundary changed while reading the Session')
      }
      const decision: PublicationDecision = decidePublication({
        sessionId: session.id as unknown as string,
        events,
        refs: requested.visuals.map(entry => entry.ref),
        turn: before.lastTurn,
        stepStartSeq: before.lastStepStartSeq as unknown as number,
        callId: exec.callId as unknown as string,
      })
      if (!decision.ok) throw new Error(decision.reason)
      return { version: 1 as const, published: decision.receipt.published.map(entry => ({ ref: entry.ref })) }
    },
  })
}

/** Read the turn boundary and require an open turn with an open `step/start`. */
function requireOpenStep(
  projections: SessionProjectionReaderLike,
  session: unknown,
  toolName: string,
): TurnBoundary {
  const boundary = projections.stateOf(session, 'turnBoundary')
  if (boundary === undefined) throw new Error(`${toolName} requires the turnBoundary session projection`)
  if (boundary.openTurnStartSeq === null) throw new Error(`${toolName} requires an open turn`)
  if (boundary.lastStepStartSeq === null) throw new Error(`${toolName} requires an open step`)
  if (boundary.lastStepBoundary === null || boundary.lastStepBoundary.kind !== 'start') {
    throw new Error(`${toolName} requires an open step`)
  }
  return boundary
}

/** Whether two boundary reads describe the exact same execution fence. */
function sameBoundary(a: TurnBoundary, b: TurnBoundary): boolean {
  const stepA = a.lastStepBoundary
  const stepB = b.lastStepBoundary
  return a.openTurnStartSeq === b.openTurnStartSeq
    && a.lastStepStartSeq === b.lastStepStartSeq
    && a.lastTurn === b.lastTurn
    && stepA?.kind === stepB?.kind
    && stepA?.seq === stepB?.seq
}

/** The two content blocks of one successful publication receipt. */
function publicationBlocks(value: { version: 1; published: readonly { ref: string }[] }): ContentBlock[] {
  const count = value.published.length
  return [
    { type: 'text', text: `Selected ${count} visual${count === 1 ? '' : 's'} for presentation.` },
    { type: 'text', text: `${VISUAL_PUBLISHED_PREFIX}${JSON.stringify(value)}` },
  ]
}

/** Fail closed when a visible same-name definition already owns the name. */
function assertNameFree(tools: ToolRuntime, toolName: string): void {
  const existing = tools.get(toolName)
  if (existing !== undefined) {
    throw new Error(`visual tool name conflict: "${toolName}" is already registered; this row will not shadow another tool`)
  }
}

/** One live registration THIS row owns: the exact definition (the registry
 *  identity is the authoritative visibility fact) and its exact disposer. */
interface RegisteredVisualTool {
  readonly definition: ToolDefinition
  readonly dispose: () => void
}

/**
 * Release one registration and answer the handle the row should keep.
 *
 * A dsh-tools disposer removes the registry entry BEFORE it emits
 * `tools/change`, and that synchronous emit propagates listener exceptions.
 * The handle may therefore be dropped even when `dispose()` throws (the tool is
 * already gone); it is kept only while the registry still returns THIS
 * definition, so a later reconciliation can attempt the release again.
 */
function releaseRegistered(
  tools: ToolRuntime,
  name: string,
  registered: RegisteredVisualTool | undefined,
  errors: unknown[],
): RegisteredVisualTool | undefined {
  if (registered === undefined) return undefined
  try {
    registered.dispose()
  } catch (error) {
    errors.push(error)
    if (tools.get(name) === registered.definition) return registered
  }
  return undefined
}

/**
 * Register this Host row: reconcile the three tool registrations with the
 * `enabled` Config reference at mount and after every volatile commit.
 *
 * `ctx.reflect.get` is the documented permanent-Host-plane idiom
 * (`docs/architecture/host-client.md`): this module IS the Host plane, so the
 * registry read is not Client-side coupling and the client-boundary inventory
 * stays inside the existing baseline. The explicit `inject` above guarantees
 * every service.
 *
 * The Loader commits every volatile value BEFORE it dispatches
 * `loader/volatile-update`, so the listener must read the reference (never the
 * event payload) and ignore unrelated paths. A throwing listener is contained
 * by the Loader: the write stays committed, and the next read of
 * {@link VISUAL_TOOLS_STATUS_SERVICE} proves the registration did not follow.
 *
 * Reconciliation is SERIALIZED: a `tools/change` listener may synchronously
 * write the Config back from inside a registration/disposal callback, so that
 * request is queued and applied after the current transition reaches a
 * consistent group instead of interleaving two transitions.
 *
 * @param ctx - the Host context that owns this row's fiber.
 * @param config - the resolved Config (the live `enabled` reference).
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.reflect.get('tools') as ToolRuntime
  const projections = ctx.reflect.get('sessionProjections') as SessionProjectionReaderLike
  let chart: RegisteredVisualTool | undefined
  let svg: RegisteredVisualTool | undefined
  let present: RegisteredVisualTool | undefined
  /** One synchronous reconciliation seat (see `request`). */
  let reconciling = false
  /** The LATEST requested target while the seat is held. */
  let pending: boolean | undefined
  /** The live group, in registration order. */
  const group = (): readonly (readonly [string, RegisteredVisualTool | undefined])[] => [
    [CHART_TOOL_NAME, chart],
    [SVG_TOOL_NAME, svg],
    [PRESENT_VISUAL_TOOL_NAME, present],
  ]
  /** The LIVE GROUP fact, read from the official registry (never a second
   *  enable value): all three definitions this row registered are currently
   *  the ones the registry returns. A partially released group answers false. */
  const applied = (): boolean => group().every(([name, registered]) =>
    registered !== undefined && tools.get(name) === registered.definition)
  ctx.provide(VISUAL_TOOLS_STATUS_SERVICE, { applied } satisfies VisualToolsRuntimeStatus)

  /**
   * Attempt ALL THREE releases even when one of them throws, then surface the
   * collected failures: one broken `tools/change` listener must never strand
   * the other registrations. Releases run in reverse registration order.
   *
   * The handles are DETACHED before any disposer runs. A disposer emits
   * `tools/change` synchronously, and a Host listener may re-enter the switch;
   * that request is queued by `request()`, but it must never observe or
   * overwrite a handle this release already owns.
   */
  const release = (): void => {
    const errors: unknown[] = []
    const releasing: readonly (readonly [string, RegisteredVisualTool | undefined])[] = [
      [PRESENT_VISUAL_TOOL_NAME, present],
      [SVG_TOOL_NAME, svg],
      [CHART_TOOL_NAME, chart],
    ]
    chart = undefined
    svg = undefined
    present = undefined
    const restored = new Map<string, RegisteredVisualTool>()
    for (const [name, registered] of releasing) {
      const kept = releaseRegistered(tools, name, registered, errors)
      if (kept !== undefined) restored.set(name, kept)
    }
    // A disposer that failed BEFORE removing its definition stays retryable;
    // nothing newer can have registered while this release holds the seat.
    chart = restored.get(CHART_TOOL_NAME)
    svg = restored.get(SVG_TOOL_NAME)
    present = restored.get(PRESENT_VISUAL_TOOL_NAME)
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'visual tools: releasing the registrations failed')
    }
  }

  /** Register all three definitions in the fixed order; a failure rolls back the
   *  ones this transition already registered, so the SETTLED group is all-or-none.
   *  Each `tools.register()` publishes its own `tools/change` synchronously (the
   *  registry has no batch seam), so a synchronous observer can see the
   *  intermediate additions of a transition that is still running. */
  const register = (): void => {
    for (const [name] of group()) assertNameFree(tools, name)
    const created: RegisteredVisualTool[] = []
    const rollback = (failure: unknown): never => {
      const errors: unknown[] = [failure]
      for (const registered of [...created].reverse()) {
        try {
          registered.dispose()
        } catch (rollbackError) {
          errors.push(rollbackError)
        }
      }
      if (errors.length === 1) throw failure
      throw new AggregateError(errors, 'visual tools: a registration failed and the rollback did not complete')
    }
    try {
      const chartDefinition = chartTool(projections)
      chart = { definition: chartDefinition, dispose: tools.register(chartDefinition) }
      created.push(chart)
      const svgDefinition = svgTool(projections)
      svg = { definition: svgDefinition, dispose: tools.register(svgDefinition) }
      created.push(svg)
      const presentDefinition = presentVisualTool(ctx, projections)
      present = { definition: presentDefinition, dispose: tools.register(presentDefinition) }
      created.push(present)
    } catch (error) {
      chart = undefined
      svg = undefined
      present = undefined
      rollback(error)
    }
  }

  /** Apply ONE settled target value; runs only while `request()` holds the
   *  reconciliation seat. */
  const applyState = (enabled: boolean): void => {
    if (enabled) {
      if (applied()) return
      // A partial group (an earlier release threw after removing one entry, or a
      // registration failed after its rollback) is fully cleared first.
      release()
      register()
      return
    }
    release()
  }

  /**
   * Serialize every reconciliation request. The Loader commits the value
   * before dispatch, and a `tools/change` listener may synchronously write the
   * Config back (or emit `loader/volatile-update` directly) from inside a
   * registration or disposal callback. Re-entering the state machine there
   * would interleave two group transitions and could clobber a newly registered
   * handle, so a nested request only records the LATEST target; the outer drain
   * applies it after the current transition reaches a consistent group.
   */
  const request = (enabled: boolean): void => {
    pending = enabled
    if (reconciling) return
    reconciling = true
    const failures: unknown[] = []
    try {
      // A failing transition must not drop a NEWER target queued by a
      // synchronous listener during that transition: keep draining, then
      // surface every failure after the newest settled state is applied.
      while (pending !== undefined) {
        const next = pending
        pending = undefined
        try {
          applyState(next)
        } catch (error) {
          failures.push(error)
        }
      }
    } finally {
      reconciling = false
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'visual tools: reconciliation failed repeatedly')
    }
  }

  ctx.on('loader/volatile-update', (paths) => {
    if (!paths.some(path => path.length === 1 && path[0] === 'enabled')) return
    request(config.enabled.get())
  })
  request(config.enabled.get())
}
