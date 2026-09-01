#!/usr/bin/env node
/**
 * Temp-hygiene gate: forbid the `mkdtemp`/`mkdtempSync` tokens in root
 * test files so every fixture directory keeps a single owner —
 * `testLifecycle(t).tempDir(prefix)` from test/support/temp-lifecycle.ts.
 *
 * A TEXT scan is used deliberately instead of an AST analysis: the goal is
 * to stop NEW direct temp creation, and a syntactic token check cannot be
 * evaded by aliasing, scoping, namespace tricks, or computed access. The
 * cost is that comments and strings mentioning the tokens are flagged too —
 * reword them. The real safety net for anything the gate cannot see (child
 * processes, generated scripts) is the runner's TMPDIR containment.
 *
 * Exit 0: clean. Exit 1: violations printed as `file:line`, the matched
 * token, and the fix. Files that legitimately contain the tokens are listed
 * in ALLOWED_DIRECT_USAGE with a reason — keep that list tiny.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const FORBIDDEN_TOKEN = /\bmkdtemp(?:Sync)?\b/gu

/** Files allowed to contain the tokens, relative to the test root. Each entry needs a reason. */
export const ALLOWED_DIRECT_USAGE = [
  { file: 'support/temp-lifecycle.ts', reason: 'the helper itself: the one place allowed to create test temp dirs' },
  { file: 'temp-hygiene-gate.test.mjs', reason: 'the gate\'s own test fixtures must contain the forbidden tokens' },
  { file: 'dev-bootstrap-ephemeral.test.mjs', reason: 'embedded fake-pnpm child script must create real temp dirs to drive the real source-pack script (contained by the runner)' },
  { file: 'dsh-source-identity.test.mjs', reason: 'embedded fake-pnpm child script must create real temp dirs to drive the real source-pack script (contained by the runner)' },
]

const SCANNABLE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

export function collectTestFiles(rootDir, files = []) {
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      collectTestFiles(full, files)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf('.')
      if (dot > 0 && SCANNABLE_EXTENSIONS.has(entry.name.slice(dot))) files.push(full)
    }
  }
  return files
}

function isAllowedFile(rootDir, file) {
  const rel = relative(rootDir, file).split('\\').join('/')
  return ALLOWED_DIRECT_USAGE.some((allowed) => allowed.file === rel)
}

/** Scan one source file's text; returns violations (file:line + matched token). */
export function scanSource(filePath, sourceText) {
  const violations = []
  for (const match of sourceText.matchAll(FORBIDDEN_TOKEN)) {
    const line = sourceText.slice(0, match.index).split('\n').length
    violations.push({ file: filePath, line, api: match[0] })
  }
  return violations
}

/** Scan a whole test root: discovers scannable files, allows the whitelist, reports the rest. */
export function scanTree(rootDir) {
  const violations = []
  for (const file of collectTestFiles(rootDir)) {
    if (isAllowedFile(rootDir, file)) continue
    violations.push(...scanSource(file, readFileSync(file, 'utf8')))
  }
  return violations
}

function printViolations(violations) {
  console.error(`temp-hygiene-gate: ${violations.length} mkdtemp* token(s) outside the allowed files`)
  for (const violation of violations) {
    console.error('')
    console.error(`  ${violation.file}:${violation.line}`)
    console.error(`    hit: ${violation.api}`)
    console.error('    fix: use testLifecycle(t).tempDir(prefix) from test/support/temp-lifecycle.ts so the owning test disposes the directory')
  }
  console.error('')
  console.error('  If a case genuinely cannot avoid the token, extend ALLOWED_DIRECT_USAGE in scripts/temp-hygiene-gate.mjs with a reason.')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const rootDir = process.argv[2] ?? join(process.cwd(), 'test')
  const violations = scanTree(rootDir)
  if (violations.length > 0) {
    printViolations(violations)
    process.exit(1)
  }
  console.log(`temp-hygiene-gate: clean (${rootDir})`)
}
