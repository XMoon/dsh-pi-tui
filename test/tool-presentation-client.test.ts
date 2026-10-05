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
import { createClientToolPresenter } from '../src/tool-presentation-client.ts'

const presenter = createClientToolPresenter()

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

test('result: always undefined — settled rendering stays with the existing Client derivations', () => {
  assert.equal(presenter.result('edit', '{}', { content: [], isError: false }), undefined)
  assert.equal(presenter.result('bash', '{}', { content: [], isError: true }), undefined)
})

test('negative lock: no Host tool registry, no presenter callbacks, no wire surface', () => {
  const source = readFileSync(new URL('../src/tool-presentation-client.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal(code.includes('ctx.tools'), false)
  assert.equal(code.includes('ctx.get'), false)
  assert.equal(code.includes('presentCall'), false)
  assert.equal(code.includes('presentResult'), false)
  assert.equal(code.includes('toolPresenterFrom'), false,
    'the client presenter never wraps a Host registry lookup')
})
