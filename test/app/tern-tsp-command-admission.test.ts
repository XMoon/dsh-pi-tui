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
    ['attach', 'copy', 'exit', 'fork', 'image', 'new', 'quit', 'rename', 'title', 'yolo'])
  for (const name of ['exit', 'quit', 'new', 'fork', 'title', 'rename', 'copy', 'yolo']) {
    assert.deepEqual(bare(classify({ tuiCommand: true }), name), { kind: 'available' },
      `/${name} is available on the TSP renderer`)
  }
  for (const name of [
    'settings', 'help', 'status', 'tasks', 'model', 'preset', 'footer', 'focus', 'display',
    'export', 'transcript', 'rewind', 'plugins', 'keybindings', 'login',
  ]) {
    assert.deepEqual(bare(classify({ tuiCommand: true }), name), { kind: 'unsupported' },
      `/${name} needs PiTui UI and is refused on the TSP renderer`)
  }
})

test('the Client-local attachment intake is available on the TSP renderer with its argument', () => {
  const tui = classify({ tuiCommand: true })
  // The REAL argued line: the handler reads the path from `rawInput`.
  assert.deepEqual(tspBuiltinAvailability(tui, 'image', {}, '<path>'), { kind: 'available' },
    '/image <path> stages into the mounted composer, so it is admitted')
  assert.deepEqual(tspBuiltinAvailability(tui, 'attach', {}, '<path>'), { kind: 'available' },
    '/attach <path> stages into the mounted composer, so it is admitted')
  // The PiTui-only chrome beside them stays refused — including the delivered
  // files browser (PR2 adds no TSP-native command or page).
  for (const name of ['view-image', 'export', 'transcript', 'deliverables']) {
    assert.deepEqual(tspBuiltinAvailability(tui, name, {}, '<path>'), { kind: 'unsupported' },
      `/${name} still needs a PiTui surface and is never admitted by the intake decision`)
  }
})

// ── The ONE input-shaped member: /logout ────────────────────────────────────

test('/logout is admitted ONLY in its explicit-target form', () => {
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

test('the argument-shaped admission never captures a non-TUI family', () => {
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

test('native Session Browser commands require the mounted capability', () => {
  const tui = classify({ tuiCommand: true })
  for (const name of ['sessions', 'resume', 'search']) {
    assert.deepEqual(bare(tui, name), { kind: 'unsupported' }, `/${name} is refused without the Browser`)
    assert.deepEqual(bare(tui, name, { sessionBrowser: true }), { kind: 'available' },
      `/${name} is admitted only when the Browser presenter is installed`)
  }
})

test('the Session Browser capability never captures a non-TUI family', () => {
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

// ── B3-A3: the ONE Task Center family (/tasks + its /subagents alias) ───────

test('G01/G02: /tasks is admitted ONLY when the display seam really declares the Task Center', () => {
  const tui = classify({ tuiCommand: true })
  // G01 — the mounted renderer negotiated the Hub + Reader capability.
  assert.deepEqual(bare(tui, 'tasks', { taskCenter: true }), { kind: 'available' })
  // G02 — false/undefined refuse it, and no OTHER picker stands in.
  assert.deepEqual(bare(tui, 'tasks', { taskCenter: false }), { kind: 'unsupported' })
  assert.deepEqual(bare(tui, 'tasks', {}), { kind: 'unsupported' })
  for (const substitute of [
    { modelPicker: true }, { presetPicker: true }, { sessionBrowser: true },
    { modelPicker: true, presetPicker: true, sessionBrowser: true },
  ]) {
    assert.deepEqual(bare(tui, 'tasks', substitute), { kind: 'unsupported' },
      'a sibling presenter is never a Task Center substitute')
  }
})

test('G03: the registered /subagents alias follows the SAME admission as /tasks', () => {
  const tui = classify({ tuiCommand: true })
  assert.deepEqual(bare(tui, 'subagents', { taskCenter: true }), { kind: 'available' })
  assert.deepEqual(bare(tui, 'subagents', { taskCenter: false }), { kind: 'unsupported' })
  assert.deepEqual(bare(tui, 'subagents', {}), { kind: 'unsupported' })
  // The alias is the SAME business entry: an argument never changes the verdict.
  for (const rawInput of ['', 'unrelated', 'agent:child-1']) {
    assert.deepEqual(tspBuiltinAvailability(tui, 'subagents', { taskCenter: true }, rawInput),
      { kind: 'available' }, 'the alias never gains or loses the capability by its argument shape')
  }
})

test('G04/G05/G06: the Task Center admission never captures a non-TUI family', () => {
  const capable = { taskCenter: true }
  // G04 — a genuine Host-origin /tasks keeps its own routing.
  const hostClaimed = classify({ hostClaim: { claimed: true, attachments: false }, tuiCommand: true })
  assert.deepEqual(bare(hostClaimed, 'tasks', capable), { kind: 'not-a-tui-builtin' })
  assert.deepEqual(bare(hostClaimed, 'subagents', capable), { kind: 'not-a-tui-builtin' })
  // A Host name that does not claim the argued line is an ordinary submission.
  assert.deepEqual(bare(classify({ hostClaim: { claimed: false }, tuiCommand: true }), 'tasks', capable),
    { kind: 'not-a-tui-builtin' })
  // G05 — an extension contribution or a skill invocation has its own owner.
  assert.deepEqual(bare(classify({ extensionCommand: true }), 'tasks', capable), { kind: 'not-a-tui-builtin' })
  assert.deepEqual(bare(classify({ skillInvocation: true }), 'tasks', capable), { kind: 'not-a-tui-builtin' })
  // G06 — an unregistered slash line / plain prompt is never captured by name.
  for (const name of ['tasks', 'subagents', 'tasks-and-more']) {
    assert.deepEqual(bare(classify({}), name, capable), { kind: 'not-a-tui-builtin' })
  }
})

test('G07/G08: the Task Center admission leaves the other builtins and the unconditional set untouched', () => {
  // G07 — the existing per-capability gates keep their verdicts, and the
  // Task Center capability never widens them.
  const tui = classify({ tuiCommand: true })
  assert.deepEqual(bare(tui, 'model', { taskCenter: true }), { kind: 'unsupported' })
  assert.deepEqual(bare(tui, 'preset', { taskCenter: true }), { kind: 'unsupported' })
  assert.deepEqual(bare(tui, 'sessions', { taskCenter: true }), { kind: 'unsupported' })
  assert.deepEqual(tspBuiltinAvailability(tui, 'logout', { taskCenter: true }, ''), { kind: 'unsupported' })
  assert.deepEqual(bare(tui, 'settings', { taskCenter: true }), { kind: 'unsupported' })
  for (const name of ['exit', 'quit', 'new', 'fork', 'title', 'rename', 'copy', 'yolo']) {
    assert.deepEqual(bare(tui, name, {}), { kind: 'available' })
  }
  // G08 — the Task Center is NOT an unconditional builtin, and the B2-A notice
  // scope keeps its membership (the success receipt of /tasks is the UI).
  assert.ok(!TSP_SUPPORTED_TUI_BUILTINS.has('tasks'))
  assert.ok(!TSP_SUPPORTED_TUI_BUILTINS.has('subagents'))
  assert.ok(!TSP_B2A_RESULT_NOTICE_COMMANDS.has('tasks'))
  assert.ok(!TSP_B2A_RESULT_NOTICE_COMMANDS.has('subagents'))
})

// ── The FAMILY is part of the result (the F1 fix) ───────────────────────────

test('every non-TUI family reports not-a-tui-builtin, never unsupported', () => {
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

test('the exit pair is available for the TUI family regardless of the name spelling', () => {
  const exit = classify({ tuiCommand: true })
  assert.equal(exit.kind, 'client-command')
  assert.deepEqual(bare(exit, 'quit'), { kind: 'available' },
    '/quit is /exit\'s canonical alias and stays available')
})

test('the B2-A builtins stay available for the TUI family whatever the argument shape is', () => {
  // A genuine Host winner would have been classified `host-command` (tested
  // above); within the TUI family the LINE argument never changes the
  // unconditional members.
  for (const name of ['new', 'fork', 'title', 'rename', 'copy', 'yolo']) {
    assert.deepEqual(tspBuiltinAvailability(classify({ tuiCommand: true }), name, {}, 'an argument'),
      { kind: 'available' }, `/${name} keeps its unconditional admission with an argument`)
  }
})

// ── RFL-001: the card-ownership policy the refusal sink consults ────────────

test('each mount has exactly ONE visible owner for a /title refusal', () => {
  // PiTui over Direct keeps its long-standing in-handler notice beside the card.
  assert.equal(titleRefusalNoticeOwner({ pituiPresentation: true, backendKind: 'direct' }), 'handler')
  // TSP over Direct: the command-result card carries the same text.
  assert.equal(titleRefusalNoticeOwner({ pituiPresentation: false, backendKind: 'direct' }), 'result-card')
  // The card-less Client command registry: the submission settlement publishes it.
  assert.equal(titleRefusalNoticeOwner({ pituiPresentation: false, backendKind: 'remote' }), 'submission-settlement')
  assert.equal(titleRefusalNoticeOwner({ pituiPresentation: true, backendKind: 'remote' }), 'submission-settlement')
})

test('a confirmed title write publishes its own notice only on the card-less TSP path', () => {
  // The base handler never announced success; the only mount that needs the line
  // is TSP over the Client command registry (no card, no PiTui presentation).
  assert.equal(titleSuccessNoticeVisible({ pituiPresentation: false, backendKind: 'remote' }), true)
  assert.equal(titleSuccessNoticeVisible({ pituiPresentation: false, backendKind: 'direct' }), false)
  assert.equal(titleSuccessNoticeVisible({ pituiPresentation: true, backendKind: 'remote' }), false)
  assert.equal(titleSuccessNoticeVisible({ pituiPresentation: true, backendKind: 'direct' }), false)
})

test('the card-less result-notice scope covers admitted builtins, the Browser family and /logout', () => {
  // The scope is derived from the ONE admission set (not a second routing list);
  // the conditionally admitted Browser family is included because it has no
  // command card on the card-less transport.
  assert.deepEqual([...TSP_B2A_RESULT_NOTICE_COMMANDS].sort(),
    [...TSP_SUPPORTED_TUI_BUILTINS, 'sessions', 'resume', 'search', 'logout'].sort())
  for (const name of ['new', 'fork', 'title', 'rename', 'copy', 'yolo', 'sessions', 'resume', 'search', 'logout']) {
    assert.ok(TSP_B2A_RESULT_NOTICE_COMMANDS.has(name), `/${name} needs an owner on the card-less route`)
  }
  // The attachment intake's SYNCHRONOUS refusal (a bare command, a malformed
  // argument, an unavailable draft composer) returns `CommandResult.error`
  // before any intake starts. On a renderer without a command card this
  // result notice is the ONLY visible owner of that refusal, so the two names
  // must stay in the scope. The scope never publishes a success result, which
  // is why the intake's asynchronous success message can still come from the
  // composer alone.
  for (const name of ['attach', 'image']) {
    assert.ok(TSP_SUPPORTED_TUI_BUILTINS.has(name), `/${name} is admitted on the TSP renderer`)
    assert.ok(TSP_B2A_RESULT_NOTICE_COMMANDS.has(name),
      `/${name} keeps its synchronous error visible on the card-less route`)
  }
  assert.ok(!TSP_B2A_RESULT_NOTICE_COMMANDS.has('preset'), 'sibling commands keep their own refusal notices')
  assert.ok(!TSP_B2A_RESULT_NOTICE_COMMANDS.has('model'))
})
