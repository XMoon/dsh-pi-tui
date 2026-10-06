import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

/**
 * The A5b owner surface: the composition surface (plan A5 §22) PLUS the
 * application modules the A5b slices extract bootstrap responsibilities into
 * (`app/surface`, `app/command`, `app/submission`).
 *
 * This list is NOT the whole owner inventory: the A2/A4 owners under
 * `app/session` (ownership core, scope, commit order, subject, owner access) and
 * `app/direct` keep their own locks. They are deliberately absent here because
 * `ownerSource()`/`ownerOccurrences()` are the A5b *single-owner* aggregate, and
 * folding the earlier owners in would count their factory DECLARATIONS
 * (`export function bindSessionRuntime(`) as competing constructions. A
 * duplicate of an A5b single-owner site in one of those modules is still caught:
 * {@link productionSources} scans the whole production tree for it.
 *
 * A5b locks care about two different facts and must not conflate them:
 *
 * - **single ownership** — a tracker/controller/state machine is constructed
 *   exactly once across the whole owner surface, wherever its owner lives;
 * - **ownership LOCATION** — the construction lives in the module that owns the
 *   behaviour, not in `src/app/bootstrap.ts` (which stays composition-only).
 *
 * The list is deliberately EXPLICIT rather than a `src/app/**` glob (A5b plan
 * §8.3): a source lock must follow the authority to a named owner, and a glob
 * would let an old string search pass by scanning the whole tree. The
 * whole-tree scan below exists only to detect a SECOND copy outside this
 * surface; it never replaces a per-owner location pin.
 *
 * The list grows as slices land. Entries that do not exist yet are not listed,
 * so `ownerSources()` never silently covers a missing module: every listed
 * module is REQUIRED to exist.
 */

export type OwnerRole = 'composition' | 'owner'

export interface OwnerModule {
  readonly rel: string
  readonly role: OwnerRole
}

/** The explicit A5b owner-module set, in composition order. */
export const OWNER_MODULES: readonly OwnerModule[] = [
  { rel: 'src/index.ts', role: 'composition' },
  { rel: 'src/app/bootstrap.ts', role: 'composition' },
  // A4-6 / A5b-6: the mounted-surface owner; the A5b-6 closure moved the
  // Task-Center jobs-read retention policy into it (plan §7.6.2), so its
  // ownership location is now locked from the A5b owner surface.
  { rel: 'src/app/surface/runtime.ts', role: 'owner' },
  // A5b-1: viewer + live-session presentation.
  { rel: 'src/app/surface/session-presentation.ts', role: 'owner' },
  { rel: 'src/app/surface/viewer-runtime.ts', role: 'owner' },
  // A5b-2: status/settings/history/client state.
  { rel: 'src/app/surface/status-runtime.ts', role: 'owner' },
  { rel: 'src/app/surface/input-history.ts', role: 'owner' },
  { rel: 'src/app/surface/settings-runtime.ts', role: 'owner' },
  // A5b-3: command/model-selection/artifacts.
  { rel: 'src/app/command/model-selection.ts', role: 'owner' },
  { rel: 'src/app/command/surface.ts', role: 'owner' },
  { rel: 'src/app/command/artifacts.ts', role: 'owner' },
  // A5b-3: command authority/registration/catalog.
  // A5b-4: submission/input + local shell.
  { rel: 'src/app/submission/controller.ts', role: 'owner' },
  { rel: 'src/app/submission/user-shell.ts', role: 'owner' },
  // A5b-5: TuiApp application events + client-local platform actions.
  { rel: 'src/app/surface/application-events.ts', role: 'owner' },
  { rel: 'src/app/surface/client-actions.ts', role: 'owner' },
] as const

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function read(rel: string): string {
  const path = join(ROOT, rel)
  if (!existsSync(path)) throw new Error(`the A5b owner surface requires ${rel}`)
  return readFileSync(path, 'utf8')
}

/** The owner-surface contents with each module's role, in composition order. */
export function ownerSources(): Array<OwnerModule & { source: string }> {
  return OWNER_MODULES.map((m) => ({ ...m, source: read(m.rel) }))
}

/** The owner-surface contents joined with file banners. */
export function ownerSource(): string {
  return ownerSources().map(({ rel, source }) => `// >>> ${rel}\n${source}`).join('\n')
}

/** Total occurrences of one literal across the owner surface. */
export function ownerOccurrences(literal: string): number {
  return ownerSources().reduce((total, { source }) => total + source.split(literal).length - 1, 0)
}

/** The source of one owner-surface module. Throws when it is not listed. */
export function ownerFile(rel: string): string {
  const entry = ownerSources().find((m) => m.rel === rel)
  if (!entry) throw new Error(`${rel} is not part of the A5b owner surface`)
  return entry.source
}

/**
 * Fully unwrap the expression wrappers the TypeScript AST can hide a callee or
 * an object-literal initializer behind — `(...)`, `x as T`, `<T>x`, `x!`,
 * `x satisfies T` — looping until the expression stops changing.
 *
 * This mirrors the unwrap in `scripts/application-architecture-gate.mjs`
 * (`findDirectAdapterConstructions`). It lives here, next to the production
 * walkers it guards, because BOTH A5b AST guards
 * (`test/a5-composition-inventory.test.ts` and
 * `test/a5b-bootstrap-closure.test.ts`) share it: keeping one definition means
 * a wrapper the architecture gate unwraps can never silently bypass an A5b
 * scan.
 *
 * `onWrapperType` is invoked with the type annotation of every `as` /
 * `satisfies` / `<T>` wrapper, so a caller can recognize a type that travels on
 * the wrapper rather than on the variable declaration.
 */
export function unwrapExpression(
  expr: ts.Expression,
  onWrapperType?: (type: ts.TypeNode) => void,
): ts.Expression {
  let current = expr
  while (true) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression
    } else if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) {
      onWrapperType?.(current.type)
      current = current.expression
    } else {
      return current
    }
  }
}

/**
 * EVERY production TypeScript source under `src/` (recursive, `src/`-relative
 * paths), for the whole-tree duplicate detectors.
 *
 * This is deliberately NOT `OWNER_MODULES`: the explicit list above is the
 * authority pin, while this walk is the DETECTOR that can see a second
 * construction in a file nobody listed (plan A5b §8.1/§8.3 — "authority pinned
 * to the owner, the whole-tree scan only detects a second copy"). `test/`,
 * `packages/` and `dist/` are never reached because the walk starts at `src/`;
 * `node_modules`/`dist` are skipped defensively.
 *
 * The extension filter mirrors `scripts/application-architecture-gate.mjs`'s
 * `collectSourceEntries()` — `.ts`, `.mts` and `.cts` (which also cover the
 * `.d.ts` / `.d.mts` / `.d.cts` declaration spellings) — so no production
 * TypeScript source is skipped silently.
 */
export function productionSources(): Array<{ rel: string; source: string }> {
  const out: Array<{ rel: string; source: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(path)
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mts') || entry.name.endsWith('.cts')) {
        out.push({ rel: relative(ROOT, path).split('\\').join('/'), source: readFileSync(path, 'utf8') })
      }
    }
  }
  walk(join(ROOT, 'src'))
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/**
 * Every production site that CALLS or CONSTRUCTS `name`, alias-aware.
 *
 * The unit is the AST callee identity (`CallExpression` / `NewExpression`
 * expression, unwrapped), never a source spelling: an inferred-generic call, an
 * explicit-generic call, a parenthesized callee, `new X()` and `new X<T>()` are
 * all the same fact. Simple aliases are followed to convergence:
 * `const F = <name>` / `const F = <alias>` and `import { <name> as F } from '…'`.
 *
 * Stated scope (deliberately narrower than "aliases in general"): resolution is
 * TEXT-based over identifiers, not binding-based, and only those two forms are
 * followed. A same-named unrelated local therefore makes a caller fail LOUDLY (a
 * false positive, never a silent pass), while computed indirection
 * (`obj[key](x)`, a re-export object, a `Proxy`, a re-assigned binding) is
 * outside the helper entirely. The architecture gate locks the dependency
 * direction only — it performs no type analysis.
 */
export function aliasAwareConstructionSites(name: string): string[] {
  const files = productionSources().map(({ rel, source }) => ({
    rel,
    file: ts.createSourceFile(rel, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS),
  }))
  const aliases = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const { file } of files) {
      const scan = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
          const inner = unwrapExpression(node.initializer)
          if (ts.isIdentifier(inner) && (inner.text === name || aliases.has(inner.text)) && !aliases.has(node.name.text)) {
            aliases.add(node.name.text)
            changed = true
          }
        }
        if (
          ts.isImportSpecifier(node)
          && node.propertyName !== undefined
          && node.propertyName.text === name
          && !aliases.has(node.name.text)
        ) {
          aliases.add(node.name.text)
          changed = true
        }
        ts.forEachChild(node, scan)
      }
      scan(file)
    }
  }
  const sites: string[] = []
  for (const { rel, file } of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = unwrapExpression(node.expression)
        if (ts.isIdentifier(callee) && (callee.text === name || aliases.has(callee.text))) sites.push(rel)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return sites.sort()
}

/** The whole production `src/` tree joined with file banners, for count/scan locks. */
export function productionSource(): string {
  return productionSources().map(({ rel, source }) => `// >>> ${rel}\n${source}`).join('\n')
}
