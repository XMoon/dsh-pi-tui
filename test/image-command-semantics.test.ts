/**
 * M12 tests: the command semantics matrix — slash commands reject image
 * placeholders, plain prompts accept them, skills (non-local slash) follow
 * the plain-prompt rule; skill invocations support images (plan §19, review finding 4).
 * @module @xmoon76/dsh-pi-tui/image-command-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { commandRejectsImages, LOCAL_COMMANDS, normalizeSkillInvocation, SESSIONLESS_COMMANDS } from '../src/index.ts'

function storeWithImage(): DraftImageStore {
  const store = new DraftImageStore()
  store.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 800, height: 600 })
  return store
}

test('a plain prompt with an image is NOT a command rejection', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  assert.equal(commandRejectsImages(undefined, `analyze ${image.placeholder}`, store, name => name === 'help'), false)
})

test('a local command with an image placeholder is rejected', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  assert.equal(commandRejectsImages({ name: 'help' }, `/help ${image.placeholder}`, store, name => name === 'help'), true)
  assert.equal(commandRejectsImages({ name: 'status' }, `/status ${image.placeholder}`, store, name => name === 'status'), true)
})

test('a command without images is never rejected', () => {
  const store = storeWithImage()
  assert.equal(commandRejectsImages({ name: 'help' }, '/help', store, name => name === 'help'), false)
  assert.equal(commandRejectsImages({ name: 'model' }, '/model', store, name => name === 'model'), false)
})

test('a skill-style slash prompt with an image is AGENT input and NOT rejected (review finding 4)', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  assert.equal(commandRejectsImages({ name: 'grilling' }, `/grilling ${image.placeholder}`, store, name => name === 'help'), false)
})

test('a stale placeholder text is not a rejection (no staged image)', () => {
  const store = new DraftImageStore()
  assert.equal(commandRejectsImages({ name: 'help' }, '/help [image #1 (800×600)]', store, name => name === 'help'), false)
})

test('every LOCAL_COMMANDS entry is covered by the rejection matrix', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  for (const name of LOCAL_COMMANDS) {
    assert.equal(commandRejectsImages({ name }, `/${name} ${image.placeholder}`, store, () => true), true, `/${name} rejects images`)
  }
})

test('a /skill <name> invocation with an image is agent input (bare /skill stays local)', () => {
  const store = storeWithImage()
  const image = store.values()[0]!
  // The dispatch callback treats `skill` as non-local when it carries args.
  const withArgs = commandRejectsImages({ name: 'skill', rawInput: 'grilling [image #1 (800×600)]' } as never,
    `/skill grilling ${image.placeholder}`, store, name => name === 'skill' && false)
  assert.equal(withArgs, false, '/skill <name> + image is not rejected')
  // The bare picker stays local: rejected when the callback says local.
  const bare = commandRejectsImages({ name: 'skill', rawInput: '' } as never,
    '/skill', store, name => name === 'skill')
  assert.equal(bare, false, 'no image attached → nothing to reject')
})

test('SESSIONLESS_COMMANDS includes image: /image never creates a session (review finding 1)', () => {
  assert.ok(SESSIONLESS_COMMANDS.has('image'), '/image is sessionless')
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
