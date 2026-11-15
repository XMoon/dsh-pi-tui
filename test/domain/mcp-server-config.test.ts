/**
 * FR4 — the pure MCP server configuration editing domain.
 *
 * Evidence level: unit/contract (L1/L2). These are the discriminating
 * negatives the adapters and the page cannot see on their own: a
 * cross-transport field combination the official manager schema refuses, an
 * invalid `${credential:REF}` token, a name outside the official grammar, a
 * per-key dict patch that must NOT wash away unknown fields, and the
 * User-added/Inherited/Overridden classification that decides whether a
 * `unset ['servers', name]` is a Delete or a Reset.
 *
 * @module @xmoon76/dsh-pi-tui/domain/mcp-server-config.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MCP_SERVER_NAME_PATTERN,
  classifyMcpServerProvenance,
  diffMcpServerDraft,
  mcpAddOps,
  mcpEditOps,
  mcpRemoveOps,
  mcpSetEnabledOps,
  projectMcpServerEntry,
  validateMcpServerDraft,
  type McpServerEntryDraft,
} from '../../src/domain/mcp/server-config.ts'

function stdioDraft(overrides: Partial<McpServerEntryDraft> = {}): McpServerEntryDraft {
  return {
    transport: 'stdio',
    command: '/bin/echo',
    args: [],
    env: new Map(),
    cwd: '',
    url: '',
    headers: new Map(),
    enabled: true,
    ...overrides,
  }
}

function httpDraft(overrides: Partial<McpServerEntryDraft> = {}): McpServerEntryDraft {
  return {
    transport: 'streamable-http',
    command: '',
    args: [],
    env: new Map(),
    cwd: '',
    url: 'https://example.test/mcp',
    headers: new Map(),
    enabled: true,
    ...overrides,
  }
}

test('the name grammar is the official 1-32 ASCII word-character pattern', () => {
  for (const name of ['a', 'A_b-9', 'x'.repeat(32)]) assert.equal(MCP_SERVER_NAME_PATTERN.test(name), true, name)
  for (const name of ['', 'x'.repeat(33), 'has space', 'dot.name', 'slash/name', 'ümlaut', 'a\nb']) {
    assert.equal(MCP_SERVER_NAME_PATTERN.test(name), false, JSON.stringify(name))
  }
  const issues = validateMcpServerDraft('bad name', stdioDraft())
  assert.equal(issues[0]?.field, 'name')
})

test('a valid stdio and a valid streamable-http draft have no issues', () => {
  assert.deepEqual(validateMcpServerDraft('ok-name', stdioDraft({ args: ['--flag', '${credential:TOKEN}'] })), [])
  assert.deepEqual(validateMcpServerDraft('ok-http', httpDraft({ headers: new Map([['Authorization', 'Bearer ${credential:API_KEY}']]) })), [])
})

test('a stdio server requires a command; a streamable-http server requires a URL', () => {
  assert.equal(validateMcpServerDraft('s', stdioDraft({ command: '   ' }))[0]?.field, 'command')
  assert.equal(validateMcpServerDraft('h', httpDraft({ url: '' }))[0]?.field, 'url')
})

test('an invalid template token is refused in every templated field', () => {
  for (const value of ['${credential:}', '${token:ABC}', '${credential:1BAD}', '${x${credential:A}']) {
    assert.ok(validateMcpServerDraft('s', stdioDraft({ command: value })).length > 0, value)
    assert.ok(validateMcpServerDraft('s', stdioDraft({ args: [value] })).length > 0, value)
    assert.ok(validateMcpServerDraft('s', stdioDraft({ env: new Map([['K', value]]) })).length > 0, value)
    assert.ok(validateMcpServerDraft('s', stdioDraft({ cwd: value })).length > 0, value)
    assert.ok(validateMcpServerDraft('h', httpDraft({ url: value })).length > 0, value)
    assert.ok(validateMcpServerDraft('h', httpDraft({ headers: new Map([['K', value]]) })).length > 0, value)
  }
  // A valid reference is accepted, including adjacent plain text.
  assert.deepEqual(validateMcpServerDraft('s', stdioDraft({ args: ['--token=${credential:TOKEN}'] })), [])
})

test('an env/header key that cannot be a settings path segment is refused', () => {
  for (const key of ['', 'a.b', 'a$b', 'a\nb']) {
    assert.ok(validateMcpServerDraft('s', stdioDraft({ env: new Map([[key, 'v']]) })).length > 0, JSON.stringify(key))
    assert.ok(validateMcpServerDraft('h', httpDraft({ headers: new Map([[key, 'v']]) })).length > 0, JSON.stringify(key))
  }
  // A plain key is fine.
  assert.deepEqual(validateMcpServerDraft('s', stdioDraft({ env: new Map([['API_TOKEN', 'v']]) })), [])
})

test('an Add writes ONE whole-entry set with only the transport own fields', () => {
  const ops = mcpAddOps('new-one', stdioDraft({ args: ['a b', 'c'], env: new Map([['K', '${credential:V}']]), enabled: false }))
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0]?.path, ['servers', 'new-one'])
  assert.equal(ops[0]?.op, 'set')
  assert.deepEqual(ops[0]?.value, {
    transport: 'stdio',
    enabled: false,
    command: '/bin/echo',
    args: ['a b', 'c'],
    cwd: '',
    env: { K: '${credential:V}' },
  })
  // No cross-transport field ever rides a stdio add.
  const value = ops[0]?.value as Record<string, unknown>
  assert.equal('url' in value, false)
  assert.equal('headers' in value, false)
  // The deferred budget fields are never restated.
  for (const field of ['startupTimeoutMs', 'toolCallTimeoutMs', 'closeTimeoutMs', 'reconnect']) {
    assert.equal(field in value, false, field)
  }
})

test('an Edit patches ONLY the dirty paths and preserves unknown/deferred fields', () => {
  const effective = {
    transport: 'stdio' as const,
    command: '/bin/echo',
    args: ['a'],
    env: new Map([['KEEP', 'same'], ['DROP', 'x']]),
    cwd: '',
    enabled: true,
  }
  const draft = stdioDraft({
    command: '/bin/echo', // unchanged
    args: ['a', 'b'], // whole-list replacement
    env: new Map([['KEEP', 'same'], ['NEW', 'v']]),
    cwd: '',
    enabled: true,
  })
  const ops = mcpEditOps('srv', effective, draft, diffMcpServerDraft(effective, draft))
  assert.deepEqual(ops, [
    { op: 'set', path: ['servers', 'srv', 'args'], value: ['a', 'b'] },
    { op: 'set', path: ['servers', 'srv', 'env', 'NEW'], value: 'v' },
    { op: 'unset', path: ['servers', 'srv', 'env', 'DROP'] },
  ])
  // The unchanged dict key is never restated, and the entry is never rewritten
  // as a whole object.
  assert.equal(ops.some(op => op.path.length === 2), false)
  assert.equal(ops.some(op => op.op === 'set' && op.path[2] === 'env' && op.path.length === 3), false)
})

test('an Edit with no change produces ZERO ops (no pointless CAS write)', () => {
  const effective = { transport: 'stdio' as const, command: '/bin/echo', args: [], env: new Map(), cwd: '', enabled: true }
  const draft = stdioDraft()
  assert.deepEqual(mcpEditOps('srv', effective, draft, diffMcpServerDraft(effective, draft)), [])
})

test('a transport switch resets the abandoned transport fields to schema defaults', () => {
  const effective = {
    transport: 'stdio' as const,
    command: '/bin/echo',
    args: ['x'],
    env: new Map([['K', 'v']]),
    cwd: '/tmp',
    enabled: true,
  }
  const draft = httpDraft()
  const ops = mcpEditOps('srv', effective, draft, diffMcpServerDraft(effective, draft))
  const byPath = new Map(ops.map(op => [op.path.join('.'), op]))
  assert.equal(byPath.get('servers.srv.transport')?.value, 'streamable-http')
  assert.equal(byPath.get('servers.srv.url')?.value, 'https://example.test/mcp')
  // The abandoned stdio fields are SET to the official defaults, never unset
  // (an unset would resurrect an inherited value).
  assert.deepEqual(byPath.get('servers.srv.command'), { op: 'set', path: ['servers', 'srv', 'command'], value: '' })
  assert.deepEqual(byPath.get('servers.srv.args'), { op: 'set', path: ['servers', 'srv', 'args'], value: [] })
  assert.deepEqual(byPath.get('servers.srv.env'), { op: 'set', path: ['servers', 'srv', 'env'], value: {} })
  assert.deepEqual(byPath.get('servers.srv.cwd'), { op: 'set', path: ['servers', 'srv', 'cwd'], value: '' })
  for (const op of ops) assert.equal(op.op, 'set', 'a switch never unsets a field')
})

test('Delete and Reset are the SAME official op — the preconditions differ', () => {
  assert.deepEqual(mcpRemoveOps('gone'), [{ op: 'unset', path: ['servers', 'gone'] }])
  // The provenance decides which user action is allowed, never the wording.
  // The SECOND argument is the EFFECTIVE descriptor layer (`value`).
  const base = { servers: { inherited: { transport: 'stdio' }, both: { transport: 'stdio' } } }
  const value = { servers: {
    inherited: { transport: 'stdio' },
    both: { transport: 'stdio', enabled: false },
    mine: { transport: 'stdio' },
  } }
  assert.equal(classifyMcpServerProvenance(base, value, 'mine'), 'user-added')
  assert.equal(classifyMcpServerProvenance(base, value, 'inherited'), 'inherited')
  assert.equal(classifyMcpServerProvenance(base, value, 'both'), 'overridden')
  assert.equal(classifyMcpServerProvenance(base, value, 'absent'), undefined)
})

test('an inherited entry materialized into the USER patch by an unrelated Add stays Inherited', () => {
  // REAL official rc.3 behavior: `SettingsForms.write` restates the WHOLE
  // effective `servers` map into the USER patch on any mutate. A `user` key
  // therefore cannot mean Overridden — the decisive comparison is value vs base.
  const base = { servers: { inherited: { transport: 'stdio', command: '/bin/sleep', args: ['3600'], enabled: false } } }
  const userAfterAdd = { servers: {
    inherited: { transport: 'stdio', command: '/bin/sleep', args: ['3600'], enabled: false },
    added: { transport: 'stdio', command: '/bin/true', enabled: false },
  } }
  const value = { servers: {
    inherited: { transport: 'stdio', command: '/bin/sleep', args: ['3600'], enabled: false },
    added: { transport: 'stdio', command: '/bin/true', enabled: false },
  } }
  assert.ok('inherited' in (userAfterAdd.servers as object), 'the USER patch materialized the inherited entry')
  assert.equal(classifyMcpServerProvenance(base, value, 'inherited'), 'inherited')
  assert.equal(classifyMcpServerProvenance(base, value, 'added'), 'user-added')
})

test('value vs base structural equality ignores key order but not array order or absent fields', () => {
  const base = { servers: { s: { transport: 'stdio', command: 'c', args: ['a', 'b'], enabled: true } } }
  const reordered = { servers: { s: { enabled: true, args: ['a', 'b'], command: 'c', transport: 'stdio' } } }
  assert.equal(classifyMcpServerProvenance(base, reordered, 's'), 'inherited')
  const swappedArgs = { servers: { s: { transport: 'stdio', command: 'c', args: ['b', 'a'], enabled: true } } }
  assert.equal(classifyMcpServerProvenance(base, swappedArgs, 's'), 'overridden')
  const removedField = { servers: { s: { transport: 'stdio', command: 'c', args: ['a', 'b'] } } }
  assert.equal(classifyMcpServerProvenance(base, removedField, 's'), 'overridden')
})

test('provenance reads own keys only — a prototype name is never "present"', () => {
  const base = { servers: {} }
  const value = { servers: {} }
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.equal(classifyMcpServerProvenance(base, value, name), undefined, name)
  }
  // A real own key with a hostile name IS a configured entry (the official
  // mutate remains the final validator of its value).
  const valueOwn = JSON.parse('{"servers":{"__proto__":{"transport":"stdio"}}}') as { servers: Record<string, unknown> }
  assert.equal(classifyMcpServerProvenance(base, valueOwn, '__proto__'), 'user-added')
})

test('a malformed layer never classifies anything', () => {
  for (const layer of [undefined, null, [], 'text', { servers: [] }, { servers: null }]) {
    assert.equal(classifyMcpServerProvenance(layer, layer, 'x'), undefined)
  }
})

test('the enable toggle is ONE path set', () => {
  assert.deepEqual(mcpSetEnabledOps('srv', false), [{ op: 'set', path: ['servers', 'srv', 'enabled'], value: false }])
  assert.deepEqual(mcpSetEnabledOps('srv', true), [{ op: 'set', path: ['servers', 'srv', 'enabled'], value: true }])
})

test('projectMcpServerEntry keeps transport facts and drops non-string noise', () => {
  assert.deepEqual(projectMcpServerEntry({ transport: 'stdio', command: 'c', args: ['a'], env: { K: 'v' }, enabled: false }), {
    transport: 'stdio',
    command: 'c',
    args: ['a'],
    cwd: '',
    env: new Map([['K', 'v']]),
    enabled: false,
  })
  assert.deepEqual(projectMcpServerEntry({ transport: 'streamable-http', url: 'u' }), {
    transport: 'streamable-http',
    url: 'u',
    headers: new Map(),
  })
  // An unknown transport or a non-string arg refuses the entry projection.
  assert.equal(projectMcpServerEntry({ transport: 'sse' }), undefined)
  assert.equal(projectMcpServerEntry({ transport: 'stdio', args: ['a', 2] }), undefined)
  assert.equal(projectMcpServerEntry(undefined), undefined)
})

test('a transport switch keeps the NEW transport\'s freshly added dict entries', () => {
  // stdio -> streamable-http with a new Authorization header.
  const effective = { transport: 'stdio' as const, command: '/bin/echo', args: ['a'], env: new Map([['OLD', 'v']]), cwd: '', enabled: true }
  const draft = httpDraft({
    headers: new Map([['Authorization', 'Bearer ${credential:T}']]),
  })
  const ops = mcpEditOps('srv', effective, draft, diffMcpServerDraft(effective, draft))
  const byPath = new Map(ops.map(op => [op.path.join('.'), op]))
  assert.equal(byPath.get('servers.srv.transport')?.value, 'streamable-http')
  assert.equal(byPath.get('servers.srv.url')?.value, 'https://example.test/mcp')
  // The NEW header must reach the mutation — this is the regression: the old
  // code dropped the whole headers patch on a switch.
  assert.deepEqual(
    ops.find(op => op.path.join('.') === 'servers.srv.headers.Authorization'),
    { op: 'set', path: ['servers', 'srv', 'headers', 'Authorization'], value: 'Bearer ${credential:T}' },
  )
  // The abandoned stdio fields are still reset to the schema defaults.
  assert.deepEqual(byPath.get('servers.srv.command'), { op: 'set', path: ['servers', 'srv', 'command'], value: '' })
  assert.deepEqual(byPath.get('servers.srv.env'), { op: 'set', path: ['servers', 'srv', 'env'], value: {} })
  // A switch never emits a per-key unset that could restore an inherited key.
  for (const op of ops) assert.equal(op.op, 'set', 'a switch never unsets a field')

  // streamable-http -> stdio with a new env var (the symmetric path).
  const effectiveHttp = { transport: 'streamable-http' as const, url: 'https://old.test/rpc', headers: new Map([['H', 'v']]), enabled: true }
  const draftStdio = stdioDraft({ env: new Map([['TOKEN', '${credential:T}']]) })
  const opsBack = mcpEditOps('srv', effectiveHttp, draftStdio, diffMcpServerDraft(effectiveHttp, draftStdio))
  assert.deepEqual(
    opsBack.find(op => op.path.join('.') === 'servers.srv.env.TOKEN'),
    { op: 'set', path: ['servers', 'srv', 'env', 'TOKEN'], value: '${credential:T}' },
  )
  assert.deepEqual(
    opsBack.find(op => op.path.join('.') === 'servers.srv.headers'),
    { op: 'set', path: ['servers', 'srv', 'headers'], value: {} },
  )
  for (const op of opsBack) assert.equal(op.op, 'set')
})

test('a NON-switch edit still emits per-key unsets for removed dict entries', () => {
  const effective = { transport: 'stdio' as const, command: '/bin/echo', args: [], env: new Map([['KEEP', 'k'], ['DROP', 'd']]), cwd: '', enabled: true }
  const draft = stdioDraft({ env: new Map([['KEEP', 'k']]) })
  const ops = mcpEditOps('srv', effective, draft, diffMcpServerDraft(effective, draft))
  assert.deepEqual(ops, [{ op: 'unset', path: ['servers', 'srv', 'env', 'DROP'] }])
})
