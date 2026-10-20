#!/usr/bin/env node
/**
 * The zero-consumer EXPORT report for the shared test helpers.
 *
 * An `export` on a helper symbol that NO other test file imports is a
 * public surface with no consumer: it invites a future test to reach for a
 * capability the helper was never designed to offer, and it hides the fact
 * that the symbol is really module-internal.
 *
 * The report is READ-ONLY. It names the symbols, classifies them as
 * "modifier-only" (used only at the definition site — the `export` is pure
 * noise) or "internally used" (the symbol is used inside its own module
 * and only the `export` modifier is unnecessary), and does NOT change
 * anything.
 *
 * Usage: node scripts/report-zero-consumer-exports.mjs
 * @module @xmoon76/dsh-pi-tui/scripts/report-zero-consumer-exports
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/** Every helper module under `test/support/` and `test/fixtures/`. */
function helperModules() {
  const helpers = []
  for (const directory of ['support', 'fixtures']) {
    const base = join(TEST_ROOT, directory)
    let entries
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && /\.(ts|mjs)$/u.test(entry.name)) helpers.push(join(base, entry.name))
    }
  }
  return helpers
}

/** Every test file in the tree. */
function testFiles() {
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'support' || entry.name === 'fixtures') continue
        walk(path)
      } else if (/\.test\.(ts|mjs)$/u.test(entry.name)) {
        files.push(path)
      }
    }
  }
  walk(TEST_ROOT)
  return files
}

/** The symbols a module exports. */
function exportedSymbols(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true)
  const exported = new Set()
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) exported.add(statement.name.text)
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exported.add(declaration.name.text)
      }
    } else if (
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement))
      && statement.name !== undefined
    ) {
      exported.add(statement.name.text)
    }
  }
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exported.add(element.name.text)
    }
  }
  return exported
}

function main() {
  const helpers = helperModules()
  const tests = testFiles()
  const testSources = tests.map(path => ({ path, source: readFileSync(path, 'utf8') }))

  const modifierOnly = []
  const internalUsed = []
  for (const helper of helpers) {
    const source = readFileSync(helper, 'utf8')
    for (const name of exportedSymbols(helper, source)) {
      const pattern = new RegExp(`\\b${name.replace(/[$]/gu, '\\$&')}\\b`, 'gu')
      const external = testSources.some(test => test.path !== helper && pattern.test(test.source))
      if (external) continue
      const localHits = (source.match(pattern) ?? []).length
      const relative = helper.slice(ROOT.length + 1)
      if (localHits <= 1) modifierOnly.push(`${relative}: ${name}`)
      else internalUsed.push(`${relative}: ${name} (${localHits} local uses)`)
    }
  }

  console.log(`helper modules: ${helpers.length}, test files: ${tests.length}`)
  console.log(`\n=== modifier-only (the export is pure noise) — ${modifierOnly.length} ===`)
  for (const entry of modifierOnly) console.log(`  ${entry}`)
  console.log(`\n=== internally used (only the export modifier is unnecessary) — ${internalUsed.length} ===`)
  for (const entry of internalUsed) console.log(`  ${entry}`)
}

main()
