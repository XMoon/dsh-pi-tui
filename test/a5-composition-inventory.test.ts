import assert from 'node:assert/strict'
import test from 'node:test'

import { compositionOccurrences, compositionSource, compositionSources } from './support/composition-surface.ts'

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
  ['command runtime binding', 'bindCommandRuntime({'],
  ['surface owner', 'createSurfaceRuntime<SessionEvent>({'],
  ['surface mount', 'surface.start({'],
  ['Plugin Manager attach', 'surface.attachPluginManager('],
  ['Task Center attach', 'surface.attachTasks('],
  ['presentation event routing attach', 'surface.attachEventRouting('],
  ['interaction provider attach', 'surface.attachInteraction('],
  ['command registration', 'registerCommands('],
  ['surface teardown', 'const disposeSurface = (): void => {'],
  ['startup lifecycle root', 'const startRunner = async (): Promise<void> => {'],
  ['terminal-total fatal catch', 'const handleStartupFailure = async (error: unknown): Promise<void> => {'],
]

/**
 * Owner constructions that must have exactly one site in the composition
 * surface. Counts are the frozen post-A4 inventory; a relocation that leaves a
 * second construction behind (or pushes one into a non-composition module)
 * changes the count.
 */
const SINGLE_OWNER_SITES: ReadonlyArray<readonly [string, number]> = [
  ['createSessionOwnershipCore({', 1],
  ['createSessionScopeAuthority({', 1],
  ['createDirectApplicationRuntime({', 1],
  ['bindSessionRuntime(', 1],
  ['bindSubmissionRuntime({', 1],
  ['bindCommandRuntime({', 1],
  ['createSurfaceRuntime<SessionEvent>({', 1],
  ['new DefaultIntentTracker<', 1],
  ['new DefaultWriteBarrier(', 1],
  ['new PendingSubmissions(', 1],
  ['new SubmitLatencyTracker(', 1],
  ['new ContextMeasurementCoordinator(', 1],
  ['new DraftImageStore(', 1],
  ['new DraftFileStore(', 1],
  ['new FileHistorySearchSource(', 1],
  ['new CoalescingRefreshGate(', 1],
  ['new CatalogRefreshCoordinator(', 1],
  ['new DirectSubmissionPresentation(', 1],
  // Two distinct transcript windows: the main session and the viewed child.
  ['new TranscriptWindowController(', 2],
]

test('A5: the composition surface is the entry plus the composition root', () => {
  const sources = compositionSources()
  assert.equal(sources[0].rel, 'src/index.ts', 'the package entry is the first composition-surface file')
  for (const { rel } of sources) {
    assert.ok(rel === 'src/index.ts' || rel === 'src/app/bootstrap.ts', `${rel} is not a composition-surface file`)
  }
})

test('A5: every composition responsibility still has a site', () => {
  const source = compositionSource()
  for (const [name, site] of COMPOSITION_INVENTORY) {
    assert.ok(source.includes(site), `the composition surface must still own ${name} (${site})`)
  }
})

test('A5: every application owner is constructed exactly once in the composition surface', () => {
  for (const [site, expected] of SINGLE_OWNER_SITES) {
    assert.equal(compositionOccurrences(site), expected,
      `${site} must have exactly ${expected} construction site(s) in the composition surface`)
  }
})

test('A5: the composition surface registers each Host subscription exactly once', () => {
  // Plan §39: no duplicate event subscription. The runner registers one
  // listener per Host event; the surface owns the routing decision.
  const subscriptions = [
    "ctx.on('session/event'",
    "ctx.on('subagent/start'",
    "ctx.on('subagent/end'",
    "ctx.on('agent/status'",
    "ctx.on('llm/adapters-updated'",
    "ctx.on('settings/document-updated'",
  ]
  for (const subscription of subscriptions) {
    assert.equal(compositionOccurrences(subscription), 1, `${subscription} must be registered exactly once`)
  }
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
    'await initLiveSession(',
    'registerCommands({ snapshot: initialSnapshot, skills: initialSkills })',
  ]) {
    const at = source.indexOf(step, cursor)
    assert.ok(at > cursor, `${step} must come after the previous startup step`)
    cursor = at
  }
})
