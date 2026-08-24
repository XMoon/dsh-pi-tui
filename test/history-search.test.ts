/**
 * Headless tests for the Ctrl+R history search source (history-search.ts):
 * scope semantics, legacy cwd recovery (Rules 1–3), case-insensitive
 * matching, ordering, dedupe and cancellation. The source is pure
 * filesystem — no terminal, no dsh services.
 * @module @xmoon76/dsh-pi-tui/history-search.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileHistorySearchSource } from '../src/history-search.ts'
import type { HistorySearchResult, HistoryScope } from '../src/history-search.ts'
import { appendHistoryRecord, historyFilePath, historyFilePathFromHash } from '../src/history.ts'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pi-tui-history-search-'))
}

/** Write a canonical history file for a cwd directly. */
function writeV2(home: string, cwd: string, rows: Array<{ content: string; ts: number; sessionId?: string }>): void {
  const file = historyFilePath(home, cwd)
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  const lines = rows.map(row => JSON.stringify({
    v: 2,
    content: row.content,
    cwd,
    ts: row.ts,
    ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
  }))
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
}

function writeV1(home: string, cwd: string, rows: string[]): void {
  const file = historyFilePath(home, cwd)
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
  writeFileSync(file, rows.map(content => JSON.stringify({ content })).join('\n') + '\n', { mode: 0o600 })
}

function source(home: string, knownCwds?: Map<string, string>): FileHistorySearchSource {
  return new FileHistorySearchSource({ dshHome: home, knownCwds })
}

async function search(
  home: string,
  scope: HistoryScope,
  cwd: string,
  query: string,
  opts: { knownCwds?: Map<string, string>; signal?: AbortSignal } = {},
): Promise<HistorySearchResult[]> {
  return source(home, opts.knownCwds).search({ scope, cwd, query, limit: 100, signal: opts.signal })
}

test('current scope reads only the cwd file; v1 rows inherit the cwd', async () => {
  const home = tempHome()
  try {
    writeV1(home, '/work/a', ['alpha', 'beta'])
    writeV1(home, '/work/b', ['gamma'])
    const results = await search(home, 'current', '/work/a', '')
    assert.equal(results.length, 2)
    assert.ok(results.every(row => row.cwd === '/work/a'), 'v1 rows inherit the effective cwd')
    // Legacy rows have no ts: within one file, newest row first (sourceIndex DESC).
    assert.equal(results[0]?.content, 'beta')
    assert.equal(results[1]?.content, 'alpha')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('current scope with a query filters case-insensitively', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', [
      { content: 'Nginx Reload', ts: 1 },
      { content: 'docker ps', ts: 2 },
    ])
    const results = await search(home, 'current', '/a', 'nginx')
    assert.equal(results.length, 1)
    assert.equal(results[0]?.content, 'Nginx Reload')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all scope merges files newest-first by ts', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', [
      { content: 'older in a', ts: 10 },
      { content: 'newest in a', ts: 30 },
    ])
    writeV2(home, '/b', [{ content: 'middle in b', ts: 20 }])
    const results = await search(home, 'all', '/nowhere', '')
    assert.deepEqual(results.map(row => row.content), ['newest in a', 'middle in b', 'older in a'])
    assert.deepEqual(results.map(row => row.cwd), ['/a', '/b', '/a'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all scope: a v2 row validates the file hash and its cwd inherits to v1 rows (Rule 1)', async () => {
  const home = tempHome()
  try {
    // One MIXED file: legacy rows first, then a v2 row that proves the hash.
    const file = historyFilePath(home, '/a')
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    writeFileSync(file, [
      JSON.stringify({ content: 'legacy one' }),
      JSON.stringify({ content: 'legacy two' }),
      JSON.stringify({ v: 2, content: 'modern', cwd: '/a', ts: 5 }),
    ].join('\n') + '\n', { mode: 0o600 })
    const results = await search(home, 'all', '/nowhere', '')
    const legacy = results.find(row => row.content === 'legacy one')
    assert.ok(legacy !== undefined, 'legacy row survives the all-scope merge')
    assert.equal(legacy.cwd, '/a', 'legacy row inherits the file-proof cwd')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all scope: known-cwd hash map recovers a legacy-only file (Rule 2)', async () => {
  const home = tempHome()
  try {
    writeV1(home, '/legacy-dir', ['old prompt'])
    const known = new Map<string, string>()
    // The hash is derived from the file path (md5 of the cwd).
    known.set(historyFilePath(home, '/legacy-dir').split('/').pop()!.replace(/\.jsonl$/, ''), '/legacy-dir')
    const results = await search(home, 'all', '/nowhere', '', { knownCwds: known })
    assert.equal(results.length, 1)
    assert.equal(results[0]?.cwd, '/legacy-dir')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all scope: unresolved legacy rows are EXCLUDED (Rule 3 — no fabricated cwd)', async () => {
  const home = tempHome()
  try {
    writeV1(home, '/unknown', ['orphan prompt'])
    const results = await search(home, 'all', '/nowhere', '')
    assert.equal(results.length, 0, 'an unresolved legacy file must not show a fabricated cwd')
    // The same row remains findable in the CURRENT scope (its own file).
    const current = await search(home, 'current', '/unknown', '')
    assert.equal(current.length, 1)
    assert.equal(current[0]?.cwd, '/unknown')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all scope: knownCwds may be a RESOLVER — cwds learned after construction are immediately recoverable', async () => {
  const home = tempHome()
  try {
    writeV1(home, '/later-dir', ['legacy in a later session'])
    // The resolver starts empty; the "session switch" adds the cwd AFTER
    // the source was constructed — the next search must see it (Rule 2 is
    // never a startup snapshot).
    const known = new Map<string, string>()
    const resolver = (): ReadonlyMap<string, string> => known
    const source = new FileHistorySearchSource({ dshHome: home, knownCwds: resolver })
    const before = await source.search({ scope: 'all', cwd: '/nowhere', query: '', limit: 100 })
    assert.equal(before.length, 0, 'unresolved before the cwd is known (Rule 3)')
    // The cwd joins the set later (a session created/switched).
    known.set(historyFilePath(home, '/later-dir').split('/').pop()!.replace(/\.jsonl$/, ''), '/later-dir')
    const after = await source.search({ scope: 'all', cwd: '/nowhere', query: '', limit: 100 })
    assert.equal(after.length, 1)
    assert.equal(after[0]?.cwd, '/later-dir', 'the resolver is read per search')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all scope: a v2 row whose cwd does NOT validate the file hash is not trusted (plan §40)', async () => {
  const home = tempHome()
  try {
    // The FILE is md5('/a'); the v2 row claims '/b' (a moved directory or
    // a hand-edited row) — that cwd must never be trusted.
    const file = historyFilePath(home, '/a')
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    writeFileSync(file, JSON.stringify({ v: 2, content: 'suspect', cwd: '/b', ts: 9 }) + '\n', { mode: 0o600 })
    // All scope: no v2 row validates the hash, no known-cwd map entry →
    // the file is unresolved, its rows are EXCLUDED (Rule 3), never shown
    // under a fabricated directory.
    const all = await search(home, 'all', '/nowhere', '')
    assert.equal(all.length, 0, 'an unvalidated v2 cwd must not surface in the all scope')
    // Current scope: the row still lives in THE current-directory file, so
    // it is displayable under the inherited effective cwd — not the
    // untrusted /b.
    const current = await search(home, 'current', '/a', '')
    assert.equal(current.length, 1)
    assert.equal(current[0]?.cwd, '/a', 'the inherited effective cwd replaces the unvalidated one')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all scope: an unvalidated v2 row inherits the file proof when one exists', async () => {
  const home = tempHome()
  try {
    // The file is proven by row 1 (validating cwd '/a'); row 2's cwd
    // '/b' does not validate — it must NOT surface as /b.
    const file = historyFilePath(home, '/a')
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    writeFileSync(file, [
      JSON.stringify({ v: 2, content: 'proven', cwd: '/a', ts: 5 }),
      JSON.stringify({ v: 2, content: 'suspect', cwd: '/b', ts: 6 }),
    ].join('\n') + '\n', { mode: 0o600 })
    const results = await search(home, 'all', '/nowhere', '')
    const suspect = results.find(row => row.content === 'suspect')
    assert.ok(suspect !== undefined, 'the row stays searchable')
    assert.equal(suspect.cwd, '/a', 'the unvalidated cwd degrades to the file proof, never /b')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('current scope dedupes by content (newest wins)', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', [
      { content: 'same', ts: 1 },
      { content: 'x', ts: 2 },
      { content: 'same', ts: 3 },
    ])
    const results = await search(home, 'current', '/a', '')
    const same = results.filter(row => row.content === 'same')
    assert.equal(same.length, 1, 'current dedupe keeps one row per content')
    assert.equal(same[0]?.ts, 3, 'the NEWEST occurrence wins')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('all scope dedupes by (cwd, content) — the same prompt in two dirs stays two rows', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', [{ content: 'pnpm build', ts: 1 }])
    writeV2(home, '/b', [{ content: 'pnpm build', ts: 2 }])
    const results = await search(home, 'all', '/nowhere', 'pnpm')
    assert.equal(results.length, 2, 'a prompt in two directories is two rows')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('CJK and multi-line content match by substring', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', [{ content: '帮我检查这个问题\n第二行 nginx', ts: 1 }])
    const cjk = await search(home, 'current', '/a', '检查')
    assert.equal(cjk.length, 1)
    const multiline = await search(home, 'current', '/a', 'nginx')
    assert.equal(multiline.length, 1, 'a query on a later line matches')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an aborted search returns [] without partial results', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', [{ content: 'first', ts: 1 }])
    const controller = new AbortController()
    controller.abort()
    const results = await search(home, 'current', '/a', '', { signal: controller.signal })
    assert.deepEqual(results, [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('corrupt/vanished files degrade gracefully in the all scope', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', [{ content: 'healthy', ts: 1 }])
    // A corrupt file (not JSON) must not fail the whole search.
    writeFileSync(historyFilePath(home, '/corrupt'), 'not json\n', { mode: 0o600 })
    const results = await search(home, 'all', '/nowhere', '')
    assert.equal(results.length, 1)
    assert.equal(results[0]?.content, 'healthy')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('limit caps the returned rows', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', [
      { content: 'one', ts: 1 },
      { content: 'two', ts: 2 },
      { content: 'three', ts: 3 },
    ])
    const limited = await source(home).search({ scope: 'current', cwd: '/a', query: '', limit: 2 })
    assert.equal(limited.length, 2)
    assert.equal(limited[0]?.content, 'three')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})