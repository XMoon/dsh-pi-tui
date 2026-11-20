/**
 * Supporting presenter-unit tests (no L1–L6 level) for the Client-derived tool
 * presenter (M3-4 PR4 §5):
 * diff cards from raw edit/write args, terminal cards from bash/pwsh args,
 * bounded patch cards, the undefined-for-everything-else contract (the
 * existing Client generic/read-envelope fallbacks stay authoritative), the
 * name-scoped dsh-web-aligned result-card recognition (read/write/generic
 * applied diff), and the negative lock — the module never touches a Host tool
 * registry or a presenter callback.
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

test('exit_plan_mode: the full plan body rides the generic card content (Host presentCall parity)', () => {
  const plan = '# Upgrade 0.5.7\n## Scope\n- goal dock\n- plan review\n## Execution\nship it'
  const view = presenter.call('exit_plan_mode', JSON.stringify({ plan }))
  assert.deepEqual(view, {
    card: 'generic',
    title: 'Upgrade 0.5.7',
    kind: 'other',
    content: [{ type: 'text', text: plan }],
  })
})

test('exit_plan_mode: an invalid plan shape keeps the generic tool card (never a guessed body)', () => {
  // No heading start.
  assert.equal(presenter.call('exit_plan_mode', JSON.stringify({ plan: 'just text' })), undefined)
  // Empty plan.
  assert.equal(presenter.call('exit_plan_mode', JSON.stringify({ plan: '' })), undefined)
  // Missing plan field.
  assert.equal(presenter.call('exit_plan_mode', JSON.stringify({ other: 1 })), undefined)
  // Malformed args JSON.
  assert.equal(presenter.call('exit_plan_mode', 'not json'), undefined)
})

test('unknown/other tools: undefined (the existing Client fallbacks stay authoritative)', () => {
  assert.equal(presenter.call('read', JSON.stringify({ path: 'a.ts' })), undefined)
  assert.equal(presenter.call('web_search', JSON.stringify({ query: 'x' })), undefined)
  assert.equal(presenter.call('totally_custom', '{}'), undefined)
  assert.equal(presenter.call('bash', 'not-json'), undefined)
})

test('the client presenter never invents a Schedule Host presentation', () => {
  // A Remote Client has no Host tool registry: the rc1 Schedule tools declare
  // only a tool-authored `presentCall`/canonical JSON result, no durable
  // presentation metadata. The shared `toolCardHeader` fallback owns the card
  // identity; the Client presenter must not fabricate a Schedule view (nor turn
  // a matching-looking durable `meta` into one).
  for (const name of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit', 'schedule_update', 'schedule_delete']) {
    assert.equal(presenter.call(name, JSON.stringify({ id: 's1', title: 'Morning report', action: 'delete' })), undefined, `${name} call`)
    assert.equal(
      presenter.result(name, JSON.stringify({ id: 's1' }), {
        content: [{ type: 'text', text: '{"id":"s1","kind":"rrule","status":"active"}' }],
        isError: false,
        // A legacy/foreign metadata payload shaped like a Schedule task is
        // still not a Host-authored presentation contract.
        meta: { id: 's1', kind: 'rrule', status: 'active', code: 'schedule_conflict' },
      }),
      undefined,
      `${name} result`,
    )
  }
})

// ---------------------------------------------------------------------------
// Result view: name-scoped dsh-web-aligned card recognition.
//
// dsh-web selects a Client result card by the wire name PLUS a per-card
// minimum contract, so a NON-read tool returning read-shaped metadata (or a
// NON-write tool returning empty diffs) must NOT gain that card. The
// recognized shapes are: a generic applied diff (any name, non-empty valid
// `meta.diffs`), a write fallback diff (`write` only, from the call args), and
// a read card (`read` only, with a valid read call + window + file envelope).
// ---------------------------------------------------------------------------

test('result: a foreign tool with read-shaped metadata does not get a read card', () => {
  // A NON-read tool that returns valid read window metadata and a file
  // envelope must NOT be decoded as a read card (Web `validReadCall` names the
  // tool). The presenter returns undefined so the raw result stays with the
  // generic renderer — the SAME result a no-presenter sink shows.
  const readMeta = { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 }
  for (const name of ['third_party_probe', 'web_search', 'totally_custom']) {
    assert.equal(presenter.result(name, JSON.stringify({ file_path: 'src/a.ts' }), {
      content: [{ type: 'text', text: READ_ENVELOPE }],
      isError: false,
      meta: readMeta,
    }), undefined, `${name} must not gain a read card`)
  }
})

test('result: a read call must carry a valid file path and window to get a read card', () => {
  // dsh-web `validReadCall` gates the read card on the CALL too: a non-empty
  // `file_path` and optional `offset`/`limit` as positive integers. A read row
  // with a missing/blank path or a bad window ARG is refused even when its
  // metadata and envelope are well-formed.
  const meta = { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 }
  const readWith = (args: Record<string, unknown>): ReturnType<typeof presenter.result> => presenter.result('read', JSON.stringify(args), {
    content: [{ type: 'text', text: READ_ENVELOPE }], isError: false, meta: meta as never,
  })
  assert.equal(readWith({}), undefined, 'missing file_path')
  assert.equal(readWith({ file_path: '' }), undefined, 'empty file_path')
  assert.equal(readWith({ file_path: '   ' }), undefined, 'blank file_path')
  assert.equal(readWith({ file_path: 'src/a.ts', offset: 0 }), undefined, 'offset 0')
  assert.equal(readWith({ file_path: 'src/a.ts', offset: 1.5 }), undefined, 'fractional offset')
  assert.equal(readWith({ file_path: 'src/a.ts', limit: -2 }), undefined, 'negative limit')
  assert.equal(readWith({ file_path: 'src/a.ts', offset: 1, limit: 10 })?.card, 'read', 'a valid read call is accepted')
})

test('result: a real read result renders the read card from its metadata and envelope', () => {
  // The tool's OWN metadata + envelope: the read view the tool declared (the
  // first-party positive). Like the tool's own `readMetaFromMeta`, an EMPTY
  // metadata path is still accepted (it can never claim the `path` target kind
  // afterwards), a language hint rides along, and the envelope body becomes
  // `content` (the documented degradation path).
  const read = (meta: Record<string, unknown>): ReturnType<typeof presenter.result> => presenter.result('read', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: READ_ENVELOPE }], isError: false, meta: meta as never,
  })
  const view = read({ path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1, lang: 'ts' })
  assert.ok(view !== undefined && view.card === 'read')
  assert.equal(view.path, 'src/a.ts')
  assert.equal(view.offset, 1)
  assert.equal(view.totalLines, 1)
  assert.equal(view.lang, 'ts')
  assert.deepEqual(view.content, [{ type: 'text', text: '1: a' }])
  // An empty metadata path is accepted exactly like the Host read tool.
  const emptyPath = read({ path: '', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 })
  assert.equal(emptyPath?.card, 'read')
})

test('result: a foreign tool cannot fabricate a write diff from empty diffs', () => {
  // dsh-web's write fallback is keyed on the `write` NAME, not on a metadata
  // `operation`/`diffs` marker a foreign tool could emit. A NON-write tool that
  // returns `operation:create` + `diffs:[]` + a `content` argument must NOT
  // get a synthesized write diff.
  for (const name of ['third_party_probe', 'edit', 'apply_patch']) {
    assert.equal(presenter.result(name, JSON.stringify({ file_path: 'src/new.ts', content: 'fresh\n' }), {
      content: [{ type: 'text', text: 'written' }],
      isError: false,
      meta: { operation: 'create', path: 'src/new.ts', diffs: [], content: 'fresh\n' },
    }), undefined, `${name} must not fabricate a write diff`)
  }
})

test('result: a write diff reaches the result view only with a result path', () => {
  // dsh-web shows a write's args diff, but PiTui's `targetKind:path` needs a
  // TOOL-AUTHORED result path (owner correction: display capability is not
  // source proof). So `presenter.result` returns a write diff ONLY when the
  // RESULT declares a non-empty `meta.path` (branch B — the diff path comes
  // from the result metadata). A write with NO result path yields `undefined`
  // from `result()`; its args-derived diff rides the `call()`/renderToolBody
  // fallback, never a synthetic `args.file_path` result path.
  const writeResult = (args: Record<string, unknown>, meta: unknown): ReturnType<typeof presenter.result> =>
    presenter.result('write', JSON.stringify(args), { content: [{ type: 'text', text: 'written' }], isError: false, meta: meta as never })
  const writeArgs = { file_path: 'src/new.ts', content: 'fresh\n' }

  // W05-A: no result metadata -> no Result View; the CALL view carries the diff.
  assert.equal(writeResult(writeArgs, undefined), undefined, 'W05-A: meta absent, no synthetic result path')
  const callDiff = presenter.call('write', JSON.stringify(writeArgs))
  assert.ok(callDiff !== undefined && callDiff.card === 'diff', 'W05-A: the args diff rides the call view')
  assert.deepEqual(callDiff.diffs, [{ path: 'src/new.ts', oldText: null, newText: 'fresh\n' }])

  // W05-B/W05-C: empty or malformed diffs with NO result path -> no Result View.
  assert.equal(writeResult(writeArgs, { diffs: [] }), undefined, 'W05-B: empty diffs, no result path')
  assert.equal(writeResult(writeArgs, { diffs: [{ foo: 1 }] }), undefined, 'W05-C: malformed diffs, no result path')
  assert.equal(writeResult(writeArgs, { operation: 'delete', diffs: [] }), undefined, 'a stray operation marker, no result path')

  // W05-D: a RESULT-declared path rebuilds the diff from the args content.
  const withPath = writeResult({ file_path: 'src/new.ts', content: 'fresh\n' }, { path: 'src/new.ts', diffs: [] })
  assert.equal(withPath?.card, 'diff', 'W05-D: a result path backs the diff')
  assert.deepEqual(withPath?.card === 'diff' ? withPath.diffs : undefined, [{ path: 'src/new.ts', oldText: null, newText: 'fresh\n' }])

  // W05-E: the RESULT path wins over a different `args.file_path` (pathFromMeta).
  const canonical = writeResult({ file_path: 'src/b.ts', content: 'x' }, { path: '/repo/canonical.ts', diffs: [] })
  assert.deepEqual(canonical?.card === 'diff' ? canonical.diffs : undefined, [{ path: '/repo/canonical.ts', oldText: null, newText: 'x' }], 'W05-E: the result path wins')

  // The write diff is built from the args content, so both `file_path` and
  // `content` must be present (the call view and branch B both need them).
  assert.equal(presenter.call('write', JSON.stringify({ file_path: 'src/a.ts' })), undefined, 'no content argument (call)')
  assert.equal(writeResult({ file_path: 'src/a.ts' }, { path: 'src/a.ts', diffs: [] }), undefined, 'no content argument (branch B)')
  assert.equal(writeResult({ content: 'x' }, { path: 'src/a.ts', diffs: [] }), undefined, 'no file_path argument (branch B)')
})

test('call: a write of empty content or a delete edit still forms its diff', () => {
  // A legal EMPTY new text is a real value, not an absent one: an empty-file
  // write (`content: ''`) and a delete edit (`new_string: ''`) must keep their
  // args diff (owner W05-F/W05-G). The diff is display-only (the call view is
  // never a `targetKind:path` proof).
  const emptyWrite = presenter.call('write', JSON.stringify({ file_path: 'src/empty.ts', content: '' }))
  assert.ok(emptyWrite !== undefined && emptyWrite.card === 'diff', 'W05-F: an empty write still forms its call diff')
  assert.deepEqual(emptyWrite.diffs, [{ path: 'src/empty.ts', oldText: null, newText: '' }])
  const deleteEdit = presenter.call('edit', JSON.stringify({ file_path: 'src/a.ts', old_string: 'a', new_string: '' }))
  assert.ok(deleteEdit !== undefined && deleteEdit.card === 'diff', 'W05-G: a delete edit keeps its call diff')
  assert.deepEqual(deleteEdit.diffs, [{ path: 'src/a.ts', oldText: 'a', newText: '' }])
})

test('result: an edit result never fabricates a before-image from empty diffs', () => {
  // `edit` gets no write-style fallback: an empty/missing/bad diff list stays
  // `undefined` (the Host edit presenter declines too). A valid NON-EMPTY
  // `diffs` list still renders those hunks (the generic applied diff below).
  const edit = (meta: unknown): ReturnType<typeof presenter.result> => presenter.result('edit', JSON.stringify({ file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }), {
    content: [{ type: 'text', text: 'edited' }], isError: false, meta: meta as never,
  })
  assert.equal(edit({ operation: 'create', path: 'src/a.ts', diffs: [] }), undefined, 'empty diffs')
  assert.equal(edit({ path: 'src/a.ts' }), undefined, 'no diffs field')
  assert.equal(edit({ path: 'src/a.ts', diffs: [{ foo: 1 }] }), undefined, 'malformed diffs')
  assert.equal(edit(undefined), undefined, 'no metadata')
  const applied = edit({ path: 'src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }] })
  assert.equal(applied?.card, 'diff', 'a valid applied diff still renders')
})

test('result: a generic applied diff survives empty or non-text result content', () => {
  // dsh-web's `GenericToolCard` calls `diffCardModel` for ANY tool name: a
  // valid NON-EMPTY `meta.diffs` renders those recorded hunks regardless of the
  // result content (empty or non-text). Tightening the read/write recognition
  // must NOT disable this generic applied-diff compatibility. The paths come
  // from the diffs themselves (an empty top-level `path` does not decide it).
  const diffs = [{ path: 'src/a.ts', oldText: 'a', newText: 'b' }]
  for (const content of [[], [{ type: 'image' } as never], [{ type: 'text', text: '' }], [{ type: 'text', text: 'ok' }]]) {
    const view = presenter.result('third_party_probe', JSON.stringify({}), { content: content as never, isError: false, meta: { path: '', diffs } })
    assert.equal(view?.card, 'diff', `content ${JSON.stringify(content)}: applied diff still renders`)
    assert.deepEqual(view?.card === 'diff' ? view.diffs : undefined, diffs)
  }
  // isError refuses the view even with valid diffs (never a fake success).
  assert.equal(presenter.result('third_party_probe', JSON.stringify({}), {
    content: [{ type: 'text', text: 'ok' }], isError: true, meta: { diffs },
  }), undefined, 'a failed call yields no view')
})

test('result: malformed metadata degrades without a view and keeps the raw result', () => {
  // Bad shapes are refused like the tool's own `diffsFromMeta`/`readMetaFromMeta`
  // refuse them — never a throw, never a fabricated view. The raw result/error
  // is preserved by the generic renderer the undefined return hands back to.
  const result = (name: string, args: string, meta: unknown, content: readonly unknown[] = [{ type: 'text', text: 'raw' }]): ReturnType<typeof presenter.result> =>
    presenter.result(name, args, { content: content as never, isError: false, meta: meta as never })
  // A malformed diff entry is refused (missing newText / bad oldText / not an object).
  assert.equal(result('third_party_probe', '{}', { path: 'a', diffs: [{ path: 'a' }] }), undefined, 'diff entry without newText')
  assert.equal(result('third_party_probe', '{}', { path: 'a', diffs: [{ path: 'a', oldText: null }] }), undefined, 'diff entry without newText (null oldText)')
  assert.equal(result('third_party_probe', '{}', { path: 'a', diffs: [{ path: 'a', oldText: 7, newText: 'b' }] }), undefined, 'diff entry with a bad oldText')
  assert.equal(result('third_party_probe', '{}', { path: 'a', diffs: [1] }), undefined, 'diff entry that is not an object')
  // A read whose content is not exactly one file envelope is refused.
  const read = (content: readonly unknown[]): ReturnType<typeof presenter.result> => result('read', JSON.stringify({ file_path: 'src/a.ts' }), { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 }, content)
  assert.equal(read([{ type: 'text', text: 'ok' }]), undefined, 'not an envelope')
  assert.equal(read([{ type: 'text', text: '<path>src/a.ts</path>\n<type>directory</type>\n<content>\n1: a\n</content>' }]), undefined, 'not a file type')
  assert.equal(read([{ type: 'image' } as never]), undefined, 'non-text content')
  assert.equal(read([{ type: 'text', text: READ_ENVELOPE }, { type: 'text', text: 'extra' }]), undefined, 'multiple content blocks')
  // A `write` with valid args but NO result path yields no Result View even
  // when the metadata is malformed (owner W05-C) — the args diff rides the
  // call view, so a bad metadata shape never fabricates a synthetic result path.
  const writeNoPath = presenter.result('write', JSON.stringify({ file_path: 'src/a.ts', content: 'x' }), {
    content: [{ type: 'text', text: 'raw' }], isError: false, meta: { diffs: [{ foo: 1 }] },
  })
  assert.equal(writeNoPath, undefined, 'malformed diffs with no result path: no Result View')
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
  assert.equal(read({ ...base, path: 42 }), undefined, 'non-string path')
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

test('result: a same-named third-party tool can still match the read and write rows', () => {
  // dsh-web keys its Client slots by WIRE NAME too, so a third-party tool that
  // shadows `read`/`write` and emits a well-formed shape WOULD match here. This
  // is the accepted name-based bound (recognition, NOT source-identity
  // authentication) — the contract regression must stay visible rather than be
  // asserted as "impossible to collide".
  const shadowRead = presenter.result('read', JSON.stringify({ file_path: 'src/a.ts' }), {
    content: [{ type: 'text', text: READ_ENVELOPE }], isError: false,
    meta: { path: 'src/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1 },
  })
  assert.equal(shadowRead?.card, 'read', 'a name-shadowing `read` matches the read row')
  // A name-shadowing `write` with a well-formed RESULT PATH matches branch B
  // too — the accepted name-based bound (a third party that emits the shape
  // reaches the same row; there is no source-identity authentication).
  const shadowWrite = presenter.result('write', JSON.stringify({ file_path: 'src/a.ts', content: 'x' }), {
    content: [{ type: 'text', text: 'written' }], isError: false, meta: { path: 'src/a.ts', diffs: [] },
  })
  assert.equal(shadowWrite?.card, 'diff', 'a name-shadowing `write` matches the write-with-result-path row')
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
