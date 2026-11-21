/**
 * S4-D3 B05/B08 — the OFFICIAL rc.2 Optional bundle result in the
 * MOUNTED PiTui application (D3-4).
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the published rc.2 Optional bundle
 * packages + dsh-base family, the official profile/patch reader and `boot()`
 * Loader, the real Agent/Session/ToolRuntime/Job/terminal/session-query
 * services, the production TUI runner (`src/index.ts::apply`) mounted on the
 * SAME Context, and the existing Direct reader/status/job consumers.
 * `TEST STAND-INS`: the temporary profile/installation/home roots, the
 * scripted deterministic LLM transport and the VirtualTerminal.
 * `DELIBERATELY ABSENT`: the user's real DSH_HOME/credentials, network
 * installs, a physical terminal and any TUI screen row this fixture does not
 * mount.
 * @module @xmoon76/dsh-pi-tui/host-to-tui-tools.test
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  skippedInstallationReason,
  type OptionalBundleId,
  type S5OptionalBundleId,
} from '../support/optional-bundle-fixture.ts'
import { startS4D3Application } from '../support/application-fixture.ts'

const B05 = '@deepseek-ai/dsh-experimental-tool-worktree' satisfies OptionalBundleId
const B08 = '@deepseek-ai/dsh-experimental-session-search' satisfies OptionalBundleId

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

interface ToolScript {
  readonly kind: 'tool'
  readonly name: string
  readonly arguments: string
  readonly callId: string
}
type Script = ToolScript | { readonly kind: 'text'; readonly text: string }

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly scripts: Script[] = []
  readonly requests: string[] = []

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.requests.push(JSON.stringify(options.messages))
    const script = this.scripts.shift()
    if (script === undefined) {
      yield* textChunks('done')
      return
    }
    if (script.kind === 'text') {
      yield* textChunks(script.text)
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: script.callId as never,
      name: script.name,
      argumentsDelta: script.arguments,
    }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: script.callId as never, name: script.name, arguments: script.arguments },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function footerLine(view: string): string {
  const lines = view.split('\n')
  return lines.find(line => line.includes('[scripted/review-model]')) ?? ''
}

test('the real create_worktree result and effective cwd reach the mounted TUI', { skip: skippedInstallationReason([B05]) }, async t => {
  const app = await startS4D3Application(t, {
    bundles: [B05],
    presets: true,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
  })
  const adapter = new ScriptedAdapter()
  app.host.ctx.llm.registerAdapter(['scripted'], adapter)

  // A REAL local Git repository under the fixture's session root.
  const project = join(app.host.root, 'work')
  mkdirSync(project, { recursive: true })
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'config', 'user.email', 's4-d3@example.invalid')
  git(project, 'config', 'user.name', 'S4 D3')
  writeFileSync(join(project, 'README.md'), 'S4-D3 B05 fixture\n')
  git(project, 'add', 'README.md')
  git(project, 'commit', '-q', '-m', 'fixture base')
  const baseCommit = git(project, 'rev-parse', 'HEAD')
  const sourceHead = git(project, 'rev-parse', 'HEAD')
  const sourceReadme = readFileSync(join(project, 'README.md'), 'utf8')

  adapter.scripts.push(
    { kind: 'tool', name: 'create_worktree', callId: 's4d3-b05-create', arguments: JSON.stringify({ name: 's4d3-worktree', from: baseCommit }) },
    { kind: 'text', text: 'Worktree created.' },
  )
  const agent = await app.submitFirstPrompt('Create a worktree for the next task')
  await agent.whenIdle()
  await app.waitFor(() => app.view().includes('s4d3-worktree'), 'the real tool result in the transcript')
  const view = app.view()
  assert.match(view, /create_worktree/u, 'the real Host tool call is painted')
  assert.match(view, /s4d3-worktree/u, 'the real branch/path result is painted')
  assert.match(view, /Worktree created\./u, 'the following assistant turn settles in the transcript')

  const worktreePath = join(project, '.agents', 'worktrees', 's4d3-worktree')
  // The footer's cwd is the OFFICIAL effective directory projection, not the
  // immutable Session header (which keeps the original project).
  await app.waitFor(() => footerLine(app.view()).includes('s4d3-worktree'), 'the footer follows the effective cwd')
  assert.equal(agent.session.header.cwd, project, 'the Session header keeps the original project')
  const workingDirectory = app.host.ctx.get('workingDirectory') as { get(session: unknown): string }
  assert.equal(workingDirectory.get(agent.session), worktreePath)

  // NEGATIVE: an invalid worktree name fails in the real Host and never moves
  // the effective directory.
  adapter.scripts.push(
    { kind: 'tool', name: 'create_worktree', callId: 's4d3-b05-bad', arguments: JSON.stringify({ name: '../escape', from: baseCommit }) },
    { kind: 'text', text: 'The invalid request failed.' },
  )
  followup(agent, 'Attempt an invalid worktree')
  await agent.whenIdle()
  await app.waitFor(() => /relative Git branch name|branch/i.test(app.view()), 'the official refusal in the transcript')
  assert.equal(workingDirectory.get(agent.session), worktreePath, 'a refused create never moves the cwd')
  assert.match(footerLine(app.view()), /s4d3-worktree/u)

  // SESSION SWITCH: a fresh `/new` session starts from the launch project and
  // never inherits the previous session's effective worktree directory.
  adapter.scripts.push({ kind: 'text', text: 'Fresh session ready.' })
  for (const character of '/new') app.vt.sendInput(character)
  await app.waitFor(() => app.view().includes('❯ /new'), 'the painted /new command')
  app.vt.sendInput('\r')
  await app.waitFor(() => app.agent() !== undefined && String(app.agent()!.session.id) !== String(agent.session.id),
    'the production /new session transition')
  const second = app.requireAgent()
  followup(second, 'Start a fresh task')
  await second.whenIdle()
  await app.waitFor(() => app.view().includes('Fresh session ready.'), 'the fresh session answer')
  assert.notEqual(String(second.session.id), String(agent.session.id))
  assert.match(footerLine(app.view()), /dsh-optional-bundle-[^/]+\/work|s4d-pi-tui-wt\/s4-d3/u,
    'the fresh session cwd is the launch project')
  assert.doesNotMatch(footerLine(app.view()), /s4d3-worktree/u, 'the old session cwd never leaks into the new one')

  // TEST-OWNED CLEANUP: removing the temporary worktree never damages the
  // source repository's HEAD, content or cleanliness.
  execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: project })
  assert.equal(git(project, 'rev-parse', 'HEAD'), sourceHead, 'the source repository HEAD is unchanged')
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), sourceReadme, 'the source content is unchanged')
  assert.equal(git(project, 'status', '--porcelain'), '', 'the source worktree stays clean')
})

/** The committed text of one tool/result by call id. */
function toolResultOf(agent: Agent, callId: string): string | undefined {
  const events = agent.session.snapshotEvents() as readonly { readonly type?: string; readonly data?: unknown }[]
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = (event.data as { message?: { toolCallId?: string; content?: readonly { type?: string; text?: string }[] } }).message
    if (message?.toolCallId !== callId) continue
    return (message.content ?? []).map(block => block.text ?? '').join('')
  }
  return undefined
}

// ── B08 session search ─────────────────────────────────────────────────────

test('the official scoped session_search results reach the PiTui Tool output, never the Session Browser', { skip: skippedInstallationReason([B08]) }, async t => {
  const adapter = new ScriptedAdapter()
  const project = { path: '' }
  const app = await startS4D3Application(t, {
    bundles: [B08],
    presets: true,
    columns: 160,
    rows: 56,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: async host => {
      project.path = join(host.root, 'work')
      const outside = join(host.root, 'outside')
      mkdirSync(project.path, { recursive: true })
      mkdirSync(outside, { recursive: true })
      host.ctx.llm.registerAdapter(['scripted'], adapter)
      const seed = async (id: string, cwd: string, marker: string): Promise<void> => {
        const agent = await host.createAgent(id as never, { provider: 'scripted', model: 'review-model', cwd })
        adapter.scripts.push({ kind: 'text', text: `ACK ${marker}` })
        agent.followup(createUserMessage({ content: [{ type: 'text', text: `Please note ${marker} for later.` }], source: { kind: 'user' } }))
        await agent.whenIdle()
      }
      await seed('s4d3-b08-alpha', project.path, 'ALPHA_NEEDLE_PROJECT')
      await seed('s4d3-b08-beta', project.path, 'ALPHA_NEEDLE_PROJECT')
      await seed('s4d3-b08-secret', outside, 'SECRET_NEEDLE_PRIVATE')
    },
  })

  adapter.scripts.push(
    { kind: 'tool', name: 'session_search', callId: 's4d3-b08-hit', arguments: JSON.stringify({ query: 'ALPHA_NEEDLE_PROJECT' }) },
    { kind: 'tool', name: 'session_event_search', callId: 's4d3-b08-event', arguments: JSON.stringify({ session_id: 's4d3-b08-beta', query: 'ALPHA_NEEDLE_PROJECT' }) },
    { kind: 'tool', name: 'session_event_read', callId: 's4d3-b08-window', arguments: JSON.stringify({ session_id: 's4d3-b08-beta', seq: 0, after: 4 }) },
    { kind: 'tool', name: 'session_search', callId: 's4d3-b08-none', arguments: JSON.stringify({ query: 'NO_SUCH_NEEDLE' }) },
    { kind: 'tool', name: 'session_search', callId: 's4d3-b08-secret', arguments: JSON.stringify({ query: 'SECRET_NEEDLE_PRIVATE' }) },
    { kind: 'text', text: 'Session query round completed.' },
  )
  const agent = await app.submitFirstPrompt('Search prior sessions in this workspace')
  await agent.whenIdle()
  await app.waitFor(() => app.view().includes('s4d3-b08-beta'), 'the prior-session Tool output')
  // Ctrl+O is the EXISTING global expand; the full Host result becomes
  // readable in the same Tool card.
  app.vt.sendInput('\x0f')
  await app.settle()
  await app.waitFor(() => app.view().includes('s4d3-b08-alpha'), 'the expanded prior-session result')
  const view = app.view()
  assert.match(view, /s4d3-b08-alpha/u)
  assert.match(view, /s4d3-b08-beta/u)
  assert.match(view, /ALPHA_NEEDLE_PROJECT/u)
  assert.match(view, /No prior session matches found/iu, 'the official no-hit result is visible')
  assert.doesNotMatch(view, /s4d3-b08-secret/u, 'a session outside the caller workspace never appears')
  // Both the no-hit query and the outside-workspace query return the official
  // empty result (the caller's own query text is its tool argument, not a
  // leaked session fact).
  assert.ok((view.match(/No prior session matches found/giu) ?? []).length >= 2)

  // The Host query tool returns Tool output; it never injects its query into
  // the Session Browser's own search box.
  for (const character of '/sessions') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.settle()
  if (app.view().includes('❯ /sessions')) {
    app.vt.sendInput('\r')
    await app.settle()
  }
  const browser = app.view()
  assert.match(browser, /Sessions/u, 'the fullscreen Session Workspace opens')
  assert.match(browser, /Workspace: /u, 'the workspace keeps its own scope chrome')
  // The Host query is a Tool result; opening the workspace never carries that
  // query into its own raw editor. `/` focuses the workspace editor and it
  // must start empty.
  app.vt.sendInput('/')
  await app.waitFor(() => app.view().includes('Search:'), 'the workspace query editor')
  const editor = app.view()
  assert.match(editor, /Search:\s*$/mu, 'the workspace keeps its own EMPTY query editor')
  assert.doesNotMatch(editor, /ALPHA_NEEDLE_PROJECT/u, 'the Host query is not a Session Workspace search injection')
})

// ── Release-added Forge bundle: the same Host Git path, no GitHub ─────────

const FORGE_BUNDLE = '@deepseek-ai/dsh-experimental-forge-bundle' satisfies S5OptionalBundleId

interface DurableToolCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

/** The durable `tool/call` event of one call id (never the painted card). */
function toolCallOf(agent: Agent, callId: string): DurableToolCall | undefined {
  for (const event of agent.session.snapshotEvents() as readonly { readonly type?: string; readonly data?: unknown }[]) {
    if (event.type !== 'tool/call') continue
    const data = event.data as { readonly callId?: unknown; readonly name?: unknown; readonly arguments?: unknown }
    if (String(data?.callId) !== callId) continue
    return { callId: String(data.callId), name: String(data.name), arguments: String(data.arguments) }
  }
  return undefined
}

interface WorktreeRecord {
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  readonly repositoryRoot: string
}

/** The REAL Git registration set of one repository. */
function gitWorktrees(cwd: string): readonly { readonly path: string; readonly branch: string }[] {
  const output = git(cwd, 'worktree', 'list', '--porcelain')
  const entries: Array<{ path: string; branch: string }> = []
  let path = ''
  let branch = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (path !== '') entries.push({ path, branch })
      path = line.slice('worktree '.length)
      branch = ''
    } else if (line.startsWith('branch ')) {
      branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
    }
  }
  if (path !== '') entries.push({ path, branch })
  return entries
}

test('the experimental Forge bundle drives the real create_worktree Git/cwd path and the mounted TUI', { skip: skippedInstallationReason([FORGE_BUNDLE]) }, async t => {
  const app = await startS4D3Application(t, {
    bundles: [FORGE_BUNDLE],
    presets: true,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
  })
  const adapter = new ScriptedAdapter()
  app.host.ctx.llm.registerAdapter(['scripted'], adapter)

  // A REAL local Git repository: the only Forge prerequisite exercised here.
  const project = join(app.host.root, 'work')
  mkdirSync(project, { recursive: true })
  git(project, 'init', '-q', '-b', 'main')
  git(project, 'config', 'user.email', 's5-pr6@example.invalid')
  git(project, 'config', 'user.name', 'S5 PR6')
  writeFileSync(join(project, 'README.md'), 'S5-PR6 Forge fixture\n')
  git(project, 'add', 'README.md')
  git(project, 'commit', '-q', '-m', 'fixture base')
  const sourceHead = git(project, 'rev-parse', 'HEAD')
  const sourceReadme = readFileSync(join(project, 'README.md'), 'utf8')
  assert.equal(git(project, 'remote'), '', 'the fixture repository has NO GitHub remote')
  assert.equal(app.host.toolNames().filter(tool => tool === 'create_worktree').length, 1,
    'the composed Forge bundle declares the single official create_worktree schema')

  adapter.scripts.push(
    { kind: 'tool', name: 'create_worktree', callId: 's5-pr6-forge-create', arguments: JSON.stringify({ name: 's5-forge-worktree', from: sourceHead }) },
    { kind: 'text', text: 'Forge worktree created.' },
  )
  const agent = await app.submitFirstPrompt('Create the Forge worktree')
  await agent.whenIdle()
  assert.equal(app.host.toolNames(agent).filter(tool => tool === 'create_worktree').length, 1,
    'the calling Agent sees exactly one create_worktree schema')

  // The durable call is the official model request, not a test-side Git write.
  const call = toolCallOf(agent, 's5-pr6-forge-create')
  assert.ok(call !== undefined, 'the durable tool/call event exists')
  assert.equal(call.name, 'create_worktree')
  assert.deepEqual(JSON.parse(call.arguments), { name: 's5-forge-worktree', from: sourceHead })

  const resultText = toolResultOf(agent, 's5-pr6-forge-create')
  assert.ok(resultText !== undefined, 'the official tool/result is committed')
  const record = JSON.parse(resultText) as WorktreeRecord
  const expectedPath = join(project, '.agents', 'worktrees', 's5-forge-worktree')
  assert.equal(record.path, expectedPath, 'the official result reports the canonical checkout')
  assert.equal(record.baseCommit, sourceHead, 'the checkout is pinned to the real base commit')
  assert.equal(record.repositoryRoot, project, 'the source checkout is the fixture project')

  // Git owns the registration and the checkout really contains the base file.
  const registered = gitWorktrees(project).find(entry => entry.path === expectedPath)
  assert.ok(registered !== undefined, `git worktree list carries ${expectedPath}`)
  assert.equal(registered.branch, record.branch, 'the registered branch is the official result branch')
  assert.equal(readFileSync(join(expectedPath, 'README.md'), 'utf8'), sourceReadme, 'the base file was checked out')

  // The effective Session directory moved; the immutable header did not.
  const workingDirectory = app.host.ctx.get('workingDirectory') as { get(session: unknown): string }
  assert.equal(workingDirectory.get(agent.session), expectedPath)
  assert.equal(agent.session.header.cwd, project, 'the Session header keeps the launch checkout')
  await app.waitFor(() => app.view().includes('Forge worktree created.'), 'the assistant turn after the tool')
  await app.waitFor(() => footerLine(app.view()).includes('s5-forge-worktree'), 'the footer follows the effective cwd')
  assert.match(app.view(), /create_worktree/u, 'the real Host tool call is painted')
  assert.match(app.view(), /s5-forge-worktree/u, 'the real Host result is painted')

  // NEGATIVE: an illegal worktree name is refused by the official tool and no
  // Git registration, working directory or source content changes.
  const registrationsBefore = gitWorktrees(project)
  adapter.scripts.push(
    { kind: 'tool', name: 'create_worktree', callId: 's5-pr6-forge-refused', arguments: JSON.stringify({ name: '../escape', from: sourceHead }) },
    { kind: 'text', text: 'The invalid Forge request failed.' },
  )
  followup(agent, 'Attempt an invalid Forge worktree')
  await agent.whenIdle()
  const refused = toolResultOf(agent, 's5-pr6-forge-refused')
  assert.match(refused ?? '', /relative Git branch name|branch/iu, 'the official tool refuses the illegal name')
  assert.deepEqual(gitWorktrees(project), registrationsBefore, 'a refused call registers no new worktree')
  assert.equal(workingDirectory.get(agent.session), expectedPath, 'a refused call never moves the cwd')
  assert.match(footerLine(app.view()), /s5-forge-worktree/u)
  assert.equal(git(project, 'rev-parse', 'HEAD'), sourceHead, 'the source HEAD is unchanged')
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), sourceReadme, 'the source content is unchanged')
  await app.waitFor(() => app.view().includes('The invalid Forge request failed.'), 'the refusal turn settles')

  // The /new Session starts from the launch project, never the Forge checkout.
  adapter.scripts.push({ kind: 'text', text: 'Fresh Forge session ready.' })
  for (const character of '/new') app.vt.sendInput(character)
  await app.waitFor(() => app.view().includes('❯ /new'), 'the painted /new command')
  app.vt.sendInput('\r')
  await app.waitFor(() => app.agent() !== undefined && String(app.agent()!.session.id) !== String(agent.session.id),
    'the production /new session transition')
  const second = app.requireAgent()
  followup(second, 'Start a fresh Forge session')
  await second.whenIdle()
  await app.waitFor(() => app.view().includes('Fresh Forge session ready.'), 'the fresh session answer')
  assert.notEqual(String(second.session.id), String(agent.session.id))
  assert.doesNotMatch(footerLine(app.view()), /s5-forge-worktree/u, 'the new Session never inherits the Forge worktree')
  assert.equal(workingDirectory.get(second.session), project, 'the new Session starts from the launch project')

  // TEST-OWNED CLEANUP: remove the temporary checkout; the source stays clean.
  execFileSync('git', ['worktree', 'remove', '--force', record.path], { cwd: project })
  assert.equal(git(project, 'rev-parse', 'HEAD'), sourceHead)
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), sourceReadme)
  assert.equal(git(project, 'status', '--porcelain'), '')
})
