/**
 * Pure display-projection tests for the Approval argument formatter. The
 * formatter owns no approval/danger/IO semantics: these tests pin the field
 * mapping, the no-loss fallback rules and the raw-bytes boundary only.
 * @module @xmoon76/dsh-pi-tui/approval-arguments.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  approvalArgumentSections,
  type ApprovalArgumentSection,
} from '../src/tui/presentation/approval-arguments.ts'

const sections = (tool: string, args: unknown): readonly ApprovalArgumentSection[] =>
  approvalArgumentSections(tool, JSON.stringify(args))
const headings = (tool: string, args: unknown): string[] => sections(tool, args).map(section => section.heading)
const section = (tool: string, args: unknown, heading: string): ApprovalArgumentSection | undefined =>
  sections(tool, args).find(candidate => candidate.heading === heading)

test('edit maps the known fields in order and keeps unknown fields', () => {
  const args = {
    file_path: 'src/config.ts',
    old_string: 'const timeout = 30',
    new_string: 'const timeout = 60\nconst retries = 3',
    replace_all: false,
    annotation: 'keep me',
  }
  assert.deepEqual(headings('edit', args), ['Action', 'Target', 'Before', 'After', 'Replace all', 'Other arguments'])
  assert.deepEqual(sections('edit', args).map(s => s.text), [
    'Replace text',
    'src/config.ts',
    'const timeout = 30',
    'const timeout = 60\nconst retries = 3',
    'No',
    '{\n  "annotation": "keep me"\n}',
  ])
  assert.equal(section('edit', { ...args, replace_all: true }, 'Replace all')?.text, 'Yes')
})

test('edit schema mismatches fall back to the generic object view', () => {
  for (const args of [
    { file_path: 'a', old_string: 1, new_string: 'b' },
    { file_path: 'a', old_string: 'b' },
    { file_path: 'a', old_string: 'b', new_string: 'c', replace_all: 'yes' },
  ]) {
    assert.deepEqual(headings('edit', args), ['Arguments'])
    assert.ok(section('edit', args, 'Arguments')?.text.includes('file_path'))
  }
})

test('write maps the known fields without claiming a new file', () => {
  const args = { file_path: 'src/a.ts', content: 'export const a = 1', mode: 0 }
  assert.deepEqual(headings('write', args), ['Action', 'Target', 'New content', 'Other arguments'])
  assert.equal(section('write', args, 'Action')?.text, 'Write file')
  assert.equal(section('write', args, 'Target')?.text, 'src/a.ts')
  assert.equal(section('write', args, 'New content')?.text, 'export const a = 1')
  assert.equal(section('write', args, 'Other arguments')?.text, '{\n  "mode": 0\n}')
})

test('str_replace_editor maps all four official commands', () => {
  assert.deepEqual(headings('str_replace_editor', { command: 'view', path: '/x', view_range: [1, 3] }),
    ['Action', 'Target', 'Other arguments'])
  assert.equal(section('str_replace_editor', { command: 'view', path: '/x' }, 'Action')?.text, 'View file')

  assert.deepEqual(headings('str_replace_editor', { command: 'create', path: '/x', file_text: 'a\nb' }),
    ['Action', 'Target', 'New content'])
  assert.equal(section('str_replace_editor', { command: 'create', path: '/x', file_text: 'a\nb' }, 'New content')?.text, 'a\nb')

  assert.deepEqual(headings('str_replace_editor', { command: 'str_replace', path: '/x', old_str: 'a', new_str: 'b' }),
    ['Action', 'Target', 'Before', 'After'])
  assert.equal(section('str_replace_editor', { command: 'str_replace', path: '/x', old_str: 'a' }, 'After')?.text, '')

  assert.deepEqual(headings('str_replace_editor', { command: 'insert', path: '/x', insert_line: 4, new_str: 'z', old_str: 'q' }),
    ['Action', 'Target', 'Inserted text', 'Other arguments'])
  assert.equal(section('str_replace_editor', { command: 'insert', path: '/x', insert_line: 4, new_str: 'z' }, 'Action')?.text,
    'Insert after line 4')
})

test('str_replace_editor schema mismatches never guess a mutation', () => {
  for (const args of [
    { command: 'nope', path: '/x' },
    { command: 'view', path: 1 },
    { command: 'create', path: '/x' },
    { command: 'str_replace', path: '/x', old_str: '' },
    { command: 'str_replace', path: '/x', old_str: 'a', new_str: null },
    { command: 'insert', path: '/x', insert_line: 1.5, new_str: 'z' },
    { command: 'insert', path: '/x', insert_line: 1 },
  ]) {
    assert.deepEqual(headings('str_replace_editor', args), ['Arguments'], JSON.stringify(args))
  }
})

test('bash and pwsh keep the full multiline command and put options in Other arguments', () => {
  const command = 'echo one\necho two'
  assert.deepEqual(headings('bash', { command, timeout: 0, env: { A: null } }),
    ['Action', 'Command', 'Other arguments'])
  assert.equal(section('bash', { command }, 'Command')?.text, command)
  assert.equal(section('bash', { command, timeout: 0 }, 'Other arguments')?.text, '{\n  "timeout": 0\n}')
  assert.deepEqual(headings('pwsh', { command: 'Get-Item .' }), ['Action', 'Command'])
  assert.deepEqual(headings('bash', { command: 42 }), ['Arguments'])
})

test('a generic JSON object keeps every value type, nested structure and order', () => {
  const args = {
    empty: '',
    zero: 0,
    no: false,
    nil: null,
    nested: { a: [1, {}] },
    'key\u001b[31m': 'value',
  }
  assert.deepEqual(headings('unknown', args), ['Arguments'])
  const text = section('unknown', args, 'Arguments')!.text
  for (const expected of ['empty: ""', 'zero: 0', 'no: false', 'nil: null',
    'nested: {', '"a": [', 'key\\u001b[31m: "value"']) {
    assert.ok(text.includes(expected), `${JSON.stringify(expected)} missing from:\n${text}`)
  }
  assert.deepEqual(headings('unknown', {}), ['Arguments'])
  assert.equal(section('unknown', {}, 'Arguments')?.text, '(empty object)')
})

test('generic strings keep their type and cannot forge a field row', () => {
  const raw = JSON.stringify({
    enabled: false,
    disabled: 'false',
    tries: 0,
    triesString: '0',
    payload: 'ok\nadmin: true',
    admin: false,
    'payload\nadmin': 'nested-key',
  })
  const text = approvalArgumentSections('unknown', raw)[0]!.text
  assert.ok(text.includes('enabled: false'), text)
  assert.ok(text.includes('disabled: "false"'), text)
  assert.ok(text.includes('tries: 0'), text)
  assert.ok(text.includes('triesString: "0"'), text)
  assert.ok(text.includes('payload: "ok\\nadmin: true"'), text)
  assert.ok(text.includes('payload\\u000aadmin: "nested-key"'), text)
  assert.equal(text.split('\n').filter(line => line.startsWith('admin:')).length, 1,
    `the embedded newline never creates a second admin row:\n${text}`)
  assert.ok(text.split('\n').includes('admin: false'), text)
})

test('control-bearing generic keys cannot swallow later approval fields', () => {
  const raw = JSON.stringify({
    '\u001b]0;unfinished': 'benign',
    '\u009d0;c1-unfinished': 'benign-c1',
    'tab\tkey': 'tab-value',
    command: 'rm -rf /srv/data',
    mode: 'force',
  })
  const text = approvalArgumentSections('unknown', raw)[0]!.text
  assert.ok(text.includes('command: "rm -rf /srv/data"'), text)
  assert.ok(text.includes('mode: "force"'), text)
  assert.ok(text.includes('\\u001b]0;unfinished: "benign"'), text)
  assert.ok(text.includes('\\u009d0;c1-unfinished: "benign-c1"'), text)
  assert.ok(text.includes('tab\\u0009key: "tab-value"'), text)
  assert.equal(text.includes('\u001b'), false, 'no raw ESC survives the key encoding')
  assert.equal(text.includes('\u009d'), false, 'no raw C1 OSC survives the key encoding')
  assert.equal(text.includes('\t'), false, 'no raw TAB survives the key encoding')
})

test('deep or wide valid arguments fall back to the exact raw projection', () => {
  const depth = 2000
  const nested = '{"a":'.repeat(depth) + '1' + '}'.repeat(depth)
  assert.deepEqual(approvalArgumentSections('unknown', nested),
    [{ heading: 'Arguments', text: nested }])
  const known = `{"command":"ls","deep":${nested}}`
  assert.deepEqual(approvalArgumentSections('bash', known),
    [{ heading: 'Arguments', text: known }])
  // 100k keys is deliberately far beyond the node ceiling: the guard must
  // reject from the lazy frontier without materializing all children.
  const wide = `{${Array.from({ length: 100_000 }, (_, index) => `"k${index}":${index}`).join(',')}}`
  assert.deepEqual(approvalArgumentSections('unknown', wide),
    [{ heading: 'Arguments', text: wide }])
})

test('a consumed field never repeats under Other arguments, including __proto__', () => {
  const raw = '{"command":"ls","__proto__":{"polluted":true},"keep":1}'
  const result = approvalArgumentSections('bash', raw)
  assert.deepEqual(result.map(s => s.heading), ['Action', 'Command', 'Other arguments'])
  const other = result[2]!.text
  assert.ok(other.includes('__proto__'), other)
  assert.ok(other.includes('keep'), other)
  assert.ok(!other.includes('"command"'), 'the consumed command is never duplicated in Other')
  assert.equal(({} as { polluted?: boolean }).polluted, undefined)
})

test('non-object or malformed input falls back to the exact raw text', () => {
  for (const raw of ['[1,2]', '"scalar"', '42', 'null', 'not json\nsecond line', '']) {
    const result = approvalArgumentSections('bash', raw)
    assert.deepEqual(result, [{ heading: 'Arguments', text: raw }])
  }
  assert.deepEqual(approvalArgumentSections('bash', '{"command":'), [{ heading: 'Arguments', text: '{"command":' }])
})

test('tool-name lookalikes never take a specialized branch', () => {
  for (const tool of ['str_replace_editor_extra', 'edit_extra', 'Write', 'BASH']) {
    assert.deepEqual(headings(tool, { command: 'view', path: '/x' }), ['Arguments'], tool)
  }
})

test('the projection never invents an applied diff, danger decision or file IO fact', () => {
  const raw = JSON.stringify({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' })
  const before = raw
  const result = approvalArgumentSections('edit', raw)
  assert.equal(raw, before, 'the received bytes are never mutated')
  for (const entry of result) {
    assert.equal(/applied|written|dangerous|permission/iu.test(entry.heading), false, entry.heading)
    assert.equal(/applied|written|dangerous/iu.test(entry.text), false, entry.text)
  }
  assert.deepEqual(result.map(s => s.heading), ['Action', 'Target', 'Before', 'After'])
})

test('numeric-like top-level keys keep their source order and every value', () => {
  const generic = approvalArgumentSections('unknown', '{"10":"ten","2":"two"}')
  assert.deepEqual(generic.map(section => section.heading), ['Arguments'])
  assert.equal(generic[0]!.text, '10: "ten"\n2: "two"')
  const other = approvalArgumentSections('bash', '{"command":"ls","10":"ten","2":"two"}')
  assert.equal(other.find(section => section.heading === 'Other arguments')?.text,
    '{\n  "10": "ten",\n  "2": "two"\n}')
})

test('the source-order scan survives escaped keys and nested containers', () => {
  const result = approvalArgumentSections('unknown', '{"a\\"b":1,"nested":{"x":[1,{"y":"}"}]},"z":2}')
  const text = result[0]!.text
  assert.ok(text.startsWith('a"b: 1\nnested: {'), text)
  assert.ok(text.endsWith('z: 2'), text)
})

test('the display budget rejects a wide frontier without materializing its children', () => {
  const wide = `{${Array.from({ length: 100_000 }, (_, index) => `"k${index}":${index}`).join(',')}}`
  const originalValues = Object.values
  let valuesCalls = 0
  Object.values = ((value: Record<string, unknown> | ArrayLike<unknown>) => {
    valuesCalls += 1
    return originalValues(value)
  }) as typeof Object.values
  let result: ReturnType<typeof approvalArgumentSections>
  try {
    result = approvalArgumentSections('unknown', wide)
  } finally {
    Object.values = originalValues
  }
  assert.deepEqual(result!, [{ heading: 'Arguments', text: wide }])
  assert.equal(valuesCalls, 0,
    'the budget must enumerate the wide frontier lazily, never via a full Object.values list')
})
