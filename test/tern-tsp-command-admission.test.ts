/**
 * PR3-B B2 command-admission unit tests.
 *
 * The predicate is the module under test here; its PRODUCTION consumer (the
 * `SubmissionController` admission) is exercised end-to-end on the real runner
 * in `tern-tsp-runner-interactive.test.ts` with an UNKNOWN-slash-line negative
 * control (the Host-same-name winner case needs the official Host catalog
 * fixture and is tracked with the B2 qualification work, not claimed here). This file deliberately does NOT re-implement the
 * consumer's family guard: a helper that supplies the guard production lacks
 * would be green while production misroutes (the B2 review's F1).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-command-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCommandLine, type CommandLineClassification } from '../src/domain/command/policy.ts'
import { tspBuiltinAvailability, TSP_SUPPORTED_TUI_BUILTINS } from '../src/app/command/tsp-capability.ts'

/** Classify one line through the REAL classifier with explicit fact wiring. */
function classify(facts: {
  hostClaim?: { claimed: boolean; attachments?: boolean }
  tuiCommand?: boolean
  extensionCommand?: boolean
  skillInvocation?: boolean
}): CommandLineClassification {
  return classifyCommandLine({
    hostOriginClaim: facts.hostClaim === undefined
      ? undefined
      : facts.hostClaim.claimed
        ? { claimed: true, attachments: facts.hostClaim.attachments === true }
        : { claimed: false },
    tuiCommand: facts.tuiCommand === true,
    extensionCommand: facts.extensionCommand === true,
    skillInvocation: facts.skillInvocation === true,
  })
}

// ── The predicate: exactly the exit pair is available for the TUI family ────

test('B2: the TSP builtin capability admits exactly /exit and /quit', () => {
  assert.deepEqual([...TSP_SUPPORTED_TUI_BUILTINS].sort(), ['exit', 'quit'])
  for (const name of ['exit', 'quit']) {
    assert.deepEqual(tspBuiltinAvailability(classify({ tuiCommand: true }), name), { kind: 'available' },
      `/${name} is available on the TSP renderer`)
  }
  for (const name of ['settings', 'help', 'status', 'tasks', 'model', 'preset', 'title', 'footer', 'focus', 'display']) {
    assert.deepEqual(tspBuiltinAvailability(classify({ tuiCommand: true }), name), { kind: 'unsupported' },
      `/${name} needs PiTui UI and is refused on the TSP renderer`)
  }
})

// ── The FAMILY is part of the result (the F1 fix) ───────────────────────────

test('B2: every non-TUI family reports not-a-tui-builtin, never unsupported', () => {
  // A genuine Host command claiming the line — even with a TUI registration of
  // the same name present in the facts.
  const hostClaimed = classify({ hostClaim: { claimed: true, attachments: false }, tuiCommand: true })
  assert.equal(hostClaimed.kind, 'host-command')
  assert.deepEqual(tspBuiltinAvailability(hostClaimed, 'settings'), { kind: 'not-a-tui-builtin' },
    'a Host command keeps its own routing')

  // A Host name that does not claim this argued line: an ordinary submission.
  const hostUnclaimed = classify({ hostClaim: { claimed: false }, tuiCommand: true })
  assert.equal(hostUnclaimed.kind, 'ordinary-submission')
  assert.deepEqual(tspBuiltinAvailability(hostUnclaimed, 'settings'), { kind: 'not-a-tui-builtin' })

  // A client extension contribution.
  const extension = classify({ extensionCommand: true })
  assert.deepEqual(tspBuiltinAvailability(extension, 'status'), { kind: 'not-a-tui-builtin' },
    'an extension contribution has its own execution owner')

  // A skill invocation (agent-facing input).
  assert.deepEqual(tspBuiltinAvailability(classify({ skillInvocation: true }), 'settings'),
    { kind: 'not-a-tui-builtin' })

  // An unregistered slash name / plain prompt.
  assert.deepEqual(tspBuiltinAvailability(classify({}), 'not-registered'), { kind: 'not-a-tui-builtin' })
})

test('B2: the exit pair is available for the TUI family regardless of the name spelling', () => {
  const exit = classify({ tuiCommand: true })
  assert.equal(exit.kind, 'client-command')
  assert.deepEqual(tspBuiltinAvailability(exit, 'quit'), { kind: 'available' },
    '/quit is /exit\'s canonical alias and stays available')
})
