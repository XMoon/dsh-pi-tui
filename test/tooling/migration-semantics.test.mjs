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

test('an identifier-valued source read resolves through its static initializer', () => {
  // The review's finding: the tree reads production files from an ARRAY of
  // paths, e.g.
  //
  //     for (const file of ['../src/a.ts', '../src/b.ts']) {
  //       readFileSync(new URL(file, import.meta.url), 'utf8')
  //     }
  //
  // The URL's argument is an IDENTIFIER, so a literal-only extractor sees
  // nothing — and the migration's rewrite of those array entries would go
  // unchecked.
  const source = [
    "for (const file of [",
    "  '../src/app/plugin-manager/controller.ts',",
    "  '../src/runtime/plugin-manager-port.ts',",
    "]) {",
    "  const source = readFileSync(new URL(file, import.meta.url), 'utf8')",
    "}",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source).sort(),
    ['../src/app/plugin-manager/controller.ts', '../src/runtime/plugin-manager-port.ts'],
    'every path the array names is a reference',
  )
  assert.deepEqual(unexplainedTextReferences(source), [])
})

test('a named array of production paths is resolved too', () => {
  const source = [
    "const files = ['../src/a.ts', '../src/b.ts']",
    "for (const file of files) {",
    "  readFileSync(new URL(file, import.meta.url), 'utf8')",
    "}",
  ].join('\n')
  assert.deepEqual(productionReferences(source).sort(), ['../src/a.ts', '../src/b.ts'])
})

test('an identifier reused in two scopes resolves to each scope\'s own array', () => {
  // The review's reproduction: two loops reuse the name `file` for
  // DIFFERENT arrays. A file-global map would resolve both to the last
  // array — a false reference for one loop and a missing one for the other.
  const source = [
    "for (const file of ['../src/actually-read.ts']) {",
    "  readFileSync(new URL(file, import.meta.url), 'utf8')",
    "}",
    "for (const file of ['../src/not-read.ts']) {",
    "  readFileSync(new URL(file, import.meta.url), 'utf8')",
    "}",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source).sort(),
    ['../src/actually-read.ts', '../src/not-read.ts'],
    'each use must resolve to its OWN scope\'s array',
  )
})

test('a runtime-built array is REPORTED, never silently ignored', () => {
  // The reference cannot be resolved statically, so the checker must say so
  // instead of claiming the file is covered.
  const source = [
    'const files = getSourcePaths()',
    "for (const file of files) { readFileSync(new URL(file, import.meta.url), 'utf8') }",
  ].join('\n')
  const refs = productionReferences(source)
  assert.equal(refs.length, 1)
  assert.match(refs[0], /^<unresolved:/u,
    'an unresolvable binding must be reported as unresolved')
})

test('a whole-tree enumeration resolves to the directory it walks', () => {
  // `srcTsFiles(root).filter(rel => readFileSync(new URL(rel, root), …))`
  // has no per-file target, but the DIRECTORY it walks is the reference the
  // migration had to keep pointing at.
  const source = [
    "const root = new URL('../src/', import.meta.url)",
    'const offenders = srcTsFiles(root)',
    "  .filter(rel => readFileSync(new URL(rel, root), 'utf8').includes('x'))",
  ].join('\n')
  assert.deepEqual(productionReferences(source), ['../src/'],
    'the enumeration base is the reference')
})

test('a path-join READ of a production file is a reference', () => {
  // The tree reads production files through a JOIN of the repository root
  // and literal segments: `readFileSync(join(root, 'src', 'app', …))`.
  const source = [
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')",
    "const surface = readFileSync(join(root, 'src', 'app', 'surface', 'runtime.ts'), 'utf8')",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source).filter(ref => ref.includes('src/')),
    ['<root>src/app/surface/runtime.ts'],
    'the join read must resolve to the production file',
  )
})

test('a path join that WRITES a fixture is not a production reference', () => {
  // `join(workspace, 'src', 'deep')` builds a TEMPORARY tree inside the
  // test's own work root. Its paths are not the repository's production
  // modules, so they must not be counted.
  const source = [
    "const workspace = join(dirname(fileURLToPath(import.meta.url)), '..', 'work')",
    "mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })",
    "writeFileSync(join(workspace, 'src', 'deep', 'utility.ts'), 'x')",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source).filter(ref => ref.includes('src/')),
    [],
    'a fixture write is not a production reference',
  )
})

test('a join read under a NAMED path variable is a reference', () => {
  // The review's reproduction: the tree computes a path ONCE
  // (`const srcDir = join(…, 'src')`) and then reads through it
  // (`join(srcDir, 'index.ts')`). The base is resolved RECURSIVELY.
  const source = [
    "const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')",
    "readFileSync(join(srcDir, 'index.ts'), 'utf8')",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source).filter(ref => ref.includes('src/')),
    ['<root>src/index.ts'],
    'the named path variable must resolve through its own initializer',
  )
})

test('a join read of the FORK package is a reference', () => {
  // The review's reproduction: the tree reads the vendored fork's own
  // sources and manifest through `join(ROOT, 'packages', 'pi-tui', …)`.
  const source = [
    "const localUtils = readFileSync(join(ROOT, 'packages', 'pi-tui', 'src', 'utils.ts'), 'utf8')",
    "const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', 'pi-tui', 'vendor-divergences.json'), 'utf8'))",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source).filter(ref => ref.includes('packages/')),
    ['<root>packages/pi-tui/src/utils.ts', '<root>packages/pi-tui/vendor-divergences.json'],
    'a join read of the fork package must resolve',
  )
})
