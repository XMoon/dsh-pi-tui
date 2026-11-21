/**
 * Session Workspace PR1 real Direct Host-context proof.
 *
 * The Direct adapter unit test uses a structural controller fake. This suite
 * mounts the REAL official plugins the Direct profile rows load
 * (`@deepseek-ai/dsh-host-directory-picker-browse` providing the `browse`
 * capability, and the `DirectoryPickerController` Host handler) in a real
 * Cordis Host Context, points the process home at an isolated Host account,
 * and reads through the production `DirectHostDirectoryBrowsePort`.
 *
 * It proves the positive Direct chain the plan requires:
 *
 *   Direct Host Context -> ctx.directoryPickerController
 *     -> official BrowseDirectoryPicker -> Host filesystem home / explicit level
 *     -> Backend.hostDirectoryBrowse outcome
 *
 * and that the read creates no Workspace or Session (no such Host service is
 * mounted at all).
 *
 * @module @xmoon76/dsh-pi-tui/host-directory-browse-direct-host.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import BrowseDirectoryPicker from '@deepseek-ai/dsh-host-directory-picker-browse'
import { DirectoryPickerController } from '@deepseek-ai/dsh-api-workspace-controller'
import type { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'
import { DirectHostDirectoryBrowsePort } from '../../../src/runtime/direct/host-directory-browse-direct.ts'
import { testLifecycle } from '../../support/temp-lifecycle.ts'

test('the Direct port reads the REAL official controller and browse backend', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pr1-direct-host-')
  const hostHome = join(root, 'home')
  const marker = join(hostHome, 'pi-tui-pr1-proof')
  mkdirSync(join(marker, 'alpha'), { recursive: true })
  mkdirSync(join(marker, '.hidden-child'), { recursive: true })
  writeFileSync(join(marker, 'not-a-directory.txt'), 'pr1\n')

  // The official browse backend reads the Host account home through
  // `os.homedir()`. Point this test process at the isolated Host account for
  // the duration of the test only.
  const originalHome = process.env.HOME
  process.env.HOME = hostHome
  life.defer(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
  })

  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  // The exact official plugins the Direct profile rows load: ONE browse
  // backend (the seam) and the Workspace Controller's child Remote handler.
  await ctx.plugin(BrowseDirectoryPicker, { maxEntries: 1_000 })
  await ctx.plugin(DirectoryPickerController)
  const picker = ctx.get('directoryPicker') as DirectoryPicker | undefined
  assert.ok(picker !== undefined, 'the official directoryPicker seam is not mounted')
  assert.equal(picker.capability().kind, 'browse', 'the mounted official backend is not the browse capability')
  assert.ok(ctx.get('directoryPickerController') !== undefined,
    'the official DirectoryPickerController service is not mounted')
  // A read must never create Host business state; neither authority exists in
  // this real Host Context, so no write path is reachable here.
  assert.equal(ctx.get('workspaceRegistry'), undefined)
  assert.equal(ctx.get('sessions'), undefined)

  // The adapter resolves exactly the official controller service.
  const gets: string[] = []
  const port = new DirectHostDirectoryBrowsePort({
    get(name: string): unknown {
      gets.push(name)
      return ctx.get(name)
    },
  })
  const signal = new AbortController().signal

  // Sessionless home read: the REAL Host account home, with the marker level.
  const home = await port.list(undefined, signal)
  assert.equal(home.kind, 'ready')
  assert.ok(home.kind === 'ready')
  assert.equal(realpathSync(home.listing.home), realpathSync(hostHome),
    'list(undefined) did not return the Host account home')
  assert.equal(realpathSync(home.listing.path), realpathSync(hostHome))
  assert.ok(home.listing.entries.some(entry => entry.name === 'pi-tui-pr1-proof'),
    `the Host home listing lost the marker level: ${JSON.stringify(home.listing.entries)}`)

  // Explicit absolute level: only the child directories, hidden flag kept.
  const level = await port.list(marker, signal)
  assert.equal(level.kind, 'ready')
  assert.ok(level.kind === 'ready')
  assert.equal(realpathSync(level.listing.path), realpathSync(marker))
  assert.deepEqual(level.listing.entries.map(entry => entry.name).sort(), ['.hidden-child', 'alpha'])
  assert.equal(level.listing.entries.find(entry => entry.name === '.hidden-child')?.hidden, true)
  assert.equal(level.listing.entries.find(entry => entry.name === 'alpha')?.hidden, false)
  assert.equal(level.listing.truncated, false)

  // The official Host refusal is a path failure, from the real handler.
  const missing = await port.list(join(hostHome, 'pr1-missing-level'), signal)
  assert.equal(missing.kind, 'failed')
  assert.ok(missing.kind === 'failed')
  assert.equal(missing.code, 'directory-picker/unreadable')
  const relative = await port.list('relative-not-fully-qualified', signal)
  assert.equal(relative.kind, 'failed')
  assert.ok(relative.kind === 'failed')
  assert.equal(relative.code, 'directory-picker/unreadable')

  assert.deepEqual(gets, [
    'directoryPickerController',
    'directoryPickerController',
    'directoryPickerController',
    'directoryPickerController',
  ], 'the Direct adapter must resolve only the official controller per read')
})
