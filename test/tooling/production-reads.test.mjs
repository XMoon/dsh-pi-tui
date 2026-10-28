/**
 * The production-read RESOLVER's own contract.
 *
 * The resolver decides which production file a test actually reads. A
 * resolver that misses a form would let a source lock silently point at a
 * DIFFERENT file, so every form the tree uses is proved here — and a form
 * that cannot be resolved must be REPORTED, never silently ignored.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/production-reads.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { productionReads, productionReferences } from '../../scripts/production-reads.mjs'

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
  'the import type query': "const e: import('../src/app/runtime.ts').Event[] = []",
  'the CommonJS require': "const m = require('../src/app/runtime.ts')",
}

test('the resolver recognises every production-read form the tree uses', () => {
  for (const [label, source] of Object.entries(FORMS)) {
    const refs = productionReferences(source, 0)
    assert.equal(refs.length, 1, `${label} must be recognised as one reference`)
    assert.match(refs[0], /^\.\.\//u, `${label} must yield the relative specifier`)
  }
})

test('a reference inside a string literal is not a reference of this file', () => {
  const source = 'assert.ok(source.includes("import { x } from \'../src/app/runtime.ts\'"))'
  assert.deepEqual(productionReferences(source, 0), [],
    'a source-lock assertion on another file is not a reference of this file')
})

test('an executable import inside a template INTERPOLATION is a reference', () => {
  // The template literal's TEXT is not code, but its `${…}` INTERPOLATION
  // IS. A text-based scan cannot tell them apart; the parser can.
  const source = "const result = `loaded: ${await import('../src/real.ts')}`"
  assert.deepEqual(productionReferences(source, 0), ['../src/real.ts'],
    'an executable import inside a template interpolation is a reference')
})

test('a reference inside a template literal\'s TEXT is not a reference', () => {
  const source = 'const fixture = `return import(\'../src/real.ts\')`'
  assert.deepEqual(productionReferences(source, 0), [],
    'template TEXT is not executable code')
})

test('a function parameter that shadows an outer array resolves to the parameter', () => {
  // The binding-aware case: the URL uses the PARAMETER, not the outer array.
  const source = [
    "const file = ['../src/outer.ts']",
    "function read(file) { readFileSync(new URL(file, import.meta.url), 'utf8') }",
  ].join('\n')
  assert.deepEqual(productionReferences(source, 0), ['<unresolved:file>'],
    'the outer array must not be used when the parameter shadows it')
})

test('a path-join READ of a production file is a reference', () => {
  const source = [
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')",
    "const surface = readFileSync(join(root, 'src', 'app', 'surface', 'runtime.ts'), 'utf8')",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source, 0).filter(ref => ref.includes('src/')),
    ['<root>src/app/surface/runtime.ts'],
    'the join read must resolve to the production file',
  )
})

test('a path join that WRITES a fixture is not a production reference', () => {
  const source = [
    "const workspace = join(dirname(fileURLToPath(import.meta.url)), '..', 'work')",
    "mkdirSync(join(workspace, 'src', 'deep'), { recursive: true })",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source, 0).filter(ref => ref.includes('/src/')),
    [],
    'a fixture write is not a production reference',
  )
})

test('a join read under a NAMED path variable is a reference', () => {
  const source = [
    "const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')",
    "readFileSync(join(srcDir, 'index.ts'), 'utf8')",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source, 1).filter(ref => ref.includes('src/')),
    ['<root>src/index.ts'],
    'the named path variable must resolve through its own initializer',
  )
})

test('a join read of the FORK package is a reference', () => {
  const source = [
    "const localUtils = readFileSync(join(ROOT, 'packages', 'pi-tui', 'src', 'utils.ts'), 'utf8')",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source, 0).filter(ref => ref.includes('packages/')),
    ['<root>packages/pi-tui/src/utils.ts'],
    'a join read of the fork package must resolve',
  )
})

test('a local read HELPER\'s call sites are the references', () => {
  const source = [
    "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')",
    "const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')",
    "const surface = read('src/app/surface/runtime.ts')",
    "const journal = read('src/app/surface/opening-journal.ts')",
  ].join('\n')
  assert.deepEqual(
    productionReferences(source, 0).filter(ref => ref.includes('src/')).sort(),
    ['<root>src/app/surface/opening-journal.ts', '<root>src/app/surface/runtime.ts'],
    'each call site must contribute its own production path',
  )
})

test('a read helper whose base is NOT the repository root is reported, not assumed', () => {
  // A base with one `..` level too few resolves into the TEST tree, so
  // every call site would read a path that does not exist — and the
  // comparison between two trees would pass while the reads are broken.
  const wrongBase = [
    "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')",
    "const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')",
    "const surface = read('src/app/surface/runtime.ts')",
  ].join('\n')
  const wrongRefs = productionReferences(wrongBase, 1)
  assert.ok(
    wrongRefs.some(ref => ref.startsWith('<unresolved:')),
    'a base that does not reach the repository root must be reported as unresolved',
  )
  assert.ok(
    !wrongRefs.includes('<root>src/app/surface/runtime.ts'),
    'a base that does not reach the repository root must not be reported as a production read',
  )
})

test('a read helper over a NON-production directory is excluded, not reported', () => {
  // The generated preset patches are not a production source: reporting
  // them as an unresolved PRODUCTION reference would make the guard fail
  // on a correct tree.
  const source = [
    "const root = join(import.meta.dirname, '..', '..', 'generated', 'dsh-presets')",
    "const count = (file: string): number =>",
    "  (readFileSync(join(root, file), 'utf8').match(/x/gu) ?? []).length",
    "const hits = count('standard.patch.yml')",
  ].join('\n')
  assert.deepEqual(productionReferences(source, 1), [],
    'a read of the generated presets is not a production reference')
})

test('a read helper over an UNKNOWN base is still reported', () => {
  const source = [
    'const root = someBase()',
    "const count = (file: string): number => readFileSync(join(root, file), 'utf8').length",
    "const hits = count('src/app/runtime.ts')",
  ].join('\n')
  assert.ok(
    productionReferences(source, 1).some(ref => ref.startsWith('<unresolved:')),
    'an unknown base must be reported as unresolved',
  )
})

test('a mixed static and dynamic array reports the static subset AND the partial', () => {
  const source = [
    "for (const file of ['../src/static.ts', ...runtimePaths()]) {",
    "  readFileSync(new URL(file, import.meta.url), 'utf8')",
    '}',
  ].join('\n')
  const refs = productionReferences(source, 0)
  assert.ok(refs.includes('../src/static.ts'), 'the static member is a reference')
  assert.ok(
    refs.some(ref => ref.startsWith('<unresolved:')),
    'a spread member makes the array partial, and the partial must be reported',
  )
})

test('the resolved reads are expressed relative to the repository root', () => {
  const source = [
    "const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')",
    "const surface = readFileSync(join(root, 'src', 'app', 'surface', 'runtime.ts'), 'utf8')",
  ].join('\n')
  const { paths } = productionReads(source, 1)
  assert.deepEqual(paths, ['src/app/surface/runtime.ts'],
    'a resolved read must name the production file relative to the repository root')
})
