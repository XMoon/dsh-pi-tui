/**
 * L5: the REAL installed Client store drives the Browser read owner.
 *
 * One real Host fixture + the real in-process Client (the same carrier the
 * production split Client uses), the real Remote reader/facts adapters over the
 * official generated namespaces, and the real `createSessionBrowserReadOwner`
 * + presentation seam. This proves the changed authority producer→decision→
 * render path instead of a precomputed fact: the official list push reaches the
 * accepted roster, and a REAL carrier reconnect keeps the panel open while the
 * Workspace follow invalidates and re-proves a fresh baseline.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSessionBrowserReadOwner } from '../../src/app/command/session-browser-read.ts'
import type {
  SessionBrowserPanelRequest,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
} from '../../src/app/command/session-browser-presentation.ts'
import type { SessionScope } from '../../src/app/session/scope.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { RemoteSessionReader } from '../../src/runtime/remote/session-reader-remote.ts'
import { RemoteSessionWorkspaceFacts } from '../../src/runtime/remote/session-workspace-facts-remote.ts'
import { createRemoteApplicationHostFixture, testLifecycle } from '../support/remote-application-fixture.ts'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteClientRuntime } from '../support/m3-inprocess/client-runtime.ts'

const CURRENT = 'l5-browser-owner-row'
const LATE = 'l5-browser-owner-late'

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}

class ProbePresentation implements SessionBrowserPresentation {
  readonly requests: SessionBrowserPanelRequest[] = []
  readonly snapshots: SessionBrowserReadSnapshot[] = []
  readonly latest = (): SessionBrowserReadSnapshot | undefined => this.snapshots.at(-1)

  open(request: SessionBrowserPanelRequest): import('../../src/app/command/session-browser-presentation.ts').SessionBrowserPanelHandle {
    this.requests.push(request)
    return {
      isDisposed: () => false,
      setSnapshot: (snapshot) => { this.snapshots.push(snapshot) },
      close: () => { request.onClose() },
    }
  }

  notify(): void {}
}

test('L5 the REAL Client store drives the Browser owner roster and its Workspace recovery', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'l5-browser-owner')
  host.ctx.sessions.create(SessionId(CURRENT), { meta: { cwd: host.anchorDir } })
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  t.after(async () => {
    await client.dispose()
    await hostRuntime.dispose()
    await host.dispose()
  })
  await waitFor('the official Session list is ready', () => client.sessions.list.getSnapshot().phase === 'ready')
  await waitFor('the seeded Session arrives in the official list', () => client.sessions.list.getSnapshot().ids.includes(SessionId(CURRENT)))

  const generation = client.connection.generation
  const forwarded = client.remote.$on.bind(client.remote)
  const reader = new RemoteSessionReader(client.sessions, generation)
  const facts = new RemoteSessionWorkspaceFacts({
    sessions: client.sessions,
    remote: { session: client.remote.session, workspace: client.remote.workspace },
    connection: { generation },
    events: { onSessionStatus: listener => forwarded('api-session/status', listener) },
    workspaceStream: client.workspaceStream,
    initialGeneration: client.initialGeneration,
  })
  t.after(() => { facts.dispose() })

  const presentation = new ProbePresentation()
  const diag = createDiag({ stderrLevel: 'off' })
  t.after(() => { diag.dispose() })
  const owner = createSessionBrowserReadOwner({
    reader,
    presentation,
    captureSubject: () => ({
      subject: { currentSessionId: CURRENT, currentCwd: host.anchorDir, isCurrent: () => true },
      scope: { sessionId: CURRENT } as unknown as SessionScope,
    }),
    diag,
    sessionId: () => CURRENT,
    sessionWorkspaceFacts: facts,
  })
  t.after(() => { owner.dispose() })
  owner.open()

  // The real official row reaches the accepted roster: a row and its Room.
  await waitFor('the real seeded row paints from the official store', () =>
    presentation.latest()?.rows.some(entry => entry.id === CURRENT) === true)
  await waitFor('the real Workspace baseline is proven', () =>
    presentation.latest()?.workspace?.baselineProven === true)

  // A real Host Session create reaches the SAME owner through the official push.
  host.ctx.sessions.create(SessionId(LATE), { meta: { cwd: host.anchorDir } })
  await waitFor('the late real Session reaches the owner roster', () =>
    presentation.latest()?.rows.some(entry => entry.id === LATE) === true)

  // A REAL carrier reconnect with the panel OPEN: the one Workspace follow
  // invalidates the membership and re-proves a fresh baseline; the panel never
  // closes and its roster survives.
  const revisionBefore = presentation.latest()?.workspace?.revision ?? 0
  client.connection.reconnect()
  await waitFor('the Workspace baseline is re-proven after the real reconnect', () => {
    const workspace = presentation.latest()?.workspace
    return workspace !== undefined && workspace.baselineProven && workspace.revision > revisionBefore
  })
  assert.equal(presentation.latest()?.rows.some(entry => entry.id === CURRENT), true,
    'the same panel keeps its real roster across the reconnect')
  assert.equal(presentation.latest()?.workspace?.state, 'ready',
    'the recovered Workspace membership is a real current baseline, not a stale paint')
})
