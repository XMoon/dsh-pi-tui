/**
 * Headless tests for the TUI application core: a virtual xterm drives the
 * surface exactly like a real TTY, so rendering and input routing are
 * verified without a terminal or a model connection.
 * @module @xmoon76/dsh-pi-tui/tui-app.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { CallId, MessageId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolPresenterFrom } from '../src/present.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp; submitted: string[]; get exits(): number } {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  let exits = 0
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => { exits += 1 },
  })
  app.start()
  // `exits` is a number: returning it by value would copy 0, so expose a getter.
  return { vt, app, submitted, get exits(): number { return exits } }
}

test('renders the header and the editor frame', async () => {
  const { vt } = startApp()
  await vt.waitForRender()
  const viewport = vt.getViewport().join('\n')
  assert.ok(viewport.includes('dsh-pi-tui'), `header missing from viewport:\n${viewport}`)
  assert.ok(viewport.includes('─'), `editor border missing from viewport:\n${viewport}`)
})

test('the editor carries a terminal-prompt ❯ with continuation indent', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setDraft('line one\nline two')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  const lines = view.split('\n')
  const promptRow = lines.findIndex(line => line.includes('❯ line one'))
  assert.ok(promptRow >= 0, `editor prompt row missing:\n${view}`)
  // The prompt reads exactly like the transcript's user messages: the ❯
  // leads the FIRST line, continuation lines indent under it and never
  // repeat the marker.
  assert.ok(lines[promptRow + 1]?.includes('line two'), `continuation row missing:\n${view}`)
  assert.ok(lines[promptRow + 1]!.startsWith('  '), `continuation must indent under the prompt:\n${view}`)
  assert.ok(!lines[promptRow + 1]!.includes('❯'), `continuation must not repeat the prompt:\n${view}`)
})

test('a scrolled draft drops the editor prompt (top row is a continuation)', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // 10 draft lines exceed the editor's 7 visible rows: the draft scrolls and
  // the fork paints an `↑ N more` indicator as the top border. The first
  // visible row is then a continuation, so no prompt may float on it.
  app.setDraft(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('↑'), `scrolled editor must show the ↑ indicator:\n${view}`)
  assert.equal((view.match(/❯/g) ?? []).length, 0, 'a scrolled draft must not show a floating prompt:\n${view}')
})

test('submits editor content to the onSubmit event', async () => {
  const { vt, submitted } = startApp()
  await vt.waitForRender()
  vt.sendInput('hello')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello'])
})

test('ctrl+c twice within the window exits (pi parity)', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03') // empty editor: first press only arms the chord
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 0, 'a single Ctrl+C must not exit')
  surface.vt.sendInput('\x03') // within 500ms: exit
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
})

test('ctrl+d triggers the exit event (like /exit)', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x04')
  await surface.vt.waitForRender()
  assert.equal(surface.exits, 1)
  // A kitty-protocol Ctrl+D press exits exactly once; the release does not.
  const { setKittyProtocolActive } = await import('@xmoon76/pi-tui')
  setKittyProtocolActive(true)
  try {
    surface.vt.sendInput('\x1b[100;5:1u') // ctrl+d press
    await surface.vt.waitForRender()
    assert.equal(surface.exits, 2)
    surface.vt.sendInput('\x1b[100;5:3u') // ctrl+d release
    await surface.vt.waitForRender()
    assert.equal(surface.exits, 2, 'release must not exit again')
  } finally {
    setKittyProtocolActive(false)
  }
})

test('notify survives repaints and clears on fresh user input', async () => {
  const { vt, app } = startApp()
  app.notify('resume failed')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('resume failed'), `notify line missing:\n${view}`)
  // A repaint (e.g. a streaming frame in an active session) must not flash
  // the notice away — that made every error block unreadable.
  app.setTranscript([])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('resume failed'), `repaint must not clear the notify:\n${view}`)
  // Fresh user input supersedes the notice.
  vt.sendInput('hello')
  vt.sendInput('\r')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('resume failed'), `submit must clear the notify:\n${view}`)
})

test('notify is transient: cleared by its auto-clear timeout', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { notifyDurationMs: 200 })
  app.start()
  app.notify('transient note')
  await new Promise(resolve => setTimeout(resolve, 40))
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('transient note'), 'notify line missing before timeout')
  await new Promise(resolve => setTimeout(resolve, 300))
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('transient note'), 'notify line survived its timeout')
})

test('notify defaults to info and errors opt in explicitly', async () => {
  const { vt, app } = startApp()
  // The default kind is info (dim ℹ) — informational notices are the common
  // case; failures pass 'error' explicitly (red ✗).
  app.notify('steering 2 messages')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('ℹ steering 2 messages'), `default info notify missing:\n${view}`)
  assert.ok(!view.includes('✗'), `default notify must not render as an error:\n${view}`)
  // Explicit error kind keeps the red ✗ style.
  app.notify('resume failed', 'error')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('✗ resume failed'), `error-style notify missing:\n${view}`)
})

test('tool cards present through the real registry: read shows the relativized path', async () => {
  // A real workspace with a real file under a src/ subdirectory.
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-tui-read-'))
  try {
    await mkdir(join(dir, 'src'), { recursive: true })
    const filePath = join(dir, 'src', 'foo.ts')
    await writeFile(filePath, 'const answer = 42')

    // A real Cordis context with the real tool registry, plus a fake read
    // tool whose presentation contract mirrors @deepseek-ai/dsh-tool-fs.
    const ctx = new Context()
    ;(ctx as unknown as { provide(name: string, value: object): void }).provide('systemPrompt', {
      tools: () => {},
      section: () => () => {},
    })
    new ToolRuntime(ctx)
    const unregister = ctx.tools.register(defineTool({
      name: 'read',
      description: 'Read a UTF-8 text file (test fake).',
      parameters: {
        file_path: { type: 'string', required: true, description: 'Path to read.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
        presentationMeta: (_args, value) => ({
          path: value.path,
          lines: value.text.split('\n').map((text, index) => ({ number: index + 1, text })),
          totalLines: value.text.split('\n').length,
        }),
      },
      execute: async (args) => ({
        path: args.file_path,
        text: await readFile(args.file_path, 'utf8'),
      }),
      presentCall: (args) => ({
        card: 'generic',
        title: 'Read ' + args.file_path,
        kind: 'read',
        locations: [{ path: args.file_path, line: 1 }],
      }),
      presentResult: (args, result) => {
        const meta = result.meta as { path: string; lines: { number: number; text: string }[]; totalLines: number }
        return { card: 'read', path: meta.path, offset: 1, lines: meta.lines, totalLines: meta.totalLines, content: result.content }
      },
    }))
    try {
      const callId = CallId('call-1')
      // The mock stream: a tool/call event, then the real loop executes the
      // registered tool for real, then its outcome lands as tool/result.
      const callEvent: SessionEvent = {
        type: 'tool/call',
        seq: 0,
        time: 1_700_000_000_000,
        data: { turn: 0, step: 0, callId, name: 'read', arguments: JSON.stringify({ file_path: filePath }) },
      }
      const outcome = await ctx.tools.execute({
        callId,
        name: 'read',
        arguments: { file_path: filePath },
        signal: new AbortController().signal,
      })
      assert.equal(outcome.isError, false)
      const resultEvent: SessionEvent = {
        type: 'tool/result',
        seq: 1,
        time: 1_700_000_000_001,
        data: {
          turn: 0,
          step: 0,
          message: createToolResultMessage({ callId, content: outcome.content, isError: outcome.isError }),
          ...outcome.meta === undefined ? {} : { meta: outcome.meta },
        },
      }

      const vt = new VirtualTerminal(100, 24)
      const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
        workspaceRoot: dir,
        present: toolPresenterFrom(name => ctx.tools.get(name)),
      })
      app.start()
      app.setToolOutputExpanded(true)
      const folder = new TranscriptFolder()
      folder.apply([callEvent, resultEvent])
      app.setTranscript(folder.messages())
      await vt.waitForRender()
      const view = vt.getViewport().join('\n')
      assert.ok(view.includes('Read src/foo.ts [ok]'), `read card header missing:\n${view}`)
      assert.ok(view.includes('path: src/foo.ts'), `relativized path missing:\n${view}`)
      assert.ok(view.includes('total lines: 1'), `line count missing:\n${view}`)
      assert.ok(!view.includes(dir), `workspace root leaked into the viewport:\n${view}`)
      app.stop()
    } finally {
      unregister()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test('footer mode slot badges every permission preset', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'm', cwd: 'c', permission: 'danger-full-access' })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('[yolo]'), `yolo badge missing:\n${view}`)
  app.setStatus({ permission: 'read-only' })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('[read-only]'), `read-only badge missing:\n${view}`)
  app.setStatus({ permission: 'custom' })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('[custom]'), `custom badge missing:\n${view}`)
  // The default preset badges too, so the effective write scope is always
  // visible in the footer (the dock no longer carries a perm line).
  app.setStatus({ permission: 'workspace-write' })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('[workspace-write]'), `workspace-write badge missing:\n${view}`)
  assert.ok(!view.includes('[yolo]'), `stale badge:\n${view}`)
})

test('shift+tab with no overlay cycles the permission through the host', async () => {
  const vt = new VirtualTerminal(80, 24)
  let cycled = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onCyclePermission: () => { cycled += 1 } })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x1b[Z') // shift+tab
  await vt.waitForRender()
  assert.equal(cycled, 1, `shift+tab must reach the host:\n`)
  app.stop()
})

test('the dock strip shows the todo summary only while non-empty; tasks live in the footer badge and goal on its own line', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(!view.includes('☑'), `empty dock must not render a todo line:\n${view}`)
  // Everything present: goal (own line above the queue), todo summary, and
  // the task count in the footer badge only.
  app.setStatus({ goal: 'goal ● fix the build' })
  app.setTodoSummary([{ content: 'write tests', status: 'in_progress' }, { content: 'ship', status: 'pending' }])
  app.setTasks([{ id: 'bash-1', label: 'audit repo', status: 'running', kind: 'bash' }])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('goal ● fix the build'), `goal missing from its own line:\n${view}`)
  assert.ok(view.includes('☑  2 active · write tests'), `todo summary missing:\n${view}`)
  // Task details are NOT in the dock anymore — only the footer badge count.
  assert.ok(!view.includes('⏳  bash-1 · audit repo'), `task detail leaked into the dock:\n${view}`)
  assert.ok(view.includes('[1 task running'), `footer task badge missing:\n${view}`)
  // Lines drop out as their data clears.
  app.setTasks([])
  app.setTodoSummary([])
  app.setStatus({ goal: undefined })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('☑'), `cleared todo line survived:\n${view}`)
  assert.ok(!view.includes('goal ●'), `cleared goal line survived:\n${view}`)
})

test('the queue pane renders pending rows and hides when empty', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  // The editor prompt is the only `❯` on screen: the empty queue must
  // render no pane rows.
  assert.equal((view.match(/❯/g) ?? []).length, 1, `empty queue must leave only the editor prompt:\n${view}`)
  app.setQueueItems([
    { id: 'm-1', text: 'follow up on the audit', mode: 'followup' },
    { id: 'm-2', text: 'steer a correction', mode: 'steer' },
  ])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('❯ follow up on the audit'), `followup row missing:\n${view}`)
  assert.ok(view.includes('❯ steer a correction'), `steer row missing:\n${view}`)
  assert.ok(view.includes('ctrl+s to steer all'), `steer-all hint missing:\n${view}`)
  assert.ok(view.includes('alt+↑ to edit all'), `hint row missing:\n${view}`)
  app.setQueueItems([])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal((view.match(/❯/g) ?? []).length, 1, `cleared queue still rendered:\n${view}`)
})

test('job notices in the queue render with their own marker and drop the steer hints', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // Only a job-completion notice queued: no steerable content at all.
  app.setQueueItems([{ id: 'j-1', text: 'bash-2 pnpm build finished: exit 0', mode: 'steer', notice: true }])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('⏳ bash-2 pnpm build finished'), `notice row missing its marker:\n${view}`)
  // Only the editor prompt may carry a ❯ — a notice must never render as
  // steerable input.
  assert.equal((view.match(/❯/g) ?? []).length, 1, `a notice must not render as steerable input:\n${view}`)
  assert.ok(!view.includes('ctrl+s to steer all'), `steer hints must not advertise for notices:\n${view}`)
  assert.ok(view.includes('/tasks to view'), `jobs hint missing:\n${view}`)
  // A notice alongside real user input keeps the steer verbs.
  app.setQueueItems([
    { id: 'j-1', text: 'bash-2 pnpm build finished: exit 0', mode: 'steer', notice: true },
    { id: 'm-1', text: 'please also fix the lint', mode: 'followup' },
  ])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('⏳ bash-2'), `notice row missing with mixed queue:\n${view}`)
  assert.ok(view.includes('❯ please also fix the lint'), `user row missing:\n${view}`)
  assert.ok(view.includes('ctrl+s to steer all'), `steer hint must survive a mixed queue:\n${view}`)
  app.setQueueItems([])
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('⏳ bash-2'), `cleared notice survived:\n${view}`)
})

test('notice rows beyond the fold collapse into a +N more line; user rows never fold', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // A backlog of notices (e.g. a batch of subagent settlements/reports):
  // only the first MAX_NOTICE_ROWS render, the rest collapse into one line.
  const notices = Array.from({ length: 8 }, (_, i) => ({
    id: `n-${i}`, text: `notice ${i} text`, mode: 'steer' as const, notice: true,
  }))
  app.setQueueItems(notices)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('⏳ notice 0 text'), `first notice visible:\n${view}`)
  assert.ok(view.includes('⏳ notice 4 text'), `fifth notice visible:\n${view}`)
  assert.ok(!view.includes('⏳ notice 5 text'), `sixth notice must fold:\n${view}`)
  assert.ok(view.includes('+3 more notices pending'), `fold line missing:\n${view}`)
  assert.ok(!view.includes('ctrl+s to steer all'), 'notices alone must not advertise steer verbs')
  assert.ok(view.includes('notices deliver after the current task · /tasks to view'), `notices hint missing:\n${view}`)
  // User rows mixed in: every user row shows, notices still fold.
  app.setQueueItems([
    ...notices,
    { id: 'm-1', text: 'my first queued message', mode: 'followup' },
    { id: 'm-2', text: 'my second queued message', mode: 'steer' },
  ])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('❯ my first queued message'), `user row 1 missing:\n${view}`)
  assert.ok(view.includes('❯ my second queued message'), `user row 2 missing:\n${view}`)
  assert.ok(view.includes('+3 more notices pending'), `fold line must survive mixed queue:\n${view}`)
  assert.ok(view.includes('ctrl+s to steer all'), 'steer hint must survive mixed queue:\n${view}')
  // Claims drain the backlog: two notices gone, the fold shrinks.
  app.setQueueItems([...notices.slice(0, 6), { id: 'm-1', text: 'my first queued message', mode: 'followup' }])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('+1 more notices pending'), `fold count must shrink after claims:\n${view}`)
  // Full drain: the group disappears entirely.
  app.setQueueItems([{ id: 'm-1', text: 'my first queued message', mode: 'followup' }])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('more notices pending'), `fold line must vanish after drain:\n${view}`)
  assert.ok(view.includes('❯ my first queued message'), `user row must survive the drain:\n${view}`)
})

test('down opens the task browser only with active tasks and an empty editor; ctrl+j is inert', async () => {
  const vt = new VirtualTerminal(80, 24)
  let opened = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The real runner opens a picker (which renders); the test mimics that.
    onOpenTasks: () => { opened += 1; app.requestRender() },
  })
  app.start()
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  await vt.waitForRender()
  // No active tasks: ↓ is inert.
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 0, `no tasks means no browser`)
  app.setTasks([{ id: 'bash-1', label: 'pnpm build', status: 'running', kind: 'bash' }])
  await vt.waitForRender()
  // Empty editor + active tasks: ↓ opens the browser.
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 1, `down must open the task browser with an empty editor`)
  // Ctrl+J is deliberately unbound: legacy terminals send it as LF, which
  // the editor treats as Enter — it must NOT open the browser (the task
  // surface is ↓ + `/tasks`).
  vt.sendInput('\n') // ctrl+j is LF
  await sleep(20)
  assert.equal(opened, 1, `ctrl+j must not open the task browser`)
  // Non-empty draft: the key keeps its editing meaning (no browser).
  app.setDraft('ls -la')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 1, `down must not open the browser while a draft is being edited`)
  // Tasks cleared: the trigger disarms.
  app.setTasks([])
  app.setDraft('')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 1, `the trigger must disarm when no tasks are active`)
  app.stop()
})

test('the footer badges active tasks and advertises the ↓ trigger on an empty editor', async () => {
  const { vt, app } = startApp()
  app.setTasks([{ id: 'bash-1', label: 'pnpm build', status: 'running', kind: 'bash' }])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('[1 task running · ↓ view]'), `footer task badge missing:\n${view}`)
  app.setDraft('typed text')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('[1 task running]'), `badge must stay with a draft:\n${view}`)
  assert.ok(!view.includes('↓ view'), `the ↓ hint must not show while a draft is being edited:\n${view}`)
  app.setTasks([])
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('task running'), `badge survived clearing:\n${view}`)
})

test('live continuable subagents arm the task browser trigger through setAgents', async () => {
  const vt = new VirtualTerminal(80, 24)
  let opened = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onOpenTasks: () => { opened += 1; app.requestRender() },
  })
  app.start()
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  await vt.waitForRender()
  // No live agents: inert.
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 0, `no agents means no browser`)
  // A live continuable child arms the trigger even with zero jobs.
  app.setAgents([{ id: 'child-abc', label: 'research', activity: 'running' }])
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 1, `down must open the task browser with a live subagent`)
  // Ctrl+J is deliberately unbound (legacy LF ambiguity): inert here too.
  vt.sendInput('\n') // ctrl+j is LF
  await sleep(20)
  assert.equal(opened, 1, `ctrl+j must not open the task browser with a live subagent`)
  // Clearing agents disarms; clearing jobs while agents live must not.
  app.setAgents([])
  app.setTasks([])
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 1, `the trigger must disarm when no agents are active`)
  app.setTasks([{ id: 'bash-1', label: 'pnpm build', status: 'running', kind: 'bash' }])
  app.setAgents([])
  await vt.waitForRender()
  app.setTasks([])
  app.setAgents([{ id: 'child-abc', label: 'research', activity: 'running' }])
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 2, `agents must keep the trigger armed when tasks clear`)
  app.stop()
})

test('fullscreen click on the todo panel toggles its compact/full expansion', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const todos = Array.from({ length: 9 }, (_, i) => ({
    id: `t-${i}`,
    content: `todo item ${i}`,
    status: i % 3 === 0 ? ('in_progress' as const) : i % 3 === 1 ? ('pending' as const) : ('completed' as const),
  }))
  app.setTodoSummary(todos)
  app.toggleTodoPanel()
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('todo item 0'), `compact panel must show the first rows:\n${view}`)
  assert.ok(!view.includes('todo item 8'), `compact panel must hide later rows:\n${view}`)
  assert.ok(!app.isTodoPanelExpanded(), 'starts compact')
  // SGR click (press + release on the same cell) inside the todo panel
  // area. Fullscreen layout on the 80x24 test terminal: footer (1) +
  // editor seat (1) sit at the bottom, so the todo panel (border + title +
  // 5 rows = 7) occupies 0-based rows 15..21 — click row 18.
  vt.sendInput('\x1b[<0;20;19M')
  vt.sendInput('\x1b[<0;20;19m')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(app.isTodoPanelExpanded(), 'click must expand the panel')
  assert.ok(view.includes('todo item 8'), `expanded panel must show the full list:\n${view}`)
  // Click again (a DIFFERENT cell — same-cell rapid clicks read as a
  // double-click word selection, never a disclosure). The layout must have
  // repainted after the expansion (the expanded panel moves rows), or the
  // click still lands on the stale scroll pane rect. The three-state loop:
  // full list → the panel closes back to the summary row.
  await vt.waitForRender()
  vt.sendInput('\x1b[<0;30;20M')
  vt.sendInput('\x1b[<0;30;20m')
  await vt.waitForRender()
  assert.ok(!app.isTodoPanelVisible(), 'second click must close the panel back to the summary')
  assert.ok(!app.isTodoPanelExpanded(), 'closing resets the expansion')
  assert.ok(!vt.getViewport().join('\n').includes('todo item 8'), 'closed panel must hide later rows')
  app.setFullscreen(false)
})

test('fullscreen click on the todo summary dock row opens the todo panel', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  const todos = Array.from({ length: 9 }, (_, i) => ({
    id: `t-${i}`,
    content: `todo item ${i}`,
    status: i % 3 === 0 ? ('in_progress' as const) : i % 3 === 1 ? ('pending' as const) : ('completed' as const),
  }))
  app.setTodoSummary(todos)
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('☑'), `todo summary must render in the dock:\n${view}`)
  assert.ok(!app.isTodoPanelVisible(), 'panel starts closed')
  // The dock summary row sits at 0-based row 20 (editor seat 3 + footer 0
  // at the bottom on the 80x24 test terminal; the closed panel renders
  // zero rows, so the todo region clamps to [20, 21) — exactly the dock
  // row).
  vt.sendInput('\x1b[<0;20;21M')
  vt.sendInput('\x1b[<0;20;21m')
  await vt.waitForRender()
  assert.ok(app.isTodoPanelVisible(), 'click on the summary row must open the panel')
  assert.ok(!app.isTodoPanelExpanded(), 'opens compact')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('todo item 0'), `compact panel must show after the click:\n${view}`)
  // With the panel open the summary is hidden and the panel owns rows
  // 14..20 — the same cell is now a panel row, so the next click runs the
  // compact → full step of the loop.
  vt.sendInput('\x1b[<0;20;21M')
  vt.sendInput('\x1b[<0;20;21m')
  await vt.waitForRender()
  assert.ok(app.isTodoPanelVisible(), 'panel must stay open (the cell is now a panel row)')
  assert.ok(app.isTodoPanelExpanded(), 'the click now expands the panel (compact → full)')
  app.setFullscreen(false)
  app.stop()
})

test('the footer badge combines tasks and live agents, hint only on an empty editor', async () => {
  const { vt, app } = startApp()
  app.setAgents([{ id: 'child-abc', label: 'research', activity: 'running' }])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('[1 agent · ↓ view]'), `agent-only badge missing:\n${view}`)
  app.setTasks([{ id: 'bash-1', label: 'pnpm build', status: 'running', kind: 'bash' }])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('[1 task running · 1 agent · ↓ view]'), `combined badge missing:\n${view}`)
  app.setDraft('typed text')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('[1 task running · 1 agent]'), `badge must stay with a draft:\n${view}`)
  assert.ok(!view.includes('↓ view'), `the ↓ hint must not show while a draft is being edited:\n${view}`)
  app.setTasks([])
  app.setAgents([])
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('agent ·'), `badge survived clearing:\n${view}`)
})

test('a tiny terminal clamps the todo click geometry to the visible screen', async () => {
  // Bottom-up geometry on a 6-row terminal: footer + editor seat take the
  // bottom rows, so the todo panel's top overflows the screen and clamps
  // to row 0 — the derived region is [0, todoBottom), never negative or
  // inverted, and clicks outside it are ignored.
  const vt = new VirtualTerminal(80, 6)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  const todos = Array.from({ length: 3 }, (_, i) => ({
    id: `t-${i}`, content: `todo item ${i}`,
    status: i === 0 ? ('in_progress' as const) : ('pending' as const),
  }))
  app.setTodoSummary(todos)
  app.toggleTodoPanel()
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.ok(!app.isTodoPanelExpanded(), 'starts compact')
  // Row 2 (SGR y=3) sits inside the clamped region [0, todoBottom): expand.
  vt.sendInput('\x1b[<0;40;3M')
  vt.sendInput('\x1b[<0;40;3m')
  await vt.waitForRender()
  assert.ok(app.isTodoPanelExpanded(), 'a click inside the clamped region must expand')
  // Row 6 (SGR y=6) sits in the editor/footer rows below the region: ignored.
  vt.sendInput('\x1b[<0;40;6M')
  vt.sendInput('\x1b[<0;40;6m')
  await vt.waitForRender()
  assert.ok(app.isTodoPanelExpanded(), 'a click outside the clamped region must be ignored')
  app.setFullscreen(false)
  app.stop()
})

test('live subagents render as a footer badge only (no dock detail lines)', async () => {
  const { vt, app } = startApp()
  app.setAgents([
    { id: 'child-abc', label: 'research', activity: 'running' },
    { id: 'child-def', label: 'audit repo', activity: 'running' },
  ])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('🤖'), `subagent detail must not render in the dock:\n${view}`)
  assert.ok(view.includes('[2 agents'), `footer subagent badge missing:\n${view}`)
})

test('the output viewer refreshes on a timer, stops on s, and closes on esc', async () => {
  const { vt, app } = startApp()
  const stopped: string[] = []
  let closed = 0
  let tick = 0
  const close = app.openOutputViewer({
    title: 'bash 1 · pnpm build — running',
    initial: 'first line',
    refresh: () => `first line\ntick ${++tick}`,
    onStop: () => { stopped.push('stop') },
    onClose: () => { closed += 1 },
    intervalMs: 10,
  })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('bash 1 · pnpm build'), `viewer title missing:\n${view}`)
  assert.ok(view.includes('first line'), `viewer body missing:\n${view}`)
  // The refresh timer swaps the body in place.
  await new Promise(resolve => setTimeout(resolve, 40))
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(/tick \d+/.test(view), `refreshed body missing:\n${view}`)
  // `s` fires the stop hook; Esc closes (idempotent).
  vt.sendInput('s')
  assert.deepEqual(stopped, ['stop'])
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(closed, 1, `esc must close the viewer once`)
  close()
  assert.equal(closed, 1, `the closer must be idempotent`)
  app.stop()
})

test('alt+up with no overlay reaches the dequeue host', async () => {
  const vt = new VirtualTerminal(80, 24)
  let dequeued = 0
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {}, onDequeue: () => { dequeued += 1 } })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x1b[1;3A') // alt+up
  await vt.waitForRender()
  assert.equal(dequeued, 1, `alt+up must reach the host`)
  app.stop()
})

test('setDraft and getDraft round-trip the editor text', async () => {
  const { vt, app } = startApp()
  app.setDraft('pulled back queue text')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'pulled back queue text')
})

test('resetInputHistory replaces the recall history wholesale (session switch)', async () => {
  const { vt, app } = startApp()
  const editorLine = (): string => {
    const lines = vt.getViewport()
    const index = lines.findIndex(line => line.includes('cmd') || line.includes('recall'))
    return index === -1 ? '' : lines[index]!.trim()
  }
  app.seedInputHistory(['old cmd', 'older cmd'])
  app.resetInputHistory(['new cmd'])
  await vt.waitForRender()
  assert.deepEqual(app.getInputHistory(), ['new cmd'], 'the persistence mirror must be replaced')
  // ↑ in the EMPTY editor recalls the NEW workspace's entry, never the old one.
  app.setDraft('')
  vt.sendInput('\x1b[A')
  await vt.waitForRender()
  assert.equal(editorLine(), '❯ new cmd', 'the OLD workspace entry must not be recalled')
  // An empty reset clears the mirror, and a later seed recalls ONLY the new
  // entries (nothing of the old workspace survives).
  app.resetInputHistory([])
  assert.deepEqual(app.getInputHistory(), [], 'cleared mirror must be empty')
  app.resetInputHistory(['fresh cmd'])
  await vt.waitForRender()
  app.setDraft('')
  vt.sendInput('\x1b[A')
  await vt.waitForRender()
  assert.equal(editorLine(), '❯ fresh cmd', 'only the newest workspace entries must be recallable')
  app.stop()
})

test('the pre-session welcome invites the first message and clears on facts', async () => {
  const { vt, app } = startApp()
  app.setWelcomeIdle(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('type a message to start a session'), `idle invitation missing:\n${view}`)
  // Real facts replace the invitation.
  app.setWelcomeCard({ cwd: '/ws', sessionId: 'session-1', model: 'p/m', version: '0.1.0' })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('session session-1'), `welcome card missing:\n${view}`)
  assert.ok(!view.includes('type a message to start'), `invitation survived:\n${view}`)
})

test('overlay frame borders stay aligned when content is narrower than the panel', async () => {
  const { vt, app } = startApp()
  app.openPicker(
    [
      { value: 's1', label: 'short label one' },
      { value: 's2', label: 'short label two' },
    ],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  const lines = vt.getViewport().map(strip)
  // Locate the picker box around its first row, not the welcome card's frame.
  const pickerRow = lines.findIndex(line => line.includes('short label one'))
  assert.ok(pickerRow >= 0, `picker row missing:\n${lines.join('\n')}`)
  let top = pickerRow
  while (top > 0 && !lines[top]!.includes('╭')) top -= 1
  let bottom = pickerRow
  while (bottom < lines.length - 1 && !lines[bottom]!.includes('╰')) bottom += 1
  const box = lines.slice(top, bottom + 1)
  assert.ok(box.length >= 4, `frame too small:\n${box.join('\n')}`)
  const widths = new Set(box.map(line => line.length))
  assert.equal(widths.size, 1, `frame rows must match the border width:\n${box.join('\n')}`)
})

test('fixed-width overlays fill the declared width: no border-external mask region', async () => {
  // M1 (plan §4): a framed overlay that declares a fixed width must fill
  // that width (Frame(child, true)), otherwise the compositor pads the
  // remaining columns with spaces — the "black mask" beside the border.
  const run = async (columns: number): Promise<void> => {
    const vt = new VirtualTerminal(columns, 24)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    app.openTaskBrowser(
      [{ value: 'job:1', label: 'bash · build', status: 'running', startedAt: Date.now(), group: 'jobs' }],
      () => {},
      () => {},
      { header: 'tasks' },
    )
    await vt.waitForRender()
    const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
    const lines = vt.getViewport().map(strip)
    const rowIndex = lines.findIndex(line => line.includes('bash · build'))
    assert.ok(rowIndex >= 0, `task row missing at ${columns} cols:\n${lines.join('\n')}`)
    let top = rowIndex
    while (top > 0 && !lines[top]!.includes('╭')) top -= 1
    let bottom = rowIndex
    while (bottom < lines.length - 1 && !lines[bottom]!.includes('╰')) bottom += 1
    const box = lines.slice(top, bottom + 1)
    // The declared width is clamped to the terminal width by the
    // compositor; the FRAME's border must span exactly that width on every
    // row. Before M1 the frame hugged its content (e.g. 39 cols) while the
    // overlay still occupied the declared 72 — the compositor padded the
    // gap, and the border's right edge sat far short of the overlay edge
    // (the black mask). The right-border position is the detector.
    const declared = Math.min(72, columns)
    const left = box[0]!.indexOf('╭')
    assert.ok(left >= 0, `top border missing:\n${box.join('\n')}`)
    for (const line of box) {
      // The right border glyph must sit exactly at left + declared - 1.
      assert.equal(line[left + declared - 1], line[left] === '╭' ? '╮' : line[left] === '╰' ? '╯' : '│',
        `frame right edge must sit at column ${left + declared - 1} (declared ${declared}) at ${columns} cols:\n${box.join('\n')}`)
    }
    app.stop()
  }
  for (const cols of [40, 80, 120, 200]) await run(cols)
})

test('a fixed-width overlay keeps its frame geometry across fullscreen, resize and theme switches', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const openBrowser = (): void => {
    app.openTaskBrowser(
      [{ value: 'job:1', label: 'bash · build', status: 'running', startedAt: Date.now(), group: 'jobs' }],
      () => {},
      () => {},
      { header: 'tasks' },
    )
  }
  const assertRightEdge = (label: string): void => {
    const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
    const lines = vt.getViewport().map(strip)
    const rowIndex = lines.findIndex(line => line.includes('bash · build'))
    assert.ok(rowIndex >= 0, `${label}: task row missing:\n${lines.join('\n')}`)
    let top = rowIndex
    while (top > 0 && !lines[top]!.includes('╭')) top -= 1
    let bottom = rowIndex
    while (bottom < lines.length - 1 && !lines[bottom]!.includes('╰')) bottom += 1
    const box = lines.slice(top, bottom + 1)
    const left = box[0]!.indexOf('╭')
    for (const line of box) {
      const expectedRight = line[left] === '╭' ? '╮' : line[left] === '╰' ? '╯' : '│'
      assert.equal(line[left + 71], expectedRight,
        `${label}: frame right edge must sit at column ${left + 71} (declared 72):\n${box.join('\n')}`)
    }
  }
  openBrowser()
  await vt.waitForRender()
  assertRightEdge('regular')
  // Fullscreen hides existing overlays (the surface migration clears the
  // stack), so the browser is opened again under the alt screen — the same
  // compositor contract applies there.
  app.setFullscreen(true)
  await vt.waitForRender()
  openBrowser()
  await vt.waitForRender()
  assertRightEdge('fullscreen')
  // Resize while the overlay is up: the frame re-renders at the new width.
  vt.resize(100, 30)
  await vt.waitForRender()
  assertRightEdge('post-resize')
  // Palette switches do not disturb the geometry.
  app.applyTheme('light')
  await vt.waitForRender()
  assertRightEdge('light theme')
  app.stop()
})

test('an approval dialog stacked over the settings panel hides it modally and restores it', async () => {
  const { vt, app } = startApp()
  app.openSettings(
    [{ id: 'a', label: '[next 1] follow up on the audit report', description: 'msg-1111', currentValue: '' }],
    () => {},
    () => {},
  )
  void app.showApprovalPrompt({ toolName: 'Bash', reason: 'run a shell command', danger: true })
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('Approve Bash?'), `approval title missing:\n${view}`)
  assert.ok(view.includes('run a shell command'), `dialog content missing:\n${view}`)
  // Modal stacking: the fork's compositor interleaves stacked boxes line by
  // line, so the settings panel is HIDDEN beneath the dialog instead of
  // bleeding its borders around it.
  assert.ok(!view.includes('follow up on the audit'), `settings panel must be hidden behind the dialog:\n${view}`)
  // Approving the dialog restores the panel beneath it.
  vt.sendInput('y')
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('follow up on the audit'), `settings panel must return after the dialog closes:\n${view}`)
  assert.ok(!view.includes('Approve Bash?'), `dialog survived approval:\n${view}`)
})

test('openSettings returns a closer so action-style lists can dismiss themselves', async () => {
  const { vt, app } = startApp()
  const close = app.openSettings(
    [{ id: 'view', label: 'View transcript', description: 'Watch read-only', currentValue: '', values: ['✓'] }],
    () => {},
    () => {},
  )
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('View transcript'), `settings list missing:\n${view}`)
  // The action fires and the list dismisses itself — without the closer the
  // list would stay mounted as a ghost overlay eating every later key (the
  // /subagents trap, observed live in tmux).
  close()
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('View transcript'), `settings overlay survived its closer:\n${view}`)
  // Esc on the empty surface must NOT reopen or revive the closed list.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('View transcript'), `closed overlay revived:\n${view}`)
  app.stop()
})

function diffCallArgs(): string {
  return JSON.stringify({ file_path: 'src/foo.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' })
}

function diffCallEvent(seq: number, callId: string): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { turn: 0, step: 0, callId: CallId(callId), name: 'edit', arguments: diffCallArgs() },
  }
}

function diffResultEvent(seq: number, callId: string, text: string): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 0,
      step: 0,
      message: createToolResultMessage({ callId: CallId(callId), content: [{ type: 'text', text }], isError: false }),
    },
  }
}

function subagentRouteCallEvent(seq: number, callId: string, args: string): SessionEvent {
  return {
    type: 'tool/call',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { turn: 0, step: 0, callId: CallId(callId), name: 'subagent_route', arguments: args },
  }
}

function subagentRouteResultEvent(seq: number, callId: string): SessionEvent {
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 0,
      step: 0,
      message: createToolResultMessage({
        callId: CallId(callId),
        content: [{ type: 'text', text: 'started background subagent job job-1' }],
        isError: false,
      }),
    },
  }
}

test('a running edit card renders its call-time diff', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({
        card: 'diff' as const,
        title: 'Edit src/foo.ts',
        diffs: [{ path: 'src/foo.ts', oldText: 'a\nb\nc', newText: 'a\nB\nc' }],
        locations: [],
      }),
      result: () => undefined,
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  const folder = new TranscriptFolder()
  folder.apply([diffCallEvent(0, 'call-diff-1')])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('+1 -1 src/foo.ts'), `diff header missing:\n${view}`)
  assert.ok(view.includes('- b'), `delete row missing:\n${view}`)
  assert.ok(view.includes('+ B'), `add row missing:\n${view}`)
  app.stop()
})

test('subagent-family tool cards show the model/provider line when the call carries it', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setToolOutputExpanded(true)
  // A running subagent_route dispatch with an explicit model/provider.
  const args = JSON.stringify({ description: 'research', prompt: 'look it up', provider: 'ollama', model: 'deepseek-v4' })
  const folder = new TranscriptFolder()
  folder.apply([subagentRouteCallEvent(0, 'call-route-1', args)])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('deepseek-v4 · ollama'), `running card must show the model line:\n${view}`)
  // Settled: the line survives above the result.
  const settled = new TranscriptFolder()
  settled.apply([subagentRouteCallEvent(0, 'call-route-1', args), subagentRouteResultEvent(1, 'call-route-1')])
  app.setTranscript(settled.messages())
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('deepseek-v4 · ollama'), `settled card must keep the model line:\n${view}`)
  app.stop()
})

test('subagent-family cards without an explicit model render unchanged (compatibility)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setToolOutputExpanded(true)
  // The official subagent tool never carries model/provider in the args
  // (deployment config owns the route): no model line, no extra row.
  const args = JSON.stringify({ description: 'research', prompt: 'deep dive', run_in_background: false })
  const folder = new TranscriptFolder()
  folder.apply([subagentRouteCallEvent(0, 'call-route-2', args)])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('· ollama'), `no provider must not render a model line:\n${view}`)
  assert.ok(view.includes('subagent_route'), `the card itself must still render:\n${view}`)
  app.stop()
})

test('a completed diff card renders the applied result diffs', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => undefined,
      result: () => ({
        card: 'diff' as const,
        title: 'Edit src/foo.ts',
        diffs: [{ path: 'src/foo.ts', oldText: 'x\ny', newText: 'x\nY\nz' }],
        locations: [],
      }),
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  const folder = new TranscriptFolder()
  folder.apply([diffCallEvent(0, 'call-diff-2'), diffResultEvent(1, 'call-diff-2', 'The file src/foo.ts has been updated successfully.')])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('+2 -1 src/foo.ts'), `applied diff header missing:\n${view}`)
  assert.ok(view.includes('+ Y'), `applied add row missing:\n${view}`)
  assert.ok(!view.includes('updated successfully'), `raw result text must not replace the diff:\n${view}`)
  app.stop()
})

test('a completed diff card without a result view falls back to the call-time diff', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({
        card: 'diff' as const,
        title: 'Edit src/foo.ts',
        diffs: [{ path: 'src/foo.ts', oldText: 'a\nb\nc', newText: 'a\nB\nc' }],
        locations: [],
      }),
      result: () => undefined, // no meta on replay: the tool attaches no view
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  const folder = new TranscriptFolder()
  folder.apply([diffCallEvent(0, 'call-diff-3'), diffResultEvent(1, 'call-diff-3', 'The file src/foo.ts has been updated successfully.')])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('+1 -1 src/foo.ts'), `call diff header missing:\n${view}`)
  assert.ok(!view.includes('updated successfully'), `raw result text must not replace the diff:\n${view}`)
  app.stop()
})

test('a big diff card caps in the default view with an expand hint', async () => {
  const vt = new VirtualTerminal(100, 40)
  const oldLines = Array.from({ length: 30 }, (_, i) => `old ${i}`).join('\n')
  const newLines = Array.from({ length: 30 }, (_, i) => `new ${i}`).join('\n')
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => ({
        card: 'diff' as const,
        title: 'Write src/big.ts',
        diffs: [{ path: 'src/big.ts', oldText: null, newText: newLines }],
        locations: [],
      }),
      result: () => undefined,
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  const folder = new TranscriptFolder()
  folder.apply([diffCallEvent(0, 'call-diff-4')])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('+30 src/big.ts'), `create header missing:\n${view}`)
  assert.ok(view.includes('more changes hidden (click to expand)'), `cap footer missing:\n${view}`)
  app.stop()
})

test('the one-shot subagent viewer covers the editor, consumes input, and restores the draft on exit', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  let singleEscapes = 0
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    onSingleEscape: () => { singleEscapes += 1; return true },
  })
  app.start()
  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  app.setDraft('my precious draft')
  await vt.waitForRender()
  app.setViewerMode({ parentSessionId: 'session-main', childSessionId: 'child-1', label: 'research', mode: 'one-shot', activity: 'running' })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('viewing subagent: research — one-shot · read-only · Esc returns'), `placeholder missing:\n${view}`)
  assert.ok(view.includes('[viewing subagent · one-shot · read-only]'), `header badge missing:\n${view}`)
  // Typing goes nowhere, Enter does not submit, ↓ does not open anything.
  vt.sendInput('hello')
  vt.sendInput('\r')
  vt.sendInput('\x1b[B')
  await sleep(20)
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('hello'), `typed text leaked into the editor:\n${view}`)
  assert.ok(view.includes('viewing subagent: research'), `placeholder must survive keys:\n${view}`)
  assert.equal(submitted.length, 0, `Enter must not submit while viewing`)
  // The preserved draft is still the real draft.
  assert.equal(app.getDraft(), 'my precious draft')
  // Esc exits through onSingleEscape while the viewer is up.
  vt.sendInput('\x1b')
  await sleep(20)
  assert.equal(singleEscapes, 1, `Esc must reach onSingleEscape while viewing`)
  // Leaving the viewer restores the draft and drops the badge.
  app.setViewerMode(undefined)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('my precious draft'), `draft not restored:\n${view}`)
  assert.ok(!view.includes('[viewing subagent'), `badge survived leaving:\n${view}`)
  app.stop()
})

test('ctrl+o still folds the viewed transcript while the viewer is up', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  })
  app.start()
  app.setViewerMode({ parentSessionId: 'session-main', childSessionId: 'child-1', label: 'research', mode: 'one-shot', activity: 'running' })
  await vt.waitForRender()
  app.setToolOutputExpanded(false)
  vt.sendInput('\x0f') // ctrl+o
  await vt.waitForRender()
  assert.equal(app.isToolOutputExpanded(), true, `ctrl+o must still toggle the fold while viewing`)
  app.setViewerMode(undefined)
  app.stop()
})

test('openTaskBrowser renders status dots and live counts in the overlay', async () => {
  const { vt, app } = startApp()
  app.openTaskBrowser(
    [
      { value: 'job:1', label: 'bash · build', status: 'running', startedAt: Date.now() - 3_000, group: 'jobs' },
      { value: 'job:2', label: 'bash · lint', status: 'completed', startedAt: Date.now() - 60_000, group: 'jobs' },
      { value: 'agent:1', label: 'subagent · research', status: 'running', group: 'subagents' },
    ],
    () => {},
    () => {},
    { header: 'tasks · subagents', enableSearch: true },
  )
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  const view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('tasks · subagents'), `header missing:\n${view}`)
  assert.ok(view.includes('●'), `status dots missing:\n${view}`)
  assert.ok(view.includes('running'), `running status missing:\n${view}`)
  assert.ok(view.includes('3s'), `elapsed missing:\n${view}`)
  assert.ok(view.includes('1m'), `completed elapsed missing:\n${view}`)
  assert.ok(view.includes('── jobs ──') && view.includes('── subagents ──'), `group headers missing:\n${view}`)
  app.stop()
})

test('openTaskBrowser: Enter selects the highlighted row; Esc closes', async () => {
  const { vt, app } = startApp()
  let selected: string | undefined
  let cancelled = false
  app.openTaskBrowser(
    [
      { value: 'job:1', label: 'bash · build', status: 'running', startedAt: Date.now(), group: 'jobs' },
      { value: 'job:2', label: 'bash · lint', status: 'completed', startedAt: Date.now(), group: 'jobs' },
    ],
    (value) => { selected = value },
    () => { cancelled = true },
    { header: 'tasks' },
  )
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // move to the second row
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(selected, 'job:2', `Enter must select the highlighted row`)
  // Re-open and cancel.
  app.openTaskBrowser(
    [{ value: 'job:1', label: 'bash · build', status: 'running', startedAt: Date.now(), group: 'jobs' }],
    () => {},
    () => { cancelled = true },
    { header: 'tasks' },
  )
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancelled, true, `Esc must cancel the browser`)
  app.stop()
})

test('openTaskBrowser setItems replaces rows live', async () => {
  const { vt, app } = startApp()
  const handle = app.openTaskBrowser(
    [{ value: 'job:1', label: 'bash · build', status: 'running', startedAt: Date.now(), group: 'jobs' }],
    () => {},
    () => {},
    { header: 'tasks' },
  )
  await vt.waitForRender()
  handle.setItems([
    { value: 'job:1', label: 'bash · build', status: 'completed', startedAt: Date.now(), group: 'jobs' },
    { value: 'job:2', label: 'bash · deploy', status: 'failed', startedAt: Date.now(), group: 'jobs' },
  ])
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  const view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('bash · deploy'), `replaced row missing:\n${view}`)
  assert.ok(view.includes('failed'), `new status missing:\n${view}`)
  app.stop()
})

test('openTaskBrowser repaints a subagent row in place on runtime re-projection (running -> inactive)', async () => {
  // The runner's agent/status path: the TaskBrowserRuntime re-projects
  // the CACHED catalog from the Agent registry and commits through
  // handle.setItems — the open browser must flip the SAME row's status
  // word to inactive WITHOUT closing (plan §6.2 Case A) and drop the
  // interrupt verb with it (plan §I).
  const { vt, app } = startApp()
  const handle = app.openTaskBrowser(
    [{
      value: 'agent:child-1',
      label: 'subagent · research',
      suffix: 'continuable',
      status: 'running',
      group: 'subagents',
      treePrefix: '├─ ',
      interruptible: true,
      type: 'subagent',
    }],
    () => {},
    () => {},
    { header: 'tasks · subagents', enableSearch: true },
  )
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
  let view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('running'), `running row missing:\n${view}`)
  assert.ok(view.includes('i interrupt'), `a running continuable must advertise the stop verb:\n${view}`)
  // The child's driver goes idle: the runtime-only commit re-projects
  // the row (SAME value, new status) — this is exactly what the runner's
  // commitRows hook does on agent/status.
  handle.setItems([{
    value: 'agent:child-1',
    label: 'subagent · research',
    suffix: 'continuable',
    status: 'inactive',
    group: 'subagents',
    treePrefix: '├─ ',
    interruptible: false,
    type: 'subagent',
  }])
  await vt.waitForRender()
  view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('inactive'), `the row must repaint to inactive in place:\n${view}`)
  assert.ok(!view.includes('running'), `the old status word must be gone:\n${view}`)
  assert.ok(!view.includes('i interrupt'), `an idle continuable must not advertise the stop verb:\n${view}`)
  assert.ok(view.includes('tasks · subagents'), `the browser must stay open:\n${view}`)
  app.stop()
})

test('openSettings revert() restores a rejected row display (M5 gate)', async () => {
  const { vt, app } = startApp()
  let revertedValue = ''
  app.openSettings(
    [{ id: 'ext', label: 'Plugin setting', currentValue: 'old', values: ['old', 'new'] }],
    (id, value, revert) => {
      assert.equal(id, 'ext')
      // The fork already mutated the row to 'new' before calling onChange;
      // the host calls revert('old') to restore the rejected value.
      revert('old')
      revertedValue = value
    },
    () => {},
  )
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Plugin setting'), `settings list missing:\n${view}`)
  // Activate the row: Enter cycles the value.
  vt.sendInput('\r')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(revertedValue, 'new', 'the onChange received the new value')
  // The displayed row shows the REVERTED (old) value, not the rejected new.
  const stripped = view.replace(/\x1b\[[0-9;]*m/g, '')
  assert.ok(stripped.includes('old'), `rejected row must show the previous value:\n${stripped}`)
  app.stop()
})

test('submitDraft with an empty draft and a staged image submits (image-only gate)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    isImageDraft: () => true,
  })
  app.start()
  await vt.waitForRender()
  // The runner resolves the placeholders to image blocks (plan §11.1): an
  // empty-text draft with images is NOT empty.
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submitted, [''])
  app.stop()
})

test('submitDraft with an empty draft and no image stays a no-op even with the gate wired', async () => {
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    isImageDraft: () => false,
  })
  app.start()
  await vt.waitForRender()
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submitted, [])
  app.stop()
})

test('ctrl+v routes to onClipboardPaste and consumes the key', async () => {
  const vt = new VirtualTerminal(100, 24)
  let pasted = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onClipboardPaste: () => { pasted += 1 },
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('\x16') // legacy Ctrl+V byte
  await vt.waitForRender()
  assert.equal(pasted, 1, 'ctrl+v fires the clipboard paste event')
  assert.ok(!vt.getViewport().join('\n').includes('^V'), 'the key is consumed, never inserted')
  // Kitty-protocol Ctrl+V press routes the same way.
  const { setKittyProtocolActive } = await import('@xmoon76/pi-tui')
  setKittyProtocolActive(true)
  try {
    vt.sendInput('\x1b[118;5u') // ctrl+v press
    await vt.waitForRender()
    assert.equal(pasted, 2)
  } finally {
    setKittyProtocolActive(false)
  }
  app.stop()
})

test('a multimodal submission refused by shouldRememberInput never recalls (review finding)', async () => {
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    // The runner refuses lines carrying image placeholders: their drafts
    // die on consume, so ↑ must never resurrect them as plain text.
    shouldRememberInput: (text) => !text.includes('[image #'),
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('分析 [image #1 (800×600)]')
  await vt.waitForRender()
  vt.sendInput('\r') // submit
  await vt.waitForRender()
  assert.deepEqual(submitted, ['分析 [image #1 (800×600)]'])
  // ↑ (history previous): the multimodal line must NOT come back.
  vt.sendInput('\x1b[A')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('[image #1'), `dead placeholder recalled:\n${view}`)
  app.stop()
})

test('a plain-text submission still recalls through the editor history', async () => {
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    shouldRememberInput: (text) => !text.includes('[image #'),
  })
  app.start()
  await vt.waitForRender()
  vt.sendInput('plain prompt')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['plain prompt'])
  vt.sendInput('\x1b[A')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('plain prompt'), `plain text recalls:\n${view}`)
  app.stop()
})

test('fullscreen drag selection copies through the host copySelection policy (issue #7)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const copied: string[] = []
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    copySelection: async (text) => { copied.push(text); return true },
  })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 0, time: 1_700_000_000_000, data: { id: MessageId('m1'), role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } as SessionEvent,
    { type: 'assistant/message', seq: 1, time: 1_700_000_000_001, data: { turn: 0, step: 0, message: { id: MessageId('m2'), role: 'assistant', content: [{ type: 'text', text: 'alpha\nbeta' }] } } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  app.setFullscreen(true)
  await vt.waitForRender()
  // The fullscreen layout pins the header at row 0, so the transcript
  // starts at row 1: drag from (1,1) across the user + assistant rows
  // (rows 0..4: header, ❯ hello, spacer, 🐋 alpha, beta continuation).
  vt.sendInput('\x1b[<0;1;1M')
  vt.sendInput('\x1b[<32;10;5M')
  vt.sendInput('\x1b[<0;10;5m')
  await vt.waitForRender()
  assert.equal(copied.length, 1, `the drag selection must reach the host policy:\n${vt.getViewport().join('\n')}`)
  const text = copied[0] ?? ''
  assert.ok(text.includes('alpha'), `selected text must carry the transcript content: ${JSON.stringify(text)}`)
  assert.ok(text.includes('beta'), `selected text must carry the wrapped line: ${JSON.stringify(text)}`)
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Copied!'), `the success flash must render:\n${view}`)
  app.stop()
})

test('a reasoning-only assistant message (no text) adds no blank row between cards', async () => {
  const vt = new VirtualTerminal(60, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 0, time: 1_700_000_000_000, data: { id: MessageId('m1'), role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } } as SessionEvent,
    // Thinking streams, then the step settles with a reasoning-only message
    // (NO text block): the image pipeline's non-text-block retention keeps
    // the empty assistant entry — it must not occupy a spacer row, or the
    // thinking card and the next card read two blank rows apart.
    { type: 'assistant/chunk', seq: 1, time: 1_700_000_000_001, data: { turn: 0, step: 0, chunk: { type: 'reasoning-delta', text: 'think one\nthink two\n' } } } as SessionEvent,
    { type: 'assistant/message', seq: 2, time: 1_700_000_000_002, data: { turn: 0, step: 0, message: { id: MessageId('m2'), role: 'assistant', content: [{ type: 'reasoning', text: 'think one\nthink two' }] } } } as SessionEvent,
    { type: 'tool/call', seq: 3, time: 1_700_000_000_003, data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } } as SessionEvent,
    { type: 'tool/result', seq: 4, time: 1_700_000_000_004, data: { turn: 0, step: 0, message: createToolResultMessage({ callId: CallId('c1'), content: [{ type: 'text', text: 'file.txt' }], isError: false }) } } as SessionEvent,
  ])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport()
  // The compact Thinking card previews the LATEST reasoning line.
  const thinkingRow = view.findIndex(line => line.includes('think two'))
  const bashRow = view.findIndex(line => line.includes('Bash ls'))
  assert.ok(thinkingRow >= 0, `thinking card must render:\n${view.join('\n')}`)
  assert.ok(bashRow >= 0, `bash card must render:\n${view.join('\n')}`)
  // Exactly ONE blank row between the cards (the spacer) — the invisible
  // reasoning-only entry must not add a second one.
  const between = view.slice(thinkingRow + 1, bashRow)
  const blankCount = between.filter(line => line.trim() === '').length
  assert.equal(blankCount, 1, `exactly one blank row between cards:\n${view.join('\n')}`)
  app.stop()
})
