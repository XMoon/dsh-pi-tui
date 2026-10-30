/**
 * TSP-7 PR-C real-client subject: the composer action row in a real Tern pane.
 *
 * It mounts the PRODUCTION `mountTspRenderer` (the same factory the
 * composition root mounts), installs a read-only status reader through the
 * shipped `bindStatusReader`, and drives the shipped display seam. The
 * composer action row, the editor and the native statusline therefore come
 * from the production `dockView()`; this subject supplies only the
 * `StatusSnapshot` commits and records every business handler call on
 * `events.jsonl`, so the flow can read the REAL click results back as its
 * positive control.
 *
 * Subject cases (the run directory's `case` file or `TERN_TSP7_CASE`):
 *   idle      — the configured model facts, idle (the default)
 *   busy      — busy with the configured model facts (Stop appears)
 *   nomodel   — idle with NO model facts (the short-label rule)
 *   long      — a long display name (the clamp's witness)
 *
 * Usage: node --import tsx/esm scripts/tern-pane-composer-actions-subject.mts
 * @module scripts/tern-pane-composer-actions-subject
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
const caseFile = `${dir}/case`
const testCase = (existsSync(caseFile) ? readFileSync(caseFile, 'utf8').trim() : '')
  || process.env.TERN_TSP7_CASE || 'idle'

const session = await connect({ app: 'composer-actions', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
note({ caps: session.caps })

/** The business-handler record: the flow's positive control for every click. */
const calls = {
  submits: [] as Array<{ text: string; gesture: string }>,
  cancels: 0,
  modelEntries: [] as Array<'models' | 'effort'>,
}

let closing: Promise<void> | undefined
function shutdown(reason: string): Promise<void> {
  closing ??= (async () => {
    note({ closed: true, reason, calls })
    await renderer.dispose()
  })()
  return closing
}

const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  requestExit: () => { process.exitCode = 0; void shutdown('exit-requested') },
})

renderer.bindInput({
  exit: () => { void shutdown('exit') },
  cancel: () => { calls.cancels += 1; note({ cancel: calls.cancels }) },
  submit: (text, request) => {
    const gesture = typeof request === 'string' ? request : String(request)
    calls.submits.push({ text, gesture })
    note({ submit: { text, gesture } })
  },
  steer: (text) => { note({ steer: text }) },
  pasteMedia: () => { note({ pasteMedia: true }) },
  noteUserInput: () => {},
  listContinuedQuestions: () => [],
  reopenContinuedQuestion: () => false,
  openModelPicker: entry => {
    calls.modelEntries.push(entry)
    note({ modelEntry: entry })
    // The production wiring would run the registered `/model` handler; this
    // subject proves the SEAM (the click reached the command entry) and the
    // flow drives the picker layer itself through the presentation port.
    renderer.modelPresentation?.open({
      subject: { sessionless: true },
      entry,
      isCurrent: () => true,
      retry() {},
      apply: selection => { note({ apply: selection }); return 'rejected' },
      runOwned: (_label, task, options) => {
        void Promise.resolve().then(task).then(options.onResult, options.onError)
      },
    }).setDirectory({
      current: { provider: 'alpha', model: 'm-alpha', reasoningEffort: 'medium' },
      directory: {
        default: { provider: 'beta', model: 'm-beta' },
        routableProviders: ['alpha', 'beta'],
        groups: [
          {
            id: 'alpha',
            name: 'Alpha Provider',
            models: [{
              id: 'm-alpha',
              name: 'Alpha Model',
              reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
            }],
          },
          { id: 'beta', name: 'Beta Provider', models: [{ id: 'm-beta', name: 'Beta Model' }] },
        ],
        failures: [],
      },
    })
  },
})

/** One snapshot with the requested facts (the SHARED derive-free literal shape). */
const snapshotFor = (facts: {
  busy?: boolean
  model?: { displayName: string; id: string; reasoningEffort?: string }
}): StatusSnapshot => {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    composition: facts.model === undefined ? {} : { model: facts.model },
    activity: { ...base.activity, busy: facts.busy === true },
  } as StatusSnapshot
}

const MODEL = { displayName: 'luna-fast', id: 'luna-fast', reasoningEffort: 'high' }
const LONG = { displayName: 'an-extremely-long-model-display-name-for-the-clamp', id: 'long', reasoningEffort: 'high' }
const modelFor = (): { displayName: string; id: string; reasoningEffort?: string } | undefined =>
  testCase === 'nomodel' ? undefined : testCase === 'long' ? LONG : MODEL
let current: StatusSnapshot = snapshotFor({ busy: testCase === 'busy', model: modelFor() })

const commit = (label: string): void => {
  renderer.bindStatusReader({ snapshot: () => current })
  // The visible ready marker the flow waits for (the dock's session-title row).
  renderer.display.commitStatusFacts({ sessionTitle: `composer-actions ${label}` })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  note({ commit: label })
}
commit(testCase)

// The production renderer owns the ONE input loop of this session (started by
// `mountTspRenderer`); this subject never iterates the session itself. The
// flow drives the pane through the control channel (keys/clicks land in the
// renderer's loop) and each run's `case` file selects the INITIAL snapshot —
// exactly the one-case-per-run pattern of the PR-B statusline flow.
note({ inputLoop: 'renderer-owned', case: testCase })
await new Promise((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
