/**
 * S3 §C2.5 — old-generation data handling over the experimental Remote
 * Host/Client graph (L5).
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the ordinary real rc.2 Host fixture (real JSONL persistence on an isolated
 *   root, real session-query engine, real Session Controller, Gateway,
 *   RemoteAccess, the official in-process Client carrier)
 * - the REAL committed released-v1 product artifact
 *   (`test/fixtures/session-format/released-v1-real-shapes.jsonl`) placed as the
 *   official physical generation, exactly as the JSONL backend writes it
 *
 * TEST STAND-INS
 * - the fixture's readiness values only (see `remote-application-fixture.ts`)
 *
 * DELIBERATELY ABSENT
 * - the user's real DSH_HOME, network, a model request, M4 IPC
 *
 * @module @xmoon76/dsh-pi-tui/remote-session-migration-rc2.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { RemoteSessionLifecycle } from '../../src/runtime/remote/session-lifecycle-remote.ts'
import { loadExperimentalRemoteRuntime } from '../../src/runtime/backend-loader.ts'
import { createRemoteSessionOwnerServices } from '../../src/app/remote/session-owners.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import {
  bindSessionRuntime,
  type SessionRuntimeSurface,
} from '../../src/app/session/runtime.ts'
import type { SessionOwnerRef } from '../../src/app/session/subject.ts'
import {
  LifecycleError,
  requireOpened,
  type SessionHandle,
} from '../../src/runtime/session-lifecycle-port.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { createRemoteApplicationHostFixture, waitFor } from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const FIXTURE_V1 = new URL('../fixtures/session-format/released-v1-real-shapes.jsonl', import.meta.url)
const CURRENT_SUFFIX = '.zstd'

/** The generation artifacts in one session directory (the lock file is not a
 *  generation). */
function generationFiles(dir: string): string[] {
  return readdirSync(dir).filter(name => name.startsWith('session.') && name !== 'session.lock').sort()
}

/** Place one plain-JSONL artifact as the official physical generation: zstd
 *  frames [header line][body], exactly what the JSONL backend writes. */
function placeArtifact(target: string, plainJsonl: string): void {
  const newline = plainJsonl.indexOf('\n')
  assert.ok(newline > 0, 'the artifact needs a header line')
  writeFileSync(target, Buffer.concat([
    zstdCompressSync(Buffer.from(plainJsonl.slice(0, newline + 1))),
    zstdCompressSync(Buffer.from(plainJsonl.slice(newline + 1))),
  ]))
}

/** The single stored session directory materialized under one persistence root. */
function sessionDirOf(root: string): string {
  const projects = readdirSync(root)
  assert.equal(projects.length, 1, 'exactly one project directory')
  const dirs = readdirSync(join(root, projects[0]!))
  assert.equal(dirs.length, 1, 'exactly one session directory')
  return join(root, projects[0]!, dirs[0]!)
}

function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Seed one REAL session directory and replace its current generation with the
 *  released-v1 artifact, exactly as the official persistence layout stores it. */
async function seedMigrationArtifact(
  host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>,
): Promise<{ readonly id: ReturnType<typeof SessionId>; readonly sourcePath: string; readonly sourceHash: string; readonly sessionDir: string; readonly sourceName: string }> {
  const fixtureText = readFileSync(FIXTURE_V1, 'utf8')
  const header = JSON.parse(fixtureText.slice(0, fixtureText.indexOf('\n'))) as { id: string; cwd?: string }
  const id = SessionId(header.id)
  const persistence = host.ctx.get('sessionPersistence') as SessionPersistence
  const seed = await persistence.create({
    id,
    createdAt: 1,
    version: SESSION_FORMAT_VERSION,
    cwd: header.cwd as string,
    isSeeded: false,
    delegationDepth: 0,
  })
  await seed.flush()
  await seed.close()
  const sessionDir = sessionDirOf(join(host.workRoot, 'persistence'))
  rmSync(join(sessionDir, `session.v${SESSION_FORMAT_VERSION}.jsonl${CURRENT_SUFFIX}`), { force: true })
  const sourceName = 'session.v1.jsonl.zstd'
  const sourcePath = join(sessionDir, sourceName)
  placeArtifact(sourcePath, fixtureText)
  return { id, sourcePath, sourceHash: hashOf(sourcePath), sessionDir, sourceName }
}

test('a migration-required generation is listed read-only, refuses an explicit fork, and is never rewritten', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 's3-migration-preset')
  const { id, sourcePath, sourceHash, sessionDir, sourceName } = await seedMigrationArtifact(host)

  const runtime = await (await loadExperimentalRemoteRuntime()).createExperimentalRemoteRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  life.defer(() => runtime.dispose().catch(() => {}))
  const sessions = runtime.client.sessions
  await sessions.refresh()
  const listed = sessions.list.getSnapshot().byId[id]
  assert.ok(listed !== undefined, 'the released artifact is listed by the real Host/Client graph')
  assert.equal(listed?.formatStatus, 'migration-required',
    'the official Client reports the released artifact as needing migration')

  const lifecycle = new RemoteSessionLifecycle(sessions, runtime.client.connection.generation)
  // The TUI fork always refuses implicit migration, and the official Host then
  // refuses a fork of a source that needs migration.
  const forked = await lifecycle.fork({ sourceSessionId: String(id) })
  assert.equal(forked.outcome.kind, 'rejected',
    `an explicit no-migration fork must be refused: ${forked.ownership}/${forked.outcome.kind}`)
  assert.equal(forked.outcome.kind === 'rejected' ? forked.outcome.error.code : undefined,
    'session/migration-required')
  assert.equal(hashOf(sourcePath), sourceHash, 'a refused fork never rewrites the released artifact')
  assert.deepEqual(generationFiles(sessionDir), [sourceName], 'a refused fork publishes no successor')

  // An explicit user open starts the official migration. THIS released artifact
  // is one the official promotion refuses (its surface events precede the first
  // step), so the open must fail closed. The official Client surfaces that on
  // the exact retained generation's snapshot (`openState`/`openError`) — the
  // settled readiness is asserted UNCONDITIONALLY, never behind an optional cast
  // that could silently skip the central assertion.
  const reference = sessions.retain(id, { source: 'tuiMainView' })
  const binding = await reference.ready
  const snapshot = (binding.session as unknown as {
    getSnapshot(): { readonly openState: string; readonly openError: { readonly message?: unknown } | null }
  }).getSnapshot()
  reference.release()
  assert.equal(snapshot.openState, 'error', 'the official initial open settles in the error state')
  assert.ok(snapshot.openError !== null, 'the error state carries the official failure')
  assert.match(String(snapshot.openError?.message),
    /cannot acquire a system head|surface before first step/u,
    `the refusal carries the official diagnostic: ${String(snapshot.openError?.message)}`)
  assert.equal(hashOf(sourcePath), sourceHash, 'the failed open never rewrites the released artifact')
  assert.deepEqual(generationFiles(sessionDir), [sourceName], 'a failed open publishes no successor')
  await waitFor('the Client list still reports the released artifact', () =>
    sessions.list.getSnapshot().byId[id]?.formatStatus === 'migration-required')
})

/**
 * L5 app-runtime failure: a REAL Host → official Client → `SessionRuntime`
 * explicit open of the released-v1 artifact. The official `Session.doOpen`
 * records `openState: 'error'` and RESOLVES the reference's ready promise, so
 * the application commit boundary must read the state, keep the old owner and
 * its draft, release the failed reference exactly once, and never report a
 * committed switch.
 */
test('a failed Remote open never replaces the current Session, its draft, or reports success', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 's3-open-failure-preset')
  const { id: migrationId } = await seedMigrationArtifact(host)
  const runtime = await (await loadExperimentalRemoteRuntime()).createExperimentalRemoteRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  life.defer(() => runtime.dispose().catch(() => {}))
  const sessions = runtime.client.sessions
  await sessions.refresh()
  assert.equal(sessions.list.getSnapshot().byId[migrationId]?.formatStatus, 'migration-required',
    'the target is the real migration-required artifact')

  const lifecycle = new RemoteSessionLifecycle(sessions, runtime.client.connection.generation)
  const currentId = 'session-open-failure-current'
  const created = await lifecycle.create({ sessionId: currentId, cwd: host.anchorDir })
  assert.equal(created.outcome.kind, 'created', `the current Session must be created: ${created.ownership}/${created.outcome.kind}`)
  if (created.outcome.kind !== 'created') throw new Error('unreachable')
  const handleA: SessionHandle = created.outcome.handle
  await waitFor('the current Session history opens', () =>
    sessions.binding(SessionId(currentId))?.session.getSnapshot().openState === 'open')

  const services = createRemoteSessionOwnerServices({
    binding: (id: string) => sessions.binding(SessionId(id)),
  }, runtime.client.connection.generation)
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  const events: string[] = []
  let draft = 'unsent draft survives'
  let unpinnedDraftsCleared = 0
  const surface: SessionRuntimeSurface = {
    warnRetirement: () => {},
    warnRetirementSkipped: () => {},
    isSurfaceDisposed: () => false,
    beginOpening: (sessionId) => { events.push(`opening:${sessionId}`); return sessionId },
    clearOpening: () => { events.push('clearOpening') },
    settlePendingQueueRecalls: (committed) => { events.push(`recalls:${committed}`) },
    settleLocalSubmitAck: () => {},
    resetSubmitLatency: () => {},
    setCompletionOwner: () => {},
    initLiveSession: async (owner: SessionOwnerRef) => { events.push(`init:${services.owners.sessionId(owner)}`) },
    refreshLiveCatalog: async () => {},
    reportSwitch: (from, to: SessionOwnerRef) => { events.push(`switch:${from ?? ''}->${services.owners.sessionId(to)}`) },
    clearUnpinnedDrafts: () => { unpinnedDraftsCleared += 1 },
    dropOutgoingActiveDraft: () => { draft = ''; events.push('dropDraft') },
    withdrawReplacedPresentation: () => {},
    beginInputHistoryScope: () => {},
    retireStaleHistorySeat: () => {},
    reportSwitchFailure: (sessionId) => { events.push(`switchFailure:${sessionId}`) },
    launchComposition: async () => ({ composition: {} }),
    setResumeFailure: () => {},
    reportFirstSessionCreateFailure: () => {},
    notifyResumeFailure: () => {},
    awaitPendingDefaultWrite: async () => {},
    newSessionId: () => 'session-first',
    sessionCreateCwd: () => host.anchorDir,
    currentOpening: () => undefined,
    resetOpening: () => {},
  }
  const controller = new AbortController()
  const diag: Diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }
  const sessionRuntime = bindSessionRuntime(core, {
    owners: services.owners,
    retirement: services.retirement,
    lifecycle,
    lifecycleSignal: controller.signal,
    surface,
    isScopeCurrent: () => true,
    diag,
  })
  sessionRuntime.publishResumedOwner(handleA, () => undefined)
  assert.equal(core.currentSessionId(), currentId, 'the current Session is published before the failed switch')
  const oldOwner = core.owner()
  assert.ok(oldOwner !== undefined)

  // Record the exact release count of the failed target's reference. The
  // recorder calls the production retain with its real receiver and returns a
  // transparent wrapper; only release() is counted.
  const originalRetain = sessions.retain
  const releases = new Map<string, number>()
  sessions.retain = function recordedRetain(
    this: unknown,
    target: Parameters<typeof originalRetain>[0],
    options: Parameters<typeof originalRetain>[1],
  ): ReturnType<typeof originalRetain> {
    const reference = originalRetain.call(sessions, target, options)
    const sessionIdText = reference.sessionId
    if (!releases.has(sessionIdText)) releases.set(sessionIdText, 0)
    return {
      get sessionId() { return reference.sessionId },
      get binding() { return reference.binding },
      get ready() { return reference.ready },
      release: () => {
        releases.set(sessionIdText, (releases.get(sessionIdText) ?? 0) + 1)
        reference.release()
      },
    } as ReturnType<typeof originalRetain>
  } as typeof sessions.retain
  try {
    const result = await sessionRuntime.switchSession(String(migrationId))
    assert.equal(typeof result, 'string', 'the failed open returns a bounded error, never a success')
    assert.match(result!, /failed to open/u, result)
    assert.match(result!, /cannot acquire a system head|surface before first step/u,
      'the notice carries the official open failure')
    assert.equal(core.currentSessionId(), currentId, 'the current Session stays the visible owner')
    assert.equal(core.owner(), oldOwner, 'the exact current owner generation is untouched')
    assert.equal(draft, 'unsent draft survives', 'the active draft is not dropped by a failed switch')
    assert.equal(unpinnedDraftsCleared, 0, 'no per-session draft clear runs on a failed switch')
    assert.equal(events.some(event => event.startsWith('switch:')), false, 'no success switch is reported')
    assert.equal(events.some(event => event === `init:${String(migrationId)}`), false,
      'the failed target is never hydrated as the live Session')
    assert.equal(releases.get(String(migrationId)), 1, 'the failed target reference is released exactly once')
    assert.equal(sessions.binding(migrationId), undefined,
      'the failed target generation is gone, not leaked')

    // The `--session` startup and the post-fork adoption unwrap the SAME
    // lifecycle settlement through `requireOpened` (bootstrap.ts and
    // adoptFork). A second explicit attempt proves the startup boundary sees
    // the same unavailable settlement — never a false owner it could publish.
    const startupOpen = await lifecycle.open({ sessionId: String(migrationId) })
    assert.equal(startupOpen.outcome.kind, 'unavailable')
    assert.throws(
      () => requireOpened(startupOpen),
      (error: unknown) => error instanceof LifecycleError && error.settlement === 'unavailable',
      'the startup/adoption unwrap rejects instead of publishing a dead target',
    )
    assert.equal(releases.get(String(migrationId)), 2,
      'the startup attempt releases its own failed reference exactly once')
    assert.equal(sessions.binding(migrationId), undefined)
  } finally {
    sessions.retain = originalRetain
  }
})
