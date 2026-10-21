/**
 * S2/PR-B §B4 / C30 — the OFFICIAL credential precedence (L5).
 *
 * The managed `$DSH_HOME/.credentials.yaml` store outranks the launch
 * environment, which outranks the invoking project's `.env`, which outranks the
 * harness-home `.env`; a saved value immediately wins over every environment
 * layer, and an unset value falls back to them. The TUI never re-implements
 * this order and never treats `source=env` as a stored secret record.
 *
 * FIXTURE (real): the official `dsh-credentials-local` service over an isolated
 * store, and the official `createLaunchEnvironmentSnapshot` with all three
 * layers. STAND-INS: the layer VALUES (controlled by the test) only.
 * ABSENT: the user's real `~/.dsh`, network, an Agent.
 *
 * @module @xmoon76/dsh-pi-tui/credentials-precedence-local.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const REF = credentialRef('DEEPSEEK_API_KEY')
const PROJECT_REF = credentialRef('PROJECT_ONLY_KEY')
const HOME_REF = credentialRef('HOME_ONLY_KEY')
const MISSING_REF = credentialRef('MISSING_KEY')

interface Fixture {
  readonly ctx: Context
  readonly credentials: {
    resolve(ref: unknown): Promise<{ value: string; source: string } | undefined>
    describe(ref: unknown): Promise<{ configured: boolean; source?: string; writable?: boolean }>
    set(ref: unknown, value: string): Promise<unknown>
    unset(ref: unknown): Promise<unknown>
  }
  readonly logs: string[]
}

/** Mount the real credential store over a controlled three-layer snapshot. */
async function boot(life: TestLifecycle, workRoot: string, path?: string): Promise<Fixture> {
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  const logs: string[] = []
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
    { source: 'process', values: { DEEPSEEK_API_KEY: 'from-process' } },
    { source: 'project-env', values: { PROJECT_ONLY_KEY: 'from-project' }, path: join(workRoot, 'project', '.env') },
    { source: 'user-env', values: { HOME_ONLY_KEY: 'from-home' }, path: join(workRoot, '.env') },
  ]) as never)
  ctx.provide('logger', {
    info: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    warn: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    error: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
    debug: (...args: unknown[]) => { logs.push(args.map(String).join(' ')) },
  } as never)
  await ctx.plugin(LocalCredentials, { path: path ?? join(workRoot, '.credentials.yaml'), watch: false })
  return { ctx, credentials: ctx.get('credentials') as Fixture['credentials'], logs }
}

test('the managed store outranks the launch environment, which outranks the .env layers', async t => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-s2b-cred-')
  const fixture = await boot(life, workRoot)

  // Environment precedence exactly as the official contract states.
  assert.deepEqual(await fixture.credentials.resolve(REF), { value: 'from-process', source: 'env' })
  assert.equal((await fixture.credentials.resolve(PROJECT_REF))?.source, 'project-env')
  assert.equal((await fixture.credentials.resolve(HOME_REF))?.source, 'user-env')
  assert.equal(await fixture.credentials.resolve(MISSING_REF), undefined)
  // Presence/source are the same facts the TUI shows; the VALUE never rides.
  assert.deepEqual(await fixture.credentials.describe(REF), { configured: true, source: 'env', writable: true })

  // A stored value immediately wins over every environment layer...
  await fixture.credentials.set(REF, 'stored-value')
  assert.deepEqual(await fixture.credentials.resolve(REF), { value: 'stored-value', source: 'file' })
  assert.deepEqual(await fixture.credentials.describe(REF), { configured: true, source: 'file', writable: true })
  // ...and clearing it restores the environment fallback (never a stale value).
  await fixture.credentials.unset(REF)
  assert.deepEqual(await fixture.credentials.resolve(REF), { value: 'from-process', source: 'env' })
  assert.equal((await fixture.credentials.describe(REF)).source, 'env')

  // No secret ever reaches the logger.
  for (const line of fixture.logs) {
    assert.ok(!line.includes('stored-value'), `a secret reached the log: ${line}`)
    assert.ok(!line.includes('from-process'), `an environment secret reached the log: ${line}`)
  }
})

test('a value written by another process is read back by a fresh store (external reload/read)', async t => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-s2b-cred-reload-')
  const path = join(workRoot, '.credentials.yaml')
  const first = await boot(life, workRoot, path)
  await first.credentials.set(REF, 'saved-by-this-process')
  await first.ctx.fiber.dispose()

  // A SECOND store instance reads the same file: the durable layer is the file,
  // not any in-process cache.
  const second = await boot(life, workRoot, path)
  assert.deepEqual(await second.credentials.resolve(REF), { value: 'saved-by-this-process', source: 'file' })
  assert.deepEqual(await second.credentials.describe(REF), { configured: true, source: 'file', writable: true })
})
