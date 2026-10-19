/**
 * S4-D2 B05/B07/B08 — Host-tool runtime qualification over the real rc.2
 * Optional bundle patches (see `s4-d2-optional-bundle-fixture.ts`).
 *
 * This file is established first by D2-1 with the B05 off→enable→restart→real
 * tool registry proof; the remaining global-tool bundles join in D2-4.
 * @module @xmoon76/dsh-pi-tui/s4-d2-host-tools.test
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  S4_D2_BUNDLE_IDS,
  profileSelectsBundle,
  skippedInstallationReason,
  startS4D2Host,
  type S4D2BundleId,
} from './support/s4-d2-optional-bundle-fixture.ts'

const B05 = '@deepseek-ai/dsh-experimental-tool-worktree' satisfies S4D2BundleId

const skip = skippedInstallationReason([B05])

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A real local Git repository under the fixture root. */
function seedRepository(root: string): { project: string; baseCommit: string } {
  const project = join(root, 'work')
  mkdirSync(project, { recursive: true })
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'config', 'user.email', 's4-d2@example.invalid')
  git(project, 'config', 'user.name', 'S4 D2')
  writeFileSync(join(project, 'README.md'), 'S4-D2 worktree fixture\n')
  git(project, 'add', 'README.md')
  git(project, 'commit', '-q', '-m', 'fixture base')
  return { project, baseCommit: git(project, 'rev-parse', 'HEAD') }
}

function resultText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

test('D2-1/B05: an official Optional bundle goes off→enable→restart-required→restart→real tool', { skip }, async t => {
  let host = await startS4D2Host(t, { bundles: [] })
  const { project, baseCommit } = seedRepository(host.root)
  try {
    // OFF: the real Host tool registry does not carry the bundle's tool.
    assert.equal(host.hasTool('create_worktree'), false, 'B05 is not active before it is enabled')
    assert.equal(profileSelectsBundle(host.profileDir, B05), false)

    // ON through the OFFICIAL Host plugin manager: a startup-only profile
    // reports restart-required instead of pretending the tool went live.
    const enabled = await host.pluginManager.setBundleEnabled(B05, true) as {
      changed: boolean
      application: string
      restartReason?: unknown
    }
    assert.equal(enabled.changed, true)
    assert.equal(enabled.application, 'restart-required', `official enable result: ${JSON.stringify(enabled)}`)
    assert.notEqual(enabled.restartReason, undefined, 'the official result names why a restart is required')
    assert.equal(profileSelectsBundle(host.profileDir, B05), true, 'the official manager persisted the selection')

    // RESTART: a fresh real Context composes the real bundle patch.
    const restarted = await host.restart()
    host = restarted
    assert.ok(restarted.activeBundles.includes(B05), `restart composed ${JSON.stringify(restarted.activeBundles)}`)
    assert.equal(restarted.hasTool('create_worktree'), true, 'the official tool registry carries B05 after restart')

    // REAL TOOL: create a branch/worktree from a local commit and observe the
    // OFFICIAL working-directory projection, not the tool result alone.
    const agent = await restarted.createAgent(SessionId('s4-d2-b05'), { cwd: project })
    const result = await restarted.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('s4-d2-b05-call'),
      name: 'create_worktree',
      arguments: { name: 's4d2-worktree', from: baseCommit },
      agent,
    })
    assert.notEqual((result as { isError?: boolean }).isError, true, resultText(result))
    const created = JSON.parse(resultText(result)) as {
      path: string
      branch: string
      baseCommit: string
      repositoryRoot: string
    }
    assert.equal(created.branch, 's4d2-worktree')
    assert.equal(created.baseCommit, baseCommit)
    assert.equal(created.path, join(project, '.agents', 'worktrees', 's4d2-worktree'))
    assert.equal(existsSync(created.path), true, 'the real checkout exists on disk')
    assert.equal(created.repositoryRoot, project)
    assert.equal(git(created.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 's4d2-worktree')
    // The Session header keeps the ORIGINAL project; the EFFECTIVE cwd is the
    // official projection the TUI's status/fork/path readers consume.
    assert.equal(agent.session.header.cwd, project)
    const workingDirectory = restarted.ctx.get('workingDirectory') as { get(session: unknown): string }
    assert.equal(workingDirectory.get(agent.session), created.path)
    const projections = restarted.ctx.get('sessionProjections') as { stateOf(session: unknown, key: string): unknown }
    assert.equal(projections.stateOf(agent.session, 'workingDirectory'), created.path)

    // NEGATIVE: an invalid branch name is refused by the OFFICIAL runtime and
    // the Session's effective directory does not drift.
    const refused = await restarted.ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('s4-d2-b05-bad'),
      name: 'create_worktree',
      arguments: { name: '../escape', from: baseCommit },
      agent,
    })
    assert.equal((refused as { isError?: boolean }).isError, true, 'an invalid branch must fail')
    assert.match(resultText(refused), /relative Git branch name|branch/i)
    assert.equal(workingDirectory.get(agent.session), created.path, 'a refused create never moves the cwd')

    // OFF AGAIN: the official disable is also startup-only, and a restart
    // removes the tool from the real registry.
    const disabled = await restarted.pluginManager.setBundleEnabled(B05, false) as { application: string }
    assert.equal(disabled.application, 'restart-required')
    const off = await restarted.restart()
    host = off
    assert.equal(off.activeBundles.includes(B05), false)
    assert.equal(off.hasTool('create_worktree'), false, 'the tool is gone after the disabling restart')
  } finally {
    await host.dispose()
  }
  // The bundle identity set stays the plan's exact 14 (imported here so this
  // file fails if the fixture silently renames an identity).
  assert.equal(S4_D2_BUNDLE_IDS.length, 14)
})
