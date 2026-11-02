/**
 * M4 PR4 — the Client-local `/reload-client` safety decision.
 *
 * The classifier is PURE: it merges the facts of the ONE owning live sources
 * (Composer draft, the two draft stores, the submission/interaction/transition
 * owners) into a fixed-priority refusal. This suite pins the priority and the
 * exact facts that must never be approximated:
 *
 * - a whitespace-only draft is real input (`.trim()` would lose it);
 * - a staged image/file entry counts even when the editor text no longer
 *   references it (a pinned occurrence, not a placeholder count);
 * - every unsafe state refuses; the CLIENTS still stay alive (the caller owns
 *   the old surface — this module never stops anything);
 * - a Client without the process capability is `unavailable`, so Direct can
 *   never be mistaken for a safe reload.
 *
 * EVIDENCE LEVEL: pure unit. The real owners → refusal → process sink chain is
 * covered by the submission/runner composition suites and the two-package
 * upgrade smoke (U08).
 *
 * @module @xmoon76/dsh-pi-tui/client-reload-safety.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { clientReloadRefusal, type ClientReloadSafetyFacts } from '../../src/app/remote-process/client-reload-safety.ts'

/** One fully safe fact set: every case below flips exactly one fact. */
function safeFacts(overrides: Partial<ClientReloadSafetyFacts> = {}): ClientReloadSafetyFacts {
  return {
    capable: true,
    ready: true,
    draftText: '',
    stagedImageCount: 0,
    stagedFileCount: 0,
    unsettledUserWrite: false,
    unsettledInteraction: false,
    unsettledTransition: false,
    ...overrides,
  }
}

test('a ready split Client with no local input may retire', () => {
  assert.equal(clientReloadRefusal(safeFacts()), undefined)
})

test('the refusal priority is unavailable -> not-ready -> draft-text -> attachments -> submission -> interaction -> transition', () => {
  assert.equal(clientReloadRefusal(safeFacts({
    capable: false,
    ready: false,
    draftText: 'x',
    stagedImageCount: 1,
    stagedFileCount: 1,
    unsettledUserWrite: true,
    unsettledInteraction: true,
    unsettledTransition: true,
  })), 'unavailable', 'Direct / a Client without the process capability is never a reload')
  assert.equal(clientReloadRefusal(safeFacts({
    ready: false,
    draftText: 'x',
    stagedImageCount: 1,
    stagedFileCount: 1,
    unsettledUserWrite: true,
    unsettledInteraction: true,
    unsettledTransition: true,
  })), 'not-ready')
  assert.equal(clientReloadRefusal(safeFacts({
    draftText: 'x',
    stagedImageCount: 1,
    stagedFileCount: 1,
    unsettledUserWrite: true,
    unsettledInteraction: true,
    unsettledTransition: true,
  })), 'draft-text')
  assert.equal(clientReloadRefusal(safeFacts({
    stagedImageCount: 1,
    stagedFileCount: 1,
    unsettledUserWrite: true,
    unsettledInteraction: true,
    unsettledTransition: true,
  })), 'attachments')
  assert.equal(clientReloadRefusal(safeFacts({
    stagedFileCount: 1,
    unsettledUserWrite: true,
    unsettledInteraction: true,
    unsettledTransition: true,
  })), 'attachments', 'a staged FILE alone refuses too')
  assert.equal(clientReloadRefusal(safeFacts({
    unsettledUserWrite: true,
    unsettledInteraction: true,
    unsettledTransition: true,
  })), 'submission')
  assert.equal(clientReloadRefusal(safeFacts({
    unsettledInteraction: true,
    unsettledTransition: true,
  })), 'interaction')
  assert.equal(clientReloadRefusal(safeFacts({ unsettledTransition: true })), 'transition')
})

test('a whitespace-only draft is real unsubmitted input', () => {
  for (const draft of [' ', '\n', '\t', '   \n  ']) {
    assert.equal(clientReloadRefusal(safeFacts({ draftText: draft })), 'draft-text',
      `a ${JSON.stringify(draft)} draft must refuse — trimming would silently lose it`)
  }
})

test('staged attachments count even when the editor no longer references them', () => {
  // The caller reports the REAL draft-store sizes, so a pinned/unreferenced
  // occurrence is not invisible merely because the draft text is empty.
  assert.equal(clientReloadRefusal(safeFacts({ stagedImageCount: 1 })), 'attachments')
  assert.equal(clientReloadRefusal(safeFacts({ stagedFileCount: 1 })), 'attachments')
})

test('a refused reload reports the FIRST fixable reason and never a fabricated safe state', () => {
  // A real state with BOTH a draft and an in-flight submission reports the
  // draft: the user clears it, retries, and only then learns about the write.
  assert.equal(clientReloadRefusal(safeFacts({ draftText: 'hello', unsettledUserWrite: true })), 'draft-text')
  // Unknown/foreign refusal reasons cannot exist: the union is closed.
  assert.equal(clientReloadRefusal(safeFacts({ capable: false })), 'unavailable')
})
