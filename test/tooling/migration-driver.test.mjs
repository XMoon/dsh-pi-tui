/**
 * The migration DRIVER's own contract: the path forms it must rewrite, the
 * preflight it must refuse, and the whole-tree check it must run.
 *
 * The driver is the instrument that performs the test-tree reorganization, so
 * a silent defect in it would corrupt the tree. These cases are written
 * against SYNTHETIC sources, so they prove the rewrite rules themselves and
 * not one particular file's paths.
 *
 * @module @xmoon76/dsh-pi-tui/test/migration-driver.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  joinPathSegments,
  relativeImports,
  relativeUrlPaths,
  resolveRootPaths,
  rewriteImports,
} from '../../scripts/migrate-test-group.mjs'

/** The rewrite under test: a file moves from `test/` to `test/tui/`. */
const FROM = 'sample.test.ts'
const TO = 'tui/sample.test.ts'

test('the import clause is rewritten to the new depth', () => {
  const out = rewriteImports("import { x } from './support/helper.ts'\n", FROM, TO)
  assert.match(out, /from '\.\.\/support\/helper\.ts'/u)
})

test('the double-quoted clause is rewritten too', () => {
  const out = rewriteImports('import { x } from "./support/helper.ts"\n', FROM, TO)
  assert.match(out, /from "\.\.\/support\/helper\.ts"/u)
})

test('the side-effect import is rewritten too', () => {
  const out = rewriteImports("import './support/helper.ts'\n", FROM, TO)
  assert.match(out, /import '\.\.\/support\/helper\.ts'/u)
})

test('the dynamic import is rewritten too', () => {
  const out = rewriteImports("const m = await import('./support/helper.ts')\n", FROM, TO)
  assert.match(out, /import\('\.\.\/support\/helper\.ts'\)/u)
})

test('the template dynamic import is rewritten, keeping its interpolated tail', () => {
  const out = rewriteImports('const m = await import(`./support/helper.ts?t=${Date.now()}`)\n', FROM, TO)
  assert.match(out, /import\(`\.\.\/support\/helper\.ts\?t=\$\{Date\.now\(\)\}`\)/u)
})

test('the new URL source read is rewritten, keeping a trailing separator', () => {
  const out = rewriteImports("readFileSync(new URL('../src/app/', import.meta.url), 'utf8')\n", FROM, TO)
  assert.match(out, /new URL\('\.\.\/\.\.\/src\/app\/'\u002c import\.meta\.url\)/u,
    'the trailing separator must survive: the URL is used as a BASE')
})

test('the template new URL source read is rewritten', () => {
  const out = rewriteImports("readFileSync(new URL(`../src/tui/${name}`, import.meta.url), 'utf8')\n", FROM, TO)
  assert.match(out, /new URL\(`\.\.\/\.\.\/src\/tui\/\$\{name\}`/u)
})

test('the join(dirname(fileURLToPath(import.meta.url))) handle is rewritten', () => {
  const out = rewriteImports(
    "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')\n",
    FROM,
    TO,
  )
  assert.match(out, /join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.\.'\)/u)
})

test('the join(import.meta.dirname) handle is rewritten', () => {
  const out = rewriteImports("const root = join(import.meta.dirname, '..')\n", FROM, TO)
  assert.match(out, /join\(import\.meta\.dirname, '\.\.', '\.\.'\)/u)
})

test('the resolve(dirname(fileURLToPath(import.meta.url))) handle is rewritten', () => {
  const out = rewriteImports("const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')\n", FROM, TO)
  assert.match(out, /resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', '\.\.'\)/u)
})

test('a short handle is not corrupted by a longer one that shares its first segment', () => {
  // The segment-level replacement would rewrite the `'..'` inside
  // `'..', 'src', …`; the whole-call replacement must not.
  const source = [
    "const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')",
    "const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app', 'runtime.ts')",
    '',
  ].join('\n')
  const out = rewriteImports(source, FROM, TO)
  const lines = out.split('\n')
  assert.match(lines[0], /'\.\.', '\.\.'\)/u, 'the ROOT handle must gain exactly one level')
  assert.match(lines[1], /'\.\.', '\.\.', 'src', 'app', 'runtime\.ts'\)/u,
    'the longer handle must gain exactly one level, and keep every segment')
})

test('a relative path inside a plain string literal is not an import', () => {
  const source = 'assert.ok(other.includes("import { x } from \'../src/app/runtime.ts\'"))\n'
  assert.deepEqual(relativeImports(source), [],
    'a quoted import text inside a string literal is a source lock, not an import')
})

test('a relative path inside a template literal is not an import', () => {
  const source = 'const fixture = `export function load() { return import(\'../src/app/runtime.js\') }`\n'
  assert.deepEqual(relativeImports(source), [],
    'a template-literal fixture is not an import of this file')
})

test('the path readers find exactly the forms they own', () => {
  const source = [
    "import { a } from './a.ts'",
    "const b = new URL('../src/b.ts', import.meta.url)",
    "const c = join(dirname(fileURLToPath(import.meta.url)), '..')",
    "const d = resolve(dirname(fileURLToPath(import.meta.url)), '..')",
    '',
  ].join('\n')
  assert.deepEqual(relativeImports(source), ['./a.ts'])
  assert.deepEqual(relativeUrlPaths(source), ['../src/b.ts'])
  assert.deepEqual(joinPathSegments(source), ['..'])
  assert.deepEqual(resolveRootPaths(source), ['..'])
})

test('a file that does not move keeps its paths byte-identical', () => {
  const source = "import { a } from './a.ts'\n"
  assert.equal(rewriteImports(source, 'sample.test.ts', 'sample.test.ts'), source)
})
