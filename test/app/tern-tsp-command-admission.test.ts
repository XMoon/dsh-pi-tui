/**
 * PR3-B B2 / PR4-B2-A command-admission unit tests.
 *
 * The predicate is the module under test here; its PRODUCTION consumer (the
 * `SubmissionController` admission) is exercised end-to-end on the real runner
 * in `tern-tsp-runner-interactive.test.ts` and `tern-tsp-direct-admission.test.ts`
 * with Unknown-slash and Host-same-name controls. This file deliberately does NOT re-implement the
 * consumer's family guard: a helper that supplies the guard production lacks
 * would be green while production misroutes (the B2 review's F1).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-command-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCommandLine, type CommandLineClassification } from '../../src/domain/command/policy.ts'
import { TSP_B2A_RESULT_NOTICE_COMMANDS, TSP_SUPPORTED_TUI_BUILTINS, titleRefusalNoticeOwner, titleSuccessNoticeVisible, tspBuiltinAvailability, type TspBuiltinPickers } from '../../src/app/command/tsp-capability.ts'

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

/** The predicate call with the default (no presenters, bare) input shape. */
function bare(classification: CommandLineClassification, name: string, pickers: TspBuiltinPickers = {}) {
  return tspBuiltinAvailability(classification, name, pickers, '')
}

// ── The unconditional set: the exit pair + the PR4-B2-A business builtins ───

test('the TSP builtin capability unconditionally admits the exit pair and the B2-A business builtins', () => {
  assert.deepEqual([...TSP_SUPPORTED_TUI_BUILTINS].sort(),
    ['copy', 'exit', 'fork', 'new', 'quit', 'rename', 'title', 'yolo'])
  for (const name of ['exit', 'quit', 'new', 'fork', 'title', 'rename', 'copy', 'yolo']) {
    assert.deepEqual(bare(classify({ tuiCommand: true }), name), { kind: 'available' },
      `/${name} is available on the TSP renderer`)
  }
  for (const name of [
    'settings', 'help', 'status', 'tasks', 'model', 'preset', 'footer', 'focus', 'display',
    'attach', 'image', 'export', 'transcript', 'rewind', 'plugins', 'keybindings', 'login',
  ]) {
    assert.deepEqual(bare(classify({ tuiCommand: true }), name), { kind: 'unsupported' },
      `/${name} needs PiTui UI and is refused on the TSP renderer`)
  }
})

// ── The ONE input-shaped member: /logout ────────────────────────────────────

test('B2-A: /logout is admitted ONLY in its explicit-target form', () => {
  const tui = classify({ tuiCommand: true })
  // Bare and whitespace-only forms need the credential picker: refused.
  assert.deepEqual(tspBuiltinAvailability(tui, 'logout', {}, ''), { kind: 'unsupported' })
  assert.deepEqual(tspBuiltinAvailability(tui, 'logout', {}, '   '), { kind: 'unsupported' })
  assert.deepEqual(tspBuiltinAvailability(tui, 'logout', {}, '\t\n'), { kind: 'unsupported' })
  // Any non-blank argument is admitted: the TARGET is the original handler's
  // own `resolveCredentialArg` business check, never this predicate's.
  for (const rawInput of ['some-target', ' deepseek-official ', 'nonsense', '"quoted target"']) {
    assert.deepEqual(tspBuiltinAvailability(tui, 'logout', {}, rawInput), { kind: 'available' },
      `bare /logout refused, argued ${JSON.stringify(rawInput)} admitted`)
  }
})

test('B2-A: the argument-shaped admission never captures a non-TUI family', () => {
  // A genuine Host /logout (with an argument) keeps its own routing.
  assert.deepEqual(tspBuiltinAvailability(
    classify({ hostClaim: { claimed: true, attachments: false }, tuiCommand: true }), 'logout', {}, 'some-target'),
  { kind: 'not-a-tui-builtin' })
  // A Host name that does not claim the argued line: an ordinary submission.
  assert.deepEqual(tspBuiltinAvailability(
    classify({ hostClaim: { claimed: false }, tuiCommand: true }), 'logout', {}, 'some-target'),
  { kind: 'not-a-tui-builtin' })
  assert.deepEqual(tspBuiltinAvailability(classify({}), 'logout', {}, 'some-target'), { kind: 'not-a-tui-builtin' })
})

// ── The FAMILY is part of the result (the F1 fix) ───────────────────────────

test('B1-B: native Session Browser commands require the mounted capability', () => {
  const tui = classify({ tuiCommand: true })
  for (const name of ['sessions', 'resume', 'search']) {
    assert.deepEqual(bare(tui, name), { kind: 'unsupported' }, `/${name} is refused without the Browser`)
    assert.deepEqual(bare(tui, name, { sessionBrowser: true }), { kind: 'available' },
      `/${name} is admitted only when the Browser presenter is installed`)
  }
})

test('B1-B: the Session Browser capability never captures a non-TUI family', () => {
  const browser = { sessionBrowser: true }
  const hostClaimed = classify({ hostClaim: { claimed: true, attachments: false }, tuiCommand: true })
  assert.deepEqual(bare(hostClaimed, 'sessions', browser), { kind: 'not-a-tui-builtin' })
  for (const facts of [
    { extensionCommand: true },
    { skillInvocation: true },
    {},
  ]) {
    const classification = classify(facts)
    for (const name of ['sessions', 'resume', 'search']) {
      assert.deepEqual(bare(classification, name, browser), { kind: 'not-a-tui-builtin' })
    }
  }
})

// ── The FAMILY is part of the result (the F1 fix) ───────────────────────────

test('B2: every non-TUI family reports not-a-tui-builtin, never unsupported', () => {
  // A genuine Host command claiming the line — even with a TUI registration of
  // the same name present in the facts.
  const hostClaimed = classify({ hostClaim: { claimed: true, attachments: false }, tuiCommand: true })
  assert.equal(hostClaimed.kind, 'host-command')
  assert.deepEqual(bare(hostClaimed, 'settings'), { kind: 'not-a-tui-builtin' },
    'a Host command keeps its own routing')

  // A Host name that does not claim this argued line: an ordinary submission.
  const hostUnclaimed = classify({ hostClaim: { claimed: false }, tuiCommand: true })
  assert.equal(hostUnclaimed.kind, 'ordinary-submission')
  assert.deepEqual(bare(hostUnclaimed, 'settings'), { kind: 'not-a-tui-builtin' })

  // A client extension contribution.
  const extension = classify({ extensionCommand: true })
  assert.deepEqual(bare(extension, 'status'), { kind: 'not-a-tui-builtin' },
    'an extension contribution has its own execution owner')

  // A skill invocation (agent-facing input).
  assert.deepEqual(bare(classify({ skillInvocation: true }), 'settings'), { kind: 'not-a-tui-builtin' })

  // An unregistered slash name / plain prompt.
  assert.deepEqual(bare(classify({}), 'not-registered'), { kind: 'not-a-tui-builtin' })
})

test('B2: the exit pair is available for the TUI family regardless of the name spelling', () => {
  const exit = classify({ tuiCommand: true })
  assert.equal(exit.kind, 'client-command')
  assert.deepEqual(bare(exit, 'quit'), { kind: 'available' },
    '/quit is /exit\'s canonical alias and stays available')
})

test('B2-A: the B2-A builtins stay available for the TUI family whatever the argument shape is', () => {
  // A genuine Host winner would have been classified `host-command` (tested
  // above); within the TUI family the LINE argument never changes the
  // unconditional members.
  for (const name of ['new', 'fork', 'title', 'rename', 'copy', 'yolo']) {
    assert.deepEqual(tspBuiltinAvailability(classify({ tuiCommand: true }), name, {}, 'an argument'),
      { kind: 'available' }, `/${name} keeps its unconditional admission with an argument`)
  }
})

// ── RFL-001: the card-ownership policy the refusal sink consults ────────────

test('B2-A: each mount has exactly ONE visible owner for a /title refusal', () => {
  // PiTui over Direct keeps its long-standing in-handler notice beside the card.
  assert.equal(titleRefusalNoticeOwner({ pituiPresentation: true, backendKind: 'direct' }), 'handler')
  // TSP over Direct: the command-result card carries the same text.
  assert.equal(titleRefusalNoticeOwner({ pituiPresentation: false, backendKind: 'direct' }), 'result-card')
  // The card-less Client command registry: the submission settlement publishes it.
  assert.equal(titleRefusalNoticeOwner({ pituiPresentation: false, backendKind: 'remote' }), 'submission-settlement')
  assert.equal(titleRefusalNoticeOwner({ pituiPresentation: true, backendKind: 'remote' }), 'submission-settlement')
})

test('B2-A: a confirmed title write publishes its own notice only on the card-less TSP path', () => {
  // The base handler never announced success; the only mount that needs the line
  // is TSP over the Client command registry (no card, no PiTui presentation).
  assert.equal(titleSuccessNoticeVisible({ pituiPresentation: false, backendKind: 'remote' }), true)
  assert.equal(titleSuccessNoticeVisible({ pituiPresentation: false, backendKind: 'direct' }), false)
  assert.equal(titleSuccessNoticeVisible({ pituiPresentation: true, backendKind: 'remote' }), false)
  assert.equal(titleSuccessNoticeVisible({ pituiPresentation: true, backendKind: 'direct' }), false)
})

test('B2-A: the card-less result-notice scope is the admitted set plus /logout', () => {
  // The scope is derived from the ONE admission set (not a second routing list).
  assert.deepEqual([...TSP_B2A_RESULT_NOTICE_COMMANDS].sort(),
    [...TSP_SUPPORTED_TUI_BUILTINS, 'logout'].sort())
  for (const name of ['new', 'fork', 'title', 'rename', 'copy', 'yolo', 'logout']) {
    assert.ok(TSP_B2A_RESULT_NOTICE_COMMANDS.has(name), `/${name} needs an owner on the card-less route`)
  }
  assert.ok(!TSP_B2A_RESULT_NOTICE_COMMANDS.has('preset'), 'sibling commands keep their own refusal notices')
  assert.ok(!TSP_B2A_RESULT_NOTICE_COMMANDS.has('model'))
})
