/**
 * TSP-7 PR-G real-client subject: the production Quiet Composer's combined
 * Model / Reasoning Effort quick menu.
 *
 * Mounts the production `mountTspRenderer` (the same entry the shipped TSP
 * renderer uses) inside a real Tern pane, with the composer chrome, the
 * combined trigger and the anchored quick menu rendered by the shipped view.
 * The panel is opened through `modelPresentation.openQuick` — the exact seam the
 * registered `/model` command uses for a live Session — and every directory
 * read, applied selection, retry and handoff is written to `events.jsonl` so
 * the flow can read back what really happened. The model-directory fixtures and
 * the write settlement are scripted here (a boundary stand-in, declared in the
 * record); the real command/Host writer chain is qualified by
 * `test/app/tern-tsp-model-quick-menu.test.ts` against the official Direct
 * composition, not by this subject.
 *
 * Cases (`case` file or TERN_TSP7_MQ_CASE):
 *   root       open the menu and hold it open (anchor + layout evidence)
 *   models     the Model page with an eleven-model directory (search + scroll)
 *   effort     the Effort page of a model that advertises candidates
 *   noeffort   a current model with NO reasoning metadata
 *   partial    one provider read failed beside the usable groups
 *   long       CJK + over-long model/provider names on a narrow pane
 *   write      a real selection: pending frame, then the committed settle
 *   reject     a refused write: the page stays and the panel restores
 *   full       the `All models & details…` handoff to the registered full entry
 *   keys       keyboard-only walk (no pointer input at all)
 *
 * Usage: node --import tsx/esm scripts/tern-pane-composer-model-quick-ux-subject.mts
 * @module scripts/tern-pane-composer-model-quick-ux-subject
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import { emptyStatusSnapshot, type StatusSnapshot } from '../src/domain/status/types.ts'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import type { ModelDirectoryDto } from '../src/runtime/catalog-port.ts'
import type { ModelPickerRequest } from '../src/app/command/model-presentation.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)
const caseFile = `${dir}/case`
const testCase = (existsSync(caseFile) ? readFileSync(caseFile, 'utf8').trim() : '')
  || process.env.TERN_TSP7_MQ_CASE || 'root'

const session = await connect({ app: 'composer-model-quick-ux', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
note({ caps: session.caps, case: testCase, standIn: 'scripted directory + scripted write settlement; the registered command owner is qualified by the automated Direct suite' })

/* ------------------------------------------------------------- fixtures */

const LONG_CJK = '供应商/超长深度求模模型变体-含推理档位-with-reasoning'
const ELEVEN = Array.from({ length: 11 }, (_, i) => ({
  id: `many-${i + 1}`,
  name: `Model Number ${String(i + 1).padStart(2, '0')}`,
}))

function directoryFor(name: string): ModelDirectoryDto {
  if (name === 'noeffort') {
    return {
      default: { provider: 'alpha', model: 'plain' },
      routableProviders: ['alpha'],
      groups: [{ id: 'alpha', name: 'Alpha Provider', models: [{ id: 'plain', name: 'Plain Model' }] }],
      failures: [],
    }
  }
  if (name === 'partial') {
    return {
      default: { provider: 'alpha', model: 'a-one' },
      routableProviders: ['alpha'],
      groups: [{
        id: 'alpha',
        name: 'Alpha Provider',
        models: [
          { id: 'a-one', name: 'Alpha One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
          { id: 'a-two', name: 'Alpha Two' },
        ],
      }],
      failures: [{ id: 'gamma', name: 'Gamma Provider', message: 'provider gamma is unreachable' }],
    }
  }
  if (name === 'long') {
    return {
      default: { provider: 'alpha', model: 'a-one' },
      routableProviders: ['alpha', 'beta'],
      groups: [
        {
          id: 'alpha',
          name: 'A very long advertised provider name that cannot fit either',
          models: [
            { id: 'a-one', name: LONG_CJK, reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '非常高' }], defaultEffort: 'low' } },
            { id: 'a-two', name: `${'W'.repeat(60)}-tail` },
          ],
        },
        { id: 'beta', name: 'Beta Provider', models: [{ id: 'b-one', name: 'Beta One' }] },
      ],
      failures: [],
    }
  }
  if (name === 'models') {
    return {
      default: { provider: 'alpha', model: 'many-01' },
      routableProviders: ['alpha', 'beta'],
      groups: [
        { id: 'alpha', name: 'Alpha Provider', models: ELEVEN.slice(0, 6) },
        { id: 'beta', name: 'Beta Provider', models: ELEVEN.slice(6) },
      ],
      failures: [],
    }
  }
  // A directory where a dozen providers failed to read: the failure count is
  // external data with no bound, and this case proves it can never push the
  // fixed Full entry out of the anchored menu in a short pane.
  if (name === 'manyfail') {
    return {
      default: { provider: 'alpha', model: 'a-one' },
      routableProviders: ['alpha', 'beta'],
      groups: [
        { id: 'alpha', name: 'Alpha Provider', models: [{ id: 'a-one', name: 'Alpha One' }] },
        { id: 'beta', name: 'Beta Provider', models: [{ id: 'b-one', name: 'Beta One' }] },
      ],
      failures: Array.from({ length: 12 }, (_unused, index) => ({
        id: `down-${index}`,
        name: `Provider ${index}`,
        message: `provider down-${index} is unreachable`,
      })),
    }
  }
  // root / effort / write / reject / full / keys: the normal directory.
  return {
    default: { provider: 'beta', model: 'b-one' },
    routableProviders: ['alpha', 'beta'],
    groups: [
      {
        id: 'alpha',
        name: 'Alpha Provider',
        models: [
          { id: 'a-one', name: 'Alpha One', description: 'The current model.', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' } },
          { id: 'a-two', name: 'Alpha Two' },
        ],
      },
      { id: 'beta', name: 'Beta Provider', models: [{ id: 'b-one', name: 'Beta One' }] },
    ],
    failures: [],
  }
}

function currentFor(name: string): { provider: string; model: string; reasoningEffort?: string } {
  if (name === 'noeffort' || name === 'partial' || name === 'manyfail') return { provider: 'alpha', model: 'a-one' }
  if (name === 'long') return { provider: 'alpha', model: 'a-one', reasoningEffort: 'low' }
  if (name === 'models') return { provider: 'alpha', model: 'many-01' }
  return { provider: 'alpha', model: 'a-one', reasoningEffort: 'high' }
}

/** The advertised display name of a model id, from the fixture directory. */
function displayNameFor(id: string): string {
  for (const group of directory.groups) {
    const model = group.models.find(candidate => candidate.id === id)
    if (model !== undefined) return model.name
  }
  return id
}

function statusFor(name: string): StatusSnapshot {
  const base = emptyStatusSnapshot()
  const current = currentFor(name)
  const displayName = name === 'long' ? LONG_CJK : name === 'models' ? 'Model Number 01' : 'Alpha One'
  return {
    ...base,
    access: { permissionPreset: { id: 'workspace-write', label: 'Workspace Write', matched: true } },
    workspace: { cwd: '/workspaces/composer-model-quick', branch: 'pr-g-evidence' },
    composition: {
      model: {
        provider: current.provider,
        id: current.model,
        displayName,
        ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
      },
    },
    activity: { ...base.activity, phase: 'idle', busy: false },
  } as unknown as StatusSnapshot
}

let current = statusFor(testCase)
const directory = directoryFor(testCase)
const selection = currentFor(testCase)
const calls = {
  applies: [] as unknown[],
  retries: 0,
  fullEntries: [] as string[],
  quickOpens: 0,
  cancels: 0,
  submits: [] as string[],
  settled: [] as string[],
}

/* ------------------------------------------------------------- production mount */

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
  onFatal: (error) => { note({ fatal: String(error) }) },
})

const presentation = renderer.modelPresentation
if (presentation?.openQuick === undefined) throw new Error('the mounted renderer offers no quick presentation')

let handle: ReturnType<NonNullable<typeof presentation.openQuick>> | undefined
function openQuickPanel(): void {
  calls.quickOpens += 1
  const request: ModelPickerRequest = {
    subject: { sessionless: false },
    entry: 'models',
    isCurrent: () => true,
    retry: () => {
      calls.retries += 1
      note({ retry: calls.retries })
      handle?.setLoading()
      // The scripted read owner settles the retry one second later.
      setTimeout(() => {
        if (calls.retries > 0) handle?.setDirectory({ directory, current: selection })
      }, 1000)
    },
    apply: (next) => {
      calls.applies.push(next)
      note({ apply: next })
      // The settlement is a scripted Host outcome for THIS case, recorded on the
      // events file: `write` and `reject` stay pending long enough for the flow
      // to capture the pending frame and prove no second dispatch, then settle
      // committed / refused. A committed settle also pushes the new projection
      // (the stand-in below) so the flow can see the Composer relabel from the
      // authoritative value instead of from the clicked row.
      const outcome = testCase === 'reject' ? 'rejected' : 'committed'
      const delay = testCase === 'write' || testCase === 'reject' ? 2600 : 250
      return new Promise((resolve) => {
        setTimeout(() => {
          calls.settled.push(outcome)
          note({ settled: outcome })
          resolve(outcome as never)
          if (outcome === 'committed') {
            // A stand-in for the Host's pushed Session selection event: the
            // committed projection, never this panel's request, is what relabels
            // the Composer. Declared here so the record states what it is.
            note({ projectionStandIn: 'the Host selection push is simulated; the real durable write is qualified by the automated Direct suite' })
            current = {
              ...current,
              composition: {
                model: {
                  provider: next.provider,
                  id: next.model,
                  displayName: displayNameFor(next.model),
                  ...(next.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: next.reasoningEffort }),
                },
              },
            } as unknown as StatusSnapshot
            renderer.display.commitDisplaySubject({}, {}, undefined)
          }
        }, delay)
      })
    },
    runOwned: (label, task, options) => {
      void Promise.resolve()
        .then(task)
        .then((value) => options.onResult?.(value), (error) => options.onError?.(error))
    },
  }
  handle = presentation.openQuick!(request)
  note({ opened: calls.quickOpens })
  handle.setLoading()
  setTimeout(() => handle?.setDirectory({ directory, current: selection }), 150)
}

renderer.bindInput({
  exit() { void shutdown('exit') },
  cancel: () => { calls.cancels += 1; note({ cancels: calls.cancels }) },
  submit: (text, request) => { calls.submits.push(text); note({ submit: { text, gesture: String(request) } }) },
  steer: (text) => { note({ steer: text }) },
  pasteMedia: () => { note({ pasteMedia: true }) },
  noteUserInput: () => {},
  listContinuedQuestions: () => [],
  reopenContinuedQuestion: () => false,
  // The full-panel handoff: the SAME registered `/model` UI entry the typed
  // command uses. The quick menu never opens the catalogue by itself.
  openModelPicker: entry => { calls.fullEntries.push(entry); note({ fullEntry: entry }) },
  openModelQuick: () => { openQuickPanel() },
  modelPickerAvailable: () => true,
  permissionOptions: () => ['read-only', 'workspace-write', 'danger-full-access'],
  selectPermission: () => {},
})
renderer.bindStatusReader({ snapshot: () => current })
renderer.display.commitStatusFacts({ sessionTitle: `composer-model-quick-ux ${testCase}` })
renderer.display.commitDisplaySubject({}, {}, undefined)
note({ ready: true, case: testCase })

// The keys case opens the panel through the SAME entry the pointer uses, so the
// keyboard walk never depends on a synthetic panel or a pre-built node tree.
if (testCase === 'keys') setTimeout(() => openQuickPanel(), 600)

await new Promise<void>((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
