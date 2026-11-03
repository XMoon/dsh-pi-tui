/**
 * TSP-7 PR-D real-client subject: the configured native footer in a real pane.
 *
 * It mounts the PRODUCTION `mountTspRenderer` and drives the footer
 * projection through the SHIPPED `bindNativeFooterConfig` — the exact
 * production seam the composition root installs. The status rows therefore
 * come from the production `dockView()` + `nativeStatuslineRows(presentation)`;
 * this subject supplies only a trusted `TspNativeFooterConfig` synthesis (the
 * RENDERER lane: it proves the renderer's config projection, not a Host
 * settings E2E — the Direct chain test owns that tier).
 *
 * Cases (`TERN_TSP7_PRD_CASE` / the run dir's `case` file):
 *   default           — the frozen PR-A/B two-row shape (no config needed)
 *   compact           — the fixed TSP single row, busy facts
 *   custom-builtin    — a custom layout over builtin ids (model + branch +
 *                       context + latency/speed duplicates)
 *   custom-text       — a USER text item beside builtins
 *   custom-unavailable — a USER command item + an ext item + an unknown id:
 *                       the visible `Unavailable` markers + the merged notice
 *   command-fallback  — whole-footer command: the persisted compact fallback
 *                       + the one command notice
 *
 * Usage: node --import tsx/esm scripts/tern-pane-footer-config-subject.mts
 * @module scripts/tern-pane-footer-config-subject
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'
import { resolveTspNativeFooterConfig } from '../src/domain/footer/tsp-native-config.ts'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
const caseFile = `${dir}/case`
const testCase = (existsSync(caseFile) ? readFileSync(caseFile, 'utf8').trim() : '')
  || process.env.TERN_TSP7_PRD_CASE || 'default'

const session = await connect({ app: 'footer-config', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
note({ caps: session.caps })

let closing: Promise<void> | undefined
function shutdown(reason: string): Promise<void> {
  closing ??= (async () => {
    note({ closed: true, reason })
    await renderer.dispose()
  })()
  return closing
}

const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  requestExit: () => { process.exitCode = 0; void shutdown('exit-requested') },
})

/** The rich fact snapshot every configured case commits. */
function richSnapshot(): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    access: { permissionPreset: { id: 'workspace-write' } },
    workspace: { cwd: '/workspaces/footer-config', branch: 'prd-evidence' },
    collaboration: { plan: { effective: true } },
    composition: { model: { provider: 'deepseek', id: 'luna-fast', displayName: 'luna-fast', reasoningEffort: 'high' } },
    activity: { ...base.activity, busy: true, phase: 'working', taskCount: 2, taskTotalCount: 3, childAgentCount: 1, childAgentTotalCount: 2 },
    usage: {
      ...base.usage,
      tokens: { input: 114_000_000, output: 54_000, cacheRead: 0, cacheWrite: 0 },
      context: { usedTokens: 720_000, windowTokens: 1_000_000, percent: 72 },
      performance: { llmMs: 0, firstTokenMs: 2_600, tokensPerSec: 116, sessionTokensPerSec: 44 },
    },
  } as unknown as StatusSnapshot
}

/** The trusted config synthesis per case (the RENDERER-lane input). */
function configFor(name: string) {
  const userText = [{ schemaVersion: 1 as const, id: 'user:environment', kind: 'text' as const, text: 'prod-cluster' }]
  const userCommand = [{ schemaVersion: 1 as const, id: 'user:clock', kind: 'command' as const, command: 'date', refreshIntervalMs: 5000 }]
  switch (name) {
    case 'compact':
      return resolveTspNativeFooterConfig({ doc: { footer: 'compact' }, readiness: 'ready', userItems: { items: [], invalidCount: 0 } })
    case 'custom-builtin':
      return resolveTspNativeFooterConfig({
        doc: {
          footer: 'custom',
          footerLayout: {
            schemaVersion: 1,
            rows: [
              {
                left: [{ id: 'model', format: 'compact', importance: 90 }, { id: 'git-branch', format: 'label', prefix: 'branch:', importance: 20 }],
                right: [{ id: 'context', format: 'percent', importance: 100 }],
              },
              { left: [{ id: 'performance', format: 'latency', importance: 40 }, { id: 'performance', format: 'speed-both', importance: 45 }], right: [] },
            ],
          },
        },
        readiness: 'ready',
        userItems: { items: [], invalidCount: 0 },
      })
    case 'custom-text':
      return resolveTspNativeFooterConfig({
        doc: {
          footer: 'custom',
          footerLayout: {
            schemaVersion: 1,
            rows: [{ left: [{ id: 'user:environment' }, { id: 'cwd' }], right: [{ id: 'context', format: 'percent' }] }],
          },
        },
        readiness: 'ready',
        userItems: { items: userText, invalidCount: 0 },
      })
    case 'custom-unavailable':
      return resolveTspNativeFooterConfig({
        doc: {
          footer: 'custom',
          footerLayout: {
            schemaVersion: 1,
            rows: [{
              left: [{ id: 'user:clock', importance: 70 }, { id: 'ext:*' }, { id: 'ext:acme/uptime' }, { id: 'no-such-item' }],
              right: [{ id: 'context', format: 'percent' }],
            }],
          },
        },
        readiness: 'ready',
        userItems: { items: userCommand, invalidCount: 0 },
      })
    case 'command-fallback':
      return resolveTspNativeFooterConfig({ doc: { footer: 'command', footerFallbackMode: 'compact' }, readiness: 'ready', userItems: { items: [], invalidCount: 0 } })
    default:
      return resolveTspNativeFooterConfig({ doc: { footer: 'default' }, readiness: 'ready', userItems: { items: [], invalidCount: 0 } })
  }
}

const current = richSnapshot()
renderer.bindStatusReader({ snapshot: () => current })
// The production footer seam, in the mount's own order (reader → footer →
// the first display commit), exactly as renderer-selection mounts it.
renderer.bindNativeFooterConfig(configFor(testCase))
renderer.display.commitStatusFacts({ sessionTitle: `footer-config ${testCase}` })
renderer.display.commitDisplaySubject({}, {}, undefined)
note({ ready: true, case: testCase })

note({ inputLoop: 'renderer-owned', case: testCase })
await new Promise((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
