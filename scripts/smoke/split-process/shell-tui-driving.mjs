/**
 * The shared REAL-PTY driving of the `!`/`!!` Shell editor completion: the
 * composer-mode witnesses, the completion dropdown/auto-apply acceptance and
 * the single/multiline completion flows.
 *
 * Both the F1 live-Session case and the G14 sessionless-Workspace case drive
 * the SAME production editor through these helpers, so a completion can never
 * be "proven" through a second, case-local key sequence. Every helper waits
 * for a PAINTED state before sending the next byte: the modes are editor
 * STATE, not text, so a coalesced PTY chunk must never insert the prefix as
 * literal draft text.
 *
 * @module split-process/shell-tui-driving
 */

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The composer rows with box chrome and padding normalized away. */
function composerRows(composer) {
  return composer?.split('\n')
    .map(line => line.replace(/[│┌┐└┘─]/gu, ' ').trim())
    .filter(Boolean) ?? []
}

/**
 * Wait for the AUTHORITATIVE empty composer of `mode`. This never types an
 * Escape: every transition before the wait is a product-owned input action,
 * so a timeout is a real state failure and no stray ESC is left queued for
 * the next completion's literal `!`.
 */
export async function waitForComposerMode(client, mode, label, timeoutMs = 30_000) {
  const expected = mode === 'prompt' ? '❯' : mode
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const rows = composerRows(await client.composerText())
    // The empty draft may paint a dim PLACEHOLDER hint after the prompt glyph
    // (observed as '❯ ………'). It is presentation-only, not draft text, so the
    // empty-mode witness strips trailing ellipsis/dot padding instead of
    // demanding a literally bare glyph row.
    // EMPTY-EDITOR witness: the mode glyph must be followed by NO draft text.
    // A connection banner / diagnostic line may share the composer box after a
    // transport drop; that presentation-only hint is the sole tolerated body.
    const first = rows[0] ?? ''
    const shellLocalIsNotContext = expected === '!' && first.startsWith('!!')
    if (!shellLocalIsNotContext && first.startsWith(expected)) {
      const body = first.slice(expected.length).replace(/[\s.…·]+$/u, '').trim()
      // Presentation-only hints: an empty body, a pure placeholder, or a
      // connection banner whose remaining text is still the banner itself.
      const hintOnly = body === ''
        || /^[…·]+$/u.test(body)
        || (/^\[connection\]/u.test(body) && /(?:connection lost|reconnect|retry)/iu.test(body))
      if (hintOnly) return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label} did not reach the empty ${mode} composer: ${JSON.stringify(await client.composerText())}`)
}

/** Wait until the CURRENT composer draft holds `text` (never the transcript). */
export async function waitForComposerText(client, text, label, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await client.composerText() ?? '').includes(text)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new SplitSmokeAssertionError(`${label} did not reach the composer: ${JSON.stringify(await client.composerText())}`)
}

/**
 * Rows painted BELOW the composer box (after its bottom rule). The transcript
 * is above the box, so a candidate found here belongs ONLY to the completion
 * dropdown painted by the current Tab — never to old transcript text. The
 * footer shares this region but never carries a completion candidate.
 */
function belowComposerRows(viewport) {
  let bottom = -1
  for (let index = 0; index < viewport.length; index += 1) {
    if (/^─+$/u.test(viewport[index].trim())) bottom = index
  }
  return bottom === -1 ? [] : viewport.slice(bottom + 1)
}

/**
 * Accept the CURRENT completion offer after a Tab. Tab has exactly two
 * user-visible outcomes: a single candidate is applied in place, or several
 * candidates open a dropdown painted BELOW the composer. Both are accepted
 * here (the dropdown needs a second Tab); a forbidden candidate anywhere in
 * the current completion surface fails the case.
 */
export async function acceptOfferedCompletion(client, candidate, forbidden, label) {
  const deadline = Date.now() + 30_000
  let offered
  let offeredDraft = ''
  while (Date.now() < deadline) {
    const viewport = await client.viewport()
    const draft = client.composerOf(viewport) ?? ''
    if (draft.includes(candidate)) {
      offered = 'applied'
      offeredDraft = draft
      break
    }
    if (belowComposerRows(viewport).join('\n').includes(candidate)) {
      offered = 'menu'
      offeredDraft = draft
      break
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (offered === undefined) {
    throw new SplitSmokeAssertionError(`${label} did not produce ${candidate} in the current completion UI: frameTail=${(await client.viewport()).slice(-12).join('\\n')}; composer=${JSON.stringify(await client.composerText())}`)
  }
  const offeredBelow = belowComposerRows(await client.viewport()).join('\n')
  assert(!offeredDraft.includes(forbidden) && !offeredBelow.includes(forbidden),
    `${label} leaked a Client-only suggestion into the current completion UI: composer=${JSON.stringify(offeredDraft)}; below=${JSON.stringify(offeredBelow)}`)
  if (offered === 'menu') {
    const draftBeforeAccept = offeredDraft
    client.send('\t')
    const acceptDeadline = Date.now() + 30_000
    let accepted = false
    while (Date.now() < acceptDeadline) {
      const viewport = await client.viewport()
      const draft = client.composerOf(viewport) ?? ''
      const stillOffered = belowComposerRows(viewport).join('\n').includes(candidate)
      if (draft !== draftBeforeAccept && !stillOffered) {
        accepted = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(accepted, `${label} dropdown acceptance did not commit a new draft and close the menu: composer=${JSON.stringify(await client.composerText())}`)
    const acceptedDraft = (await client.composerText()) ?? ''
    assert(!acceptedDraft.includes(forbidden), `${label} accepted draft leaked a Client-only suggestion: ${JSON.stringify(acceptedDraft)}`)
  }
  return offered
}

async function completeFromTui(client, input, candidate, forbidden, label) {
  const mode = input.startsWith('!!') ? '!!' : '!'
  const body = input.slice(mode.length)
  await waitForComposerMode(client, 'prompt', `${label} prompt preparation`)
  // `!` is editor STATE, not text: send it alone and wait for the painted
  // shell prompt before the body, so a coalesced chunk can never insert the
  // prefix as literal draft text.
  client.send(mode)
  await waitForComposerMode(client, mode, `${label} shell-mode activation`)
  client.send(body)
  // The body must be the CURRENT draft before Tab: this both proves the text
  // landed and guarantees the Tab is a separate input event.
  await waitForComposerText(client, body, `${label} draft body`)
  // Baseline the pre-Tab frame. A candidate already present above the box
  // (the transcript already holds earlier Host command names/results) must
  // never be mistaken for this Tab's suggestion.
  const beforeFrame = await client.viewport()
  const beforeComposer = (await client.composerText()) ?? ''
  assert(!beforeComposer.includes(candidate), `${label} candidate was already in the draft before Tab`)
  assert(!belowComposerRows(beforeFrame).join('\n').includes(candidate),
    `${label} candidate was already below the composer before Tab`)
  client.send('\t')
  await acceptOfferedCompletion(client, candidate, forbidden, label)
  // Reset the shell draft through the editor's OWN action
  // (tui.editor.deleteToLineStart / Ctrl+U). No backspace length arithmetic
  // and no replayed Escape: a shell completion's trailing space or a quoted
  // path can never desync the cleanup.
  client.send('\x15')
  await waitForComposerMode(client, mode, `${label} draft reset`)
  // ONE consumed Escape on the empty shell body steps the mode back to the
  // prompt. The empty-composer wait above proves the body was gone, and the
  // prompt wait below proves the Escape was consumed before any later `!`.
  client.send('\x1b')
  await waitForComposerMode(client, 'prompt', `${label} return to prompt mode`)
}

export { completeFromTui }

/**
 * Complete a word on a MULTILINE shell draft. `!`/`!!` are editor MODES, not
 * single-line commands: every independently complete command line is Shell.
 * The lines are inserted through bracketed paste because Enter SUBMITS a shell
 * draft. Cleanup is Ctrl+C, which clears the body and the mode together.
 */
export async function completeMultilineFromTui(client, mode, bodyLines, candidate, forbidden, label) {
  await waitForComposerMode(client, 'prompt', `${label} prompt preparation`)
  client.send(mode)
  await waitForComposerMode(client, mode, `${label} shell-mode activation`)
  client.send(`\x1b[200~${bodyLines.join('\n')}\x1b[201~`)
  await waitForComposerText(client, bodyLines.at(-1), `${label} multiline draft`)
  const before = (await client.viewport()).join('\n')
  assert(!before.includes(candidate), `${label} candidate was already painted before Tab`)
  client.send('\t')
  // The offer may be auto-applied OR a dropdown (git has several `che…`
  // subcommands); both are accepted through the shared step.
  await acceptOfferedCompletion(client, candidate, forbidden, label)
  const composer = (await client.composerText()) ?? ''
  assert(composer.includes(bodyLines[0]), `${label} must keep the earlier draft line: ${JSON.stringify(composer)}`)
  // The first painted row carries the mode glyph; no LATER row may repeat it,
  // which would mean the synthetic prefix had leaked into the body text.
  const bodyRows = composer.split('\n').slice(1)
  assert(bodyRows.every(row => !row.trimStart().startsWith(mode)),
    `${label} must never write the synthetic prefix into the body: ${JSON.stringify(composer)}`)
  client.send('\x03')
  await waitForComposerMode(client, 'prompt', `${label} return to prompt mode`)
}
