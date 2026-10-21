#!/usr/bin/env node
/**
 * The CODE-PREFIX STRIPPER: remove a leading plan/milestone code from a
 * case title.
 *
 * The policy (`docs/guides/testing.md` §7) says a case title must not be
 * LED BY a plan, milestone or review code: `A5b`, `B4A-07`, `PR5`,
 * `M3-4`, `RFL-002`, `TS2` … are local labels from the effort that wrote
 * the test, and a reader of a CI log does not have that effort.
 *
 * The rewrite is deliberately the SMALLEST one that removes the code and
 * keeps the sentence:
 *
 *   'A5b: the composition zone is one facade'  ->  'the composition zone is one facade'
 *   'PR5 negative control: an indeterminate'  ->  'an indeterminate prompt result'
 *
 * It never rewrites the English, never reorders it, and never invents an
 * outcome. A title whose code is followed by a phrase that already reads as
 * a sentence keeps that phrase exactly.
 *
 * ## How the label is found
 *
 * The title is split into a HEAD and a SENTENCE at the first separator
 * that ends a label (a colon, a dash, or a space before a lowercase
 * word). The HEAD is then examined TOKEN BY TOKEN: a token is part of the
 * label when it is a code, a section marker, a bracketed code, a
 * compound-label qualifier, or a listed qualifier word. The label is the
 * longest run of such tokens from the start.
 *
 * The token walk is used instead of one big pattern because the
 * repository's labels use every order of their parts (`PR5 §1C-3 (R6-1)`,
 * `PR4 F2b.2 (review round 4)`, `§D2 (review round 3 ruling)`,
 * `A06/Focus`, `B3 F6.1`, `PR D`) and enumerating the orders in a
 * pattern is how the pattern starts eating the sentence.
 *
 * The transform is a REPORT: it prints what it would change, and only
 * writes when it is asked to. The reviewer decides which of the changes to
 * keep — a title can carry a code that is genuinely part of its meaning.
 *
 * Usage:
 *   node scripts/strip-code-prefix.mjs --inventory inventory.json
 *   node scripts/strip-code-prefix.mjs --file test/foo.test.ts --write
 * @module @xmoon76/dsh-pi-tui/scripts/strip-code-prefix
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A code ATOM: a single label token that names an effort.
 *
 * The families the repository uses: a short uppercase family (`A5b`,
 * `TS8`, `B4A`, `PR5`, `H3A`, `L6`, `F10` …), optionally with a dotted
 * sub-number (`D2.1`, `F2b.2`, `P1.1`), a letter suffix (`B4B-10b`),
 * a slash- or dash-qualified second code (`A5b/TS2`, `S3-R0`), or a
 * word suffix (`B4B-delete-fallback`).
 *
 * A few families start with a DIGIT instead of a letter (`3B`, `2B`), and
 * a few carry a letter separator (`AC-1`, `PR-A`).
 */
const CODE_TOKEN = /^(?:\d+\.\d+[a-z]?|[A-Z]{1,4}\d+[a-zA-Z]?(?:(?:\.\d+|\u2013[A-Z]?\d+|-\d+)[a-z]?)?(?:-[A-Z]\d*)?(?:-[A-Za-z]+)?(?:\+[A-Za-z]+)?\.?(?:\/(?:[A-Z]{1,4}\d+[a-zA-Z]?(?:\.\d+[a-z]?)?(?:-[A-Z]\d*)?(?:-[A-Z]{1,4}\d*)?|RFL-\d+|\d{1,2}\/\d{1,2}|Direct(?:-L\d)?|Focus|DEL|BEL|BS|OWNER-RULED))*|RFL-\d+|[A-Z]{2,4}-(?:[A-Z]|\d+)[a-z]?|\d+[A-Z]\d*|\d{1,2}\/\d{1,2}|[A-Z]{1,4}\d+[a-zA-Z]?(?:-\d+)?-(?:swap|resize-zero|resize|height|delete-fallback))$/u

/**
 * A SECTION marker: a pointer into the plan that wrote the test.
 *
 * `§18.1`, `§1C-3`, `§D2`, `§6.4 (3)`. It is the same kind of local
 * label as a code: the reader of a CI log does not have the plan either.
 */
const SECTION_TOKEN = /^§\s*(?:\d+[A-Z](?:-\d+)?|\d+[A-Z]?(?:\.\d+)*(?:-\d+)?[a-z]?|[A-Z]\d+(?:-\d+)?)(?:\/§?\s*(?:\d+[A-Z]?(?:\.\d+)*(?:-\d+)?[a-z]?|[A-Z]\d+(?:-\d+)?))*?(?:\s*\(\d+\))?$/u

/**
 * A bracketed code: `(R6-1)`, `(F2)`, `(3)`, `(10)`.
 *
 * A bare NUMBER in brackets is a case label too — the plan numbers its
 * cases — so `(10):` is a label and not a sentence.
 */
const BRACKET_CODE_TOKEN = /^\((?:[A-Z]{1,4}\d+[a-z]?(?:-\d+)?(?:\/[A-Z0-9-]+)*|\d+)\)$/u

/**
 * A bracketed REVIEW qualifier: `(review round 4)`, `(ruling)`.
 *
 * It names the review that produced the case, not the behaviour, so it
 * goes with the label.
 */
const BRACKET_REVIEW_TOKEN = /^\((?:review\s+round\s+\d+\s+)?(?:ruling|review|external)\)$/u

/**
 * A bracketed HARNESS label: `(ctrl-r harness)`, `(Parity harness)`.
 *
 * It names the harness the case drives, not the behaviour, so it goes
 * with the label.
 */
const BRACKET_HARNESS_TOKEN = /^\([A-Za-z0-9 -]+ harness\)$/u

/**
 * The word-suffix code form: `B4B-delete-fallback`, `B4B-07-height`.
 *
 * These are rare — five titles in the whole tree — and they are listed
 * explicitly rather than matched by a loose rule, so the rule cannot
 * start eating ordinary hyphenated words.
 */
const WORD_SUFFIX_CODE_TOKEN = /^[A-Z]{1,4}\d+[a-zA-Z]?(?:-\d+)?-(?:swap|resize-zero|resize|height|delete-fallback)$/u

/**
 * A compound-label QUALIFIER: `Direct`, `Focus`, `OWNER-RULED`.
 *
 * These name WHICH variant of the behaviour the case covers, so they are
 * part of the label rather than the sentence.
 */
const QUALIFIER_TOKEN = /^(?:Direct|Focus|DEL|BEL|BS|OWNER-RULED)$/u

/**
 * A lowercase qualifier WORD that belongs to the label.
 *
 * `negative control`, `static`, `lock`, `headless` — they say how the
 * case was proved, not what it proves.
 */
const LABEL_WORD = /^(?:negative\s+control|positive\s+control|static|lock|child|final|retired|addendum|absolute|headless)$/u

/**
 * A single-letter code with a slash-qualified qualifier: `B/Direct`.
 *
 * A lone capital letter on its own is a KEY name (`S on a clean draft`),
 * so it may only lead a label when a qualified code follows it.
 */
const SINGLE_LETTER_SLASH_TOKEN = /^[A-Z]\/(?:[A-Z]{1,4}\d+[a-zA-Z]?(?:\.\d+[a-z]?)?|Direct(?:-L\d)?|Focus)$/u

/**
 * A `PR` code with a single-letter sub-label: `PR D`, `PR E`.
 *
 * The single letter is only a sub-label AFTER a `PR` code. On its own it
 * is a key name — `S on a clean draft closes` is a keyboard key, not a
 * code — so it may not start a label.
 */
const PR_SUB_LABEL = /^PR\d*\s+[A-Z]$/u

/**
 * Whether one token is part of a label.
 *
 * @param {string} token - the token.
 * @param {boolean} first - whether this is the FIRST token of the title.
 * @returns {boolean} true when the token belongs to the label.
 */
function isLabelToken(token, first) {
  if (token === '') return false
  if (PR_SUB_LABEL.test(token)) return true
  if (first && /^[A-Z]$/u.test(token)) {
    // A lone capital letter may only lead a label when a slash-qualified
    // code follows it (`B/Direct`); on its own it is a key name.
    return false
  }
  // A QUALIFIER (`Focus`, `Direct`) names the variant a case covers, so it
  // is part of the label — but only when a CODE precedes it. On its own,
  // `Focus Error sanitizes AUTH failure messages` is a sentence ABOUT the
  // Focus mode, and the word is what the reader needs.
  if (QUALIFIER_TOKEN.test(token)) {
    return first ? false : true
  }
  return CODE_TOKEN.test(token)
    || SINGLE_LETTER_SLASH_TOKEN.test(token)
    || WORD_SUFFIX_CODE_TOKEN.test(token)
    || SECTION_TOKEN.test(token)
    || BRACKET_CODE_TOKEN.test(token)
    || BRACKET_REVIEW_TOKEN.test(token)
    || BRACKET_HARNESS_TOKEN.test(token)
    || LABEL_WORD.test(token)
}

/**
 * Split a title into its label HEAD and the rest.
 *
 * The head ends at the first separator that ends a label: a colon, a
 * dash, or a space followed by a lowercase word. A title with no such
 * separator has no label to remove.
 *
 * @param {string} title - the current title.
 * @returns {{head: string, rest: string}|null} the split, or null.
 */
function splitLabel(title) {
  // A DOT separator comes FIRST, because a dot-separated code is the
  // shortest possible label: `F1. a synchronous mount throw leaves the
  // stage fiber unassigned: …` — the colon is inside the SENTENCE, and
  // splitting there would cut the sentence in half.
  //
  // The dot is only a separator when the text in front of it is a CODE.
  // Otherwise it is the end of the title's first sentence.
  const dot = /\. /u.exec(title)
  if (dot !== null) {
    const head = title.slice(0, dot.index)
    if (isLabelToken(head, true)) {
      return { head, rest: title.slice(dot.index + 2) }
    }
  }
  // A bracketed label: `(ctrl-r harness): the case …`. The bracket ends
  // the label, and the colon after it separates the sentence.
  const bracketed = /^\([^)]*\)\s*:\s*/u.exec(title)
  if (bracketed !== null) {
    const head = title.slice(0, bracketed[0].index + bracketed[0].indexOf(')') + 1)
    if (isLabelToken(head, true)) {
      return { head, rest: title.slice(bracketed[0].index + bracketed[0].length) }
    }
  }
  const colon = title.indexOf(':')
  if (colon !== -1) return { head: title.slice(0, colon), rest: title.slice(colon + 1) }
  // A dash separator: `- ` (a dash followed by a space), so an ordinary
  // hyphenated word is not a separator. The en-dash and em-dash forms are
  // the same separator.
  const dash = / [—–-] /u.exec(title)
  if (dash !== null) return { head: title.slice(0, dash.index), rest: title.slice(dash.index + 3) }
  // A space before a lowercase word.
  const space = / (?=[a-z])/u.exec(title)
  if (space !== null) return { head: title.slice(0, space.index), rest: title.slice(space.index + 1) }
  return null
}

/**
 * The label a title starts with, and the sentence after it.
 *
 * The label is the longest run of label TOKENS at the start of the title.
 * A `/`-joined token is one token (`A06/Focus`), and a `PR D` pair is one
 * token.
 *
 * @param {string} title - the current title.
 * @returns {{label: string, sentence: string}|null} the split, or null
 *   when the title has no label.
 */
export function splitLeadingLabel(title) {
  const split = splitLabel(title)
  if (split === null) return null
  // A BRACKETED head is ONE token: `(ctrl-r harness)` is a single label,
  // and splitting it on the space inside the bracket would make the
  // bracket a token of its own.
  const rawTokens = /^\(.+\)$/u.test(split.head)
    ? [split.head]
    : split.head.split(/\s+/u).filter(token => token !== '')
  if (rawTokens.length === 0) return null
  const tokens = []
  for (const token of rawTokens) {
    const previous = tokens[tokens.length - 1]
    if (previous !== undefined && PR_SUB_LABEL.test(`${previous} ${token}`)) {
      tokens[tokens.length - 1] = `${previous} ${token}`
      continue
    }
    tokens.push(token)
  }
  let consumed = 0
  for (const [index, token] of tokens.entries()) {
    if (!isLabelToken(token, index === 0)) break
    consumed = index + 1
  }
  if (consumed === 0) return null
  const label = tokens.slice(0, consumed).join(' ')
  const sentence = split.rest.trimStart()
  // A label that is ONE bare token with no sentence after it is the whole
  // title (`B3`, `L6`), not a label.
  if (consumed === tokens.length && tokens.length === 1 && sentence === '') return null
  if (sentence === '') return null
  return { label, sentence }
}

/**
 * Whether a title LED BY a code label.
 *
 * The audit and the transform MUST agree on what a code is: an audit that
 * uses its own pattern can silently stop reporting the very titles the
 * transform would change, and a "no code-led titles" report that is based
 * on a narrower pattern is a false assurance.
 *
 * @param {string} title - the current title.
 * @returns {boolean} true when the title starts with a code label.
 */
export function hasLeadingCodePrefix(title) {
  return splitLeadingLabel(title) !== null
}

/**
 * Remove a leading code label from one title.
 *
 * @param {string} title - the current title.
 * @returns {string} the title without its leading code.
 */
export function stripCodePrefix(title) {
  const split = splitLeadingLabel(title)
  if (split === null) return title
  return split.sentence
}

function main() {
  const args = process.argv.slice(2)
  const inventoryIndex = args.indexOf('--inventory')
  const fileIndex = args.indexOf('--file')
  const write = args.includes('--write')

  if (fileIndex !== -1) {
    const path = resolve(ROOT, args[fileIndex + 1])
    const source = readFileSync(path, 'utf8')
    const changed = rewriteSource(source)
    if (changed === source) {
      console.log(`no leading code found in ${args[fileIndex + 1]}`)
      return
    }
    if (write) {
      writeFileSync(path, changed)
      console.log(`rewrote ${args[fileIndex + 1]}`)
    } else {
      console.log(changed)
    }
    return
  }

  if (inventoryIndex === -1) {
    console.error('usage: node scripts/strip-code-prefix.mjs --inventory <file> | --file <path> [--write]')
    process.exit(2)
  }

  const inventory = JSON.parse(readFileSync(args[inventoryIndex + 1], 'utf8'))
  const changes = []
  for (const record of inventory.cases) {
    const next = stripCodePrefix(record.name)
    if (next !== record.name) {
      changes.push({ file: record.file, line: record.line, from: record.name, to: next })
    }
  }
  console.log(`candidates: ${changes.length} of ${inventory.caseCount}`)
  for (const change of changes) {
    console.log(`${change.file}:${change.line}\n  - ${change.from}\n  + ${change.to}`)
  }
}

/**
 * Rewrite every case title in one source file.
 *
 * Only the TITLE STRING LITERALS of `test()` / `it()` calls are touched.
 * The source is edited as TEXT (not re-printed by a parser), so the
 * formatting of the file is preserved exactly and only the literal changes.
 *
 * @param {string} source - the file's content.
 * @returns {string} the rewritten content.
 */
export function rewriteSource(source) {
  // A `test(` / `it(` call, then the FIRST string literal after it.
  const callPattern = /\b(?:test|it)\(\s*(['"`])/gu
  let result = ''
  let last = 0
  for (const match of source.matchAll(callPattern)) {
    const quote = match[1]
    const start = match.index + match[0].length
    const end = findStringEnd(source, start, quote)
    if (end === -1) continue
    const literal = source.slice(start, end)
    // A template literal with an interpolation carries a computed name; it is
    // left alone, because its final text is not knowable from the source.
    if (quote === '`' && literal.includes('${')) continue
    const next = stripCodePrefix(literal)
    if (next === literal) continue
    result += source.slice(last, start) + next
    last = end
  }
  result += source.slice(last)
  return result
}

/** The index just past the string literal that starts at `start`. */
function findStringEnd(source, start, quote) {
  let index = start
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) return index
    index += 1
  }
  return -1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
