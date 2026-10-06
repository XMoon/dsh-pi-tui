import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { compositionFile, compositionSources, compositionSourcesUnder } from './support/composition-surface.ts'
import { aliasAwareConstructionSites, ownerFile, ownerSource, productionScriptKind, productionSource, productionSources, unwrapExpression } from './support/owner-modules.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

/** This repository root. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A5b bootstrap-closure locks (plan A5b §2.2, §7.6.2, §8.2).
 *
 * A5a moved the application body out of the package entry into
 * `src/app/bootstrap.ts`, but bootstrap is still the implementation site of the
 * application handler groups (plan §0). A5b's single purpose is that it stops
 * being: `src/app/bootstrap.ts` must reduce to resolve → construct → bind →
 * connect → start → dispose/fatal cleanup (plan §2.1).
 *
 * The final A5 state forbids the handler groups and implementation literals
 * below from being DEFINED in the composition layer (plan §7.6.2). Every A5b
 * slice has landed and the per-slice ledger was retired together with the A5b
 * root matrix, so the lock is permanent and ZONE-wide (TS2): a forbidden name
 * must be absent from `src/app/bootstrap.ts` AND from every
 * `src/app/bootstrap/**` helper at any depth, and the package entry never
 * defines any of them.
 *
 * Plan §8.2's minimum closure list and where each clause is locked:
 *   1. the composition zone exists — one facade plus its helpers —
 *      "the composition zone is one facade plus its bootstrap helpers" below;
 *   2. `src/index.ts` remains a facade —
 *      "the package entry is a facade and defines no application handler";
 *   3. forbidden handler definitions absent — the two ledger tests below;
 *   4. no `TuiAppEvents` implementation literal —
 *      "the composition root implements no TuiAppEvents/TuiCommandRunner
 *      literal" (root) + "exactly one TuiAppEvents implementation" (owner);
 *   5. no `TuiCommandRunner` implementation literal — the same two locks;
 *   6. no universal carrier/bag —
 *      "no universal application/runtime dependency bag exists" +
 *      "the composition root introduces no new context/bag type";
 *   7. each extracted owner constructed/bound once — the
 *      `OWNER_CONSTRUCTIONS` lock here plus the inventory test's
 *      `SINGLE_OWNER_SITES` authority/binding rows.
 *
 * No LOC threshold: A5b is complete when every remaining statement is
 * composition/startup/disposal, not when bootstrap falls below a line count
 * (plan §7.6.5).
 */

/**
 * Plan §7.6.2: definitions that must not exist anywhere in the composition
 * layer. This list is durable — it does not shrink as slices land, and TS2 made
 * it ZONE-wide: `src/app/bootstrap/**` is now a legal home for composition code,
 * so "absent from bootstrap" can no longer mean "absent from `bootstrap.ts`".
 */
const FINAL_FORBIDDEN_HANDLERS: readonly string[] = [
  'runLocalShell',
  'dispatchViaSession',
  'runLocalCommand',
  'steerNow',
  'dispatchUserInput',
  'enterView',
  'exitView',
  'surfaceEvents',
  'applyFooterSettings',
  'initLiveSession',
  'registerCommands',
  'openRewindPicker',
  'refreshStatusCheap',
  // Plan §7.6.2, second list: implementation literals, not just functions.
  'runner', // the TuiCommandRunner literal
]

/**
 * The whole bootstrap composition ZONE under one repository root: the facade
 * plus every `src/app/bootstrap/**` helper, at any depth.
 *
 * The "this must not exist in the composition layer" locks read the ZONE, not
 * just the facade (TS2 §17/§20): the retired A5b root matrix used to re-see every
 * bootstrap declaration, and with it gone a new helper could otherwise
 * reintroduce an application handler, an extracted owner's state or an
 * application-owner mutable-state category with every lock still green. The
 * locks that genuinely belong to the FACADE alone (`applyRunner`, the owner
 * constructions, the exact connectors) keep reading `compositionFile`/
 * `compositionSource` directly.
 */
function bootstrapZoneUnder(root: string): string {
  return compositionSourcesUnder(root)
    .filter(({ rel }) => rel === 'src/app/bootstrap.ts' || rel.startsWith('src/app/bootstrap/'))
    .map(({ rel, source }) => `// >>> ${rel}\n${source}`)
    .join('\n')
}

/** {@link bootstrapZoneUnder} bound to this repository root. */
function bootstrapZone(): string {
  return bootstrapZoneUnder(ROOT)
}

/** True when the two sources declare the same set of `let`/`const`/`function`/`class` names. */
function declares(source: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(source)
}

/**
 * Every forbidden handler must be absent from the WHOLE composition zone. The
 * transitional per-slice ledger is retired with the A5b root matrix: the A5b
 * slices have all landed (`MUST_MOVE` residual was 0), so this is now a
 * permanent, non-shrinking contract.
 */
function assertForbiddenHandlersAbsent(zone: string): void {
  for (const name of FINAL_FORBIDDEN_HANDLERS) {
    assert.equal(
      declares(zone, name),
      false,
      `${name} is implemented in the bootstrap composition zone — that handler belongs to its owner layer`,
    )
  }
}

/** No application-owner mutable-state CATEGORY may be declared in the zone. */
function assertOwnerStateCategoriesAbsent(
  zone: string,
  categories: ReadonlyArray<readonly [string, readonly string[]]>,
): void {
  for (const [category, names] of categories) {
    for (const name of names) {
      assert.equal(declares(zone, name), false,
        `the bootstrap composition zone must not declare ${name} (${category}, plan §7.6.2)`)
    }
  }
}

/**
 * The A5b-6 composition-side forbidden owner-state/retention slots (plan
 * §7.6.2/§17). These are NOT facade identity or legal-connector facts: the whole
 * composition layer must be free of them, so the assertion reads the ZONE —
 * a nested helper may not reintroduce them either. The corresponding POSITIVE
 * late-bound connector locks stay facade-scoped.
 */
function assertCompositionFreeOfOwnerState(
  zone: string,
  names: readonly string[],
  patterns: readonly RegExp[] = [],
): void {
  for (const name of names) {
    assert.equal(
      declares(zone, name),
      false,
      `the bootstrap composition zone must not declare ${name} (owner state, plan §17)`,
    )
  }
  for (const pattern of patterns) {
    assert.doesNotMatch(
      zone,
      pattern,
      `the bootstrap composition zone must not name ${String(pattern)} (owner state/policy, plan §17)`,
    )
  }
}

test('A5b: the composition zone is one facade plus its bootstrap helpers, and nothing else', () => {
  // Plan §8.2(1), restated durably by TS2. `compositionSources()` throws when a
  // listed file is missing, so this locks the EXISTENCE of the entry and the
  // facade; the zone is the ONLY place application composition may live, so no
  // second application composition root may appear anywhere else (the owners
  // consume narrow injected callbacks instead).
  const files = compositionSources().map(({ rel }) => rel)
  assert.equal(files[0], 'src/index.ts', 'the package entry is the first composition-surface file')
  assert.equal(files[1], 'src/app/bootstrap.ts', 'src/app/bootstrap.ts is the sole composition facade')
  for (const rel of files.slice(2)) {
    assert.ok(rel.startsWith('src/app/bootstrap/'),
      `src/app/bootstrap/** is the only composition-helper zone (${rel} is outside it)`)
  }
  // The zone is closed: the Cordis composition entries may be exported from the
  // facade ONLY, so a "bootstrap-like" root appearing elsewhere fails here even
  // before the architecture gate's dependency rules are consulted.
  for (const { rel, source } of productionSources()) {
    if (rel === 'src/app/bootstrap.ts') continue
    assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(?:applyRunner|applyRunnerWithRuntime)\b/u,
      `${rel} exports an application composition entry — the composition zone is src/app/bootstrap.ts + src/app/bootstrap/**`)
  }
})

test('A5b: no forbidden handler exists anywhere in the bootstrap composition zone', () => {
  // Permanent replacement for the retired per-slice ledger: every A5b slice has
  // landed, so the forbidden-handler contract no longer shrinks and no longer
  // needs a migration exemption list.
  const zone = bootstrapZone()
  assert.ok(zone.includes('src/app/bootstrap.ts'), 'the zone must contain the facade')
  assert.ok(zone.includes('src/app/bootstrap/lifecycle.ts'), 'the zone must contain the helpers')
  assertForbiddenHandlersAbsent(zone)
})

test('A5b/TS2: a forbidden handler reintroduced in a NESTED helper fails the zone lock (mutation)', (t) => {
  // The real consumer, on a fixture tree: a new helper at ANY depth that
  // redeclares a forbidden handler must fail, and the same fixture without it
  // must pass — otherwise "absent from the composition zone" would only be
  // covering the facade.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-zone-forbidden-')
  mkdirSync(join(root, 'src', 'app', 'bootstrap', 'nested'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const entry = 1\n')
  writeFileSync(join(root, 'src', 'app', 'bootstrap.ts'), 'export const bootstrap = 1\n')
  const nested = join(root, 'src', 'app', 'bootstrap', 'nested', 'legacy.ts')
  writeFileSync(nested, 'export const harmless = 1\n')
  assertForbiddenHandlersAbsent(bootstrapZoneUnder(root))
  writeFileSync(nested, 'const registerCommands = (): void => {}\nconst pendingSubmissions = []\n')
  const zone = bootstrapZoneUnder(root)
  assert.ok(declares(zone, 'registerCommands'), 'the fixture must actually reintroduce the name in the zone')
  assert.throws(() => assertForbiddenHandlersAbsent(zone),
    'a handler reintroduced in a NESTED bootstrap helper must fail the zone lock')
})

test('A5b: the package entry is a facade and defines no application handler', () => {
  const entry = compositionFile('src/index.ts')
  for (const name of FINAL_FORBIDDEN_HANDLERS) {
    assert.equal(declares(entry, name), false, `src/index.ts must not define ${name}`)
  }
})

test('A5b: no universal application/runtime dependency bag exists', () => {
  // Plan §6.3/§7.6.2: the escape hatch is a new EverythingBag type that carries
  // cross-domain state. It must not appear in the composition surface or in any
  // extracted owner.
  const source = ownerSource()
  for (const bag of ['BootstrapContext', 'AppContext', 'GlobalRuntime', 'EverythingBag', 'RunnerContext', 'SurfaceContext', 'CompositionContext', 'RuntimeContext', 'ApplicationContext']) {
    assert.equal(
      new RegExp(`\\b(?:interface|type|class)\\s+${bag}\\b`).test(source),
      false,
      `${bag} would be a universal dependency bag (plan A5b §6.3)`,
    )
  }
})

/** Every top-level `interface`/`type alias`/`class` name a module declares. */
function declaredTypeNames(source: string): string[] {
  const sf = ts.createSourceFile('module.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const names: string[] = []
  const walk = (node: ts.Node): void => {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      names.push(node.name.text)
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return names
}

test('A5b-6: the composition root introduces no new context/bag type', () => {
  // Plan §7.6.2: no new broad context/bag type carrying cross-domain state. The
  // only type the composition root has ever declared is the small pre-existing
  // `AppExit`; a new `type`/`interface`/`class` there is a bag by construction.
  const root = compositionFile('src/app/bootstrap.ts')
  assert.deepEqual(
    declaredTypeNames(root),
    ['AppExit'],
    'src/app/bootstrap.ts must declare no type/interface/class besides the pre-existing AppExit (plan §7.6.2: no new broad bag)',
  )
})

interface TuiAppEventsLiteral {
  readonly rel: string
  readonly name: string
  readonly line: number
  /** the initializer object literal spreads `...deps.events` (a pass-through) */
  readonly passesThroughDepsEvents: boolean
}

/** One object literal whose declared/asserted type is `typeName`. */
interface TypedObjectLiteral {
  readonly rel: string
  /** the declared variable name, or `<expression>` for an inline literal */
  readonly name: string
  readonly line: number
  readonly node: ts.ObjectLiteralExpression
}

/**
 * Every object literal typed as `typeName` ANYWHERE in `source`, via the
 * TypeScript parser: the type may travel on the variable declaration
 * (`const x: T = { ... }`) or on an `as` / `satisfies` / `<T>` wrapper around
 * the literal, wherever that literal appears — a call argument
 * (`register({ ... } satisfies T)`), a return statement
 * (`return { ... } as T`), a property assignment, or a variable initializer.
 *
 * Wrappers are unwrapped with the shared {@link unwrapExpression} contract, so
 * a rogue implementation can hide neither behind a parenthesized / non-null /
 * cast / satisfies wrapper nor in an inline (non-`VariableDeclaration`)
 * position. A plain substring count cannot tell the semantic implementation
 * from a NEW rogue literal in an unlisted module, and the previous scanner only
 * inspected `VariableDeclaration`s (plan §8.2(4)/§8.2(5)).
 *
 * Results are deduplicated by object-literal node (a literal reachable through
 * both its variable declaration and its wrapper is recorded once, under the
 * declared variable name).
 */
function typedObjectLiterals(rel: string, source: string, typeName: string): TypedObjectLiteral[] {
  // The parser kind follows the FILE (`.tsx` => TSX): every caller feeds this
  // from `productionSources()`, which scans all four production extensions, and
  // a legal JSX attribute/child holding a typed implementation literal is
  // invisible to a TS parse (TS2 §19).
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.ESNext, true, productionScriptKind(rel))
  // Local type aliases (`type Events = TuiAppEvents`, incl. chains, resolved to
  // convergence in source order) are followed; a CONTEXTUALLY typed literal (an
  // argument whose parameter is declared elsewhere as this type) has no syntactic
  // annotation here and is outside this guard's stated scope.
  const aliasNames = new Set<string>([typeName])
  let aliasesChanged = true
  while (aliasesChanged) {
    aliasesChanged = false
    const scanAliases = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)) {
        if (aliasNames.has(node.type.typeName.text) && !aliasNames.has(node.name.text)) {
          aliasNames.add(node.name.text)
          aliasesChanged = true
        }
      }
      ts.forEachChild(node, scanAliases)
    }
    scanAliases(sf)
  }
  const isType = (node: ts.TypeNode | undefined): boolean =>
    node !== undefined
    && ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && aliasNames.has(node.typeName.text)
  /** The return-type annotation of the function-like node enclosing `from`
   *  (functions, arrows, methods and get accessors). */
  const returnAnnotationOf = (from: ts.Node): ts.TypeNode | undefined => {
    let node: ts.Node | undefined = from
    while (node !== undefined) {
      if (
        ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node)
      ) return node.type
      node = node.parent
    }
    return undefined
  }
  const found = new Map<ts.ObjectLiteralExpression, TypedObjectLiteral>()
  const consider = (expr: ts.Expression, declaredName: string | undefined, annotation: ts.TypeNode | undefined): void => {
    let typed = isType(annotation)
    const inner = unwrapExpression(expr, (type) => {
      if (isType(type)) typed = true
    })
    if (!typed || !ts.isObjectLiteralExpression(inner)) return
    if (found.has(inner)) return
    found.set(inner, {
      rel,
      name: declaredName ?? '<expression>',
      line: sf.getLineAndCharacterOfPosition(inner.getStart(sf)).line + 1,
      node: inner,
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      consider(node.initializer, ts.isIdentifier(node.name) ? node.name.text : undefined, node.type)
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      consider(node.expression, undefined, returnAnnotationOf(node))
    }
    if (
      ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isParenthesizedExpression(node)
      || ts.isNonNullExpression(node)
    ) {
      consider(node, undefined, undefined)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return [...found.values()].sort((a, b) => a.line - b.line)
}

/** Every `TuiAppEvents` object literal in `source` (shared AST contract). */
function tuiAppEventsLiterals(rel: string, source: string): TuiAppEventsLiteral[] {
  return typedObjectLiterals(rel, source, 'TuiAppEvents').map(({ rel: file, name, line, node }) => ({
    rel: file,
    name,
    line,
    passesThroughDepsEvents: node.properties.some(
      property => ts.isSpreadAssignment(property) && property.expression.getText() === 'deps.events',
    ),
  }))
}

/** Every `TuiCommandRunner` object literal in `source` (plan §8.2(5)). */
function tuiCommandRunnerLiterals(rel: string, source: string): TypedObjectLiteral[] {
  return typedObjectLiterals(rel, source, 'TuiCommandRunner')
}

test('A5b: tuiAppEventsLiterals detects every TuiAppEvents literal form', () => {
  // A rogue implementation must not be able to hide behind an ordinary
  // expression wrapper, move its type annotation onto the wrapper, or sit in a
  // non-`VariableDeclaration` position (call argument, return, property).
  const positive: ReadonlyArray<readonly [string, string]> = [
    ['const rogue: TuiAppEvents = { onSubmit: () => {} }\n', 'rogue'],
    ['const rogue: TuiAppEvents = ({ onSubmit: () => {} })\n', 'rogue'],
    ['const rogue = ({ onSubmit: () => {} } satisfies TuiAppEvents)\n', 'rogue'],
    ['const rogue = ({ onSubmit: () => {} } as TuiAppEvents)\n', 'rogue'],
    ['const rogue = ({ onSubmit: () => {} } as TuiAppEvents)!\n', 'rogue'],
    ['const rogue = <TuiAppEvents>{ onSubmit: () => {} }\n', 'rogue'],
    ['register({ onSubmit: () => {} } satisfies TuiAppEvents)\n', '<expression>'],
    ['function make() { return { onSubmit: () => {} } as TuiAppEvents }\n', '<expression>'],
    ['const holder = { events: { onSubmit: () => {} } as TuiAppEvents }\n', '<expression>'],
  ]
  for (const [source, name] of positive) {
    assert.deepEqual(
      tuiAppEventsLiterals('synthetic.ts', source).map(literal => literal.name),
      [name],
      `${source.trim()} must be detected as a TuiAppEvents literal`,
    )
  }
  const negative: ReadonlyArray<string> = [
    'const ok = ({ onSubmit: () => {} } satisfies TuiCommandRunner)\n',
    'const ok: TuiCommandRunner = { onSubmit: () => {} }\n',
    'const ok = ({ onSubmit: () => {} })\n',
    'register({ onSubmit: () => {} })\n',
  ]
  for (const source of negative) {
    assert.deepEqual(
      tuiAppEventsLiterals('synthetic.ts', source),
      [],
      `${source.trim()} is not a TuiAppEvents literal`,
    )
  }
})

test('A5b/TS2: a typed implementation literal in a JSX attribute is caught (hard case, not a parser-kind copy)', () => {
  // Every caller of `typedObjectLiterals` feeds it from `productionSources()`,
  // which scans `.tsx` too. A legal JSX ATTRIBUTE position is invisible to a TS
  // parse, so a rogue `TuiAppEvents`/`TuiCommandRunner` literal could hide in a
  // `.tsx` production module and still satisfy "exactly one implementation".
  // Both halves are asserted, so the extension — not incidental recovery — is
  // what makes this pass.
  const eventsInAttribute = 'export const view = <Box value={{ onSubmit: () => {} } satisfies TuiAppEvents} />\n'
  assert.deepEqual(
    tuiAppEventsLiterals('probe.tsx', eventsInAttribute).map(literal => literal.name),
    ['<expression>'],
  )
  assert.deepEqual(tuiAppEventsLiterals('probe.ts', eventsInAttribute), [],
    'the same bytes parsed as TS must yield NO literal')

  const runnerInChild = 'export const view = <Box>{{ onSubmit: () => {} } satisfies TuiCommandRunner}</Box>\n'
  assert.equal(tuiCommandRunnerLiterals('probe.tsx', runnerInChild).length, 1)
  assert.deepEqual(tuiCommandRunnerLiterals('probe.ts', runnerInChild), [],
    'the same bytes parsed as TS must yield NO literal')

  // The `.ts` grammar is unchanged: angle-bracket assertions still work.
  assert.equal(tuiCommandRunnerLiterals('synthetic.ts', 'const rogue = <TuiCommandRunner>{ onSubmit: () => {} }\n').length, 1)
})

test('A5b: tuiCommandRunnerLiterals detects every TuiCommandRunner literal form', () => {
  const positive: ReadonlyArray<string> = [
    'const rogue: TuiCommandRunner = { onSubmit: () => {} }\n',
    'const rogue = ({ onSubmit: () => {} } satisfies TuiCommandRunner)\n',
    'const rogue = ({ onSubmit: () => {} } as TuiCommandRunner)\n',
    'const rogue = <TuiCommandRunner>{ onSubmit: () => {} }\n',
    'register({ onSubmit: () => {} } satisfies TuiCommandRunner)\n',
    'function make() { return { onSubmit: () => {} } as TuiCommandRunner }\n',
  ]
  for (const source of positive) {
    assert.equal(
      tuiCommandRunnerLiterals('synthetic.ts', source).length,
      1,
      `${source.trim()} must be detected as a TuiCommandRunner literal`,
    )
  }
  const negative: ReadonlyArray<string> = [
    'const ok: TuiAppEvents = { onSubmit: () => {} }\n',
    'const ok = ({ onSubmit: () => {} } satisfies TuiAppEvents)\n',
    'const ok = ({ onSubmit: () => {} })\n',
    'const ok: TuiCommandRunner[\'agents\'] = { onSubmit: () => {} }\n',
  ]
  for (const source of negative) {
    assert.deepEqual(
      tuiCommandRunnerLiterals('synthetic.ts', source),
      [],
      `${source.trim()} is not a TuiCommandRunner literal`,
    )
  }
})

test('A5b: exactly one TuiAppEvents SEMANTIC implementation, wrappers are pass-throughs', () => {
  // The A5b-5 cut moved the whole TuiAppEvents implementation into
  // `app/surface/application-events.ts` (the former `surfaceEvents` literal).
  // The surface runtime legitimately overlays a SECOND literal over
  // `deps.events` for the transcript-navigation/search callbacks it owns. This
  // is an AST scan over ALL production `src/**/*.ts` (not just the owner
  // surface): a NEW `const rogue: TuiAppEvents = { onSubmit: ... }` in any
  // module must fail, naming the file and variable (plan §8.2(4)/§7.6.2).
  const literals = productionSources().flatMap(({ rel, source }) => tuiAppEventsLiterals(rel, source))
  const semantic = literals.filter(
    literal => literal.rel === 'src/app/surface/application-events.ts' && literal.name === 'surfaceEvents',
  )
  assert.equal(
    semantic.length,
    1,
    'the TuiAppEvents semantic implementation must be `surfaceEvents` in src/app/surface/application-events.ts',
  )
  const wrappers = literals.filter(
    literal => literal.rel === 'src/app/surface/runtime.ts' && literal.name === 'events',
  )
  assert.equal(wrappers.length, 1, 'the surface runtime must overlay exactly one TuiAppEvents wrapper literal')
  assert.ok(
    wrappers[0]!.passesThroughDepsEvents,
    'the surface runtime literal must spread `...deps.events` (a pass-through wrapper, never a second implementation)',
  )
  const others = literals.filter(literal => literal !== semantic[0] && literal !== wrappers[0])
  assert.deepEqual(
    others.map(literal => `${literal.rel}:${literal.line} ${literal.name}`),
    [],
    'every other TuiAppEvents object literal is a second implementation (plan §8.2(4))',
  )
})

test('A5b: NO production module implements a typed TuiCommandRunner object literal', () => {
  // Plan §8.2(5)/§7.6.2: `TuiCommandRunner` is an interface, and the final A5
  // state has NO implementation literal for it — not in the composition root
  // and not anywhere else. The command owner builds the facade as the
  // fully type-checked `RunnerFacade<Selection, Id>`
  // (`app/command/surface.ts`, via `buildRunner`) and performs the ONE
  // documented generic→concrete bridge (`facade as unknown as TuiCommandRunner`).
  //
  // There is deliberately NO allowlist here: the current production tree has
  // ZERO typed `TuiCommandRunner` literals, and a future legitimate one would
  // have to come with its own explicit, documented lock rather than sliding
  // into this scan. The scan is the same whole-tree AST contract as the
  // `TuiAppEvents` lock, so `satisfies`/`as`/`<T>` and inline positions cannot
  // hide a second implementation.
  const literals = productionSources().flatMap(({ rel, source }) => tuiCommandRunnerLiterals(rel, source))
  assert.deepEqual(
    literals.map(literal => `${literal.rel}:${literal.line} ${literal.name}`),
    [],
    'no production module may implement TuiCommandRunner as an object literal (plan §8.2(5))',
  )
  // The allowed reality: the facade is the type-checked RunnerFacade, bridged
  // by the documented identity cast — never an object literal.
  const command = ownerFile('src/app/command/surface.ts')
  assert.match(command, /const facade: RunnerFacade<Selection, Id> = \{/u,
    'the command owner must build the TuiCommandRunner facade as the type-checked RunnerFacade')
  assert.match(command, /runnerFacade = facade as unknown as TuiCommandRunner/u,
    'the command owner must bridge the RunnerFacade to TuiCommandRunner with the documented cast')
})

/**
 * Extracted declarations and the module that must own them.
 *
 * The aggregate `ownerOccurrences()`/`ownerSource()` locks prove "exactly once
 * SOMEWHERE across the owner surface" — and that surface includes
 * `src/app/bootstrap.ts`, so a construction or state machine moving back into
 * the composition root would still satisfy the count. These rows pin the
 * ownership LOCATION per module (A5b-1 review P2): the named owner must declare
 * the symbol and the composition root must not.
 */
const EXTRACTED_DECLARATIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'src/app/surface/viewer-runtime.ts',
    [
      'viewing', 'setViewedQueueAgent', 'activePendingSessionId',
      'pendingSubagentCalls', 'viewCallToChild', 'viewerOpen', 'openingViewer',
      'viewerSessionAbort', 'enterView', 'exitView',
      'viewedChildPresentation', 'settleSubagentSubmit', 'subagentPromptNotice',
    ],
  ],
  [
    'src/app/command/artifacts.ts',
    ['artifactInFlight', 'ArtifactSaveFailure', 'localFileSource', 'saveArtifact', 'startArtifactSave'],
  ],
  [
    'src/app/command/surface.ts',
    [
      'catalogCoordinator', 'isSkillInvocation', 'commandsRegistered', 'wasAdvertisedClaim',
      'hostClaimOf', 'isSkillWrapperName', 'refreshCommandCompletions', 'withCommandDelivery',
      'takeCommandDraftDisposition', 'catalogRefreshRequest', 'skillsChangeSubscribed',
      'skillsChangeGate', 'subscribeSkillsChangeEvents', 'agentForLiveScope', 'attachmentForSession',
      'refreshLiveCatalog', 'registerCommands', 'runner',
    ],
  ],
  [
    'src/app/command/model-selection.ts',
    [
      'defaultIntent', 'setDefaultIntent', 'settleIntent', 'reconcileDefaultIntent', 'selected',
      'defaultWriteBarrier', 'trackDefaultWrite', 'awaitPendingDefaultWrite',
      'pendingModelSelection', 'setModelSelectionPending', 'currentModelSelectionMarker',
    ],
  ],
  [
    'src/app/surface/settings-runtime.ts',
    [
      'userFooterCustomItemsForSave', 'footerCommandRunner', 'footerCommandUnsubscribe',
      'footerDynamicItemRuntime', 'keybindings', 'applyUserKeybindings',
      'footerWarningShown', 'customFooterWarningShown', 'footerCommandItemWarningShown',
      'disableFooterCommand', 'applyFooterSettings', 'setDisplayPreset',
    ],
  ],
  [
    'src/app/surface/input-history.ts',
    ['knownHistoryCwdSet', 'rememberHistoryCwd', 'knownHistoryCwds', 'lastHistoryContent'],
  ],
  [
    'src/app/surface/status-runtime.ts',
    [
      'goalText', 'updateWelcomeCard', 'sessionCwd', 'refreshTerminalTitle', 'modelLabel',
      'deriveCompositionStatus', 'deriveWorkspaceStatus', 'deriveHostStatus', 'contextMeasurement',
      'markContextDirty', 'refreshStatusCheap', 'refreshContextMeasurement', 'forceContextMeasurement',
      'cancelDeferredContextMeasure', 'scheduleInitialContextMeasure',
    ],
  ],
  [
    'src/app/surface/session-presentation.ts',
    [
      'folder', 'windowController', 'statsFolder', 'mainStreamingToolPreviews',
      'mainPresentation', 'callArgs', 'resetForGeneration', 'initLiveSession',
      'TRANSCRIPT_WINDOW_TURNS', 'TRANSCRIPT_WINDOW_STEP', 'applyAssistantLiveInput',
      'mergeSessionEventCut',
    ],
  ],
  [
    'src/app/submission/controller.ts',
    [
      'localEcho', 'failSubmission', 'restoreSubmissionDraft', 'localSubmitAck',
      'submitLatencyTracker', 'pendingSubmissions', 'submissionPresentation',
      'acceptLocalSubmitAck', 'settleLocalSubmitAck', 'installLocalEcho',
      'settleLocalSubmission', 'notifySubmissionFailure', 'submitDeps',
      'submitSerialTail', 'takeSubmitTurn', 'dispatchViaSession', 'runLocalCommand',
      'steerNow', 'makeSteerPersist', 'dispatchUserInput', 'dequeue',
      // A5b-6: the writer SECTION moved from the composition root into the
      // submission owner (the sole writer/admission authority).
      'withWriterSection',
      // A5b-4 review fix: the submission-presentation policy the composition
      // root used to define (attachment refusal, command-submit attachment
      // expansion, local-echo placement) is controller-owned.
      'attachmentRefusal', 'commandSubmitAttachments', 'submissionPlacement',
    ],
  ],
  [
    'src/app/submission/user-shell.ts',
    ['shellController', 'interrupt', 'shellTempFiles', 'runUserShell'],
  ],
  [
    'src/app/surface/application-events.ts',
    ['surfaceEvents', 'openRewindPicker'],
  ],
  [
    'src/app/surface/client-actions.ts',
    ['runClipboardCommand', 'clipboardEnv', 'runCopyCommand', 'copyEnv', 'openExternalEditor'],
  ],
]

test('A5b: every extracted declaration lives in its named owner, never in the composition ZONE', () => {
  // TS2 §17/§20: the "must not return" half reads the WHOLE zone, so a helper —
  // at any depth — cannot take an extracted declaration back into the
  // composition layer. The owner-side half is unchanged.
  const zone = bootstrapZone()
  for (const [rel, names] of EXTRACTED_DECLARATIONS) {
    const owner = ownerFile(rel)
    for (const name of names) {
      assert.ok(declares(owner, name), `${name} must be declared in the owner ${rel}`)
      assert.equal(
        declares(zone, name),
        false,
        `the bootstrap composition zone must not declare ${name} — it belongs to ${rel}`,
      )
    }
  }
})

/** Each extracted owner's construction sits in the composition root exactly once. */
const OWNER_CONSTRUCTIONS: ReadonlyArray<readonly [string, string, string]> = [
  ['src/app/surface/status-runtime.ts', 'createStatusRuntime', 'createStatusRuntime('],
  ['src/app/surface/input-history.ts', 'createInputHistory', 'createInputHistory('],
  ['src/app/surface/settings-runtime.ts', 'createSettingsRuntime', 'createSettingsRuntime('],
  ['src/app/command/model-selection.ts', 'createModelSelectionOwner', 'createModelSelectionOwner<'],
  ['src/app/command/surface.ts', 'createCommandSurface', 'createCommandSurface<ModelSelection, SessionId, Agent>('],
  ['src/app/command/artifacts.ts', 'createArtifactSaveOwner', 'createArtifactSaveOwner<Agent>('],
  ['src/app/surface/session-presentation.ts', 'createSessionPresentation', 'createSessionPresentation<SessionEvent>('],
  ['src/app/surface/viewer-runtime.ts', 'createViewerRuntime', 'createViewerRuntime<SessionEvent>('],
  ['src/app/submission/controller.ts', 'createSubmissionController', 'createSubmissionController<Agent>('],
  ['src/app/submission/user-shell.ts', 'createUserShell', 'createUserShell<Agent>('],
  ['src/app/surface/application-events.ts', 'createApplicationEvents', 'createApplicationEvents('],
  ['src/app/surface/client-actions.ts', 'createClientActions', 'createClientActions('],
]

test('A5b: each extracted owner is constructed exactly once, from the composition root', () => {
  const root = compositionFile('src/app/bootstrap.ts')
  for (const [rel, factory, site] of OWNER_CONSTRUCTIONS) {
    assert.ok(
      new RegExp(`export function ${factory}(<|\\s*\\()`).test(ownerFile(rel)),
      `${rel} must export the ${factory} factory`,
    )
    assert.equal(root.split(site).length - 1, 1, `the composition root must construct ${factory} exactly once`)
  }
})

/**
 * The extracted-owner factories and their SINGLE production call site.
 *
 * The lock is over AST `CallExpression` callees, never over source spellings:
 * these factories infer their generics from `deps`, so `createViewerRuntime(deps)`
 * is as valid as `createViewerRuntime<SessionEvent, Agent>(deps)` and a
 * spelling-based scan silently misses the former (A5b-7 review P2). A factory
 * DECLARATION is not a call, so no declaration bookkeeping is needed either.
 */
const OWNER_FACTORY_NAMES: readonly string[] = [
  'createStatusRuntime',
  'createInputHistory',
  'createSettingsRuntime',
  'createModelSelectionOwner',
  'createCommandSurface',
  'createArtifactSaveOwner',
  'createSessionPresentation',
  'createViewerRuntime',
  'createSubmissionController',
  'createUserShell',
  'createApplicationEvents',
  'createClientActions',
]

/** Delegates to the shared alias-aware construction-site helper so the wrapper
 *  and alias scope has ONE definition (`test/support/owner-modules.ts`). */
const factoryCallSites = (name: string): string[] => aliasAwareConstructionSites(name)

test('A5b: every extracted-owner factory is called exactly once, from the composition root', () => {
  // The per-module location lock above reads the hand-listed root only, so a
  // second, type-correct construction added in ANY other production file leaves
  // the root count at 1 and is invisible to it. This repo-wide companion (plan
  // A5b §8.1/§8.3) counts SEMANTIC call sites: an inferred-generic call, an
  // explicit-generic call and a parenthesized callee are the same fact.
  assert.deepEqual(
    [...OWNER_FACTORY_NAMES].sort(),
    [...new Set(OWNER_CONSTRUCTIONS.map(([, factory]) => factory))].sort(),
    'OWNER_FACTORY_NAMES must cover exactly the extracted owners',
  )
  for (const name of OWNER_FACTORY_NAMES) {
    assert.deepEqual(
      factoryCallSites(name),
      ['src/app/bootstrap.ts'],
      `${name} must be called exactly once, from src/app/bootstrap.ts, across production src/** (AST call sites, never spellings)`,
    )
  }
})

/**
 * Owner-internal presentation constructors and the modules that must hold them.
 *
 * `SINGLE_OWNER_SITES` in the A5 composition inventory counts across the whole
 * owner surface (which includes the composition root), so moving one of these
 * back into bootstrap would keep the aggregate count green (A5b-1 review P2).
 * These rows pin the concrete module set.
 */
const EXTRACTED_CONSTRUCTIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['src/app/surface/session-presentation.ts', ['new TranscriptFolder(', 'new StatsFolder(', 'new TranscriptWindowController(']],
  ['src/app/surface/viewer-runtime.ts', ['new TranscriptFolder(', 'new StatsFolder(', 'new TranscriptWindowController(']],
]

test('A5b: the moved presentation constructors live in their owners, not in the composition root', () => {
  const root = compositionFile('src/app/bootstrap.ts')
  for (const [rel, sites] of EXTRACTED_CONSTRUCTIONS) {
    const owner = ownerFile(rel)
    for (const site of sites) {
      assert.ok(owner.includes(site), `${rel} must construct ${site}`)
      assert.equal(
        root.includes(site),
        false,
        `src/app/bootstrap.ts must not construct ${site} — its owner is ${rel}`,
      )
    }
  }
})

test('A5b-2: the settings owner consumes narrow surface/config capabilities', () => {
  // A5b-2 review P2: taking the whole `SurfaceRuntime` and `Backend` would hand
  // the owner a large set of unrelated capabilities. It declares exactly the app
  // + status-store surface and the config slice it uses.
  const owner = ownerFile('src/app/surface/settings-runtime.ts')
  assert.ok(owner.includes('export interface SettingsSurface'),
    'the settings owner must declare its narrow surface capability')
  assert.ok(owner.includes('export interface SettingsConfigPort'),
    'the settings owner must declare its narrow config capability')
  assert.ok(!/readonly\s+surface:\s*SurfaceRuntime</u.test(owner),
    'the settings owner must not depend on the whole surface owner')
  assert.ok(!/readonly\s+backend:\s*Backend\b/u.test(owner),
    'the settings owner must not depend on the whole backend port')
})

test('A5b-5: the persisted busy-Enter preference is read from the settings owner', () => {
  // Review note: this is a persisted TUI input preference, not a lifecycle or
  // identity fact, so it must not travel in the event adapter's lifecycle group.
  const events = ownerFile('src/app/surface/application-events.ts')
  const lifecycleAt = events.indexOf('export interface ApplicationEventsLifecycle')
  assert.ok(lifecycleAt > 0, 'the application-events owner must declare its lifecycle group')
  const lifecycleBody = events.slice(lifecycleAt, events.indexOf('\n}', lifecycleAt))
  assert.doesNotMatch(lifecycleBody, /busyEnter/u,
    'the lifecycle group must not carry the persisted busy-Enter preference')
  assert.match(events, /deps\.settings\.busyEnter\(\)/u,
    'the event adapter must read the preference from the settings owner')
  const settings = ownerFile('src/app/surface/settings-runtime.ts')
  assert.match(settings, /busyEnter\(\): string \| undefined/u,
    'the settings owner must expose the persisted busy-Enter preference')
})

test('A5b-4: only the owner that is asked to consume the draft clears the editor', () => {
  // TuiApp's own Ctrl+S path clears + notifies the editor seat BEFORE calling
  // `onSteer`, so the controller must not clear a second time there (a duplicate
  // synchronous notify/revision). The surface `steer-draft` action instead hands
  // the still-present draft over and asks the owner to consume it.
  const owner = ownerFile('src/app/submission/controller.ts')
  assert.equal(owner.split("deps.app().setDraft('')").length - 1, 1,
    'the submission owner must CLEAR the editor in exactly ONE place')
  assert.match(owner, /if \(options\?\.consumeDraft === true\) deps\.app\(\)\.setDraft\(''\)/u,
    'the single clear must be guarded by the explicit consumeDraft request')
  // A5b-5 moved the event adapter (and its two steer seams) into its owner.
  const events = ownerFile('src/app/surface/application-events.ts')
  assert.equal(events.split('submission.steer(').length - 1, 2,
    'exactly two production steer call sites must exist in the event owner (one consume-draft, one already-consumed)')
  assert.match(events, /submission\.steer\(deps\.surface\.app\.getDraft\(\), \{ consumeDraft: true \}\)/u,
    'the steer-draft action must ask the owner to consume the still-present draft')
  const onSteer = events.slice(events.indexOf('onSteer: (text) =>'), events.indexOf('onSteer: (text) =>') + 900)
  assert.match(onSteer, /submission\.steer\(text\)/u,
    'the TuiApp onSteer seam must NOT ask for a second consume (the caller already cleared)')
  assert.doesNotMatch(onSteer, /consumeDraft/u,
    'the TuiApp onSteer seam must not pass consumeDraft')
})

test('A5b-3: the command runtime application binding is command-owned', () => {
  // Plan §A5b-3 "Move together" lists `commandRuntime = bindCommandRuntime(...)`:
  // the binding must not stay in the composition root, and the root must reach
  // it only through the owner's single wiring step.
  const root = compositionFile('src/app/bootstrap.ts')
  assert.doesNotMatch(root, /bindCommandRuntime\(/u,
    'the composition root must not bind the semantic command runtime itself')
  assert.match(root, /command\.attachRuntime\(\)/u,
    'the composition root must trigger the command-owned wiring step')
  assert.equal(root.split('command.attachRuntime()').length - 1, 1,
    'the composition root must trigger the command wiring step EXACTLY once')
  assert.doesNotMatch(root, /command\.buildRunner\(/u,
    'the composition root must not build the facade directly (attachRuntime owns it)')
  const owner = ownerFile('src/app/command/surface.ts')
  assert.match(owner, /bindCommandRuntime\(/u,
    'the command surface owner must own the runtime binding')
  // A5b-3 review P2 + M3-6 PR3: disposal must retire BOTH the coordinator and
  // the refresh request through the non-truncating primitive, so a throwing
  // generation unsubscribe or a late `skills/change` (the Direct capability
  // cannot unsubscribe) cannot reach a disposed coordinator.
  const disposeAt = owner.indexOf('const disposeCatalog = (): void => {')
  assert.ok(disposeAt > 0, 'the command owner must expose disposeCatalog')
  const disposeBody = owner.slice(disposeAt, owner.indexOf('\n  }', disposeAt))
  assert.ok(disposeBody.includes('runSyncDisposalSteps('),
    'disposal attempts every owned step through the non-truncating primitive')
  assert.ok(disposeBody.includes('const coordinator = catalogCoordinator'),
    'disposal snapshots the coordinator before retiring the slot')
  assert.ok(disposeBody.includes('coordinator?.dispose()'),
    'disposal disposes the catalog coordinator')
  assert.ok(disposeBody.includes('catalogCoordinator = undefined'),
    'disposal clears the coordinator reference')
  assert.ok(disposeBody.includes('catalogRefreshRequest = undefined'),
    'disposal clears the refresh request so a late skills/change is a no-op')
})

test('A5b-6: the Direct-facing viewed-queue authority is viewer-owned and read late-bound', () => {
  // The A5b-6 zero-assumption sweep judged the `viewedQueueAgent` slot VIEWER
  // mutable state (plan §7.6.2) and moved it into the viewer owner. The
  // composition root keeps only the narrow late-bound CONNECTOR for the Direct
  // queue resolver — the invariant (ONE published authority, published by the
  // viewer, read by the Direct runtime) is unchanged.
  const root = compositionFile('src/app/bootstrap.ts')
  const zone = bootstrapZone()
  const viewer = ownerFile('src/app/surface/viewer-runtime.ts')
  // Composition-side negative: the slot must not exist anywhere in the zone.
  assertCompositionFreeOfOwnerState(zone, ['viewedQueueAgent'], [/publishQueueAuthority/u])
  assert.ok(declares(viewer, 'queueAuthority'),
    'the viewer owner must hold the published queue authority slot')
  assert.match(viewer, /viewedQueueAuthority: \(\) => queueAuthority/u,
    'the viewer owner must expose a getter for the published authority')
  // Facade-side POSITIVE: the narrow late-bound connector stays in the facade.
  assert.match(root, /getViewedQueueAgent: \(\) => viewerRef\?\.viewedQueueAuthority\(\)/u,
    'the composition connector must read the viewer-owned authority late-bound (never capture by value)')
})

test('A5b-6: the composition ZONE implements no TuiAppEvents/TuiCommandRunner literal', () => {
  // Plan §7.6.2, second list. A literal is detected by its type annotation
  // (`: TuiAppEvents = {` / `: TuiCommandRunner = {`); the type-only references
  // the composition still needs (e.g. `TuiCommandRunner['agents']`) are fine.
  // TS2: the scan is ZONE-wide — a helper implementing either literal would be a
  // second application implementation living in the composition layer.
  const zone = bootstrapZone()
  for (const type of ['TuiAppEvents', 'TuiCommandRunner']) {
    assert.equal(
      new RegExp(`:\\s*${type}\\s*=\\s*\\{`).test(zone),
      false,
      `the bootstrap composition zone must not implement ${type} as an object literal`,
    )
  }
  assert.equal(declares(zone, 'surfaceEvents'), false,
    'the TuiAppEvents implementation must live in its owner, not the composition layer')
})

test('A5b-6: no application-owner mutable state category remains in the composition ZONE', (t) => {
  // Plan §7.6.2 categories: client-local history state, command claim/catalog
  // mutable slots, submission FIFO/ack/local-echo state, viewer mutable state
  // and the footer/display state machine. Each name below is a real declaration
  // of its named owner (pinned in EXTRACTED_DECLARATIONS above); this lock keeps
  // the CATEGORY explicit and mutation-sensitive, and since TS2 it scans the
  // whole bootstrap zone (a helper must not reintroduce a category either).
  const zone = bootstrapZone()
  const categories: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['client-local history state', ['knownHistoryCwdSet', 'lastHistoryContent', 'bootHistoryEntries']],
    ['command claim/catalog mutable slots', [
      'wasAdvertisedClaim', 'hostClaimOf', 'isSkillWrapperName', 'withCommandDelivery',
      'takeCommandDraftDisposition', 'catalogRefreshRequest', 'commandsRegistered',
      'skillsChangeGate', 'catalogCoordinator',
    ]],
    ['submission FIFO/ack/local-echo mutable state', [
      'pendingSubmissions', 'localSubmitAck', 'localEcho', 'submitSerialTail',
      'takeSubmitTurn', 'submissionPresentation',
    ]],
    ['viewer mutable state', ['viewerOpen', 'openingViewer', 'pendingSubagentCalls', 'viewerSessionAbort']],
    ['footer/display mutable state machine', [
      'footerCommandRunner', 'footerCommandUnsubscribe', 'footerDynamicItemRuntime',
      'userFooterCustomItemsForSave', 'applyFooterSettings', 'footerWarningShown',
    ]],
  ]
  assertOwnerStateCategoriesAbsent(zone, categories)
  // The real consumer on a fixture tree: a category reintroduced in a NESTED
  // helper must fail, and the same fixture without it must pass.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-zone-state-')
  mkdirSync(join(root, 'src', 'app', 'bootstrap', 'nested'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const entry = 1\n')
  writeFileSync(join(root, 'src', 'app', 'bootstrap.ts'), 'export const bootstrap = 1\n')
  const nested = join(root, 'src', 'app', 'bootstrap', 'nested', 'legacy.ts')
  writeFileSync(nested, 'export const harmless = 1\n')
  assertOwnerStateCategoriesAbsent(bootstrapZoneUnder(root), categories)
  writeFileSync(nested, 'const pendingSubmissions = new Map()\nconst knownHistoryCwdSet = new Set()\n')
  assert.throws(() => assertOwnerStateCategoriesAbsent(bootstrapZoneUnder(root), categories),
    'an application-owner state category reintroduced in a NESTED bootstrap helper must fail the zone lock')
})

test('A5b-6: the composition root holds exactly one ownership and scope authority', () => {
  // Plan §7.6.2: no second submission/session/command/viewer/surface authority.
  // The A2 authority factories are constructed exactly once in the composition
  // root; a second construction would be a second authority.
  const root = compositionFile('src/app/bootstrap.ts')
  assert.equal(root.split('createSessionOwnershipCore(').length - 1, 1,
    'the composition root must construct the ownership authority exactly once')
  assert.equal(root.split('createSessionScopeAuthority(').length - 1, 1,
    'the composition root must construct the live-scope authority exactly once')
})

test('A5b: the Task Center viewer adapter forwards the nested depth to the viewer owner', () => {
  // A5b-1 review P2: the task-browser seam declares an optional 6th `depth`
  // (`TaskSurfaceSource.enterView`) and the surface routes nested/workflow
  // members through it. A composition adapter that drops it silently defaults
  // `depth` to 1, so a nested continuable child would be treated as an
  // interactive direct child and lose the read-only policy (plan §4.3).
  const root = compositionFile('src/app/bootstrap.ts')
  assert.match(
    root,
    /enterView: \(childId: string, label: string \| undefined, mode: 'one-shot' \| 'continuable', parentSessionId: string, activity: 'running' \| 'inactive', depth\?: number\) =>\n\s*viewer\.enterView\(childId, label, mode, parentSessionId, activity, depth\)/u,
    'the Task Center enterView adapter must forward `depth` to the viewer owner',
  )
})

test('A5b-4: the submission owner derives the local-echo placement from reported facts', () => {
  // Review fix P2: the composition root used to compute the official
  // `beginSubmission` placement at the connector. It must only resolve the
  // exact Agent and report `mode`/`running`/`sessionId`; the placement
  // DECISION (queued/steering/transcript) is owner-side.
  const root = compositionFile('src/app/bootstrap.ts')
  const owner = ownerFile('src/app/submission/controller.ts')
  assert.doesNotMatch(root, /submissionPlacement\(/u,
    'the composition root must not compute the submission placement')
  assert.match(owner, /const submissionPlacement = \(mode: 'queue' \| 'steer', running: boolean\)/u,
    'the submission owner must own the placement policy')
  assert.match(
    root,
    /beginLocalSubmission: \(\{ requestId, text, scope, generation, ackToken \}\) => \{[\s\S]*?mode: 'queue',[\s\S]*?running: agent\.status === 'running',[\s\S]*?sessionId: agent\.session\.id,/u,
    'the composition connector must report the facts (mode/running/sessionId), not the placement',
  )
  assert.match(owner, /installLocalEcho\(requestId, text, submissionPlacement\(mode, running\), sessionId, generation, ackToken\)/u,
    'the exposed owner seam must derive the placement from the reported facts')
})

test('A5b-4: the input-history owner owns the submission persistence policy', () => {
  // Review fix P2: trim/dedupe/cwd/file-path/detached write/last-content are
  // the input-history owner's policy; the submission controller only decides
  // WHEN to persist.
  const root = compositionFile('src/app/bootstrap.ts')
  const controller = ownerFile('src/app/submission/controller.ts')
  const history = ownerFile('src/app/surface/input-history.ts')
  assert.match(history, /from '\.\.\/\.\.\/history-persist\.ts'/u,
    'the history owner must own the persist decision + ordering gate')
  assert.match(history, /runDetached\('input history write'/u,
    'the history owner must own the detached write')
  assert.doesNotMatch(root, /runDetached\('input history write'/u,
    'the composition root must not write input history')
  assert.doesNotMatch(controller, /runDetached\('input history write'/u,
    'the submission controller must not write input history')
  assert.doesNotMatch(controller, /from '\.\.\/\.\.\/history-persist\.ts'/u,
    'the submission controller must consume the owner, not history-persist directly')
  assert.doesNotMatch(controller, /from '\.\.\/\.\.\/history\.ts'/u,
    'the submission controller must not resolve history file paths directly')
  // Exactly ONE last-content state: the submission deps no longer expose it.
  assert.doesNotMatch(controller, /deps\.history\.(?:lastContent|setLastContent)\b/u,
    'the controller must not keep a second last-content state')
})

test('A5b-6: the submission writer section is controller-owned and read late-bound', () => {
  // Plan §A5b-6: the last residual moves into the submission owner (the scope
  // authority + submission runtime already live there), and every external
  // consumer reads it through the controller at CALL time (the shell is built
  // before the controller, the event adapter after it).
  const root = compositionFile('src/app/bootstrap.ts')
  const controller = ownerFile('src/app/submission/controller.ts')
  // Composition-side negative: the writer section must not exist anywhere in the zone.
  assertCompositionFreeOfOwnerState(bootstrapZone(), ['submissionWriterSection'])
  assert.ok(declares(controller, 'withWriterSection'),
    'the submission owner must own withWriterSection')
  // The exact semantics: captureLive → reject with SessionScopeSupersededError
  // → submissionRuntime.withWriter(scope, task).
  assert.match(
    controller,
    /const withWriterSection = <T>\(task: \(\) => Promise<T>\): Promise<T> => \{\n\s*const scope = deps\.scope\.captureLive\(\)\n\s*if \(scope === undefined\) return Promise\.reject\(new SessionScopeSupersededError\(\)\)\n\s*return deps\.submissionRuntime\.withWriter\(scope, task\)\n\s*\}/u,
    'the owner must keep the exact captureLive → reject → withWriter semantics',
  )
  assert.equal(root.split('submission.withWriterSection(task)').length - 1, 2,
    'the local shell and the subagent-delivery adapter must both reach the owner')
  assert.doesNotMatch(root, /writerSection: submission\.withWriterSection\b/u,
    'the consumers must read the owner at call time, never capture the method by value')
})

test('A5b-6: the jobs-read retention policy is Task-Center owner state, never a root cache', () => {
  // Finding (P2): the composition root held the retained jobs snapshot and the
  // session/generation fence — a small state machine, not composition wiring.
  // It belongs to the Task-Center owner (`TaskRuntime.attachTasks`, which
  // already owns the task model); the root now supplies only the fence FACTS.
  // TS3 §34 moved that owner into `app/surface/task-runtime.ts`.
  const owner = ownerFile('src/app/surface/task-runtime.ts')
  // Composition-side negative: neither the retained-snapshot slot nor the
  // jobs-read retention policy may exist anywhere in the zone.
  assertCompositionFreeOfOwnerState(
    bootstrapZone(),
    ['jobSnapshot', 'retainedJobsSnapshot'],
    [/\bjobSnapshot\b/u, /\bretainedJobsSnapshot\b/u, /readJobs/u],
  )
  const sourceGroup = owner.slice(
    owner.indexOf('export interface TaskSurfaceRead'),
    owner.indexOf('export interface TaskSurfaceSource'),
  )
  assert.doesNotMatch(sourceGroup, /readJobs/u,
    'the injected Task read source group must no longer carry readJobs')
  assert.match(sourceGroup, /currentSessionId\(\): string \| undefined/u,
    'the source group must supply the jobs-read session id for the owner')
  // The owner owns the retained snapshot AND the same-session fence.
  assert.match(owner, /let retainedJobsSnapshot: \{ key: string; rows: readonly TaskBrowserJobInput\[\] \} \| undefined/u,
    'the Task-Center owner must declare the retained jobs snapshot slot')
  assert.match(owner, /const rows = jobs\.list\(sessionId\)\s*\n\s*retainedJobsSnapshot = \{ key, rows \}/u,
    'a SUCCESSFUL jobs read must refresh the retained snapshot — otherwise the failure fallback has nothing to retain')
  assert.match(owner, /retainedJobsSnapshot\?\.key === key \? retainedJobsSnapshot\.rows : \[\]/u,
    'the owner must keep the same-session retention fence on a transient read failure')
  const readJobsAt = owner.indexOf('readJobs: () => {')
  const readJobsEnd = owner.indexOf('activityOf: taskRead.activityOf', readJobsAt)
  assert.ok(readJobsAt > 0 && readJobsEnd > readJobsAt,
    'the owner must implement readJobs and wire the activity read after it')
  const readJobsBody = owner.slice(readJobsAt, readJobsEnd)
  assert.match(readJobsBody, /const key = taskRead\.currentKey\(\)/u,
    'the owner must resolve the fence key from the injected facts at call time')
  assert.match(readJobsBody, /const sessionId = taskRead\.currentSessionId\(\)/u,
    'the owner must resolve the session id from the injected facts at call time')
  assert.match(readJobsBody, /jobs\.list\(sessionId\)/u,
    'the owner must read the jobs through its own injected adapter')
  assert.doesNotMatch(readJobsBody, /agentNow\(/u,
    'the owner-side jobs read must not read the Direct attachment')
  assert.doesNotMatch(owner, /readJobs: taskRead\.readJobs/u,
    'the TaskBrowserRuntime must receive the owner-side readJobs, not a root-provided one')
})

test('A5b/TS2: legacy owner-state slots reintroduced in a NESTED helper fail the zone locks (mutation)', (t) => {
  // Rejection proof for the A5b-6 composition-side negatives. These four slots
  // are NOT in FINAL_FORBIDDEN_HANDLERS, EXTRACTED_DECLARATIONS or the five
  // category rows, so their own zone assertions are the only thing that can
  // reject a helper redeclaring them. The facade placement is the positive
  // control that the same assertion fires for the ORIGINAL location too.
  const names = ['viewedQueueAgent', 'submissionWriterSection', 'jobSnapshot', 'retainedJobsSnapshot'] as const
  const patterns = [/publishQueueAuthority/u, /\bjobSnapshot\b/u, /\bretainedJobsSnapshot\b/u, /readJobs/u] as const
  const slotSource = `${names.map(name => `let ${name}: unknown\n`).join('')}const readJobs = 1\nconst publishQueueAuthority = 1\n`

  const life = testLifecycle(t)
  const root = life.tempDir('dsh-zone-legacy-state-')
  mkdirSync(join(root, 'src', 'app', 'bootstrap', 'nested'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const entry = 1\n')
  const facade = join(root, 'src', 'app', 'bootstrap.ts')
  const nested = join(root, 'src', 'app', 'bootstrap', 'nested', 'legacy.ts')
  writeFileSync(facade, 'export const bootstrap = 1\n')
  writeFileSync(nested, 'export const harmless = 1\n')

  // Clean positive: the same fixture without the slots passes.
  assertCompositionFreeOfOwnerState(bootstrapZoneUnder(root), names, patterns)

  // Nested negative: a helper at ANY depth may not reintroduce them.
  writeFileSync(nested, slotSource)
  assert.throws(() => assertCompositionFreeOfOwnerState(bootstrapZoneUnder(root), names, patterns),
    'the four legacy owner-state slots must be rejected anywhere in the composition zone')

  // Same-bytes facade control: the original location fires the same assertion.
  writeFileSync(nested, 'export const harmless = 1\n')
  writeFileSync(facade, slotSource)
  assert.throws(() => assertCompositionFreeOfOwnerState(bootstrapZoneUnder(root), names, patterns),
    'the same bytes in the facade must fire the same assertion')
})
