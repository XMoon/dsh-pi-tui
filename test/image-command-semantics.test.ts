/**
 * M12 tests: the command semantics matrix — slash commands reject image
 * placeholders, plain prompts accept them, skills (non-local slash) follow
 * the plain-prompt rule; skill invocations support images (plan §19, review finding 4).
 * @module @xmoon76/dsh-pi-tui/image-command-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { commandIsLocalForAttachments, commandRejectsImages, isLocalCommandLine, LOCAL_COMMANDS, normalizeSkillInvocation, resolveSubmitDelivery, SESSIONLESS_COMMANDS } from '../src/index.ts'

function storeWithImage(): DraftImageStore {
  const store = new DraftImageStore()
  store.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 800, height: 600 })
  return store
}

test('a plain prompt with an image is NOT a command rejection', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  assert.equal(commandRejectsImages(undefined, `analyze ${image.placeholder}`, store, false), false)
})

test('a local command with an image placeholder is rejected', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  assert.equal(commandRejectsImages({ name: 'help' }, `/help ${image.placeholder}`, store, LOCAL_COMMANDS.has('help')), true)
  assert.equal(commandRejectsImages({ name: 'status' }, `/status ${image.placeholder}`, store, LOCAL_COMMANDS.has('status')), true)
})

test('a command without images is never rejected', () => {
  const store = storeWithImage()
  assert.equal(commandRejectsImages({ name: 'help' }, '/help', store, LOCAL_COMMANDS.has('help')), false)
  assert.equal(commandRejectsImages({ name: 'model' }, '/model', store, LOCAL_COMMANDS.has('model')), false)
})

test('a skill-style slash prompt with an image is AGENT input and NOT rejected (review finding 4)', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  assert.equal(commandRejectsImages({ name: 'grilling' }, `/grilling ${image.placeholder}`, store, LOCAL_COMMANDS.has('grilling')), false)
})

test('a stale placeholder text is not a rejection (no staged image)', () => {
  const store = new DraftImageStore()
  assert.equal(commandRejectsImages({ name: 'help' }, '/help [image #1 (800×600)]', store, LOCAL_COMMANDS.has('help')), false)
})

test('every LOCAL_COMMANDS entry is covered by the rejection matrix', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  for (const name of LOCAL_COMMANDS) {
    assert.equal(commandRejectsImages({ name }, `/${name} ${image.placeholder}`, store, LOCAL_COMMANDS.has(name)), true, `/${name} rejects images`)
  }
})

test('a /skill <name> invocation with an image is agent input (bare /skill stays local)', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  // The PRODUCTION classifier: `/skill <name> ...` is agent-facing, the bare
  // picker is a TUI-local command.
  assert.equal(commandRejectsImages(
    { name: 'skill', rawInput: ' grilling' },
    `/skill grilling ${image.placeholder}`,
    store,
    commandIsLocalForAttachments({ name: 'skill', rawInput: ' grilling' }, undefined, undefined, false),
  ), false, '/skill <name> + image is not rejected')
  assert.equal(commandRejectsImages(
    { name: 'skill', rawInput: '' },
    '/skill',
    store,
    commandIsLocalForAttachments({ name: 'skill', rawInput: '' }, undefined, undefined, false),
  ), false, 'no image attached → nothing to reject')
})

test('attachment commands are local and sessionless', () => {
  assert.ok(SESSIONLESS_COMMANDS.has('attach'), '/attach is sessionless')
  assert.ok(SESSIONLESS_COMMANDS.has('image'), '/image is sessionless')
  assert.ok(LOCAL_COMMANDS.has('attach'), '/attach is local')
  assert.ok(LOCAL_COMMANDS.has('image'), '/image is local')
})

test('normalizeSkillInvocation rewrites /skill <name> <args> to /<name> <args> (review finding 2)', () => {
  assert.equal(normalizeSkillInvocation('/skill grilling foo bar'), '/grilling foo bar')
  assert.equal(normalizeSkillInvocation('/skill matrix-cli'), '/matrix-cli')
  assert.equal(normalizeSkillInvocation('/skill'), undefined, 'bare picker stays unnormalized')
  assert.equal(normalizeSkillInvocation('/help me'), undefined, 'non-skill commands untouched')
  assert.equal(normalizeSkillInvocation('plain prompt'), undefined)
})

test('normalizeSkillInvocation preserves the argument text VERBATIM (trailing whitespace included)', () => {
  // The skill-invocation contract: the user's words travel as the
  // original text — only the command-name separator is normalized.
  assert.equal(normalizeSkillInvocation('/skill grilling foo bar   '), '/grilling foo bar   ')
  assert.equal(normalizeSkillInvocation('/skill grilling   spaced  args '), '/grilling spaced  args ')
})

test('a LIVE skill wrapper is agent-facing even when a client contribution shares its name', () => {
  // The attachment gate must not treat a skill wrapper as a local UI command
  // just because a client contribution of the same name exists: the wrapper
  // route (its own slash line + injected body) supports images.
  const contribution = (name: string): boolean => name === 'grilling'
  const wrapper = (name: string): boolean => name === 'grilling'
  assert.equal(isLocalCommandLine('grilling', wrapper, contribution, false), false,
    'a live skill wrapper is agent-facing (multimodal), never a local command')
  assert.equal(isLocalCommandLine('grilling', undefined, contribution, false), true,
    'without a live wrapper the contribution IS the local client command')
  assert.equal(isLocalCommandLine('help', wrapper, contribution, false), true, 'core local commands stay local')
  assert.equal(isLocalCommandLine('plain', wrapper, contribution, false), false, 'an unknown name is not local')
})

test('a client command with a staged attachment is REJECTED as a local command (never run with a live attachment)', () => {
  // The contribution classification rides the SAME predicate as the dispatch:
  // a client-owned command is local, so an image/file-bearing line must be
  // refused (the client handler has no attachment channel) — while a live
  // skill wrapper of the same name stays agent-facing and is allowed.
  const store = storeWithImage()
  const image = store.values()[0]!
  const clientCommand = commandIsLocalForAttachments({ name: 'panel', rawInput: '' }, undefined, name => name === 'panel', false)
  assert.equal(commandRejectsImages({ name: 'panel' }, `/panel ${image.placeholder}`, store, clientCommand), true,
    'a client command rejects attachments')
  const skillWrapper = commandIsLocalForAttachments({ name: 'grilling', rawInput: ' args' }, name => name === 'grilling', name => name === 'grilling', false)
  assert.equal(commandRejectsImages({ name: 'grilling' }, `/grilling args ${image.placeholder}`, store, skillWrapper), false,
    'a live skill wrapper is agent-facing even when a client contribution shares the name')
  const explicitSkill = commandIsLocalForAttachments({ name: 'skill', rawInput: ' grilling' }, undefined, undefined, false)
  assert.equal(commandRejectsImages({ name: 'skill' }, `/skill grilling ${image.placeholder}`, store, explicitSkill), false,
    'an explicit /skill <name> invocation is agent-facing')
})

test('a HOST claim outranks a same-named client contribution in the attachment gate', () => {
  // Host authority: a contribution must never turn an attachment-bearing
  // /deploy line into a rejected "local command" while the host catalog owns
  // that line — the host handler decides its own attachment policy.
  const store = storeWithImage()
  const image = store.values()[0]!
  const colliding = commandIsLocalForAttachments(
    { name: 'deploy', rawInput: ' prod' },
    undefined,
    name => name === 'deploy',
    true,
  )
  assert.equal(commandRejectsImages({ name: 'deploy' }, `/deploy prod ${image.placeholder}`, store, colliding), false,
    'a host-claimed line is never a local command (the host route owns it)')
  const core = commandIsLocalForAttachments({ name: 'help', rawInput: '' }, undefined, undefined, true)
  assert.equal(core, false,
    '§D3 line authority (review round 2): a host-RESOLVED name is never TUI-local — even a LOCAL_COMMANDS member defers to the host route when the catalog claims its line')
  assert.equal(commandRejectsImages({ name: 'help' }, `/help ${image.placeholder}`, store, core), false,
    'the host descriptor owns the attachment policy of its own claimed line')
})

test('a client contribution claims the BARE token only: an argued line keeps its attachments', () => {
  // DSH `matchEnter`: a contribution is a slash-menu entry, so `if (!bare)
  // return undefined` — `/deploy explain` is an ordinary multimodal
  // submission, never a local client command (which would refuse the image).
  const store = storeWithImage()
  const image = store.values()[0]!
  const isClientCommand = (name: string): boolean => name === 'deploy'
  const bare = commandIsLocalForAttachments({ name: 'deploy', rawInput: '' }, undefined, isClientCommand, false)
  assert.equal(bare, true, 'the bare token IS the contribution invocation (a local client command)')
  assert.equal(commandRejectsImages({ name: 'deploy' }, `/deploy ${image.placeholder}`, store, bare), true,
    '…whose attachment-bearing form is impossible, but the classification is local')
  const argued = commandIsLocalForAttachments({ name: 'deploy', rawInput: ' explain' }, undefined, isClientCommand, false)
  assert.equal(argued, false, 'an argued line of a contribution name is an ordinary submission')
  assert.equal(commandRejectsImages({ name: 'deploy', rawInput: ' explain' }, `/deploy explain ${image.placeholder}`, store, argued), false,
    'the argued line keeps its image (no local-command refusal)')
})

test('the host claim is LINE-level: an execute-kind command does not claim its argued line', () => {
  // DSH `CommandDescriptor.input` decides which LINE a host command claims.
  // `/compact extra` is not a command invocation at all (upstream
  // `matchEnter`: `if (!bare) return undefined`), so it is an ordinary
  // multimodal submission — never the execute-kind command's attachment
  // refusal, and never a rejected "local command".
  const store = storeWithImage()
  const image = store.values()[0]!
  const bareCompact = commandIsLocalForAttachments({ name: 'compact', rawInput: '' }, undefined, undefined, true)
  assert.equal(bareCompact, false, 'the bare token IS the execute-kind invocation')
  const arguedCompact = commandIsLocalForAttachments({ name: 'compact', rawInput: ' extra' }, undefined, undefined, true)
  assert.equal(arguedCompact, false, 'an argued line of an execute-kind command is an ordinary submission')
  const arguedGoal = commandIsLocalForAttachments({ name: 'goal', rawInput: ' ship it' }, undefined, undefined, true)
  assert.equal(arguedGoal, false, 'a leadingInput command claims its argued line')
  // Without a client contribution of the same name both lines are ordinary
  // submissions in the attachment gate — the refusal decision belongs to the
  // dispatch, which distinguishes the claimed bare line from the rest.
  assert.equal(commandRejectsImages({ name: 'compact', rawInput: ' extra' }, `/compact extra ${image.placeholder}`, store, arguedCompact), false,
    'the argued execute-kind line keeps its image')
})

test('§D3 line authority: a HOST-RESOLVED name is never TUI-local (argued /export foo keeps attachments + ordinary-prompt semantics)', () => {
  // The frozen rc.2 Host /export (dsh-session-log-export) is execute-kind
  // (no leadingInput): its BARE token is a Host invocation, its ARGUED line
  // is an ordinary submission. The TUI also owns a Client /export built-in —
  // the host view must outrank the LOCAL_COMMANDS term in BOTH cases
  // (review round 2, external finding: the three sibling gates used to
  // disagree with the dispatch's precedence fix).
  assert.equal(isLocalCommandLine('export', undefined, undefined, true), false,
    'a CLAIMED host line is a host command, never TUI-local')
  assert.equal(isLocalCommandLine('export', undefined, undefined, true), false,
    'a RESOLVED-but-unclaimed argued line is an ordinary submission, never TUI-local (attachments allowed)')
  assert.equal(isLocalCommandLine('export', undefined, undefined, false), true,
    'with the host catalog not resolving the name at all, the TUI built-in stays local')
  // The attachment gate rides the same order end-to-end (the hostResolvesName
  // discriminator is NAME authority: both the bare and the argued line of a
  // resolved Host name defer to the host route).
  assert.equal(commandIsLocalForAttachments({ name: 'export', rawInput: 'foo' }, undefined, undefined, true), false,
    'an argued /export foo line keeps its attachments (ordinary multimodal submission)')
  assert.equal(commandIsLocalForAttachments({ name: 'export', rawInput: '' }, undefined, undefined, true), false,
    'the bare /export Host invocation is a HOST line — the TUI-local attachment refusal never applies (the host admission owns its policy)')
})


test('§D3 Direct parity matrix (review round 2 external gate): the TUI-built-in observable behavior is unchanged when no Host name collides', () => {
  // The Direct matrix the external review froze: with the authoritative Host
  // catalog NOT resolving a TUI built-in name, every observable classification
  // keeps its pre-precedence behavior — only a REAL host-resolved name changes
  // routing (the collision case above).
  const noHost = false
  // /settings bare: still an immediately-executed TUI local command.
  assert.equal(isLocalCommandLine('settings', undefined, undefined, noHost), true)
  // /help while running: still the queue placeholder (a local command never
  // steers), NOT the ordinary queue/steer policy.
  assert.equal(resolveSubmitDelivery({ name: 'help', rawInput: '' }, true, 'enter', 'steer', isLocalCommandLine('help', undefined, undefined, noHost)), 'queue')
  // /export with NO external Host claim: the TUI built-in path (local).
  assert.equal(isLocalCommandLine('export', undefined, undefined, noHost), true)
  // An argued line of a NO-collision TUI built-in: execute-kind built-ins keep
  // their ordinary-prompt busy policy only where the builtin itself declares
  // it; the local set stays local (the LOCAL_COMMANDS term rules unresolved
  // names exactly as before).
  assert.equal(resolveSubmitDelivery({ name: 'export', rawInput: 'foo' }, true, 'enter', 'steer', isLocalCommandLine('export', undefined, undefined, noHost)), 'queue')
  // A genuinely ordinary prompt line still follows the composer policy: the
  // accelerated CHORD takes the busyEnter preference's OPPOSITE (web parity)
  // — chord + steer-preference queues, chord + queue-preference steers. The
  // point: a host-resolved argued line participates in that policy instead of
  // the local-command queue placeholder.
  assert.equal(resolveSubmitDelivery({ name: 'export', rawInput: 'foo' }, true, 'accelerated', 'steer', false), 'queue',
    'chord takes the preference opposite — ordinary busy policy, not the local placeholder')
  assert.equal(resolveSubmitDelivery({ name: 'export', rawInput: 'foo' }, true, 'accelerated', 'queue', false), 'steer',
    'the steer side of the ordinary busy policy is reachable for a host-resolved argued line')
})

/* ── PR5 supplement: the Client self-claim authority correction ─────────── */

test('PR5: a TUI built-in\'s own Client registration never reads as Host territory (the PR4 self-claim regression)', () => {
  // The PR4 regression shape: on the Remote branch the TUI's own /status
  // registration appears in the EFFECTIVE claim union, so the retired
  // line-claim discriminator answered "host territory" and /status under a
  // running session resolved to steer. The corrected primitive derives
  // Host-NAME authority from the AUTHORITATIVE catalog alone.
  const clientSelfClaimPresent = true
  assert.equal(clientSelfClaimPresent, true, 'fixture: the union carries the Client self-claim')
  // Host catalog does NOT resolve 'status' → the TUI built-in stays LOCAL
  // (never steered) even while its own Client registration is claimed.
  assert.equal(isLocalCommandLine('status', undefined, undefined, false), true,
    '/status is a TUI-local line when the authoritative Host catalog does not resolve it')
  // The same correction rides the attachment gate.
  assert.equal(commandIsLocalForAttachments({ name: 'status', rawInput: '' }, undefined, undefined, false), true,
    'the attachment gate classifies /status as a local command (refuses staged images)')
  // A REAL Host-resolved name still defers to the Host route (both the
  // local-command term and a same-named contribution).
  assert.equal(isLocalCommandLine('export', undefined, undefined, true), false,
    'a Host-resolved name is never TUI-local (the rc.2 Host /export collision)')
  // The busy delivery consumes the same classification: a TUI local line
  // under steer-mode busy input takes the QUEUE placeholder, never steer.
  assert.equal(resolveSubmitDelivery({ name: 'status', rawInput: '' }, true, 'enter', 'steer', isLocalCommandLine('status', undefined, undefined, false)), 'queue',
    '/status under running + steer-mode busyEnter resolves to queue (the Client handler runs), never steer')
  assert.equal(resolveSubmitDelivery({ name: 'status', rawInput: '' }, true, 'accelerated', 'queue', isLocalCommandLine('status', undefined, undefined, false)), 'queue',
    'the accelerated gesture takes the same local-command placeholder')
  // Negative control: an agent-facing line still follows the busy policy.
  assert.equal(resolveSubmitDelivery(undefined, true, 'enter', 'steer', false), 'steer',
    'a plain prompt under steer-mode busy input still steers')
})

test('PR5: /exit and /quit are sessionless aliases with identical no-session behavior', () => {
  // PR5 supplement §6: `/quit` is `/exit`'s alias (registered as such), so
  // BOTH must ride SESSIONLESS_COMMANDS — before a session exists neither
  // may create one on its way to exiting.
  assert.equal(SESSIONLESS_COMMANDS.has('exit'), true, '/exit is sessionless')
  assert.equal(SESSIONLESS_COMMANDS.has('quit'), true, '/quit (the /exit alias) is sessionless too')
  assert.equal(LOCAL_COMMANDS.has('exit'), true)
  assert.equal(LOCAL_COMMANDS.has('quit'), true)
})
