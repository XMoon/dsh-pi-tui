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
import { RemoteSessionLifecycle } from '../src/runtime/remote/session-lifecycle-remote.ts'
import { loadExperimentalRemoteRuntime } from '../src/runtime/backend-loader.ts'
import { createRemoteApplicationHostFixture, waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

const FIXTURE_V1 = new URL('./fixtures/session-format/released-v1-real-shapes.jsonl', import.meta.url)
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

test('L5: a migration-required generation is listed read-only, refuses an explicit fork, and is never rewritten', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 's3-migration-preset')
  const fixtureText = readFileSync(FIXTURE_V1, 'utf8')
  const header = JSON.parse(fixtureText.slice(0, fixtureText.indexOf('\n'))) as { id: string; cwd?: string }
  const id = SessionId(header.id)

  // Seed a real session directory, then replace its current generation with the
  // released artifact (the same physical layout the official backend writes).
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
  const sourceHash = hashOf(sourcePath)

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
  // step), so the open must fail closed: no fabricated Session, no successor and
  // byte-identical source. The Client catalog keeps reporting the real artifact.
  const opened = await lifecycle.open({ sessionId: String(id) })
  if (opened.outcome.kind === 'opened') {
    const reference = sessions.binding(id) as unknown as { readonly ready?: Promise<unknown> } | undefined
    if (reference?.ready !== undefined) {
      const refusal = await reference.ready.then(() => undefined, (error: unknown) => error as Error)
      assert.ok(refusal !== undefined, 'the official open refusal must surface, never resolve as opened')
      assert.match(refusal.message, /cannot acquire a system head|surface before first step/u,
        `the refusal carries the official diagnostic: ${refusal.message}`)
    }
  } else {
    assert.equal(opened.outcome.kind, 'unavailable', 'a refused migration open is unavailable, never created')
  }
  await waitFor('the Client list still reports the released artifact', () =>
    sessions.list.getSnapshot().byId[id]?.formatStatus === 'migration-required')
  assert.equal(hashOf(sourcePath), sourceHash, 'the failed open never rewrites the released artifact')
  assert.deepEqual(generationFiles(sessionDir), [sourceName], 'a failed open publishes no successor')
})
