#!/usr/bin/env node
/**
 * Raw-persistence coupling gate (Stage A A10.4): forbid the normal TUI
 * runtime from re-coupling to physical session artifacts. On the master
 * baseline every session read goes through the semantic session-query
 * seam (`listSessions` / `observeSession` / `filterEvents`); the raw
 * persistence fallback (`readRaw`, `locate`, `session.jsonl` /
 * `session.vN` filename guessing) is removed legacy, and the repair
 * tooling that once justified physical knowledge is retired.
 *
 * A TEXT scan is used deliberately instead of an AST analysis: the goal is
 * to stop NEW coupling, and a syntactic token check cannot be evaded by
 * aliasing, scoping, namespace tricks, or computed access. The cost is
 * that comments and strings mentioning the tokens are flagged too —
 * reword them. The scan covers `src/**` only: test files legitimately
 * assert the ABSENCE of these paths.
 *
 * Exit 0: clean. Exit 1: violations printed as `file:line`, the matched
 * token, and the fix.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The forbidden physical-coupling tokens, each with its fix hint. */
export const FORBIDDEN_PATTERNS = [
  { pattern: /\breadRaw\b/gu, label: 'readRaw', fix: 'read through sessionQuery.observeSession instead' },
  { pattern: /\.locate\(/gu, label: '.locate(', fix: 'never resolve a physical session artifact path' },
  { pattern: /session\.jsonl/gu, label: 'session.jsonl', fix: 'never guess the physical log filename' },
  { pattern: /session\.v\d/gu, label: 'session.vN', fix: 'never guess a generation-suffixed log filename' },
]

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

export function collectSourceFiles(rootDir, files = []) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      collectSourceFiles(full, files)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot > 0 && SCANNABLE_EXTENSIONS.has(entry.name.slice(dot))) files.push(full)
    }
  }
  return files
}

/** Scan one source text; returns `{ file, line, token, fix }` violations. */
export function scanSource(file, source) {
  const violations = []
  const lines = source.split('\n')
  for (const { pattern, label, fix } of FORBIDDEN_PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) {
        violations.push({ file, line: index + 1, token: label, fix })
      }
    }
  }
  return violations
}

/** Scan every scannable file under a source root. */
export function scanTree(rootDir) {
  const violations = []
  for (const file of collectSourceFiles(rootDir)) {
    const source = readFileSync(file, 'utf8')
    violations.push(...scanSource(relative(rootDir, file).split('\\').join('/'), source))
  }
  return violations
}

function main() {
  const root = join(import.meta.dirname, '..', 'src')
  const violations = scanTree(root)
  if (violations.length === 0) {
    console.log('raw-persistence coupling gate: clean')
    return
  }
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.token} — ${violation.fix}`)
  }
  console.error(`raw-persistence coupling gate: ${violations.length} violation(s)`)
  process.exitCode = 1
}

if (process.argv[1] === pathToFileURL(import.meta.filename).href) main()
