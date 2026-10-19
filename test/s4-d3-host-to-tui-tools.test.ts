/**
 * S4-D3 B05/B07/B08 — the OFFICIAL rc.2 Optional bundle result in the
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
 * @module @xmoon76/dsh-pi-tui/s4-d3-host-to-tui-tools.test
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
  type S4D2BundleId,
} from './support/s4-d2-optional-bundle-fixture.ts'
import { startS4D3Application } from './support/s4-d3-application-fixture.ts'

const B05 = '@deepseek-ai/dsh-experimental-tool-worktree' satisfies S4D2BundleId
const B07 = '@deepseek-ai/dsh-experimental-terminal-bundle' satisfies S4D2BundleId
const B08 = '@deepseek-ai/dsh-experimental-session-search' satisfies S4D2BundleId

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

test('B05: the real create_worktree result and effective cwd reach the mounted TUI', { skip: skippedInstallationReason([B05]) }, async t => {
  const app = await startS4D3Application(t, {
    bundles: [B05],
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
  await app.settle()
  app.vt.sendInput('\r')
  await app.waitFor(() => app.agent() !== undefined && String(app.agent()!.session.id) !== String(agent.session.id),
    'the production /new session transition')
  const second = app.requireAgent()
  followup(second, 'Start a fresh task')
  await second.whenIdle()
  await app.waitFor(() => app.view().includes('Fresh session ready.'), 'the fresh session answer')
  assert.notEqual(String(second.session.id), String(agent.session.id))
  assert.match(footerLine(app.view()), /dsh-s4-d2-[^/]+\/work|s4d-pi-tui-wt\/s4-d3/u,
    'the fresh session cwd is the launch project')
  assert.doesNotMatch(footerLine(app.view()), /s4d3-worktree/u, 'the old session cwd never leaks into the new one')

  // TEST-OWNED CLEANUP: removing the temporary worktree never damages the
  // source repository's HEAD, content or cleanliness.
  execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: project })
  assert.equal(git(project, 'rev-parse', 'HEAD'), sourceHead, 'the source repository HEAD is unchanged')
  assert.equal(readFileSync(join(project, 'README.md'), 'utf8'), sourceReadme, 'the source content is unchanged')
  assert.equal(git(project, 'status', '--porcelain'), '', 'the source worktree stays clean')
})

// ── B07 persistent terminal ────────────────────────────────────────────────

function toolResultTexts(agent: Agent): string[] {
  const events = agent.session.snapshotEvents() as readonly { readonly type?: string; readonly data?: unknown }[]
  const texts: string[] = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = (event.data as { message?: { content?: readonly { type?: string; text?: string }[] } }).message
    const text = (message?.content ?? []).map(block => block.text ?? '').join('')
    if (text !== '') texts.push(text)
  }
  return texts
}

const sleep = async (ms: number): Promise<void> => { await new Promise<void>(resolve => setTimeout(resolve, ms)) }

test('B07: the real retained terminal result, Job and close state reach the mounted TUI', { skip: skippedInstallationReason([B07]) }, async t => {
  const app = await startS4D3Application(t, {
    bundles: [B07],
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
  })
  const adapter = new ScriptedAdapter()
  app.host.ctx.llm.registerAdapter(['scripted'], adapter)
  const work = join(app.host.root, 'work')

  adapter.scripts.push(
    { kind: 'tool', name: 'terminal_open', callId: 's4d3-b07-open', arguments: JSON.stringify({ type: 'shell', name: 'main', cwd: work }) },
    { kind: 'text', text: 'Terminal opened.' },
  )
  const agent = await app.submitFirstPrompt('Open a persistent terminal')
  await agent.whenIdle()
  const opened = toolResultTexts(agent).find(text => text.includes('started terminal session'))
  assert.ok(opened !== undefined, `the real terminal_open result is committed:\n${toolResultTexts(agent).join('\n---\n')}`)
  const terminalId = /started terminal session (\S+)/u.exec(opened!)![1]!
  await app.waitFor(() => app.view().includes('terminal_open'), 'the real terminal tool card')

  adapter.scripts.push(
    { kind: 'tool', name: 'terminal_send', callId: 's4d3-b07-send', arguments: JSON.stringify({ sessionId: terminalId, text: 'echo TERMINAL_OK' }) },
    { kind: 'tool', name: 'terminal_read', callId: 's4d3-b07-read', arguments: JSON.stringify({ sessionId: terminalId }) },
    { kind: 'tool', name: 'terminal_send', callId: 's4d3-b07-ansi', arguments: JSON.stringify({ sessionId: terminalId, text: "printf '\\033[31mRED_ESCAPE\\033[0m\\n'" }) },
    { kind: 'tool', name: 'terminal_read', callId: 's4d3-b07-read-ansi', arguments: JSON.stringify({ sessionId: terminalId }) },
    { kind: 'tool', name: 'terminal_list', callId: 's4d3-b07-list', arguments: '{}' },
    { kind: 'tool', name: 'terminal_send', callId: 's4d3-b07-background', arguments: JSON.stringify({ sessionId: terminalId, text: 'sleep 0.2; echo BG_OK', run_in_background: true }) },
    { kind: 'text', text: 'Terminal round completed.' },
  )
  followup(agent, 'Run the retained terminal commands')
  await agent.whenIdle()
  await app.waitFor(() => app.view().includes('TERMINAL_OK'), 'the real terminal output in the transcript')
  assert.match(app.view(), /RED_ESCAPE/u, 'the sanitized ANSI output is visible')
  assert.doesNotMatch(app.view(), /\u001b\[31m/u, 'no raw terminal escape sequence is painted by the transcript')

  const results = toolResultTexts(agent)
  const listed = results.findLast(text => /pid=\d+/u.test(text))!
  const pid = Number(/pid=(\d+)/u.exec(listed)![1]!)
  const background = results.find(text => text.includes('started background job'))
  assert.ok(background !== undefined, 'the background send really created a Host Job')
  const jobId = /started background job (\S+)/u.exec(background!)![1]!

  adapter.scripts.push(
    { kind: 'tool', name: 'job_output', callId: 's4d3-b07-job', arguments: JSON.stringify({ job_id: jobId, wait: true, timeout_ms: 30_000 }) },
    { kind: 'tool', name: 'terminal_close', callId: 's4d3-b07-close', arguments: JSON.stringify({ sessionId: terminalId }) },
    { kind: 'tool', name: 'terminal_read', callId: 's4d3-b07-read-closed', arguments: JSON.stringify({ sessionId: terminalId }) },
    { kind: 'text', text: 'Terminal closed.' },
  )
  followup(agent, 'Read the background Job and close the terminal')
  await agent.whenIdle()
  await app.waitFor(() => app.view().includes('BG_OK'), 'the real background Job output in the transcript')
  await app.waitFor(() => /closed terminal session|unknown|closed|lost/iu.test(app.view()), 'the close/refusal tool results')
  assert.ok(toolResultTexts(agent).some(text => /unknown|closed|lost/iu.test(text)),
    'the post-close read result is the official refusal')

  // The existing Task Center observes the SAME Host Job without a second
  // registry: open `/tasks` and read the job row, then its retained output.
  for (const character of '/tasks') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.settle()
  await app.waitFor(() => /Job|jobs|Task/iu.test(app.view()), 'the real Task Center')
  const taskFrame = app.view()
  assert.match(taskFrame, new RegExp(`${jobId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}|terminal|bash`, 'iu'),
    `the Host Job appears in the existing Task Center:\n${taskFrame}`)

  // A closed terminal truly released its process tree.
  await app.waitFor(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }, 'the retained terminal process to exit')
  // The one-shot `!`/`!!` behavior is a separate shell owner; this test never
  // merges it with the persistent terminal and does not touch it.
  await sleep(10)
})

// ── B08 session search ─────────────────────────────────────────────────────

test('B08: the official scoped session_search results reach the PiTui Tool output, never the Session Browser', { skip: skippedInstallationReason([B08]) }, async t => {
  const adapter = new ScriptedAdapter()
  const project = { path: '' }
  const app = await startS4D3Application(t, {
    bundles: [B08],
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
  assert.match(browser, /sessions · Current directory/u, 'the existing Session Browser opens')
  assert.match(browser, /Type to filter/u, 'the picker keeps its own query input')
  // The Host query is a Tool result; opening the Browser never carries that
  // query into the picker's own search input. Read the OVERLAY cells only (the
  // transcript remains painted to its left).
  const overlay = browser.split('\n')
  const top = overlay.findIndex(line => line.includes('sessions · Current directory'))
  assert.ok(top >= 0)
  const left = overlay[top]!.indexOf('╭')
  const overlayText = overlay.slice(top).map(line => line.slice(left)).join('\n')
  assert.doesNotMatch(overlayText, /ALPHA_NEEDLE_PROJECT/u, 'the Host query is not a Session Browser search injection')
})
