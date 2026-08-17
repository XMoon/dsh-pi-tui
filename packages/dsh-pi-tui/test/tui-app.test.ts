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
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toolPresenterFrom } from '../src/present.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
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

test('submits editor content to the onSubmit event', async () => {
  const { vt, submitted } = startApp()
  await vt.waitForRender()
  vt.sendInput('hello')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['hello'])
})

test('ctrl+c triggers the exit event', async () => {
  const surface = startApp()
  await surface.vt.waitForRender()
  surface.vt.sendInput('\x03')
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
  assert.ok(!view.includes('❯'), `empty queue must render no pane:\n${view}`)
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
  assert.ok(!view.includes('❯ follow up'), `cleared queue still rendered:\n${view}`)
})

test('job notices in the queue render with their own marker and drop the steer hints', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  // Only a job-completion notice queued: no steerable content at all.
  app.setQueueItems([{ id: 'j-1', text: 'bash-2 pnpm build finished: exit 0', mode: 'steer', notice: true }])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('⏳ bash-2 pnpm build finished'), `notice row missing its marker:\n${view}`)
  assert.ok(!view.includes('❯'), `a notice must not render as steerable input:\n${view}`)
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

test('down and ctrl+j open the task browser only with active tasks and an empty editor', async () => {
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
  // No active tasks: ↓ and Ctrl+J are inert.
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 0, `no tasks means no browser`)
  app.setTasks([{ id: 'bash-1', label: 'pnpm build', status: 'running', kind: 'bash' }])
  await vt.waitForRender()
  // Empty editor + active tasks: both keys open the browser.
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 1, `down must open the task browser with an empty editor`)
  vt.sendInput('\n') // ctrl+j is LF
  await sleep(20)
  assert.equal(opened, 2, `ctrl+j must open the task browser with an empty editor`)
  // Non-empty draft: the keys keep their editing meaning (no browser).
  app.setDraft('ls -la')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 2, `down must not open the browser while a draft is being edited`)
  // Tasks cleared: the trigger disarms.
  app.setTasks([])
  app.setDraft('')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 2, `the trigger must disarm when no tasks are active`)
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
  vt.sendInput('\n') // ctrl+j is LF
  await sleep(20)
  assert.equal(opened, 2, `ctrl+j must open the task browser with a live subagent`)
  // Clearing agents disarms; clearing jobs while agents live must not.
  app.setAgents([])
  app.setTasks([])
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 2, `the trigger must disarm when no agents are active`)
  app.setTasks([{ id: 'bash-1', label: 'pnpm build', status: 'running', kind: 'bash' }])
  app.setAgents([])
  await vt.waitForRender()
  app.setTasks([])
  app.setAgents([{ id: 'child-abc', label: 'research', activity: 'running' }])
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await sleep(20)
  assert.equal(opened, 3, `agents must keep the trigger armed when tasks clear`)
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
  assert.equal(editorLine(), 'new cmd', 'the OLD workspace entry must not be recalled')
  // An empty reset clears the mirror, and a later seed recalls ONLY the new
  // entries (nothing of the old workspace survives).
  app.resetInputHistory([])
  assert.deepEqual(app.getInputHistory(), [], 'cleared mirror must be empty')
  app.resetInputHistory(['fresh cmd'])
  await vt.waitForRender()
  app.setDraft('')
  vt.sendInput('\x1b[A')
  await vt.waitForRender()
  assert.equal(editorLine(), 'fresh cmd', 'only the newest workspace entries must be recallable')
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

test('the subagent viewer covers the editor, consumes input, and restores the draft on exit', async () => {
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
  app.setViewerMode({ id: 'child-1', label: 'research' })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('viewing subagent: research — read-only · Esc returns'), `placeholder missing:\n${view}`)
  assert.ok(view.includes('[viewing subagent]'), `header badge missing:\n${view}`)
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
  assert.ok(!view.includes('[viewing subagent]'), `badge survived leaving:\n${view}`)
  app.stop()
})

test('ctrl+o still folds the viewed transcript while the viewer is up', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
  })
  app.start()
  app.setViewerMode({ id: 'child-1', label: 'research' })
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
