#!/usr/bin/env node
/**
 * The shared FIXED-WAIT HELPERS: the helpers that wait a fixed number of
 * milliseconds.
 *
 * A blind sleep is not only a literal `setTimeout` in the test file: it can
 * also be a call to a SHARED helper that wraps one. The helper names are
 * DERIVED FROM THE HELPERS' IMPLEMENTATION — a function whose body waits a
 * `setTimeout` whose delay comes from one of ITS OWN PARAMETERS is a
 * fixed-wait helper BY CONSTRUCTION.
 *
 * The derivation is therefore name-independent: a helper named `sleep`,
 * `pause`, `wait` or `directSettle` is covered the same way, and a NEW
 * helper is covered without a hand-maintained list.
 *
 * @module @xmoon76/dsh-pi-tui/scripts/fixed-wait-helpers
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SUPPORT_ROOT = join(ROOT, 'test', 'support')

/**
 * The fixed-wait helpers in the support directory.
 *
 * A helper qualifies when its body calls `setTimeout` with a delay that
 * comes from one of its OWN parameters — the signature of a helper that
 * waits a caller-chosen number of milliseconds.
 */
export function fixedWaitHelpers(supportRoot = SUPPORT_ROOT) {
  const helpers = new Set()
  let entries
  try {
    entries = readdirSync(supportRoot, { withFileTypes: true })
  } catch {
    return helpers
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(ts|mjs)$/u.test(entry.name)) continue
    const path = join(supportRoot, entry.name)
    const source = readFileSync(path, 'utf8')
    const file = ts.createSourceFile('helper.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    // A helper may be a FUNCTION DECLARATION (`export async function
    // sleep(...)`) or a VARIABLE holding an arrow/function expression
    // (`export const sleep = (...) => …`). Both are fixed-wait helpers when
    // their body waits a `setTimeout` whose delay comes from one of their
    // OWN parameters, so both forms are examined.
    const examine = (name, parameters, body) => {
      let wraps = false
      const scan = (inner) => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'setTimeout') {
          const delay = inner.arguments[1]
          if (delay !== undefined && ts.isIdentifier(delay) && parameters.has(delay.text)) {
            wraps = true
          }
        }
        ts.forEachChild(inner, scan)
      }
      scan(body)
      if (wraps) helpers.add(name)
    }
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
        examine(
          node.name.text,
          new Set(node.parameters.map(parameter => parameter.name.getText(file))),
          node,
        )
        ts.forEachChild(node, visit)
        return
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const initializer = node.initializer
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          examine(
            node.name.text,
            new Set(initializer.parameters.map(parameter => parameter.name.getText(file))),
            initializer,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return helpers
}

/**
 * The fixed waits a test file contains.
 *
 * A BLIND sleep is a fixed wait whose only purpose is "give the system
 * time". The policy allows a bounded wait when the contract IS about a
 * time window, and requires the reason next to it.
 *
 * The literal form is `setTimeout(resolve, 4000)`; the helper form is
 * `directSettle(4_000)`. A helper call with NO argument uses the helper's
 * own default, so it counts too.
 */
export function fixedWaitsOf(rel, testRoot, helpers = fixedWaitHelpers()) {
  const source = readFileSync(join(testRoot, rel), 'utf8')
  const lines = source.split('\n')
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // The literal form. The millisecond literal may use the underscore
    // separator (`30_000`).
    const literal = /setTimeout\([^,]*,\s*\d[\d_]{2,}/u.test(line)
    // The shared-helper form.
    const helperCall = [...helpers].some(helper => {
      const pattern = new RegExp(`\\b${helper}\\s*\\(\\s*(\\d[\\d_]{2,})?\\s*\\)`, 'u')
      return pattern.test(line)
    })
    if (!literal && !helperCall) continue
    // A blind wait needs a stated reason in a COMMENT on the line itself or
    // the line above. The marker must be a comment: a word in a test NAME
    // is not a reason.
    const context = `${lines[index - 1] ?? ''}\n${line}`
    if (/\/\/[^\n]*(?:reason|window|deadline|bounded|negative|observation)/iu.test(context)) continue
    found.push(index + 1)
  }
  return found
}
