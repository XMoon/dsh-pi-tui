/**
 * M12 tests: the command semantics matrix — slash commands reject image
 * placeholders, plain prompts accept them, skills (non-local slash) follow
 * the plain-prompt rule; skill invocations support images (plan §19, review finding 4).
 * @module @xmoon76/dsh-pi-tui/image-command-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { commandIsLocalForAttachments, commandRejectsImages, isLocalCommandLine, LOCAL_COMMANDS, normalizeSkillInvocation, SESSIONLESS_COMMANDS } from '../src/index.ts'
import type { HostCommandClaim } from '../src/commands.ts'

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
    commandIsLocalForAttachments({ name: 'skill', rawInput: ' grilling' }, undefined, undefined),
  ), false, '/skill <name> + image is not rejected')
  assert.equal(commandRejectsImages(
    { name: 'skill', rawInput: '' },
    '/skill',
    store,
    commandIsLocalForAttachments({ name: 'skill', rawInput: '' }, undefined, undefined),
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
  assert.equal(isLocalCommandLine('grilling', wrapper, contribution), false,
    'a live skill wrapper is agent-facing (multimodal), never a local command')
  assert.equal(isLocalCommandLine('grilling', undefined, contribution), true,
    'without a live wrapper the contribution IS the local client command')
  assert.equal(isLocalCommandLine('help', wrapper, contribution), true, 'core local commands stay local')
  assert.equal(isLocalCommandLine('plain', wrapper, contribution), false, 'an unknown name is not local')
})

test('a client command with a staged attachment is REJECTED as a local command (never run with a live attachment)', () => {
  // The contribution classification rides the SAME predicate as the dispatch:
  // a client-owned command is local, so an image/file-bearing line must be
  // refused (the client handler has no attachment channel) — while a live
  // skill wrapper of the same name stays agent-facing and is allowed.
  const store = storeWithImage()
  const image = store.values()[0]!
  const clientCommand = commandIsLocalForAttachments({ name: 'panel', rawInput: '' }, undefined, name => name === 'panel')
  assert.equal(commandRejectsImages({ name: 'panel' }, `/panel ${image.placeholder}`, store, clientCommand), true,
    'a client command rejects attachments')
  const skillWrapper = commandIsLocalForAttachments({ name: 'grilling', rawInput: ' args' }, name => name === 'grilling', name => name === 'grilling')
  assert.equal(commandRejectsImages({ name: 'grilling' }, `/grilling args ${image.placeholder}`, store, skillWrapper), false,
    'a live skill wrapper is agent-facing even when a client contribution shares the name')
  const explicitSkill = commandIsLocalForAttachments({ name: 'skill', rawInput: ' grilling' }, undefined, undefined)
  assert.equal(commandRejectsImages({ name: 'skill' }, `/skill grilling ${image.placeholder}`, store, explicitSkill), false,
    'an explicit /skill <name> invocation is agent-facing')
})

/** A host catalog stub with the real claim semantics (DSH `matchEnter`): a
 * descriptor with `input` claims its argued line, an execute-kind one claims
 * the bare token only, and a name the catalog does not hold is unresolved.
 * The catalogue is keyed by name. */
function hostCatalog(rows: Record<string, { leadingInput?: boolean; attachments?: boolean }>) {
  return (parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined => {
    const row = rows[parsed.name]
    if (row === undefined) return undefined
    if (row.leadingInput !== true && (parsed.rawInput?.trim() ?? '') !== '') return { claimed: false }
    return { claimed: true, attachments: row.attachments === true }
  }
}

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
    hostCatalog({ deploy: { leadingInput: true } }),
  )
  assert.equal(commandRejectsImages({ name: 'deploy' }, `/deploy prod ${image.placeholder}`, store, colliding), false,
    'a host-claimed line is never a local command (the host route owns it)')
  const core = commandIsLocalForAttachments({ name: 'help', rawInput: '' }, undefined, undefined, hostCatalog({ help: { leadingInput: true } }))
  assert.equal(commandRejectsImages({ name: 'help' }, `/help ${image.placeholder}`, store, core), true,
    'a TUI-owned local command stays local even if a registry claim exists for it')
})

test('a client contribution claims the BARE token only: an argued line keeps its attachments', () => {
  // DSH `matchEnter`: a contribution is a slash-menu entry, so `if (!bare)
  // return undefined` — `/deploy explain` is an ordinary multimodal
  // submission, never a local client command (which would refuse the image).
  const store = storeWithImage()
  const image = store.values()[0]!
  const isClientCommand = (name: string): boolean => name === 'deploy'
  const host = hostCatalog({})
  const bare = commandIsLocalForAttachments({ name: 'deploy', rawInput: '' }, undefined, isClientCommand, host)
  assert.equal(bare, true, 'the bare token IS the contribution invocation (a local client command)')
  assert.equal(commandRejectsImages({ name: 'deploy' }, `/deploy ${image.placeholder}`, store, bare), true,
    '…whose attachment-bearing form is impossible, but the classification is local')
  const argued = commandIsLocalForAttachments({ name: 'deploy', rawInput: ' explain' }, undefined, isClientCommand, host)
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
  const host = hostCatalog({ compact: {}, goal: { leadingInput: true } })
  const bareCompact = commandIsLocalForAttachments({ name: 'compact', rawInput: '' }, undefined, undefined, host)
  assert.equal(bareCompact, false, 'the bare token IS the execute-kind invocation')
  const arguedCompact = commandIsLocalForAttachments({ name: 'compact', rawInput: ' extra' }, undefined, undefined, host)
  assert.equal(arguedCompact, false, 'an argued line of an execute-kind command is an ordinary submission')
  const arguedGoal = commandIsLocalForAttachments({ name: 'goal', rawInput: ' ship it' }, undefined, undefined, host)
  assert.equal(arguedGoal, false, 'a leadingInput command claims its argued line')
  // Without a client contribution of the same name both lines are ordinary
  // submissions in the attachment gate — the refusal decision belongs to the
  // dispatch, which distinguishes the claimed bare line from the rest.
  assert.equal(commandRejectsImages({ name: 'compact', rawInput: ' extra' }, `/compact extra ${image.placeholder}`, store, arguedCompact), false,
    'the argued execute-kind line keeps its image')
})
