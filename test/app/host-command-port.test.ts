/**
 * Contract tests for the Direct Host command execution port (D2.1). Claim
 * precedence remains in the runner; this seam must forward the selected full
 * line, existing attachments, live session identity and cancellation signal.
 * @module @xmoon76/dsh-pi-tui/host-command-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectHostCommandPort, type HostContextLike } from '../../src/runtime/direct/host-command-direct.ts'

function host(services: unknown, live: Map<string, { session: { id: string } }>): HostContextLike {
  return {
    get(name: string): unknown {
      if (name === 'commands') return services
      return undefined
    },
  }
}

test('forwards the full selected line, attachments, live agent and signal', async () => {
  const liveAgent = { session: { id: 'session-a' } }
  const live = new Map([['session-a', liveAgent]])
  const attachments = [{ type: 'image', data: 'bytes' }]
  const signal = new AbortController().signal
  const calls: unknown[] = []
  const execution = { commandId: 'command-1', result: { kind: 'success' as const, text: 'done' } }
  const port = new DirectHostCommandPort(host({
    execute: async (agent: unknown, line: string, received: readonly unknown[], receivedSignal: AbortSignal) => {
      calls.push({ agent, line, attachments: received, signal: receivedSignal })
      return execution
    },
  }, live), sessionId => live.get(sessionId))

  const outcome = await port.execute({
    sessionId: 'session-a',
    line: '/export   report',
    attachments,
    signal,
  })
  assert.deepEqual(outcome, { kind: 'committed', matched: true, execution })
  assert.deepEqual(calls, [{ agent: liveAgent, line: '/export   report', attachments, signal }])
})

test('maps an unmatched official command to committed matched:false', async () => {
  const live = new Map([['session-a', { session: { id: 'session-a' } }]])
  const port = new DirectHostCommandPort(host({ execute: async () => undefined }, live), sessionId => live.get(sessionId))
  assert.deepEqual(await port.execute({ sessionId: 'session-a', line: '/unknown', attachments: [], signal: new AbortController().signal }), {
    kind: 'committed',
    matched: false,
  })
})

test('resolves a replacement live Agent on the next call', async () => {
  const first = { session: { id: 'session-a' } }
  const second = { session: { id: 'session-a' } }
  let current = first
  const seen: unknown[] = []
  const port = new DirectHostCommandPort(host({
    execute: async (agent: unknown) => {
      seen.push(agent)
      return { result: { kind: 'success' } }
    },
  }, new Map()), sessionId => sessionId === 'session-a' ? current : undefined)
  await port.execute({ sessionId: 'session-a', line: '/one', attachments: [], signal: new AbortController().signal })
  current = second
  await port.execute({ sessionId: 'session-a', line: '/two', attachments: [], signal: new AbortController().signal })
  assert.deepEqual(seen, [first, second])
})

test('an already-aborted signal before dispatch settles cancelled without executing', async () => {
  const live = new Map([['session-a', { session: { id: 'session-a' } }]])
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const port = new DirectHostCommandPort(host({
    execute: async () => { calls += 1; return undefined },
  }, live), sessionId => live.get(sessionId))
  // A signal already aborted BEFORE dispatch proves the command never ran, so
  // this is a known cancellation and the executor is not invoked.
  assert.deepEqual(
    await port.execute({ sessionId: 'session-a', line: '/command', attachments: [], signal: controller.signal }),
    { kind: 'cancelled' },
  )
  assert.equal(calls, 0)
})

test('maps non-cancellation command exceptions to indeterminate', async () => {
  const unreadable = new Error('unreadable command error')
  Object.defineProperty(unreadable, 'message', { get: () => { throw new Error('message getter failure') } })
  for (const [failure, message] of [
    [new Error('command invariant failure'), 'command invariant failure'],
    ['non-error command failure', 'non-error command failure'],
    [{ toString: () => { throw new Error('coercion failure') } }, '<unprintable error>'],
    [unreadable, '<error with unreadable message>'],
  ] as const) {
    const live = new Map([['session-a', { session: { id: 'session-a' } }]])
    const port = new DirectHostCommandPort(host({
      execute: async () => { throw failure },
    }, live), sessionId => live.get(sessionId))
    assert.deepEqual(await port.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), {
      kind: 'indeterminate',
      error: { code: 'session/write-indeterminate', message },
    })
  }
})

test('a cancellation-shaped exception AFTER dispatch is indeterminate, never a known cancellation', async () => {
  const failure = new Error('command cancelled')
  failure.name = 'AbortError'
  const live = new Map([['session-a', { session: { id: 'session-a' } }]])
  const port = new DirectHostCommandPort(host({
    execute: async () => { throw failure },
  }, live), sessionId => live.get(sessionId))
  // The pinned executor appends command/run before the handler, so an aborted
  // handler may already have run: the outcome cannot claim "not executed".
  assert.deepEqual(await port.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), {
    kind: 'indeterminate',
    error: { code: 'session/write-indeterminate', message: 'command cancelled' },
  })
})

test('rejects when the command service or live session is unavailable', async () => {
  const noService = new DirectHostCommandPort(host(undefined, new Map()), () => undefined)
  assert.deepEqual(await noService.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), {
    kind: 'rejected',
    error: { code: 'service/unavailable', message: 'commands service unavailable' },
  })
  const noSession = new DirectHostCommandPort(host({ execute: async () => undefined }, new Map()), () => undefined)
  assert.deepEqual(await noSession.execute({ sessionId: 'session-a', line: '/x', attachments: [], signal: new AbortController().signal }), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-a" is not available' },
  })
})

// ── The official Direct receipt path (real Cordis services) ────────────────
// Evidence level: L2. A real Cordis Context, the OFFICIAL `CommandRuntime` and
// the OFFICIAL `FileUploads` service (which itself installs the command receipt
// resolver `commands.execute` consumes) prove the Direct adapter's
// `stageFileReceipt` reaches the same Host authority a split Client reaches
// over the raw upload route.

import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import { probeAttachment } from '../../src/client/media/attachment/intake.ts'
import { streamDraftFile } from '../../src/client/media/attachment/file-stream.ts'
import type { PreparedFile } from '../../src/runtime/prepared-prompt.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

interface OfficialAgent {
  readonly id: string
  readonly session: {
    readonly id: string
    readonly header: { readonly id: string; readonly origin: string }
    readonly seq: number
    eventAt(seq: number): unknown
    snapshotEvents(): readonly unknown[]
    append(type: string, data: unknown): unknown
  }
}

interface OfficialHost {
  readonly ctx: Context
  readonly agents: Map<string, OfficialAgent>
  readonly commands: CommandRuntime
  readonly port: DirectHostCommandPort
  readonly handlerInvocations: { readonly attachments: readonly unknown[] }[]
  createAgent(sessionId: string): OfficialAgent
  dispose(): Promise<void>
}

function officialHost(t: TestContext): OfficialHost {
  const ctx = new Context()
  const agents = new Map<string, OfficialAgent>()
  const stored = new Map<string, { readonly attachmentId: string; readonly name: string; readonly bytes: number; readonly data: Buffer }>()
  let nextAttachment = 0
  const attachments = {
    imageLimits: {
      maxImageBytes: 20 * 1024 * 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 200 * 1024 * 1024,
      maxImagePixels: 64_000_000,
      maxImageDimension: 8192,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    isAttachmentError: () => false,
    async saveFileStream(input: { data: AsyncIterable<Uint8Array>; name?: string; signal?: AbortSignal }) {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of input.data) {
        input.signal?.throwIfAborted()
        chunks.push(Buffer.from(chunk))
        bytes += chunk.byteLength
      }
      nextAttachment += 1
      const ref = { attachmentId: `sha256-${nextAttachment}`, name: input.name ?? 'file', bytes }
      stored.set(ref.attachmentId, { ...ref, data: Buffer.concat(chunks) })
      return ref
    },
    readFileStream(ref: { attachmentId: string }) {
      const found = stored.get(ref.attachmentId)
      if (found === undefined) throw new Error('unknown attachment')
      return (async function* () {
        yield found.data.subarray(0, 2)
        if (found.data.byteLength > 2) yield found.data.subarray(2)
      })()
    },
  }
  ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
  ctx.provide('agents', { get: (sessionId: string) => agents.get(sessionId) } as never)
  ctx.provide('attachments', attachments as never)
  // The OFFICIAL registry (it owns the command lifecycle and the receipt
  // resolver seam), then the OFFICIAL upload service whose constructor installs
  // the resolver through `commands.registerFileReceiptResolver`.
  const commands = new CommandRuntime(ctx)
  new FileUploads(ctx)
  const handlerInvocations: { readonly attachments: readonly unknown[] }[] = []
  commands.register({
    name: 'files',
    description: 'official command FILE receipt proof',
    input: { hint: '<task>', attachments: true },
    handler: (invocation) => {
      handlerInvocations.push({ attachments: invocation.attachments })
      return { kind: 'success', text: 'file verified' }
    },
  })
  const host: OfficialHost = {
    ctx,
    agents,
    commands,
    port: new DirectHostCommandPort(
      { get: (name: string) => ctx.get(name) },
      sessionId => agents.get(sessionId),
    ),
    handlerInvocations,
    createAgent(sessionId) {
      const events: { type: string; seq: number; time: number; data: unknown }[] = []
      const agent: OfficialAgent = {
        id: sessionId,
        session: {
          id: sessionId,
          header: { id: sessionId, origin: 'user' },
          get seq() { return events.length },
          eventAt: (seq: number) => events[seq],
          snapshotEvents: () => Object.freeze([...events]),
          append: (type: string, data: unknown) => {
            const event = { type, seq: events.length, time: Date.now(), data }
            events.push(event)
            return event
          },
        },
      }
      agents.set(sessionId, agent)
      return agent
    },
    async dispose() {
      for (const runtime of [...ctx.registry.values()]) {
        for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
      }
    },
  }
  t.after(() => host.dispose())
  return host
}

async function officialPreparedFile(
  life: ReturnType<typeof testLifecycle>,
  name: string,
  bytes: Buffer,
): Promise<{ readonly file: PreparedFile; readonly path: string }> {
  const root = life.tempDir('dsh-command-receipt-')
  const path = join(root, name)
  await writeFile(path, bytes)
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') throw new Error('unreachable')
  const draft = {
    id: 1,
    kind: 'file' as const,
    name: probe.name,
    byteLength: probe.byteLength,
    placeholder: '',
    source: { type: 'path' as const, path: probe.path, fingerprint: probe.fingerprint },
  }
  return {
    file: {
      name: probe.name,
      byteLength: probe.byteLength,
      source: { kind: 'client-stream', open: signal => streamDraftFile(draft, signal) },
    },
    path,
  }
}

test('the official FileUploads service mints the receipt the command handler reads as a durable FILE', async (t) => {
  const life = testLifecycle(t)
  const host = officialHost(t)
  host.createAgent('session-a')
  const source = Buffer.from('the exact Client source bytes\n')
  const { file } = await officialPreparedFile(life, 'client-only-report.bin', source)
  const signal = new AbortController().signal
  const staged = await host.port.stageFileReceipt({ sessionId: 'session-a', file, signal })
  assert.ok(staged.receiptId.length > 0, 'the Host mints a real Session-scoped receipt')
  assert.equal(host.handlerInvocations.length, 0, 'staging never invokes the handler')
  const outcome = await host.port.execute({
    sessionId: 'session-a',
    line: '/files inspect the report',
    attachments: [{ type: 'file', receiptId: staged.receiptId }],
    signal,
  })
  assert.equal(outcome.kind, 'committed')
  assert.ok(outcome.kind === 'committed' && outcome.matched)
  assert.equal(host.handlerInvocations.length, 1, 'the official executor invoked the handler exactly once')
  const block = host.handlerInvocations[0]?.attachments[0] as { type: string; attachment: { attachmentId: string; name: string; bytes: number } }
  assert.equal(block.type, 'file', 'the receipt resolved to a durable FILE block')
  assert.equal(block.attachment.name, 'client-only-report.bin')
  assert.equal(block.attachment.bytes, source.byteLength)
  // The handler reads the Host-STORED bytes through the official attachment
  // authority — the same read the F4 smoke uses — and they equal the source.
  const digest = createHash('sha256')
  const attachments = host.ctx.get('attachments') as { readFileStream(ref: unknown): AsyncIterable<Uint8Array> }
  for await (const chunk of attachments.readFileStream(block.attachment)) digest.update(chunk)
  assert.equal(digest.digest('hex'), createHash('sha256').update(source).digest('hex'))
})

test('a foreign Session receipt does not resolve and the handler never runs', async (t) => {
  const life = testLifecycle(t)
  const host = officialHost(t)
  host.createAgent('session-a')
  host.createAgent('session-b')
  const { file } = await officialPreparedFile(life, 'foreign.bin', Buffer.from([1, 2, 3]))
  const signal = new AbortController().signal
  const staged = await host.port.stageFileReceipt({ sessionId: 'session-a', file, signal })
  const outcome = await host.port.execute({
    sessionId: 'session-b',
    line: '/files inspect foreign',
    attachments: [{ type: 'file', receiptId: staged.receiptId }],
    signal,
  })
  assert.equal(outcome.kind, 'committed')
  assert.equal(host.handlerInvocations.length, 0, 'the foreign receipt is refused before the handler')
  assert.ok(outcome.kind === 'committed' && outcome.matched)
  assert.equal((outcome.execution as { result: { kind: string } }).result.kind, 'error',
    'the official executor settles the admission refusal as a command error')
})

test('staging fails closed without the official upload service, for a disposed Agent or a recalled file', async (t) => {
  const life = testLifecycle(t)
  const host = officialHost(t)
  host.createAgent('session-a')
  const { file } = await officialPreparedFile(life, 'report.bin', Buffer.from([1]))
  const signal = new AbortController().signal

  const noService = new DirectHostCommandPort(
    { get: () => undefined },
    () => ({ session: { id: 'session-a' } }),
  )
  await assert.rejects(
    () => noService.stageFileReceipt({ sessionId: 'session-a', file, signal }),
    /fileUploads service unavailable/,
  )

  host.agents.delete('session-a')
  await assert.rejects(
    () => host.port.stageFileReceipt({ sessionId: 'session-a', file, signal }),
    /session "session-a" is not available/,
  )

  host.createAgent('session-a')
  await assert.rejects(
    () => host.port.stageFileReceipt({
      sessionId: 'session-a',
      file: { name: 'stored.bin', byteLength: 1, source: { kind: 'recalled-unsupported' } },
      signal,
    }),
    /stored file "stored.bin" cannot be re-uploaded/,
  )
})

test('an aborted or changed Client source stages no receipt', async (t) => {
  const life = testLifecycle(t)
  const host = officialHost(t)
  host.createAgent('session-a')

  const aborted = new AbortController()
  aborted.abort()
  const changed = await officialPreparedFile(life, 'changed.bin', Buffer.from([1, 2, 3, 4]))
  await assert.rejects(
    () => host.port.stageFileReceipt({ sessionId: 'session-a', file: changed.file, signal: aborted.signal }),
    /aborted/i,
  )
  await writeFile(changed.path, Buffer.from('changed'), { mode: 0o600 })
  await assert.rejects(
    () => host.port.stageFileReceipt({ sessionId: 'session-a', file: changed.file, signal: new AbortController().signal }),
    /File changed since it was attached/,
  )
  assert.equal(host.handlerInvocations.length, 0)
})
