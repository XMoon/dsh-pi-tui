/** Host-owned dynamic footer instruction tests. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveFooterInstruction } from '../src/footer/instruction.ts'

test('exit confirmation instruction uses the effective key label', () => {
  for (const label of ['Ctrl+C', 'Ctrl+D', 'Ctrl+X', 'Leader X']) {
    const instruction = resolveFooterInstruction({
      exitConfirmKeyLabel: label,
      viewing: false,
    })
    assert.deepEqual(instruction, {
      id: 'exit-confirm',
      text: [{ text: `Press ${label} again to exit` }],
      priority: 100,
    })
  }
})

test('viewing suppresses the parent exit instruction', () => {
  assert.equal(resolveFooterInstruction({
    exitConfirmKeyLabel: 'Ctrl+D',
    viewing: true,
    leaderHint: 'Leader T',
  }), undefined)
})

test('leader hint remains the fallback when no exit confirmation is armed', () => {
  assert.deepEqual(resolveFooterInstruction({
    viewing: false,
    leaderHint: 'Leader T',
  }), {
    id: 'leader-which-key',
    text: [{ text: 'Leader T' }],
    priority: 90,
  })
})
