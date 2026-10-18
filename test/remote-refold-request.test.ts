/**
 * S3-R0: the window-reconcile request fold — a `paging` wakeup (older history
 * became visible) must not re-measure the context, a `recovery` must, and a
 * recovery always wins over a pending paging request.
 *
 * @module @xmoon76/dsh-pi-tui/remote-refold-request.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  IDLE_REMOTE_REFOLD_REQUEST,
  requestRemoteRefold,
} from '../src/app/bootstrap/remote-refold-request.ts'

test('a paging request never measures, a recovery always does', () => {
  assert.deepEqual(requestRemoteRefold(IDLE_REMOTE_REFOLD_REQUEST, 'paging'),
    { pending: true, measure: false }, 'a prepend paging wakeup must not measure')
  assert.deepEqual(requestRemoteRefold(IDLE_REMOTE_REFOLD_REQUEST, 'recovery'),
    { pending: true, measure: true }, 'a recovery wakeup measures')
  assert.deepEqual(requestRemoteRefold(IDLE_REMOTE_REFOLD_REQUEST, undefined),
    { pending: true, measure: true }, 'an unlabelled wakeup measures')
})

test('a recovery escalates a pending paging request and paging never downgrades one', () => {
  const paging = requestRemoteRefold(IDLE_REMOTE_REFOLD_REQUEST, 'paging')
  assert.deepEqual(requestRemoteRefold(paging, 'recovery'), { pending: true, measure: true },
    'a recovery arriving while a paging reconcile is pending must measure it')
  const recovery = requestRemoteRefold(IDLE_REMOTE_REFOLD_REQUEST, 'recovery')
  assert.deepEqual(requestRemoteRefold(recovery, 'paging'), { pending: true, measure: true },
    'a paging request must not downgrade a pending recovery')
  assert.deepEqual(requestRemoteRefold(paging, 'paging'), { pending: true, measure: false },
    'paging stays measurement-free')
  assert.deepEqual(IDLE_REMOTE_REFOLD_REQUEST, { pending: false, measure: true },
    'the consumed/reset state allows the next unlabelled wakeup to measure')
})

test('the composition root folds the reason into the pump option (source lock)', async () => {
  // The chain ingress reason -> sink -> request fold -> pump option is the whole
  // point of the fix; the behavioral half above covers the fold, this lock covers
  // the wiring (the previous revision had a dead `remoteRefoldMeasure` slot that
  // was never assigned, which this asserts cannot come back).
  const bootstrap = readFileSync(new URL('../src/app/bootstrap.ts', import.meta.url), 'utf8')
  assert.ok(bootstrap.includes('remoteRefoldRequest = requestRemoteRefold(remoteRefoldRequest, reason)'),
    'the request sink folds the ingress reason')
  assert.ok(bootstrap.includes('const measure = remoteRefoldRequest.measure'),
    'the pump reads the folded decision')
  assert.ok(bootstrap.includes('remoteRefoldRequest = IDLE_REMOTE_REFOLD_REQUEST'),
    'the request is consumed (a later unlabelled wakeup measures)')
  assert.ok(bootstrap.includes('rehydrateFromWindow(sessionId, { measure })'),
    'the pump passes the folded decision into the reconcile')
  assert.ok(bootstrap.includes('rehydrateFromWindow(sessionId, { measure: false })'),
    'the DIRECT loadOlder paging caller never measures either')
  assert.ok(!bootstrap.includes('remoteRefoldMeasure'),
    'no dead measure slot may exist beside the request state')
  // The pump's second-level coalescing must keep the reason severity: the ONLY
  // way the pending state changes is the fold, and the decision is captured
  // BEFORE the await so a wakeup during an in-flight reconcile folds fresh.
  const foldSites = bootstrap.split('requestRemoteRefold(remoteRefoldRequest, reason)').length - 1
  assert.equal(foldSites, 1, 'every request folds through the severity-preserving helper')
  const pendingSites = bootstrap.split('remoteRefoldRequest =').length - 1
  assert.equal(pendingSites, 2,
    'the request state is only assigned by the fold and the post-run reset')
  assert.ok(bootstrap.indexOf('const measure = remoteRefoldRequest.measure')
    < bootstrap.indexOf('await presentation.rehydrateFromWindow(sessionId, { measure })'),
    'the decision is consumed BEFORE the reconcile await')
  assert.ok(bootstrap.includes('requestRemoteWindowRefold(id, reason)'),
    'the ingress onWindowRefoldRequired reason reaches the request sink')
})
