/**
 * Contract tests for the M3-3A Remote Host-file adapter
 * (runtime/remote/host-file-remote.ts): the official Session-scoped
 * `fileReferences/list` mapping, the truthful unavailable states for the
 * workspace scope and existence/canonicalization, and the hard locality
 * rule (no Client filesystem access ever).
 * @module @xmoon76/dsh-pi-tui/remote-host-file-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteHostFilePort, type RemoteHostFileRemotes } from '../src/runtime/remote/host-file-remote.ts'
import { createObservableGenerationHarness } from './support/remote-generation.ts'

type ListCall = { agentId: string; query: string; signal: AbortSignal | undefined }

function harness(options: {
  result?: { ok: true; value: readonly { path: string; kind: 'file' | 'directory' }[] } | { ok: false; error: unknown }
  throw?: unknown
  gate?: Promise<void>
} = {}) {
  const generation = createObservableGenerationHarness()
  const calls: ListCall[] = []
  const fileReferences: RemoteHostFileRemotes = {
    list: async (agentId: string, query: string, signal?: AbortSignal) => {
      calls.push({ agentId, query, signal })
      if (options.gate !== undefined) await options.gate
      if (options.throw !== undefined) throw options.throw
      return options.result ?? { ok: true as const, value: [] }
    },
  }
  return { generation, calls, port: new RemoteHostFilePort(fileReferences, generation.source) }
}

test('F1: the session scope sends the EXACT session id and the OFFICIAL query form', async () => {
  const { port, calls } = harness({ result: { ok: true, value: [{ path: 'src/a.ts', kind: 'file' }] } })
  const result = await port.listReferences({ kind: 'session', sessionId: 'child-7' }, 'src/a')
  assert.deepEqual(result, { kind: 'ok', items: [{ path: 'src/a.ts', kind: 'file' }] })
  // The official contract: `query` is the path text FOLLOWING the `@` —
  // never the editor's at-prefixed form.
  assert.deepEqual(calls, [{ agentId: 'child-7', query: 'src/a', signal: undefined }])
})

test('F1b: an authoritative Host empty answer stays ok([]) — not unavailable', async () => {
  const { port } = harness({ result: { ok: true, value: [] } })
  assert.deepEqual(await port.listReferences({ kind: 'session', sessionId: 's' }, 'none'),
    { kind: 'ok', items: [] })
})

test('F2: the AbortSignal is forwarded to the official call', async () => {
  const controller = new AbortController()
  const { port, calls } = harness()
  await port.listReferences({ kind: 'session', sessionId: 's' }, 'x', { signal: controller.signal })
  assert.equal(calls[0]!.signal, controller.signal)
})

test('F2b: an already-aborted request never dispatches', async () => {
  const controller = new AbortController()
  controller.abort()
  const { port, calls } = harness()
  await assert.rejects(port.listReferences({ kind: 'session', sessionId: 's' }, 'x', { signal: controller.signal }))
  assert.deepEqual(calls, [])
})

test('F3: the returned candidates are detached from the wire value', async () => {
  const wire: { path: string; kind: 'file' | 'directory' }[] = [{ path: 'a.ts', kind: 'file' }]
  const { port } = harness({ result: { ok: true, value: wire } })
  const result = await port.listReferences({ kind: 'session', sessionId: 's' }, 'a')
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.notEqual(result.items, wire)
    ;(result.items as unknown as Array<{ path: string }>)[0]!.path = 'MUTATED'
    assert.equal(wire[0]!.path, 'a.ts', 'the wire array is never aliased')
  }
})

test('F4: a replaced connection turns the settle unavailable', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { port, generation } = harness({ gate, result: { ok: true, value: [{ path: 'a', kind: 'file' }] } })
  const pending = port.listReferences({ kind: 'session', sessionId: 's' }, 'a')
  generation.set({ id: 2 })
  release()
  const result = await pending
  assert.equal(result.kind, 'unavailable')
  const thrown = harness({
    gate,
    throw: new Error('transport broke mid-flight'),
  })
  const pendingThrow = thrown.port.listReferences({ kind: 'session', sessionId: 's' }, 'a')
  thrown.generation.set({ id: 5 })
  release()
  assert.equal((await pendingThrow).kind, 'unavailable',
    'a generation-replaced throw is unavailable, never the new generation\'s failure')
})

test('F4b: a Host domain error surfaces as an error, never an empty ok', async () => {
  const { port } = harness({ result: { ok: false, error: { code: 'session/not-found', message: 'no such session' } } })
  await assert.rejects(port.listReferences({ kind: 'session', sessionId: 's' }, 'a'), /no such session/)
})

test('no connection reads unavailable without any Host call', async () => {
  const { port, generation, calls } = harness()
  generation.set(undefined)
  const result = await port.listReferences({ kind: 'session', sessionId: 's' }, 'a')
  assert.equal(result.kind, 'unavailable')
  assert.deepEqual(calls, [])
})

test('F5+cancellation: a pre-aborted WORKSPACE request rejects before the unsupported answer', async () => {
  const { port, calls } = harness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    port.listReferences({ kind: 'workspace', cwd: '/any' }, 'a', { signal: controller.signal }),
    /aborted/u,
    'cancellation outranks the workspace-scope unavailable')
  assert.deepEqual(calls, [], 'the rejected request never dispatches')
})

test('a pre-aborted resolveReference rejects instead of answering unavailable', async () => {
  const { port } = harness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    port.resolveReference({ kind: 'session', sessionId: 's' }, 'a.ts', { signal: controller.signal }),
    /aborted/u,
    'cancellation outranks the no-carrier unavailable on the synchronous resolve path')
})

test('F5: the workspace scope is unavailable with ZERO Remote calls', async () => {
  const { port, calls } = harness()
  const result = await port.listReferences({ kind: 'workspace', cwd: '/any/cwd' }, 'a')
  assert.equal(result.kind, 'unavailable')
  assert.match(result.kind === 'unavailable' ? result.reason : '', /no official Remote carrier/)
  assert.deepEqual(calls, [], 'the workspace scope never dispatches')
})

test('F6: no existence carrier — unavailable, never missing', async () => {
  const { port, calls } = harness()
  const result = await port.resolveReference({ kind: 'session', sessionId: 's' }, 'a.ts')
  assert.equal(result.kind, 'unavailable')
  assert.deepEqual(calls, [], 'existence never dispatches a discovery call')
})

test('F7: canonicalization keeps every relative mention literal', async () => {
  const { port } = harness()
  assert.equal(await port.canonicalizeMentions({ kind: 'session', sessionId: 's' }, 'see @src/a.ts and @b.md'),
    'see @src/a.ts and @b.md')
})

test('F8: the adapter module never touches the Client filesystem', async () => {
  const { readFileSync } = await import('node:fs')
  const adapterSource = readFileSync('src/runtime/remote/host-file-remote.ts', 'utf8')
  assert.ok(!/\bprocess\.cwd\(\)/.test(adapterSource), 'no process.cwd()')
  assert.ok(!/\bhomedir\(\)/.test(adapterSource), 'no homedir()')
  assert.ok(!/\bstatSync\(|\brealpath\(|\breaddir\(/.test(adapterSource), 'no fs probes')
  assert.ok(!/LocalFileSource/.test(adapterSource), 'no LocalFileSource')
})

test('F9: the child scope carries the CHILD session id — never a parent cwd', async () => {
  const { port, calls } = harness({ result: { ok: true, value: [] } })
  await port.listReferences({ kind: 'session', sessionId: 'child-9' }, 'x')
  assert.equal(calls[0]!.agentId, 'child-9')
  assert.equal((calls[0]! as { cwd?: string }).cwd, undefined,
    'the wire carries the session identity only; the Host owns the cwd semantics')
})
