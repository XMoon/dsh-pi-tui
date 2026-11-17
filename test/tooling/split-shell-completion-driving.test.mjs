/**
 * The real multiline `!`/`!!` completion driver, driven through a narrow
 * four-member Client contract (`send`, `viewport`, `composerText`,
 * `composerOf`).
 *
 * The qualification defect this guards: the pre-Tab baseline used to scan the
 * WHOLE viewport, so a real earlier command painted in the transcript looked
 * like an already-offered completion and the case never sent Tab. Only the
 * current editor surface — the composer draft and the menu rows below its box —
 * may decide that baseline.
 *
 * This is a wiring/region proof for the smoke driver, not Host Shell evidence;
 * the real packed `surface.host-user-shell-f1` / sessionless G14 cases own that.
 *
 * @module split-shell-completion-driving.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { completeMultilineFromTui } from '../../scripts/smoke/split-process/shell-tui-driving.mjs'
import { SplitSmokeAssertionError } from '../../scripts/lib/split-smoke-diagnostics.mjs'

const RULE = '─'.repeat(40)
const CANDIDATE = 'f1-host-command'
const FORBIDDEN = 'f1-client-command'
const MENU = `menu: ${CANDIDATE}`

/**
 * One action-driven frame fake. It owns only the four members the completion
 * driver uses; the frame really contains a transcript, the composer box and the
 * rows below it, so `belowComposerRows` exercises its production region rule.
 */
function frameClient({ transcript = [], menuBeforeTab = [], draftAlreadyComplete = false } = {}) {
  let mode = 'prompt'
  let body = []
  let menu = [...menuBeforeTab]
  const sent = []
  const rows = () => body.length === 0 ? [mode === 'prompt' ? '❯' : mode] : [mode, ...body]
  const viewport = () => [
    ...transcript,
    RULE,
    ...rows(),
    RULE,
    ...menu,
    'footer',
  ]
  const composerText = () => rows().join('\n')
  const composerOf = frame => {
    const rules = frame.flatMap((line, index) => /^─+$/u.test(line.trim()) ? [index] : [])
    const bottom = rules.at(-1)
    const top = rules.at(-2)
    return top === undefined || bottom === undefined ? undefined : frame.slice(top + 1, bottom).join('\n')
  }
  return {
    sent,
    get tabCount() { return sent.filter(entry => entry === '\t').length },
    send(data) {
      sent.push(data)
      if (data === '!' || data === '!!') {
        assert.equal(mode, 'prompt')
        mode = data
        return
      }
      if (data.startsWith('\x1b[200~') && data.endsWith('\x1b[201~')) {
        body = data.slice('\x1b[200~'.length, -'\x1b[201~'.length).split('\n')
        if (draftAlreadyComplete) body[body.length - 1] = CANDIDATE
        return
      }
      if (data === '\t') {
        // The product's single-candidate completion is applied in place.
        body[body.length - 1] = CANDIDATE
        menu = []
        return
      }
      if (data === '\x03') {
        body = []
        menu = []
        mode = 'prompt'
        return
      }
      throw new Error(`unexpected input ${JSON.stringify(data)}`)
    },
    viewport,
    composerText,
    composerOf,
  }
}

async function rejection(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  assert.fail('the driver must fail')
}

test('a multiline shell completion treats an earlier transcript command as history, not the current completion surface', async () => {
  // The transcript really paints the exact completion candidate, as it does
  // after F1 has already run this Host command in an earlier turn.
  const client = frameClient({ transcript: ['🐋  Host executed', `❯ !${CANDIDATE}`, '  f1-host-command output'] })
  await completeMultilineFromTui(client, '!', ['echo first', 'f1-host-'], CANDIDATE, FORBIDDEN, 'history candidate')
  assert.equal(client.tabCount, 1, 'the client must send exactly the one Tab under test')
  assert.equal(client.composerText(), '❯', 'the driver must leave the editor in the empty prompt mode')
})

test('a multiline shell completion refuses to send Tab when the draft already holds the candidate', async () => {
  // The pasted draft already holds the full candidate (the user typed it), so
  // Tab must not be treated as the producer of that text.
  const client = frameClient({ draftAlreadyComplete: true })
  const error = await rejection(() => completeMultilineFromTui(
    client, '!', ['echo first', 'f1-host-'], CANDIDATE, FORBIDDEN, 'draft candidate',
  ))
  assert.ok(error instanceof SplitSmokeAssertionError, `expected the driver's own refusal, got ${String(error)}`)
  assert.match(String(error.message), /already in the draft before Tab/u)
  assert.equal(client.tabCount, 0, 'no Tab may be sent for a draft that already offers the candidate')
})

test('a multiline shell completion refuses to send Tab when the menu already holds the candidate', async () => {
  const client = frameClient({ menuBeforeTab: [MENU] })
  const error = await rejection(() => completeMultilineFromTui(
    client, '!', ['echo first', 'f1-host-'], CANDIDATE, FORBIDDEN, 'menu candidate',
  ))
  assert.ok(error instanceof SplitSmokeAssertionError, `expected the driver's own refusal, got ${String(error)}`)
  assert.match(String(error.message), /already below the composer before Tab/u)
  assert.equal(client.tabCount, 0, 'no Tab may be sent for a menu that already offers the candidate')
})
