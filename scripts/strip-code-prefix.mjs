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
 *   'PR5 negative control: an indeterminate'  ->  'negative control: an indeterminate'
 *
 * It never rewrites the English, never reorders it, and never invents an
 * outcome. A title whose code is followed by a phrase that already reads as
 * a sentence keeps that phrase exactly.
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
 * A leading code, and the separator that ends it.
 *
 * The code families are the ones this repository actually uses: a short
 * uppercase family (`A5b`, `TS8`, `B4A`, `PR5`, `H3A`, `L6`, `F10` …),
 * optionally followed by a sub-number (`A5b-6`, `B4A-07`), and optionally
 * followed by a slash-qualified sub-code (`A5b/TS2`).
 *
 * A few families start with a DIGIT instead of a letter (`3B`, `2B`), and a
 * few carry a letter separator (`AC-1`, `PR-A`). They are part of the same
 * family of local labels, so they are matched too.
 *
 * The separator is what tells a CODE from an ordinary word: a code is
 * followed by a colon, a dash, a slash-code or a space and then a
 * lowercase word. `L6` alone as a whole title is NOT a code-led title —
 * there is no sentence to keep.
 */
const CODE = String.raw`(?:[A-Z]{1,4}\d+[a-zA-Z]?(?:-[A-Z])?(?:-\d+[a-z]?)?(?:\/[A-Z]{1,4}\d+[a-z]?)*|[A-Z]{2,4}-(?:[A-Z]|\d+)[a-z]?|\d+[A-Z](?:\d+)?|RFL-\d+)`

/**
 * The word-suffix code form (`B4B-delete-fallback`, `B4B-07-height`).
 *
 * These are rare — five titles in the whole tree — and they are handled
 * explicitly rather than by a loose pattern, so the pattern cannot start
 * eating ordinary hyphenated words.
 */
const WORD_SUFFIX_CODE = String.raw`[A-Z]{1,4}\d+[a-zA-Z]?(?:-\d+)?-(?:swap|resize-zero|resize|height|delete-fallback)`
/**
 * ONE leading code label, with the separator that ends it.
 *
 * A label may be followed by a section marker (`§7.4-10/11`), by a
 * bracketed second code (`(F2)`), and by a lowercase qualifier word that
 * belongs to the label (`negative control`, `static`, `lock`).
 */
const ONE_LABEL = String.raw`(?:${CODE}|${WORD_SUFFIX_CODE})(?:\s*§\s*[\d.]+(?:-\d+)?(?:\/\d+)?)?(?:\s*\([A-Z]{1,4}\d+[a-z]?\))?(?:\s+(?:negative\s+control|positive\s+control|static|lock|child|final|retired|addendum)\b)*`

/** Whether a title STARTS with a code (used to keep a bare code intact). */
const CODE_AT_START = new RegExp(String.raw`^${CODE}\b`, 'u')

/**
 * The leading-code pattern.
 *
 * It matches a RUN of leading code labels (`L6 PR5: …`), each with its
 * separator, and stops at the first thing that is not a label.
 *
 * The look-ahead is what keeps the transform safe: the text after the
 * labels must NOT itself start with a code, so a title that is only a code
 * (`B3`) is never stripped to nothing.
 */
const LEADING_CODE = new RegExp(
  String.raw`^(?:${ONE_LABEL}(?:\s*[:—-]\s*|\s+))+`,
  'u',
)

/**
 * Remove a leading code label run from one title.
 *
 * @param {string} title - the current title.
 * @returns {string} the title without its leading code.
 */
export function stripCodePrefix(title) {
  let rest = title
  for (;;) {
    const match = LEADING_CODE.exec(rest)
    if (match === null) break
    const candidate = rest.slice(match[0].length)
    // The sentence must not be another code: `B3` alone stays `B3`.
    if (candidate.trim() === '' || CODE_AT_START.test(candidate)) break
    rest = candidate
  }
  if (rest === title) return title
  return rest
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
