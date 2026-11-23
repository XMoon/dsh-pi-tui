/**
 * `/web` (M5-W PR-C): the ONE Client control entry of the Split Host's official
 * Web frontend.
 *
 * Two layers are driven through their real seams:
 *  - the COMMAND (`createWebAccessCommands`) over the semantic WebAccessPort:
 *    which Host call each explicit intent makes, the authoritative re-read and
 *    the truthful presentation/notices;
 *  - the PiTui branch: `/web` is a typed deep link into the ONE Settings
 *    `Host · Web UI` page, so this command performs NO Host read/write and NO
 *    URL request of its own (the page owns those).
 *
 * The authenticated URL is a hostile-by-default value here: every case fails if
 * it reaches a notice, the Details page or a non-explicit action.
 * @module @xmoon76/dsh-pi-tui/test/app/web-access-command
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebAccessCommands, type WebAccessCommandRunner } from '../../src/tui/commands/web-access.ts'
import type {
  WebAccessActionId,
  WebAccessMenuHandle,
  WebAccessNotice,
  WebAccessPresentation,
  WebAccessReadOutcome,
  WebAccessRequest,
} from '../../src/app/command/web-access-presentation.ts'
import type { WebAccessStatus } from '../../src/runtime/web-access-port.ts'
import { LOCAL_COMMANDS, SESSIONLESS_COMMANDS } from '../../src/domain/command/policy.ts'

const SILENT_DIAG = { debug() {}, info() {}, warn() {}, error() {}, dispose() {} }

/** One recorded menu. */
interface MenuRecord {
  readonly request: WebAccessRequest
  readonly calls: string[]
  readonly outcomes: WebAccessReadOutcome[]
  readonly notices: WebAccessNotice[]
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
      const entry: MenuRecord = { request, calls: [], outcomes: [], notices: [], pending: [], disposed: false }
      menus.push(entry)
      return {
        setLoading: () => { entry.calls.push('loading') },
        setPending: (message) => { entry.pending.push(message) },
        setStatus: (outcome, notice) => {
          entry.outcomes.push(outcome)
          if (notice !== undefined) entry.notices.push(notice)
        },
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
  /** The PiTui renderer: `/web` becomes the Settings deep link. */
  readonly pitui?: boolean
  /** The Settings entry the PiTui branch calls (default: success). */
  readonly openSettings?: () => Promise<{ kind: 'success' } | { kind: 'error'; text: string }>
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
      currentGeneration: () => undefined,
      subscribeGeneration: () => () => {},
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
  const settingsOpens: number[] = []
  const openSettings = options.openSettings ?? (async () => ({ kind: 'success' as const }))
  createWebAccessCommands({
    runner,
    // The PiTui branch is `app !== undefined && webPresentation === undefined`;
    // this fixture supplies a structural app marker for it.
    app: options.pitui === true ? {} as never : undefined,
    notify: (text, kind) => { recording.presentation.notify(text, kind) },
    registerOne: (definition) => {
      const spec = definition as unknown as { name: string; handler: (invocation: { rawInput: string }) => unknown }
      handlers.set(spec.name, spec.handler)
    },
    openSettings: () => {
      settingsOpens.push(1)
      return openSettings()
    },
    ...(options.pitui === true ? {} : { webPresentation: recording.presentation }),
    openUrl: (value) => { openedUrls.push(value) },
  }).registerWeb()
  const invoke = async (): Promise<{ kind: string; text?: string }> => {
    const handler = handlers.get('web')
    assert.ok(handler !== undefined, '/web must be registered')
    return await handler({ rawInput: '' }) as { kind: string; text?: string }
  }
  return { runner, recording, invoke, enabledRequests, statusReads, copied, openedUrls, url, settingsOpens }
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

test('the Direct backend refuses the TSP /web explicitly and opens no menu', async () => {
  const h = setup({ backendKind: 'direct' })
  const result = await h.invoke()
  assert.equal(result.kind, 'error')
  assert.equal(result.text, 'Web frontend controls are available only in a Split Client.')
  assert.equal(h.recording.menus.length, 0, 'no menu is presented outside a Split Client')
  assert.match(h.recording.notices[0]?.text ?? '', /available only in a Split Client/u)
})

test('the menu opens on the loading projection and the request read reaches the Host once', async () => {
  const h = setup({ status: { state: 'disabled' } })
  assert.equal((await h.invoke()).kind, 'success')
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
  await h.invoke()
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
  assert.deepEqual(entry.notices, [], 'a state toggle needs no extra result line: the status is the result')
})

test('Disable Web trusts the authoritative re-read, not the toggle reply', async () => {
  const h = setup({ status: { state: 'enabled' }, settledStatus: { state: 'changing' } })
  await h.invoke()
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
  await h.invoke()
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
    await h.invoke()
    const entry = h.recording.menus[0]!
    entry.request.act('copy-link')
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    assert.deepEqual(h.copied, [h.url], 'the EXACT official URL is copied, once')
    const notice = h.recording.notices.at(-1)
    assert.equal(notice?.text, expected, 'the notice states the copy acknowledgement only')
    assert.equal(notice?.kind, kind)
    assert.deepEqual(entry.notices, [{ message: expected, kind }],
      'the SAME result is painted INSIDE the open menu (its overlay covers the base notice line)')
    assert.doesNotMatch(JSON.stringify(h.recording.notices), /SECRET-LAUNCH-TOKEN/u)
  }
})

test('an unreadable Host status becomes an explicit unavailable projection (no guessed Off)', async () => {
  const h = setup({ readFailure: 'the Client is not connected to a Host' })
  await h.invoke()
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
  await h.invoke()
  const entry = h.recording.menus[0]!
  entry.request.act('enable')
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const notices = h.recording.notices.map(notice => notice.text)
  assert.match(notices.at(-1) ?? '', /the Host refused the toggle/u)
  assert.deepEqual(entry.outcomes, [{ kind: 'status', status: { state: 'disabled' } }],
    'the authoritative re-read is what the menu shows after the refusal')
  assert.equal(entry.notices.length, 1, 'the refusal is painted inside the open menu too')
  assert.equal(entry.notices[0]?.kind, 'error')
  assert.match(entry.notices[0]?.message ?? '', /the Host refused the toggle/u)
})

/* -------------------------------------------------- PiTui / web deep link */

test('the PiTui /web is the ONE Settings deep link: zero Host read, zero URL, zero write', async () => {
  const h = setup({ pitui: true, status: { state: 'enabled' } })
  const result = await h.invoke()
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(h.settingsOpens, [1], 'exactly one Settings Web-UI entry')
  assert.deepEqual(h.statusReads, [], 'the command itself starts no Host read')
  assert.deepEqual(h.enabledRequests, [], 'the command itself writes nothing')
  assert.deepEqual(h.copied, [], 'no launch URL is requested or copied')
  assert.deepEqual(h.openedUrls, [], 'no URL is opened')
  assert.equal(h.recording.menus.length, 0, 'no overlay is presented any more')
})

test('the PiTui /web reaches the page on Direct too (the page states the capability)', async () => {
  const h = setup({ pitui: true, backendKind: 'direct' })
  const result = await h.invoke()
  assert.deepEqual(result, { kind: 'success' }, 'Direct no longer refuses the entry')
  assert.deepEqual(h.settingsOpens, [1])
  assert.equal(h.recording.notices.length, 0, 'no unsupported notice is emitted by the command')
})

test('a failed Settings page mount is returned as the real command error', async () => {
  const h = setup({
    pitui: true,
    openSettings: async () => ({ kind: 'error', text: 'could not open Web UI: the web-ui row is not available in this snapshot' }),
  })
  const result = await h.invoke()
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /the web-ui row is not available/u)
  assert.deepEqual(h.statusReads, [], 'a refused entry starts no Host read')
})
