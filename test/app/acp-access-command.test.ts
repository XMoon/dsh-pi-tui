/**
 * `/acp` (PO-5E / PR-B): the ONE Client entry of the Split Host's local ACP v1
 * listener.
 *
 * Two layers are driven through their real seams:
 *  - the NATIVE (TSP) command path over the semantic AcpAccessPort: which Host
 *    call each explicit intent makes, the generation fencing, the authoritative
 *    re-read and the truthful presentation/notices;
 *  - the PiTui routing seam: `/acp` forwards UNCONDITIONALLY to the ONE
 *    `Settings · Host · ACP access` deep link (Direct included) and returns its
 *    real result, while a supplied native presenter still owns the native path.
 *
 * The retired PiTui short SettingsList overlay no longer exists; its page is
 * owned by `test/tui/acp-access-settings-page.test.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/test/app/acp-access-command
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createAcpAccessCommands, type AcpAccessCommandRunner } from '../../src/tui/commands/acp-access.ts'
import type {
  AcpAccessActionId,
  AcpAccessMenuHandle,
  AcpAccessNotice,
  AcpAccessPresentation,
  AcpAccessReadOutcome,
  AcpAccessRequest,
} from '../../src/app/command/acp-access-presentation.ts'
import type { AcpAccessStatus } from '../../src/runtime/acp-access-port.ts'
import { LOCAL_COMMANDS, READ_ONLY_LOCAL_COMMANDS, SESSIONLESS_COMMANDS } from '../../src/domain/command/policy.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'

const lifecycle = createAppLifecycleGuard<TuiApp>()
test.after(() => { lifecycle.disposeAll() })

const SILENT_DIAG = { debug() {}, info() {}, warn() {}, error() {}, dispose() {} }

/** One recorded menu. */
interface MenuRecord {
  readonly request: AcpAccessRequest
  readonly outcomes: AcpAccessReadOutcome[]
  readonly notices: AcpAccessNotice[]
  readonly pending: string[]
  disposed: boolean
}

/** A recording presenter: the command's read/action wiring without a renderer. */
function recordingPresentation() {
  const menus: MenuRecord[] = []
  const notices: Array<{ text: string; kind: 'info' | 'error' }> = []
  const presentation: AcpAccessPresentation = {
    notify: (text, kind) => { notices.push({ text, kind: kind ?? 'info' }) },
    open: (request): AcpAccessMenuHandle => {
      const entry: MenuRecord = { request, outcomes: [], notices: [], pending: [], disposed: false }
      menus.push(entry)
      const handle: AcpAccessMenuHandle = {
        setLoading: () => {},
        setPending: (message) => { entry.pending.push(message) },
        setStatus: (outcome, notice) => {
          entry.outcomes.push(outcome)
          if (notice !== undefined) entry.notices.push(notice)
        },
        isDisposed: () => entry.disposed,
        close: () => { entry.disposed = true },
      }
      // The REAL presenters ask for the initial read as soon as they are
      // entered; this recording presenter mirrors that contract.
      request.runOwned('acp status', () => request.readStatus(), {
        onResult: (outcome) => {
          if (entry.disposed) return
          handle.setStatus(outcome as AcpAccessReadOutcome)
        },
      })
      return handle
    },
  }
  return { presentation, menus, notices }
}

function setup(options: {
  readonly backendKind?: 'direct' | 'remote'
  readonly status?: AcpAccessStatus
  readonly settledStatus?: AcpAccessStatus
  readonly readFailure?: string
  readonly toggleFailure?: string
}) {
  const generation = { host: 'generation-1' }
  let status = options.status ?? { state: 'disabled' }
  const toggles: Array<{ readonly enabled: boolean; readonly expectedGeneration: unknown }> = []
  let toggleAttempts = 0
  const statusReads: number[] = []
  const runner: AcpAccessCommandRunner = {
    backendKind: options.backendKind ?? 'remote',
    acpAccess: {
      getStatus: async () => {
        statusReads.push(1)
        if (options.readFailure !== undefined) throw new Error(options.readFailure)
        return status
      },
      setEnabled: async (enabled: boolean, expectedGeneration?: unknown) => {
        toggleAttempts += 1
        if (options.toggleFailure !== undefined) throw new Error(options.toggleFailure)
        toggles.push({ enabled, expectedGeneration })
        status = options.settledStatus ?? (enabled ? { state: 'enabled' } : { state: 'disabled' })
        return status
      },
      currentGeneration: () => generation,
      subscribeGeneration: () => () => {},
    },
    diag: SILENT_DIAG,
    currentSessionId: undefined,
  }
  const recording = recordingPresentation()
  const handlers = new Map<string, (invocation: { rawInput: string }) => unknown>()
  createAcpAccessCommands({
    runner,
    app: undefined,
    notify: (text, kind) => { recording.presentation.notify(text, kind) },
    registerOne: (definition) => {
      const spec = definition as unknown as { name: string; handler: (invocation: { rawInput: string }) => unknown }
      handlers.set(spec.name, spec.handler)
    },
    acpPresentation: recording.presentation,
    openSettings: async () => ({ kind: 'success' }),
  }).registerAcp()
  const invoke = (): { kind: string; text?: string } => {
    const handler = handlers.get('acp')
    assert.ok(handler !== undefined, '/acp must be registered')
    return handler({ rawInput: '' }) as { kind: string; text?: string }
  }
  return { runner, recording, invoke, toggles, statusReads, generation, toggleAttempts: () => toggleAttempts }
}

/** Drain the command's owned tasks (the real runOwned queue) deterministically. */
async function settleCommand(): Promise<void> {
  for (let at = 0; at < 4; at += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

test('/acp is a sessionless LOCAL command that is not read-only', () => {
  assert.ok(SESSIONLESS_COMMANDS.has('acp'), 'a first-boot /acp must never create a Session')
  assert.ok(LOCAL_COMMANDS.has('acp'), '/acp is a Client-local control entry')
  assert.equal(READ_ONLY_LOCAL_COMMANDS.has('acp'), false,
    '/acp performs an explicit Host mutation, so it must not be admitted as read-only local work')
})

test('the Direct backend refuses /acp explicitly and opens no menu', () => {
  const h = setup({ backendKind: 'direct' })
  const result = h.invoke()
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'ACP server controls are available only in a Split Client.')
  assert.equal(h.recording.menus.length, 0, 'no menu is presented outside a Split Client')
  assert.match(h.recording.notices[0]?.text ?? '', /available only in a Split Client/u)
})

test('the menu opens on the loading projection and reads the Host exactly once', async () => {
  const h = setup({ status: { state: 'disabled' } })
  assert.equal(h.invoke().kind, 'success')
  const entry = h.recording.menus[0]!
  await settleCommand()
  assert.equal(h.statusReads.length, 1, 'exactly ONE Host status read per menu')
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'disabled' } }])
})

test('Enable ACP performs ONE fenced Host toggle and reprojects the authoritative re-read', async () => {
  const h = setup({ status: { state: 'disabled' }, settledStatus: { state: 'changing' } })
  h.invoke()
  const entry = h.recording.menus[0]!
  await settleCommand()
  entry.outcomes.length = 0
  entry.request.act('enable')
  await settleCommand()
  assert.deepEqual(h.toggles, [{ enabled: true, expectedGeneration: h.generation }],
    'the SAME Host setEnabled(true) is called once with the generation captured by the menu read')
  assert.deepEqual(entry.pending, ['Enabling ACP…'], 'the admitted action is stated before it settles')
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'changing' } }],
    'the menu shows the RE-READ state, not the requested boolean')
  assert.equal(h.recording.menus.length, 1, 'the SAME menu is reprojected')
  assert.deepEqual(entry.notices, [], 'a state toggle needs no extra result line: the status is the result')
})

test('Disable ACP trusts the authoritative re-read, not the toggle reply', async () => {
  const h = setup({ status: { state: 'enabled' }, settledStatus: { state: 'disabled' } })
  h.invoke()
  const entry = h.recording.menus[0]!
  await settleCommand()
  entry.outcomes.length = 0
  entry.request.act('disable')
  await settleCommand()
  assert.deepEqual(h.toggles, [{ enabled: false, expectedGeneration: h.generation }])
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'disabled' } }])
})

test('a stale-generation refusal is one clear error, then the authoritative re-read; no retry', async () => {
  const h = setup({
    status: { state: 'disabled' },
    toggleFailure: 'acp access toggle superseded: the Host generation changed before dispatch',
  })
  h.invoke()
  const entry = h.recording.menus[0]!
  await settleCommand()
  entry.outcomes.length = 0
  entry.request.act('enable')
  await settleCommand()
  assert.equal(h.toggleAttempts(), 1, 'exactly one admitted write attempt is made')
  assert.equal(h.recording.notices.length, 1, 'the refusal is stated once')
  assert.equal(h.recording.notices[0]?.kind, 'error')
  assert.match(h.recording.notices[0]?.text ?? '', /superseded/u)
  assert.deepEqual(entry.notices, [{ message: h.recording.notices[0]!.text, kind: 'error' }],
    'the refusal is painted inside the open menu too')
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'disabled' } }],
    'the authoritative re-read is what the menu shows after the refusal')
})

test('an unreadable Host status becomes an explicit unavailable projection (no guessed Off)', async () => {
  const h = setup({ readFailure: 'the Client is not connected to a Host' })
  h.invoke()
  const entry = h.recording.menus[0]!
  await settleCommand()
  assert.deepEqual(entry.outcomes, [{
    kind: 'unavailable',
    message: 'the Client is not connected to a Host',
  }])
})

test('a superseded menu cannot reach the Host', async () => {
  const h = setup({ status: { state: 'disabled' } })
  h.invoke()
  const first = h.recording.menus[0]!
  h.invoke()
  const second = h.recording.menus[1]!
  assert.equal(first.disposed, true, 'a repeated /acp retires the previous menu')
  first.request.act('enable')
  await settleCommand()
  assert.deepEqual(h.toggles, [], 'the retired menu never writes')
  await settleCommand()
  second.request.act('enable')
  await settleCommand()
  assert.equal(h.toggles.length, 1, 'the current menu still writes exactly once')
})

/* --------------------------------------- PiTui typed Settings deep link */

/** The Host port of one routing case: it must never be reached by `/acp`. */
function unroutedRunner(backendKind: 'direct' | 'remote'): {
  readonly runner: AcpAccessCommandRunner
  readonly reads: () => number
  readonly writes: () => number
} {
  let reads = 0
  let writes = 0
  const runner: AcpAccessCommandRunner = {
    backendKind,
    acpAccess: {
      getStatus: async () => { reads += 1; return { state: 'disabled' } },
      setEnabled: async () => { writes += 1; return { state: 'enabled' } },
      currentGeneration: () => ({}),
      subscribeGeneration: () => () => {},
    },
    diag: SILENT_DIAG,
    currentSessionId: undefined,
  }
  return { runner, reads: () => reads, writes: () => writes }
}

/** Register `/acp` behind a REAL TuiApp and the given Settings deep link. */
async function pituiCommand(options: {
  readonly backendKind?: 'direct' | 'remote'
  readonly openSettings: () => Promise<{ kind: 'success' } | { kind: 'error'; text: string }>
  readonly presenter?: AcpAccessPresentation
  readonly notify?: (text: string, kind?: 'info' | 'error') => void
}): Promise<{ readonly invoke: () => unknown; readonly port: ReturnType<typeof unroutedRunner>; readonly app: TuiApp; readonly vt: VirtualTerminal }> {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  lifecycle.started.add(app)
  const port = unroutedRunner(options.backendKind ?? 'remote')
  const handlers = new Map<string, (invocation: { rawInput: string }) => unknown>()
  createAcpAccessCommands({
    runner: port.runner,
    app,
    notify: options.notify ?? (() => {}),
    registerOne: (definition) => {
      const spec = definition as unknown as { name: string; handler: (invocation: { rawInput: string }) => unknown }
      handlers.set(spec.name, spec.handler)
    },
    openSettings: options.openSettings,
    ...(options.presenter === undefined ? {} : { acpPresentation: options.presenter }),
  }).registerAcp()
  const invoke = (): unknown => {
    const handler = handlers.get('acp')
    assert.ok(handler !== undefined, '/acp must be registered')
    return handler({ rawInput: '' })
  }
  return { invoke, port, app, vt }
}

test('/acp on PiTui forwards to the ONE Settings deep link and returns its result', async t => {
  t.after(() => { lifecycle.disposeAll() })
  let opens = 0
  const h = await pituiCommand({
    backendKind: 'remote',
    openSettings: async () => { opens += 1; return { kind: 'success' } },
  })
  const result = await h.invoke()
  assert.deepEqual(result, { kind: 'success' }, 'the deep link result is the command result')
  assert.equal(opens, 1, 'exactly ONE Settings deep link per invocation')
  assert.equal(h.port.reads(), 0, 'the command performs no Host read of its own')
  assert.equal(h.port.writes(), 0, 'opening the page writes nothing')
})

test('a Direct PiTui /acp still reaches the truthful Settings page', async t => {
  t.after(() => { lifecycle.disposeAll() })
  let opens = 0
  const h = await pituiCommand({
    backendKind: 'direct',
    openSettings: async () => { opens += 1; return { kind: 'success' } },
    notify: () => assert.fail('Direct must not refuse at the command layer when the page can state the fact'),
  })
  const result = await h.invoke()
  assert.deepEqual(result, { kind: 'success' })
  assert.equal(opens, 1, 'Direct forwards to the SAME page, which states Split Host only')
  assert.equal(h.port.reads(), 0, 'a Direct page performs no fake Host read')
})

test('a failed Settings mount is the real /acp error, never a silent fallback', async t => {
  t.after(() => { lifecycle.disposeAll() })
  const h = await pituiCommand({
    openSettings: async () => ({ kind: 'error', text: 'could not open ACP access: the Host row is unavailable' }),
  })
  const result = await h.invoke()
  assert.deepEqual(result, { kind: 'error', text: 'could not open ACP access: the Host row is unavailable' })
})

test('a supplied native presenter keeps the TSP path; the Settings link is not used', async t => {
  t.after(() => { lifecycle.disposeAll() })
  const recording = recordingPresentation()
  let opens = 0
  const h = await pituiCommand({
    backendKind: 'remote',
    presenter: recording.presentation,
    openSettings: async () => { opens += 1; return { kind: 'success' } },
  })
  const result = await h.invoke()
  assert.deepEqual(result, { kind: 'success' })
  assert.equal(opens, 0, 'the native presenter owns the native path')
  assert.equal(recording.menus.length, 1, 'the native presenter really opened its menu')
  await settleCommand()
  assert.equal(recording.menus[0]!.outcomes.length, 1, 'the native path still reads the Host once')
})
