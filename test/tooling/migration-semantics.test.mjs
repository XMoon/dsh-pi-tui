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
  unexplainedTextReferences,
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
    // The TEXT scan cannot tell a source-lock string from a real
    // reference, so it counts both; what the checker uses is the
    // UNEXPLAINED list — a text reference the extractor does not see and
    // that is not inside a string literal.
    assert.deepEqual(unexplainedTextReferences(source), [],
      `${label} must be explained by the string-literal exemption`)
  }
})

test('the coverage counter agrees with the extractor on every form', () => {
  // The coverage proof: a reference the TEXT scan finds and the extractor
  // does not see — outside a string literal — is a form the extractor
  // missed, and the checker reports it instead of a false assurance.
  for (const [label, source] of Object.entries(FORMS)) {
    assert.deepEqual(unexplainedTextReferences(source), [],
      `${label}: the text scan and the extractor must agree`)
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
  assert.equal(productionReferences(mixed).length, 3, 'the source-lock string is not a reference')
  assert.deepEqual(unexplainedTextReferences(mixed), [],
    'the source-lock string is explained by the string-literal exemption')
})

test('an executable import inside a template INTERPOLATION is a reference', () => {
  // The review's reproduction: a template literal's TEXT is not code, but
  // its `${…}` INTERPOLATION IS. A text-based scan cannot tell them apart;
  // the parser can, and the checker must see the import.
  const source = "const result = `loaded: ${await import('../src/real.ts')}`"
  assert.deepEqual(productionReferences(source), ['../src/real.ts'],
    'an executable import inside a template interpolation is a reference')
  assert.deepEqual(unexplainedTextReferences(source), [],
    'the extractor must explain every reference the text scan finds')
})

test('a reference inside a template literal\'s TEXT is not a reference', () => {
  const source = 'const fixture = `return import(\'../src/real.ts\')`'
  assert.deepEqual(productionReferences(source), [],
    'template TEXT is not executable code')
  assert.deepEqual(unexplainedTextReferences(source), [],
    'a text-only reference is explained by the string-literal exemption')
})

test('the import TYPE query and the CommonJS require are references', () => {
  const typeQuery = "const events: import('../../src/runtime/config-port.ts').Event[] = []"
  assert.deepEqual(productionReferences(typeQuery), ['../../src/runtime/config-port.ts'],
    'an import type query is a real reference')
  const requireForm = "const mod = require('../src/runtime/config-port.ts')"
  assert.deepEqual(productionReferences(requireForm), ['../src/runtime/config-port.ts'],
    'a CommonJS require is a real reference')
})
