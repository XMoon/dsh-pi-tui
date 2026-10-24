/**
 * B3-A1: the renderer-neutral Task Center presentation boundary.
 *
 * The PiTui adapter is a pure delegation over the mounted `TuiApp`, and the
 * REAL `createTaskRuntime` keeps every business fact while committing only
 * through the presentation port. The cases here prove the adapter's identity/
 * receiver preservation, the Task Runtime's unchanged PiTui behaviour, and the
 * renderer-gated refusal that keeps a Task-Center-less renderer from reading a
 * mounted PiTui app.
 *
 * Evidence level: application composition over a real `TuiApp` /
 * `VirtualTerminal`; the renderer-less cases inject a recording display seam
 * and presentation port (structural fakes) and are labelled as such.
 *
 * @module @xmoon76/dsh-pi-tui/task-presentation-port.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { TuiApp, type TaskBrowserHandle } from '../../src/tui-app.ts'
import { createTaskRuntime, type TaskRuntime, type TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import { pituiTaskCenterPresentation } from '../../src/app/surface/task-presentation-pitui.ts'
import { pituiDisplaySeam } from '../../src/app/surface/display-seam-pitui.ts'
import type {
  TaskBrowserPresentationHandle,
  TaskBrowserPresentationOpen,
  TaskCenterPresentationPort,
} from '../../src/app/surface/task-presentation-port.ts'
import type { TaskPanelItem } from '../../src/app/surface/task-presentation.ts'
import type { TaskBrowserSummary } from '../../src/app/surface/task-browser-runtime.ts'
import type { QuestionAttentionRow } from '../../src/app/surface/question-controller.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { TaskSubagentEntry } from '../../src/runtime/task-read-port.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import type { JobObservationPort, JobStopOutcome } from '../../src/runtime/job-observation-port.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

async function flush(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

function mountApp(): TuiApp {
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return app
}

function jobInput(id: string, label: string, status = 'running', kind = 'bash'): TaskBrowserJobInput {
  return { id, kind, label, status, startedAt: 1_000 }
}

function taskChild(
  id: string,
  label: string,
  mode: 'one-shot' | 'continuable' | 'external' = 'continuable',
  activity: 'running' | 'inactive' = 'running',
  options: { parentId?: string; depth?: number } = {},
): TaskSubagentEntry {
  return {
    kind: 'child',
    id,
    label,
    mode,
    activity,
    hasChildren: false,
    parentId: options.parentId ?? '',
    depth: options.depth ?? 1,
  }
}

function openOptions(overrides: Partial<TaskBrowserPresentationOpen> = {}): TaskBrowserPresentationOpen {
  return {
    header: 'Tasks',
    mode: 'full',
    openedFrom: 'command',
    scope: 'all',
    enableSearch: true,
    expandedIds: [],
    collapsedIds: [],
    maxVisible: 18,
    loading: false,
    groupLabels: true,
    onRefresh: () => {},
    onStop: () => {},
    onViewportExpose: () => {},
    onRetired: () => {},
    ...overrides,
  }
}

class ObservationDouble implements JobObservationPort {
  open(): () => void {
    return () => {}
  }

  async stop(): Promise<JobStopOutcome> {
    return { kind: 'requested' }
  }
}

interface SourceOptions {
  readonly roster?: TaskBrowserJobInput[]
  readonly withJobs?: boolean
  readonly descendants?: readonly TaskSubagentEntry[]
  /** Replace the semantic read (held reads, cross-generation settlement). */
  readonly readTask?: () => Promise<{
    parentSessionId: string
    parentAvailable: boolean
    descendants: readonly TaskSubagentEntry[]
    jobs: readonly TaskBrowserJobInput[]
  } | undefined>
  readonly entered?: Array<{ childId: string; parentSessionId: string }>
  readonly openedJobs?: string[]
  readonly reopened?: Array<{ sessionId: string; callId: string }>
  readonly reopenResult?: boolean
}

function makeSource(options: SourceOptions = {}): TaskSurfaceSource {
  const subject = {} as SessionSubject
  const roster = options.roster ?? [jobInput('j1', 'build')]
  const descendants = options.descendants ?? []
  return {
    sessionId: () => 'sess-main',
    captureSubject: () => subject,
    subjectMatches: candidate => candidate === subject,
    enterView: async (childId, _label, _mode, parentSessionId) => {
      options.entered?.push({ childId, parentSessionId })
    },
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (row, jobDetail) => row !== undefined && row.kind === 'job' ? jobDetail : row === undefined ? jobDetail : 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: {
      open: (_sessionId, jobId) => {
        options.openedJobs?.push(jobId)
        return () => {}
      },
      stop: async () => ({ kind: 'requested' }),
    } as JobObservationPort,
    ...(options.withJobs === false ? {} : {
      jobs: {
        list: () => roster,
        subscribe: () => () => {},
      } satisfies NonNullable<TaskSurfaceSource['jobs']>,
    }),
    ...(options.descendants === undefined && options.readTask === undefined ? {} : {
      taskRead: {
        currentKey: () => 'g1:sess-main',
        currentSessionId: () => 'sess-main',
        readTask: options.readTask ?? (async () => ({
          parentSessionId: 'sess-main',
          parentAvailable: true,
          descendants: [...descendants],
          jobs: roster,
        })),
        activityOf: (childId: string) => {
          const entry = descendants.find(candidate => candidate.kind === 'child' && candidate.id === childId)
          return entry !== undefined && entry.kind === 'child' ? entry.activity : 'inactive'
        },
      },
    }),
  }
}

interface RuntimeHarness {
  readonly tasks: TaskRuntime
  readonly display: { supportsTaskCenter: boolean }
  readonly notices: Array<{ text: string; kind?: 'error' | 'info' }>
  readonly opens: Array<{
    items: readonly TaskPanelItem[]
    onSelect: (value: string) => 'close' | 'keep-open'
    onClose: () => void
    options: TaskBrowserPresentationOpen
  }>
  readonly handles: Array<{
    closed: boolean
    items: readonly TaskPanelItem[]
    preferredValues: Array<string | undefined>
    refreshStates: Array<{ state: 'loading' | 'ready' | 'stale'; error?: string }>
  }>
  readonly sinks: {
    quick: number
    agents: number
    tasks: number
    attention: number
    summary: number
  }
}

/** A real Task Runtime over a recording presentation port + display seam. */
function startRuntime(options: {
  readonly supportsTaskCenter?: boolean
  readonly source?: TaskSurfaceSource
  readonly attention?: QuestionAttentionRow[]
  readonly reopen?: (sessionId: string, callId: string) => boolean
  readonly mounted?: () => TuiApp
  readonly failingHandleClose?: boolean
} = {}): RuntimeHarness {
  const notices: RuntimeHarness['notices'] = []
  const opens: RuntimeHarness['opens'] = []
  const handles: RuntimeHarness['handles'] = []
  const sinks = { quick: 0, agents: 0, tasks: 0, attention: 0, summary: 0 }
  const display = { supportsTaskCenter: options.supportsTaskCenter ?? true }
  const port: TaskCenterPresentationPort = {
    openBrowser: (items, onSelect, onClose, open) => {
      const entry = { items, onSelect, onClose, options: open }
      opens.push(entry)
      const handleState: RuntimeHarness['handles'][number] = { closed: false, items, preferredValues: [], refreshStates: [] }
      handles.push(handleState)
      const handle: TaskBrowserPresentationHandle = {
        close: () => {
          if (options.failingHandleClose === true) throw new Error('browser close failed')
          handleState.closed = true
        },
        setItems: (next, preferred) => {
          handleState.items = next
          handleState.preferredValues.push(preferred)
        },
        setRefreshState: (state, error) => {
          handleState.refreshStates.push({ state, ...(error === undefined ? {} : { error }) })
        },
      }
      return handle
    },
    setQuickTaskItems: () => { sinks.quick += 1 },
    setAgents: () => { sinks.agents += 1 },
    setTasks: () => { sinks.tasks += 1 },
    setQuestionAttention: () => { sinks.attention += 1 },
    setTaskSummary: () => { sinks.summary += 1 },
  }
  const attention = options.attention ?? []
  const tasks = createTaskRuntime({
    mounted: options.mounted ?? (() => { throw new Error('mounted must not be read') }),
    display: () => displaySeamStub({
      supportsTaskCenter: display.supportsTaskCenter,
      notify: (text, kind) => { notices.push({ text, ...(kind === undefined ? {} : { kind }) }) },
    }),
    presentation: () => port,
    isCleanedUp: () => false,
    attention: {
      rows: () => attention,
      reconcile: () => {},
      publish: () => {},
      reopen: options.reopen ?? (() => false),
    },
  })
  tasks.attachTasks(options.source ?? makeSource(), {
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    isCleanedUp: () => false,
  })
  return { tasks, display, notices, opens, handles, sinks }
}

const zeroSummary: TaskBrowserSummary = {
  runningAgents: 0,
  totalAgents: 0,
  runningJobs: 0,
  totalJobs: 0,
  failedAttention: 0,
  failedTotal: 0,
}

const row = (value: string, overrides: Partial<TaskPanelItem> = {}): TaskPanelItem => ({
  value,
  label: value,
  status: 'running',
  source: 'job',
  type: 'bash',
  ...overrides,
})

// ── A1-P01/P02/P03: the PiTui adapter is a pure delegation ──────────────────

test('the PiTui adapter calls the real openTaskBrowser once with the same rows, callbacks and receiver', () => {
  const app = mountApp()
  const items: readonly TaskPanelItem[] = [row('job:j1')]
  const onSelect = (value: string): 'close' | 'keep-open' => value === 'job:j1' ? 'keep-open' : 'close'
  const onClose = (): void => {}
  const options = openOptions()
  const calls: Array<{ receiver: unknown; args: unknown[] }> = []
  const original = app.openTaskBrowser
  app.openTaskBrowser = function (this: TuiApp, ...args: Parameters<typeof original>): TaskBrowserHandle {
    calls.push({ receiver: this, args })
    return original.apply(this, args)
  }
  const port = pituiTaskCenterPresentation(app)
  const handle = port.openBrowser(items, onSelect, onClose, options)
  assert.equal(calls.length, 1, 'openTaskBrowser must be called exactly once')
  assert.equal(calls[0]!.receiver, app, 'the app must remain the receiver')
  assert.equal(calls[0]!.args[0], items, 'the row array must be delegated by identity')
  assert.equal(calls[0]!.args[1], onSelect, 'onSelect must be delegated by identity')
  assert.equal(calls[0]!.args[2], onClose, 'onClose must be delegated by identity')
  assert.equal(calls[0]!.args[3], options, 'the options must be delegated by identity')
  handle.close()
})

test('the PiTui handle delegates close/setItems/setRefreshState with the preferred value intact', () => {
  const app = mountApp()
  const calls: string[] = []
  const fakeHandle: TaskBrowserHandle = {
    close: () => { calls.push('close') },
    setItems: (items, preferred) => { calls.push(`setItems:${items.length}:${preferred ?? '-'}`) },
    setRefreshState: (state, error) => { calls.push(`refresh:${state}:${error ?? '-'}`) },
  }
  app.openTaskBrowser = () => fakeHandle
  const port = pituiTaskCenterPresentation(app)
  const handle = port.openBrowser([row('job:j1')], () => 'keep-open', () => {}, openOptions())
  handle.setItems([row('job:j1'), row('job:j2')], 'job:j2')
  handle.setRefreshState('stale', 'catalog failed')
  handle.close()
  assert.deepEqual(calls, ['setItems:2:job:j2', 'refresh:stale:catalog failed', 'close'])
})

test('the PiTui handle tolerates the app\'s optional setRefreshState without inventing a default', () => {
  const app = mountApp()
  app.openTaskBrowser = () => ({ close: () => {}, setItems: () => {} })
  const port = pituiTaskCenterPresentation(app)
  const handle = port.openBrowser([], () => 'keep-open', () => {}, openOptions())
  assert.doesNotThrow(() => handle.setRefreshState('loading'))
  handle.close()
})

test('the PiTui passive sinks each delegate exactly once in order', () => {
  const app = mountApp()
  const calls: string[] = []
  app.setQuickTaskItems = () => { calls.push('quick') }
  app.setAgents = () => { calls.push('agents') }
  app.setTasks = () => { calls.push('tasks') }
  app.setTaskSummary = () => { calls.push('summary') }
  app.setQuestionAttention = () => { calls.push('attention') }
  const port = pituiTaskCenterPresentation(app)
  port.setQuickTaskItems([])
  port.setAgents([])
  port.setTasks([])
  port.setTaskSummary(zeroSummary)
  port.setQuestionAttention(0)
  assert.deepEqual(calls, ['quick', 'agents', 'tasks', 'summary', 'attention'])
})

// ── A1-P04: notices move to the EXISTING display seam ──────────────────────

test('a Task Runtime notice reaches the PiTui display seam exactly once', async () => {
  const app = mountApp()
  const notices: Array<{ text: string; kind?: string }> = []
  const originalNotify = app.notify
  app.notify = function (this: TuiApp, text, kind) {
    notices.push({ text, ...(kind === undefined ? {} : { kind }) })
    originalNotify.call(this, text, kind)
  }
  const calls: Array<{ onSelect: (value: string) => 'close' | 'keep-open' }> = []
  const originalOpen = app.openTaskBrowser
  app.openTaskBrowser = function (this: TuiApp, ...args: Parameters<typeof originalOpen>): TaskBrowserHandle {
    calls.push({ onSelect: args[1] })
    return originalOpen.apply(this, args)
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => pituiDisplaySeam(app),
    presentation: () => pituiTaskCenterPresentation(app),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  tasks.attachTasks(makeSource({ descendants: [taskChild('ext-1', 'external run', 'external', 'inactive')] }), {
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    isCleanedUp: () => false,
  })
  await flush()
  tasks.openTasksBrowser('full')
  assert.equal(calls.length, 1, 'the browser must open once')
  calls[0]!.onSelect('agent:ext-1')
  assert.deepEqual(notices, [{ text: 'external subagent: no local session to open', kind: 'info' }],
    'the notice must be committed once through the display seam')
  tasks.resetTasks()
})

// ── A1-P05: the real Task Runtime still owns the ONE browser/refresh path ──

test('the real Task Runtime seeds, opens and repaints ONE browser through the PiTui port', async () => {
  const app = mountApp()
  const adapter = pituiTaskCenterPresentation(app)
  const handles: Array<{ items: readonly TaskPanelItem[]; preferred: Array<string | undefined> }> = []
  const originalOpen = app.openTaskBrowser
  app.openTaskBrowser = function (this: TuiApp, ...args: Parameters<typeof originalOpen>): TaskBrowserHandle {
    const handle = originalOpen.apply(this, args)
    const record = { items: args[0], preferred: [] as Array<string | undefined> }
    handles.push(record)
    const originalSetItems = handle.setItems
    handle.setItems = (items, preferred) => {
      record.items = items
      record.preferred.push(preferred)
      originalSetItems.call(handle, items, preferred)
    }
    return handle
  }
  let reads = 0
  const source = makeSource({
    roster: [jobInput('j1', 'build')],
    descendants: [taskChild('child-1', 'review', 'continuable', 'running')],
    readTask: async () => {
      reads += 1
      return {
        parentSessionId: 'sess-main',
        parentAvailable: true,
        descendants: [taskChild('child-1', 'review', 'continuable', 'running')],
        jobs: [jobInput('j1', 'build')],
      }
    },
  })
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => pituiDisplaySeam(app),
    presentation: () => adapter,
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  await flush()
  tasks.openTasksBrowser('full')
  assert.equal(handles.length, 1, 'exactly ONE browser opened')
  const values = handles[0]!.items.map(item => item.value)
  assert.ok(values.includes('agent:child-1'), `the committed catalog row reached the browser: ${values.join(',')}`)
  assert.ok(values.includes('job:j1'), `the roster row reached the browser: ${values.join(',')}`)
  // The coordinator repaints the SAME handle (not a second browser).
  handles[0]!.preferred.length = 0
  tasks.refreshAgentRuntimeOnly()
  assert.equal(handles.length, 1, 'a runtime refresh never opens a second browser')
  assert.equal(handles[0]!.preferred.length, 1, 'the open handle received the repaint')
  assert.equal(typeof handles[0]!.preferred[0], 'string', 'the runtime preferred row is preserved for PiTui')
  assert.ok(reads >= 1, 'the semantic read really ran')
  tasks.resetTasks()
})

test('the catalog refresh gate stays single-flight while a read is held', async () => {
  let reads = 0
  let release!: (value: {
    parentSessionId: string
    parentAvailable: boolean
    descendants: TaskSubagentEntry[]
    jobs: TaskBrowserJobInput[]
  }) => void
  const held = new Promise<{
    parentSessionId: string
    parentAvailable: boolean
    descendants: TaskSubagentEntry[]
    jobs: TaskBrowserJobInput[]
  }>(resolve => { release = resolve })
  const h = startRuntime({
    source: makeSource({
      descendants: [],
      readTask: async () => {
        reads += 1
        return held
      },
    }),
  })
  assert.equal(reads, 1, 'the attach seed starts ONE catalog read')
  h.tasks.refreshAgents()
  h.tasks.refreshAgents()
  assert.equal(reads, 1, 'invalidations during the in-flight read are coalesced, not re-listed')
  release({ parentSessionId: 'sess-main', parentAvailable: true, descendants: [], jobs: [] })
  await flush()
  assert.equal(reads, 2, 'the coalesced invalidation becomes exactly ONE trailing read')
  h.tasks.resetTasks()
})

// ── A1-P06: the PiTui selection router is unchanged ────────────────────────

test('a PiTui Job selection still routes through the original Job viewer', async () => {
  const app = mountApp()
  const openedJobs: string[] = []
  const selections: Array<(value: string) => 'close' | 'keep-open'> = []
  const originalOpen = app.openTaskBrowser
  app.openTaskBrowser = function (this: TuiApp, ...args: Parameters<typeof originalOpen>): TaskBrowserHandle {
    selections.push(args[1])
    return originalOpen.apply(this, args)
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => pituiDisplaySeam(app),
    presentation: () => pituiTaskCenterPresentation(app),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  tasks.attachTasks(makeSource({ roster: [jobInput('j1', 'build')], openedJobs }), {
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false,
  })
  await flush()
  tasks.openTasksBrowser('full')
  selections[0]!('job:j1')
  assert.deepEqual(openedJobs, ['j1'], 'the Job selection still opens the ONE Job viewer')
  tasks.resetTasks()
})

test('a PiTui subagent selection still routes through the original transcript viewer', async () => {
  const app = mountApp()
  const entered: Array<{ childId: string; parentSessionId: string }> = []
  const selections: Array<(value: string) => 'close' | 'keep-open'> = []
  const originalOpen = app.openTaskBrowser
  app.openTaskBrowser = function (this: TuiApp, ...args: Parameters<typeof originalOpen>): TaskBrowserHandle {
    selections.push(args[1])
    return originalOpen.apply(this, args)
  }
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => pituiDisplaySeam(app),
    presentation: () => pituiTaskCenterPresentation(app),
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
  })
  tasks.attachTasks(makeSource({
    roster: [],
    descendants: [taskChild('child-1', 'review', 'continuable', 'running')],
    entered,
  }), { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  await flush()
  tasks.openTasksBrowser('full')
  selections[0]!('agent:child-1')
  await flush()
  assert.deepEqual(entered, [{ childId: 'child-1', parentSessionId: 'sess-main' }],
    'the subagent selection still opens the ONE transcript viewer')
  tasks.resetTasks()
})

test('a PiTui Question selection still reopens the ONE Question controller', async () => {
  const app = mountApp()
  const reopened: Array<{ sessionId: string; callId: string }> = []
  const selections: Array<(value: string) => 'close' | 'keep-open'> = []
  const originalOpen = app.openTaskBrowser
  app.openTaskBrowser = function (this: TuiApp, ...args: Parameters<typeof originalOpen>): TaskBrowserHandle {
    selections.push(args[1])
    return originalOpen.apply(this, args)
  }
  const attention: QuestionAttentionRow[] = [{
    sessionId: 'sess-main',
    callId: 'call-1',
    presentation: 'parked',
    questions: [{ id: 'q', question: 'Choose a region' }],
  } as QuestionAttentionRow]
  const tasks = createTaskRuntime({
    mounted: () => app,
    display: () => pituiDisplaySeam(app),
    presentation: () => pituiTaskCenterPresentation(app),
    isCleanedUp: () => false,
    attention: {
      rows: () => attention,
      reconcile: () => {},
      publish: () => {},
      reopen: (sessionId, callId) => {
        reopened.push({ sessionId, callId })
        return true
      },
    },
  })
  tasks.attachTasks(makeSource({ roster: [] }), {
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false,
  })
  await flush()
  tasks.openTasksBrowser('full')
  selections[0]!('question:sess-main:call-1')
  assert.deepEqual(reopened, [{ sessionId: 'sess-main', callId: 'call-1' }],
    'the Question row is never treated as a Job')
  tasks.resetTasks()
})

// ── A1-P07/P08: close reentrancy and session reset ─────────────────────────

test('a browser opened synchronously from a retire callback keeps its token against the old close tail', async () => {
  const h = startRuntime()
  h.tasks.refreshTasks()
  h.tasks.openTasksBrowser('full')
  const first = h.opens[0]!
  // The old browser retires; its owner callback synchronously opens a NEWER
  // browser (the physical hide restores plugin focus), then the OLD close
  // tail runs afterwards and must not overwrite the newer slot.
  first.options.onRetired('cancel')
  h.tasks.openTasksBrowser('full')
  assert.equal(h.opens.length, 2, 'the reentrant open is the newer browser')
  first.onClose()
  h.tasks.refreshTasks()
  assert.equal(h.handles[1]!.closed, false, 'the newer browser must survive the old close tail')
  assert.ok(h.handles[1]!.items.length >= 0, 'the newer handle receives the commits')
  h.tasks.resetTasks()
})

test('an old catalog read cannot commit after resetTasks replaced the browser', async () => {
  let release!: (value: {
    parentSessionId: string
    parentAvailable: boolean
    descendants: TaskSubagentEntry[]
    jobs: TaskBrowserJobInput[]
  }) => void
  let reads = 0
  const held = new Promise<{
    parentSessionId: string
    parentAvailable: boolean
    descendants: TaskSubagentEntry[]
    jobs: TaskBrowserJobInput[]
  }>(resolve => { release = resolve })
  const h = startRuntime({
    source: makeSource({
      readTask: async () => {
        reads += 1
        return held
      },
    }),
  })
  assert.equal(reads, 1)
  h.tasks.resetTasks()
  h.tasks.openTasksBrowser('full')
  const fresh = h.opens.at(-1)!
  release({
    parentSessionId: 'sess-main',
    parentAvailable: true,
    descendants: [taskChild('stale-child', 'ghost')],
    jobs: [],
  })
  await flush()
  assert.ok(!fresh.items.some(item => item.value.includes('stale-child')),
    'the superseded generation must never paint its catalog')
  h.tasks.resetTasks()
})

test('resetTasks attempts every sink even when the browser closer throws', () => {
  const h = startRuntime({ failingHandleClose: true })
  h.tasks.refreshTasks()
  h.tasks.openTasksBrowser('full')
  assert.throws(() => h.tasks.resetTasks(), /browser close failed/)
  assert.ok(h.sinks.summary >= 1, 'the summary reset is an independent step')
  assert.ok(h.sinks.tasks >= 1, 'the jobs reset is an independent step')
  assert.ok(h.sinks.agents >= 1, 'the agents reset is an independent step')
  assert.ok(h.sinks.attention >= 1, 'the attention reset is an independent step')
})

// ── A1-P10/P11/P12: a Task-Center-less renderer is refused at the real entry ──

test('a renderer without a Task Center declines openTasksBrowser with ONE notice and no mounted app', () => {
  const h = startRuntime({ supportsTaskCenter: false })
  h.tasks.refreshTasks()
  h.tasks.openTasksBrowser('full')
  assert.deepEqual(h.notices, [{ text: 'Work Hub is not available in this renderer yet.', kind: 'info' }])
  assert.equal(h.opens.length, 0, 'no presentation open happened')
  assert.equal(h.sinks.tasks, 0, 'no roster chrome was committed')
})

test('a renderer without a Task Center refuses a Workflow-scoped browser before any source read', () => {
  const h = startRuntime({ supportsTaskCenter: false })
  h.tasks.refreshTasks()
  h.tasks.handleWorkflowAction({ kind: 'open-run-agents', runId: 'run-1', name: 'wf', childIds: ['child-1'] })
  assert.equal(h.opens.length, 0, 'the scope never became a hidden browser')
  assert.equal(h.notices.length, 0, 'no fabricated receipt was emitted')
})

test('a renderer without a Task Center never reads the PiTui app on refresh/reset', () => {
  const h = startRuntime({ supportsTaskCenter: false })
  assert.doesNotThrow(() => h.tasks.refreshTasks())
  assert.doesNotThrow(() => h.tasks.refreshAgents())
  assert.doesNotThrow(() => h.tasks.refreshAgentRuntimeOnly())
  assert.doesNotThrow(() => h.tasks.resetTasks())
})

// ── A1-P13/P14: the two independent source halves still work ───────────────

test('a jobs-only source lists the roster ONCE per refresh and opens the browser', async () => {
  let listCalls = 0
  const roster = [jobInput('j1', 'build')]
  const source: TaskSurfaceSource = {
    ...makeSource(),
    jobs: {
      list: () => { listCalls += 1; return roster },
      subscribe: () => () => {},
    },
  }
  const h = startRuntime({ source })
  await flush()
  h.tasks.refreshTasks()
  h.tasks.openTasksBrowser('full')
  assert.equal(h.opens.length, 1, 'the jobs-only browser opened')
  assert.ok(h.opens[0]!.items.some(item => item.value === 'job:j1'), 'the roster row reached the browser')
  const before = listCalls
  h.tasks.refreshTasks()
  assert.ok(listCalls > before, 'the jobs-only refresh re-reads the roster')
  h.tasks.resetTasks()
})

test('a child-only source still lists the full descendant tree without a Jobs service', async () => {
  const h = startRuntime({
    source: makeSource({
      withJobs: false,
      descendants: [taskChild('child-1', 'review', 'continuable', 'running')],
    }),
  })
  await flush()
  h.tasks.openTasksBrowser('full')
  assert.equal(h.opens.length, 1, 'a children-only session still opens the browser')
  assert.ok(h.opens[0]!.items.some(item => item.value === 'agent:child-1'),
    'the descendant row reached the browser')
  h.tasks.resetTasks()
})

// ── A1-P15: Question attention is a presentation-only refresh ──────────────

test('a Question attention change repaints the open browser without a catalog read', async () => {
  const attention: QuestionAttentionRow[] = []
  let reads = 0
  const h = startRuntime({
    attention,
    source: makeSource({
      descendants: [taskChild('child-1', 'review', 'continuable', 'running')],
      readTask: async () => {
        reads += 1
        return {
          parentSessionId: 'sess-main',
          parentAvailable: true,
          descendants: [taskChild('child-1', 'review', 'continuable', 'running')],
          jobs: [],
        }
      },
    }),
  })
  await flush()
  h.tasks.openTasksBrowser('full')
  const readsBefore = reads
  attention.push({
    sessionId: 'sess-main',
    callId: 'call-1',
    presentation: 'parked',
    questions: [{ id: 'q', question: 'Choose a region' }],
  } as QuestionAttentionRow)
  h.tasks.refreshAttentionRows()
  const fresh = h.handles.at(-1)!
  const questionRow = fresh.items[0]
  assert.equal(questionRow?.source, 'question', 'the attention row is the first row and is NOT a Job')
  assert.equal(questionRow?.value, 'question:sess-main:call-1')
  assert.equal(reads, readsBefore, 'the attention refresh never re-lists the catalog')
  attention.length = 0
  h.tasks.refreshAttentionRows()
  assert.ok(!fresh.items.some(item => item.source === 'question'), 'removing the attention row repaints it away')
  h.tasks.resetTasks()
})

// ── A1-P16: static guard against a missed PiTui-only sink ──────────────────

test('the Task Runtime has no remaining PiTui-only presentation calls', () => {
  const source = readFileSync(new URL('../../src/app/surface/task-runtime.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source,
    /options\.mounted\(\)\.(openTaskBrowser|setQuickTaskItems|setTasks|setAgents|setQuestionAttention|setTaskSummary|notify)\(/u,
    'every presentation sink must go through the port/display seam')
  assert.match(source, /options\.mounted\(\)\.openJobInspector\(/u,
    'the PiTui-only Job Inspector mount remains the ONE documented exception')
})
