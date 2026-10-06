import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

import { compositionFile, compositionFilesUnder, compositionOccurrences, compositionSource, compositionSourceUnder, compositionSources } from './support/composition-surface.ts'
import {
  aliasAwareConstructionSites,
  ownerFile,
  ownerOccurrences,
  productionFilesUnder,
  productionScriptKind,
  productionSource,
  productionSources,
  productionSourcesUnder,
  unwrapExpression,
} from './support/owner-modules.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

/**
 * A5 composition-inventory locks (plan §22/§23/§29/§44 A5-0).
 *
 * These freeze the POST-A4 composition inventory: the runner scope owns the
 * process/application composition (lifetime controller, diagnostics, Host
 * service resolution, the five application owners, the mount, the command
 * facade, the disposal/fatal orchestration) and every one of those
 * responsibilities has EXACTLY ONE owner.
 *
 * They are written against the composition surface (`src/index.ts` +
 * `src/app/bootstrap.ts`, see `./support/composition-surface.ts`) so the same
 * facts hold before and after the A5 move: the point of A5-1 is to relocate the
 * body, not to duplicate it, and a copy-paste relocation that leaves two owner
 * construction sites alive fails here even while the behaviour suites stay
 * green (plan §36: "never copy implementation → leave both owners alive").
 *
 * The per-slice ownership assertions (index must not construct X, bootstrap
 * must construct X) are added by the slices that make them true.
 */

/** The composition responsibilities A5 must keep owning, with a distinctive site. */
const COMPOSITION_INVENTORY: ReadonlyArray<readonly [string, string]> = [
  ['runner lifetime signal', 'new AbortController()'],
  ['process diagnostics', 'diagFromEnv(process.env)'],
  ['pre-mount startup status', 'createStartupStatus('],
  ['Host core services', "ctx.get('agents')"],
  ['session ownership core', 'createSessionOwnershipCore({'],
  ['session scope authority', 'createSessionScopeAuthority({'],
  ['Direct application runtime', 'createDirectApplicationRuntime({'],
  ['session runtime binding', 'bindSessionRuntime('],
  ['submission runtime binding', 'bindSubmissionRuntime({'],
  ['command runtime binding', 'command.attachRuntime()'],
  ['surface owner', 'createSurfaceRuntime<SessionEvent>({'],
  ['surface mount', 'surface.start({'],
  ['Plugin Manager attach', 'surface.attachPluginManager('],
  ['Task Center attach', 'surface.attachTasks('],
  ['presentation event routing attach', 'surface.attachEventRouting('],
  ['interaction provider attach', 'surface.attachInteraction('],
  ['command registration', 'command.register({ snapshot: initialSnapshot, skills: initialSkills })'],
  ['surface teardown', 'const disposeSurface = (): void => {'],
  ['startup lifecycle root', 'const startRunner = async (): Promise<void> => {'],
  ['terminal-total fatal catch', 'const handleStartupFailure = async (error: unknown): Promise<void> => {'],
]

/**
 * Single-owner constructions, each pinned to the module that OWNS it:
 * `[site, count, ownerRel]`.
 *
 * A5a counted these across the transitionally-broad composition surface. The
 * final A5 architecture pins the ownership LOCATION instead (plan A5b §8.1):
 * the named module contains the construction exactly `count` time(s), and the
 * composition root contains it only where the root itself IS the owner — the
 * authority/binding constructions and the client-local state the root builds
 * and injects. Every other entry is owner-internal state that moved OUT of the
 * composition root during A5b: the owner constructs its private state exactly
 * once, the root constructs none.
 */
const SINGLE_OWNER_SITES: ReadonlyArray<readonly [string, number, string]> = [
  // Composition-root authority/binding constructions (the root IS the owner;
  // plan A5b §7.6.4 lists these as legitimate bootstrap composition).
  ['createSessionOwnershipCore({', 1, 'src/app/bootstrap.ts'],
  ['createSessionScopeAuthority({', 1, 'src/app/bootstrap.ts'],
  ['createDirectApplicationRuntime({', 1, 'src/app/bootstrap.ts'],
  ['bindSessionRuntime(', 1, 'src/app/bootstrap.ts'],
  ['bindSubmissionRuntime({', 1, 'src/app/bootstrap.ts'],
  ['createSurfaceRuntime<SessionEvent>({', 1, 'src/app/bootstrap.ts'],
  // Client-local composition state the root builds and injects into owners.
  ['new DraftImageStore(', 1, 'src/app/bootstrap.ts'],
  ['new DraftFileStore(', 1, 'src/app/bootstrap.ts'],
  ['new FileHistorySearchSource(', 1, 'src/app/bootstrap.ts'],
  // A5b-3: the command runtime binding + its catalog/refresh state.
  ['bindCommandRuntime({', 1, 'src/app/command/surface.ts'],
  ['new CoalescingRefreshGate(', 1, 'src/app/command/surface.ts'],
  ['new CatalogRefreshCoordinator(', 1, 'src/app/command/surface.ts'],
  // A5b-3a: the model-selection intent + default-write state.
  ['new DefaultIntentTracker<', 1, 'src/app/command/model-selection.ts'],
  ['new DefaultWriteBarrier(', 1, 'src/app/command/model-selection.ts'],
  // A5b-4: the submission FIFO / ack / local-echo / presentation state.
  ['new PendingSubmissions(', 1, 'src/app/submission/controller.ts'],
  ['new SubmitLatencyTracker(', 1, 'src/app/submission/controller.ts'],
  ['new DirectSubmissionPresentation(', 1, 'src/app/submission/controller.ts'],
  // A5b-2: the context-measurement cache.
  ['new ContextMeasurementCoordinator(', 1, 'src/app/surface/status-runtime.ts'],
  // A5b-1: two distinct transcript windows — the main session and the viewed
  // child — each owned by its presentation module.
  ['new TranscriptWindowController(', 1, 'src/app/surface/session-presentation.ts'],
  ['new TranscriptWindowController(', 1, 'src/app/surface/viewer-runtime.ts'],
]

test('A5: the composition surface is the entry plus the composition zone', () => {
  const sources = compositionSources()
  assert.equal(sources[0].rel, 'src/index.ts', 'the package entry is the first composition-surface file')
  assert.equal(sources[1].rel, 'src/app/bootstrap.ts', 'the composition facade is the second composition-surface file')
  for (const { rel } of sources.slice(2)) {
    assert.ok(rel.startsWith('src/app/bootstrap/'), `${rel} is not a composition-surface file`)
  }
})

test('A5: every composition responsibility still has a site', () => {
  const source = compositionSource()
  for (const [name, site] of COMPOSITION_INVENTORY) {
    assert.ok(source.includes(site), `the composition surface must still own ${name} (${site})`)
  }
})

test('A5a: the composition ROOT owns every composition site (the entry owns none)', () => {
  // Ownership LOCATION, not just "somewhere in the composition surface". The
  // aggregate counts below cannot catch a regression that moves a construction
  // back into the entry while deleting it from the composition root — the
  // count stays 1 and every aggregate lock stays green (A5a review P2).
  //
  // TS2: the composition ROOT is the whole composition zone — the facade plus
  // every `src/app/bootstrap/**` helper. The entry stays excluded absolutely;
  // "the root owns it" means the zone owns it (the helper split is checked by
  // the per-module location locks in test/a5b-bootstrap-closure.test.ts).
  const files = compositionSources().map(({ rel }) => rel)
  assert.equal(files[0], 'src/index.ts', 'the composition surface must start with the package entry')
  assert.equal(files[1], 'src/app/bootstrap.ts', 'the composition facade must follow the entry')
  for (const rel of files.slice(2)) {
    assert.ok(rel.startsWith('src/app/bootstrap/'), `the composition surface must not widen past the bootstrap zone (${rel})`)
  }
  const entry = compositionFile('src/index.ts')
  const root = compositionSource()

  // Plan §29 markers: the entry carries no composition/assembly at all.
  for (const marker of [
    'createDirectApplicationRuntime(',
    'createSessionOwnershipCore(',
    'createSessionScopeAuthority(',
    'bindSessionRuntime(',
    'bindSubmissionRuntime(',
    'bindCommandRuntime(',
    'createSurfaceRuntime<',
    'surface.start(',
    'ctx.get(',
  ]) {
    assert.equal(entry.includes(marker), false, `src/index.ts must not contain ${marker} (§29)`)
  }

  // Every inventoried composition responsibility lives in the ROOT.
  for (const [name, site] of COMPOSITION_INVENTORY) {
    assert.equal(entry.includes(site), false, `the entry must not own ${name}`)
    assert.ok(root.includes(site), `the composition root must own ${name} (${site})`)
  }
  // Single-owner constructions follow the ownership LOCATION to the module that
  // owns them (plan A5b §8.1): the owner constructs its private state exactly
  // once, the root constructs none of what an A5b owner took over, and the
  // entry constructs none of it at all. The root IS the named owner for the
  // authority/binding constructions and the client-local state it injects.
  for (const [site, expected, owner] of SINGLE_OWNER_SITES) {
    assert.equal(entry.includes(site), false, `the entry must not construct ${site}`)
    assert.equal(
      ownerFile(owner).split(site).length - 1,
      expected,
      `${owner} must construct ${site} exactly ${expected} time(s) (plan A5b §8.1)`,
    )
    if (owner !== 'src/app/bootstrap.ts') {
      assert.equal(
        root.split(site).length - 1,
        0,
        `src/app/bootstrap.ts must not construct ${site} — its owner is ${owner}`,
      )
    }
  }
})

test('A5: every single-owner construction has exactly its expected count across the owner surface', () => {
  // The aggregate companion to the per-module location lock above: the TOTAL
  // count across the owner surface (which includes the composition root) must
  // still match, so a relocation that duplicates a construction in TWO owner
  // modules fails even when each module individually looks plausible.
  const expectedBySite = new Map<string, number>()
  for (const [site, expected] of SINGLE_OWNER_SITES) {
    expectedBySite.set(site, (expectedBySite.get(site) ?? 0) + expected)
  }
  for (const [site, expected] of expectedBySite) {
    assert.equal(ownerOccurrences(site), expected,
      `${site} must have exactly ${expected} construction site(s) in the A5b owner surface`)
  }
})

/**
 * Literals that legitimately occur once OUTSIDE the A5b single-owner rows, each
 * pinned to its exact production file. These are documented facts, not escapes:
 *
 * - `app/session/runtime.ts` DECLARES the `bindSessionRuntime(` factory that the
 *   composition root calls — the declaration is not a second construction.
 *
 * The whole-tree guard pins each to that exact file, so a construction added
 * anywhere (including inside these files) still fails the count.
 *
 * TS6 removed the other entry: the Direct/Remote presentation parity oracle's
 * throwaway `new TranscriptWindowController(` left production `src/**` for
 * `scripts/support/presentation-read-shadow.ts`, so it is no longer a
 * production construction site at all.
 */
const WHOLE_TREE_NON_OWNER_SITES: Readonly<Record<string, readonly string[]>> = {
  'bindSessionRuntime(': ['src/app/session/runtime.ts'],
}

test('A5: no production file outside the pinned owners holds a single-owner construction', () => {
  // The per-module location lock above is the authority pin, but it reads only
  // the hand-listed `OWNER_MODULES`. A NEW file (or an unlisted module) that
  // constructs a second `new PendingSubmissions(` is invisible to it. This guard
  // scans ALL production `src/**/*.ts` and pins BOTH the exact file set and the
  // total count per site, so a second copy anywhere fails even while each
  // per-owner count stays green (plan A5b §8.1/§8.3).
  const expectedFiles = new Map<string, Set<string>>()
  const expectedCounts = new Map<string, number>()
  for (const [site, count, owner] of SINGLE_OWNER_SITES) {
    if (!expectedFiles.has(site)) {
      expectedFiles.set(site, new Set())
      expectedCounts.set(site, 0)
    }
    expectedFiles.get(site)!.add(owner)
    expectedCounts.set(site, expectedCounts.get(site)! + count)
  }
  for (const [site, extras] of Object.entries(WHOLE_TREE_NON_OWNER_SITES)) {
    const files = expectedFiles.get(site)
    assert.ok(files !== undefined, `${site} is not a SINGLE_OWNER_SITES literal`)
    for (const extra of extras) {
      assert.equal(files.has(extra), false, `${extra} is listed as both an owner and a non-owner site for ${site}`)
      files.add(extra)
      expectedCounts.set(site, expectedCounts.get(site)! + 1)
    }
  }

  const sources = productionSources()
  const whole = sources.map(({ rel, source }) => `// >>> ${rel}\n${source}`).join('\n')
  for (const [site, files] of expectedFiles) {
    const actualFiles = sources.filter(({ source }) => source.includes(site)).map(({ rel }) => rel)
    assert.deepEqual(
      actualFiles,
      [...files].sort(),
      `${site} must occur only in its pinned owner/non-owner file(s) across production src/**`,
    )
    assert.equal(
      whole.split(site).length - 1,
      expectedCounts.get(site),
      `${site} must occur exactly ${expectedCounts.get(site)} time(s) across production src/**`,
    )
  }
})

/**
 * Every call callee in `source`: an identifier name or a dotted property path.
 * The callee is unwrapped first (`(createSessionOwnershipCore)(...)`,
 * `(surface.start as ...)(...)`, ...) so a parenthesized / cast / non-null call
 * cannot hide a composition-root construction from the guard below.
 */
/** The identifier a single-owner site calls or constructs. */
function siteName(site: string): string {
  return site.replace(/^new /u, '').replace(/[(<{].*$/u, '')
}

/**
 * The alias-aware whole-tree companion of the WHOLE single-owner inventory —
 * including the A5 TOP-LEVEL composition factories
 * (`createSessionOwnershipCore`, `createSessionScopeAuthority`,
 * `createDirectApplicationRuntime`, `bindSessionRuntime`,
 * `bindSubmissionRuntime`, `bindCommandRuntime`, `createSurfaceRuntime`).
 *
 * The table above pins the LOCATION with exact strings, and those strings cannot
 * see an inferred-generic call (`createSurfaceRuntime(deps)`), a parenthesized
 * callee, `new X()` without type arguments, or an alias
 * (`const F = bindSessionRuntime; F(…)`,
 * `import { createSurfaceRuntime as makeSurface } from '…'`). This guard reads
 * the AST callee identity over production `src/**` through the shared
 * alias-aware helper and asserts each name is reached ONLY from the file(s) the
 * table pins, so a second construction anywhere, in ANY spelling, fails.
 */
test('A5: every single-owner construction is alias-aware unique across production src/**', () => {
  const expected = new Map<string, string[]>()
  for (const [site, , ownerRel] of SINGLE_OWNER_SITES) {
    const name = siteName(site)
    const owners = expected.get(name) ?? []
    if (!owners.includes(ownerRel)) owners.push(ownerRel)
    expected.set(name, owners)
  }
  for (const [name, owners] of expected) {
    assert.deepEqual(
      aliasAwareConstructionSites(name),
      [...owners].sort(),
      `${name} must be called/constructed ONLY from ${owners.join(', ')} across production src/** (alias-aware AST sites, never spellings)`,
    )
  }
})

function calledCallees(source: string, rel = 'module.ts'): string[] {
  // The parser kind follows the FILE (`.tsx` => TSX): a whole-tree scan over
  // `productionSources()` includes `.tsx`, and a legal JSX attribute/child
  // holding this call would otherwise parse to nothing (TS2 §19).
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.ESNext, true, productionScriptKind(rel))
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression)
      if (ts.isIdentifier(callee)) out.push(callee.text)
      else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        out.push(`${callee.expression.text}.${callee.name.text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

test('A5: calledCallees resolves the callee through every expression wrapper', () => {
  // The composition-root guard is only as strong as its callee resolution: each
  // wrapper form below must still be attributed to the unwrapped call.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['(createSessionOwnershipCore)({})', 'createSessionOwnershipCore'],
    ['(createSessionOwnershipCore as typeof createSessionOwnershipCore)({})', 'createSessionOwnershipCore'],
    ['(createSessionScopeAuthority as unknown as (d: unknown) => void)({})', 'createSessionScopeAuthority'],
    ['(bindSessionRuntime)!({}, {})', 'bindSessionRuntime'],
    ['(surface.start)({})', 'surface.start'],
    ['(surface.start as (deps: unknown) => void)({})', 'surface.start'],
  ]
  for (const [source, callee] of cases) {
    assert.ok(calledCallees(source).includes(callee), `${source} must resolve to ${callee}`)
  }
})

test('A5: the composition-root construction calls occur only in the composition root', () => {
  // Plan §8.1/§8.4: a THIRD composition root would be a second
  // `createSessionOwnershipCore({` / `surface.start({` somewhere in production
  // src. The per-owner `SINGLE_OWNER_SITES` row pins the count in bootstrap but
  // cannot see a copy in a file nobody listed; this guard scans every production
  // source. Callees are read from the AST so the owners' own factory
  // DECLARATIONS (`export function bindSessionRuntime(`) are not miscounted as a
  // second composition.
  const rootOnlyCalls = [
    'createSessionOwnershipCore',
    'createSessionScopeAuthority',
    'createDirectApplicationRuntime',
    'bindSessionRuntime',
    'bindSubmissionRuntime',
    'createSurfaceRuntime',
    'surface.start',
  ]
  const byCall = new Map<string, string[]>(rootOnlyCalls.map(name => [name, []]))
  for (const { rel, source } of productionSources()) {
    for (const callee of calledCallees(source, rel)) {
      byCall.get(callee)?.push(rel)
    }
  }
  for (const name of rootOnlyCalls) {
    assert.deepEqual(
      byCall.get(name),
      ['src/app/bootstrap.ts'],
      `${name} must be called only in src/app/bootstrap.ts (plan §8.1/§8.4)`,
    )
  }
})

/** The composition root's Host subscriptions: event name -> its ONE owner. */
const HOST_SUBSCRIPTIONS: Readonly<Record<string, string>> = {
  'session/event': 'src/app/bootstrap/event-wiring.ts',
  'subagent/start': 'src/app/bootstrap/event-wiring.ts',
  'subagent/end': 'src/app/bootstrap/event-wiring.ts',
  'agent/status': 'src/app/bootstrap/event-wiring.ts',
  'llm/adapters-updated': 'src/app/bootstrap/event-wiring.ts',
  'settings/document-updated': 'src/app/bootstrap/event-wiring.ts',
}

/**
 * Every OTHER production `ctx.on(<string literal>, …)` subscription and the
 * module that owns it: the Direct adapters (they ARE the Host implementation) and
 * the skill-catalog capability. Pinned explicitly so the guard can assert the
 * COMPLETE subscription inventory — a new or duplicated event subscription fails
 * instead of slipping in.
 */
const OTHER_HOST_SUBSCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['user-questions/request', 'src/runtime/direct/interaction-direct.ts'],
  ['approval/request', 'src/runtime/direct/interaction-direct.ts'],
  ['plugin-manager/install-state', 'src/runtime/direct/plugin-manager-direct.ts'],
  ['plugin-manager/install-log', 'src/runtime/direct/plugin-manager-direct.ts'],
  ['plugin-manager/changed', 'src/runtime/direct/plugin-manager-direct.ts'],
  ['agent/assistant-stream', 'src/runtime/direct/assistant-stream-direct.ts'],
  ['agent/disposed', 'src/runtime/direct/assistant-stream-direct.ts'],
  ['skills/change', 'src/skill-catalog.ts'],
  ['commands/change', 'src/commands.ts'],
]

/** Dynamic (non-literal event) `ctx.on` bridges: the Direct config port only. */
const DYNAMIC_SUBSCRIPTION_SITES: readonly string[] = ['src/runtime/direct/config-direct.ts']

/**
 * Every `ctx.on(<literal>, …)` subscription in one production source, read from
 * the AST — so quotes, whitespace, optional chaining (`ctx.on?.(…)`), a
 * `this.ctx.on` receiver and a computed `ctx['on']` are all the SAME fact. A
 * source-string match (`"ctx.on('session/event'"`) would miss all of them.
 */
function hostSubscriptions(source: string, rel = 'probe.ts'): { events: string[]; dynamicCount: number } {
  // The parser kind follows the FILE (`.tsx` => TSX): without it a legal JSX
  // attribute/child subscription is invisible to this whole-tree inventory
  // (TS2 §19).
  const file = ts.createSourceFile(rel, source, ts.ScriptTarget.ESNext, true, productionScriptKind(rel))
  const events: string[] = []
  let dynamicCount = 0
  const isCtxOn = (callee: ts.Expression): boolean => {
    const target = unwrapExpression(callee)
    if (ts.isPropertyAccessExpression(target) && target.name.text === 'on') {
      const receiver = target.expression
      return ts.isIdentifier(receiver) ? receiver.text === 'ctx' : receiver.getText(file).endsWith('.ctx')
    }
    if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
      return target.argumentExpression.text === 'on'
    }
    return false
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCtxOn(node.expression)) {
      const first = node.arguments[0]
      if (first !== undefined && ts.isStringLiteralLike(first)) events.push(first.text)
      else dynamicCount += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { events, dynamicCount }
}

test('A5: the Host subscription inventory is unique and AST-complete across production src/**', () => {
  // Plan §14/§16 ("no subscription/disposer duplication") and §39. Read from the
  // AST so every legal spelling of a `ctx.on` subscription is counted, and assert
  // the COMPLETE inventory (not just the composition-root six): a second
  // registration of any event — inside an extracted owner or anywhere else —
  // fails, and an untracked new subscription is visible here rather than silent.
  const byEvent = new Map<string, string[]>()
  const dynamicSites: string[] = []
  for (const { rel, source } of productionSources()) {
    const { events, dynamicCount } = hostSubscriptions(source, rel)
    for (let index = 0; index < dynamicCount; index += 1) dynamicSites.push(rel)
    for (const event of events) {
      const sites = byEvent.get(event) ?? []
      sites.push(rel)
      byEvent.set(event, sites)
    }
  }
  const expected = new Map<string, string>([
    ...Object.entries(HOST_SUBSCRIPTIONS),
    ...OTHER_HOST_SUBSCRIPTIONS.map(([event, rel]) => [event, rel] as const),
  ])
  assert.deepEqual(
    [...byEvent.keys()].sort(),
    [...expected.keys()].sort(),
    'the production Host-subscription inventory changed: every ctx.on(event, …) must be listed with its owner',
  )
  for (const [event, owner] of expected) {
    assert.deepEqual(
      byEvent.get(event),
      [owner],
      `${event} must be subscribed exactly once, from ${owner}`,
    )
  }
  assert.deepEqual(
    dynamicSites,
    [...DYNAMIC_SUBSCRIPTION_SITES].sort(),
    'the dynamic (non-literal) ctx.on bridges must stay in the Direct config port — one call site each, so a SECOND bridge in the same file also fails',
  )
})

test('A5: the composition surface keeps the documented surface release order', () => {
  // Plan §12.2/§38: the teardown order is behaviour. The composition root only
  // orchestrates; every release hook is surface-owned.
  const source = compositionSource()
  const cleanupStart = source.indexOf('const disposeSurface = (): void => {')
  assert.ok(cleanupStart >= 0, 'disposeSurface must exist')
  const cleanup = source.slice(cleanupStart, source.indexOf('diag.dispose()', cleanupStart) + 20)
  const order = [
    'surface.disposePluginManager()',
    'surface.disposeJobEvents()',
    'surface.disposeJobObservation()',
    'surface.disposeTaskBrowser()',
    'surface.dispose()',
  ]
  let cursor = -1
  for (const hook of order) {
    const at = cleanup.indexOf(hook)
    assert.ok(at >= 0, `cleanup must call ${hook}`)
    assert.ok(at > cursor, `cleanup must call ${hook} after the previous surface release hook`)
    cursor = at
  }
})

test('A5: the composition surface keeps the startup order', () => {
  // attachTasks → refreshPendingInput → initLiveSession → registerCommands.
  // Search FORWARD from each hit: the earlier input handlers also refresh the
  // pending presentation, so only the startup tail order is pinned here.
  const source = compositionSource()
  let cursor = source.indexOf('surface.attachTasks({')
  assert.ok(cursor >= 0, 'the composition surface must attach the Task Center')
  for (const step of [
    'surface.refreshPendingInput()',
    'await presentation.initLiveSession(',
    'command.register({ snapshot: initialSnapshot, skills: initialSkills })',
  ]) {
    const at = source.indexOf(step, cursor)
    assert.ok(at > cursor, `${step} must come after the previous startup step`)
    cursor = at
  }
})

test('A5/TS2: the Host-subscription phases keep their frozen startup interleaving', () => {
  // §0/§12/§85/§91 Pass 3: the startup wiring order is BEHAVIOR. The baseline
  // interleaved the six application-level subscriptions with the Direct
  // live-assistant-stream acquire — `session/event` BEFORE it, the other five
  // AFTER it and its abort binding — so a throwing stream install left exactly
  // the listeners the baseline had installed. One collapsed installation call
  // reorders that; this lock pins the two-phase interleaving and the phase
  // contents.
  const source = compositionSource()
  const order = [
    'installSessionEventWiring({ ctx, direct: remoteSources === undefined, surface })',
    'const directAssistantRuntime = directRuntime()',
    'const assistantStreamHandle = directAssistantRuntime.installAssistantStream({',
    "lifecycleController.signal.addEventListener('abort', assistantStreamHandle, { once: true })",
    'installRuntimeEventWiring({ ctx, direct: remoteSources === undefined, surface })',
    "const disposeCredentialSubscription = backend.config.credentials.onChanged(",
  ]
  let cursor = -1
  for (const step of order) {
    const at = source.indexOf(step)
    assert.ok(at >= 0, `the startup wiring must contain ${step}`)
    assert.ok(at > cursor, `${step} must come after the previous startup wiring step`)
    cursor = at
  }

  // The phase SPLIT itself: exactly one declaration + one call per phase, and
  // phase 1 installs exactly ONE listener (the throwing-install window's active
  // set), while phase 2 installs the other five IN THE BASELINE ORDER.
  assert.equal(compositionOccurrences('installSessionEventWiring('), 2,
    'phase 1 must have exactly one declaration and one call site')
  assert.equal(compositionOccurrences('installRuntimeEventWiring('), 2,
    'phase 2 must have exactly one declaration and one call site')
  const wiring = readFileSync(new URL('../src/app/bootstrap/event-wiring.ts', import.meta.url), 'utf8')
  const phaseTwoAt = wiring.indexOf('export function installRuntimeEventWiring(')
  assert.ok(phaseTwoAt > 0, 'the phase-2 installation must exist')
  const phaseOne = wiring.slice(0, phaseTwoAt)
  const phaseTwo = wiring.slice(phaseTwoAt)
  assert.equal(phaseOne.split('ctx.on(').length - 1, 1,
    'phase 1 installs exactly ONE listener, so a throwing stream install leaves exactly that one active')
  assert.ok(phaseOne.includes("ctx.on('session/event'"), 'phase 1 owns the Direct durable firehose')
  let phaseCursor = -1
  for (const event of [
    'subagent/start',
    'subagent/end',
    'agent/status',
    'llm/adapters-updated',
    'settings/document-updated',
  ]) {
    assert.ok(!phaseOne.includes(`ctx.on('${event}'`), `${event} must NOT be installed before the stream acquire`)
    const at = phaseTwo.indexOf(`ctx.on('${event}'`)
    assert.ok(at > phaseCursor, `${event} must keep its baseline registration order inside phase 2`)
    phaseCursor = at
  }
  assert.equal(phaseTwo.split('ctx.on(').length - 1, 5, 'phase 2 installs exactly the other five listeners')
})

test('A5/TS2: a .tsx production duplicate cannot escape the single-owner scans', (t) => {
  // TS1 closed the `.tsx` hole in the production architecture gate; this helper
  // (the whole-tree duplicate DETECTOR behind the A5b single-owner locks) must
  // scan the SAME extension set, and must parse a `.tsx` module as TSX. Without
  // both, a JSX-bearing production module could hold a second composition
  // construction invisibly.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-a5b-tsx-')
  mkdirSync(join(root, 'src', 'app', 'surface'), { recursive: true })
  writeFileSync(join(root, 'src', 'app', 'bootstrap.ts'), 'export const bootstrap = 1\n')
  const jsxSource = [
    'export function Probe() {',
    '  return (',
    '    <section data-probe={createSessionOwnershipCore({})}>',
    '      probe',
    '    </section>',
    '  )',
    '}',
    '',
  ].join('\n')
  const rel = 'src/app/surface/duplicate.tsx'
  writeFileSync(join(root, rel), jsxSource)

  const sources = productionSourcesUnder(root)
  assert.deepEqual(
    sources.map(({ rel: scanned }) => scanned),
    ['src/app/bootstrap.ts', rel],
    'the production scan must include the .tsx module',
  )
  assert.deepEqual(
    aliasAwareConstructionSites('createSessionOwnershipCore', sources),
    [rel],
    'a duplicate composition construction in a .tsx production module must be attributed to its own file',
  )
  // Positive control for the parser kind: under the WRONG kind the JSX file is
  // not a valid module, so the scan of the same bytes cannot be the reason this
  // passes. The same construction in a real `.ts` file is still found.
  const tsSpelling = [{ rel: 'src/app/surface/duplicate.ts', source: 'export const s = createSessionOwnershipCore({})\n' }]
  assert.deepEqual(aliasAwareConstructionSites('createSessionOwnershipCore', tsSpelling), ['src/app/surface/duplicate.ts'])
  assert.deepEqual(
    aliasAwareConstructionSites('createSessionOwnershipCore', [{ rel: 'src/app/surface/duplicate.ts', source: jsxSource }]),
    [],
    'the JSX source parsed as plain TS must not silently look like a scanned module — the extension drives the parser kind',
  )
})

test('A5/TS2: the composition zone is enumerated RECURSIVELY (nested helpers included)', (t) => {
  // The zone is the WHOLE `src/app/bootstrap/**` subtree (§7/§18/§20): a
  // one-level `readdir` lets a nested helper escape the composition/owner-surface
  // locks while the architecture gate (which treats the directory as the zone)
  // still accepts it. Proven through the REAL enumerators the locks use, and
  // through the real composition surface on a fixture tree.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-zone-nested-')
  mkdirSync(join(root, 'src', 'app', 'bootstrap', 'nested'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const entry = 1\n')
  writeFileSync(join(root, 'src', 'app', 'bootstrap.ts'), 'export const bootstrap = 1\n')
  writeFileSync(join(root, 'src', 'app', 'bootstrap', 'top.ts'), 'export const top = 1\n')
  writeFileSync(join(root, 'src', 'app', 'bootstrap', 'nested', 'probe.tsx'), 'export const probe = <span />\n')
  writeFileSync(join(root, 'src', 'app', 'bootstrap', 'nested', 'alt.mts'), 'export const alt = 1\n')
  writeFileSync(join(root, 'src', 'app', 'bootstrap', 'nested', 'ignored.md'), 'not source\n')
  assert.deepEqual(
    compositionFilesUnder(root),
    [
      'src/index.ts',
      'src/app/bootstrap.ts',
      'src/app/bootstrap/nested/alt.mts',
      'src/app/bootstrap/nested/probe.tsx',
      'src/app/bootstrap/top.ts',
    ],
    'the composition surface must include a NESTED zone helper over every production extension',
  )
  // The SAME enumerator feeds OWNER_MODULES (`bootstrapHelperModules`), so the
  // aggregate bag/single-owner locks see nested helpers too.
  assert.deepEqual(
    productionFilesUnder(root, 'src/app/bootstrap'),
    [
      'src/app/bootstrap/nested/alt.mts',
      'src/app/bootstrap/nested/probe.tsx',
      'src/app/bootstrap/top.ts',
    ],
  )
  // ...and their CONTENT is part of what the content locks scan: a bad
  // universal-dependency bag (or a hard-coded chord) hidden in a nested helper
  // must be visible to the composed surface text, not just to the file list.
  writeFileSync(
    join(root, 'src', 'app', 'bootstrap', 'nested', 'bad.ts'),
    'interface EverythingBag { readonly everything: unknown }\n',
  )
  const composed = compositionSourceUnder(root)
  assert.ok(composed.includes('interface EverythingBag {'),
    'a bag declared in a NESTED composition helper must appear in the composed composition surface')
  assert.ok(composed.includes('// >>> src/app/bootstrap/nested/bad.ts'),
    'the composed surface must banner the nested helper it now covers')
  // The real tree is unchanged by the recursion: all six helpers are flat today.
  assert.deepEqual(
    productionFilesUnder(process.cwd(), 'src/app/bootstrap'),
    [
      'src/app/bootstrap/event-wiring.ts',
      'src/app/bootstrap/lifecycle.ts',
      'src/app/bootstrap/presentation-bridge.ts',
      'src/app/bootstrap/runtime-selection.ts',
      'src/app/bootstrap/session-startup.ts',
      'src/app/bootstrap/task-source.ts',
    ],
  )
})

test('A5/TS2: the JSX hard cases are visible to the whole-tree AST walkers', () => {
  // A legal JSX ATTRIBUTE position hides the construct from a TS parse, so a
  // `.tsx` production module would otherwise escape the Host-subscription
  // inventory and the callee scan while `productionSources()` already scans it.
  // Each case is asserted BOTH ways: the TSX parse finds it, and the SAME bytes
  // parsed as plain TS find nothing — so the extension, not the scanner's
  // incidental recovery, is what makes these pass.
  const hostInAttribute = "export const view = <Box value={ctx.on('session/event', () => {})} />\n"
  assert.deepEqual(hostSubscriptions(hostInAttribute, 'probe.tsx').events, ['session/event'])
  assert.deepEqual(hostSubscriptions(hostInAttribute, 'probe.ts').events, [],
    'the same bytes parsed as TS must yield NO subscription (TSX is a hard case, not a recovered one)')

  const callInAttribute = 'export const view = <Box value={createSurfaceRuntime(options)} />\n'
  assert.ok(calledCallees(callInAttribute, 'probe.tsx').includes('createSurfaceRuntime'))
  assert.deepEqual(calledCallees(callInAttribute, 'probe.ts'), [],
    'the same bytes parsed as TS must yield NO callee')

  const callInChild = 'export const view = <Box>{createSurfaceRuntime(options)}</Box>\n'
  assert.ok(calledCallees(callInChild, 'probe.tsx').includes('createSurfaceRuntime'))
  assert.deepEqual(calledCallees(callInChild, 'probe.ts'), [])

  // The default kind stays TS for the pre-existing `.ts` fixtures/helpers.
  assert.ok(calledCallees('(surface.start)({})').includes('surface.start'))
  assert.deepEqual(hostSubscriptions("ctx.on('agent/status', () => {})").events, ['agent/status'])
})
