#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/application-architecture-gate — CI guard for the
 * long-lived application-layer dependency direction between `src/app/**` owners,
 * `src/runtime/**` semantic/adaptor layers, presentation/TUI modules, and the
 * experimental Remote composition boundary (see `docs/architecture.md`; the
 * enforcement inventory lives in `docs/client-server-migration.md`).
 *
 * This gate is deliberately separate from `scripts/client-boundary-gate.mjs`:
 *
 *   client-boundary-gate  = Host business coupling debt (which src/ file may
 *                           touch which Host service / Host type)
 *   application-architecture-gate
 *                         = application-layer dependency DIRECTION between the
 *                           `src/app/**` owners, the `src/runtime/**` semantic
 *                           layer, and presentation modules
 *
 * The scanner parses TypeScript ASTs with the repo's existing `typescript`
 * dependency (no new dependency). Supported static forms: `import ... from
 * '...'`, `export ... from '...'`, `import x = require('...')`, and
 * `import('...')` TYPE queries (`type T = import('...').T` / `typeof
 * import(...)`) — a type-only dependency is still a static dependency. All
 * supported production source extensions are scanned (`.ts`, `.tsx`, `.mts`,
 * `.cts`, including their `.d.*` declaration forms), so neither the dependency
 * rules nor the root ledger can be bypassed by choosing `.tsx`; static edges
 * resolve both explicit `.ts`/`.tsx` specifiers and the NodeNext emitted
 * extensions (`.js` -> `.ts`/`.tsx`/`.d.ts`, `.jsx` -> `.tsx`/`.ts`/`.d.ts`,
 * `.mjs` -> `.mts`/`.d.mts`, `.cjs` -> `.cts`/`.d.cts`). A VALUE dynamic
 * `import('...')` call IS parsed (`parseValueDynamicImports`, transparent
 * wrappers unwrapped) and governs the sanctioned lazy backend-loading seam: the
 * Remote lazy-boundary rule admits exactly one such edge, and any rule that
 * opts in with `checksValueDynamicImport` is evaluated against the rest (today
 * the TS4 `app-imports-tui` lock and the TS8-B `runtime-imports-client` lock).
 * The generic rule list stays static-only on
 * purpose so that sanctioned seam is not re-classified. Still out of scope: a
 * non-literal dynamic argument or one containing a `${…}` substitution (a
 * genuinely dynamic expression), CommonJS `require('...')` calls (this tree is
 * ESM), and path aliases (the tsconfigs define no `paths`).
 *
 * Rules enforced:
 *   1. `src/runtime/**` must not import `src/app/**`.
 *   2. Direct wiring is importable ONLY by the composition owners: `src/index.ts`,
 *      `src/app/bootstrap.ts`, `src/app/direct/**` itself, and the
 *      semantic `src/runtime/**`. This covers `app/direct/**` and
 *      `runtime/direct/**` targets for every other module — the non-Direct
 *      application owners (`app/session`, `app/submission`, `app/command`,
 *      `app/surface`) and the whole presentation/presentation-adjacent
 *      surface. A consumer that needs a Direct fact declares its own interface
 *      and the bootstrap injects the implementation, so no Direct import
 *      is required. This is the enumeration-free form of the presentation rule;
 *      one proven historical exception is recorded in
 *      {@link ARCHITECTURE_ALLOWLIST} and is restricted to TYPE-ONLY imports.
 *   3. No application owner or presentation module may import
 *      `src/app/bootstrap.ts`: the dependency direction is
 *      `index -> bootstrap -> owners`, never `owner -> bootstrap`. The
 *      composition root connects owners through narrow injected callbacks; an
 *      owner that reaches back into bootstrap would invert the graph.
 *   4. Nothing statically reachable from `src/startup.ts` may import
 *      experimental Remote composition (`src/runtime/remote/**`,
 *      `src/app/remote/**`, any `@deepseek-ai/dsh-<pkg>/client` or
 *      `/remote` subpath entry, and the `@deepseek-ai/dsh-client-*` /
 *      `@deepseek-ai/dsh-api-*` root entries): the
 *      startup compatibility island stays free of a Remote/Connection static
 *      dependency, including through an intermediate module.
 *   5. `src/app/surface/**` must not construct Direct semantic adapters
 *      (`new Direct<...>(...)`); those belong to
 *      `src/runtime/direct/backend-direct.ts`. The deliberate non-Backend
 *      Direct application owners ({@link DIRECT_APPLICATION_EXCEPTIONS}:
 *      `DirectModelSelectionOwner`; the Direct assistant-stream install is not
 *      a `new` construction) are exempt. Parenthesized / `as`-cast / non-null
 *      constructor references are unwrapped; alias or factory indirection
 *      cannot be resolved statically and is out of scope for this gate.
 *   6. (M3-1 + M3-4 PR1) `app/remote/**` — the Remote composition — may be
 *      reached by a VALUE dynamic `import()` only through the single
 *      sanctioned boundary edge (`runtime/backend-loader.ts` ->
 *      `app/remote/runtime.ts`, the entry module that statically re-exports
 *      the application-runtime aggregate); any other src module dynamically
 *      importing `app/remote/**` fails, and so does a second dynamic target
 *      under the owner. Dynamic imports outside the Remote composition
 *      boundary stay out of scope.
 *   7. (TS1) `src/tui/**` — the terminal presentation layer, including the
 *      `src/commands.ts` command-layer facade/coordinator — must not import
 *      experimental Remote composition (`runtime/remote/**`, `app/remote/**`,
 *      or a Remote package face): terminal presentation consumes
 *      semantic/application-facing contracts only. The existing rules already
 *      forbid Direct implementation imports and `app/bootstrap.ts` there, so
 *      this is the first LONG-LIVED TUI-layer rule; it is extended by the PR
 *      that introduces each later zone.
 *   8. (TS1) `src/runtime/**` must not import `src/tui/**`: the semantic/adaptor
 *      layer never depends on terminal presentation.
 *   9. (TS7/TS8-D) `src/domain/transcript/**` — the ONE transport/UI-neutral
 *      transcript semantic/lifecycle authority — is CLOSED-WORLD: only its own
 *      siblings and two TYPE-ONLY compatibility edges
 *      (`domain/display/icons.ts`, `runtime/assistant-stream-port.ts`)
 *      are admitted; every other relative `src/**` edge (TUI/renderer mechanics,
 *      application currentness, the Direct/Remote adapters, `commands.ts`,
 *      the `src/transcript.ts` facade, any transitional/legacy root, …) fails by default,
 *      including literal dynamic spellings and value imports that would ride on a
 *      type-only allowance. Bare packages keep the PiTui/Tern/Remote package-face
 *      rule. The direction is `PiTui mechanics -> tui/transcript -> domain/transcript`,
 *      and a domain module needing a renderer/application fact means the fact was
 *      misclassified and must be split, never allowlisted. `app/remote/**` and
 *      `runtime/remote/**` are covered by this rule for the subtree.
 *  10. (TS8-A) `src/domain/**` must not import `src/client/**`: the Client-local
 *      capability is the INNER platform layer, exactly like `app/`/`tui/`.
 *  11. (TS8-A) `src/client/**` must not import experimental Remote composition:
 *      Client-local state never depends on the Host transport. The Direct side
 *      is already closed by rule 2.
 *  12. (TS8-B) `src/runtime/**` must not import `src/client/**`: the
 *      Client-local platform capability is the INNER layer (like `app/`/`tui/`),
 *      so the Host semantic/adaptor layer never depends on it.
 *
 * Root source placement (plan §20.3): `scripts/source-root-baseline.json` is a
 * shrinking ledger of the ROOT production modules. A new root module
 * (`src/*.ts|.tsx|.mts|.cts`) must
 * belong to a canonical layer (`app`/`runtime`/`domain`/`client`/`tui`/
 * `extension`) instead; a `legacy` entry that no longer exists, a missing
 * `stable` facade, a duplicate entry, or an unknown schema fails closed. The
 * gate never writes or accepts a new baseline entry.
 *
 * Retired feature directories ({@link RETIRED_SOURCE_DIRECTORIES}) are the
 * directory-level companion: a historical feature directory retired by a
 * completed ownership stage (TS8-A: `src/file-completion/**`) must not
 * reappear — new code belongs to the canonical layer that now owns it.
 *
 * Existing historical exceptions, when a phase proves one, are recorded in
 * {@link ARCHITECTURE_ALLOWLIST} (file + resolved target, TYPE-ONLY only); new
 * entries require an explicit maintainer decision and must not be added to
 * absorb new debt.
 *
 * Usage:
 *   node scripts/application-architecture-gate.mjs            # check (exit 1 on violation)
 *   node scripts/application-architecture-gate.mjs --report   # print scanned zones
 * @module application-architecture-gate
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/**
 * Every production source extension the gate scans: `.ts` (including `.d.ts`),
 * `.tsx`, `.mts` and `.cts`. `.tsx` is included deliberately — the root ledger
 * and the TUI-layer dependency rules must not be bypassable by adding a `.tsx`
 * module, and TS4+ presentation work may legitimately use it.
 */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']

/**
 * Direct application owners that are deliberately NOT Backend adapters and may
 * be constructed outside `runtime/direct/backend-direct.ts`.
 */
export const DIRECT_APPLICATION_EXCEPTIONS = new Set(['DirectModelSelectionOwner'])

/** Import specifiers that count as experimental Remote composition. */
export const REMOTE_COMPOSITION_SPECIFIER =
  /^@deepseek-ai\/dsh-(?:(?:client-|api-)[^/]*$|[^/]+\/(?:client|remote)$)/u

/**
 * The only sanctioned value dynamic-import edge into the Remote composition
 * (M3-1 + M3-4 PR1): `runtime/backend-loader.ts` may dynamically import
 * exactly `app/remote/runtime.ts` — the single entry module that also
 * statically re-exports the application-runtime aggregate; any other src
 * module dynamically importing `app/remote/**` violates the boundary, and so
 * does a second dynamic target.
 */
export const REMOTE_DYNAMIC_IMPORT_OWNER = 'runtime/backend-loader.ts'
export const REMOTE_DYNAMIC_IMPORT_TARGET = 'app/remote/runtime.ts'

/**
 * Existing historical exceptions as `"<src-relative file>:<resolved target>"`.
 * An allowlist entry excuses ONLY a TYPE-ONLY import of that target; a value
 * import of the same target still fails. Today exactly one: the legacy settings
 * migration reads the Direct TUI-settings facade's types (no wiring). A narrow
 * allowlist may record a proven historical exception; it must never
 * grow to absorb new debt.
 */
export const ARCHITECTURE_ALLOWLIST = ['legacy-settings-migration.ts:runtime/direct/tui-settings-direct.ts']

/**
 * True when `srcRel` belongs to the ONE application composition zone (TS2):
 * the facade (`src/app/bootstrap.ts`) and its cohesive wiring-only helper
 * modules (`src/app/bootstrap/**`). The zone is defined by DIRECTORY, not by
 * an allowlist of helper files, so a new extraction cannot escape the zone
 * rules by picking a new file name.
 */
export function isBootstrapCompositionFile(srcRel) {
  return srcRel === 'app/bootstrap.ts' || srcRel.startsWith('app/bootstrap/')
}

/**
 * True when `srcRel` may import Direct wiring: the composition root
 * (`src/index.ts`), the composition zone (`src/app/bootstrap.ts` +
 * `src/app/bootstrap/**`), the Direct application zone itself
 * (`src/app/direct/**`), and the semantic runtime (`src/runtime/**`).
 *
 * Every other module — including the non-Direct application owners
 * (`app/session`, `app/submission`, `app/command`, `app/surface`) and the whole
 * presentation surface — must consume semantic ports / the `Backend` / narrow
 * injected callbacks. This is the dependency graph and the presentation
 * boundary in enumeration-free form: a consumer that needs a Direct fact
 * declares its own interface and the bootstrap injects the implementation,
 * so no Direct import is ever required.
 */
export function isDirectCompositionFile(srcRel) {
  return srcRel === 'index.ts'
    || isBootstrapCompositionFile(srcRel)
    || srcRel.startsWith('app/direct/')
    || srcRel.startsWith('runtime/')
}

/** True when a resolved target / specifier is experimental Remote composition. */
export function isRemoteComposition(resolved, specifier) {
  return resolved.startsWith('runtime/remote/')
    || resolved.startsWith('app/remote/')
    || REMOTE_COMPOSITION_SPECIFIER.test(specifier)
}

/**
 * The concrete renderer / TuiApp / chrome owners the backend-neutral transcript
 * presentation core must never reach. The forbidden TUI surface is the WHOLE
 * `src/tui/**` layer MINUS the core's own `tui/transcript/**` subtree — an
 * enumeration would silently miss each newly extracted mechanics directory
 * (it already missed `tui/keybindings/**` and `tui/commands/**`), and the rule's
 * contract is "never depend on another concrete TUI mechanics module". A core
 * module that needs something from `src/tui/**` else has a renderer-specific
 * helper that belongs under `tui/components/**` (or stays in TuiApp) and must be
 * split, never allowlisted.
 */
const TRANSCRIPT_CORE_OWN_SUBTREE = 'tui/transcript/'

const TRANSCRIPT_CORE_FORBIDDEN_PACKAGES = ['@xmoon76/pi-tui', '@stencil-hq/tern']

const TRANSCRIPT_CORE_FORBIDDEN_TARGETS = new Set([
  // The TUI command facade/coordinator (the command layer's transitional root).
  'commands.ts',
  'tui-app.ts',
  // TS8-E: the retired root theme module stays a guard (a forwarding shim at
  // the retired path would be silently legal otherwise); the live terminal
  // palette/TUI themes now live at `tui/theme/runtime.ts`, already covered by
  // the `tui/**` prefix rule.
  'theme.ts',
  // The concrete renderer registry moved under the extension boundary (TS8-E);
  // both its retired root path and its canonical `extension/internal/**` path
  // stay forbidden to the core (the root path is a retired-shim guard).
  'renderer-registry.ts',
  'extension/internal/renderer-registry.ts',
  // TS7: the core consumes the canonical `domain/transcript/**` owners
  // directly. The semantic root facade and the three retired semantic roots
  // must never be re-entered (a forwarding shim at a retired path would be
  // silently legal otherwise).
  'transcript.ts',
  'transcript-semantics.ts',
  'context-presentation.ts',
  'transcript-window.ts',
])

/**
 * The Stable extension PUBLIC declaration sources (plan §21 #5): the published
 * package entries and their public type modules. A third-party plugin author
 * must be able to name every public extension contract without reaching the
 * project's TUI implementation, so these modules are a closed public face —
 * the concrete registries under `extension/internal/**` keep their reviewed
 * key-policy / terminal-rendering adapter edges, but the public sources may
 * never import `tui/**` or the `tui-app.ts` facade.
 */
const EXTENSION_PUBLIC_DECLARATION_SOURCES = new Set([
  'extensions.ts',
  'extension/public-types.ts',
  'extension/advanced.ts',
  'extension/advanced-types.ts',
  'extension/unstable.ts',
  'extension/unstable-types.ts',
])

/**
 * True when a `tui/transcript/**` import reaches concrete renderer mechanics.
 * A bare package specifier keeps its bare text as `resolved`, so the vendored
 * fork and the future Tern SDK are matched on the specifier; a relative import
 * arrives canonicalized to its on-disk `src/`-relative target.
 * @param {string} resolved canonicalized target (or bare specifier)
 * @param {string} specifier the raw import specifier
 */
export function isTranscriptRendererMechanics(resolved, specifier) {
  if (TRANSCRIPT_CORE_FORBIDDEN_PACKAGES.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`))) return true
  // Any other TUI-layer owner (components, panels, pickers, interaction,
  // keybindings, commands, footer, notification, plugin-manager, …) is
  // mechanics; only the core's own subtree is part of the core.
  if (resolved.startsWith('tui/') && !resolved.startsWith(TRANSCRIPT_CORE_OWN_SUBTREE)) return true
  return TRANSCRIPT_CORE_FORBIDDEN_TARGETS.has(resolved)
}

const DOMAIN_TRANSCRIPT_FORBIDDEN_PACKAGES = ['@xmoon76/pi-tui', '@stencil-hq/tern']

/**
 * The canonical TYPE-ONLY edges the `domain/transcript/**` authority may
 * consume: `domain/display/icons.ts` because the domain carries the existing
 * `IconSemantic` compatibility field and the canonical neutral icon vocabulary
 * now lives there (TS8-D), and the neutral structural live port (plan §18)
 * whose data vocabulary is transport-neutral. The closed-world contract admits
 * ONLY the type spelling of these two owners; value and literal-dynamic
 * spellings stay forbidden so the semantic authority never takes a runtime
 * dependency on them.
 */
const DOMAIN_TRANSCRIPT_TYPE_ONLY_EDGES = new Set([
  'domain/display/icons.ts',
  'runtime/assistant-stream-port.ts',
])

/**
 * The TS7/TS8-D sublayer contract for `domain/transcript/**`, expressed
 * CLOSED-WORLD: every relative edge must be either
 *   - a `domain/transcript/**` sibling, or
 *   - a TYPE-ONLY import of one of {@link DOMAIN_TRANSCRIPT_TYPE_ONLY_EDGES}.
 * Anything else (`tui/**`, `app/**`, `runtime/direct|remote/**`, `commands.ts`,
 * `search-overlay.ts`, `transcript.ts`, `theme.ts`, `tui-app.ts`/
 * `renderer-registry.ts`, any transitional or legacy root module, …) FAILS by
 * default, so a future escape hatch must be added deliberately instead of being
 * missed by a forbidden list. TS8-D removed the last transitional root VALUE
 * edge: the set is empty and can never grow back through this rule.
 *
 * Bare package specifiers keep the long-lived package-face contract: the vendored
 * PiTui fork, the Tern SDK and experimental Remote composition faces are
 * forbidden; official DSH semantic packages stay allowed (the client-boundary
 * gate owns Host-service coupling).
 *
 * The four generic `domain-imports-*` / Direct rules exclude this subtree from
 * their `applies` (see {@link isDomainTranscriptSubtree}), so this rule is the
 * single owner of its static AND literal-dynamic edges.
 * @param {string} resolved canonicalized target (or bare specifier)
 * @param {string} specifier the raw import specifier
 * @param {{ typeOnly?: boolean }} [meta] the edge kind (defaults to a value edge)
 * @returns {boolean} true when the edge violates the contract
 */
export function isDomainTranscriptBackendMechanics(resolved, specifier, meta = {}) {
  if (DOMAIN_TRANSCRIPT_FORBIDDEN_PACKAGES.some(pkg => specifier === pkg || specifier.startsWith(`${pkg}/`))) return true
  if (isRemoteComposition(resolved, specifier)) return true
  // A bare specifier is an npm package/subpath, never a `src/**` owner: the
  // package-face rules above are the whole contract for it.
  if (!specifier.startsWith('.')) return false
  if (resolved.startsWith('domain/transcript/')) return false
  if (meta.typeOnly === true && DOMAIN_TRANSCRIPT_TYPE_ONLY_EDGES.has(resolved)) return false
  return true
}

/** The TS7 transcript semantic-authority subtree, owned by the specific
 * `domain-transcript-imports-backend-mechanics` rule instead of the generic
 * `domain-imports-*` / Direct rules (the same single-owner carve-out the Remote
 * rule uses for `app/remote/**`). */
export function isDomainTranscriptSubtree(srcRel) {
  return srcRel.startsWith('domain/transcript/')
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
    id: 'runtime-imports-tui',
    message: 'src/runtime/** must not import src/tui/** (the semantic/adaptor layer never depends on terminal presentation)',
    applies: (srcRel) => srcRel.startsWith('runtime/'),
    forbids: (resolved) => resolved.startsWith('tui/'),
  },
  {
    // TS8-B closes the locality direction for the Client-local capability:
    // `src/client/**` is the INNER platform layer, exactly like `app/` and
    // `tui/`, and the Host semantic/adaptor layer must never depend on it. A
    // runtime adapter reaching a Client capability means the fact was
    // misclassified (or the dependency inverted) and must be split, never
    // allowlisted.
    id: 'runtime-imports-client',
    message:
      'src/runtime/** must not import src/client/** (Client-local platform capability is the inner layer; '
      + 'the Host semantic/adaptor layer never depends on it)',
    applies: (srcRel) => srcRel.startsWith('runtime/'),
    forbids: (resolved) => resolved.startsWith('client/'),
    // A literal VALUE dynamic import reaches the same Client module as a
    // static one; without this opt-in `await import('.../client/...')` would
    // be an equivalent spelling that silently enters the layer later with a
    // green gate (the same escape hatch `app-imports-tui` already closes).
    checksValueDynamicImport: true,
  },
  {
    // TS3 creates the first canonical `src/domain/**` subtree (the
    // transport/UI-neutral status model). The layer is neutral by contract:
    // application ownership, terminal presentation and experimental Remote
    // composition are all off limits. The existing Direct-import rule already
    // covers `app/direct/**` / `runtime/direct/**` for these files, so no
    // duplicate Direct rule is added here.
    id: 'domain-imports-app',
    message: 'src/domain/** must not import src/app/** (the neutral domain layer never depends on application ownership)',
    // `domain/transcript/**` is owned by the TS7 rule below (single owner for
    // its static AND literal-dynamic edges); `app/remote/**` outside that
    // subtree is reported by the more specific Remote rule, so each violation
    // has exactly one owning rule id.
    applies: (srcRel) => srcRel.startsWith('domain/') && !isDomainTranscriptSubtree(srcRel),
    forbids: (resolved) => resolved.startsWith('app/') && !resolved.startsWith('app/remote/'),
  },
  {
    id: 'domain-imports-tui',
    message: 'src/domain/** must not import src/tui/** (the neutral domain layer never depends on terminal presentation)',
    applies: (srcRel) => srcRel.startsWith('domain/') && !isDomainTranscriptSubtree(srcRel),
    forbids: (resolved) => resolved.startsWith('tui/'),
  },
  {
    id: 'domain-imports-remote-composition',
    message: 'src/domain/** must not import experimental Remote composition (domain primitives stay transport-neutral)',
    applies: (srcRel) => srcRel.startsWith('domain/') && !isDomainTranscriptSubtree(srcRel),
    forbids: (resolved, specifier) => isRemoteComposition(resolved, specifier),
  },
  {
    // TS8-A creates the canonical `src/client/**` capability layer (the
    // Client-local, non-TUI platform capability). It is the INNER layer: the
    // neutral domain never depends on it, exactly like it never depends on
    // app/ or tui/. `domain/transcript/**` keeps its own closed-world rule.
    id: 'domain-imports-client',
    message:
      'src/domain/** must not import src/client/** (the neutral domain layer never depends on '
      + 'Client-local platform capability)',
    applies: (srcRel) => srcRel.startsWith('domain/') && !isDomainTranscriptSubtree(srcRel),
    forbids: (resolved) => resolved.startsWith('client/'),
  },
  {
    // TS8-A makes the Client-local capability an explicit layer: Client-local
    // state never owns Host business authority and never reaches into the
    // Host transport/composition. `runtime/direct/**` is already closed by the
    // Direct rule below; this rule closes the Remote side.
    id: 'client-imports-remote-composition',
    message:
      'src/client/** is Client-local platform capability and must not import experimental Remote composition '
      + '(Client-local state never depends on the Host transport)',
    applies: (srcRel) => srcRel.startsWith('client/'),
    forbids: (resolved, specifier) => isRemoteComposition(resolved, specifier),
  },
  {
    id: 'direct-import-outside-composition',
    message:
      'only src/index.ts, src/app/bootstrap.ts, src/app/direct/** and src/runtime/** may import '
      + 'src/app/direct/** or src/runtime/direct/** (non-Direct app owners and presentation consume ports/Backend/callbacks)',
    applies: (srcRel) => !isDirectCompositionFile(srcRel) && !isDomainTranscriptSubtree(srcRel),
    forbids: (resolved) => resolved.startsWith('app/direct/') || resolved.startsWith('runtime/direct/'),
  },
  {
    // TS2 fixes the composition zone's INTERNAL direction (plan §7.2/§54). The
    // three contracts below are deliberately separate rules, so "the entry may
    // import the facade but not its implementation helpers" and "a helper may
    // import siblings but never the facade" are each their own mechanical
    // invariant instead of one blanket exemption of index.ts + the whole zone
    // (which would let `index.ts -> app/bootstrap/lifecycle.ts` and
    // `app/bootstrap/lifecycle.ts -> app/bootstrap.ts` through).
    //
    // Contract 1: the package entry uses the FACADE only.
    id: 'entry-imports-bootstrap-helper',
    message:
      'src/index.ts may import the app/bootstrap.ts facade only — the src/app/bootstrap/** helpers are '
      + 'implementation, never the package entry (index -> facade -> helpers)',
    applies: (srcRel) => srcRel === 'index.ts',
    forbids: (resolved) => resolved.startsWith('app/bootstrap/'),
  },
  {
    // Contract 2: a helper never imports the facade. `bootstrap.ts -> helper`
    // and `helper -> sibling helper` are both legal; the reverse edge is the
    // value cycle the frozen direction forbids.
    id: 'helper-imports-bootstrap-facade',
    message:
      'a src/app/bootstrap/** composition helper must not import the app/bootstrap.ts facade — the facade '
      + 'imports helpers, never the reverse (a facade<->helper value cycle)',
    applies: (srcRel) => srcRel.startsWith('app/bootstrap/'),
    forbids: (resolved) => resolved === 'app/bootstrap.ts',
  },
  {
    // Contract 3: everyone else stays outside the zone entirely. The forbidden
    // target is the WHOLE composition zone, not one path: a helper module that
    // owns wiring is still composition, so an application owner importing
    // `app/bootstrap/lifecycle.ts` inverts the dependency exactly like importing
    // the facade.
    id: 'owner-imports-bootstrap',
    message:
      'application owners must not import the src/app/bootstrap.ts facade or the src/app/bootstrap/** '
      + 'composition-helper zone (index -> facade -> helpers -> owners)',
    applies: (srcRel) => srcRel !== 'index.ts' && !isBootstrapCompositionFile(srcRel),
    forbids: (resolved) => isBootstrapCompositionFile(resolved),
  },
  {
    // TS4: the TUI implementation layer (`src/tui/**`) may be selected only by
    // the composition zone. Application owners consume semantic contracts and
    // injected narrow factories (`app/surface/plugin-manager-runtime` takes a
    // panel FACTORY, never the panel module), so a concrete TUI import from an
    // app owner is an inverted dependency. `src/app/bootstrap.ts` and
    // `src/app/bootstrap/**` are exempt because wiring the concrete Client/TUI
    // implementation is exactly what the composition zone does.
    id: 'app-imports-tui',
    message:
      'src/app/** outside the bootstrap composition zone must not import src/tui/** (app owners consume '
      + 'semantic contracts / injected factories; the composition zone selects concrete TUI implementations)',
    applies: (srcRel) => srcRel.startsWith('app/') && !isBootstrapCompositionFile(srcRel),
    forbids: (resolved) => resolved.startsWith('tui/'),
    // A literal VALUE dynamic import (`await import('.../tui/...')`) reaches the
    // same concrete module as a static one, and `parseImportSpecifiers()` (the
    // list every other rule consumes) does not see it — it is parsed by
    // `parseValueDynamicImports()`. Without this flag the lock would have an
    // escape hatch. Only rules that opt in are evaluated against dynamic
    // imports, because the sanctioned Remote lazy edge
    // (`runtime/backend-loader.ts` -> `app/remote/runtime.ts`) must stay a
    // dynamic, runtime-selected edge and would be re-classified by the generic
    // runtime/app rules if they were applied to dynamic imports wholesale.
    checksValueDynamicImport: true,
  },
  {
    // TS1 broadens the v1 command-layer rule to the whole long-lived TUI layer
    // (`src/tui/**`). `src/commands.ts` stays in scope as the TUI command
    // layer's transitional facade/coordinator: it owns the dynamic skill
    // wrappers and the catalog coordinator for the same definitions, so it
    // consumes the same semantic/application-facing contracts. This is strictly
    // stronger than the plan's `tui/**` scope, with no allowlist.
    id: 'tui-imports-remote-composition',
    message:
      'src/tui/** (and the src/commands.ts command-layer facade) must not import experimental Remote composition '
      + '(terminal presentation consumes semantic/application-facing contracts only)',
    applies: (srcRel) => srcRel.startsWith('tui/') || srcRel === 'commands.ts',
    forbids: (resolved, specifier) => isRemoteComposition(resolved, specifier),
  },
  {
    // TS6: `src/tui/transcript/**` is the backend-neutral transcript
    // presentation core consumed by BOTH the current PiTui mechanics and a
    // future TSP mechanics. It must stay blind to concrete renderer chrome —
    // the direction is `PiTui mechanics -> tui/transcript -> semantic
    // transcript facts`, never the reverse. A core module needing theme, icons,
    // width/component mechanics, TuiApp or the renderer registry means the
    // helper was misclassified and must be split into `tui/components/**`,
    // not allowlisted here.
    id: 'tui-transcript-imports-renderer-mechanics',
    message:
      'src/tui/transcript/** is the backend-neutral transcript presentation core: it must not import PiTui, Tern, '
      + 'TuiApp, theme/icons, the renderer registry or another concrete TUI mechanics module (split the helper instead of allowlisting it)',
    applies: (srcRel) => srcRel.startsWith('tui/transcript/'),
    forbids: (resolved, specifier) => isTranscriptRendererMechanics(resolved, specifier),
    // A literal `await import('...')` reaches the same module as a static
    // import; a rule that only consumed `parseImportSpecifiers()` would leave
    // an escape hatch for both the relative component target and the bare
    // package specifier. `checksBareDynamicImport` is therefore opted into here
    // and NOWHERE else: the older rules keep their exact baseline scope, where a
    // non-relative dynamic specifier was never resolved into a target.
    checksValueDynamicImport: true,
    checksBareDynamicImport: true,
  },
  {
    // TS7: `src/domain/transcript/**` is the ONE transcript semantic/lifecycle
    // authority (the fold, classification, Context form/provenance, Workflow
    // projection, search corpus, grouping and window semantics). It is
    // transport- and UI-neutral by contract: the direction is
    // `PiTui mechanics -> tui/transcript -> domain/transcript`, so a domain
    // module reaching a renderer/backend owner means the fact was misclassified
    // and must be split, never allowlisted. The rule is CLOSED-WORLD (see
    // `isDomainTranscriptBackendMechanics`): only domain siblings and the two
    // TYPE-ONLY compatibility edges are admitted. It also carries the
    // type-only discriminator, so a value import can never ride along on a
    // type-only allowance.
    id: 'domain-transcript-imports-backend-mechanics',
    message:
      'src/domain/transcript/** is the transport/UI-neutral transcript semantic authority: it may import only its domain '
      + 'siblings, the canonical TYPE-ONLY edges (domain/display/icons.ts, runtime/assistant-stream-port.ts) and official DSH semantic packages — every other edge '
      + '(tui/**, app/**, runtime/direct|remote, commands.ts, transcript.ts, any transitional/legacy root, PiTui, Tern, …) must be split instead',
    applies: (srcRel) => isDomainTranscriptSubtree(srcRel),
    forbids: (resolved, specifier, meta) => isDomainTranscriptBackendMechanics(resolved, specifier, meta),
    checksValueDynamicImport: true,
    checksBareDynamicImport: true,
  },
  {
    // TS8-E (plan §21 #5): the Stable extension PUBLIC declaration sources are
    // the published plugin face. A public type must be nameable without the
    // project's TUI implementation, so these sources never import `tui/**` or
    // the `tui-app.ts` facade. This is a PUBLIC-source rule only: the concrete
    // registries under `extension/internal/**` keep their reviewed key-policy
    // (`tui/keybindings/**`) and terminal-rendering (`tui/theme/runtime.ts`)
    // adapter edges, which this rule deliberately does not govern.
    id: 'extension-public-declaration-imports-tui',
    message:
      'the Stable extension public declaration sources (src/extensions.ts and extension/public-types|advanced-types|unstable-types.ts, '
      + 'their public entries) must not import project TUI implementation types (tui/**, tui-app.ts) — a public plugin contract stays free of terminal mechanics',
    applies: (srcRel) => EXTENSION_PUBLIC_DECLARATION_SOURCES.has(srcRel),
    forbids: (resolved) => resolved.startsWith('tui/') || resolved === 'tui-app.ts',
    checksValueDynamicImport: true,
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
 * The TypeScript parser kind for one production source path. `.tsx` must be
 * parsed as TSX, otherwise a legal JSX tree hides its `import('...')` TYPE
 * queries and the dependency rules can be bypassed by the file extension. The
 * `.ts`/`.mts`/`.cts` grammar (generics, angle-bracket assertions) is unchanged.
 * @param {string} rel src-relative path (or a synthetic name; default `module.ts`)
 * @returns {import('typescript').ScriptKind}
 */
export function scriptKindOf(rel = 'module.ts') {
  return rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/**
 * Strip the transparent expression wrappers that do not change WHICH node an
 * expression refers to: parentheses, `as`/`satisfies` casts, the `<T>`
 * assertion and the non-null `!` operator. Every consumer must classify the
 * referenced node, not its spelling — otherwise each wrapper is an equivalent
 * spelling that silently escapes the rule:
 *
 * ```text
 * await import('...')                  plain
 * await import(('...'))                parenthesized (plain JS)
 * await import('...' as string)        as-cast
 * await import('...' satisfies string) satisfies
 * await import(<string>'...')          angle-bracket assertion
 * await import('...'!)                 non-null
 * ```
 *
 * A `${…}` substitution, string concatenation and a non-identifier argument are
 * genuinely dynamic values and stay outside a static dependency gate's scope.
 * @param {import('typescript').Expression} expr the candidate expression
 * @returns {import('typescript').Expression} the innermost wrapped expression
 */
function unwrapExpression(expr) {
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

/**
 * Extract every STATIC import/export-from/import-equals specifier AND every
 * `import('...')` TYPE query (`type T = import('...').T` / `typeof import(...)`)
 * with its 1-based line number and whether it is TYPE-ONLY, via the TypeScript
 * parser (the file kind follows `rel`, so `.tsx` JSX is parsed as TSX). Comments
 * and multi-line `from` clauses are handled correctly; a VALUE dynamic
 * `import('...')` call is intentionally not a static edge.
 *
 * The module-specifier positions handled here are restricted by the language
 * grammar to a string literal token (`import`/`export … from`),
 * a string literal type (`import('...').T` / `typeof import('...')`) or a
 * `require('...')` string argument, so no wrapper can appear in them: both
 * `import(('./a.ts')).T` and `import x = require(('./a.ts'))` are
 * `TS1141 String literal expected` and cannot compile.
 * @param {string} source file contents
 * @param {string} [rel] src-relative path (drives the parser kind)
 * @returns {Array<{ specifier: string, line: number, typeOnly: boolean }>}
 */
export function parseImportSpecifiers(source, rel = 'module.ts') {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, false, scriptKindOf(rel))
  const out = []
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const importTypeArgument = (node) => {
    const arg = node.argument
    // The type argument is grammar-restricted to a string literal TYPE: the
    // template-literal and parenthesized spellings are `TS1141 String literal
    // expected` and cannot compile, so no wrapper/literal-kind leniency belongs
    // here (unlike the VALUE dynamic import argument, which is an ordinary
    // expression position and is unwrapped by `unwrapExpression`).
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
 * Extract every VALUE dynamic `import('...')` call with its 1-based line
 * number (the form `parseImportSpecifiers` deliberately ignores), where the
 * specifier is STATICALLY KNOWN: a string literal or a template literal with no
 * substitution (`` import(`./x.ts`) ``, which the AST classifies as
 * `NoSubstitutionTemplateLiteral`, NOT `StringLiteral`). Both spellings are
 * equivalent module references, so classifying on `StringLiteral` alone would
 * leave an equivalent spelling out of every consumer of this primitive.
 * A `${…}` substitution is a genuinely dynamic expression and stays outside a
 * static dependency gate's scope, as do static imports, export-from clauses and
 * `import('...')` TYPE queries (all handled by `parseImportSpecifiers`).
 * @param {string} source file contents
 * @param {string} [rel] src-relative path (drives the parser kind; `.tsx` => TSX)
 * @returns {Array<{ specifier: string, line: number }>}
 */
export function parseValueDynamicImports(source, rel = 'module.ts') {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, false, scriptKindOf(rel))
  const out = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length > 0
    ) {
      const argument = unwrapExpression(node.arguments[0])
      if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
        out.push({ specifier: argument.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Rule: `app/remote/**` may be reached by a VALUE dynamic import only through
 * the sanctioned lazy boundary edge — the single owner
 * (`runtime/backend-loader.ts`), its ONE target (`app/remote/runtime.ts`,
 * the entry module that statically re-exports the application-runtime
 * aggregate), and exactly ONE import expression for that target (the frozen
 * "ONE dynamic edge" is one owner + one expression + one target). The check
 * is scoped to the Remote composition boundary — dynamic imports of anything
 * else stay out of scope.
 * @param {Array<{ rel: string, source: string }>} entries
 * @returns {Array<{ file: string, line: number, rule: string, detail: string }>}
 */
export function findRemoteDynamicImportViolations(entries) {
  const known = new Set(entries.map(entry => entry.rel))
  const violations = []
  const sanctionedEdges = []
  for (const { rel, source } of entries) {
    for (const { specifier, line } of parseValueDynamicImports(source, rel)) {
      const resolved = resolveRelativeImport(rel, specifier)
      if (resolved === undefined) continue
      const target = staticImportCandidates(resolved).find(candidate => known.has(candidate)) ?? resolved
      if (!target.startsWith('app/remote/')) continue
      if (rel === REMOTE_DYNAMIC_IMPORT_OWNER && target === REMOTE_DYNAMIC_IMPORT_TARGET) {
        sanctionedEdges.push({ rel, target, line })
        continue
      }
      violations.push({
        file: rel,
        line,
        rule: 'remote-dynamic-import-owner',
        detail: `only ${REMOTE_DYNAMIC_IMPORT_OWNER} may dynamically import ${REMOTE_DYNAMIC_IMPORT_TARGET} `
          + `(found ${rel} -> ${specifier})`,
      })
    }
  }
  if (sanctionedEdges.length > 1) {
    violations.push({
      file: sanctionedEdges[1].rel,
      line: sanctionedEdges[1].line,
      rule: 'remote-dynamic-import-owner',
      detail: `${REMOTE_DYNAMIC_IMPORT_OWNER} must carry exactly ONE dynamic import expression for `
        + `${REMOTE_DYNAMIC_IMPORT_TARGET} (found ${sanctionedEdges.length})`,
    })
  }
  return violations
}

/**
 * Names constructed via `new Direct<...>(...)` in `source` (AST-based: comments
 * never match, and parenthesized / `as`-cast / non-null constructor references
 * are unwrapped). Alias or factory indirection cannot be resolved statically and
 * is out of scope.
 * @param {string} source file contents
 * @param {string} [rel] src-relative path (drives the parser kind; `.tsx` => TSX)
 */
export function findDirectAdapterConstructions(source, rel = 'module.ts') {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, false, scriptKindOf(rel))
  const out = []
  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      const expr = unwrapExpression(node.expression)
      if (ts.isIdentifier(expr) && /^Direct[A-Za-z0-9_]*$/u.test(expr.text)) {
        out.push({ name: expr.text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * Every source file under `dir` whose extension is in `extensions`, enumerated
 * RECURSIVELY, as `dir`-relative POSIX paths, deterministically sorted.
 * `node_modules`/`dist` are skipped.
 *
 * This is the ONE recursive enumeration the zone scanners share. A scanner that
 * read only one directory level would let a NESTED `src/app/bootstrap/**` module
 * escape the composition-zone string/handler/bag/keybinding locks while the
 * architecture gate (which treats the directory as the zone) still accepts it
 * (TS2 §7/§18/§20/§21: the zone is the whole subtree).
 * @param {string} dir directory to walk
 * @param {string[]} [extensions] extensions to include (default: the production set)
 * @returns {string[]}
 */
export function listSourceFilesUnder(dir, extensions = SOURCE_EXTENSIONS) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(p)
      } else if (extensions.some(extension => entry.name.endsWith(extension))) {
        out.push(relative(dir, p).split('\\').join('/'))
      }
    }
  }
  walk(dir)
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Read every TypeScript source under `dir` as a `{ rel, source }` entry (recursive). */
export function collectSourceEntries(dir = SRC) {
  return listSourceFilesUnder(dir).map(rel => ({ rel, source: readFileSync(join(dir, rel), 'utf8') }))
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
  if (resolved.endsWith('.ts') || resolved.endsWith('.tsx') || resolved.endsWith('.mts') || resolved.endsWith('.cts')) return [resolved]
  // TypeScript NodeNext emitted-extension substitution, verified against
  // `ts.resolveModuleName`:
  //   `.js`  -> `.ts`, `.tsx`, `.d.ts`
  //   `.jsx` -> `.tsx`, `.ts`, `.d.ts`
  if (resolved.endsWith('.js')) {
    const stem = resolved.slice(0, -3)
    return [`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, resolved]
  }
  if (resolved.endsWith('.jsx')) {
    const stem = resolved.slice(0, -4)
    return [`${stem}.tsx`, `${stem}.ts`, `${stem}.d.ts`, resolved]
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
    `${resolved}.tsx`,
    `${resolved}.mts`,
    `${resolved}.cts`,
    `${resolved}.d.ts`,
    `${resolved}.d.mts`,
    `${resolved}.d.cts`,
    `${resolved}/index.ts`,
    `${resolved}/index.tsx`,
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
    for (const { specifier } of parseImportSpecifiers(source, rel)) {
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
  const violations = [...findRemoteDynamicImportViolations(entries)]
  const imports = new Map()
  const sourceByRel = new Map()
  for (const { rel, source } of entries) {
    imports.set(rel, parseImportSpecifiers(source, rel))
    sourceByRel.set(rel, source)
  }
  const known = new Set(entries.map(entry => entry.rel))

  for (const { rel } of entries) {
    for (const { specifier, line, typeOnly } of imports.get(rel)) {
      // Canonicalize to the REAL on-disk source target from the scanned set, so
      // every legal NodeNext spelling of the same module (`../bootstrap.ts`,
      // `../bootstrap.js`, `../bootstrap`) is evaluated identically by
      // ARCHITECTURE_RULES and cannot bypass a rule through its emitted
      // extension. A non-relative specifier keeps its bare text; a relative
      // specifier with no on-disk candidate keeps its resolved src-relative path.
      const relative = resolveRelativeImport(rel, specifier)
      const target = relative === undefined
        ? specifier
        : staticImportCandidates(relative).find(candidate => known.has(candidate)) ?? relative
      for (const rule of ARCHITECTURE_RULES) {
        if (!rule.applies(rel)) continue
        // The edge kind travels with the resolved target so a rule can draw a
        // type-only line (e.g. the TS7 domain's `domain/display/icons.ts` /
        // `assistant-stream-port.ts` allowances) instead of allowlisting the
        // target wholesale for value imports too.
        if (!rule.forbids(target, specifier, { typeOnly })) continue
        // An allowlist entry excuses ONLY a type-only import of that target.
        if (typeOnly && allowlist.has(`${rel}:${target}`)) continue
        violations.push({ file: rel, line, rule: rule.id, detail: `${rule.message} (${specifier})` })
      }
    }
    // A literal VALUE dynamic import never reaches `parseImportSpecifiers()`, so
    // a rule that only consumes that list would be bypassed by
    // `await import('.../tui/...')`. Rules that opt in are evaluated against
    // `parseValueDynamicImports()` too, with the same canonicalized target: a
    // relative specifier canonicalizes to its on-disk target, a bare package
    // specifier keeps its bare text (the same convention the static loop uses).
    // A rule sees a BARE specifier only when it opts into
    // `checksBareDynamicImport`: the older rules must keep their exact baseline
    // scope, where a non-relative dynamic specifier was never a target (a bare
    // `tui/widget` is an npm package/subpath, not `src/tui/**`).
    for (const rule of ARCHITECTURE_RULES) {
      if (rule.checksValueDynamicImport !== true) continue
      if (!rule.applies(rel)) continue
      for (const { specifier, line } of parseValueDynamicImports(sourceByRel.get(rel), rel)) {
        const dynamicRelative = resolveRelativeImport(rel, specifier)
        if (dynamicRelative === undefined && rule.checksBareDynamicImport !== true) continue
        const target = dynamicRelative === undefined
          ? specifier
          : staticImportCandidates(dynamicRelative).find(candidate => known.has(candidate)) ?? dynamicRelative
        if (!rule.forbids(target, specifier)) continue
        violations.push({ file: rel, line, rule: rule.id, detail: `${rule.message} (${specifier})` })
      }
    }
    if (rel.startsWith('app/surface/')) {
      for (const { name, line } of findDirectAdapterConstructions(sourceByRel.get(rel), rel)) {
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

/** The checked-in shrinking baseline of ROOT production modules (plan §20.3). */
export const SOURCE_ROOT_BASELINE_PATH = join(ROOT, 'scripts/source-root-baseline.json')

/** Read and shape-check the source-root baseline. Never auto-writes. */
export function readSourceRootBaseline(path = SOURCE_ROOT_BASELINE_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const isNameList = (value) => Array.isArray(value) && value.every(name => typeof name === 'string' && name !== '')
  if (raw.version !== 1 || !isNameList(raw.stable) || !isNameList(raw.legacy)) {
    throw new Error(`unsupported source-root baseline schema in ${path} (expected { version: 1, stable: string[], legacy: string[] })`)
  }
  return { version: raw.version, stable: raw.stable, legacy: raw.legacy }
}

/** Every ROOT production module (`src/*.ts|.tsx|.mts|.cts`), sorted, directories excluded. */
export function listSourceRootFiles(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && SOURCE_EXTENSIONS.some(extension => entry.name.endsWith(extension)))
    .map(entry => entry.name)
    .sort()
}

/**
 * Root-placement enforcement (plan §20.3): a current root module must be in
 * `stable ∪ legacy`; a `legacy` entry must still exist (stale entries are
 * removed by the PR that moves the file); a `stable` entry must still exist
 * (the facade contract changes deliberately with docs + baseline); duplicates
 * and unknown schema fail closed. The baseline is a shrinking migration
 * ledger, never an exemption mechanism.
 */
export function findSourceRootViolations(baseline, currentRootFiles) {
  const violations = []
  const current = new Set(currentRootFiles)
  const stable = new Set(baseline.stable)
  const legacy = new Set(baseline.legacy)
  for (const name of stable) {
    if (legacy.has(name)) violations.push(`src/${name} is listed in BOTH stable and legacy`)
  }
  const known = new Set([...stable, ...legacy])
  for (const name of current) {
    if (!known.has(name)) {
      violations.push(`new unclassified root production module: src/${name} (place it in a canonical layer: app/runtime/domain/client/tui/extension)`)
    }
  }
  for (const name of legacy) {
    if (!current.has(name)) {
      violations.push(`stale baseline entry: src/${name} no longer exists — remove its legacy entry in the same PR that moved/deleted it`)
    }
  }
  for (const name of stable) {
    if (!current.has(name)) {
      violations.push(`stable root entry missing: src/${name} — update the facade contract, docs and baseline deliberately`)
    }
  }
  return violations
}

/**
 * Historical feature directories retired by a completed ownership stage. TS8-A
 * retires the mixed `src/file-completion/**` directory: its single owners are
 * now canonical — `domain/file-completion/**` (neutral query/ranking/discovery
 * policy), `client/file-completion/**` (Client-local filesystem completion),
 * `tui/file-completion/**` (trigger + presentation) and
 * `runtime/direct/file-completion/**` (Direct WORKSPACE compatibility IO).
 *
 * TS8-C retires the mixed media/platform directories `src/image/**` and
 * `src/attachment/**`: their owners are now canonical — `domain/media/**`
 * (neutral media vocabulary/failures/formatting), `client/media/**` +
 * `client/clipboard/**` + `client/url/**` (Client-local capability) and
 * `app/submission/direct-*.ts` + `runtime/prepared-prompt.ts` (application
 * Direct preparation and the transport-neutral prepared prompt).
 *
 * New completion/media/platform code belongs to its canonical layer;
 * recreating an old mixed directory fails closed. Each later TS8 stage adds
 * its own entry as it retires the next historical directory.
 */
export const RETIRED_SOURCE_DIRECTORIES = ['file-completion', 'image', 'attachment']

/** Every directory directly under `src/`, sorted (the placement layer's own walk). */
export function listSourceRootDirectories(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

/**
 * Fail-closed retired-directory check: a historical feature directory retired
 * by a completed stage must not reappear under `src/`. This is the
 * directory-level companion of {@link findSourceRootViolations} — the root
 * ledger governs root MODULES, this governs the retired SUBTREE placements, so
 * neither can be bypassed by choosing the other shape.
 */
export function findRetiredSourceDirectoryViolations(directories = listSourceRootDirectories()) {
  const present = new Set(directories)
  return RETIRED_SOURCE_DIRECTORIES
    .filter(name => present.has(name))
    .map(name => `src/${name}/ is a retired historical feature directory — its owners are canonical `
      + '(domain/client/tui/runtime/direct); place new code in its canonical layer instead')
}

function main() {
  const entries = collectSourceEntries()
  const rootViolations = findSourceRootViolations(readSourceRootBaseline(), listSourceRootFiles())
  const retiredViolations = findRetiredSourceDirectoryViolations()
  if (process.argv.includes('--report')) {
    console.log(`application-architecture-gate: scanned ${entries.length} src file(s)`)
    for (const rule of ARCHITECTURE_RULES) console.log(`  rule ${rule.id}`)
    console.log(`  rule ${STARTUP_REMOTE_COMPOSITION_RULE.id}`)
    console.log('  rule remote-dynamic-import-owner')
    console.log('  rule surface-constructs-direct-adapter')
    console.log('  composition zone: app/bootstrap.ts + app/bootstrap/**')
    const baseline = readSourceRootBaseline()
    console.log(`  source-root baseline: ${baseline.stable.length} stable + ${baseline.legacy.length} legacy root module(s)`)
    console.log(`  retired feature directories: ${RETIRED_SOURCE_DIRECTORIES.join(', ')}`)
    return
  }
  const violations = findViolations(entries)
  if (retiredViolations.length > 0) {
    console.error('application-architecture-gate: retired source directory recreated:')
    for (const detail of retiredViolations) console.error(`  ${detail}`)
    console.error('\nSee docs/architecture.md (source module placement).')
    process.exit(1)
  }
  if (rootViolations.length > 0) {
    console.error('application-architecture-gate: source-root placement violated:')
    for (const detail of rootViolations) console.error(`  ${detail}`)
    console.error('\nSee docs/architecture.md (source module placement).')
    process.exit(1)
  }
  if (violations.length > 0) {
    console.error('application-architecture-gate: application-layer dependency direction violated:')
    for (const v of violations) console.error(`  src/${v.file}:${v.line} [${v.rule}] ${v.detail}`)
    console.error('\nSee docs/architecture.md and docs/client-server-migration.md.')
    process.exit(1)
  }
  console.log(`application-architecture-gate: ok (${entries.length} file(s), dependency direction clean)`)
}

if (process.argv[1] && relative(ROOT, process.argv[1]).replace(/\\/g, '/') === 'scripts/application-architecture-gate.mjs') {
  main()
}
