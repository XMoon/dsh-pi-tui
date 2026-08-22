/**
 * M12 tests: the command semantics matrix — slash commands reject image
 * placeholders, plain prompts accept them, skills (non-local slash) follow
 * the plain-prompt rule; skill invocations support images (plan §19, review finding 4).
 * @module @xmoon76/dsh-pi-tui/image-command-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { commandRejectsImages, LOCAL_COMMANDS } from '../src/index.ts'

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
