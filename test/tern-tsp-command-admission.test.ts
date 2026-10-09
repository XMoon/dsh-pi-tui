/**
 * PR3-B B2 command-admission tests.
 *
 * The admission under test is the PRODUCTION one: the authoritative
 * `classifyCommandLine()` winner feeds `tspBuiltinAvailability()`, and the
 * TSP renderer's capability flag decides. The point of the suite is that the
 * TUI-builtin refusal can never capture a line the authoritative classifier
 * gave to the Host, the extension registry, a skill or an ordinary prompt —
 * i.e. the gate is post-classification, never a `/name` pre-parser.
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


/**
 * The production admission shape: only the TUI-origin family consults the
 * predicate. Declared with the WIDE classification type so a caller's
 * control-flow narrowing cannot silently make a case vacuous.
 */
function wouldRefuseAsTspBuiltin(classification: CommandLineClassification, name: string): boolean {
  return classification.kind === 'client-command'
    && classification.source === 'tui'
    && !tspBuiltinAvailability(classification, name).available
}

// ── The predicate itself (pure) ─────────────────────────────────────────────

test('B2: the TSP builtin capability admits exactly /exit and /quit', () => {
  assert.deepEqual([...TSP_SUPPORTED_TUI_BUILTINS].sort(), ['exit', 'quit'])
  for (const name of ['exit', 'quit']) {
    const classification = classify({ tuiCommand: true })
    assert.deepEqual(tspBuiltinAvailability(classification, name), { available: true },
      `/${name} is available on the TSP renderer`)
  }
  for (const name of ['settings', 'help', 'status', 'tasks', 'model', 'preset', 'title', 'footer', 'focus', 'display']) {
    const classification = classify({ tuiCommand: true })
    assert.deepEqual(tspBuiltinAvailability(classification, name),
      { available: false, reason: 'renderer-ui-unsupported' },
      `/${name} needs PiTui UI and is refused on the TSP renderer`)
  }
})

test('B2: the predicate refuses every NON-TUI family (the caller keeps its own routing)', () => {
  // A genuine Host-origin command of the SAME spelling as a refused TUI
  // builtin: the classifier returns `host-command`, so the gate must not
  // treat it as a TUI builtin at all.
  const hostSettings = classify({ hostClaim: { claimed: true, attachments: false }, tuiCommand: true })
  assert.equal(hostSettings.kind, 'host-command')
  assert.equal(tspBuiltinAvailability(hostSettings, 'settings').available, false,
    'a Host command is not this predicate\'s business')

  // A Host name that does not claim this line is an ordinary submission.
  const arguedHost = classify({ hostClaim: { claimed: false }, tuiCommand: true })
  assert.equal(arguedHost.kind, 'ordinary-submission')
  assert.equal(tspBuiltinAvailability(arguedHost, 'settings').available, false)

  // A plugin/client-extension contribution is a different owner.
  const extension = classify({ extensionCommand: true })
  assert.equal(extension.kind, 'client-command')
  assert.equal(tspBuiltinAvailability(extension, 'status').available, false,
    'an extension contribution has its own execution owner')

  // A skill invocation is agent-facing input.
  const skill = classify({ skillInvocation: true })
  assert.equal(skill.kind, 'skill-invocation')
  assert.equal(tspBuiltinAvailability(skill, 'settings').available, false)

  // A plain prompt.
  const plain = classify({})
  assert.equal(plain.kind, 'ordinary-submission')
  assert.equal(tspBuiltinAvailability(plain, 'settings').available, false)
})

test('B2: the exit pair stays available even when a Host claim is absent but a TUI registration shares the name', () => {
  // `/quit` is /exit's canonical alias; both are TUI-owned (source 'tui') and
  // both remain available, so the exit path can never be refused as
  // "unsupported UI".
  const exit = classify({ tuiCommand: true })
  assert.equal(exit.kind, 'client-command')
  assert.equal(exit.source, 'tui')
  assert.equal(tspBuiltinAvailability(exit, 'quit').available, true)
})

// ── The negative controls the plan names ────────────────────────────────────

test('B2: the SAME spelling owned by the Host keeps Host precedence (no misclassification)', () => {
  // `/settings` exists as BOTH a TUI builtin and (on a Host that declares it)
  // a Host command. The classifier gives the Host the win; the TSP refusal
  // must therefore NOT fire for that line.
  const line = 'settings'
  const tuiOnly = classify({ tuiCommand: true })
  const hostOwned = classify({ hostClaim: { claimed: true, attachments: false }, tuiCommand: true })

  assert.equal(tspBuiltinAvailability(tuiOnly, line).available, false,
    'the TUI /settings is refused on the TSP renderer')
  assert.equal(hostOwned.kind, 'host-command')
  // The production admission only consults the predicate for the TUI family,
  // so a Host-owned line never reaches the refusal:
  assert.equal(wouldRefuseAsTspBuiltin(hostOwned, line), false,
    'a Host-owned /settings is never refused by the TSP builtin gate')
  assert.equal(wouldRefuseAsTspBuiltin(tuiOnly, line), true,
    'the TUI-owned /settings IS refused (the positive control)')
})

test('B2: an unregistered slash name is never reported as an unsupported TSP builtin', () => {
  // `advertised-miss` / unknown-command behaviour belongs to the existing
  // classifier: an unknown name is an ordinary submission, not a TUI
  // builtin, so the TSP gate must not claim it.
  const unknown = classify({})
  assert.equal(unknown.kind, 'ordinary-submission')
  assert.equal(wouldRefuseAsTspBuiltin(unknown, 'settings'), false,
    'an unregistered slash name is never a refused TSP builtin')
})
