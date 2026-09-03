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

test('the restored fullscreen startup path initializes custom-item persistence before its callback can run', () => {
  const source = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  const helper = source.indexOf('const userFooterCustomItemsForSave =')
  const fullscreenBoot = source.indexOf("if (tuiSettings?.get().fullscreen === 'on') app.setFullscreen(true)")
  assert.ok(helper >= 0, 'the custom-item save projection must exist')
  assert.ok(fullscreenBoot >= 0, 'the restored fullscreen startup path must exist')
  assert.ok(helper < fullscreenBoot,
    'fullscreen startup can synchronously invoke its persistence callback; the custom-item save projection must be initialized first')
})

test('legacy history cleanup preserves the raw USER custom-item field', () => {
  // The migration cleanup is another whole-document replace. Keep this
  // source-level guard beside the startup-order guard: omitting the raw USER
  // projection here would promote a merged/project footerCustomItems value or
  // erase unknown/future definitions while deleting legacy history.
  const source = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  const start = source.indexOf("runDetached('settings history cleanup'")
  const end = source.indexOf("          }, {", start)
  assert.ok(start >= 0, 'the legacy history cleanup write must exist')
  assert.ok(end > start, 'the legacy history cleanup write must have options')
  const cleanup = source.slice(start, end)
  assert.match(cleanup, /doc\.footerCustomItems\s*=\s*userFooterCustomItemsForSave\(\)/,
    'history cleanup must project the exact raw USER custom definitions before replace')
  assert.match(cleanup, /delete doc\.history/, 'history cleanup must still remove the legacy field')

  // Pin the ownership outcome represented by the production projection above:
  // a merged project value is replaced by the raw USER value, including an
  // entry this version intentionally cannot parse.
  const userRaw = [
    { schemaVersion: 1, id: 'user:known', kind: 'text', text: 'USER' },
    { schemaVersion: 1, id: 'user:future', kind: 'future-kind', command: 'date' },
  ]
  const merged = { footerCustomItems: [{ schemaVersion: 1, id: 'user:project', kind: 'text', text: 'PROJECT' }], history: { '/ws': ['old'] } }
  const projected: { footerCustomItems: unknown; history?: unknown } = { ...merged, footerCustomItems: userRaw }
  delete projected.history
  assert.deepEqual(projected.footerCustomItems, userRaw,
    'the cleanup projection must retain raw USER data rather than merged project data')
})

test('startup-eager callbacks of startProcessTui never reference a later-declared binding (TDZ guard)', () => {
  // Lifecycle regression (the footer-command startup ReferenceError):
  // `onTerminalResize` is invoked SYNCHRONOUSLY from TuiApp's render path —
  // the first syncSurfaceGeometry fires it (lastCommandWidth starts at 0),
  // and a first render IS reachable during startup before the runner body
  // finished (a keybinding rebuild's onInvalidate → requestRender lands
  // there). A callback referencing a runner-scope binding declared AFTER
  // the startProcessTui call then reads the temporal dead zone, and the
  // surrounding fail-soft catch (the keybinding startup apply) misreported
  // the ReferenceError as a keybinding configuration failure. Unlike the
  // cleanup audit above, this class is keyed on an EXPLICIT eager set:
  // input-time callbacks (onSubmit, onDequeue, pluginActionFor, …) and
  // user-action callbacks (onClipboardPaste, onFullscreenChange)
  // legitimately capture later-declared bindings (draftImages,
  // openTasksBrowser, refreshQueue, …) — add a property here ONLY when
  // TuiApp can fire it from its own startup-capable synchronous paths.
  // Non-function property values are eagerly EVALUATED during the call
  // itself, so they must never reference a later-declared binding either.
  const source = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  const sourceFile = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // The lifecycle root IIFE (same anchor as the cleanup audit above):
  // the void expression whose arrow body declares `cleanup`. Only
  // bindings in THAT scope are the runner-scope slots this audit speaks
  // about.
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
  const runnerBlock = arrowOf(lifecycleRoot)!.body as ts.Block

  /** Collect every bound name of a binding pattern. */
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
  const runnerDecls = new Map<string, number>()
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

  // The single startProcessTui call inside the lifecycle root and its
  // object-literal arguments (the options object). Scoped to the runner
  // block: the audit speaks about RUNNER-scope bindings only.
  let appCall: ts.CallExpression | undefined
  const findCall = (node: ts.Node): void => {
    if (appCall !== undefined) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'startProcessTui') {
      appCall = node
      return
    }
    ts.forEachChild(node, findCall)
  }
  findCall(runnerBlock)
  assert.ok(appCall !== undefined, 'the startProcessTui call must exist in the runner scope')
  const callLine = sourceFile.getLineAndCharacterOfPosition(appCall.getStart()).line + 1
  const objectArgs = appCall.arguments.filter(argument => ts.isObjectLiteralExpression(argument))
  assert.ok(objectArgs.length > 0, 'startProcessTui must receive its options as object-literal arguments')

  /** Callbacks TuiApp can invoke SYNCHRONOUSLY from its own
   * startup-capable paths: the requestRender → syncSurfaceGeometry chain
   * fires onTerminalResize (the first geometry sync always does —
   * lastCommandWidth starts at 0), and a first render is reachable during
   * startup (keybinding rebuild invalidate). A new entry needs the same
   * proof — never input-time or user-action-time callbacks. */
  const STARTUP_EAGER = new Set(['onTerminalResize'])

  const isFunctionValue = (node: ts.Expression): boolean =>
    ts.isArrowFunction(node) || ts.isFunctionExpression(node)

  /** Bare identifiers under root (property names, imports and the root's
   * local declarations excluded). Scope-aware: a binding declared in a
   * nested block shadows outer references to the same name only within
   * that block (the previous flat `locals` set suppressed REAL outer
   * references whenever any nested block declared the same name).
   *
   * eagerBody=true means the ROOT itself is evaluated during the startup
   * window (an eager callback's body, a spread expression, a plain value),
   * so the root's own body — when it is a function — is an eager read.
   * NESTED function bodies are lazy capture scopes everywhere: a callback
   * only runs later, EXCEPT an immediately-invoked function (`fn()` /
   * `(fn)()`), whose body runs synchronously right here and is an eager
   * read too. eagerBody=false (a lazily-evaluated plain value) makes every
   * nested function lazy regardless. */
  const collectRefs = (root: ts.Node, eagerBody: boolean): Set<string> => {
    const refs = new Set<string>()
    const scopeStack: Set<string>[] = [new Set()]
    const currentScope = (): Set<string> => scopeStack[scopeStack.length - 1]!
    const isIIFE = (fn: ts.Node): boolean => {
      const parent = fn.parent
      if (parent === undefined) return false
      if (ts.isCallExpression(parent) && parent.expression === fn) return true
      if (ts.isParenthesizedExpression(parent) && parent.parent !== undefined
        && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return true
      return false
    }
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        const names: string[] = []
        boundNames(node.name, names)
        for (const name of names) currentScope().add(name)
      }
      if (node !== root && ts.isFunctionLike(node) && (!eagerBody || !isIIFE(node))) return
      // Enter a new scope for blocks and function-like nodes (their
      // parameters and declarations shadow outer names inside).
      const entersScope = !ts.isSourceFile(node) && (
        ts.isBlock(node) || ts.isFunctionLike(node)
      )
      if (entersScope) scopeStack.push(new Set())
      if (ts.isIdentifier(node)) {
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
        if (!isPropertyName && !scopeStack.some(scope => scope.has(node.text))) refs.add(node.text)
      }
      ts.forEachChild(node, visit)
      if (entersScope) scopeStack.pop()
    }
    visit(root)
    return refs
  }

  // Regression fixtures for the collectRefs semantics (review round 2):
  // the eager/lazy boundary must not drift when the audit is touched.
  const fixtureRefs = (fragment: string, eagerBody: boolean): Set<string> => {
    const fixture = ts.createSourceFile('fixture.ts', fragment, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    return collectRefs((fixture.statements[0] as ts.ExpressionStatement).expression, eagerBody)
  }
  assert.deepEqual(
    [...fixtureRefs('() => setTimeout(() => later(), 0)', true)],
    ['setTimeout'],
    'an eager body reports its own direct references but not a nested (non-IIFE) callback\'s — later must stay unreported',
  )
  assert.ok(
    fixtureRefs('(() => later())()', true).has('later'),
    'an immediately-invoked function inside an eager body runs synchronously — its references MUST be reported',
  )
  assert.ok(
    fixtureRefs('makeOptions(later)', true).has('later'),
    'a non-identifier spread expression is eagerly evaluated — its references MUST be reported',
  )
  assert.ok(
    fixtureRefs('later.value', true).has('later'),
    'a member-access spread expression is eagerly evaluated — its base reference MUST be reported',
  )
  assert.ok(
    fixtureRefs('({ value: later })', true).has('later'),
    'an object-literal spread expression is eagerly evaluated — its inner references MUST be reported',
  )
  assert.deepEqual(
    [...fixtureRefs('makeOptions(() => later())', false)],
    ['makeOptions'],
    'a lazily-evaluated value reports its own references but not the nested function body\'s',
  )

  const violations: string[] = []
  for (const objectArg of objectArgs) {
    for (const property of objectArg.properties) {
      // Shorthand `{ slot }` is an EAGER read of `slot` at object-creation
      // time (it desugars to `slot: slot`) — audit it like a plain value.
      if (ts.isShorthandPropertyAssignment(property)) {
        const ref = property.name.text
        const declLine = runnerDecls.get(ref)
        if (declLine !== undefined && declLine > callLine) {
          violations.push(
            `${ref} → ${ref} (declared at line ${declLine}) captured by the startProcessTui arguments (call at line ${callLine})`
              + ' — TDZ ReferenceError when the callback/value fires before the declaration runs; hoist the declaration (see the footerCommandRunner slots)',
          )
        }
        continue
      }
      // A spread `{ ...expr }` eagerly evaluates `expr` at object-creation
      // time. (No spread is currently present in the options object; the
      // rule is defensive — a future spread of a later-declared slot must
      // not silently slip past.) The whole expression is audited — a bare
      // identifier, a call (`...makeOptions(later)`), a member access
      // (`...later.value`) or an object literal (`...{ value: later }`)
      // all read eagerly; nested lazy callbacks inside are still skipped.
      if (ts.isSpreadAssignment(property)) {
        for (const ref of collectRefs(property.expression, true)) {
          const declLine = runnerDecls.get(ref)
          if (declLine !== undefined && declLine > callLine) {
            violations.push(
              `…${ref} (declared at line ${declLine}) spread into the startProcessTui arguments (call at line ${callLine})`
                + ' — TDZ ReferenceError when the callback/value fires before the declaration runs; hoist the declaration (see the footerCommandRunner slots)',
            )
          }
        }
        continue
      }
      if (!ts.isPropertyAssignment(property)) continue
      const name = ts.isIdentifier(property.name) ? property.name.text : '?'
      const eagerCallback = STARTUP_EAGER.has(name)
      // A function-valued property OUTSIDE the eager set is a lazy
      // capture scope (input/user-action time) — exempt. Everything else
      // (eager-set callbacks, plain values, nested objects) runs during
      // the startup window.
      if (!eagerCallback && isFunctionValue(property.initializer)) continue
      for (const ref of collectRefs(property.initializer, eagerCallback)) {
        const declLine = runnerDecls.get(ref)
        if (declLine === undefined || declLine <= callLine) continue
        violations.push(
          `${name} → ${ref} (declared at line ${declLine}) captured by the startProcessTui arguments (call at line ${callLine})`
            + ' — TDZ ReferenceError when the callback/value fires before the declaration runs; hoist the declaration (see the footerCommandRunner slots)',
        )
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'startup-eager callbacks and eagerly-evaluated values in the startProcessTui arguments must only reference runner-scope bindings declared BEFORE the call — a later declaration is a TDZ ReferenceError during startup',
  )
})

test('steerNow calls the empty-Ctrl+S gate BEFORE any runOwned/ensureSession work (deferred-start no-creation contract)', () => {
  // The original bug (plan §6.2): a fresh start + empty Ctrl+S used to be
  // able to create the session inside ensureSession() before the emptiness
  // was noticed. The gate (steerHasPayload) must be evaluated — and return
  // early — BEFORE runOwned('steer') and BEFORE ensureSession can run.
  // This audit pins the ORDER: someone moving the gate below the owned
  // workflow (or in front of the payload computation) breaks the deferred
  // no-creation contract even if every behavior test still passes.
  const source = readFileSync(join(srcDir, 'index.ts'), 'utf8')
  const sourceFile = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // Locate the steerNow arrow function BY DECLARATION NAME: the runner
  // scope declares `const steerNow = (text, onlyDraft, persistHistory)
  // => { ... }` — the only arrow named steerNow.
  let steerNow: ts.ArrowFunction | undefined
  const findSteerNow = (node: ts.Node): void => {
    if (steerNow !== undefined) return
    if (ts.isVariableDeclaration(node)
      && node.name.getText(sourceFile) === 'steerNow'
      && node.initializer !== undefined
      && ts.isArrowFunction(node.initializer)) {
      steerNow = node.initializer
      return
    }
    ts.forEachChild(node, findSteerNow)
  }
  findSteerNow(sourceFile)
  assert.ok(steerNow !== undefined, 'the steerNow arrow must exist in the runner')
  const body = steerNow.body as ts.Block

  const gateLine = body.statements.findIndex(statement => statement.getText(sourceFile).includes('steerHasPayload'))
  const ownedLine = body.statements.findIndex(statement => statement.getText(sourceFile).includes("runOwned('steer'"))
  const ensureLine = body.statements.findIndex(statement => statement.getText(sourceFile).includes('ensureSession'))
  assert.ok(gateLine !== -1, 'the steerHasPayload gate must be a direct statement in steerNow')
  // The gate must run before the owned workflow starts (a reorder that
  // puts runOwned/ensureSession first would allow session creation).
  assert.ok(gateLine !== -1 && (ownedLine === -1 || gateLine < ownedLine),
    'the empty-Ctrl+S gate must run BEFORE runOwned(\'steer\') — a fresh empty Ctrl+S must never create the session')
  assert.ok(gateLine !== -1 && (ensureLine === -1 || gateLine < ensureLine),
    'the empty-Ctrl+S gate must run BEFORE ensureSession — the gate is the deferred-start no-creation contract')
})

test('the host editor consumes the X044 protected autocomplete seam directly (no private casts)', () => {
  // X044's whole point is COMPILE-TIME compatibility protection: the
  // vendored Editor's requestAutocomplete/cancelAutocomplete are protected
  // and the host subclass must call them directly. A regression to
  // `as unknown as AutocompleteInternals` casts would silently survive
  // upstream signature changes and explode at runtime — the exact class
  // of breakage the re-vendor gates exist to prevent.
  const path = join(srcDir, 'tui-editor.ts')
  const source = readFileSync(path, 'utf8')
  assert.ok(!source.includes('AutocompleteInternals'),
    'the AutocompleteInternals cast interface must not exist — the host calls the protected seam directly')
  // Narrow on the CAST IDIOM only: an unrelated, legitimate `as unknown
  // as` in this file (a future compat seam) must not trip the X044 gate.
  assert.ok(!source.includes('as unknown as AutocompleteInternals'),
    'tui-editor.ts must not cast to reach editor internals (X044)')
})
