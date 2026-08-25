#!/usr/bin/env node
/**
 * Pre-push gate stage derivation — the single source of truth for what the
 * husky pre-push hook runs stays in package.json's `verify:*` scripts; this
 * module turns one of them into the ordered per-command stage list the hook
 * executes with progress reporting.
 *
 * A script like `a && b && c` yields `['a', 'b', 'c']`. Only top-level `&&`
 * separators are split (a `&&` inside quotes, e.g. inside a node -e snippet,
 * is not a separator). A trailing `&&` (or a `&&` followed by nothing but
 * whitespace) is rejected — `sh -e` treats such a line as a syntax error, so
 * a split would silently drop the intended tail.
 *
 * Usage:
 *   node scripts/pre-push-stages.mjs <verify-script-name>
 *   # e.g. node scripts/pre-push-stages.mjs verify:prepush
 *
 * @module pre-push-stages
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`pre-push-stages: ${message}`)
  process.exit(1)
}

const [name] = process.argv.slice(2)
if (!name || !name.startsWith('verify:')) {
  fail(`usage: node scripts/pre-push-stages.mjs <verify-script-name> (got: ${name ?? 'none'})`)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const script = pkg.scripts?.[name]
if (typeof script !== 'string' || script === '') {
  fail(`package.json has no non-empty script "${name}" (update .husky/pre-push)`)
}

// Split on top-level `&&` only: walk the string tracking single-quote,
// double-quote and backslash escapes; a `&&` seen at depth 0 (no open quote)
// is a command separator.
const stages = []
let current = ''
let quote = null
for (let i = 0; i < script.length; i++) {
  const ch = script[i]
  if (quote === '"') {
    if (ch === '\\') { current += ch + (script[i + 1] ?? ''); i++; continue }
    if (ch === '"') quote = null
    current += ch
    continue
  }
  if (quote === "'") {
    if (ch === "'") quote = null
    current += ch
    continue
  }
  if (ch === '"' || ch === "'") {
    quote = ch
    current += ch
    continue
  }
  if (ch === '&' && script[i + 1] === '&') {
    stages.push(current)
    current = ''
    i++
    continue
  }
  current += ch
}
stages.push(current)

const trimmed = stages.map((s) => s.trim())
if (trimmed[trimmed.length - 1] === '') {
  fail(`script "${name}" ends with a dangling "&&" — sh -e would reject it; fix package.json`)
}
for (const [i, stage] of trimmed.entries()) {
  if (stage === '') {
    fail(`script "${name}" has an empty command at position ${i + 1} (consecutive "&&")`)
  }
}

process.stdout.write(trimmed.join('\n') + '\n')
