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
import ts from 'typescript'

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

test('no production code listens to the removed credentials/updated event', () => {
  // dsh 0.1.1-rc.1 split `credentials/updated` into
  // `credentials/reference-updated` + `credentials/record-updated`; the old
  // name no longer exists in the upstream event map and must never come
  // back into running code (a stale listener would silently refresh
  // nothing). Docs may still describe the old name historically.
  const violations: string[] = []
  for (const path of listSourceFiles(srcDir)) {
    const file = relative(srcDir, path)
    const source = readFileSync(path, 'utf8')
    // ANY occurrence is refused — comments included — so the old name can
    // never re-enter the source in a form a later grep-based migration
    // would trip on (the docs may still describe it historically).
    if (source.includes('credentials/updated')) {
      violations.push(file)
    }
  }
  assert.deepEqual(
    violations,
    [],
    'the old credentials/updated event name is removed in dsh 0.1.1-rc.1; listen to credentials/reference-updated and credentials/record-updated',
  )
})

test('no keybinding settings watch callback crosses the config port (migration boundary)', () => {
  // Server/client migration (review rounds 28/30/31): the TUI settings
  // document surface (`TuiSettingsConfig`/`TuiSettingsLike`) is get/replace
  // ONLY. A `.watch(callback)` on the settings document in src/ would be a
  // Direct-only dependency on a Host-side watch — a callback could not map
  // across the process boundary in the future Remote adapter (migration
  // rule: no callbacks across the wire). The keybinding reload seam is
  // EXPLICIT (`/keybindings reload` re-reads the document); this audit
  // refuses any re-introduction of the watch in production code.
  // Round 31: the audit is AST-based — it finds every `watch(...)` CALL
  // whose receiver is (transitively) the settings object: the direct names
  // `tuiSettings`/`settings` or a simple alias binding
  // (`const s = tuiSettings`), regardless of whitespace, optional chaining
  // or LINE BREAKS (a `.watch` split across lines cannot evade it).
  // Round 32: parenthesized receivers (`(tuiSettings).watch(...)`,
  // `const s = (settings)`) are unwrapped.
  // Comment mentions are not call sites and are ignored.
  const violations: string[] = []
  for (const path of listSourceFiles(srcDir)) {
    const file = relative(srcDir, path)
    const source = readFileSync(path, 'utf8')
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    // Simple alias bindings of the settings object: name → declaration.
    // Parenthesized initializers (`const s = (settings)`) are unwrapped.
    // Round 33: alias collection is a FIXED POINT — a chain
    // (`const a = tuiSettings; const b = a; b.watch(...)`) resolves
    // transitively (each pass adds aliases whose initializer names an
    // already-known settings alias, until no new names appear).
    const settingsAliases = new Set<string>()
    const unwrapParens = (expression: ts.Expression): ts.Expression => {
      let current = expression
      while (ts.isParenthesizedExpression(current)) current = current.expression
      return current
    }
    const aliasDeclarations: Array<{ name: string; initializerName: string }> = []
    const collectAliasDeclarations = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)
        && ts.isIdentifier(node.name)
        && node.initializer !== undefined) {
        const initializer = unwrapParens(node.initializer)
        if (ts.isIdentifier(initializer)) {
          aliasDeclarations.push({ name: node.name.text, initializerName: initializer.text })
        }
      }
      ts.forEachChild(node, collectAliasDeclarations)
    }
    collectAliasDeclarations(sourceFile)
    for (const declaration of aliasDeclarations) {
      if (declaration.initializerName === 'tuiSettings' || declaration.initializerName === 'settings') {
        settingsAliases.add(declaration.name)
      }
    }
    // Fixed point: repeat until no new alias resolves.
    let grew = true
    while (grew) {
      grew = false
      for (const declaration of aliasDeclarations) {
        if (settingsAliases.has(declaration.initializerName) && !settingsAliases.has(declaration.name)) {
          settingsAliases.add(declaration.name)
          grew = true
        }
      }
    }
    const findWatch = (node: ts.Node): ts.CallExpression | undefined => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        // `x.watch(...)` / `x?.watch(...)` — property-access callee named watch.
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'watch') {
          const receiver = unwrapParens(callee.expression)
          if (ts.isIdentifier(receiver)
            && (receiver.text === 'tuiSettings' || receiver.text === 'settings' || settingsAliases.has(receiver.text))) {
            return node
          }
        }
      }
      const found = ts.forEachChild(node, findWatch)
      return found === undefined ? undefined : found
    }
    const call = findWatch(sourceFile)
    if (call !== undefined) {
      const line = sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1
      violations.push(`${file}:${line}: ${call.getText().replace(/\s+/g, ' ').slice(0, 80)}`)
    }
  }
  assert.deepEqual(
    violations,
    [],
    'no settings watch callback in src/ — the config port is get/replace only; keybinding changes apply via the explicit /keybindings reload seam (migration rule: no callbacks across the wire)',
  )
})

test('the runner cleanup closure never references a later-declared binding (TDZ guard)', () => {
  // Lifecycle regression (review round 28): `cleanup()` is registered into
  // the Cordis effect BEFORE the app is constructed, so it can run while
  // later declarations are still in the temporal dead zone — a throwing
  // subscription registration at startup then turns the teardown into a
  // SECOND ReferenceError that masks the original failure and skips the
  // extension detach / diag dispose. Every runner-scope `let`/`const`
  // identifier the cleanup body touches must be declared BEFORE the
  // cleanup block. `stopKeybindingWatch` (removed — the settings watch is
  // gone), `stopPluginKeybindingSync` and `catalogCoordinator` were the
  // offenders; this audit keeps the whole class out.
  //
  // Round 30: the audit is AST-based (typescript's compiler API), so it
  // handles destructuring (`const { x } = y`, `const [x] = y`), same-line
  // nested blocks and nested closures precisely — no regex/brace-depth
  // approximation.
  const source = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  const sourceFile = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // Find the startup lifecycle root's async IIFE:
  // `void (async () => { ... })().catch(...)` — a void expression nested
  // inside the apply function. Round 31: NOT simply the first void
  // statement — the lifecycle root is uniquely identified as the void
  // statement whose arrow body declares `cleanup` (an earlier unrelated
  // void expression must not hijack the anchor).
  const candidates: ts.ExpressionStatement[] = []
  const findVoidStatements = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression)) candidates.push(node)
    ts.forEachChild(node, findVoidStatements)
  }
  findVoidStatements(sourceFile)
  const arrowOf = (statement: ts.ExpressionStatement): ts.ArrowFunction | undefined => {
    let found: ts.ArrowFunction | undefined
    const walk = (node: ts.Node): void => {
      if (found !== undefined) return
      if (ts.isArrowFunction(node)) {
        found = node
        return
      }
      ts.forEachChild(node, walk)
    }
    walk(statement.expression)
    return found
  }
  const hasCleanup = (block: ts.Block): boolean =>
    block.statements.some(statement =>
      ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name) && declaration.name.text === 'cleanup'))
  const lifecycleRoot = candidates.find(statement => {
    const arrow = arrowOf(statement)
    return arrow !== undefined && ts.isBlock(arrow.body) && hasCleanup(arrow.body)
  })
  assert.ok(lifecycleRoot !== undefined, 'the startup lifecycle root IIFE (the void expression whose arrow declares cleanup) must exist')
  const arrow = arrowOf(lifecycleRoot)!
  const runnerBlock = arrow.body
  assert.ok(ts.isBlock(runnerBlock), 'the lifecycle root body must be a block')

  // Collect runner-scope `let`/`const` declarations (the arrow body's direct
  // children): name → declaration line (1-based).
  const runnerDecls = new Map<string, number>()
  /** Collect every bound name of a binding pattern (simple identifier,
   * object/array destructuring, nested patterns incl. aliases). */
  const boundNames = (pattern: ts.BindingName, out: string[]): void => {
    if (ts.isIdentifier(pattern)) {
      out.push(pattern.text)
      return
    }
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) continue
      if (ts.isBindingElement(element)) boundNames(element.name, out)
      else boundNames(element, out)
    }
  }
  for (const statement of runnerBlock.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const flags = statement.declarationList.flags
    if (!(flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) continue
    const names: string[] = []
    for (const declaration of statement.declarationList.declarations) {
      boundNames(declaration.name, names)
    }
    const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1
    for (const name of names) {
      if (!runnerDecls.has(name)) runnerDecls.set(name, line)
    }
  }

  // The cleanup function declaration (runner-scope).
  const cleanupDecl = runnerBlock.statements.find(statement =>
    ts.isVariableStatement(statement)
    && ts.isIdentifier(statement.declarationList.declarations[0]!.name)
    && statement.declarationList.declarations[0]!.name.text === 'cleanup'
  ) as ts.VariableStatement | undefined
  assert.ok(cleanupDecl !== undefined, 'cleanup must exist in the runner scope')
  const cleanupInitializer = cleanupDecl.declarationList.declarations[0]!.initializer
  assert.ok(cleanupInitializer !== undefined && ts.isArrowFunction(cleanupInitializer), 'cleanup must be an arrow function')
  const cleanupBody = cleanupInitializer.body
  assert.ok(ts.isBlock(cleanupBody), 'cleanup body must be a block')
  const cleanupLine = sourceFile.getLineAndCharacterOfPosition(cleanupDecl.getStart()).line + 1

  // Collect the identifiers referenced in the cleanup body (excluding its
  // own local declarations — e.g. the `for (const file of ...)` loop var).
  const skip = new Set<string>()
  const referenced = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const names: string[] = []
      boundNames(node.name, names)
      for (const name of names) skip.add(name)
    }
    if (ts.isIdentifier(node)) {
      // Only bare identifiers (not property names / member names) count.
      const parent = node.parent
      const isPropertyName = parent !== undefined && (
        (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isShorthandPropertyAssignment(parent) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
        || (ts.isParameter(parent) && parent.name === node)
        || (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent))
      )
      if (!isPropertyName) referenced.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(cleanupBody)
  for (const name of [...referenced]) if (skip.has(name)) referenced.delete(name)

  const violations: string[] = []
  for (const name of referenced) {
    const declLine = runnerDecls.get(name)
    if (declLine === undefined) continue
    if (declLine > cleanupLine) {
      violations.push(`${name} (runner-scope declaration at line ${declLine}) referenced by cleanup (line ${cleanupLine}) — TDZ ReferenceError on early teardown`)
    }
  }
  assert.deepEqual(
    violations,
    [],
    'cleanup must only reference runner-scope bindings declared BEFORE it — a binding declared later is a TDZ ReferenceError when cleanup runs early (effect teardown / startup failure / exit)',
  )
})
