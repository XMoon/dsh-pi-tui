/**
 * `/web` (M5-W PR-C): the ONE Client control entry of the Split Host's official
 * Web frontend.
 *
 * Two layers are driven through their real seams:
 *  - the COMMAND (`createWebAccessCommands`) over the semantic WebAccessPort:
 *    which Host call each explicit intent makes, the authoritative re-read and
 *    the truthful presentation/notices;
 *  - the default PiTui SHORT MENU (`pituiWebAccessPresentation`) over a real
 *    `TuiApp`/`VirtualTerminal`: the state fact and exactly the actions the
 *    current Host status admits, with `openSettings` rows that really activate.
 *
 * The authenticated URL is a hostile-by-default value here: every case fails if
 * it reaches a notice, the Details page or a non-explicit action.
 * @module @xmoon76/dsh-pi-tui/test/app/web-access-command
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createWebAccessCommands, type WebAccessCommandRunner } from '../../src/tui/commands/web-access.ts'
import { pituiWebAccessPresentation } from '../../src/tui/pickers/web-access-presentation-pitui.ts'
import type {
  WebAccessActionId,
  WebAccessMenuHandle,
  WebAccessPresentation,
  WebAccessReadOutcome,
  WebAccessRequest,
} from '../../src/app/command/web-access-presentation.ts'
import type { WebAccessStatus } from '../../src/runtime/web-access-port.ts'
import { LOCAL_COMMANDS, SESSIONLESS_COMMANDS } from '../../src/domain/command/policy.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'

const lifecycle = createAppLifecycleGuard<TuiApp>()
test.after(() => { lifecycle.disposeAll() })

const SILENT_DIAG = { debug() {}, info() {}, warn() {}, error() {}, dispose() {} }

/** One recorded menu. */
interface MenuRecord {
  readonly request: WebAccessRequest
  readonly calls: string[]
  readonly outcomes: WebAccessReadOutcome[]
  readonly pending: string[]
  disposed: boolean
}

/** A recording presenter: the command's read/action wiring without a renderer. */
function recordingPresentation() {
  const menus: MenuRecord[] = []
  const notices: Array<{ text: string; kind: 'info' | 'error' }> = []
  const presentation: WebAccessPresentation = {
    notify: (text, kind) => { notices.push({ text, kind: kind ?? 'info' }) },
    open: (request): WebAccessMenuHandle => {
      const entry: MenuRecord = { request, calls: [], outcomes: [], pending: [], disposed: false }
      menus.push(entry)
      return {
        setLoading: () => { entry.calls.push('loading') },
        setPending: (message) => { entry.pending.push(message) },
        setStatus: (outcome) => { entry.outcomes.push(outcome) },
        isDisposed: () => entry.disposed,
        close: () => { entry.disposed = true },
      }
    },
  }
  return { presentation, menus, notices }
}

/** An owned runner that drains queued tasks deterministically. */
function ownedRunner() {
  const pending: Array<() => void> = []
  const run = (
    label: string,
    task: () => unknown,
    options: {
      onResult?: (value: unknown) => void
      onError?: (error: unknown) => void
    },
  ): void => {
    void label
    pending.push(() => {
      void Promise.resolve()
        .then(() => task())
        .then(
          value => options.onResult?.(value),
          (error: unknown) => options.onError?.(error),
        )
    })
  }
  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      pending.shift()!()
      for (let at = 0; at < 12; at += 1) await Promise.resolve()
    }
    for (let at = 0; at < 12; at += 1) await Promise.resolve()
  }
  return { run, drain }
}

function setup(options: {
  readonly backendKind?: 'direct' | 'remote'
  readonly status?: WebAccessStatus
  readonly settledStatus?: WebAccessStatus
  readonly copy?: boolean
  readonly readFailure?: string
  readonly toggleFailure?: string
  readonly urlFailure?: string
}) {
  const url = 'http://127.0.0.1:4321/?token=SECRET-LAUNCH-TOKEN'
  let status = options.status ?? { state: 'disabled' }
  const enabledRequests: boolean[] = []
  const statusReads: number[] = []
  const copied: string[] = []
  const openedUrls: string[] = []
  const runner: WebAccessCommandRunner = {
    backendKind: options.backendKind ?? 'remote',
    webAccess: {
      getStatus: async () => {
        statusReads.push(1)
        if (options.readFailure !== undefined) throw new Error(options.readFailure)
        return status
      },
      setEnabled: async (enabled: boolean) => {
        if (options.toggleFailure !== undefined) throw new Error(options.toggleFailure)
        enabledRequests.push(enabled)
        status = options.settledStatus ?? (enabled ? { state: 'enabled' } : { state: 'disabled' })
        return status
      },
      getAuthenticatedUrl: async () => {
        if (options.urlFailure !== undefined) throw new Error(options.urlFailure)
        return { url }
      },
    },
    copyToClipboard: async (text: string) => {
      copied.push(text)
      return options.copy ?? true
    },
    diag: SILENT_DIAG,
    currentSessionId: undefined,
  }
  const recording = recordingPresentation()
  const handlers = new Map<string, (invocation: { rawInput: string }) => unknown>()
  createWebAccessCommands({
    runner,
    app: undefined,
    notify: (text, kind) => { recording.presentation.notify(text, kind) },
    registerOne: (definition) => {
      const spec = definition as unknown as { name: string; handler: (invocation: { rawInput: string }) => unknown }
      handlers.set(spec.name, spec.handler)
    },
    webPresentation: recording.presentation,
    openUrl: (value) => { openedUrls.push(value) },
  }).registerWeb()
  const invoke = (): { kind: string; text?: string } => {
    const handler = handlers.get('web')
    assert.ok(handler !== undefined, '/web must be registered')
    return handler({ rawInput: '' }) as { kind: string; text?: string }
  }
  return { runner, recording, invoke, enabledRequests, statusReads, copied, openedUrls, url }
}

/** Run one request's owned read through the LOCAL drain (no global tasks). */
function readInto(entry: MenuRecord, owned: ReturnType<typeof ownedRunner>): void {
  entry.request.runOwned('web status', () => entry.request.readStatus(), {
    onResult: (outcome) => { entry.outcomes.push(outcome as WebAccessReadOutcome) },
  })
  void owned
}

test('/web is a sessionless LOCAL command name', () => {
  assert.ok(SESSIONLESS_COMMANDS.has('web'), 'a first-boot /web must never create a Session')
  assert.ok(LOCAL_COMMANDS.has('web'), '/web is a Client-local control entry')
})

test('the Direct backend refuses /web explicitly and opens no menu', () => {
  const h = setup({ backendKind: 'direct' })
  const result = h.invoke()
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'Web frontend controls are available only in a Split Client.')
  assert.equal(h.recording.menus.length, 0, 'no menu is presented outside a Split Client')
  assert.match(h.recording.notices[0]?.text ?? '', /available only in a Split Client/u)
})

test('the menu opens on the loading projection and the request read reaches the Host once', async () => {
  const h = setup({ status: { state: 'disabled' } })
  assert.equal(h.invoke().kind, 'success')
  assert.equal(h.recording.menus.length, 1)
  const entry = h.recording.menus[0]!
  const owned = ownedRunner()
  readInto(entry, owned)
  await owned.drain()
  assert.equal(h.statusReads.length, 1, 'exactly one Host status read per menu')
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'disabled' } }])
})

test('Enable Web performs the Host toggle and reprojects the authoritative re-read', async () => {
  const h = setup({ status: { state: 'disabled' } })
  h.invoke()
  const entry = h.recording.menus[0]!
  entry.request.act('enable')
  const owned = ownedRunner()
  // The command's own runOwned is the global one; drain the tasks through a
  // real runOwned by awaiting one macrotask turn.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  void owned
  assert.deepEqual(h.enabledRequests, [true], 'the SAME Host setEnabled(true) is called once')
  assert.deepEqual(entry.pending, ['Enabling Web…'], 'the admitted action is stated before it settles')
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'enabled' } }],
    'the menu shows the RE-READ state, not the requested boolean')
  assert.equal(h.recording.menus.length, 1, 'the SAME menu is reprojected')
})

test('Disable Web trusts the authoritative re-read, not the toggle reply', async () => {
  const h = setup({ status: { state: 'enabled' }, settledStatus: { state: 'changing' } })
  h.invoke()
  const entry = h.recording.menus[0]!
  entry.request.act('disable')
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  assert.deepEqual(h.enabledRequests, [false])
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'changing' } }],
    'a Host that has not settled is reported as changing')
})

test('Open Browser requests the official URL only on the explicit action and never prints it', async () => {
  const h = setup({ status: { state: 'enabled' } })
  h.invoke()
  const entry = h.recording.menus[0]!
  assert.equal(h.openedUrls.length, 0, 'merely opening the menu requests/opens no URL')
  entry.request.act('open-browser')
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  assert.deepEqual(h.openedUrls, [h.url], 'the Client-local opener received the official URL')
  const notices = h.recording.notices.map(notice => notice.text).join('\n')
  assert.match(notices, /Opening browser…/u, 'the notice states the REQUEST, never that it opened')
  assert.match(notices, /Copy Link/u, 'the fallback path is named')
  assert.doesNotMatch(notices, /SECRET-LAUNCH-TOKEN/u, 'the launch token never reaches a notice')
  assert.doesNotMatch(JSON.stringify(entry.outcomes), /SECRET-LAUNCH-TOKEN/u, 'nor the menu projection')
})

test('Copy Link reports only the clipboard acknowledgement and never falls back to the URL text', async () => {
  for (const [copy, expected, kind] of [
    [true, 'Link copied', 'info'],
    [false, 'Clipboard unavailable', 'error'],
  ] as const) {
    const h = setup({ status: { state: 'enabled' }, copy })
    h.invoke()
    const entry = h.recording.menus[0]!
    entry.request.act('copy-link')
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    assert.deepEqual(h.copied, [h.url], 'the EXACT official URL is copied, once')
    const notice = h.recording.notices.at(-1)
    assert.equal(notice?.text, expected, 'the notice states the copy acknowledgement only')
    assert.equal(notice?.kind, kind)
    assert.doesNotMatch(JSON.stringify(h.recording.notices), /SECRET-LAUNCH-TOKEN/u)
  }
})

test('an unreadable Host status becomes an explicit unavailable projection (no guessed Off)', async () => {
  const h = setup({ readFailure: 'the Client is not connected to a Host' })
  h.invoke()
  const entry = h.recording.menus[0]!
  const owned = ownedRunner()
  readInto(entry, owned)
  await owned.drain()
  assert.deepEqual(entry.outcomes, [{
    kind: 'unavailable',
    message: 'the Client is not connected to a Host',
  }])
})

test('a failed toggle is stated as an error notice and the menu re-reads the authority', async () => {
  const h = setup({ status: { state: 'disabled' }, toggleFailure: 'the Host refused the toggle' })
  h.invoke()
  const entry = h.recording.menus[0]!
  entry.request.act('enable')
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const notices = h.recording.notices.map(notice => notice.text)
  assert.match(notices.at(-1) ?? '', /the Host refused the toggle/u)
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'disabled' } }],
    'the authoritative re-read is what the menu shows after the refusal')
})

/* ------------------------------------------------------------ PiTui menu */

interface MenuHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly handle: WebAccessMenuHandle
  readonly actions: WebAccessActionId[]
  readonly notices: string[]
}

/** One real PiTui menu driven on a virtual terminal. */
async function pituiMenu(
  t: { after(fn: () => unknown): void },
  status: WebAccessStatus,
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
  const actions: WebAccessActionId[] = []
  const notices: string[] = []
  const presentation = pituiWebAccessPresentation(app)
  const request: WebAccessRequest = {
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
  return { vt, app, handle, actions, notices }
}

/** Let the entry read settle and its projection paint. */
async function settleMenu(vt: VirtualTerminal): Promise<void> {
  for (let at = 0; at < 12; at += 1) await Promise.resolve()
  await vt.waitForRender()
}

const view = (vt: VirtualTerminal): string => vt.getViewport().join('\n')

test('the PiTui menu paints the state fact and exactly the disabled-state actions', async t => {
  const h = await pituiMenu(t, { state: 'disabled' })
  const frame = view(h.vt)
  assert.match(frame, /Status: disabled/u)
  assert.match(frame, /Enable Web/u)
  assert.match(frame, /Details/u)
  assert.doesNotMatch(frame, /Open Browser|Copy Link|Disable Web|Loading Web status/u,
    'a disabled Host offers no enabled-state action and no stale loading row')
})

test('the PiTui menu offers only Open/Copy/Disable on an enabled Host', async t => {
  const h = await pituiMenu(t, { state: 'enabled' })
  const frame = view(h.vt)
  assert.match(frame, /Status: enabled/u)
  assert.match(frame, /Open Browser/u)
  assert.match(frame, /Copy Link/u)
  assert.match(frame, /Disable Web/u)
  assert.doesNotMatch(frame, /Enable Web/u)
})

test('a changing Host offers no write', async t => {
  const h = await pituiMenu(t, { state: 'changing' })
  const frame = view(h.vt)
  assert.match(frame, /Status: changing/u)
  assert.doesNotMatch(frame, /Enable Web|Open Browser|Copy Link|Disable Web/u,
    'a serialized mutation in flight admits no second request')
})

test('an unavailable Host offers no write', async t => {
  const h = await pituiMenu(t, { state: 'unavailable', reason: 'rows partially enabled' })
  const frame = view(h.vt)
  assert.match(frame, /Status: unavailable/u)
  assert.doesNotMatch(frame, /Enable Web|Open Browser|Copy Link|Disable Web/u,
    'a partial Web graph offers no false success action')
})

test('activating Enable Web forwards the ONE intent and closing never writes', async t => {
  const h = await pituiMenu(t, { state: 'disabled' })
  // Row 1 is the disabled fact row; one Down reaches Enable Web, Enter activates it.
  h.vt.sendInput('\u001b[B')
  await h.vt.waitForRender()
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
  // Rows: status -> Open Browser -> Copy Link -> Disable Web -> Details.
  for (let at = 0; at < 4; at += 1) h.vt.sendInput('\u001b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.match(view(h.vt), /Back to Web/u, 'the way back is the first row')
  assert.deepEqual(h.actions, [], 'opening Details writes nothing')

  const descriptions: string[] = []
  for (let at = 0; at < 5; at += 1) {
    h.vt.sendInput('\u001b[B')
    await h.vt.waitForRender()
    descriptions.push(view(h.vt))
  }
  const all = descriptions.join('\n')
  assert.match(all, /127\.0\.0\.1/u, 'the Host fact is stated')
  assert.match(all, /next Host launch/u, 'the Auto-start lifetime is stated')
  assert.match(all, /Web home page/u, 'the session limitation is stated')

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
  assert.match(frame, /Enable Web/u, 'the admitted action stays reachable at the 44-column floor')
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
  const row = lines.findIndex(line => line.includes('Enable Web'))
  assert.ok(row >= 0, `the Enable Web row must be painted on the alt screen:\n${lines.join('\n')}`)
  const start = visibleWidth(lines[row]!.slice(0, lines[row]!.indexOf('Enable Web')))
  h.vt.sendInput(`\u001b[<0;${start + 3};${row + 1}M`)
  await h.vt.waitForRender()
  h.vt.sendInput(`\u001b[<0;${start + 3};${row + 1}m`)
  await h.vt.waitForRender()
  assert.deepEqual(h.actions, ['enable'], 'the alt-screen pointer path reaches the ONE command intent')
  h.vt.sendInput('\u001b')
  await h.vt.waitForRender()
  assert.equal(h.app.overlayGraphState().handles, 0, 'Esc restores the seat on the alt screen too')
})
