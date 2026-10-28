/**
 * M4-A0 static process-boundary guards.
 *
 * The Host-only entry and the Client-only entry are separate OS processes in
 * the same package. Their source-level value closure must stay separated:
 * the Client entry may never reach the Host composition/aggregate, and the Host
 * entry may never reach the TUI renderer or the Client UI subtree. A future
 * edit that merely renames an entry but imports the aggregate would otherwise
 * silently rebuild M3's in-process graph inside one of the PIDs.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-boundary.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface ValueImport {
  readonly specifier: string
  readonly value: boolean
}

/** Every module edge the runtime load can execute (types are erased). */
function moduleEdges(file: string): ValueImport[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const edges: ValueImport[] = []
  const add = (specifier: string, value: boolean): void => { edges.push({ specifier, value }) }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.isTypeOnly !== true) {
        const hasValueBinding = clause === undefined
          || clause.name !== undefined
          || clause.namedBindings === undefined
          || ts.isNamespaceImport(clause.namedBindings)
          || clause.namedBindings.elements.some(element => !element.isTypeOnly)
        if (hasValueBinding) add(node.moduleSpecifier.getText(source).slice(1, -1), true)
      }
      return
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      if (!node.isTypeOnly) {
        add(node.moduleSpecifier.getText(source).slice(1, -1), node.exportClause === undefined
          || !ts.isNamedExports(node.exportClause)
          || node.exportClause.elements.some(element => !element.isTypeOnly))
      }
      return
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      add(node.arguments[0].text, true)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return edges
}

/** Resolve one relative source edge to its repository-relative path. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = join(dirname(fromFile), specifier)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, join(base, 'index.ts')]
  return candidates.find(candidate => existsSync(candidate))
}

/** The value-import closure rooted at one entry file. */
function valueClosure(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>()
  const bare = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop() as string
    const rel = relative(ROOT, file).split('\\').join('/')
    if (files.has(rel)) continue
    files.add(rel)
    for (const edge of moduleEdges(file)) {
      if (!edge.value) continue
      const resolved = resolveRelative(file, edge.specifier)
      if (resolved === undefined) {
        if (edge.specifier.startsWith('.')) throw new Error(`unresolved relative import ${edge.specifier} from ${rel}`)
        bare.add(edge.specifier)
        continue
      }
      queue.push(resolved)
    }
  }
  return { files, bare }
}

function assertNoMatch(files: ReadonlySet<string>, patterns: readonly RegExp[], label: string): void {
  for (const file of files) {
    for (const pattern of patterns) {
      assert.doesNotMatch(file, pattern, `${label} value closure must not include ${file}`)
    }
  }
}

test('the Client-only entry value closure never reaches the Host composition or the TUI renderer', () => {
  const closure = valueClosure(join(ROOT, 'src/app/remote-process/local-client-entry.ts'))
  assertNoMatch(closure.files, [
    /^src\/app\/remote\/runtime\.ts$/u,
    /^src\/app\/remote\/host-runtime\.ts$/u,
    /^src\/app\/remote\/application-runtime\.ts$/u,
    /^src\/app\/remote\/client-runtime\.ts$/u,
    /^src\/tui-app\.ts$/u,
  ], 'the Client-only entry')
  assert.ok(closure.files.has('src/app/remote-process/client-bootstrap.ts'))
  assert.ok(closure.files.has('src/app/remote/client-ui-runtime.ts'))
  assert.ok(closure.files.has('src/extensions.ts'), 'the Client entry must mount the real extension host')
  assert.ok(closure.files.has('src/builtins.ts'), 'the Client entry must mount the real first-party builtins')
})

test('the Host-only entry value closure never reaches the TUI renderer or the Client UI subtree', () => {
  const closure = valueClosure(join(ROOT, 'src/app/remote-process/local-host-entry.ts'))
  assertNoMatch(closure.files, [
    /^src\/tui-app\.ts$/u,
    /^src\/app\/remote-process\/client-bootstrap\.ts$/u,
    /^src\/app\/remote\/client-ui-runtime\.ts$/u,
    /^src\/extensions\.ts$/u,
    /^src\/builtins\.ts$/u,
  ], 'the Host-only entry')
  assert.ok(closure.files.has('src/app/remote-process/host-bootstrap.ts'))
  assert.ok(closure.files.has('src/app/remote/host-prerequisites.ts'))
  assert.ok(![...closure.bare].some(specifier => specifier === '@xmoon76/pi-tui'))
})

test('the package exposes no public Host/Client process entry or bin', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>
    bin?: unknown
  }
  const exported = Object.keys(manifest.exports ?? {})
  assert.ok(!exported.some(name => /local-(host|client)/u.test(name)), 'process entries stay internal artifacts')
  assert.equal(manifest.bin, undefined, 'M4-A0 adds no CLI command')
})
