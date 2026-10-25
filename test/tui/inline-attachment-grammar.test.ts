/**
 * Unit tests for the Image UX PR5 inline attachment grammar and the
 * position-scoped path-argument classifier: the FIRST line's leading command
 * token stays the legacy slash-command seat, every other declared command
 * token is the inline attachment seat, and nothing else (URLs, `/usr/bin`,
 * `weird/image`, ordinary paths) is a seat at all.
 * @module @xmoon76/dsh-pi-tui/inline-attachment-grammar.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  INLINE_ATTACHMENT_ACTIONS,
  candidatePath,
  applyInlineAttachmentAction,
  applyInlineAttachmentPath,
  isInlineAttachmentAction,
  isInlineAttachmentPath,
  unquoteCandidateValue,
} from '../../src/tui/interaction/autocomplete/inline-attachment.ts'
import {
  classifyFileCompletionContext,
  pathArgumentSeat,
} from '../../src/tui/file-completion/context.ts'
import { FILE_ARGUMENT_COMMANDS } from '../../src/domain/file-completion/path-argument-commands.ts'

const COMMANDS = FILE_ARGUMENT_COMMANDS
const classify = (text: string, line = 0) => classifyFileCompletionContext(text, COMMANDS, { line })

test('a mid-body command token on the FIRST line is an INLINE seat', () => {
  const seat = classify('帮我看看 /image ./shots/err')
  assert.equal(seat.kind, 'path-argument')
  if (seat.kind !== 'path-argument') return
  assert.equal(seat.command, 'image')
  assert.equal(seat.query, './shots/err')
  assert.equal(seat.leading, false, 'a mid-body token is never the legacy command seat')
  assert.equal(seat.commandStart, '帮我看看 '.length)
})

test("the FIRST line's LEADING command token is the legacy command seat", () => {
  const seat = classify('/image ./shots/err')
  assert.equal(seat.kind, 'path-argument')
  if (seat.kind !== 'path-argument') return
  assert.equal(seat.leading, true, 'line 0 leading keeps the slash-command policy')
  // Indentation is still the leading command seat (the fork accepts it).
  const indented = classify('   /attach ./logs/a.log')
  assert.equal(indented.kind, 'path-argument')
  if (indented.kind !== 'path-argument') return
  assert.equal(indented.leading, true)
})

test("a later line's leading command token is an INLINE seat", () => {
  const seat = classify('/attach ./logs/service.log', 2)
  assert.equal(seat.kind, 'path-argument')
  if (seat.kind !== 'path-argument') return
  assert.equal(seat.leading, false, 'only the FIRST logical line is the command seat')
  assert.equal(seat.command, 'attach')
})

test('non-seats stay closed: path segments, URLs, shell and ordinary paths', () => {
  // A `/` glued to a word is never a token boundary.
  assert.equal(classify('weird/image /x').kind, 'none')
  assert.equal(classify('https://host.example/image /x').kind, 'none')
  assert.equal(classify('x/image /x').kind, 'none')
  // A declared NAME only: `/usr/bin` is a path, not `usr`.
  assert.equal(classify('/usr/bin /x').kind, 'none')
  assert.equal(classify('see /usr/bin').kind, 'none')
  // The command name with NO separator yet is the command-name/action seat,
  // never a path argument (the inline `/name` dropdown owns it).
  assert.equal(classify('hi /image').kind, 'none')
  // Ordinary paths and prose.
  assert.equal(classify('ordinary ./path').kind, 'none')
  assert.equal(classify('hello /tmp/foo').kind, 'none')
  // An undeclared command is not a file seat.
  assert.equal(classify('hello /other foo').kind, 'none')
})

test('the LAST declared token wins, so an earlier one is not a stale seat', () => {
  const seat = classify('hi /image ./a.png /attach ./b')
  assert.equal(seat.kind, 'path-argument')
  if (seat.kind !== 'path-argument') return
  assert.equal(seat.command, 'attach')
  assert.equal(seat.query, './b')
})

test('a multi-space separator belongs to the argument (fork apply parity)', () => {
  const seat = classify('/image    file')
  assert.equal(seat.kind, 'path-argument')
  if (seat.kind !== 'path-argument') return
  assert.equal(seat.query, '   file', 'the leftover separator stays part of the replaced range')
})

test('an `@` mention is never claimed by a declared command seat', () => {
  const mention = classify('hi @src/fo')
  assert.equal(mention.kind, 'mention')
  // But a declared command argument DOES own the position (the Client-local
  // path is what `/image` means, never a Host mention).
  const argument = classify('hi /image @src/fo')
  assert.equal(argument.kind, 'path-argument')
})

test('pathArgumentSeat and the classifier agree (ONE authority)', () => {
  for (const text of ['/image a', 'hi /attach b', 'hi /image', 'weird/image /x', 'hi @a']) {
    const seat = pathArgumentSeat(text, COMMANDS)
    const context = classify(text)
    assert.equal(context.kind === 'path-argument', seat !== undefined, `agreement for ${JSON.stringify(text)}`)
  }
})

test('the fixed action list is exactly the declared attachment commands', () => {
  assert.deepEqual(INLINE_ATTACHMENT_ACTIONS.map(action => action.name), ['image', 'attach'])
  for (const action of INLINE_ATTACHMENT_ACTIONS) {
    assert.ok(COMMANDS.has(action.name), `${action.name} must be a declared file-argument command`)
  }
})

test('accepting an action inserts the token and opens the argument seat', () => {
  // `hi /ima` → `hi /image ` with the cursor at the argument's first column.
  const applied = applyInlineAttachmentAction('hi /ima', 3, 7, 'image')
  assert.equal(applied.line, 'hi /image ')
  assert.equal(applied.cursorCol, 10)
  const seat = classify(applied.line.slice(0, applied.cursorCol))
  assert.equal(seat.kind, 'path-argument', 'the inserted separator opens the argument seat')
  if (seat.kind !== 'path-argument') return
  assert.equal(seat.query, '', 'an empty argument is the cwd listing (allowEmpty)')
  // A trailing separator after the cursor is kept, never doubled.
  const kept = applyInlineAttachmentAction('hi /ima world', 3, 7, 'image')
  assert.equal(kept.line, 'hi /image world')
  assert.equal(classify(kept.line.slice(0, kept.cursorCol)).kind, 'path-argument',
    'the existing separator makes the position an argument seat immediately')
})

test('accepting a path replaces only the argument span and reports the fragment', () => {
  const line = '看看 /image ./sh/err 为什么'
  const caret = line.indexOf('./sh/err') + './sh/err'.length
  const seat = pathArgumentSeat(line.slice(0, caret), COMMANDS)
  assert.ok(seat !== undefined)
  const applied = applyInlineAttachmentPath(line, seat, caret, 0, './shots/err.png')
  // The prefix, the selected value and the SUFFIX all survive.
  assert.equal(applied.line, '看看 /image ./shots/err.png 为什么')
  assert.equal(applied.cursorCol, '看看 /image ./shots/err.png'.length)
  // The reported span covers the whole inline fragment (command token through
  // the accepted value) — what the canonical placeholder will replace.
  assert.equal(applied.span.line, 0)
  assert.equal(applied.span.start, '看看 '.length)
  assert.equal(applied.span.end, '看看 /image ./shots/err.png'.length)
  assert.equal(applied.line.slice(applied.span.start, applied.span.end), '/image ./shots/err.png')
})

test('a directory value keeps its separator and stays a live argument seat', () => {
  const line = 'hi /image sub'
  const seat = pathArgumentSeat(line.slice(0, 'hi /image sub'.length), COMMANDS)
  assert.ok(seat !== undefined)
  const applied = applyInlineAttachmentPath(line, seat, 'hi /image sub'.length, 0, 'sub/')
  assert.equal(applied.line, 'hi /image sub/')
  assert.equal(classify(applied.line.slice(0, applied.cursorCol)).kind, 'path-argument')
})

test('row markers identify actions and paths structurally, never by label', () => {
  const action = {
    value: 'image', label: 'image', description: 'Insert local image',
    inlineAttachment: 'action' as const, command: 'image',
  }
  const path = {
    value: 'a.png', label: 'a.png', description: undefined,
    inlineAttachment: 'path' as const, command: 'image', directory: false,
  }
  assert.equal(isInlineAttachmentAction(action), true)
  assert.equal(isInlineAttachmentPath(action), false)
  assert.equal(isInlineAttachmentPath(path), true)
  assert.equal(isInlineAttachmentAction(path), false)
  // A plain skill row (same value as the action!) is NOT an action: identity
  // comes from the marker, never from the name.
  const skill = { value: 'image', label: 'image', description: 'A skill named image' }
  assert.equal(isInlineAttachmentAction(skill), false)
  assert.equal(isInlineAttachmentPath(skill), false)
})

test('a fully quoted candidate value is unquoted; anything else stays verbatim', () => {
  assert.equal(unquoteCandidateValue('"my file.png"'), 'my file.png')
  assert.equal(unquoteCandidateValue('"sub dir/"'), 'sub dir/')
  assert.equal(unquoteCandidateValue('plain.png'), 'plain.png')
  assert.equal(unquoteCandidateValue('"unclosed'), '"unclosed')
  assert.equal(unquoteCandidateValue(''), '')
})

test('a SHELL document never yields an attachment seat (the shell plane owns it)', () => {
  // The shell bridge owns `!`/`!!` arguments; a literal `/image <path>` there
  // is a shell WORD, not a Client-local attachment site. Classifying it as a
  // path argument would let attachment candidates (and their apply) rewrite a
  // shell command line.
  for (const line of ['!echo /image ./foo', '!!echo /attach ./bar', '/image ./foo']) {
    assert.equal(classifyFileCompletionContext(line, COMMANDS, { line: 0, shell: true }).kind, 'none',
      `a shell document must not expose a path-argument seat: ${JSON.stringify(line)}`)
  }
  // The SAME text in an ordinary PROMPT document is the attachment seat: the
  // classifier takes the shell fact from its caller (the caller owns the
  // input mode and the literal wire form), so it never guesses.
  assert.equal(classify('echo /image ./foo').kind, 'path-argument', 'ordinary prompt prose is the seat')
  assert.equal(
    classifyFileCompletionContext('!echo /image ./foo', COMMANDS, { line: 0, shell: true }).kind,
    'none',
    'a prompt-mode buffer holding the literal `!` wire form is classified as shell by its caller',
  )
})

test('the read path never inherits the editor replacement spacing', () => {
  // The Client-local path engine prefixes the argument's leading separator run
  // back onto a candidate so the accepted TEXT preserves the user's spacing.
  // That text is an editor replacement, never a filesystem path.
  assert.equal(candidatePath('   shot.png'), 'shot.png', 'an injected multi-space run is not part of the name')
  assert.equal(candidatePath('\tshot.png'), 'shot.png', 'a tab separator is not part of the name')
  assert.equal(candidatePath('shot.png'), 'shot.png', 'an unspaced value is unchanged')
  // A quoted value keeps the quote contract, applied AFTER the spacing is gone.
  assert.equal(candidatePath('   "my file.png"'), 'my file.png')
  assert.equal(candidatePath(' '), '', 'a spacing-only value has no path')
  // A directory continuation value keeps its own trailing separator (it is the
  // editor text for the NEXT seat, and directories are never read).
  assert.equal(candidatePath('   sub/'), 'sub/')
})
