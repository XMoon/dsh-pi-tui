import assert from 'node:assert/strict'
import test from 'node:test'
import ts from 'typescript'

import { compositionFile, compositionSources } from './support/composition-surface.ts'
import { ownerFile, ownerSource, productionSources, unwrapExpression } from './support/owner-modules.ts'

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
 * below from being DEFINED in bootstrap (plan §7.6.2). Until the corresponding
 * slice lands they are legitimately still there, so this test keeps a frozen,
 * per-slice ledger:
 *
 * - a forbidden name is either absent from bootstrap, or listed in
 *   `PENDING_BOOTSTRAP_HANDLERS` with the slice that removes it;
 * - every ledger entry must still be a real declaration in bootstrap, so a
 *   slice cannot delete the implementation while leaving a stale exemption
 *   behind, and the ledger cannot quietly outlive the debt;
 * - the package entry never defines any of them.
 *
 * A5b-6 flips the ledger to empty; from then on the lock is final.
 *
 * Plan §8.2's minimum closure list and where each clause is locked:
 *   1. bootstrap exists and is the sole composition root —
 *      "src/app/bootstrap.ts is the sole application composition root" below;
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

interface PendingHandler {
  /** root-scope declaration name in `src/app/bootstrap.ts` */
  readonly name: string
  /** the A5b slice that extracts it into its real owner */
  readonly slice: 'A5b-1' | 'A5b-2' | 'A5b-3' | 'A5b-4' | 'A5b-5' | 'A5b-6'
  /** where it lands (the owner module) */
  readonly owner: string
}

/**
 * Plan §7.6.2: definitions `src/app/bootstrap.ts` must not contain at the final
 * A5 state. This list is durable — it does not shrink as slices land.
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

/** The transitional ledger: forbidden handlers still implemented in bootstrap. */
const PENDING_BOOTSTRAP_HANDLERS: readonly PendingHandler[] = []

/** Does `source` declare `name` at any scope? */
function declares(source: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var|function|class)\\s+${name}\\b`).test(source)
}

test('A5b: src/app/bootstrap.ts is the sole application composition root', () => {
  // Plan §8.2(1). `compositionSources()` throws when either file is missing, so
  // this also locks the EXISTENCE of the composition root; the pair is the
  // whole composition surface, so no second application composition root may
  // appear (the owners consume narrow injected callbacks instead).
  assert.deepEqual(
    compositionSources().map(({ rel }) => rel),
    ['src/index.ts', 'src/app/bootstrap.ts'],
    'the composition surface must be exactly the package entry plus src/app/bootstrap.ts',
  )
})

test('A5b: a forbidden handler is absent from bootstrap or explicitly on the slice ledger', () => {
  const root = compositionFile('src/app/bootstrap.ts')
  const ledger = new Set(PENDING_BOOTSTRAP_HANDLERS.map((e) => e.name))
  for (const name of FINAL_FORBIDDEN_HANDLERS) {
    if (!declares(root, name)) continue
    assert.ok(
      ledger.has(name),
      `${name} is implemented in bootstrap without a slice ledger entry — record the A5b slice that extracts it`,
    )
  }
})

test('A5b: every ledger entry is a live declaration scheduled for a known slice', () => {
  const root = compositionFile('src/app/bootstrap.ts')
  const seen = new Set<string>()
  for (const entry of PENDING_BOOTSTRAP_HANDLERS) {
    assert.equal(seen.has(entry.name), false, `${entry.name} is listed twice in the ledger`)
    seen.add(entry.name)
    assert.ok(FINAL_FORBIDDEN_HANDLERS.includes(entry.name), `${entry.name} is not on the final forbidden list`)
    assert.ok(
      declares(root, entry.name),
      `the ledger still exempts ${entry.name} for ${entry.slice}, but bootstrap no longer declares it — delete the ledger entry`,
    )
  }
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

/**
 * Every `TuiAppEvents` object-literal construction in `source`, via the
 * TypeScript parser: a variable declaration whose type annotation — on the
 * declaration OR on any `as` / `satisfies` / `<T>` wrapper — is the
 * `TuiAppEvents` type reference and whose initializer, once fully unwrapped, is
 * an object literal.
 *
 * A plain substring count cannot tell the semantic implementation from a NEW
 * rogue literal in an unlisted module, and the old test only checked one
 * hand-named wrapper by name (plan §8.2(4)).
 */
function tuiAppEventsLiterals(rel: string, source: string): TuiAppEventsLiteral[] {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const out: TuiAppEventsLiteral[] = []
  const isTuiAppEventsType = (node: ts.TypeNode | undefined): boolean =>
    node !== undefined
    && ts.isTypeReferenceNode(node)
    && ts.isIdentifier(node.typeName)
    && node.typeName.text === 'TuiAppEvents'
  const record = (name: string, initializer: ts.Expression, annotation: ts.TypeNode | undefined): void => {
    let typed = isTuiAppEventsType(annotation)
    const expr = unwrapExpression(initializer, (type) => {
      if (isTuiAppEventsType(type)) typed = true
    })
    if (!typed || !ts.isObjectLiteralExpression(expr)) return
    const passesThroughDepsEvents = expr.properties.some(
      property => ts.isSpreadAssignment(property) && property.expression.getText(sf) === 'deps.events',
    )
    out.push({ rel, name, line: sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1, passesThroughDepsEvents })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      record(node.name.text, node.initializer, node.type)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

test('A5b: tuiAppEventsLiterals detects every TuiAppEvents wrapper spelling', () => {
  // A rogue implementation must not be able to hide behind an ordinary
  // expression wrapper or move its type annotation onto the wrapper.
  const positive: ReadonlyArray<readonly [string, string]> = [
    ['const rogue: TuiAppEvents = { onSubmit: () => {} }\n', 'rogue'],
    ['const rogue: TuiAppEvents = ({ onSubmit: () => {} })\n', 'rogue'],
    ['const rogue = ({ onSubmit: () => {} } satisfies TuiAppEvents)\n', 'rogue'],
    ['const rogue = ({ onSubmit: () => {} } as TuiAppEvents)\n', 'rogue'],
    ['const rogue = ({ onSubmit: () => {} } as TuiAppEvents)!\n', 'rogue'],
    ['const rogue = <TuiAppEvents>{ onSubmit: () => {} }\n', 'rogue'],
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
  ]
  for (const source of negative) {
    assert.deepEqual(
      tuiAppEventsLiterals('synthetic.ts', source),
      [],
      `${source.trim()} is not a TuiAppEvents literal`,
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
      'viewerSessionAbort', 'refreshViewerFooter', 'enterView', 'exitView',
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
    'src/app/submission/local-shell.ts',
    ['localShellController', 'interruptLiveAgent', 'shellTempFiles', 'runLocalShell'],
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

test('A5b: every extracted declaration lives in its named owner, never in the composition root', () => {
  const root = compositionFile('src/app/bootstrap.ts')
  for (const [rel, names] of EXTRACTED_DECLARATIONS) {
    const owner = ownerFile(rel)
    for (const name of names) {
      assert.ok(declares(owner, name), `${name} must be declared in the owner ${rel}`)
      assert.equal(
        declares(root, name),
        false,
        `src/app/bootstrap.ts must not declare ${name} — it belongs to ${rel}`,
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
  ['src/app/surface/viewer-runtime.ts', 'createViewerRuntime', 'createViewerRuntime<SessionEvent, Agent>('],
  ['src/app/submission/controller.ts', 'createSubmissionController', 'createSubmissionController<Agent>('],
  ['src/app/submission/local-shell.ts', 'createLocalShell', 'createLocalShell<Agent>('],
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
  // A5b-3 review P2: disposal must clear BOTH the coordinator and the refresh
  // request, so a late `skills/change` (the Direct capability cannot unsubscribe)
  // cannot reach a disposed coordinator.
  const disposeAt = owner.indexOf('const disposeCatalog = (): void => {')
  assert.ok(disposeAt > 0, 'the command owner must expose disposeCatalog')
  const disposeBody = owner.slice(disposeAt, owner.indexOf('\n  }', disposeAt))
  assert.ok(disposeBody.includes('catalogCoordinator?.dispose()'),
    'disposal must dispose the catalog coordinator')
  assert.ok(disposeBody.includes('catalogCoordinator = undefined'),
    'disposal must clear the coordinator reference')
  assert.ok(disposeBody.includes('catalogRefreshRequest = undefined'),
    'disposal must clear the refresh request so a late skills/change is a no-op')
})

test('A5b-6: the Direct-facing viewed-queue authority is viewer-owned and read late-bound', () => {
  // The A5b-6 zero-assumption sweep judged the `viewedQueueAgent` slot VIEWER
  // mutable state (plan §7.6.2) and moved it into the viewer owner. The
  // composition root keeps only the narrow late-bound CONNECTOR for the Direct
  // queue resolver — the invariant (ONE published authority, published by the
  // viewer, read by the Direct runtime) is unchanged.
  const root = compositionFile('src/app/bootstrap.ts')
  const viewer = ownerFile('src/app/surface/viewer-runtime.ts')
  assert.equal(declares(root, 'viewedQueueAgent'), false,
    'the composition root must not hold the viewed-queue viewer state (plan §7.6.2)')
  assert.ok(declares(viewer, 'queueAuthority'),
    'the viewer owner must hold the published queue authority slot')
  assert.match(viewer, /viewedQueueAuthority: \(\) => queueAuthority/u,
    'the viewer owner must expose a getter for the published authority')
  assert.match(root, /getViewedQueueAgent: \(\) => viewerRef\?\.viewedQueueAuthority\(\)/u,
    'the composition connector must read the viewer-owned authority late-bound (never capture by value)')
  assert.doesNotMatch(root, /publishQueueAuthority/u,
    'the composition root must no longer receive the viewer publication callback')
})

test('A5b-6: the composition root implements no TuiAppEvents/TuiCommandRunner literal', () => {
  // Plan §7.6.2, second list. A literal is detected by its type annotation
  // (`: TuiAppEvents = {` / `: TuiCommandRunner = {`); the type-only references
  // the composition still needs (e.g. `TuiCommandRunner['agents']`) are fine.
  const root = compositionFile('src/app/bootstrap.ts')
  for (const type of ['TuiAppEvents', 'TuiCommandRunner']) {
    assert.equal(
      new RegExp(`:\\s*${type}\\s*=\\s*\\{`).test(root),
      false,
      `src/app/bootstrap.ts must not implement ${type} as an object literal`,
    )
  }
  assert.equal(declares(root, 'surfaceEvents'), false,
    'the TuiAppEvents implementation must live in its owner, not the composition root')
})

test('A5b-6: no application-owner mutable state category remains in the composition root', () => {
  // Plan §7.6.2 categories: client-local history state, command claim/catalog
  // mutable slots, submission FIFO/ack/local-echo state, viewer mutable state
  // and the footer/display state machine. Each name below is a real declaration
  // of its named owner (pinned in EXTRACTED_DECLARATIONS above); this lock keeps
  // the CATEGORY explicit and mutation-sensitive.
  const root = compositionFile('src/app/bootstrap.ts')
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
  for (const [category, names] of categories) {
    for (const name of names) {
      assert.equal(declares(root, name), false,
        `src/app/bootstrap.ts must not declare ${name} (${category}, plan §7.6.2)`)
    }
  }
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
  assert.equal(declares(root, 'submissionWriterSection'), false,
    'the composition root must not declare the submission writer section')
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
  // It belongs to the Task-Center owner (`SurfaceRuntime.attachTasks`, which
  // already owns the task model); the root now supplies only the fence FACTS.
  const root = compositionFile('src/app/bootstrap.ts')
  const owner = ownerFile('src/app/surface/runtime.ts')
  // The composition root must not name a jobs-snapshot/retained-rows slot.
  assert.equal(declares(root, 'jobSnapshot'), false,
    'the composition root must not declare the retained jobs snapshot')
  assert.doesNotMatch(root, /\bjobSnapshot\b|\bretainedJobsSnapshot\b/u,
    'the composition root must not name a jobs-snapshot/retained-rows slot')
  // The injected subagent source group no longer receives `readJobs`; it supplies
  // the fence facts instead, so the owner can derive the session id without
  // importing the ownership core.
  assert.doesNotMatch(root, /readJobs/u,
    'the composition root must not provide the jobs-read retention policy')
  const sourceGroup = owner.slice(
    owner.indexOf('export interface TaskSurfaceAgents'),
    owner.indexOf('export interface TaskSurfaceSource'),
  )
  assert.doesNotMatch(sourceGroup, /readJobs/u,
    'the injected subagent source group must no longer carry readJobs')
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
  const readJobsEnd = owner.indexOf('agentStatusOf: agents.agentStatusOf', readJobsAt)
  assert.ok(readJobsAt > 0 && readJobsEnd > readJobsAt,
    'the owner must implement readJobs and wire agentStatusOf after it')
  const readJobsBody = owner.slice(readJobsAt, readJobsEnd)
  assert.match(readJobsBody, /const key = agents\.currentKey\(\)/u,
    'the owner must resolve the fence key from the injected facts at call time')
  assert.match(readJobsBody, /const sessionId = agents\.currentSessionId\(\)/u,
    'the owner must resolve the session id from the injected facts at call time')
  assert.match(readJobsBody, /jobs\.list\(sessionId\)/u,
    'the owner must read the jobs through its own injected adapter')
  assert.doesNotMatch(readJobsBody, /agentNow\(/u,
    'the owner-side jobs read must not read the Direct attachment')
  assert.doesNotMatch(owner, /readJobs: agents\.readJobs/u,
    'the TaskBrowserRuntime must receive the owner-side readJobs, not a root-provided one')
})
