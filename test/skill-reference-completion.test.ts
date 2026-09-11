/**
 * Unit tests for the pure inline skill reference completion grammar:
 * token classification and the apply replacement (the 2026-09-07 next
 * inline multi-skill plan §8.1).
 * @module @xmoon76/dsh-pi-tui/skill-reference-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { applyInlineSkillReference, extractInlineSkillPrefix } from '../src/skill-reference-completion.ts'

test('extractInlineSkillPrefix finds inline skill tokens at whitespace boundaries', () => {
  // `请用 /` — the `/` after a space is an inline seat with an empty query.
  assert.deepEqual(extractInlineSkillPrefix(['请用 /'], 0, 4), { slashStart: 3, query: '' })
  assert.deepEqual(extractInlineSkillPrefix(['请用 /e'], 0, 5), { slashStart: 3, query: 'e' })
  assert.deepEqual(extractInlineSkillPrefix(['foo /eli'], 0, 8), { slashStart: 4, query: 'eli' })
  // A later line's leading `/` is an inline seat (only the FIRST logical
  // line's leading command seat belongs to command completion).
  assert.deepEqual(extractInlineSkillPrefix(['foo', '/eli'], 1, 4), { slashStart: 0, query: 'eli' })
  // Hyphenated names complete like the Host gesture grammar.
  assert.deepEqual(extractInlineSkillPrefix(['foo /html-maker'], 0, 15), { slashStart: 4, query: 'html-maker' })
  // A trailing hyphen is a legal in-progress query.
  assert.deepEqual(extractInlineSkillPrefix(['foo /html-'], 0, 10), { slashStart: 4, query: 'html-' })
  // The cursor may sit MID-token: the query is the text before the cursor,
  // the rest of the token stays untouched by the apply.
  assert.deepEqual(extractInlineSkillPrefix(['请用 /eli5'], 0, 7), { slashStart: 3, query: 'eli' })
})

test('extractInlineSkillPrefix never claims the first-line leading command seat', () => {
  assert.equal(extractInlineSkillPrefix(['/eli'], 0, 4), undefined, 'a line-start command seat is not inline')
  assert.equal(extractInlineSkillPrefix(['/'], 0, 1), undefined, 'a bare line-start slash is not inline')
  assert.equal(extractInlineSkillPrefix(['   /eli'], 0, 7), undefined, 'an indented command seat is not inline')
  assert.equal(extractInlineSkillPrefix(['   /'], 0, 4), undefined, 'an indented bare slash is not inline')
})

test('extractInlineSkillPrefix rejects non-skill tokens', () => {
  // A `/` glued to a word is not a token boundary.
  assert.equal(extractInlineSkillPrefix(['x/eli'], 0, 5), undefined)
  assert.equal(extractInlineSkillPrefix(['foo 5/8'], 0, 7), undefined)
  // A second `/` inside the token is a path, never a skill.
  assert.equal(extractInlineSkillPrefix(['/usr/bin'], 1, 8), undefined, 'a path token on a later line is not a skill')
  assert.equal(extractInlineSkillPrefix(['foo /usr/bin'], 0, 11), undefined)
  // A non-name character ends the grammar: `/eli5。` has no legal
  // whitespace/end boundary yet, so it is not a completion seat.
  assert.equal(extractInlineSkillPrefix(['请用 /eli5。'], 0, 8), undefined)
  assert.equal(extractInlineSkillPrefix(['foo /eli5.'], 0, 10), undefined)
  // Uppercase is outside the Host gesture grammar.
  assert.equal(extractInlineSkillPrefix(['foo /ELI'], 0, 8), undefined)
  // Tokens that can never become a Host-recognizable name are not seats:
  // a bare hyphen, a double hyphen, or a leading hyphen.
  assert.equal(extractInlineSkillPrefix(['foo /-'], 0, 5), undefined)
  assert.equal(extractInlineSkillPrefix(['foo /a--'], 0, 7), undefined)
  assert.equal(extractInlineSkillPrefix(['foo /--a'], 0, 7), undefined)
  // No `/` at all: ordinary prose.
  assert.equal(extractInlineSkillPrefix(['请用 eli'], 0, 6), undefined)
  assert.equal(extractInlineSkillPrefix([''], 0, 0), undefined)
})

test('extractInlineSkillPrefix never claims a seat when the cursor is BEFORE the slash', () => {
  // `foo |/el` — the cursor sits on the `/` (navigation, not completion).
  assert.equal(extractInlineSkillPrefix(['foo /el'], 0, 4), undefined)
  // A later line with the cursor at column 0 (before the `/`) is not a
  // seat either.
  assert.equal(extractInlineSkillPrefix(['foo', '/el'], 1, 0), undefined)
  // The cursor AT or AFTER the `/` still completes.
  assert.deepEqual(extractInlineSkillPrefix(['foo /el'], 0, 5), { slashStart: 4, query: '' })
  assert.deepEqual(extractInlineSkillPrefix(['foo /el'], 0, 7), { slashStart: 4, query: 'el' })
})

test('extractInlineSkillPrefix uses the Host \\s whitespace semantics (ideographic space)', () => {
  // A full-width ideographic space (`\u3000`, common in CJK text) is a
  // token boundary for the Host gesture `(^|\s)\/` — the classifier must
  // agree.
  assert.deepEqual(extractInlineSkillPrefix(['请用\u3000/el'], 0, 6), { slashStart: 3, query: 'el' })
  assert.deepEqual(extractInlineSkillPrefix(['请用\u3000/'], 0, 4), { slashStart: 3, query: '' })
  // NBSP is a boundary too.
  assert.deepEqual(extractInlineSkillPrefix(['foo\u00a0/el'], 0, 7), { slashStart: 4, query: 'el' })
})

test('applyInlineSkillReference keeps a \\s separator without adding an ASCII space', () => {
  // A suffix starting with an ideographic space keeps it (no double
  // separator), the cursor lands on the separator position.
  assert.deepEqual(applyInlineSkillReference('请用 /el\u3000看看', 3, 6, 'eli5'), { line: '请用 /eli5\u3000看看', cursorCol: 9 })
  // An NBSP suffix behaves the same.
  assert.deepEqual(applyInlineSkillReference('请用 /el\u00a0看看', 3, 6, 'eli5'), { line: '请用 /eli5\u00a0看看', cursorCol: 9 })
})

test('extractInlineSkillPrefix ignores tokens before the cursor', () => {
  // The cursor is past the token: the current token is `看看` — no seat.
  assert.equal(extractInlineSkillPrefix(['请用 /eli5 看看'], 0, 11), undefined)
  // The cursor sits on the whitespace AFTER a completed reference: the
  // current token is empty — no seat (the reference is already complete).
  assert.equal(extractInlineSkillPrefix(['请用 /eli5 '], 0, 9), undefined)
})

test('applyInlineSkillReference replaces only the current token and keeps the suffix', () => {
  // No suffix: insert the separator space, cursor after it.
  assert.deepEqual(applyInlineSkillReference('请用 /el', 3, 6, 'eli5'), { line: '请用 /eli5 ', cursorCol: 9 })
  // Suffix already starts with whitespace: keep it (no double space), the
  // cursor lands on the separator position.
  assert.deepEqual(applyInlineSkillReference('请用 /el 看看', 3, 6, 'eli5'), { line: '请用 /eli5 看看', cursorCol: 9 })
  // Suffix without whitespace: insert one space, the suffix survives.
  assert.deepEqual(applyInlineSkillReference('请用 /el看看', 3, 6, 'eli5'), { line: '请用 /eli5 看看', cursorCol: 9 })
  // Multi-byte (CJK) text before the token: code-unit cursor math stays
  // correct (each BMP char is one code unit).
  assert.deepEqual(applyInlineSkillReference('看看 /el', 3, 6, 'eli5'), { line: '看看 /eli5 ', cursorCol: 9 })
  // A later-line token: the line is replaced in isolation.
  assert.deepEqual(applyInlineSkillReference('/el', 0, 3, 'eli5'), { line: '/eli5 ', cursorCol: 6 })
  // A tab separator is kept like any whitespace.
  assert.deepEqual(applyInlineSkillReference('foo /el\tbar', 4, 7, 'eli5'), { line: 'foo /eli5\tbar', cursorCol: 10 })
})
