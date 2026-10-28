/**
 * Shared vocabulary for the two PR-D visual facts.
 *
 * PR-D's revised data contract (2026-10-23 Owner decision) deliberately does
 * NOT use DSH `output.presentationMeta`: a content-only `tools/post-execute`
 * replacement keeps the original durable meta, and pinned DSH has no supported
 * seam to clear it. The FINAL durable `tool/result` content is therefore the
 * only admission source for a chart or an SVG drawing.
 *
 * A visual fact rides in its own TEXT content block with this versioned prefix;
 * the human-readable text stays a separate content block. Both renderers parse
 * the SAME fact, and a policy replacement that removes the machine line removes
 * the drawing along with it.
 * @module @xmoon76/dsh-pi-tui/domain/visual/constants
 */

/** Prefix of the versioned machine-readable visual fact line. */
export const VISUAL_FACT_PREFIX = 'visual-v1:'

/** Chart product limits (v1). */
export const CHART_MIN_POINTS = 2
export const CHART_MAX_POINTS = 12
export const CHART_MAX_TITLE_CODE_POINTS = 100
export const CHART_MAX_UNIT_CODE_POINTS = 32
export const CHART_MAX_LABEL_CODE_POINTS = 48
/** Whole chart input budget, separate from the per-field limits. */
export const CHART_MAX_INPUT_BYTES = 16 * 1024

/** SVG product limits (v1). The client's own native-SVG gate is ~256 KiB. */
export const SVG_MAX_SOURCE_BYTES = 128 * 1024
export const SVG_MAX_TITLE_CODE_POINTS = 100
export const SVG_MAX_DESCRIPTION_CODE_POINTS = 500

/** The SVG raster budget (v1; deployment policy, not a safety proof). */
export const SVG_MAX_RASTER_SIDE = 2048
export const SVG_MAX_RASTER_PIXELS = 4_000_000
export const SVG_MAX_PNG_BYTES = 4 * 1024 * 1024

/** The maximum time one isolated raster child may run. */
export const SVG_RASTER_TIMEOUT_MS = 3_000
