/**
 * The PR-D visual tools: `dsh_pi_tui_chart` and `dsh_pi_tui_svg`.
 *
 * This is the HOST-plane Loader row (`@xmoon76/dsh-pi-tui/visual-tools`), not a
 * TUI module: the two definitions live in the official `ctx.tools` registry.
 * They are NOT gated by Tern, a renderer, a client capability, a session or a
 * resize — a Direct and a Remote Host load the same definitions, and a plain
 * terminal still sees both tools.
 *
 * The row's `.volatile()` `enabled` field is the ONE profile-wide availability
 * authority: it defaults to ON, the Settings service projects it as the
 * `pi-tui-visual-tools` form section, and the Loader commits a live form write
 * into the running reference and then dispatches `loader/volatile-update` to
 * THIS fiber. The row reconciles the two registry registrations from that
 * reference:
 *
 * - Off (or a restart with a persisted Off) releases both registrations, so
 *   the next model request neither sees the tools nor pays their schema tokens;
 * - On registers both definitions again under their original identity.
 *
 * Registration is atomic: a same-name conflict never leaves a half-enabled
 * pair, and a failed re-enable keeps the row reporting `applied: false` through
 * {@link VISUAL_TOOLS_STATUS_SERVICE} (the Direct adapter reads that fact; a
 * Remote Client has no equivalent wire and must not claim runtime success).
 *
 * The result contract follows the revised PR-D D0 decision: no
 * `presentationMeta` at all. Each `output.render` produces the readable text
 * plus one versioned machine line in a separate TEXT block; the final durable
 * content is the only admission source for a drawing, so a content-only
 * post-execute replacement removes the drawing instead of leaving stale visual
 * metadata behind.
 * @module @xmoon76/dsh-pi-tui/app/host/visual-tools
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
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
  CHART_TOOL_NAME,
  SVG_TOOL_NAME,
  VISUAL_TOOLS_STATUS_SERVICE,
  type VisualToolsRuntimeStatus,
} from '../../domain/visual/tool-identity.ts'

/** Stable Cordis plugin name (the Loader row id in `cordis.patch.yml`). */
export const name = 'pi-tui-visual-tools'

/** The Host tool registry is this row's whole purpose. */
export const inject = ['tools']

/** The two stable, namespaced model tool names (the domain owns their
 *  identity; this entry keeps re-exporting them for its consumers). */
export { CHART_TOOL_NAME, SVG_TOOL_NAME } from '../../domain/visual/tool-identity.ts'

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

/**
 * Define the chart tool. The tool body is a pure canonical projection of the
 * caller's supplied numbers: no filesystem, network, model or workspace access.
 */
function chartTool() {
  return defineTool({
    name: CHART_TOOL_NAME,
    description: 'Render a small static chart from numbers supplied by the user or by an explicitly labelled example. '
      + 'Use only when a visual comparison is clearer than prose; never invent data, query a monitor, or imply the values are live measurements. '
      + 'Supports bars or a sparkline with 2 to 12 labelled points and an optional unit. '
      + 'The result always includes every exact label and value as readable text.',
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
 */
function svgTool() {
  return defineTool({
    name: SVG_TOOL_NAME,
    description: 'Render one static, self-contained SVG figure. Use only when a diagram communicates better than text. '
      + 'The document must have an explicit viewBox or absolute width/height and use only static shapes, paths, text, gradients, masks and local references. '
      + 'Scripts, foreignObject, CSS/style elements, animation, DOCTYPE, external files or URLs are rejected. '
      + 'Use absolute units (px/pt/pc/mm/cm/in or unitless); relative units (percentages, em/ex/ch/rem/vw/vh) are rejected (a gradient stop offset may be a 0-100% fraction). '
      + 'Always provide a short readable description; the result keeps the description and a short source credential, '
      + 'while the SVG source itself stays in the tool call.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short figure title (at most 100 Unicode code points).' },
      description: { type: 'string', required: true, description: 'Short readable description (at most 500 Unicode code points).' },
      svg: { type: 'string', required: true, description: 'The complete standalone SVG document (at most 128 KiB UTF-8).' },
    },
    output: {
      schema: SVG_OUTPUT_SCHEMA,
      render: (_args, value) => svgContentBlocks(value),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const problem = svgArgsProblem(args)
      if (problem !== undefined) throw new Error(problem)
      return svgFactFromArgs(args as SvgArgs)
    },
  })
}

/** Fail closed when a visible same-name definition already owns the name. */
function assertNameFree(tools: ToolRuntime, toolName: string): void {
  const existing = tools.get(toolName)
  if (existing !== undefined) {
    throw new Error(`visual tool name conflict: "${toolName}" is already registered; PR-D will not shadow another tool`)
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
 * Register this Host row: reconcile the two tool registrations with the
 * `enabled` Config reference at mount and after every volatile commit.
 *
 * `ctx.reflect.get` is the documented permanent-Host-plane idiom
 * (`docs/architecture/host-client.md`): this module IS the Host plane, so the
 * registry read is not Client-side coupling and the client-boundary inventory
 * stays unchanged. The explicit `inject` above guarantees the service.
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
 * consistent pair instead of interleaving two transitions.
 *
 * @param ctx - the Host context that owns this row's fiber.
 * @param config - the resolved Config (the live `enabled` reference).
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.reflect.get('tools') as ToolRuntime
  let chart: RegisteredVisualTool | undefined
  let svg: RegisteredVisualTool | undefined
  /** One synchronous reconciliation seat (see `request`). */
  let reconciling = false
  /** The LATEST requested target while the seat is held. */
  let pending: boolean | undefined
  /** The LIVE PAIR fact, read from the official registry (never a second
   *  enable value): both definitions this row registered are currently the
   *  ones the registry returns. A partially released pair answers false. */
  const applied = (): boolean =>
    chart !== undefined && svg !== undefined
    && tools.get(CHART_TOOL_NAME) === chart.definition
    && tools.get(SVG_TOOL_NAME) === svg.definition
  ctx.provide(VISUAL_TOOLS_STATUS_SERVICE, { applied } satisfies VisualToolsRuntimeStatus)

  /**
   * Attempt BOTH releases even when the first one throws, then surface the
   * collected failure: one broken `tools/change` listener must never strand
   * the other registration.
   *
   * The pair is DETACHED before any disposer runs. A disposer emits
   * `tools/change` synchronously, and a Host listener may re-enter the switch;
   * that request is queued by `request()`, but it must never observe or
   * overwrite a handle this release already owns.
   */
  const release = (): void => {
    const errors: unknown[] = []
    const releasingChart = chart
    const releasingSvg = svg
    chart = undefined
    svg = undefined
    const restoredChart = releaseRegistered(tools, CHART_TOOL_NAME, releasingChart, errors)
    const restoredSvg = releaseRegistered(tools, SVG_TOOL_NAME, releasingSvg, errors)
    // A disposer that failed BEFORE removing its definition stays retryable;
    // nothing newer can have registered while this release holds the seat.
    if (restoredChart !== undefined) chart = restoredChart
    if (restoredSvg !== undefined) svg = restoredSvg
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'visual tools: releasing both registrations failed')
    }
  }

  /** Register both definitions atomically: a second-name conflict (or a second
   *  registration failure) rolls the first registration back, so the registry
   *  never carries a half pair. */
  const register = (): void => {
    assertNameFree(tools, CHART_TOOL_NAME)
    assertNameFree(tools, SVG_TOOL_NAME)
    const chartDefinition = chartTool()
    chart = { definition: chartDefinition, dispose: tools.register(chartDefinition) }
    try {
      const svgDefinition = svgTool()
      svg = { definition: svgDefinition, dispose: tools.register(svgDefinition) }
    } catch (error) {
      const rollback = chart
      chart = undefined
      try {
        rollback?.dispose()
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'visual tools: the second registration failed and the first could not be rolled back',
        )
      }
      throw error
    }
  }

  /** Apply ONE settled target value; runs only while `request()` holds the
   *  reconciliation seat. */
  const applyState = (enabled: boolean): void => {
    if (enabled) {
      if (applied()) return
      // A partial pair (an earlier release threw after removing one entry, or a
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
   * would interleave two pair transitions and could clobber a newly registered
   * handle, so a nested request only records the LATEST target; the outer
   * drain applies it after the current transition reaches a consistent pair.
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
