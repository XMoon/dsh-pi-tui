/**
 * The profile-owned ACP startup preference over the REAL DSH configuration plane
 * (`pi-tui-acp-preferences`).
 *
 * ```text
 * /settings decision state (DirectConfigPort.acpStartupPreference)
 *   -> official SettingsForms.mutate('pi-tui-acp-preferences', [{ set autoStart }])
 *   -> real ConfigEditor/USER profile document write
 *   -> a NEW Host cold boot reads value.autoStart from the SAME profile
 * ```
 *
 * FIXTURE MANIFEST
 * - REAL: the Loader root Include over a disposable profile + bundle, the
 *   official ConfigEditor and SettingsForms, the production
 *   `src/app/host/acp-preferences.ts` row (a thin ESM re-export shim is the only
 *   fixture module) and the production Direct config adapter.
 * - STAND-INS: none on this path. The preference row performs no work, so no
 *   Host business service is required.
 * - ABSENT: a model turn, a Remote Host, a real user DSH_HOME and the actual ACP
 *   listener (this suite proves the PREFERENCE, never the live state).
 * @module @xmoon76/dsh-pi-tui/test/integration/acp-startup-preference
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { parse as parseYaml } from 'yaml'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import {
  mountAcpPreferencesSettingsPlane,
  ACP_PREFERENCES_ROW_ID as ROW_ID,
} from '../support/acp-preferences-plane.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

interface Plane {
  readonly ctx: Context
  readonly port: DirectConfigPort
  readonly profileDir: string
  readonly patchPath: string
  dispose(): Promise<void>
}

async function bootPlane(
  life: TestLifecycle,
  root: string,
  options: { readonly resetUserDocument?: boolean; readonly disabledRow?: boolean } = {},
): Promise<Plane> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  const plane = await mountAcpPreferencesSettingsPlane(ctx, root, options)
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
  }
  life.defer(dispose)
  return {
    ctx,
    port: new DirectConfigPort(ctx, undefined, () => undefined),
    profileDir: plane.profileDir,
    patchPath: plane.patchPath,
    dispose,
  }
}

/** The Host's own settings projection of the preference section. */
function settingsDescriptor(plane: Plane): {
  readonly ns: string
  readonly value?: Record<string, unknown>
  readonly user?: Record<string, unknown>
  readonly revision?: number
} | undefined {
  return (plane.ctx as unknown as {
    settings: {
      describe(): readonly {
        ns: string
        value?: Record<string, unknown>
        user?: Record<string, unknown>
        revision?: number
      }[]
    }
  }).settings.describe().find(entry => entry.ns === ROW_ID)
}

test('a default profile projects autoStart=false with no USER override', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('acp-prefs-default-'))
  const state = plane.port.acpStartupPreference.read()
  assert.ok(state !== undefined, 'the profile must project the ACP startup preference section')
  assert.equal(state.autoStart, false, 'the schema default is OFF')
  assert.equal(state.userOverridden, false, 'the default is not a user choice')
  assert.equal(typeof state.revision, 'number', 'the decision fence is a real Host revision')

  const descriptor = settingsDescriptor(plane)
  assert.equal(descriptor?.value?.autoStart, false, 'the Host Settings form projects the effective OFF')
  assert.equal(descriptor?.user?.autoStart, undefined, 'no USER override is required for the default')
  assert.deepEqual(
    Object.keys(descriptor?.value ?? {}),
    ['autoStart'],
    'the section exposes the ONE field, never a mirror object',
  )
})

test('a revision-checked On write persists the USER patch and a NEW Host cold boot reads it', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('acp-prefs-persist-')
  const first = await bootPlane(life, root, { resetUserDocument: true })
  const before = first.port.acpStartupPreference.read()
  assert.ok(before !== undefined)
  assert.equal(before.autoStart, false)

  await first.port.acpStartupPreference.setAutoStart(true, before.revision)
  const after = first.port.acpStartupPreference.read()
  assert.ok(after !== undefined, 'the committed preference must be re-readable')
  assert.equal(after.autoStart, true, 'the authoritative read carries the committed On')
  assert.equal(after.userOverridden, true, 'the USER layer now owns the value')

  // The durable document is the profile's own USER patch, and it carries
  // exactly the one namespace/field — no second settings file.
  const document = parseYaml(readFileSync(first.patchPath, 'utf8')) as unknown
  const serialized = JSON.stringify(document)
  assert.match(serialized, new RegExp(ROW_ID, 'u'), 'the profile patch addresses the preference row')
  assert.match(serialized, /"autoStart":true|autoStart: true/u, 'the patch stores the committed On')
  assert.doesNotMatch(serialized, /tui-app/u, 'the preference never lands in the TUI settings document')

  // A NEW Host over the SAME profile reads the persisted On at boot — the fact
  // the cold-boot sequence consumes before Ready.
  await first.dispose()
  const second = await bootPlane(life, root)
  const restarted = second.port.acpStartupPreference.read()
  assert.ok(restarted !== undefined)
  assert.equal(restarted.autoStart, true, 'the next Host cold boot reads On')
  assert.equal(restarted.userOverridden, true)
  assert.equal(typeof restarted.revision, 'number', 'the restarted section exposes its own decision fence')
})

test('a stale revision is refused instead of overwriting an external change', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('acp-prefs-conflict-'), { resetUserDocument: true })
  const read = plane.port.acpStartupPreference.read()
  assert.ok(read !== undefined)
  // An external writer commits On and advances the revision.
  await plane.port.acpStartupPreference.setAutoStart(true, read.revision)
  const second = plane.port.acpStartupPreference.read()
  assert.ok(second !== undefined)

  await assert.rejects(
    plane.port.acpStartupPreference.setAutoStart(false, read.revision),
    /changed since it was read/u,
    'the official revision guard refuses the stale decision',
  )
  assert.equal(plane.port.acpStartupPreference.read()?.autoStart, true, 'the external change survived')
})

test('a DISABLED preference row contributes no writable section', async t => {
  const life = testLifecycle(t)
  const plane = await bootPlane(life, life.tempDir('acp-prefs-disabled-'), { disabledRow: true })
  assert.equal(settingsDescriptor(plane), undefined, 'a disabled row must not project a settings section')
  assert.equal(plane.port.acpStartupPreference.read(), undefined, 'and the adapter must not fabricate the default')
  await assert.rejects(
    plane.port.acpStartupPreference.setAutoStart(true, 1),
    /is not mounted/u,
    'a write against the missing section is refused, never silently applied',
  )
})
