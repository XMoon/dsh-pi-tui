/**
 * Supporting presenter-unit tests (no L1–L6 level) for the Client-derived tool
 * presenter (M3-4 PR4 §5):
 * diff cards from raw edit/write args, terminal cards from bash/pwsh args,
 * bounded patch cards, the undefined-for-everything-else contract (the
 * existing Client generic/read-envelope fallbacks stay authoritative), and
 * the negative lock — the module never touches a Host tool registry or a
 * presenter callback.
 * @module @xmoon76/dsh-pi-tui/tool-presentation-client.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createClientToolPresenter } from '../../src/tui/transcript/client-tool-presenter.ts'

const presenter = createClientToolPresenter()

/** One read envelope, in the shape the fs read tool writes into its result. */
const READ_ENVELOPE = '<path>src/a.ts</path>\n<type>file</type>\n<content>\n1: a\n</content>'

test('edit: a diff card derived from the call arguments (old/new strings)', () => {
  const view = presenter.call('edit', JSON.stringify({ path: 'src/a.ts', old_string: 'before', new_string: 'after' }))
  assert.deepEqual(view, {
    card: 'diff',
    title: 'Edit src/a.ts',
    diffs: [{ path: 'src/a.ts', oldText: 'before', newText: 'after' }],
    locations: [{ path: 'src/a.ts' }],
  })
})

test('write: a create/overwrite diff has oldText null (the Host contract distinction)', () => {
  const view = presenter.call('write', JSON.stringify({ path: 'new.txt', content: 'body' }))
  assert.ok(view !== undefined && view.card === 'diff')
  assert.equal(view.diffs[0]!.oldText, null)
  assert.equal(view.diffs[0]!.newText, 'body')
})

test('bash: a terminal card from the command arguments', () => {
  const view = presenter.call('bash', JSON.stringify({ command: 'pnpm test', description: 'run the suite', cwd: '/repo' }))
  assert.deepEqual(view, {
    card: 'terminal',
    title: 'pnpm test',
    description: 'run the suite',
    cwd: '/repo',
  })
})

test('pwsh: a terminal card without optional members when absent', () => {
  const view = presenter.call('pwsh', JSON.stringify({ command: 'Get-ChildItem' }))
  assert.deepEqual(view, { card: 'terminal', title: 'Get-ChildItem' })
})

test('apply_patch: a bounded multi-file diff card from the patch headers', () => {
  const patch = '--- a/src/one.ts\n+++ b/src/one.ts\n@@\n-x\n+y\n--- a/src/two.ts\n+++ b/src/two.ts\n'
  const view = presenter.call('apply_patch', JSON.stringify({ patch }))
  assert.ok(view !== undefined && view.card === 'diff')
  assert.equal(view.diffs.length, 2)
  assert.deepEqual(view.diffs.map(diff => diff.path), ['src/one.ts', 'src/two.ts'])
})

test('unknown/other tools: undefined (the existing Client fallbacks stay authoritative)', () => {
  assert.equal(presenter.call('read', JSON.stringify({ path: 'a.ts' })), undefined)
  assert.equal(presenter.call('web_search', JSON.stringify({ query: 'x' })), undefined)
  assert.equal(presenter.call('totally_custom', '{}'), undefined)
  assert.equal(presenter.call('bash', 'not-json'), undefined)
})

test('result: a settled view comes only from the TOOL-AUTHORED result metadata', () => {
  // No metadata: the existing Client derivations stay authoritative.
  assert.equal(presenter.result('edit', '{}', { content: [], isError: false }), undefined)
  assert.equal(presenter.result('bash', '{}', { content: [], isError: true }), undefined)
  // A foreign or malformed metadata payload: no view, no guess.
  assert.equal(presenter.result('read', '{}', { content: [], isError: false, meta: { unrelated: 1 } }), undefined)
  assert.equal(presenter.result('read', '{}', { content: [], isError: false, meta: 'nope' }), undefined)
  // A payload that names a path but carries NO window is not the read shape.
  assert.equal(presenter.result('read', '{}', { content: [], isError: false, meta: { path: 'src/a.ts' } }), undefined)
  // An EMPTY path proves no file. On the DIFF shape the path guard is what
  // refuses it (the envelope guard only applies to the read shape).
  assert.equal(presenter.result('write', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: 'written' }],
    isError: false,
    meta: { path: '', diffs: [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }] },
  }), undefined)
  assert.equal(presenter.result('read', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: READ_ENVELOPE }],
    isError: false,
    meta: { path: '', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 },
  }), undefined)
  // A MALFORMED diff list proves no file: a foreign entry is refused like the
  // tool's own `diffsFromMeta` refuses it, and an empty list with no write
  // marker declines. (The empty list WITH the write marker legitimately
  // rebuilds a create diff; that case is covered on its own below.)
  assert.equal(presenter.result('write', '{}', { content: [], isError: false, meta: { path: 'src/a.ts', diffs: [{ foo: 1 }] } }), undefined)
  // The tool's OWN metadata: the read view the tool declared.
  const read = presenter.result('read', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: READ_ENVELOPE }],
    isError: false,
    meta: { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1, lang: 'ts' },
  })
  assert.ok(read !== undefined && read.card === 'read')
  assert.equal(read.path, 'src/a.ts')
  assert.equal(read.lang, 'ts')
})

test('result: a row whose args are not a JSON object yields no view', () => {
  // The Direct bridge parses the args JSON BEFORE consulting the tool, so a
  // row whose args are not a JSON object never reaches a Host `presentResult`
  // at all. A MERGED read group is exactly that row: its args are the literal
  // `'2 files'` and it INHERITS the first read's metadata and result blocks.
  // If the Client derivation ignored this gate, the merged group would render
  // as ONE file instead of the two-file tree the card actually shows.
  assert.equal(presenter.result('read', '2 files', {
    content: [{ type: 'text', text: READ_ENVELOPE }],
    isError: false,
    meta: { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 },
  }), undefined)
})

test('result: a failed call yields no view', () => {
  // The tool's own Host `presentResult` returns nothing for a failed call; the
  // Client derivation must agree, or the two branches render a failure
  // differently.
  assert.equal(presenter.result('read', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: READ_ENVELOPE }],
    isError: true,
    meta: { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 },
  }), undefined)
})

test('result: the result content must be the ONE file envelope the read tool writes', () => {
  const meta = { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 }
  const read = (text: string): ReturnType<typeof presenter.result> => presenter.result('read', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text }], isError: false, meta,
  })
  // A content that is not a text block describes nothing.
  assert.equal(presenter.result('read', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'image' } as never], isError: false, meta,
  }), undefined)
  // A content that is not an envelope at all describes nothing.
  assert.equal(read('ok'), undefined)
  // The tool's own presenter requires the literal `<type>file</type>`; any
  // other type is a different card, not a read.
  assert.equal(read('<path>src/a.ts</path>\n<type>directory</type>\n<content>\n1: a\n</content>'), undefined)
  // The envelope body comes back as `content`, the degradation path the SDK
  // documents for a UI without a rich read card.
  const view = read(READ_ENVELOPE)
  assert.equal(view?.card, 'read')
  assert.deepEqual(view?.card === 'read' ? view.content : undefined, [{ type: 'text', text: '1: a' }])
})

test('result: the read metadata must survive the same window validation the tool applies', () => {
  // The meta is deliberately malformed here, so it crosses the JSON boundary
  // as `never`: feeding the bad shapes is exactly what this case proves.
  const read = (meta: Record<string, unknown>): ReturnType<typeof presenter.result> => presenter.result('read', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: READ_ENVELOPE }], isError: false, meta: meta as never,
  })
  const base = { path: 'src/a.ts', offset: 1, totalLines: 1, lines: [{ number: 1, text: 'a' }] }
  assert.ok(read(base) !== undefined, 'the well-formed window is accepted')
  // Every shape the tool's own `readMetaFromMeta` rejects must be rejected
  // here too: a fractional window, a zero or out-of-range line, out-of-order
  // lines, a fractional offset, a negative total and a non-string language.
  assert.equal(read({ ...base, lines: [{ number: 1.5, text: 'a' }] }), undefined, 'fractional line number')
  assert.equal(read({ ...base, lines: [{ number: 0, text: 'a' }] }), undefined, 'line number 0')
  assert.equal(read({ ...base, lines: [{ number: 2, text: 'a' }] }), undefined, 'line beyond totalLines')
  assert.equal(read({ ...base, offset: 1, totalLines: 3, lines: [{ number: 2, text: 'a' }, { number: 1, text: 'b' }] }), undefined, 'lines out of order')
  assert.equal(read({ ...base, offset: 0 }), undefined, 'offset 0')
  assert.equal(read({ ...base, offset: 1.5 }), undefined, 'fractional offset')
  assert.equal(read({ ...base, totalLines: -1 }), undefined, 'negative totalLines')
  assert.equal(read({ ...base, lang: 7 }), undefined, 'non-string lang')
})

test('result: a write that CREATED the file rebuilds its diff, and nothing else does', () => {
  // `dsh-tool-fs` records `diffs: []` when a write creates a file (there is no
  // before-image), and its own write presenter then rebuilds the diff from the
  // call arguments. This branch FABRICATES data, so it demands the tool's own
  // write contract — the projected `operation` value, the empty list that
  // create emits, and a string `content` argument — never a name.
  const args = JSON.stringify({ file_path: 'src/new.ts', content: 'fresh\n' })
  const created = presenter.result('write', args, {
    content: [{ type: 'text', text: 'written' }],
    isError: false,
    meta: { operation: 'create', path: 'src/new.ts', diffs: [] },
  })
  assert.ok(created !== undefined && created.card === 'diff')
  assert.deepEqual(created.diffs, [{ path: 'src/new.ts', oldText: null, newText: 'fresh\n' }])

  const read = (meta: Record<string, unknown>, callArgs = args): unknown => presenter.result('write', callArgs, {
    content: [{ type: 'text', text: 'written' }], isError: false, meta: meta as never,
  })
  // A third-party tool that happens to send `operation` + `path` + `content`
  // must not be read as a create: the operation value is not one the write
  // contract defines.
  assert.equal(read({ operation: 'delete', path: 'src/a.ts', diffs: [] }), undefined, 'unknown operation value')
  // `[]` is the create signature; an absent list is not this shape.
  assert.equal(read({ operation: 'create', path: 'src/a.ts' }), undefined, 'no diffs field')
  // `[]` contradicts `update`, which would have carried hunks.
  assert.equal(read({ operation: 'update', path: 'src/a.ts', diffs: [] }), undefined, 'update with an empty list')
  // The diff is built from the argument, so the argument must be there.
  assert.equal(read({ operation: 'create', path: 'src/a.ts', diffs: [] }, JSON.stringify({ file_path: 'src/a.ts' })), undefined, 'no content argument')
  // An edit with an empty list declines, exactly like the Host edit presenter.
  assert.equal(presenter.result('edit', JSON.stringify({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), {
    content: [{ type: 'text', text: 'edited' }],
    isError: false,
    meta: { operation: 'create', path: 'src/a.ts', diffs: [] },
  }), undefined)
})

test('result: a malformed diff entry is refused instead of reaching the diff renderer', () => {
  // The renderer reads `hunk.newText` as a string; an entry that lacks it
  // would throw. The tool's own `diffsFromMeta` validates every entry, and
  // the Client derivation must validate the same way.
  const malformed = presenter.result('write', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: 'written' }],
    isError: false,
    meta: { path: 'src/a.ts', diffs: [{ path: 'src/a.ts' }] },
  })
  assert.equal(malformed, undefined)
  // An entry whose `newText` is not a string is refused even when every
  // other field is well-formed.
  const noNewText = presenter.result('write', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: 'written' }],
    isError: false,
    meta: { path: 'src/a.ts', diffs: [{ path: 'src/a.ts', oldText: null }] },
  })
  assert.equal(noNewText, undefined)
  // An entry whose `oldText` is neither a string nor null is refused.
  const badOldText = presenter.result('write', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: 'written' }],
    isError: false,
    meta: { path: 'src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 7, newText: 'b' }] },
  })
  assert.equal(badOldText, undefined)
  // A well-formed entry still yields the diff view the tool declared.
  const wellFormed = presenter.result('write', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: 'written' }],
    isError: false,
    meta: { path: 'src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }] },
  })
  assert.ok(wellFormed !== undefined && wellFormed.card === 'diff')
  assert.deepEqual(wellFormed.diffs, [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }])
})

test('negative lock: no Host tool registry, no presenter callbacks, no wire surface', () => {
  const source = readFileSync(new URL('../../src/tui/transcript/client-tool-presenter.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal(code.includes('ctx.tools'), false)
  assert.equal(code.includes('ctx.get'), false)
  assert.equal(code.includes('presentCall'), false)
  assert.equal(code.includes('presentResult'), false)
  assert.equal(code.includes('toolPresenterFrom'), false,
    'the client presenter never wraps a Host registry lookup')
})
