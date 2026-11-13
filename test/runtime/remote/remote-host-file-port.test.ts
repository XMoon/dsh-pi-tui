/**
 * Contract tests for the M3-3A Remote Host-file adapter
 * (runtime/remote/host-file-remote.ts, TS8-HF1 namespace): the private
 * Session-scoped `piTuiFileReferences/list` mapping, the Host-business
 * `unavailable` value crossing as the port's own outcome, the truthful
 * unavailable states for the workspace scope and existence/canonicalization,
 * and the hard locality rule (no Client filesystem access ever).
 * @module @xmoon76/dsh-pi-tui/remote-host-file-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteHostFilePort, type RemotePiTuiFileReferenceRemotes } from '../../../src/runtime/remote/host-file-remote.ts'
import type { HostFileListResult } from '../../../src/runtime/host-file-port.ts'
import { createObservableGenerationHarness } from '../../support/remote-generation.ts'

type ListCall = { sessionId: string; query: string; signal: AbortSignal | undefined }
type WorkspaceListCall = { workspaceId: string; query: string; signal: AbortSignal | undefined }
type WireResult = { ok: true; value: HostFileListResult } | { ok: false; error: unknown }

function harness(options: {
  result?: WireResult
  workspaceResult?: WireResult
  throw?: unknown
  gate?: Promise<void>
} = {}) {
  const generation = createObservableGenerationHarness()
  const calls: ListCall[] = []
  const workspaceCalls: WorkspaceListCall[] = []
  const fileReferences: RemotePiTuiFileReferenceRemotes = {
    list: async (sessionId: string, query: string, signal?: AbortSignal) => {
      calls.push({ sessionId, query, signal })
      if (options.gate !== undefined) await options.gate
      if (options.throw !== undefined) throw options.throw
      return options.result ?? { ok: true as const, value: { kind: 'ok', items: [] } }
    },
    listWorkspace: async (workspaceId: string, query: string, signal?: AbortSignal) => {
      workspaceCalls.push({ workspaceId, query, signal })
      if (options.gate !== undefined) await options.gate
      if (options.throw !== undefined) throw options.throw
      return options.workspaceResult ?? { ok: true as const, value: { kind: 'ok', items: [] } }
    },
  }
  return { generation, calls, workspaceCalls, port: new RemoteHostFilePort(fileReferences, generation.source) }
}

test('the session scope sends the EXACT session id and the OFFICIAL query form', async () => {
  const { port, calls } = harness({
    result: { ok: true, value: { kind: 'ok', items: [{ path: 'src/a.ts', kind: 'file' }] } },
  })
  const result = await port.listReferences({ kind: 'session', sessionId: 'child-7' }, 'src/a')
  assert.deepEqual(result, { kind: 'ok', items: [{ path: 'src/a.ts', kind: 'file' }] })
  // The official contract: `query` is the path text FOLLOWING the `@` —
  // never the editor's at-prefixed form. The private method takes the Session
  // identity as its first wire argument (not the official `agentId` lookup).
  assert.deepEqual(calls, [{ sessionId: 'child-7', query: 'src/a', signal: undefined }])
})

test('an authoritative Host empty answer stays ok([]) — not unavailable', async () => {
  const { port } = harness({ result: { ok: true, value: { kind: 'ok', items: [] } } })
  assert.deepEqual(await port.listReferences({ kind: 'session', sessionId: 's' }, 'none'),
    { kind: 'ok', items: [] })
})

test('a Host-business unavailable VALUE crosses as the port unavailable', async () => {
  const { port } = harness({
    result: { ok: true, value: { kind: 'unavailable', reason: 'the requested Session has no live Host Agent' } },
  })
  const result = await port.listReferences({ kind: 'session', sessionId: 'gone' }, 'src/')
  assert.deepEqual(result, { kind: 'unavailable', reason: 'the requested Session has no live Host Agent' })
})

test('the AbortSignal is forwarded to the private call', async () => {
  const controller = new AbortController()
  const { port, calls } = harness()
  await port.listReferences({ kind: 'session', sessionId: 's' }, 'x', { signal: controller.signal })
  assert.equal(calls[0]!.signal, controller.signal)
})

test('an already-aborted request never dispatches', async () => {
  const controller = new AbortController()
  controller.abort()
  const { port, calls } = harness()
  await assert.rejects(port.listReferences({ kind: 'session', sessionId: 's' }, 'x', { signal: controller.signal }))
  assert.deepEqual(calls, [])
})

test('the returned candidates are detached from the wire value', async () => {
  const wire: { path: string; kind: 'file' | 'directory' }[] = [{ path: 'a.ts', kind: 'file' }]
  const { port } = harness({ result: { ok: true, value: { kind: 'ok', items: wire } } })
  const result = await port.listReferences({ kind: 'session', sessionId: 's' }, 'a')
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.notEqual(result.items, wire)
    ;(result.items as unknown as Array<{ path: string }>)[0]!.path = 'MUTATED'
    assert.equal(wire[0]!.path, 'a.ts', 'the wire array is never aliased')
  }
})

test('a replaced connection turns the settle unavailable', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { port, generation } = harness({
    gate,
    result: { ok: true, value: { kind: 'ok', items: [{ path: 'a', kind: 'file' }] } },
  })
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

test('a Host domain error surfaces as an error, never an empty ok', async () => {
  const { port } = harness({ result: { ok: false, error: { code: 'piTuiFileReferences/failed', message: 'no such session' } } })
  await assert.rejects(port.listReferences({ kind: 'session', sessionId: 's' }, 'a'), /no such session/)
})

test('no connection reads unavailable without any Host call', async () => {
  const { port, generation, calls } = harness()
  generation.set(undefined)
  const result = await port.listReferences({ kind: 'session', sessionId: 's' }, 'a')
  assert.equal(result.kind, 'unavailable')
  assert.deepEqual(calls, [])
})

test('a pre-aborted WORKSPACE request rejects before the unselected answer', async () => {
  const { port, workspaceCalls } = harness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    port.listReferences({ kind: 'workspace', selectionRevision: 1 }, 'a', { signal: controller.signal }),
    /aborted/u,
    'cancellation outranks the unselected-scope unavailable')
  assert.deepEqual(workspaceCalls, [], 'the rejected request never dispatches')
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

test('an UNSELECTED workspace scope is unavailable with ZERO Remote calls', async () => {
  const { port, workspaceCalls } = harness()
  const result = await port.listReferences({ kind: 'workspace', selectionRevision: 3 }, 'a')
  assert.equal(result.kind, 'unavailable')
  assert.match(result.kind === 'unavailable' ? result.reason : '', /Choose a Host workspace first/)
  assert.deepEqual(workspaceCalls, [], 'an unselected scope never dispatches')
})

test('a CONFIRMED workspace scope sends the exact workspaceId and the official query', async () => {
  const { port, workspaceCalls } = harness({
    workspaceResult: { ok: true, value: { kind: 'ok', items: [{ path: 'src/a.ts', kind: 'file' }] } },
  })
  const result = await port.listReferences({ kind: 'workspace', workspaceId: 'workspace-7', selectionRevision: 2 }, 'src/a')
  assert.deepEqual(result, { kind: 'ok', items: [{ path: 'src/a.ts', kind: 'file' }] })
  assert.deepEqual(workspaceCalls, [{ workspaceId: 'workspace-7', query: 'src/a', signal: undefined }],
    'only the Host-issued id and the query cross the wire — never a cwd nor the selection revision')
  assert.equal((workspaceCalls[0]! as { selectionRevision?: number }).selectionRevision, undefined)
})

test('an EXPLICIT workspace query crosses the wire UNCHANGED — the Client port never classifies paths', async () => {
  const { port, workspaceCalls } = harness()
  await port.listReferences({ kind: 'workspace', workspaceId: 'workspace-7', selectionRevision: 2 }, '../shared/foo')
  await port.listReferences({ kind: 'workspace', workspaceId: 'workspace-7', selectionRevision: 2 }, '/abs/dir/')
  assert.deepEqual(workspaceCalls.map(call => call.query), ['../shared/foo', '/abs/dir/'],
    'the raw explicit query is forwarded verbatim; the HOST decides the route')
  assert.deepEqual(workspaceCalls.map(call => call.workspaceId), ['workspace-7', 'workspace-7'])
})

test('a Host-business unavailable VALUE from listWorkspace crosses as unavailable', async () => {
  const { port } = harness({
    workspaceResult: { ok: true, value: { kind: 'unavailable', reason: 'Workspace "gone" is not registered on the Host' } },
  })
  const result = await port.listReferences({ kind: 'workspace', workspaceId: 'gone', selectionRevision: 1 }, 'a')
  assert.deepEqual(result, { kind: 'unavailable', reason: 'Workspace "gone" is not registered on the Host' })
})

test('a replaced connection during listWorkspace turns the settle unavailable', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const { port, generation } = harness({
    gate,
    workspaceResult: { ok: true, value: { kind: 'ok', items: [{ path: 'a', kind: 'file' }] } },
  })
  const pending = port.listReferences({ kind: 'workspace', workspaceId: 'workspace-1', selectionRevision: 1 }, 'a')
  generation.set({ id: 4 })
  release()
  const result = await pending
  assert.equal(result.kind, 'unavailable')
})

test('no existence carrier — unavailable, never missing', async () => {
  const { port, calls } = harness()
  const result = await port.resolveReference({ kind: 'session', sessionId: 's' }, 'a.ts')
  assert.equal(result.kind, 'unavailable')
  assert.deepEqual(calls, [], 'existence never dispatches a discovery call')
})

test('canonicalization keeps every relative mention literal', async () => {
  const { port } = harness()
  assert.equal(await port.canonicalizeMentions({ kind: 'session', sessionId: 's' }, 'see @src/a.ts and @b.md'),
    'see @src/a.ts and @b.md')
})

test('the adapter module never touches the Client filesystem', async () => {
  const { readFileSync } = await import('node:fs')
  const adapterSource = readFileSync('src/runtime/remote/host-file-remote.ts', 'utf8')
  assert.ok(!/\bprocess\.cwd\(\)/.test(adapterSource), 'no process.cwd()')
  assert.ok(!/\bhomedir\(\)/.test(adapterSource), 'no homedir()')
  assert.ok(!/\bstatSync\(|\brealpath\(|\breaddir\(/.test(adapterSource), 'no fs probes')
  // The Client-local discovery capability (TS8-A owner: client/file-completion):
  // the Remote Host adapter must never borrow the CLIENT filesystem to answer a
  // Host query, in any spelling.
  assert.ok(!/ClientLocalDiscoveryDriver|local-discovery|client\/file-completion/u.test(adapterSource),
    'no Client-local discovery capability')
  // TS8-HF1: the explicit-scope Host scanner is reached only on the HOST side
  // of the wire; this Client adapter must not import it either.
  assert.ok(!/DirectHostDiscoveryDriver|host-discovery|runtime\/direct/u.test(adapterSource),
    'no Direct Host discovery capability')
  // The bare/explicit route decision belongs to the HOST (the shared classifier
  // runs there); the Client port forwards the raw query unchanged.
  assert.ok(!/isExplicitHostFileQuery|host-file-augmentation/u.test(adapterSource),
    'the Client port never classifies the path itself')
})

test('the child scope carries the CHILD session id — never a parent cwd', async () => {
  const { port, calls } = harness({ result: { ok: true, value: { kind: 'ok', items: [] } } })
  await port.listReferences({ kind: 'session', sessionId: 'child-9' }, 'x')
  assert.equal(calls[0]!.sessionId, 'child-9')
  assert.equal((calls[0]! as { cwd?: string }).cwd, undefined,
    'the wire carries the session identity only; the Host owns the cwd semantics')
})
