#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/pre-m3-architecture-gate — CI guard for the
 * Pre-M3 TS Architecture Convergence application-layer dependency direction
 * (see `temp/m3/dsh-pi-tui-pre-m3-ts-architecture-convergence-implementation-plan-20260925.md`
 * §5 Dependency direction and §15 Architecture gate 最终规则).
 *
 * This gate is deliberately separate from `scripts/client-boundary-gate.mjs`:
 *
 *   client-boundary-gate  = Host business coupling debt (which src/ file may
 *                           touch which Host service / Host type)
 *   pre-m3-architecture-gate
 *                         = application-layer dependency DIRECTION between the
 *                           new `src/app/**` owners, the frozen `src/runtime/**`
 *                           semantic layer, and presentation modules
 *
 * The scanner parses TypeScript ASTs with the repo's existing `typescript`
 * dependency (no new dependency). Supported static forms: `import ... from
 * '...'`, `export ... from '...'`, `import x = require('...')`, and
 * `import('...')` TYPE queries (`type T = import('...').T` / `typeof
 * import(...)`) — a type-only dependency is still a static dependency. All
 * supported TypeScript source extensions are scanned (`.ts`, `.mts`, `.cts`,
 * including their `.d.*` declaration forms), and static edges resolve both
 * explicit `.ts` specifiers and the NodeNext emitted extensions (`.js` ->
 * `.ts`/`.d.ts`, `.mjs` -> `.mts`/`.d.mts`, `.cjs` -> `.cts`/`.d.cts`). Out of
 * scope BY DESIGN: the VALUE dynamic `import('...')` call (the
 * sanctioned lazy backend-loading seam — see the migration doc §Startup),
 * CommonJS `require('...')` calls (this tree is ESM), and path aliases (the
 * tsconfigs define no `paths`).
 *
 * Rules enforced:
 *   1. `src/runtime/**` must not import `src/app/**`.
 *   2. Direct wiring is importable ONLY by the composition owners: `src/index.ts`,
 *      the future `src/app/bootstrap.ts`, `src/app/direct/**` itself, and the
 *      semantic `src/runtime/**`. This covers `app/direct/**` and
 *      `runtime/direct/**` targets for every other module — the non-Direct
 *      application owners (`app/session`, `app/submission`, `app/command`,
 *      `app/surface`) and the whole §5.2 presentation/presentation-adjacent
 *      surface. A consumer that needs a Direct fact declares its own interface
 *      and the bootstrap injects the implementation (§5.4), so no Direct import
 *      is required. This is the enumeration-free form of the presentation rule;
 *      one proven historical exception is recorded in
 *      {@link ARCHITECTURE_ALLOWLIST} and is restricted to TYPE-ONLY imports.
 *   3. Nothing statically reachable from `src/startup.ts` may import
 *      experimental Remote composition (`src/runtime/remote/**`,
 *      `@deepseek-ai/dsh-client-*`, `@deepseek-ai/dsh-api-*`): §15.4 keeps the
 *      startup compatibility island free of a Remote/Connection static
 *      dependency, including through an intermediate module.
 *   4. `src/app/surface/**` must not construct Direct semantic adapters
 *      (`new Direct<...>(...)`); those belong to
 *      `src/runtime/direct/backend-direct.ts`. The deliberate non-Backend
 *      Direct application owners ({@link DIRECT_APPLICATION_EXCEPTIONS}:
 *      `DirectModelSelectionOwner`; the Direct assistant-stream install is not
 *      a `new` construction) are exempt. Parenthesized / `as`-cast / non-null
 *      constructor references are unwrapped; alias or factory indirection
 *      cannot be resolved statically and is out of scope for this gate.
 *
 * Existing historical exceptions, when a phase proves one, are recorded in
 * {@link ARCHITECTURE_ALLOWLIST} (file + resolved target, TYPE-ONLY only); new
 * entries require an explicit maintainer decision and must not be added to
 * absorb new debt.
 *
 * Usage:
 *   node scripts/pre-m3-architecture-gate.mjs            # check (exit 1 on violation)
 *   node scripts/pre-m3-architecture-gate.mjs --report   # print scanned zones
 * @module pre-m3-architecture-gate
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/**
 * Direct application owners that are deliberately NOT Backend adapters and may
 * be constructed outside `runtime/direct/backend-direct.ts` (plan §15.5).
 */
export const DIRECT_APPLICATION_EXCEPTIONS = new Set(['DirectModelSelectionOwner'])

/** Import specifiers that count as experimental Remote composition. */
export const REMOTE_COMPOSITION_SPECIFIER = /^@deepseek-ai\/dsh-(?:client-|api-)/u

/**
 * Existing historical exceptions as `"<src-relative file>:<resolved target>"`.
 * An allowlist entry excuses ONLY a TYPE-ONLY import of that target; a value
 * import of the same target still fails. Today exactly one: the legacy settings
 * migration reads the Direct TUI-settings facade's types (no wiring). §15.3
 * permits a narrow allowlist for proven historical exceptions; it must never
 * grow to absorb new debt.
 */
export const ARCHITECTURE_ALLOWLIST = ['legacy-settings-migration.ts:runtime/direct/tui-settings-direct.ts']

/**
 * True when `srcRel` may import Direct wiring: the composition root
 * (`src/index.ts`), the future composition owner (`src/app/bootstrap.ts`), the
 * Direct application zone itself (`src/app/direct/**`), and the semantic
 * runtime (`src/runtime/**`).
 *
 * Every other module — including the non-Direct application owners
 * (`app/session`, `app/submission`, `app/command`, `app/surface`) and the whole
 * presentation surface — must consume semantic ports / the `Backend` / narrow
 * injected callbacks. This is the §5 dependency graph and the §5.2 presentation
 * boundary in enumeration-free form: a consumer that needs a Direct fact
 * declares its own interface and the bootstrap injects the implementation
 * (§5.4), so no Direct import is ever required.
 */
export function isDirectCompositionFile(srcRel) {
  return srcRel === 'index.ts'
    || srcRel === 'app/bootstrap.ts'
    || srcRel.startsWith('app/direct/')
    || srcRel.startsWith('runtime/')
}

/** True when a resolved target / specifier is experimental Remote composition. */
export function isRemoteComposition(resolved, specifier) {
  return resolved.startsWith('runtime/remote/') || REMOTE_COMPOSITION_SPECIFIER.test(specifier)
}

/**
 * The per-file static dependency-direction rules. `applies` decides whether the
 * rule governs the importing file; `forbids` decides whether the import target
 * (or module specifier for package imports) violates it.
 */
export const ARCHITECTURE_RULES = [
  {
    id: 'runtime-imports-app',
    message: 'src/runtime/** must not import src/app/** (application layer depends on runtime, never the reverse)',
    applies: (srcRel) => srcRel.startsWith('runtime/'),
    forbids: (resolved) => resolved.startsWith('app/'),
  },
  {
    id: 'direct-import-outside-composition',
    message:
      'only src/index.ts, src/app/bootstrap.ts, src/app/direct/** and src/runtime/** may import '
      + 'src/app/direct/** or src/runtime/direct/** (non-Direct app owners and presentation consume ports/Backend/callbacks)',
    applies: (srcRel) => !isDirectCompositionFile(srcRel),
    forbids: (resolved) => resolved.startsWith('app/direct/') || resolved.startsWith('runtime/direct/'),
  },
]

/**
 * The startup static-graph rule (evaluated over reachability, not per file):
 * no module statically reachable from `src/startup.ts` may import experimental
 * Remote composition.
 */
export const STARTUP_REMOTE_COMPOSITION_RULE = {
  id: 'startup-imports-remote-composition',
  message: 'src/startup.ts and its static import graph must not import experimental Remote composition',
  forbids: isRemoteComposition,
}

/**
 * Resolve a relative import specifier against the importing file's src-relative
 * path. Returns `undefined` for non-relative (package / node:) specifiers.
 * @param {string} srcRel importing file path relative to `src/`
 * @param {string} specifier raw import specifier
 * @returns {string | undefined}
 */
export function resolveRelativeImport(srcRel, specifier) {
  if (!specifier.startsWith('.')) return undefined
  return posix.normalize(posix.join(posix.dirname(srcRel), specifier))
}

/**
 * Extract every STATIC import/export-from/import-equals specifier AND every
 * `import('...')` TYPE query (`type T = import('...').T` / `typeof import(...)`)
 * with its 1-based line number and whether it is TYPE-ONLY, via the TypeScript
 * parser. Comments and multi-line `from` clauses are handled correctly; a VALUE
 * dynamic `import('...')` call is intentionally not a static edge.
 * @param {string} source file contents
 * @returns {Array<{ specifier: string, line: number, typeOnly: boolean }>}
 */
export function parseImportSpecifiers(source) {
  const sf = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const out = []
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const importTypeArgument = (node) => {
    const arg = node.argument
    if (arg === undefined || !ts.isLiteralTypeNode(arg) || !ts.isStringLiteral(arg.literal)) return undefined
    return arg.literal.text
  }
  /** True when an import declaration binds/types only (no default value binding). */
  const isTypeOnlyImport = (node) => {
    const clause = node.importClause
    if (clause === undefined) return false
    if (clause.isTypeOnly) return true
    if (clause.name !== undefined) return false
    const bindings = clause.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) return false
    return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (ts.isStringLiteral(spec)) out.push({ specifier: spec.text, line: lineOf(node), typeOnly: isTypeOnlyImport(node) })
    } else if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (spec !== undefined && ts.isStringLiteral(spec)) out.push({ specifier: spec.text, line: lineOf(node), typeOnly: node.isTypeOnly })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression
      if (expr !== undefined && ts.isStringLiteral(expr)) out.push({ specifier: expr.text, line: lineOf(node), typeOnly: false })
    } else if (ts.isImportTypeNode(node)) {
      const spec = importTypeArgument(node)
      if (spec !== undefined) out.push({ specifier: spec, line: lineOf(node), typeOnly: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Names constructed via `new Direct<...>(...)` in `source` (AST-based: comments
 * never match, and parenthesized / `as`-cast / non-null constructor references
 * are unwrapped). Alias or factory indirection cannot be resolved statically and
 * is out of scope.
 */
export function findDirectAdapterConstructions(source) {
  const sf = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const out = []
  const unwrap = (expr) => {
    let current = expr
    while (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isSatisfiesExpression(current)
    ) {
      current = current.expression
    }
    return current
  }
  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      const expr = unwrap(node.expression)
      if (ts.isIdentifier(expr) && /^Direct[A-Za-z0-9_]*$/u.test(expr.text)) {
        out.push({ name: expr.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** Read every TypeScript source under `dir` as a `{ rel, source }` entry. */
export function collectSourceEntries(dir = SRC) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(p)
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts') || entry.name.endsWith('.cts')) {
        out.push({
          rel: relative(dir, p).split('\\').join('/'),
          source: readFileSync(p, 'utf8'),
        })
      }
    }
  }
  walk(dir)
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * Candidate on-disk files for one resolved specifier, following NodeNext's
 * emitted-extension substitution exactly: `.js` -> `.ts` / `.d.ts`, `.mjs` ->
 * `.mts` / `.d.mts`, `.cjs` -> `.cts` / `.d.cts`. This repo writes explicit
 * `.ts` specifiers; the mapping is the safety net for the equally legal NodeNext
 * spelling.
 * @param {string} resolved src-relative resolved specifier
 * @returns {string[]}
 */
export function staticImportCandidates(resolved) {
  if (resolved.endsWith('.ts') || resolved.endsWith('.mts') || resolved.endsWith('.cts')) return [resolved]
  if (resolved.endsWith('.js')) {
    const stem = resolved.slice(0, -3)
    return [`${stem}.ts`, `${stem}.d.ts`, resolved]
  }
  if (resolved.endsWith('.mjs')) {
    const stem = resolved.slice(0, -4)
    return [`${stem}.mts`, `${stem}.d.mts`, resolved]
  }
  if (resolved.endsWith('.cjs')) {
    const stem = resolved.slice(0, -4)
    return [`${stem}.cts`, `${stem}.d.cts`, resolved]
  }
  return [
    `${resolved}.ts`,
    `${resolved}.mts`,
    `${resolved}.cts`,
    `${resolved}.d.ts`,
    `${resolved}.d.mts`,
    `${resolved}.d.cts`,
    `${resolved}/index.ts`,
    `${resolved}/index.d.ts`,
  ]
}

/**
 * Static edges between scanned files: `rel -> Set<rel>`. Extension-less
 * specifiers and NodeNext emitted-extension spellings are resolved against the
 * scanned file set.
 * @param {Array<{ rel: string, source: string }>} entries
 * @returns {Map<string, Set<string>>}
 */
export function buildStaticEdges(entries) {
  const known = new Set(entries.map(entry => entry.rel))
  const edges = new Map()
  for (const { rel, source } of entries) {
    const targets = new Set()
    for (const { specifier } of parseImportSpecifiers(source)) {
      const resolved = resolveRelativeImport(rel, specifier)
      if (resolved === undefined) continue
      const hit = staticImportCandidates(resolved).find(candidate => known.has(candidate))
      if (hit !== undefined) targets.add(hit)
    }
    edges.set(rel, targets)
  }
  return edges
}

/** Breadth-first reachable set (including the root) with the path that reached each node. */
function reachableFrom(root, edges) {
  const paths = new Map([[root, [root]]])
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const next of edges.get(current) ?? []) {
      if (paths.has(next)) continue
      paths.set(next, [...paths.get(current), next])
      queue.push(next)
    }
  }
  return paths
}

/**
 * Find every architecture-boundary violation in `entries`.
 * @param {Array<{ rel: string, source: string }>} entries
 * @param {{ allowlist?: string[] }} [options]
 * @returns {Array<{ file: string, line: number, rule: string, detail: string }>}
 */
export function findViolations(entries, options = {}) {
  const allowlist = new Set(options.allowlist ?? ARCHITECTURE_ALLOWLIST)
  const violations = []
  const imports = new Map()
  const sourceByRel = new Map()
  for (const { rel, source } of entries) {
    imports.set(rel, parseImportSpecifiers(source))
    sourceByRel.set(rel, source)
  }

  for (const { rel } of entries) {
    for (const { specifier, line, typeOnly } of imports.get(rel)) {
      const resolved = resolveRelativeImport(rel, specifier)
      for (const rule of ARCHITECTURE_RULES) {
        if (!rule.applies(rel)) continue
        if (!rule.forbids(resolved ?? specifier, specifier)) continue
        // An allowlist entry excuses ONLY a type-only import of that target.
        if (typeOnly && allowlist.has(`${rel}:${resolved ?? specifier}`)) continue
        violations.push({ file: rel, line, rule: rule.id, detail: `${rule.message} (${specifier})` })
      }
    }
    if (rel.startsWith('app/surface/')) {
      for (const { name, line } of findDirectAdapterConstructions(sourceByRel.get(rel))) {
        if (DIRECT_APPLICATION_EXCEPTIONS.has(name)) continue
        violations.push({
          file: rel,
          line,
          rule: 'surface-constructs-direct-adapter',
          detail: `src/app/surface/** must not construct Direct semantic adapters; ${name} belongs to runtime/direct/backend-direct.ts`,
        })
      }
    }
  }

  // Rule 4: the startup static import graph.
  const startupRel = 'startup.ts'
  if (entries.some(entry => entry.rel === startupRel)) {
    const paths = reachableFrom(startupRel, buildStaticEdges(entries))
    for (const [rel, path] of paths) {
      for (const { specifier, line } of imports.get(rel) ?? []) {
        const resolved = resolveRelativeImport(rel, specifier)
        if (!STARTUP_REMOTE_COMPOSITION_RULE.forbids(resolved ?? specifier, specifier)) continue
        const via = path.length > 1 ? ` (statically reachable from src/startup.ts via ${path.join(' -> ')})` : ''
        violations.push({
          file: rel,
          line,
          rule: STARTUP_REMOTE_COMPOSITION_RULE.id,
          detail: `${STARTUP_REMOTE_COMPOSITION_RULE.message} (${specifier})${via}`,
        })
      }
    }
  }
  return violations
}

/** Scan the production `src/` tree. */
export function scanArchitecture(dir = SRC) {
  return findViolations(collectSourceEntries(dir))
}

function main() {
  const entries = collectSourceEntries()
  if (process.argv.includes('--report')) {
    console.log(`pre-m3-architecture-gate: scanned ${entries.length} src file(s)`)
    for (const rule of ARCHITECTURE_RULES) console.log(`  rule ${rule.id}`)
    console.log(`  rule ${STARTUP_REMOTE_COMPOSITION_RULE.id}`)
    console.log('  rule surface-constructs-direct-adapter')
    return
  }
  const violations = findViolations(entries)
  if (violations.length > 0) {
    console.error('pre-m3-architecture-gate: application-layer dependency direction violated:')
    for (const v of violations) console.error(`  src/${v.file}:${v.line} [${v.rule}] ${v.detail}`)
    console.error('\nSee the Pre-M3 TS Architecture Convergence plan §5/§15 and docs/client-server-migration.md.')
    process.exit(1)
  }
  console.log(`pre-m3-architecture-gate: ok (${entries.length} file(s), dependency direction clean)`)
}

if (process.argv[1] && relative(ROOT, process.argv[1]).replace(/\\/g, '/') === 'scripts/pre-m3-architecture-gate.mjs') {
  main()
}
