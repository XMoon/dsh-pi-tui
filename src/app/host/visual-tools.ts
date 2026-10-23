/**
 * The PR-D visual tools: `dsh_pi_tui_chart` and `dsh_pi_tui_svg`.
 *
 * This is the HOST-plane Loader row (`@xmoon76/dsh-pi-tui/visual-tools`), not a
 * TUI module: the two definitions live in the official `ctx.tools` registry for
 * the whole Host profile lifetime. They are NOT gated by Tern, a renderer, a
 * client capability, a session or a resize — a Direct and a Remote Host load
 * the same definitions, and a plain terminal still sees both tools.
 *
 * The result contract follows the revised PR-D D0 decision: no
 * `presentationMeta` at all. Each `output.render` produces the readable text
 * plus one versioned machine line in a separate TEXT block; the final durable
 * content is the only admission source for a drawing, so a content-only
 * post-execute replacement removes the drawing instead of leaving stale visual
 * metadata behind.
 * @module @xmoon76/dsh-pi-tui/app/host/visual-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  chartArgsProblem,
  chartContentBlocks,
  chartFactFromArgs,
  type ChartArgs,
} from '../../domain/visual/chart.ts'
import { svgArgsProblem, svgContentBlocks, svgFactFromArgs, type SvgArgs } from '../../domain/visual/svg.ts'

/** Stable Cordis plugin name (the Loader row id in `cordis.patch.yml`). */
export const name = 'pi-tui-visual-tools'

/** The Host tool registry is this row's whole purpose. */
export const inject = ['tools']

/** The two stable, namespaced model tool names. */
export const CHART_TOOL_NAME = 'dsh_pi_tui_chart'
export const SVG_TOOL_NAME = 'dsh_pi_tui_svg'

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

/**
 * Register both resident tool definitions on the Host registry. The owning
 * fiber disposes them exactly once; nothing in the TUI mounts or unmounts them.
 *
 * `ctx.reflect.get` is the documented permanent-Host-plane idiom
 * (`docs/architecture/host-client.md`): this module IS the Host plane, so the
 * registry read is not Client-side coupling and the client-boundary inventory
 * stays unchanged. The explicit `inject` above guarantees the service.
 * @param ctx - the Host context that owns this row's fiber.
 */
export function apply(ctx: Context): void {
  const tools = ctx.reflect.get('tools') as ToolRuntime
  assertNameFree(tools, CHART_TOOL_NAME)
  assertNameFree(tools, SVG_TOOL_NAME)
  tools.register(chartTool())
  tools.register(svgTool())
}
