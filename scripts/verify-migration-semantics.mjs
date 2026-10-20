#!/usr/bin/env node
/**
 * The migration's SEMANTIC check: every production path a test reads must
 * still point at the SAME file it pointed at before the move.
 *
 * A path rewrite that resolves to a DIFFERENT production file is a silent
 * semantic change: the test would keep passing while proving a different
 * contract.
 *
 * The reference extraction is SYNTAX-AWARE. A regex cannot tell an
 * executable `import('../src/x.ts')` from the same text inside a template
 * literal's TEXT — and a template literal's `${…}` INTERPOLATION is
 * executable code, not text. The TypeScript parser can: it reports the
 * actual module specifiers and ignores a string that merely CONTAINS an
 * import.
 *
 * Usage: node scripts/verify-migration-semantics.mjs <base-sha>
 * @module @xmoon76/dsh-pi-tui/scripts/verify-migration-semantics
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { discoverTestFiles } from './test-discovery.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = resolve(ROOT, 'test')

/**
 * The file-relative production references a test file makes.
 *
 * The TypeScript parser reports the ACTUAL module specifiers — the import
 * clauses, the dynamic imports and the `new URL(…, import.meta.url)` source
 * reads — and ignores text that merely contains an import. A specifier
 * inside a template literal's TEXT is therefore not a reference; a
 * specifier inside a template literal's `${…}` INTERPOLATION is, because
 * the parser sees it as executable code.
 */
export function productionReferences(source) {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  // A `.mjs` file is plain JavaScript; the parser handles both the same way
  // for the forms this extractor cares about.
  const refs = []
  const add = (specifier) => {
    if (typeof specifier !== 'string') return
    if (!specifier.startsWith('../')) return
    // A specifier may carry a QUERY string (`x.mjs?process-test=1`): the
    // query is not part of the path, so it is stripped before the
    // comparison.
    refs.push(specifier.split('?')[0])
  }
  const visit = (node) => {
    // The import clause: `import { x } from '…'`, and the side-effect form.
    if (ts.isImportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier.text)
    }
    // The dynamic import: `import('…')` — including one inside a template
    // literal's interpolation, which the parser sees as executable.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteralLike(argument)) add(argument.text)
      // The TEMPLATE dynamic import: `import(\`../src/app/${name}\`)`. The
      // literal prefix before the interpolation is the part that resolves.
      if (argument !== undefined && ts.isTemplateExpression(argument)) add(argument.head.text)
    }
    // The import TYPE query: `import('…').Type` — a distinct AST form
    // from the dynamic import, and a real reference.
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal
      if (ts.isStringLiteralLike(literal)) add(literal.text)
    }
    // The CommonJS require: `require('…')`.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const [argument] = node.arguments
      if (argument !== undefined && ts.isStringLiteralLike(argument)) add(argument.text)
    }
    // The source read: `new URL('…', import.meta.url)`.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const [first] = node.arguments
      if (first !== undefined && ts.isStringLiteralLike(first)) add(first.text)
      // The TEMPLATE source read: `new URL(\`../src/${name}\`, …)`. The
      // literal prefix before the interpolation is the part that resolves.
      if (first !== undefined && ts.isTemplateExpression(first)) add(first.head.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return refs
}

/**
 * How many production references the source mentions, counted WITHOUT
 * knowing the forms.
 *
 * The comparison with {@link productionReferences} is the coverage proof: a
 * form the extractor does not recognise makes the two counts differ, and
 * the caller reports it instead of reporting a false assurance.
 */
export function productionReferenceCount(source) {
  let count = 0
  for (const match of source.matchAll(/(?:new URL\(\s*|^\s*import\s+|\bfrom\s+|\bimport\s*\(\s*)['"`](\.\.\/[^'"`$]*)/gmu)) {
    count += 1
    void match
  }
  return count
}

/**
 * The references the TEXT scan finds that the parser does not.
 *
 * Every one of them must be a reference inside a plain string literal (a
 * source-lock assertion or a test fixture) — the parser ignores those on
 * purpose, and the text scan cannot tell them apart from a real reference.
 * A difference that is NOT inside a string literal is a form the extractor
 * missed, and the caller reports it.
 */
export function unexplainedTextReferences(source) {
  const parsed = productionReferences(source)
  const text = []
  for (const match of source.matchAll(/(?:new URL\(\s*|^\s*import\s+|\bfrom\s+|\bimport\s*\(\s*)['"`](\.\.\/[^'"`$]*)/gmu)) {
    if (isInsideStringLiteral(source, match.index)) continue
    // The comparison strips the QUERY string, exactly as the extractor does.
    const specifier = match[1].split('?')[0]
    if (!parsed.includes(specifier)) text.push(specifier)
  }
  return text
}

/** Whether the offset falls inside a string literal. */
function isInsideStringLiteral(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  const line = source.slice(lineStart, offset)
  let quote = undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
  }
  return quote !== undefined
}

/**
 * The base tree's version of a file, or `undefined`.
 *
 * The base tree's file may be at the FLAT root (`test/<name>.test.ts`) or
 * already in a subdirectory, so the base lookup tries the current path
 * first and then the flat basename.
 */
function baseSource(rel) {
  const base = process.argv[2]
  const candidates = [rel, rel.split('/').pop()]
  for (const candidate of candidates) {
    try {
      return execFileSync('git', ['show', `${base}:test/${candidate}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

function main() {
  const base = process.argv[2]
  if (base === undefined) {
    console.error('usage: node scripts/verify-migration-semantics.mjs <base-sha>')
    process.exit(2)
  }
  const files = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  let compared = 0
  let changed = 0
  const problems = []
  // The COVERAGE proof: a reference form the extractor does not recognise
  // would make the check report a false assurance. The extractor's count is
  // compared against an independent, form-agnostic count; a difference is
  // REPORTED, not silently accepted.
  const uncovered = []

  for (const rel of files) {
    const source = readFileSync(resolve(TEST_ROOT, rel), 'utf8')
    const before = baseSource(rel)
    if (before === undefined) continue
    const beforeRefs = productionReferences(before)
    const afterRefs = productionReferences(source)
    // The coverage check runs BEFORE the zero-reference skip: a file whose
    // ONLY reference uses an unrecognised form must still be reported.
    const unexplained = unexplainedTextReferences(source)
    if (unexplained.length > 0) {
      uncovered.push(`${rel}: ${unexplained.length} reference(s) the extractor did not recognise: ${unexplained.join(', ')}`)
    }
    if (beforeRefs.length === 0) continue
    compared += 1

    // The RESOLVED target of every reference, as a path relative to the
    // repository root. The base and the current tree must resolve to the
    // SAME production file.
    //
    // The BASE file lives at the FLAT root, so its references resolve
    // against `test/`, while the current file resolves against its own
    // directory. Each side is resolved against ITS OWN location — that is
    // exactly what the migration had to preserve.
    const baseRel = rel.split('/').pop()
    const resolveAll = (text, fileRel) => productionReferences(text)
      .map(spec => relative(ROOT, resolve(dirname(resolve(TEST_ROOT, fileRel)), spec)))
      .filter(path => path.startsWith('src/') || path.startsWith('packages/'))
      .sort()
    const beforeTargets = resolveAll(before, baseRel)
    const afterTargets = resolveAll(source, rel)
    if (JSON.stringify(beforeTargets) === JSON.stringify(afterTargets)) continue
    changed += 1
    const removed = beforeTargets.filter(target => !afterTargets.includes(target))
    const added = afterTargets.filter(target => !beforeTargets.includes(target))
    if (removed.length === 0 && added.length === 0) continue
    problems.push({ rel, removed, added })
  }

  console.log(`test files with production references compared: ${compared}`)
  console.log(`files whose resolved production targets CHANGED: ${changed}`)
  console.log(`files with a reference form the extractor did NOT recognise: ${uncovered.length}`)
  for (const entry of uncovered) console.log(`  ${entry}`)
  if (problems.length === 0) {
    console.log('\nno test now reads a DIFFERENT production file than before the move')
  } else {
    console.log('')
    for (const problem of problems) {
      console.log(`${problem.rel}`)
      for (const target of problem.removed) console.log(`  - ${target}`)
      for (const target of problem.added) console.log(`  + ${target}`)
    }
  }
  if (problems.length > 0 || uncovered.length > 0) process.exitCode = 1
}

// The module is importable: the extractor is proved by
// `test/tooling/migration-semantics.test.mjs`, which imports it directly.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
