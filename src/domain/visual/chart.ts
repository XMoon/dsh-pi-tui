/**
 * The canonical chart fact, its strict parser, and its pure projections.
 *
 * The fact is the single durable truth: labels, order, values, unit, kind and
 * version. Every projection (human text, Unicode rows, TSP chart props) is
 * derived from this one value. A renderer never reads `tool/call.arguments`,
 * a cached drawing, or assistant text to reconstruct a chart.
 * @module @xmoon76/dsh-pi-tui/domain/visual/chart
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { eastAsianWidth } from 'get-east-asian-width'
import {
  CHART_MAX_INPUT_BYTES,
  CHART_MAX_LABEL_CODE_POINTS,
  CHART_MAX_POINTS,
  CHART_MAX_TITLE_CODE_POINTS,
  CHART_MAX_UNIT_CODE_POINTS,
  CHART_MIN_POINTS,
  VISUAL_FACT_PREFIX,
} from './constants.ts'

/** v1 chart kinds (heatmap is explicitly deferred). */
export type ChartKind = 'bars' | 'spark'

/** One labelled data point. */
export interface ChartPoint {
  readonly label: string
  readonly value: number
}

/** The canonical chart fact carried by the tool result's machine line. */
export interface ChartFact {
  readonly version: 1
  readonly type: 'chart'
  readonly kind: ChartKind
  readonly title: string
  readonly unit?: string
  readonly series: readonly ChartPoint[]
}

/** The structural projection the TSP mapper feeds to `ui.chart`. */
export interface ChartProjection {
  readonly kind: ChartKind
  readonly summary: string
  readonly series: readonly ChartPoint[]
}

/** The raw tool arguments, before the version/type envelope is added. */
export interface ChartArgs {
  readonly kind: ChartKind
  readonly title: string
  readonly unit?: string
  readonly series: readonly ChartPoint[]
}

const CHART_ARGS_KEYS = ['kind', 'title', 'unit', 'series'] as const
const CHART_FACT_KEYS = ['version', 'type', 'kind', 'title', 'unit', 'series'] as const
const CHART_POINT_KEYS = ['label', 'value'] as const
const CHART_KINDS: readonly ChartKind[] = ['bars', 'spark']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

/** Count Unicode code points, not UTF-16 units. */
export function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Display width in terminal cells (East Asian wide/fullwidth count double). */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += eastAsianWidth(char.codePointAt(0) ?? 0)
  }
  return width
}

/** Deterministic, locale-independent number text. */
export function formatChartNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}

/** Validate one chart point object and narrow it. */
function parsePoint(value: unknown): ChartPoint | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, CHART_POINT_KEYS)) return undefined
  const { label, value: pointValue } = value
  if (typeof label !== 'string' || label === '' || codePointLength(label) > CHART_MAX_LABEL_CODE_POINTS) return undefined
  if (typeof pointValue !== 'number' || !Number.isFinite(pointValue)) return undefined
  return { label, value: pointValue }
}

/** Validate the kind/title/unit/series core shared by args and the fact. */
function chartCoreProblem(kind: unknown, title: unknown, unit: unknown, series: unknown): string | undefined {
  if (typeof kind !== 'string' || !CHART_KINDS.includes(kind as ChartKind)) {
    return 'kind must be "bars" or "spark"'
  }
  if (typeof title !== 'string' || title.trim() === '' || codePointLength(title) > CHART_MAX_TITLE_CODE_POINTS) {
    return `title must be a non-empty string of at most ${CHART_MAX_TITLE_CODE_POINTS} Unicode code points`
  }
  if (unit !== undefined && (typeof unit !== 'string' || unit === '' || codePointLength(unit) > CHART_MAX_UNIT_CODE_POINTS)) {
    return `unit must be a non-empty string of at most ${CHART_MAX_UNIT_CODE_POINTS} Unicode code points`
  }
  if (!Array.isArray(series) || series.length < CHART_MIN_POINTS || series.length > CHART_MAX_POINTS) {
    return `series must contain between ${CHART_MIN_POINTS} and ${CHART_MAX_POINTS} points`
  }
  for (const [index, point] of series.entries()) {
    if (parsePoint(point) === undefined) {
      return `series[${index}] must be a finite number with a non-empty label of at most ${CHART_MAX_LABEL_CODE_POINTS} Unicode code points`
    }
  }
  return undefined
}

/** Validate model-supplied chart arguments, including the whole-input budget. */
export function chartArgsProblem(args: unknown): string | undefined {
  if (!isRecord(args) || !hasOnlyKeys(args, CHART_ARGS_KEYS)) return 'arguments must contain only kind, title, unit and series'
  const problem = chartCoreProblem(args.kind, args.title, args.unit, args.series)
  if (problem !== undefined) return problem
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > CHART_MAX_INPUT_BYTES) {
    return `chart input exceeds ${CHART_MAX_INPUT_BYTES} bytes`
  }
  return undefined
}

/** Build the canonical fact from already-validated arguments. */
export function chartFactFromArgs(args: ChartArgs): ChartFact {
  return {
    version: 1,
    type: 'chart',
    kind: args.kind,
    title: args.title,
    ...args.unit === undefined ? {} : { unit: args.unit },
    series: args.series.map(point => ({ label: point.label, value: point.value })),
  }
}

/** Strict parse of one durable machine-line fact. */
export function parseChartFact(value: unknown): ChartFact | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, CHART_FACT_KEYS)) return undefined
  if (value.version !== 1 || value.type !== 'chart') return undefined
  const problem = chartCoreProblem(value.kind, value.title, value.unit, value.series)
  if (problem !== undefined) return undefined
  const series: ChartPoint[] = []
  for (const raw of value.series as unknown[]) {
    const point = parsePoint(raw)
    if (point === undefined) return undefined
    series.push(point)
  }
  return {
    version: 1,
    type: 'chart',
    kind: value.kind as ChartKind,
    title: value.title as string,
    ...value.unit === undefined ? {} : { unit: value.unit as string },
    series,
  }
}

/** The unit suffix used after one value (never parsed back as a number). */
function valueText(fact: ChartFact, point: ChartPoint): string {
  const number = formatChartNumber(point.value)
  return fact.unit === undefined ? number : `${number} ${fact.unit}`
}

/** The per-point value rows shared by every renderer (no title duplication). */
export function chartValueRows(fact: ChartFact): string[] {
  return [
    ...fact.series.map(point => `${point.label}  ${valueText(fact, point)}`),
    `${fact.series.length} supplied value${fact.series.length === 1 ? '' : 's'}`,
  ]
}

/**
 * The durable, self-contained human text. It repeats the title because this
 * text is also what search, copy and Markdown export read without a card
 * header; the graphical card bodies use {@link chartValueRows} instead.
 */
export function chartHumanText(fact: ChartFact): string {
  const title = fact.unit === undefined ? fact.title : `${fact.title} (${fact.unit})`
  return [title, ...chartValueRows(fact)].join('\n')
}

/** The durable content blocks: readable text plus the versioned fact line. */
export function chartContentBlocks(fact: ChartFact): ContentBlock[] {
  return [
    { type: 'text', text: chartHumanText(fact) },
    { type: 'text', text: `${VISUAL_FACT_PREFIX}${JSON.stringify(fact)}` },
  ]
}

/** The TSP native chart projection (one summary, the same ordered series). */
export function chartProjection(fact: ChartFact): ChartProjection {
  const unit = fact.unit === undefined ? '' : ` (${fact.unit})`
  return {
    kind: fact.kind,
    summary: `${fact.title}${unit}`,
    series: fact.series.map(point => ({ label: point.label, value: point.value })),
  }
}

// ASCII-only sparkline levels: the design-language contract requires new
// glyphs to be ASCII or EAW narrow; the Block Elements are ambiguous width and
// would misalign a CJK terminal. The visual mock's block glyphs are illustrative.
const SPARK_LEVELS = ['.', ':', ';', '+', '*', '#', '%', '@'] as const

/** One sparkline row scaled across the series' own minimum and maximum. */
function sparkline(values: readonly number[]): string {
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (max === min) return '='.repeat(values.length)
  return values.map(value => {
    const ratio = (value - min) / (max - min)
    const index = Math.max(0, Math.min(SPARK_LEVELS.length - 1, Math.round(ratio * (SPARK_LEVELS.length - 1))))
    return SPARK_LEVELS[index] as string
  }).join('')
}

/** A bar for one value: magnitude only, with a leading minus sign for negatives. */
function bar(value: number, maxAbsolute: number, budget: number): string {
  if (budget <= 0 || maxAbsolute === 0) return ''
  const length = Math.max(value === 0 ? 1 : 0, Math.round(Math.abs(value) / maxAbsolute * budget))
  const glyphs = '#'.repeat(Math.max(0, length))
  return value < 0 ? `-${glyphs}` : glyphs
}

function padEndByWidth(text: string, width: number): string {
  return `${text}${' '.repeat(Math.max(0, width - displayWidth(text)))}`
}

/**
 * Width-safe decoration rows: ASCII bars (or a sparkline) are an enhancement,
 * while every label and exact value always appears in the plain list fallback.
 * @param fact - the canonical chart.
 * @param width - the available cells (the component's render width).
 * @param decorated - whether ASCII bars/sparkline decoration may be used.
 */
export function chartTextRows(fact: ChartFact, width: number, decorated = true): string[] {
  const safeWidth = Math.max(1, Math.floor(width))
  const values = fact.series.map(point => valueText(fact, point))
  const labelWidth = Math.max(...fact.series.map(point => displayWidth(point.label)))
  const valueWidth = Math.max(...values.map(text => displayWidth(text)))
  const rows: string[] = []
  if (decorated && fact.kind === 'spark' && safeWidth >= fact.series.length) {
    rows.push(sparkline(fact.series.map(point => point.value)))
  }
  const budget = Math.min(24, safeWidth - labelWidth - valueWidth - 6)
  const drawBars = decorated && fact.kind === 'bars' && budget >= 2
  const maxAbsolute = Math.max(...fact.series.map(point => Math.abs(point.value)))
  fact.series.forEach((point, index) => {
    const label = padEndByWidth(point.label, labelWidth)
    const value = values[index] as string
    rows.push(drawBars ? `${label}  ${padEndByWidth(bar(point.value, maxAbsolute, budget), budget)}  ${value}` : `${point.label}  ${value}`)
  })
  rows.push(`${fact.series.length} supplied value${fact.series.length === 1 ? '' : 's'}`)
  return rows
}
