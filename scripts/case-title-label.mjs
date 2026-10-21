#!/usr/bin/env node
/**
 * The LABEL GRAMMAR: what this repository's case titles call a plan,
 * milestone or review label.
 *
 * The policy (`docs/guides/testing.md` §7) says a case title must not be
 * LED BY such a label. The title audit needs to RECOGNISE one, and the
 * recognition has to be exact: a title that leads with a plan code is a
 * finding, and a title that leads with an ordinary word is not. So the
 * grammar lives in ONE place, and both the audit and the tests use it.
 *
 * The label families this repository uses:
 *
 *   - a code atom: `A5b`, `TS8`, `B4A-07`, `PR5`, `L6`, `F10`, `D2.1`,
 *     `B4B-10b`, `A5b/TS2`, `S3-R0`, `RFL-002`, `3B`, `AC-1`, `PR-A`;
 *   - a plan section marker: `§18.1`, `§1C-3`, `§D2`, `§14/J12`;
 *   - a bracketed code: `(R6-1)`, `(F2)`, `(3)`, `(10)`;
 *   - a review label: `finding C (1)`, `findings F6/F7`, `assertion 7`,
 *     `step 8 / §5 Must 17`;
 *   - a compound-label qualifier: `Direct`, `Remote`, `Focus`,
 *     `OWNER-RULED`;
 *   - a lowercase qualifier word: `negative control`, `static`,
 *     `headless`.
 *
 * A label is the longest run of such tokens at the START of a title. The
 * words after it belong to the SENTENCE: `B3 F4 control: …` is the label
 * `B3 F4` followed by the category `control`, and both parts matter.
 *
 * @module @xmoon76/dsh-pi-tui/scripts/case-title-label
 */


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
const CODE_TOKEN = /^(?:\d+\.\d+[a-z]?|[A-Z]{1,4}\d+[a-zA-Z]?(?:(?:\.\d+|\u2013[A-Z]?\d+|-\d+)[a-z]?)?(?:-[A-Z]\d*)?(?:-[A-Za-z]+)?(?:\+[A-Za-z]+)?\.?(?:\/(?:[A-Z]{1,4}\d+[a-zA-Z]?(?:\.\d+[a-z]?)?(?:-[A-Z]\d*)?(?:-[A-Z]{1,4}\d*)?|RFL-\d+|\d{1,2}\/\d{1,2}|Direct(?:-L\d)?|Remote|Focus|DEL|BEL|BS|OWNER-RULED))*|RFL-\d+|[A-Z]{2,4}-(?:[A-Z]|\d+)[a-z]?|\d+[A-Z]\d*|\d{1,2}\/\d{1,2}|\d{1,3}\([a-z]\)?|\b[a-z]\d+[a-z]?|[A-Z]{1,4}\d+[a-zA-Z]?(?:-\d+)?-(?:swap|resize-zero|resize|height|delete-fallback))$/u

/**
 * A SECTION marker: a pointer into the plan that wrote the test.
 *
 * `§18.1`, `§1C-3`, `§D2`, `§6.4 (3)`. It is the same kind of local
 * label as a code: the reader of a CI log does not have the plan either.
 */
const SECTION_TOKEN = /^§\s*\d+(?:\.\d+)*(?:-\d+)*(?:\s*\/\s*§?\s*\d+(?:\.\d+)*(?:-\d+)*)*$/u
const SECTION_TOKEN_SINGLE = /^§\s*(?:\d+[A-Z](?:-\d+)?|\d+[A-Z]?(?:\.\d+)*(?:-\d+)?[a-z]?|[A-Z]\d+(?:-\d+)?)(?:\/§?\s*(?:\d+[A-Z]?(?:\.\d+)*(?:-\d+)?[a-z]?|[A-Z]\d+(?:-\d+)?))*?(?:\s*\(\d+\))?$/u

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
 * A bracketed QUALIFIER label: `(Direct)`, `(Direct negative control)`,
 * `(F1 atomicity)`, `(F1 atomicity, fork)`.
 *
 * The bracket names the VARIANT of the behaviour the case covers, and a
 * case-number or a review label inside it (`F1`, `R6-1`) is the same
 * kind of local label as the code outside it. It goes with the label.
 */
const BRACKET_QUALIFIER_TOKEN = /^\([A-Za-z0-9][A-Za-z0-9 ,._+-]*\)$/u

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
const QUALIFIER_TOKEN = /^(?:Direct|Remote|Focus|DEL|BEL|BS|OWNER-RULED)$/u

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
const SINGLE_LETTER_SLASH_TOKEN = /^[A-Z]\/(?:[A-Z]{1,4}\d+[a-zA-Z]?(?:\.\d+[a-z]?)?|Direct(?:-L\d)?|Remote|Focus)$/u

/**
 * An `assertion N` label: a numbered assertion of a plan's checklist.
 *
 * It names the checklist item the case covers, not the behaviour, so it
 * goes with the label.
 */
const ASSERTION_LABEL_TOKEN = /^assertion\s+\d+$/u

/**
 * A `finding C` / `finding F7` label: a review finding's own number.
 *
 * It names the review that produced the case, not the behaviour, so it
 * goes with the label.
 */
const FINDING_LABEL_TOKEN = /^findings?\s+[A-Z]{1,4}\d*(?:\/[A-Z]{1,4}\d*)*$/u

/**
 * A `step N` label: `step 8 / §5 Must 17:`, `step 10 + F7:`.
 *
 * The plan numbers its steps, and the step number is a local label of the
 * same kind as a case code.
 */
const STEP_LABEL_TOKEN = /^step\s+\d+(?:\s*[+/]\s*(?:step\s+\d+|[A-Z]{1,4}\d+[a-z]?|§\s*[\d.A-Z]+(?:\s+Must\s+\d+)?))*$/u

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
function isLabelToken(token, first, colonForm = false) {
  if (token === '') return false
  // A bare number is a case label only in the COLON form (`02: the
  // case`). In the space form it is a measurement — `80 columns keep the
  // full provider/model` — and the measurement is the point of the title.
  if (/^\d{1,3}$/u.test(token)) return colonForm
  // A single capital letter before a COLON is a case label: `A:`, `B:`,
  // `C:`, `E:`. The plan numbers its sub-cases with a letter, and the
  // letter alone is the whole label. Without the colon it is a KEY name
  // — `S on a clean draft closes` — and the letter is what the reader
  // needs.
  if (/^[A-Z]$/u.test(token)) return colonForm
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
    || STEP_LABEL_TOKEN.test(token)
    || FINDING_LABEL_TOKEN.test(token)
    || ASSERTION_LABEL_TOKEN.test(token)
    || WORD_SUFFIX_CODE_TOKEN.test(token)
    || SECTION_TOKEN.test(token)
    || SECTION_TOKEN_SINGLE.test(token)
    || BRACKET_CODE_TOKEN.test(token)
    || BRACKET_REVIEW_TOKEN.test(token)
    || BRACKET_HARNESS_TOKEN.test(token)
    || BRACKET_QUALIFIER_TOKEN.test(token)
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
  if (colon !== -1) {
    const head = title.slice(0, colon)
    // A bare NUMBER before the colon is a case label: `02: the case`. A
    // number that starts a SENTENCE is a measurement — `80 columns keep
    // the full provider/model` — and the measurement is the point of the
    // title, so it stays.
    return { head, rest: title.slice(colon + 1), colonForm: true }
  }
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
  const colonForm = split.colonForm === true
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
    // A `PR D` pair and a `step 8` pair are ONE label token: the code and
    // its sub-label are one thing, not two.
    if (previous !== undefined && (PR_SUB_LABEL.test(`${previous} ${token}`) || STEP_LABEL_TOKEN.test(`${previous} ${token}`) || FINDING_LABEL_TOKEN.test(`${previous} ${token}`) || ASSERTION_LABEL_TOKEN.test(`${previous} ${token}`))) {
      tokens[tokens.length - 1] = `${previous} ${token}`
      continue
    }
    tokens.push(token)
  }
  let consumed = 0
  for (const [index, token] of tokens.entries()) {
    if (!isLabelToken(token, index === 0, colonForm && index === 0)) break
    consumed = index + 1
    // A `step N` label carries its trailing parts: `step 8 / §5 Must 17`.
    // They are ONE label, so the loop keeps consuming while the next
    // token is a label part too.
    if (STEP_LABEL_TOKEN.test(token)) {
      let next = index + 1
      while (next < tokens.length && isLabelToken(tokens[next], false)) {
        consumed = next + 1
        next += 1
      }
      break
    }
  }
  if (consumed === 0) return null
  const label = tokens.slice(0, consumed).join(' ')
  // The tokens the label did NOT consume are part of the SENTENCE.
  //
  // `B3 F4 control: with no settled entry …` — the code is `B3 F4`, and
  // `control` is the CATEGORY the case belongs to. The category is part of
  // what the title says, and dropping it would make the title say less
  // than it did.
  const kept = tokens.slice(consumed).join(' ')
  const rest = split.rest.trimStart()
  const sentence = kept === '' ? rest : `${kept}: ${rest}`
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
