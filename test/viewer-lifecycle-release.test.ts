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
  const enter = span('const enterView = async (', 'const disposeViewLive = ')
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
  assert.ok(release.indexOf('disposeViewLive()') < release.indexOf('handle?.release()'),
    'the live ingress goes down BEFORE the child generation is released')
  const live = span('const disposeViewLive = (): void => {', 'const releaseViewHandle')
  assert.ok(live.includes('handle?.dispose()'), 'the ingress handle is disposed (idempotent)')
})

test('F2: the runner surface disposal tears the viewer down before the surface/app teardown', () => {
  const disposal = span('const disposeSurface = (): void => {', 'const registerRunnerDisposal', bootstrapSource)
  const viewerDisposeAt = disposal.indexOf('viewerRef?.dispose()')
  const surfaceDisposeAt = disposal.indexOf('surface.dispose()')
  assert.ok(viewerDisposeAt >= 0, 'the runner must release the mounted/pending viewer on surface disposal')
  assert.ok(surfaceDisposeAt > viewerDisposeAt,
    'the viewer (client child generation + ingress) must go down before the surface/app and the Client Context')
  assert.ok(!disposal.includes('viewer.dispose()'),
    'the closure must use the late-bound `viewerRef` (a startup failure can run this before the owner exists)')
})

test('F7: the Remote image read fails closed without a captured display subject, never late-selecting one', () => {
  const readImage = span('readImage: (ref, context) => {', '\n      present,', bootstrapSource)
  assert.ok(readImage.includes("typeof context !== 'string'"),
    'the Remote branch must require the captured subject')
  assert.ok(/throw new ImageLoadError/u.test(readImage),
    'a mount without the capture seam must fail closed (a visible load failure)')
  assert.ok(!readImage.includes('viewer.read()'),
    'the read must never late-resolve the viewer subject after the ask')
  assert.ok(!readImage.includes('ownership.currentSessionId()'),
    'the read must never late-resolve the current main session after the ask')
  assert.ok(readImage.includes('attachments.readDurableImage(context, ref.attachmentId)'),
    'the captured subject is the ONLY Session the Remote read may address')
  // The capture seam is part of the MOUNT CONTRACT (not an optional extra): the
  // surface deps must declare it required, so a future mount cannot silently omit
  // the ask-time subject and fall back to a late selection.
  const surfaceDeps = readFileSync(
    new URL('../src/app/surface/runtime.ts', import.meta.url),
    'utf8',
  )
  assert.ok(surfaceDeps.includes('readonly activeImageSubject: () => unknown'),
    'the display-subject capture must be a REQUIRED mount input')
  assert.ok(!surfaceDeps.includes('activeImageSubject?:'),
    'the capture seam must never be optional again')
})
