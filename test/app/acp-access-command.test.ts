/**
 * `/acp` (PO-5E): the ONE Client quick control of the Split Host's local ACP
 * v1 listener.
 *
 * Two layers are driven through their real seams:
 *  - the COMMAND (`createAcpAccessCommands`) over the semantic AcpAccessPort:
 *    which Host call each explicit intent makes, the generation fencing, the
 *    authoritative re-read and the truthful presentation/notices;
 *  - the default PiTui SHORT MENU (`pituiAcpAccessPresentation`) over a real
 *    `TuiApp`/`VirtualTerminal`: the state fact and exactly the action the
 *    current Host status admits, with `openSettings` rows that really activate.
 *
 * @module @xmoon76/dsh-pi-tui/test/app/acp-access-command
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createAcpAccessCommands, type AcpAccessCommandRunner } from '../../src/tui/commands/acp-access.ts'
import { pituiAcpAccessPresentation } from '../../src/tui/pickers/acp-access-presentation-pitui.ts'
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

/* ------------------------------------------------------------ PiTui menu */

interface MenuHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly handle: AcpAccessMenuHandle
  readonly actions: AcpAccessActionId[]
}

/** One real PiTui menu driven on a virtual terminal. */
async function pituiMenu(
  t: { after(fn: () => unknown): void },
  status: AcpAccessStatus,
  size: { readonly columns: number; readonly rows: number; readonly fullscreen?: boolean } = { columns: 120, rows: 40 },
): Promise<MenuHarness> {
  const vt = new VirtualTerminal(size.columns, size.rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  lifecycle.started.add(app)
  t.after(() => { lifecycle.disposeAll() })
  if (size.fullscreen === true) {
    app.setFullscreen(true)
    await vt.waitForRender()
  }
  const actions: AcpAccessActionId[] = []
  const presentation = pituiAcpAccessPresentation(app)
  const request: AcpAccessRequest = {
    isCurrent: () => true,
    readStatus: async () => ({ kind: 'status', status }),
    act: (action) => { actions.push(action) },
    runOwned: (label, task, options) => {
      void label
      void Promise.resolve().then(() => task()).then(
        value => options.onResult?.(value),
        error => options.onError?.(error),
      )
    },
  }
  const handle = presentation.open(request)
  await settleMenu(vt)
  return { vt, app, handle, actions }
}

/** Let the entry read settle and its projection paint. */
async function settleMenu(vt: VirtualTerminal): Promise<void> {
  for (let at = 0; at < 12; at += 1) await Promise.resolve()
  await vt.waitForRender()
}

const view = (vt: VirtualTerminal): string => vt.getViewport().join('\n')

test('the PiTui menu paints the state fact and exactly the disabled-state action', async t => {
  const h = await pituiMenu(t, { state: 'disabled' })
  const frame = view(h.vt)
  assert.match(frame, /Status: disabled/u)
  assert.match(frame, /Enable ACP/u)
  assert.match(frame, /Details/u)
  assert.doesNotMatch(frame, /Disable ACP|Loading ACP status/u,
    'a disabled Host offers no enabled-state action and no stale loading row')
})

test('the PiTui menu offers only Disable on an enabled Host', async t => {
  const h = await pituiMenu(t, { state: 'enabled' })
  const frame = view(h.vt)
  assert.match(frame, /Status: enabled/u)
  assert.match(frame, /Disable ACP/u)
  assert.doesNotMatch(frame, /Enable ACP/u)
})

test('a changing Host offers no write', async t => {
  const h = await pituiMenu(t, { state: 'changing' })
  const frame = view(h.vt)
  assert.match(frame, /Status: changing/u)
  assert.doesNotMatch(frame, /Enable ACP|Disable ACP/u,
    'a serialized mutation in flight admits no second request')
})

test('an unavailable Host offers no write', async t => {
  const h = await pituiMenu(t, { state: 'unavailable', reason: 'listener is closing' })
  const frame = view(h.vt)
  assert.match(frame, /Status: unavailable/u)
  assert.doesNotMatch(frame, /Enable ACP|Disable ACP/u,
    'a Host-reported unavailable state offers no false success action')
  assert.deepEqual(h.actions, [])
})

test('an unreadable connection offers no write', async t => {
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  lifecycle.started.add(app)
  t.after(() => { lifecycle.disposeAll() })
  const presentation = pituiAcpAccessPresentation(app)
  const handle = presentation.open({
    isCurrent: () => true,
    readStatus: async () => ({ kind: 'unavailable', message: 'the Client is not connected to a Host' }),
    act: () => assert.fail('an unreadable status must offer no write'),
    runOwned: (label, task, options) => {
      void label
      void Promise.resolve().then(() => task()).then(
        value => options.onResult?.(value),
        error => options.onError?.(error),
      )
    },
  })
  await settleMenu(vt)
  assert.match(view(vt), /Status: unavailable \(connection\)/u)
  assert.doesNotMatch(view(vt), /Enable ACP|Disable ACP/u)
  assert.equal(handle.isDisposed(), false)
})

test('activating Enable ACP forwards the ONE intent and closing never writes', async t => {
  const h = await pituiMenu(t, { state: 'disabled' })
  // Row 1 is the disabled fact row; one Down reaches Enable ACP, whose own
  // selected-row description is the painted "the move landed" signal, Enter
  // activates it.
  h.vt.sendInput('\u001b[B')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /Start this Host's local ACP v1 listener/u,
    'the selected action row paints its own description')
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.deepEqual(h.actions, ['enable'], 'the activation reaches the command exactly once')
  h.handle.close()
  await h.vt.waitForRender()
  assert.equal(h.handle.isDisposed(), true)
  assert.deepEqual(h.actions, ['enable'], 'closing the menu cancels no accepted request and adds none')
})

test('the Details page shows the durable facts and returns without a write', async t => {
  const h = await pituiMenu(t, { state: 'enabled' })
  // Rows: status -> Disable ACP -> Details.
  for (let at = 0; at < 2; at += 1) h.vt.sendInput('\u001b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /Back to ACP/u, 'the way back is the first row')
  assert.deepEqual(h.actions, [], 'opening Details writes nothing')

  const descriptions: string[] = []
  for (let at = 0; at < 5; at += 1) {
    h.vt.sendInput('\u001b[B')
    await h.vt.waitForRender()
    descriptions.push(view(h.vt))
  }
  const all = descriptions.join('\n')
  assert.match(all, /Local Split Host \(same OS user; no TCP\/HTTP\)/u, 'the Host fact is stated')
  assert.match(all, /Start ACP automatically/u, 'the Auto-start lifetime is stated')
  assert.match(all, /Closing an ACP View/u, 'the Session limitation is stated')

  // Back to the menu through the first row.
  for (let at = 0; at < 5; at += 1) h.vt.sendInput('\u001b[A')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /Status: enabled/u, 'Back returns to the SAME menu')
  assert.deepEqual(h.actions, [], 'reading Details and going back writes nothing')
})

test('the PiTui menu stays reachable at 44×20 and Esc returns the focus seat without a write', async t => {
  const h = await pituiMenu(t, { state: 'disabled' }, { columns: 44, rows: 20 })
  const frame = view(h.vt)
  assert.match(frame, /Status: disabled/u, 'the narrow menu still states the Host fact')
  assert.match(frame, /Enable ACP/u, 'the admitted action stays reachable at the 44-column floor')
  assert.equal(h.app.overlayGraphState().handles, 1, 'exactly ONE managed overlay exists')
  h.vt.sendInput('\u001b')
  await h.vt.waitForRender()
  assert.equal(h.app.overlayGraphState().handles, 0, 'Esc retires the overlay and restores the focus seat')
  assert.doesNotMatch(view(h.vt), /Status: disabled/u)
  assert.equal(h.handle.isDisposed(), true, 'the retired menu knows it is gone')
  assert.deepEqual(h.actions, [], 'closing the menu writes nothing')
})

test('the PiTui menu is pointer-reachable on the fullscreen alt-screen surface', async t => {
  const h = await pituiMenu(t, { state: 'disabled' }, { columns: 120, rows: 40, fullscreen: true })
  assert.equal(h.app.overlayGraphState().handles, 1, 'the ONE overlay is painted on the alt screen')
  const lines = h.vt.getViewport()
  const row = lines.findIndex(line => line.includes('Enable ACP'))
  assert.ok(row >= 0, `the Enable ACP row must be painted on the alt screen:\n${lines.join('\n')}`)
  const start = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf('Enable ACP')))
  h.vt.sendInput(`\u001b[<0;${start + 3};${row + 1}M`)
  await h.vt.waitForRender()
  h.vt.sendInput(`\u001b[<0;${start + 3};${row + 1}m`)
  await h.vt.waitForRender()
  assert.deepEqual(h.actions, ['enable'], 'the alt-screen pointer path reaches the ONE command intent')
  h.vt.sendInput('\u001b')
  await h.vt.waitForRender()
  assert.equal(h.app.overlayGraphState().handles, 0, 'Esc restores the seat on the alt screen too')
  assert.deepEqual(h.actions, ['enable'], 'closing the menu never undoes an accepted mutation')
})

test('an external overlay teardown while the read is pending retires the menu and never reopens', async t => {
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  lifecycle.started.add(app)
  t.after(() => { lifecycle.disposeAll() })
  let releaseRead: (() => void) | undefined
  const gated = new Promise<AcpAccessReadOutcome>(resolveGate => {
    releaseRead = () => resolveGate({ kind: 'status', status: { state: 'enabled' } })
  })
  const presentation = pituiAcpAccessPresentation(app)
  const handle = presentation.open({
    isCurrent: () => true,
    readStatus: () => gated,
    act: () => assert.fail('a torn-down menu must never reach a write'),
    runOwned: (label, task, options) => {
      void label
      void Promise.resolve().then(() => task()).then(
        value => options.onResult?.(value),
        error => options.onError?.(error),
      )
    },
  })
  await settleMenu(vt)
  assert.match(view(vt), /Loading ACP status/u, 'the loading projection is mounted while the read runs')
  assert.equal(app.overlayGraphState().handles, 1)
  // A non-Esc teardown path (the fullscreen screen swap) hides the overlay
  // while the read is still in flight.
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'the swap removed the overlay')
  assert.equal(handle.isDisposed(), true, 'the presenter learned the surface is gone')
  // The read settles AFTER the teardown: repainting must NOT reopen an overlay.
  releaseRead!()
  await settleMenu(vt)
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'a late settled read must not reopen the overlay')
  assert.doesNotMatch(view(vt), /Status: enabled/u)
  assert.equal(handle.isDisposed(), true)
})

test('the real /acp command reopens after Esc and a second open re-reads once', async t => {  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  lifecycle.started.add(app)
  t.after(() => { lifecycle.disposeAll() })
  let reads = 0
  const runner: AcpAccessCommandRunner = {
    backendKind: 'remote',
    acpAccess: {
      getStatus: async () => { reads += 1; return { state: 'enabled' } },
      setEnabled: async () => ({ state: 'enabled' }),
      currentGeneration: () => ({}),
      subscribeGeneration: () => () => {},
    },
    diag: SILENT_DIAG,
    currentSessionId: undefined,
  }
  const handlers = new Map<string, (invocation: { rawInput: string }) => unknown>()
  createAcpAccessCommands({
    runner,
    app,
    notify: (text, kind) => { app.notify(text, kind) },
    registerOne: (definition) => {
      const spec = definition as unknown as { name: string; handler: (invocation: { rawInput: string }) => unknown }
      handlers.set(spec.name, spec.handler)
    },
  }).registerAcp()
  const invoke = (): void => { handlers.get('acp')!({ rawInput: '' }) }
  invoke()
  for (let at = 0; at < 12; at += 1) await Promise.resolve()
  await vt.waitForRender()
  assert.match(view(vt), /Status: enabled/u, 'the first invocation opens the menu')
  assert.equal(reads, 1, 'the first menu read the Host exactly once')
  vt.sendInput('\u001b')
  await vt.waitForRender()
  assert.doesNotMatch(view(vt), /Status: enabled/u, 'Esc closes it')
  assert.equal(app.overlayGraphState().handles, 0)
  invoke()
  for (let at = 0; at < 12; at += 1) await Promise.resolve()
  await vt.waitForRender()
  assert.match(view(vt), /Status: enabled/u, 'a second /acp invocation reopens the menu')
  assert.equal(reads, 2, 'the reopened menu made ONE fresh read')
  assert.equal(app.overlayGraphState().handles, 1)
})
