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

test('notify is transient: cleared by the next transcript repaint', async () => {
  const { vt, app } = startApp()
  app.notify('resume failed')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('resume failed'), `notify line missing:\n${view}`)
  app.setTranscript([])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('resume failed'), `notify line survived a repaint:\n${view}`)
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


test('footer mode slot badges non-default permission presets', async () => {
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
  // The default preset shows nothing, so the footer stays calm.
  app.setStatus({ permission: 'workspace-write' })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('[workspace-write]'), `default preset must not badge:\n${view}`)
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
