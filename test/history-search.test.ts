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
import { FileHistorySearchSource, HistorySearchContinuationError } from '../src/history-search.ts'
import type { HistorySearchDebugStats, HistorySearchResult, HistoryScope } from '../src/history-search.ts'
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
  const page = await source(home, opts.knownCwds).search({ scope, cwd, query, limit: 100, signal: opts.signal })
  return page.results
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
    assert.equal(before.results.length, 0, 'unresolved before the cwd is known (Rule 3)')
    // The cwd joins the set later (a session created/switched).
    known.set(historyFilePath(home, '/later-dir').split('/').pop()!.replace(/\.jsonl$/, ''), '/later-dir')
    const after = await source.search({ scope: 'all', cwd: '/nowhere', query: '', limit: 100 })
    assert.equal(after.results.length, 1)
    assert.equal(after.results[0]?.cwd, '/later-dir', 'the resolver is read per search')
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
    assert.equal(limited.results.length, 2)
    assert.equal(limited.results[0]?.content, 'three')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Bounded recent-first scanning (the perf contract): global scan budget,
// mtime priority, page/continuation semantics, early exit, stats.
// ---------------------------------------------------------------------------

test('S1: current scope never parses the whole file — the global budget bounds the scan', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', Array.from({ length: 10000 }, (_, i) => ({ content: `prompt-${i}`, ts: i })))
    // A sparse query (no early exit): the scan must stop at the budget.
    const stats: HistorySearchDebugStats = { filesVisited: 0, physicalLinesScanned: 0, bytesRead: 0 }
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 500, stats })
    const page = await src.search({ scope: 'current', cwd: '/a', query: 'zzz-no-match', limit: 100 })
    assert.equal(page.results.length, 0)
    assert.ok(stats.physicalLinesScanned <= 500, `scanned ${stats.physicalLinesScanned} > 500`)
    assert.ok(stats.physicalLinesScanned < 10000, 'the whole file must not be parsed')
    assert.equal(page.exhausted, false, 'budget exhaustion is not EOF')
    assert.ok(page.continuation !== undefined, 'older history remains reachable')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S2: the all-scope budget is GLOBAL — three files share one cap, never per-file', async () => {
  const home = tempHome()
  try {
    for (const dir of ['/a', '/b', '/c']) {
      writeV2(home, dir, Array.from({ length: 3000 }, (_, i) => ({ content: `prompt-${dir}-${i}`, ts: i })))
    }
    const stats: HistorySearchDebugStats = { filesVisited: 0, physicalLinesScanned: 0, bytesRead: 0 }
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 5000, stats })
    const page = await src.search({ scope: 'all', cwd: '/nowhere', query: 'zzz-no-match', limit: 100 })
    assert.ok(stats.physicalLinesScanned <= 5000, `scanned ${stats.physicalLinesScanned} > 5000`)
    assert.ok(stats.physicalLinesScanned > 3000, 'the scan must cross file boundaries (not 5000 per file)')
    assert.equal(page.exhausted, false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S3: the all-scope scan visits the most recently modified file first', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', Array.from({ length: 100 }, (_, i) => ({ content: `a-${i}`, ts: i })))
    writeV2(home, '/b', Array.from({ length: 100 }, (_, i) => ({ content: `b-${i}`, ts: 100 + i })))
    const aFile = historyFilePath(home, '/a')
    const bFile = historyFilePath(home, '/b')
    const { utimesSync } = await import('node:fs')
    const old = new Date(Date.now() - 60_000)
    const newer = new Date(Date.now())
    utimesSync(bFile, old, old)
    utimesSync(aFile, newer, newer)
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 150 })
    const page = await src.search({ scope: 'all', cwd: '/nowhere', query: '', limit: 1000 })
    const fromA = page.results.filter(row => row.sourceFile === aFile).length
    const fromB = page.results.filter(row => row.sourceFile === bFile).length
    assert.equal(fromA, 100, 'the newest-mtime file is scanned first and fully')
    assert.equal(fromB, 50, 'the older file is cut by the remaining budget')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S4: the final order is row.ts — file mtime never overrides it', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', Array.from({ length: 100 }, (_, i) => ({ content: `a-${i}`, ts: i })))
    writeV2(home, '/b', Array.from({ length: 100 }, (_, i) => ({ content: `b-${i}`, ts: 100 + i })))
    const aFile = historyFilePath(home, '/a')
    const bFile = historyFilePath(home, '/b')
    const { utimesSync } = await import('node:fs')
    const old = new Date(Date.now() - 60_000)
    utimesSync(aFile, old, old) // /a is the OLDER mtime — scanned LAST
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 1000 })
    const page = await src.search({ scope: 'all', cwd: '/nowhere', query: '', limit: 1000 })
    assert.equal(page.results[0]?.sourceFile, bFile, 'the newest ts row leads regardless of scan order')
    assert.equal(page.results[0]?.ts, 199)
    assert.equal(page.results[page.results.length - 1]?.sourceFile, aFile)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S5: resultLimit and scanLimit are separate — a query never stops at 20 matches', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', Array.from({ length: 500 }, (_, i) => ({ content: `prompt-${i}`, ts: i })))
    const stats: HistorySearchDebugStats = { filesVisited: 0, physicalLinesScanned: 0, bytesRead: 0 }
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 1000, stats })
    const page = await src.search({ scope: 'current', cwd: '/a', query: 'prompt', limit: 20 })
    assert.equal(page.results.length, 20)
    assert.equal(stats.physicalLinesScanned, 500, 'the scan ran to EOF, not to 20 matches')
    assert.equal(page.exhausted, false, 'the overflow still holds the unreported matches')
    assert.ok(page.continuation !== undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S6: a sparse query scans to the budget/EOF, not to the first matches', async () => {
  const home = tempHome()
  try {
    const rows = Array.from({ length: 6000 }, (_, i) => ({
      content: i % 350 === 0 ? `needle-${i}` : `filler-${i}`,
      ts: i,
    }))
    writeV2(home, '/a', rows)
    const stats: HistorySearchDebugStats = { filesVisited: 0, physicalLinesScanned: 0, bytesRead: 0 }
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 5000, stats })
    const page = await src.search({ scope: 'current', cwd: '/a', query: 'needle', limit: 100 })
    // Needles in the newest 5000 rows (ts 1000..5999): 1050, 1400, ..., 5950.
    assert.equal(page.results.length, 15)
    assert.equal(stats.physicalLinesScanned, 5000, 'the scan ran to the budget, not to the matches')
    assert.equal(page.exhausted, false)
    assert.ok(page.continuation !== undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S7: an empty query stops early once this call has enough unique results', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', Array.from({ length: 10000 }, (_, i) => ({ content: `prompt-${i}`, ts: i })))
    const stats: HistorySearchDebugStats = { filesVisited: 0, physicalLinesScanned: 0, bytesRead: 0 }
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 5000, stats })
    const page = await src.search({ scope: 'current', cwd: '/a', query: '', limit: 100 })
    assert.equal(page.results.length, 100)
    assert.ok(stats.physicalLinesScanned < 5000, `early exit did not trigger (scanned ${stats.physicalLinesScanned})`)
    assert.equal(page.exhausted, false)
    assert.ok(page.continuation !== undefined, 'older history remains reachable')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S11: continuation pages resume without rescanning — no gaps, no duplicates', async () => {
  const home = tempHome()
  try {
    const rows = Array.from({ length: 12000 }, (_, i) => ({
      content: i % 400 === 0 ? `needle-${i}` : `filler-${i}`,
      ts: i,
    }))
    writeV2(home, '/a', rows)
    const stats: HistorySearchDebugStats = { filesVisited: 0, physicalLinesScanned: 0, bytesRead: 0 }
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 5000, stats })
    const request = { scope: 'current' as const, cwd: '/a', query: 'needle', limit: 100 }
    const page1 = await src.search(request)
    const scanned1 = stats.physicalLinesScanned
    assert.equal(page1.results.length, 12, 'needles in rows 7000..11999')
    assert.equal(page1.exhausted, false)
    assert.ok(page1.continuation !== undefined)
    const page2 = await src.search(request, page1.continuation)
    const scanned2 = stats.physicalLinesScanned
    assert.equal(page2.results.length, 13, 'needles in rows 2000..6999')
    assert.equal(page2.exhausted, false)
    assert.ok(page2.continuation !== undefined)
    const page3 = await src.search(request, page2.continuation)
    const scanned3 = stats.physicalLinesScanned
    assert.equal(page3.results.length, 5, 'needles in rows 0..1999')
    assert.equal(page3.exhausted, true)
    assert.equal(page3.continuation, undefined)
    // No rescan of the covered suffix: the three calls together scanned
    // exactly the file's 12000 rows (a rescan would exceed it).
    assert.equal(scanned1 + scanned2 + scanned3, 12000)
    // Merged pages: every needle exactly once, nothing missing.
    const merged = [...page1.results, ...page2.results, ...page3.results]
    assert.equal(merged.length, 30)
    assert.equal(new Set(merged.map(row => row.content)).size, 30, 'no duplicate rows across pages')
    assert.deepEqual(
      new Set(merged.map(row => row.content)),
      new Set(Array.from({ length: 30 }, (_, i) => `needle-${i * 400}`)),
      'no missing rows across pages',
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S12: reaching the scan budget is not exhausted', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', Array.from({ length: 1000 }, (_, i) => ({ content: `p-${i}`, ts: i })))
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 100 })
    const page = await src.search({ scope: 'current', cwd: '/a', query: 'zzz', limit: 100 })
    assert.equal(page.exhausted, false)
    assert.ok(page.continuation !== undefined)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S13: a continuation with a mismatched request context is a typed error', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', Array.from({ length: 1000 }, (_, i) => ({ content: `p-${i}`, ts: i })))
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 100 })
    const request = { scope: 'current' as const, cwd: '/a', query: 'zzz', limit: 100 }
    const page = await src.search(request)
    assert.ok(page.continuation !== undefined)
    await assert.rejects(
      src.search({ ...request, query: 'different' }, page.continuation),
      (error: unknown) => error instanceof HistorySearchContinuationError,
    )
    await assert.rejects(
      src.search({ ...request, scope: 'all' }, page.continuation),
      (error: unknown) => error instanceof HistorySearchContinuationError,
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S14: page overflow is carried — no match is ever lost across pages', async () => {
  const home = tempHome()
  try {
    // 100 rows, limit 10: a single batch collects far more than the page
    // can report — the overflow must drain on the following pages.
    writeV2(home, '/a', Array.from({ length: 100 }, (_, i) => ({ content: `prompt-${i}`, ts: i })))
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 5000 })
    const request = { scope: 'current' as const, cwd: '/a', query: '', limit: 10 }
    const pages: HistorySearchResult[][] = []
    let continuation: import('../src/history-search.ts').HistorySearchContinuation | undefined
    for (let i = 0; i < 20; i += 1) {
      const page = await src.search(request, continuation)
      pages.push(page.results)
      if (page.exhausted) break
      continuation = page.continuation
    }
    const merged = pages.flat()
    assert.equal(merged.length, 100, 'every match is reported across pages')
    assert.equal(new Set(merged.map(row => row.content)).size, 100, 'no duplicates across pages')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S15: a file fully scanned at the exact budget boundary is not re-scanned by the next page', async () => {
  const home = tempHome()
  try {
    writeV2(home, '/a', Array.from({ length: 100 }, (_, i) => ({ content: `a-${i}`, ts: i })))
    writeV2(home, '/b', Array.from({ length: 100 }, (_, i) => ({ content: `b-${i}`, ts: 100 + i })))
    const stats: HistorySearchDebugStats = { filesVisited: 0, physicalLinesScanned: 0, bytesRead: 0 }
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 100, stats })
    const request = { scope: 'all' as const, cwd: '/nowhere', query: 'zzz', limit: 100 }
    const page1 = await src.search(request)
    assert.equal(page1.exhausted, false)
    assert.ok(page1.continuation !== undefined)
    const page2 = await src.search(request, page1.continuation)
    assert.equal(stats.physicalLinesScanned, 100, 'page 2 scanned only file B — file A was not re-scanned')
    assert.equal(page2.exhausted, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('S16: all-scope pending rows survive across pages — a proof found on a later page recovers them', async () => {
  const home = tempHome()
  try {
    // One validating v2 row (OLDEST) + 100 legacy v1 rows (newer): page 1
    // scans the v1 rows with no proof yet (all pending), page 2 finds the
    // proof — the pending rows from page 1 must still be recovered.
    const file = historyFilePath(home, '/a')
    mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
    const lines = [
      JSON.stringify({ v: 2, content: 'modern', cwd: '/a', ts: 5 }),
      ...Array.from({ length: 100 }, (_, i) => JSON.stringify({ content: `legacy-${i}` })),
    ]
    writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
    const src = new FileHistorySearchSource({ dshHome: home, scanLimit: 100 })
    const request = { scope: 'all' as const, cwd: '/nowhere', query: '', limit: 1000 }
    const page1 = await src.search(request)
    assert.equal(page1.results.length, 0, 'page 1 scanned only unresolved v1 rows')
    assert.equal(page1.exhausted, false)
    assert.ok(page1.continuation !== undefined)
    const page2 = await src.search(request, page1.continuation)
    const legacy = page2.results.filter(row => row.content.startsWith('legacy-'))
    assert.equal(legacy.length, 100, 'every pending legacy row is recovered by the later proof')
    assert.ok(legacy.every(row => row.cwd === '/a'), 'the recovered rows carry the proven cwd')
    assert.equal(page2.exhausted, true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})