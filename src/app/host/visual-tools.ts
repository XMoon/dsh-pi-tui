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
import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
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

/** The two exact registration disposers THIS row owns (never enable state:
 *  `applied` is derived from their presence and the value lives in the
 *  Loader-committed Config reference). */
interface VisualToolDisposers {
  readonly chart: () => void
  readonly svg: () => void
}

/** Register both definitions atomically: a second-name conflict rolls the
 *  first registration back, so the registry never carries a half pair. */
function registerBoth(tools: ToolRuntime): VisualToolDisposers {
  assertNameFree(tools, CHART_TOOL_NAME)
  assertNameFree(tools, SVG_TOOL_NAME)
  const chart = tools.register(chartTool())
  try {
    const svg = tools.register(svgTool())
    return { chart, svg }
  } catch (error) {
    chart()
    throw error
  }
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
 * @param ctx - the Host context that owns this row's fiber.
 * @param config - the resolved Config (the live `enabled` reference).
 */
export function apply(ctx: Context, config: Config): void {
  const tools = ctx.reflect.get('tools') as ToolRuntime
  let disposers: VisualToolDisposers | undefined
  const status: VisualToolsRuntimeStatus = {
    applied: () => disposers !== undefined,
  }
  // The status read is the row's OWN registration fact; the registry entry
  // itself can also be probed, but only this row can say whether the live pair
  // is the one it registered.
  ctx.provide(VISUAL_TOOLS_STATUS_SERVICE, status)

  const reconcile = (enabled: boolean): void => {
    if (enabled) {
      if (disposers !== undefined) return
      disposers = registerBoth(tools)
      return
    }
    const current = disposers
    if (current === undefined) return
    // Clear the handle BEFORE releasing: a re-entrant read observes the new
    // state, and a disposer can never be called twice.
    disposers = undefined
    current.chart()
    current.svg()
  }

  ctx.on('loader/volatile-update', (paths) => {
    if (!paths.some(path => path.length === 1 && path[0] === 'enabled')) return
    reconcile(config.enabled.get())
  })
  reconcile(config.enabled.get())
}
