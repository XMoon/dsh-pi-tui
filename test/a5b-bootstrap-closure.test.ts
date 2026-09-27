import assert from 'node:assert/strict'
import test from 'node:test'

import { compositionFile } from './support/composition-surface.ts'
import { ownerFile, ownerSource } from './support/owner-modules.ts'

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
  for (const bag of ['BootstrapContext', 'AppContext', 'GlobalRuntime', 'EverythingBag', 'RunnerContext', 'SurfaceContext']) {
    assert.equal(
      new RegExp(`\\b(?:interface|type|class)\\s+${bag}\\b`).test(source),
      false,
      `${bag} would be a universal dependency bag (plan A5b §6.3)`,
    )
  }
})

test('A5b: exactly one TuiAppEvents implementation exists across the owner surface', () => {
  // The A5b-5 cut moves the whole TuiAppEvents literal into its owner; until
  // then it is exactly one `const surfaceEvents: TuiAppEvents = {` site.
  const surface = ownerSource()
  assert.equal(
    surface.split('const surfaceEvents: TuiAppEvents = {').length - 1,
    1,
    'exactly one TuiAppEvents implementation must exist across the owner surface',
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

test('A5b: the Direct-facing viewed-queue slot stays a composition connector', () => {
  // `viewedQueueAgent` is deliberately NOT extracted: the Direct runtime reads
  // it through `getViewedQueueAgent`, so the composition root keeps the single
  // mutable slot and the viewer owner publishes into it (narrow seam).
  const root = compositionFile('src/app/bootstrap.ts')
  assert.ok(declares(root, 'viewedQueueAgent'), 'the composition root keeps the Direct viewed-queue slot')
  assert.match(root, /publishQueueAuthority: \(authority\) => \{ viewedQueueAgent = authority \}/u,
    'the viewer owner publishes the queue authority through the narrow composition callback')
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
