/**
 * The migration SEMANTICS checker's own contract.
 *
 * The checker compares, for every test file, the RESOLVED target of each
 * production reference against the base tree. A reference FORM the
 * extractor does not recognise would make the checker report a false
 * assurance — so the extractor's coverage is proved here, against every
 * form the tree actually uses.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/migration-semantics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  productionReferenceCount,
  productionReferences,
} from '../../scripts/verify-migration-semantics.mjs'

/** The forms the tree uses. */
const FORMS = {
  'the single-quoted source read': "readFileSync(new URL('../src/app/runtime.ts', import.meta.url), 'utf8')",
  'the double-quoted source read': 'readFileSync(new URL("../src/app/runtime.ts", import.meta.url), "utf8")',
  'the template source read': "readFileSync(new URL(`../src/app/${name}`, import.meta.url), 'utf8')",
  'the single-quoted import': "import { x } from '../src/app/runtime.ts'",
  'the double-quoted import': 'import { x } from "../src/app/runtime.ts"',
  'the dynamic import': "const m = await import('../src/app/runtime.ts')",
  'the template dynamic import': 'const m = await import(`../src/app/${name}`)',
  'the side-effect import': "import '../src/app/runtime.ts'",
}

/** The forms that are NOT references of the file that mentions them. */
const NOT_REFERENCES = {
  'a source-lock assertion on another file': 'assert.ok(source.includes("import { x } from \'../src/app/runtime.ts\'"))',
  'a test fixture holding a production import': 'const fixture = "type T = import(\'../src/app/runtime.ts\').T\\n"',
}

test('the extractor recognises every production-reference form the tree uses', () => {
  for (const [label, source] of Object.entries(FORMS)) {
    const refs = productionReferences(source)
    assert.equal(refs.length, 1, `${label} must be recognised as one reference`)
    assert.match(refs[0], /^\.\.\//u, `${label} must yield the relative specifier`)
  }
})

test('a reference inside a string literal is not a reference of this file', () => {
  for (const [label, source] of Object.entries(NOT_REFERENCES)) {
    assert.deepEqual(productionReferences(source), [], `${label} must not be counted as a reference`)
    assert.equal(productionReferenceCount(source), 0, `${label} must not be counted by the raw counter either`)
  }
})

test('the coverage counter agrees with the extractor on every form', () => {
  // The coverage proof: the form-agnostic counter and the extractor must
  // see the SAME number of references. A form the extractor misses makes
  // them differ, and the checker reports it instead of a false assurance.
  for (const [label, source] of Object.entries(FORMS)) {
    assert.equal(
      productionReferenceCount(source),
      productionReferences(source).length,
      `${label}: the raw counter and the extractor must agree`,
    )
  }
  const mixed = [
    "import { a } from '../src/a.ts'",
    "import { b } from '../src/b.ts'",
    "readFileSync(new URL('../src/c.ts', import.meta.url), 'utf8')",
    'assert.ok(source.includes("import { d } from \'../src/d.ts\'"))',
  ].join('\n')
  assert.equal(productionReferenceCount(mixed), productionReferences(mixed).length)
  assert.equal(productionReferences(mixed).length, 3, 'the source-lock string is not a reference')
})
