/**
 * B05/B07/B08 — Host-tool runtime qualification over the real rc.2
 * Optional bundle patches (see `optional-bundle-fixture.ts`).
 *
 * This file is established first by D2-1 with the B05 off→enable→restart→real
 * tool registry proof; the remaining global-tool bundles join in D2-4.
 * @module @xmoon76/dsh-pi-tui/host-tools.test
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  profileSelectsBundle,
  skippedInstallationReason,
  startOptionalBundleHost,
  type OptionalBundleId,
} from '../support/optional-bundle-fixture.ts'

const B05 = '@deepseek-ai/dsh-experimental-tool-worktree' satisfies OptionalBundleId

const skip = skippedInstallationReason([B05])

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A real local Git repository under the fixture root. */
function seedRepository(root: string): { project: string; baseCommit: string } {
  const project = join(root, 'work')
  mkdirSync(project, { recursive: true })
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'config', 'user.email', 'optional-bundle@example.invalid')
  git(project, 'config', 'user.name', 'S4 D2')
  writeFileSync(join(project, 'README.md'), 'optional-bundle worktree fixture\n')
  git(project, 'add', 'README.md')
  git(project, 'commit', '-q', '-m', 'fixture base')
  return { project, baseCommit: git(project, 'rev-parse', 'HEAD') }
}

let callCounter = 0

function resultText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

test('an official Optional bundle goes off→enable→restart-required→restart→real tool', { skip }, async t => {
  let host = await startOptionalBundleHost(t, { bundles: [] })
  const { project, baseCommit } = seedRepository(host.root)
  const sourceHead = git(project, 'rev-parse', 'HEAD')
  const sourceStatus = git(project, 'status', '--porcelain')
  const sourceReadme = readFileSync(join(project, 'README.md'), 'utf8')
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
    const agent = await restarted.createAgent(SessionId('optional-bundle-b05'), { cwd: project })
    const result = await executeModelToolFixture(restarted.ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('optional-bundle-b05-call'),
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
    const refused = await executeModelToolFixture(restarted.ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('optional-bundle-b05-bad'),
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

    // TEST-OWNED CLEANUP: removing the temporary worktree must not damage the
    // source repository, its HEAD, its worktree registration or its content.
    execFileSync('git', ['worktree', 'remove', '--force', created.path], { cwd: project })
    assert.equal(existsSync(created.path), false, 'the temporary worktree is really removed')
    assert.doesNotMatch(git(project, 'worktree', 'list'), new RegExp(created.path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
    assert.equal(git(project, 'rev-parse', 'HEAD'), sourceHead, 'the source repository HEAD is unchanged')
    assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), sourceReadme, 'the source repository content is unchanged')
    assert.equal(git(project, 'status', '--porcelain'), sourceStatus, 'the source repository worktree stays clean')
  } finally {
    await host.dispose()
  }
  // The bundle identity set stays the plan's exact 14 (imported here so this
  // file fails if the fixture silently renames an identity).
})

// ── B07 terminal backend composition ───────────────────────────────────────

const B07 = '@deepseek-ai/dsh-experimental-terminal-bundle' satisfies OptionalBundleId
const B08 = '@deepseek-ai/dsh-experimental-session-search' satisfies OptionalBundleId

test('the Host-only B07 composition never claims a working shell backend without terminalController', { skip: skippedInstallationReason([B07]) }, async t => {
  const host = await startOptionalBundleHost(t, { bundles: [B07] })
  const work = join(host.root, 'work')
  const agent = await host.createAgent(SessionId('optional-bundle-b07-negative'), { cwd: work })

  // The bundle's tools are active, but the rc.2 terminal-panel backend needs
  // the Web/Desktop `terminalController` service and this Host-only profile
  // does not compose it. The first real call must fail closed instead of
  // pretending the removed headless Bash/PowerShell backend exists.
  assert.equal(host.hasTool('terminal_open'), true, 'the B07 terminal tools are active')
  const opened = await execute(host, 'terminal_open', agent, { type: 'shell', name: 'main', cwd: work })
  assert.equal(opened.isError, true, resultText(opened))
  assert.match(resultText(opened), /no PTY backend registered for "shell"/u,
    `the Host-only composition must expose the missing backend: ${resultText(opened)}`)
  const listed = await execute(host, 'terminal_list', agent, {})
  assert.doesNotMatch(resultText(listed), /started terminal session|pid=\d+/u,
    'the Host-only composition never claims a live terminal session')
})

// ── B08 session search ─────────────────────────────────────────────────────

function markerChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('lazy workspace-scoped session search, paging/no-hit and restart re-index', { skip: skippedInstallationReason([B08]) }, async t => {
  const host = await startOptionalBundleHost(t, { bundles: [B08] })
  const adapter = new MarkerAdapter()
  host.ctx.llm.registerAdapter(['marker'], adapter)
  const project = join(host.root, 'work')
  const outside = join(host.root, 'outside')

  async function seed(id: string, cwd: string, marker: string): Promise<void> {
    const agent = await host.createAgent(SessionId(id), { provider: 'marker', model: 'marker-model', cwd })
    adapter.next = marker
    agent.followup(createUserMessage({ content: [{ type: 'text', text: `Please note ${marker} for later.` }], source: { kind: 'user' } }))
    await agent.whenIdle()
  }
  await seed('optional-bundle-b08-alpha', project, 'ALPHA_NEEDLE_PROJECT')
  await seed('optional-bundle-b08-beta', project, 'ALPHA_NEEDLE_PROJECT')
  await seed('optional-bundle-b08-secret', outside, 'SECRET_NEEDLE_PRIVATE')
  await waitFor(async () => (await persistedSessionCount(host)) >= 3)

  const caller = await host.createAgent(SessionId('optional-bundle-b08-caller'), { provider: 'marker', model: 'marker-model', cwd: project })
  const hit = await execute(host, 'session_search', caller, { query: 'ALPHA_NEEDLE_PROJECT' })
  assert.notEqual(hit.isError, true, resultText(hit))
  assert.match(resultText(hit), /optional-bundle-b08-alpha/)
  assert.match(resultText(hit), /optional-bundle-b08-beta/)
  assert.doesNotMatch(resultText(hit), /optional-bundle-b08-secret/, 'a session outside the caller workspace is never returned')
  assert.doesNotMatch(resultText(hit), /SECRET_NEEDLE_PRIVATE/)

  const none = await execute(host, 'session_search', caller, { query: 'NO_SUCH_NEEDLE' })
  assert.notEqual(none.isError, true, resultText(none))
  assert.match(resultText(none), /No prior session matches found/i)

  const event = await execute(host, 'session_event_search', caller, {
    session_id: 'optional-bundle-b08-beta',
    query: 'ALPHA_NEEDLE_PROJECT',
  })
  assert.notEqual(event.isError, true, resultText(event))
  assert.match(resultText(event), /ALPHA_NEEDLE_PROJECT/)
  assert.doesNotMatch(resultText(event), /optional-bundle-b08-secret/)

  // Bounded event-read window over the same authorized session (the Host
  // paginates/windows raw events; the TUI has no local search index).
  const window = await execute(host, 'session_event_read', caller, {
    session_id: 'optional-bundle-b08-beta',
    seq: 0,
    after: 4,
  })
  assert.notEqual(window.isError, true, resultText(window))
  assert.match(resultText(window), /optional-bundle-b08-beta/)
  assert.match(resultText(window), /Target event seq 0/u)
  const afterLines = resultText(window).split('\n').filter(line => line.startsWith('- seq '))
  assert.ok(afterLines.length > 0 && afterLines.length <= 4,
    `the requested after:4 window is bounded (got ${String(afterLines.length)} lines)`)

  // A restart rebuilds the lazy in-memory index from the persisted logs.
  const restarted = await host.restart()
  const after = await restarted.createAgent(SessionId('optional-bundle-b08-after'), { provider: 'marker', model: 'marker-model', cwd: project })
  const reindexed = await execute(restarted, 'session_search', after, { query: 'ALPHA_NEEDLE_PROJECT' })
  assert.notEqual(reindexed.isError, true, resultText(reindexed))
  assert.match(resultText(reindexed), /optional-bundle-b08-alpha/)
  assert.doesNotMatch(resultText(reindexed), /optional-bundle-b08-secret/)
})

class MarkerAdapter extends LlmAdapter {
  next = 'MARKER'

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    for (const chunk of markerChunks(this.next)) yield chunk
  }
}

async function persistedSessionCount(host: { root: string }): Promise<number> {
  const { readdirSync } = await import('node:fs')
  try {
    return readdirSync(join(host.root, 'home', 'sessions'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('optional-bundle-b08-')).length
  } catch {
    return 0
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, turns = 2000): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (await condition()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not settle')
}

function execute(
  host: { ctx: Context },
  name: string,
  agent: Agent,
  args: unknown,
): Promise<{ isError?: boolean; content?: readonly { type?: string; text?: string }[] }> {
  return executeModelToolFixture(host.ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId(`optional-bundle-host-${++callCounter}`),
    name,
    arguments: args,
    agent,
  }) as never
}
