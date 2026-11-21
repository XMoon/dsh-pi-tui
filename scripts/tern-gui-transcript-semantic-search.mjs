/**
 * T3-B1: the REAL GUI lane for the loaded-session semantic search.
 *
 * It is the SAME journey as `scripts/tern-pane-transcript-semantic-search.mjs`,
 * run against ONE real native Tern window instead of the headless `tern serve`
 * pane: real window geometry, real appearance switching and real client painting.
 * Every gesture is still control-INJECTED input, so the evidence tier is
 * `REAL_TERN_GUI + CONTROL_INJECTED_INPUT` — never OS physical input.
 *
 *   TERN_BIN=… TERN_GUI_SEARCH_PRESET=full DISPLAY=:0 \
 *     node scripts/tern-gui-drive.mjs scripts/tern-gui-transcript-semantic-search.mjs
 *
 * A real display is REQUIRED. Without one this lane reports `NOT_RUN` (headless
 * output must never stand in for a GUI claim).
 * @module scripts/tern-gui-transcript-semantic-search
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PRESETS = ['full', 'compact', 'focus']

export function presetFromGuiEnvironment(value = process.env.TERN_GUI_SEARCH_PRESET ?? process.env.TERN_TRANSCRIPT_SEARCH_PRESET) {
  const preset = value ?? 'full'
  if (!PRESETS.includes(preset)) {
    throw new Error(`TERN_GUI_SEARCH_PRESET must be full, compact or focus; got ${preset}`)
  }
  return preset
}

const readJsonl = path => (existsSync(path)
  ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [])

export default async function (h) {
  const preset = presetFromGuiEnvironment()
  // The GUI lane REQUIRES a real display. The system reply is the client's own
  // fact, so this is a measurement of the environment, not a guess.
  const system = h.ctl('system')
  const hasDisplay = (system.displays ?? []).length > 0 && typeof system.title === 'string'
  h.check('the GUI lane runs against a REAL native window on a REAL display', hasDisplay,
    JSON.stringify({ title: system.title, displays: system.displays, DISPLAY: process.env.DISPLAY ?? null }))
  if (!hasDisplay) {
    // A display-less host is a NOT_RUN, never a headless substitute.
    h.check('the GUI evidence is unavailable on this host (NOT_RUN)', false,
      'no native display: run this lane on a real GUI session or report GUI=NOT_RUN')
    return h.finish({ qualification: 'NOT_RUN_NO_DISPLAY' })
  }

  // The journey module is the SAME flow; the only differences are the driver
  // (real window) and the appearance switch (`plugins run appearance:*`).
  const flowPath = join(h.repo, 'scripts', 'tern-pane-transcript-semantic-search.mjs')
  const flow = await import(flowPath)
  process.env.TERN_SEARCH_GUI = '1'
  process.env.TERN_TRANSCRIPT_SEARCH_PRESET = preset
  try {
    await flow.default(h)
  } finally {
    delete process.env.TERN_SEARCH_GUI
  }
  h.measure('the GUI journey reuses the headless flow module (one journey, two drivers)',
    JSON.stringify({ flowPath, preset }))
}
