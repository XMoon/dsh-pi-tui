/**
 * Static audit for the fire-and-forget hard rule (AGENTS.md): this test
 * detects COMMON SINGLE-LINE `void call()` / `void (expr)` promise
 * discards in production code — it is NOT a substitute for review or a
 * type-aware lint (`@typescript-eslint/no-floating-promises` catches forms
 * this matcher cannot see: variable promises, `new Promise`, line-broken
 * void, and floating promises without `void`). Every detected use must be
 * either a terminal sink inside `src/detached.ts` (the helpers themselves)
 * or a documented lifecycle-root allowlist entry — a line carrying the
 * `allowlist` marker (the startup and exit orchestrations). New hand-
 * written `void` promise chains fail this test instead of waiting for the
 * next review round.
 * @module @xmoon76/dsh-pi-tui/rules.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Recursively list every `.ts` file under a directory. */
function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      files.push(...listSourceFiles(path))
    } else if (entry.endsWith('.ts')) {
      files.push(path)
    }
  }
  return files
}

/** Remove block comments and line comments, PRESERVING line numbers (a
 * block comment is replaced by its own newlines, and a `//` preceded by
 * `:` — e.g. inside `https://` — is left alone, so URLs survive). */
export function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ''))
  return withoutBlocks.split('\n').map(line => {
    const match = line.match(/(^|[^:])\/\//)
    if (match === null) return line
    return line.slice(0, (match.index ?? 0) + 1)
  }).join('\n')
}

/** The `void` OPERATOR followed by a call/parenthesized promise expression
 * (`void x` no-op statements and type-position `): void {` never match).
 * Deliberately narrow: common single-line discard forms only (see the
 * module doc — not a substitute for a type-aware lint). */
export const VOID_PROMISE = /\bvoid\s+(?:\(|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\()/

/** Find the (1-based) line numbers of `void <promise>` discards. */
export function findVoidDiscards(source: string): number[] {
  const lines = stripComments(source).split('\n')
  const found: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (VOID_PROMISE.test(lines[index]!)) found.push(index + 1)
  }
  return found
}

test('the matcher self-tests: allowed fixtures stay allowed, denied fixtures are caught', () => {
  const denied = [
    'void somePromise()',
    'void object.somePromise()',
    'void this.launchEditor()',
    'void deps.resolveModelInfo(providerId, modelId)',
    'void (async () => {})()',
    'void task.catch(() => {})',
    'void Promise.resolve(value).then(() => {})',
  ]
  const allowed = [
    'void x', // no-op statement, not a promise
    '): void {', // type position
    'Promise<void>', // type position
    'void 0',
    'const run = (): void => {}', // return-type position
    'void | Promise<void>', // type union
  ]
  for (const line of denied) {
    assert.ok(findVoidDiscards(line).length > 0, `denied fixture must be caught: ${line}`)
  }
  for (const line of allowed) {
    assert.deepEqual(findVoidDiscards(line), [], `allowed fixture must pass: ${line}`)
  }
  // Comments must never count (the strip runs before the match).
  assert.deepEqual(findVoidDiscards('// never a bare void somePromise()'), [])
  assert.deepEqual(findVoidDiscards('/* doc: void somePromise() */'), [])
})

test('every production `void <promise>` discard is in detached.ts or an explicit allowlist', () => {
  const violations: string[] = []
  for (const path of listSourceFiles(srcDir)) {
    const file = relative(srcDir, path)
    const source = readFileSync(path, 'utf8')
    const originalLines = source.split('\n')
    const clean = stripComments(source).split('\n')
    for (let index = 0; index < clean.length; index += 1) {
      if (!VOID_PROMISE.test(clean[index]!)) continue
      // detached.ts is the helpers' own terminal sink; everything else
      // needs the explicit `allowlist` marker on the SAME line (checked
      // on the ORIGINAL line: comment stripping removes the marker).
      if (file !== 'detached.ts' && !originalLines[index]!.includes('allowlist')) {
        violations.push(`${file}:${index + 1}: ${clean[index]!.trim()}`)
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'hand-written `void` promise chains are only legal inside detached.ts or with an explicit `allowlist` marker (AGENTS.md hard rule)',
  )
})
