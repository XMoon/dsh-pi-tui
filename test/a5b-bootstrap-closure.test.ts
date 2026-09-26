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
const PENDING_BOOTSTRAP_HANDLERS: readonly PendingHandler[] = [
  { name: 'runLocalShell', slice: 'A5b-4', owner: 'app/submission/local-shell' },
  { name: 'dispatchViaSession', slice: 'A5b-4', owner: 'app/submission/controller' },
  { name: 'runLocalCommand', slice: 'A5b-4', owner: 'app/submission/controller' },
  { name: 'steerNow', slice: 'A5b-4', owner: 'app/submission/controller' },
  { name: 'dispatchUserInput', slice: 'A5b-4', owner: 'app/submission/controller' },
  { name: 'surfaceEvents', slice: 'A5b-5', owner: 'app/surface/application-events' },
  { name: 'applyFooterSettings', slice: 'A5b-2', owner: 'app/surface/settings-runtime' },
  { name: 'registerCommands', slice: 'A5b-3', owner: 'app/command/surface' },
  { name: 'openRewindPicker', slice: 'A5b-5', owner: 'app/surface/application-events' },
  { name: 'refreshStatusCheap', slice: 'A5b-2', owner: 'app/surface/status-runtime' },
  { name: 'runner', slice: 'A5b-3', owner: 'app/command/surface' },
]

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
    'src/app/surface/session-presentation.ts',
    [
      'folder', 'windowController', 'statsFolder', 'mainStreamingToolPreviews',
      'mainPresentation', 'callArgs', 'resetForGeneration', 'initLiveSession',
      'TRANSCRIPT_WINDOW_TURNS', 'TRANSCRIPT_WINDOW_STEP', 'applyAssistantLiveInput',
      'mergeSessionEventCut',
    ],
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
  ['src/app/surface/session-presentation.ts', 'createSessionPresentation', 'createSessionPresentation<SessionEvent>('],
  ['src/app/surface/viewer-runtime.ts', 'createViewerRuntime', 'createViewerRuntime<SessionEvent, Agent>('],
]

test('A5b: each extracted owner is constructed exactly once, from the composition root', () => {
  const root = compositionFile('src/app/bootstrap.ts')
  for (const [rel, factory, site] of OWNER_CONSTRUCTIONS) {
    assert.ok(
      new RegExp(`export function ${factory}<`).test(ownerFile(rel)),
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
