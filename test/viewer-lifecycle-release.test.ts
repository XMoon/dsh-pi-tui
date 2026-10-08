/**
 * M3-5 PR2 viewer-lifecycle structural guards (F1/F2 review findings).
 *
 * `ViewerRuntime` owns a Remote child generation (`tuiChildView`) plus its live
 * ingress. Two lifecycle rules cannot be observed from a pure unit harness —
 * they are end-of-life ordering rules across the composition root — so they are
 * pinned structurally here, next to the real-runner L6 that drives the positive
 * path (`test/runner-remote-task-center.test.ts`):
 *
 * - F1: a PENDING open has already retained its child generation, so EVERY
 *   supersession/end path must ABORT the open controller, not merely invalidate
 *   the request token;
 * - F2: the runner's surface disposal must tear the viewer down (ingress before
 *   reference) BEFORE the surface/app and the adapter → Client disposal chain.
 * @module @xmoon76/dsh-pi-tui/viewer-lifecycle-release.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  createViewerRuntime,
  type ViewerChildSource,
  type ViewerChildView,
  type ViewerRuntimeDeps,
} from '../src/app/surface/viewer-runtime.ts'
import type { SurfaceRuntime } from '../src/app/surface/runtime.ts'
import type { SessionPresentationEvent } from '../src/app/surface/session-presentation.ts'
import { toolSummaryKeys } from '../src/tui/transcript/tool-presentation.ts'
import { compositionSource } from './support/composition-surface.ts'
import { displaySeamStub } from './support/display-seam-stub.ts'

const viewerSource = readFileSync(
  new URL('../src/app/surface/viewer-runtime.ts', import.meta.url),
  'utf8',
)
const bootstrapSource = readFileSync(
  new URL('../src/app/bootstrap.ts', import.meta.url),
  'utf8',
)

/** The contiguous source span from one marker to the next. */
function span(from: string, to: string, source = viewerSource): string {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `cannot slice "${from}" .. "${to}"`)
  return source.slice(start, end)
}

test('F1: the pending open controller is owned and aborted on every supersession/end path', () => {
  const enter = span('const enterView = async (', 'const releaseViewHandle = ')
  assert.ok(enter.includes('openingAbort?.abort()'),
    'a NEW open must abort the previous in-flight one (its retained generation)')
  assert.ok(enter.indexOf('openingAbort?.abort()') < enter.indexOf('openingAbort = openController'),
    'the predecessor is aborted BEFORE the successor controller replaces the slot')
  assert.ok(enter.includes('if (openingAbort === openController) openingAbort = undefined'),
    'a settled open clears its own slot in the finally (never a successor\'s)')
  const exit = span('const exitView = (): boolean => {', 'const viewedChildPresentation')
  const exitAbortAt = exit.indexOf('openingAbort?.abort()')
  assert.ok(exitAbortAt >= 0, 'Esc must cancel a pending open even when nothing is mounted')
  assert.ok(exitAbortAt < exit.indexOf('if (viewing === undefined)'),
    'the exit abort must be REACHABLE when nothing is mounted, not nested behind the mounted branch')
  const swap = span('const teardownForSessionSwap = (): void => {', 'const dispose = (): void => {')
  // REACHABILITY, not text presence: `teardownViewerForSessionSwap` returns
  // before its callback when `!mounted`, so a FIRST pending open (nothing mounted
  // yet) must be cancelled OUTSIDE that callback.
  const swapAbortAt = swap.indexOf('openingAbort?.abort()')
  const swapHelperAt = swap.indexOf('teardownViewerForSessionSwap(')
  assert.ok(swapAbortAt >= 0, 'a session swap must cancel a pending open')
  assert.ok(swapAbortAt < swapHelperAt,
    'the swap abort must run BEFORE the mounted-only helper, never inside its callback (unreachable when nothing is mounted)')
  assert.ok(swap.indexOf('openingAbort = undefined') < swapHelperAt,
    'the swap must also clear the pending-open slot before the mounted-only helper runs')
  const dispose = span('const dispose = (): void => {', 'return {')
  assert.ok(dispose.includes('openingAbort?.abort()'), 'surface disposal must cancel a pending open')
  assert.ok(dispose.includes('viewerOpen.invalidate()'), 'surface disposal must invalidate the open token')
  assert.ok(dispose.indexOf('openingAbort?.abort()') < dispose.indexOf('releaseViewHandle()'),
    'the pending open is cancelled before the mounted handle is released')
})

test('F2: the viewer dispose drops the ingress BEFORE the child reference, exactly once', () => {
  const dispose = span('const dispose = (): void => {', 'return {')
  assert.ok(dispose.indexOf('viewing = undefined') >= 0, 'the mounted viewer state is dropped')
  assert.ok(dispose.includes('releaseViewHandle()'),
    'the child handle is released through the ONE release path')
  assert.ok(dispose.includes('viewerSessionAbort?.abort()'),
    'an in-flight follow-up of the dying viewer is cancelled')
  const release = span('const releaseViewHandle = (): void => {', 'const runDetachedViewerRehydrate')
  assert.ok(release.includes('runSyncDisposalSteps('),
    'the ingress + binding release is ONE non-truncating batch')
  assert.ok(release.indexOf('viewHandle = undefined') < release.indexOf('() => live?.dispose()'),
    'the retained binding slot is retired BEFORE the ingress callback runs')
  assert.ok(release.indexOf('viewLiveDispose = undefined') < release.indexOf('() => live?.dispose()'),
    'the ingress slot is retired BEFORE its callback runs')
  assert.ok(release.indexOf('() => live?.dispose()') < release.indexOf('() => handle?.release()'),
    'the live ingress goes down BEFORE the child generation is released')
})

test('F2: the runner surface disposal tears the viewer down before the surface/app teardown', () => {
  // TS2 §11 moved the idempotent client-surface teardown into the bootstrap
  // composition zone (`app/bootstrap/lifecycle.ts`), which now receives an
  // explicit `disposeViewer` seam. The ordering invariant is unchanged, and the
  // late-binding half is asserted on the seam's provider: a startup failure can
  // run this teardown before the viewer owner exists, so it must never capture a
  // `viewer` value (TDZ) — it reads `viewerRef` at call time.
  const zone = compositionSource()
  const disposal = span('const disposeSurface = (', 'const registerRunnerDisposal', zone)
  const viewerDisposeAt = disposal.indexOf('() => disposeViewer(),')
  const surfaceDisposeAt = disposal.indexOf('surface.dispose()')
  assert.ok(viewerDisposeAt >= 0, 'the runner must release the mounted/pending viewer on surface disposal')
  assert.ok(surfaceDisposeAt > viewerDisposeAt,
    'the viewer (client child generation + ingress) must go down before the surface/app and the Client Context')
  assert.ok(!disposal.includes('viewer.dispose()'),
    'the teardown must go through the late-bound seam, never a captured viewer')
  assert.equal(zone.split('disposeViewer: () => viewerRef?.dispose(),').length - 1, 1,
    'the viewer seam must read the late-bound `viewerRef` exactly once')
})

test('F7: the Remote image read fails closed without a captured display subject, never late-selecting one', () => {
  const readImage = span('readImage: (ref, context) => {', '\n      present,', bootstrapSource)
  assert.ok(readImage.includes('typeof subject'),
    'the Remote branch must require the captured display-subject token')
  assert.ok(readImage.includes("typeof subject.sessionId !== 'string'"),
    'the token must carry the asking Session id')
  assert.ok(/throw new ImageLoadError/u.test(readImage),
    'a mount without the capture seam must fail closed (a visible load failure)')
  assert.ok(!readImage.includes('viewer.read()'),
    'the read must never late-resolve the viewer subject after the ask')
  assert.ok(!readImage.includes('ownership.currentSessionId()'),
    'the read must never late-resolve the current main session after the ask')
  assert.ok(readImage.includes('readDurableImage(') && readImage.includes('subject.sessionId')
    && readImage.includes('subject.transportToken'),
  'the captured subject — INCLUDING its exact binding lifetime — is the only thing the Remote read may address')
  // The capture seam is part of the MOUNT CONTRACT (not an optional extra): the
  // surface deps must declare it required, so a future mount cannot silently omit
  // the ask-time subject and fall back to a late selection.
  const surfaceDeps = readFileSync(
    new URL('../src/app/surface/runtime.ts', import.meta.url),
    'utf8',
  )
  assert.ok(surfaceDeps.includes('readonly imageScope: () => unknown'),
    'the presentation scopes must be a REQUIRED mount input')
  assert.ok(!surfaceDeps.includes('imageScope?:'),
    'the presentation-scope seam must never be optional again')
})

test('P1: the image scope identity is the presentation LIFETIME, and the renderer stamps it at construction', () => {
  const scopeProvider = span('imageScope: () => {', 'readImage: (ref, context) => {', bootstrapSource)
  assert.ok(scopeProvider.includes('viewer.read()'),
    'the token follows the viewed child while its viewer is mounted')
  assert.ok(scopeProvider.includes('surface.display.getViewerGeneration()'),
    'a SAME-ID reopen is a NEW viewer generation, so it is a new scope lifetime')
  assert.ok(scopeProvider.includes('ownership.generation()'),
    'the main subject scope follows the owner generation, not the bare session id')
  assert.ok(scopeProvider.includes('imageScopeMain.key === key'),
    'the MAIN lifetime token is memoized in its own slot (a plain re-render reuses the SAME scope object)')
  assert.ok(scopeProvider.includes('imageScopeChild.key === key'),
    'the CHILD lifetime token is memoized in its own slot, so a child visit never re-mints the main token')
  // The loader itself must key bytes/in-flight/errors by the captured scope.
  const loader = readFileSync(new URL('../src/client/media/image/loader.ts', import.meta.url), 'utf8')
  assert.ok(loader.includes('private scopeOf(scope: unknown): LoaderScope'),
    'the loader resolves one state scope per CALLER-PASSED scope')
  assert.ok(!loader.includes('captureContext'),
    'the loader must never resolve an ambient subject itself')
  assert.ok(loader.includes('get(ref: ImageAttachmentRefLike, scope?: unknown)'),
    'every state read takes the owning presentation\'s scope explicitly')
  assert.ok(loader.includes('subscribe(attachmentId: string, listener: () => void, scope?: unknown)'),
    'the SUBSCRIBER identity is scoped too, so a sibling scope\'s settle never wakes it')
  assert.ok(!/private readonly cache: ImageCache\b/u.test(loader),
    'a single global bytes cache would let one subject satisfy another subject\'s authorization')
  // The renderer samples the presentation scope ONCE per component construction
  // and the component keeps it: no ambient re-resolution on any read path.
  const app = readFileSync(new URL('../src/tui-app.ts', import.meta.url), 'utf8')
  assert.ok(app.includes('imageScope?: () => unknown'),
    'the renderer receives the presentation-scope provider')
  assert.ok(app.includes('this.imageScope?.(),'),
    'the scope is sampled where the thumbnail is CONSTRUCTED')
  const thumbnail = readFileSync(
    new URL('../src/tui/components/media/image-thumbnail.ts', import.meta.url),
    'utf8',
  )
  assert.ok(thumbnail.includes('this.loader.get(this.ref, this.scope)'),
    'the component reads through its IMMUTABLE scope')
  assert.ok(thumbnail.includes('this.loader.load(this.ref, this.scope)'),
    'the component loads through its IMMUTABLE scope')
  assert.ok(thumbnail.includes('}, scope)'),
    'the component subscribes through its IMMUTABLE scope')
  // P1 (reviewer ROUND6): the scope must carry the EXACT binding lifetime into the
  // read — a surviving generation label is not enough, because the Remote source
  // would otherwise re-borrow `sessions.binding(id)` and let a retired presentation
  // read through a successor binding.
  assert.ok(scopeProvider.includes('captureTransportToken(sessionId)'),
    'the lifetime token is captured with the scope, once per lifetime')
  const presentation = readFileSync(
    new URL('../src/app/remote/presentation-source.ts', import.meta.url),
    'utf8',
  )
  assert.ok(presentation.includes('expectedLifetime: RemoteTransportLifetime'),
    'the durable read REQUIRES the owning presentation’s exact lifetime (no ambient fallback)')
  const portType = readFileSync(
    new URL('../src/app/application-runtime.ts', import.meta.url),
    'utf8',
  )
  assert.ok(portType.includes('export interface RemoteTransportLifetime'),
    'the lifetime is a structural type, not an opaque unknown')
  assert.ok(!/expectedLifetime\?:/u.test(portType),
    'the lifetime argument must never be optional again — the seam itself expresses the invariant')
  assert.ok(!presentation.includes('expectedLifetime?'),
    'the implementation must never accept a missing lifetime')
  assert.ok(presentation.includes("the presentation's Session binding for ${sessionId} is retired"),
    'a retired binding must fail closed BEFORE any Session is touched')
  const applicationRuntime = readFileSync(
    new URL('../src/app/application-runtime.ts', import.meta.url),
    'utf8',
  )
  assert.ok(applicationRuntime.includes('expectedLifetime: RemoteTransportLifetime'),
    'the port contract REQUIRES the expected lifetime')
})

/**
 * M3-6 PR3: the child live-ingress disposer is fault-injected through the REAL
 * owner. The retained child binding must still be released exactly once, the
 * ingress attempt must precede it, and the collected failure must surface
 * after both attempts — a second dispose is inert (the plan's D2 form).
 */
test('M3-6 PR3: a throwing ingress disposer cannot strand the retained child binding', async () => {
  const order: string[] = []
  const ingressError = new Error('ingress dispose failed')
  const view: ViewerChildView<SessionPresentationEvent> = {
    childSessionId: 'child-1',
    parentSessionId: 'parent-1',
    snapshot: { durableEvents: [], liveInputs: [], activity: 'inactive', cwd: '', revision: undefined },
    rehydrate: async () => undefined,
    loadOlder: async () => {},
    currentActivity: () => 'inactive',
    subscribe: () => ({
      dispose() {
        order.push('ingress')
        throw ingressError
      },
    }),
    release: () => { order.push('release') },
  }
  const childView: ViewerChildSource<SessionPresentationEvent> = {
    open: async () => view,
    childWriterSubject: () => undefined,
  }
  const surface = {
    routeSessionEvent: () => {},
    repaint: () => {},
    refreshPendingInput: () => {},
    // The viewer's admission reads the renderer-neutral capability seam.
    display: displaySeamStub(),
    app: {
      enterFocusViewerScope: () => {},
      setViewerMode: () => {},
    },
  } as unknown as SurfaceRuntime<SessionPresentationEvent>
  const viewer = createViewerRuntime<SessionPresentationEvent>({
    surface,
    isCleanedUp: () => false,
    summaryKeys: toolSummaryKeys,
    currentSessionId: () => 'parent-1',
    liveParentSessionId: () => 'parent-1',
    childView,
    refreshStatus: () => {},
    restoreMainTranscriptAnchor: () => {},
    runDetached: () => {},
  } satisfies ViewerRuntimeDeps<SessionPresentationEvent>)

  await viewer.enterView('child-1', 'child', 'one-shot', 'parent-1', 'inactive')
  assert.equal(viewer.isViewing(), true)

  assert.throws(() => viewer.dispose(), (error: unknown) => error === ingressError)
  assert.deepEqual(order, ['ingress', 'release'],
    'the binding release runs exactly once after the throwing ingress, and the failure surfaces after both')

  const releases = order.length
  viewer.dispose()
  assert.equal(order.length, releases, 'a second dispose does not re-run either release')
})
