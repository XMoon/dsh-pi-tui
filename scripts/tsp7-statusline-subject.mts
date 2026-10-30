/**
 * The TSP-7 PR-A real-client subject: the PRODUCTION TSP renderer in a real pane.
 *
 * It does NOT assemble a dock. It calls the shipped `mountTspRenderer` — the same
 * factory the composition root mounts on the TSP branch — installs a read-only
 * status reader through the shipped `bindStatusReader`, and then drives the
 * shipped display seam (`commitStatusFacts` + `commitDisplaySubject`). Every node
 * the client paints therefore comes from the production `dockView()` and the
 * production `nativeStatuslineRows()`; this subject supplies only the
 * `StatusSnapshot` that `SurfaceRuntime.commitStatus` would have written.
 *
 * `TERN_TSP7_CASE` selects the fixture:
 *   full      — every PR-A fact present
 *   notokens  — a Remote-style snapshot: `usage.tokens` absent, context present
 *   nocwd     — `cwdUnavailable`: the stated `Unavailable` word, no path
 *   empty     — no fact at all: NEITHER row may be mounted
 *   prb       — PR-B: the working run phase + the rich attention badge + the
 *               full statistics row (cache/TTFB/R5·All) — the rich case
 *   prb-attn  — PR-B: attention + context only (the statistics facts absent)
 *   prb-idle  — PR-B: environment + context only (no run phase, no badge)
 *
 * Usage: node --import tsx/esm scripts/tsp7-statusline-subject.mts
 * @module scripts/tsp7-statusline-subject
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'
import { deriveActivityStatus } from '../src/domain/status/derive-activity.ts'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
/**
 * The fixture case. The pane driver's `launch.sh` does NOT forward the driver
 * process's environment, so a flow that needs more than one case writes it into
 * the run directory's `case` file (the env var stays the single-subject path).
 */
const caseFile = `${dir}/case`
const testCase = (existsSync(caseFile) ? readFileSync(caseFile, 'utf8').trim() : '')
  || process.env.TERN_TSP7_CASE || 'full'

/** The fixture snapshots — the ONLY inputs this subject invents. */
function snapshotFor(name: string): StatusSnapshot {
  const base = emptyStatusSnapshot()
  if (name === 'empty') {
    return { ...base, usage: { ...base.usage, tokens: undefined } } as unknown as StatusSnapshot
  }
  if (name === 'notokens') {
    return {
      ...base,
      workspace: { cwd: '/workspaces/tsp7-pane', branch: 'pra-statusline' },
      access: { permissionPreset: { id: 'workspace-write' } },
      usage: { ...base.usage, tokens: undefined, context: { usedTokens: 250_000, windowTokens: 1_000_000, percent: 25 } },
    } as unknown as StatusSnapshot
  }
  if (name === 'nocwd') {
    return {
      ...base,
      workspace: { cwd: '', cwdUnavailable: true },
      access: { permissionPreset: { id: 'read-only' } },
      usage: { ...base.usage, tokens: { input: 114_000_000, output: 54_000, cacheRead: 0, cacheWrite: 0 } },
    } as unknown as StatusSnapshot
  }
  // ── PR-B: the rich activity projection ──
  // The activity section is built by the SHARED derive (the same one the surface
  // uses), never by a hand-written literal: the phase precedence and the field
  // set stay the product's.
  if (name === 'prb' || name === 'prb-attn' || name === 'prb-idle') {
    const rich = name === 'prb'
    return {
      ...base,
      workspace: { cwd: '/workspaces/tsp7-pane', branch: 'pra-statusline' },
      access: { permissionPreset: { id: 'workspace-write' } },
      collaboration: { plan: { effective: true } },
      activity: deriveActivityStatus(
        name === 'prb-idle'
          ? { working: false, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false }
          : { working: true, compacting: false, applyingCompaction: false, approvalOpen: false, questionOpen: false },
        // `busy` is the machine-behavior fact, published alongside the phase.
        name !== 'prb-idle',
        // prb-idle is the REAL no-work state (RFL-004): every attention count is
        // zero, so the badge item must omit itself — a fixture that kept the
        // rich counts would make the "no badge" assertion undiscriminating.
        name === 'prb-idle'
          ? { queuedCount: 0, taskCount: 0, childAgentCount: 0, todoCount: 0 }
          : {
              queuedCount: 0,
              taskCount: 2,
              childAgentCount: 1,
              taskTotalCount: 4,
              childAgentTotalCount: 3,
              failedTaskCount: 1,
              questionAttentionCount: 1,
              todoCount: 0,
            },
      ),
      usage: {
        ...base.usage,
        ...rich ? { tokens: { input: 114_000_000, output: 54_000, cacheRead: 0, cacheWrite: 0 } } : { tokens: undefined },
        ...rich ? { cacheHitPct: 91.9 } : {},
        ...rich
          ? { performance: { llmMs: 0, firstTokenMs: 2_600, tokensPerSec: 116, sessionTokensPerSec: 44 } }
          : {},
        context: { usedTokens: 250_000, windowTokens: 1_000_000, percent: 25 },
      },
    } as unknown as StatusSnapshot
  }
  return {
    ...base,
    workspace: { cwd: '/workspaces/tsp7-pane', branch: 'pra-statusline' },
    access: { permissionPreset: { id: 'workspace-write' } },
    collaboration: { plan: { effective: true } },
    usage: {
      ...base.usage,
      tokens: { input: 114_000_000, output: 54_000, cacheRead: 0, cacheWrite: 0 },
      context: { usedTokens: 250_000, windowTokens: 1_000_000, percent: 25 },
    },
  } as unknown as StatusSnapshot
}

const session = await connect({ app: 'tsp7-statusline', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')

/** ONE shutdown latch: the renderer's exit intent and the run's signal share it. */
let closing: Promise<void> | undefined
function shutdown(reason: string): Promise<void> {
  closing ??= (async () => {
    note({ closed: true, reason })
    await renderer.dispose()
  })()
  return closing
}

// The PRODUCTION renderer factory: one inline surface, the production dock.
const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  // The production exit intent (the renderer routes its own quit keys here).
  requestExit: () => { process.exitCode = 0; shutdown('exit-requested') },
})

const current = snapshotFor(testCase)
// The production read-only port, installed the same way the mount installs it.
renderer.bindStatusReader({ snapshot: () => current })
// The production display seam: the legacy facts line + the ONE display commit
// that samples the reader and repaints the dock.
renderer.display.commitStatusFacts({ sessionTitle: `tsp7 ${testCase}` })
renderer.display.commitDisplaySubject({}, {}, undefined)
note({ ready: true, case: testCase })

// The production renderer owns the ONE input loop of this session — it was
// started by `mountTspRenderer`. This subject therefore never iterates the
// session itself: a second `for await` would be a NON-production input consumer
// and would make any input-related claim about this run invalid. The process
// simply stays alive (the renderer's loop drives everything) until the flow ends
// the run; the driver closes the pane and the SDK session.
note({ inputLoop: 'renderer-owned' })
await new Promise((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
