/**
 * The PR2 CLI Session launch at the REAL Direct runner composition: the
 * official `SessionReader` roster and Workspace registry stand-ins feed the
 * one runner-local launch admission, which then publishes the existing
 * pre-mount `SessionLifecycle.open` owner. This suite covers the canonical full
 * id (no roster read), the unique/ambiguous/word-like lookup classes, the `-c`
 * Workspace membership choice, the fail-closed authorities and the ONE Open
 * failure that never retries.
 *
 * PRODUCTION PREREQUISITES REPRODUCED: the real runner composition
 * (`applyRunnerWithRuntime`), the real Direct lifecycle/reader adapters over
 * the harness Host services, the real command registration and TuiApp mount.
 * TEST STAND-INS: the peripheral Host registries (SessionQuery, agents,
 * Workspace registry) only.
 * DELIBERATELY ABSENT: a paid provider, a physical terminal and the Remote
 * transport (covered by the preselected-Remote suite).
 *
 * @module @xmoon76/dsh-pi-tui/session-cli-launch.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import {
  disposeContext,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  sessionEvents,
  type FakeSession,
} from '../support/runner-harness.ts'
import { installProbe } from '../support/runner-session-fixtures.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createFakeHostWorkspaceRegistry, type FakeHostWorkspaceRegistry } from '../support/workspace-registry.ts'
import { applyRunnerWithRuntime } from '../../src/app/bootstrap.ts'
import { Config as TuiConfigSchema } from '../../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** Bounded wait on a real observable state (never a blind sleep). */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`${label}: waitUntil timed out after ${timeoutMs}ms`)
    await new Promise<void>(resolve => setTimeout(resolve, stepMs))
  }
}

function listedSession(home: string, id: string, createdAt: number): FakeSession {
  return fakeSession({
    id,
    header: { id, cwd: home, createdAt, version: SESSION_FORMAT_VERSION },
    events: sessionEvents(`${id} answer`),
  })
}

interface CliMount {
  readonly life: TestLifecycle
  readonly home: string
  readonly vt: VirtualTerminal
  readonly probe: ReturnType<typeof installProbe>
  readonly harness: ReturnType<typeof makeHarness>
  /** How many official roster reads the Direct reader performed. */
  readonly listCalls: () => number
}

async function mountCli(
  life: TestLifecycle,
  options: {
    readonly sessions: readonly FakeSession[]
    readonly launch: { readonly kind: 'lookup' | 'browse' | 'continue'; readonly query?: string }
    readonly registry?: FakeHostWorkspaceRegistry
    readonly resumeError?: Error
  },
): Promise<CliMount> {
  const home = life.tempDir('dsh-cli-launch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(110, 32)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  const harness = makeHarness(
    home,
    [...options.sessions],
    undefined, undefined, undefined, undefined, undefined, undefined,
    options.resumeError,
  )
  const query = harness.sessionQuery as { listSessions: (...args: never[]) => Promise<unknown> }
  const originalList = query.listSessions
  let listCalls = 0
  query.listSessions = (...args: never[]) => {
    listCalls += 1
    return originalList.apply(query, args)
  }
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  const fiber = await mountRunner(
    ctx,
    home,
    harness,
    { sessionLaunch: options.launch },
    {},
    () => {},
    { await: async () => {} },
    undefined,
    options.registry,
  )
  life.defer(() => fiber.dispose())
  return { life, home, vt, probe, harness, listCalls: () => listCalls }
}

// ── `--session` lookup ──────────────────────────────────────────────────────

test('a canonical full id resumes pre-mount WITHOUT a roster read', async (t) => {
  const life = testLifecycle(t)
  const id = `session-${'a1'.repeat(16)}`
  const fixture = await mountCli(life, {
    sessions: [listedSession('/placeholder', id, 1_700_000_000_000)],
    launch: { kind: 'lookup', query: id },
  })
  await waitUntil(() => fixture.harness.resumeSessionIds.length === 1, 'canonical pre-mount resume')
  assert.deepEqual(fixture.harness.resumeSessionIds, [id], 'the explicit full id bytes are passed through unchanged')
  assert.equal(fixture.listCalls(), 0, 'a canonical full id never needs the roster')
  assert.equal(fixture.harness.createdSessions.length, 0, 'a resume never creates a Session')
  assert.ok(!fixture.vt.getViewport().join('\n').includes('Search all workspaces'), 'a successful full-id resume opens no Browser')
})

test('a unique listed prefix resolves through the official roster', async (t) => {
  const life = testLifecycle(t)
  const target = `session-${'abcdef12'}${'0'.repeat(24)}`
  const other = `session-${'fedcba98'}${'0'.repeat(24)}`
  const fixture = await mountCli(life, {
    sessions: [listedSession('/placeholder', target, 2_000), listedSession('/placeholder', other, 1_000)],
    launch: { kind: 'lookup', query: 'abcdef12' },
  })
  await waitUntil(() => fixture.harness.resumeSessionIds.length === 1, 'unique prefix resume')
  assert.deepEqual(fixture.harness.resumeSessionIds, [target])
  assert.equal(fixture.listCalls(), 1, 'the launch admission reads the roster exactly once')
  assert.equal(fixture.harness.createdSessions.length, 0)
})

test('an ambiguous prefix opens the SAME Browser with the query and never auto-resumes', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountCli(life, {
    sessions: [
      listedSession('/placeholder', `session-${'abcd1111'}${'0'.repeat(24)}`, 2_000),
      listedSession('/placeholder', `session-${'abcd2222'}${'0'.repeat(24)}`, 1_000),
    ],
    launch: { kind: 'lookup', query: 'abcd' },
  })
  await waitUntil(() => fixture.vt.getViewport().join('\n').includes('abcd'), 'ambiguous Browser seeded query')
  assert.match(fixture.vt.getViewport().join('\n'), /Search all workspaces/u, 'the unmatched prefix opens the same global search editor')
  assert.deepEqual(fixture.harness.resumeSessionIds, [], 'an ambiguous prefix never guesses a row')
  assert.equal(fixture.harness.createdSessions.length, 0)
  // First Esc restores browse, the second closes the same Browser: no Session
  // and no Host open happens on the way out.
  fixture.vt.sendInput('\x1b')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\x1b')
  await fixture.vt.waitForRender()
  assert.ok(!fixture.vt.getViewport().join('\n').includes('Workspace: '), 'Esc returns to the sessionless Welcome')
  assert.deepEqual(fixture.harness.resumeSessionIds, [])
})

test('a word-like query searches even when a listed id starts with it', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountCli(life, {
    sessions: [listedSession('/placeholder', 'session-mysql-0001', 2_000)],
    launch: { kind: 'lookup', query: 'mysql' },
  })
  await waitUntil(() => fixture.vt.getViewport().join('\n').includes('Search all workspaces'), 'keyword Browser open')
  assert.deepEqual(fixture.harness.resumeSessionIds, [], 'a word is never an automatic Session prefix')
  assert.match(fixture.vt.getViewport().join('\n'), /mysql/u, 'the keyword is prefilled in the same global search')
})

test('a bare --session opens Browse All and starts no Session', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountCli(life, {
    sessions: [listedSession('/placeholder', 'session-alpha', 2_000)],
    launch: { kind: 'browse' },
  })
  await waitUntil(() => fixture.vt.getViewport().join('\n').includes('Sessions · 1'), 'browse Browser roster')
  assert.deepEqual(fixture.harness.resumeSessionIds, [], 'browse never auto-opens a row')
  assert.equal(fixture.harness.createdSessions.length, 0)
  fixture.vt.sendInput('\x1b')
  await fixture.vt.waitForRender()
  assert.ok(!fixture.vt.getViewport().join('\n').includes('Back [Esc]'), 'Esc returns to the sessionless Welcome')
})

// ── `-c, --continue` ────────────────────────────────────────────────────────

test('-c chooses the newest readable member of the CONFIRMED Host Workspace, not the global newest', async (t) => {
  const life = testLifecycle(t)
  const { registry } = createFakeHostWorkspaceRegistry()
  const workspace = await registry.create(process.cwd())
  workspace.sessionIds.push('s-old', 's-new')
  const fixture = await mountCli(life, {
    sessions: [
      listedSession(process.cwd(), 's-global-latest', 4_000),
      listedSession(process.cwd(), 's-new', 3_000),
      listedSession(process.cwd(), 's-old', 2_000),
    ],
    launch: { kind: 'continue' },
    registry,
  })
  await waitUntil(() => fixture.harness.resumeSessionIds.length === 1, '-c pre-mount resume')
  assert.deepEqual(fixture.harness.resumeSessionIds, ['s-new'],
    'the membership intersection keeps the official roster order; the foreign global newest is never chosen')
  assert.equal(fixture.harness.createdSessions.length, 0, 'continue never creates a Session')
  assert.ok(!fixture.vt.getViewport().join('\n').includes('Workspace: '), '-c never opens the Browser')
})

test('-c with no readable workspace member stays sessionless with ONE notice', async (t) => {
  const life = testLifecycle(t)
  const { registry } = createFakeHostWorkspaceRegistry()
  await registry.create(process.cwd())
  const fixture = await mountCli(life, {
    sessions: [listedSession(process.cwd(), 's-global-latest', 4_000)],
    launch: { kind: 'continue' },
    registry,
  })
  await waitUntil(() => fixture.probe.notices.some(note => note.includes('No readable sessions in this Host workspace')), 'continue empty notice')
  assert.deepEqual(fixture.harness.resumeSessionIds, [], 'an empty membership is never the global newest')
  assert.equal(fixture.harness.createdSessions.length, 0)
  assert.ok(!fixture.vt.getViewport().join('\n').includes('Workspace: '), '-c never falls back to the Browser')
})

test('-c fails closed with one notice when the Host Workspace authority refuses the launch', async (t) => {
  const life = testLifecycle(t)
  const registry: FakeHostWorkspaceRegistry = {
    create: async () => { throw new Error('workspace/path-invalid') },
    get: () => undefined,
    list: () => [],
  }
  const fixture = await mountCli(life, {
    sessions: [listedSession('/placeholder', 's-anywhere', 4_000)],
    launch: { kind: 'continue' },
    registry,
  })
  await waitUntil(() => fixture.probe.notices.some(note => note.includes('the Host workspace is not confirmed')), 'continue unconfirmed notice')
  assert.deepEqual(fixture.harness.resumeSessionIds, [], 'no unconfirmed Workspace ever reaches an Open')
  assert.equal(fixture.harness.createdSessions.length, 0)
  assert.ok(!fixture.vt.getViewport().join('\n').includes('Workspace: '))
})

test('-c keeps the ONE genuine Open failure and never retries or opens a Browser', async (t) => {
  const life = testLifecycle(t)
  const { registry } = createFakeHostWorkspaceRegistry()
  const workspace = await registry.create(process.cwd())
  workspace.sessionIds.push('s-new')
  const fixture = await mountCli(life, {
    sessions: [listedSession(process.cwd(), 's-new', 3_000)],
    launch: { kind: 'continue' },
    registry,
    resumeError: new Error('session is locked by another writer'),
  })
  await waitUntil(() => fixture.probe.notices.some(note => note.includes('could not be resumed')), 'continue open failure notice')
  assert.equal(fixture.harness.resumeSessionIds.length, 1, 'exactly ONE Open attempt, never a second candidate')
  assert.equal(fixture.harness.createdSessions.length, 0)
  assert.ok(!fixture.vt.getViewport().join('\n').includes('Workspace: '), '-c never opens the Browser on failure')
})

test('an exact configured session and a CLI launch intent refuse to start together', (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-cli-launch-conflict-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const ctx = new Context()
  ctx.provide('appExit', () => {})
  ctx.provide(TUI_STARTUP_SERVICE, {
    sessionId: 'session-exact',
    sessionLaunch: { kind: 'browse', query: '' },
  })
  assert.throws(
    () => applyRunnerWithRuntime(ctx, TuiConfigSchema({} as never), undefined),
    /exact configured session cannot be combined with a CLI Session launch intent/u,
    'two startup Session targets must fail before any Host session/read operation',
  )
})

test('a failed --session open keeps the Host error visible after the recovery Browser opens', async (t) => {
  const life = testLifecycle(t)
  const id = `session-${'b2'.repeat(16)}`
  const fixture = await mountCli(life, {
    sessions: [listedSession('/placeholder', id, 1_000)],
    launch: { kind: 'lookup', query: id },
    resumeError: new Error('session is locked by another writer'),
  })
  await waitUntil(() => fixture.harness.resumeSessionIds.length === 1, 'one genuine open attempt')
  await waitUntil(() => fixture.vt.getViewport().join('\n').includes('Search all workspaces'), 'recovery Browser admission')
  await waitUntil(() => fixture.probe.notices.some(note => note.includes('could not be resumed')), 'original Host error notice')
  const frame = fixture.vt.getViewport().join('\n')
  assert.match(frame, /could not be resumed/u, 'the original Host error is visible after the Browser admission')
  assert.equal(fixture.harness.resumeSessionIds.length, 1, 'a failed explicit open is never retried')
  assert.equal(fixture.harness.createdSessions.length, 0)
})
