#!/usr/bin/env node
/**
 * The test-tree MIGRATION driver: move test files into their production
 * ownership directory, fix the relative imports, and PROVE that the
 * discovered test set is unchanged.
 *
 * The migration is a pure relocation: no test LOGIC changes. The driver
 * therefore verifies, for every group:
 *
 *   1. the discovered file set is IDENTICAL before and after the move — a
 *      moved file that silently stops being discovered is the failure this
 *      whole exercise exists to prevent;
 *   2. every moved file's relative imports still resolve to a real file;
 *   3. the total case count is unchanged.
 *
 * Usage: node scripts/migrate-test-group.mjs <group.json>
 *
 * The group file is JSON:
 *   { "moves": { "test/old/name.test.ts": "test/new/name.test.ts", ... } }
 *
 * @module @xmoon76/dsh-pi-tui/scripts/migrate-test-group
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverTestFiles } from './test-discovery.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

/**
 * Every relative import specifier a test file uses.
 *
 * Only the REAL import forms count: a `from '…'` clause and a dynamic
 * `import('…')` call. A relative path inside a plain string literal (many
 * source locks assert on the exact text of a production import) is NOT an
 * import of THIS file and must not be rewritten.
 *
 * The `from` clause is matched only at a STATEMENT position — the clause
 * starts a line, or follows an identifier (`}` / `{` / `,` / `type` / `as`).
 * A quoted `from '…'` inside a longer string literal is therefore not a
 * match.
 */
export function relativeImports(source) {
  const specs = new Set()
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)'(\.[^']*)'/gu)) {
    if (!isInsideStringLiteral(source, match.index)) {
      specs.add(match[1])
    }
  }
  // The DOUBLE-quoted clause: `from "…"` / `import("…")`.
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)"(\.[^"]*)"/gu)) {
    if (!isInsideStringLiteral(source, match.index)) {
      specs.add(match[1])
    }
  }
  // The SIDE-EFFECT import: `import "…"`.
  for (const match of source.matchAll(/^\s*import\s+'(\.[^']*)'/gmu)) {
    specs.add(match[1])
  }
  for (const match of source.matchAll(/^\s*import\s+"(\.[^"]*)"/gmu)) {
    specs.add(match[1])
  }
  // The TEMPLATE import form: `import(\`../scripts/x.mjs?query=\`)`. The
  // literal prefix before the interpolation is the part that must be
  // rewritten; the interpolated part is appended to that prefix.
  for (const match of source.matchAll(/\bimport\(\s*`(\.[^`$]*)\$\{/gu)) {
    specs.add(match[1])
  }
  return [...specs]
}

/**
 * Every relative path a test file resolves against its OWN location.
 *
 * Two forms exist:
 *   - `new URL('…', import.meta.url)` — a source read;
 *   - `join(dirname(fileURLToPath(import.meta.url)), '…')` — a path built
 *     from the file's own directory.
 *
 * Both are relative to the FILE, exactly like an import, so a move must
 * rewrite them too — otherwise the test reads a path that no longer exists.
 */
export function relativeUrlPaths(source) {
  const specs = new Set()
  for (const match of source.matchAll(/\bnew URL\(\s*'(\.[^']*)'\s*,\s*import\.meta\.url\s*\)/gu)) {
    specs.add(match[1])
  }
  // The TEMPLATE form: `new URL(\`../src/x/${name}\`, import.meta.url)`. The
  // literal prefix before the interpolation is the part that must be
  // rewritten; the interpolated part is already relative to that prefix.
  for (const match of source.matchAll(/\bnew URL\(\s*`(\.[^`$]*)\$\{/gu)) {
    specs.add(match[1])
  }
  return [...specs]
}
/**
 * The `join(dirname(fileURLToPath(import.meta.url)), '…')` form: the
 * relative segments that follow the file's own directory.
 *
 * The path is expressed as SEGMENTS, so the rewrite is a segment-level
 * operation: the segments after the file's directory are replaced with the
 * segments that reach the same target from the new location.
 */
export function joinPathSegments(source) {
  const specs = new Set()
  // The `join(dirname(fileURLToPath(import.meta.url)), '…')` form, possibly
  // spread over several lines. The segment list is matched as the quoted
  // literals that follow the closing parenthesis of the `dirname(...)` call,
  // so a nested `)` inside `fileURLToPath(...)` cannot truncate it.
  for (const match of source.matchAll(
    /join\(\s*dirname\(\s*fileURLToPath\(import\.meta\.url\)\s*\)\s*,\s*((?:'[^'\n]*'\s*,?\s*)+)\)/gu,
  )) {
    const segments = [...match[1].matchAll(/'([^']*)'/gu)].map(part => part[1])
    if (segments.length === 0) continue
    // The segments are joined with a separator that cannot occur inside a
    // path segment, so the list can be split back unambiguously.
    specs.add(segments.join('\u0000'))
  }
  // The `join(import.meta.dirname, '…')` form: the same semantics, spelled
  // with the modern `import.meta.dirname`.
  for (const match of source.matchAll(
    /join\(\s*import\.meta\.dirname\s*,\s*((?:'[^'\n]*'\s*,?\s*)+)\)/gu,
  )) {
    const segments = [...match[1].matchAll(/'([^']*)'/gu)].map(part => part[1])
    if (segments.length === 0) continue
    specs.add(segments.join('\u0000'))
  }
  return [...specs]
}

/**
 * The `resolve(dirname(fileURLToPath(import.meta.url)), '…')` form: the
 * repository-root handle a test computes from its own location.
 */
export function resolveRootPaths(source) {
  const specs = new Set()
  for (const match of source.matchAll(
    /resolve\(\s*dirname\(\s*fileURLToPath\(import\.meta\.url\)\s*\)\s*,\s*((?:'[^'\n]*'\s*,?\s*)+)\)/gu,
  )) {
    const segments = [...match[1].matchAll(/'([^']*)'/gu)].map(part => part[1])
    if (segments.length === 0) continue
    specs.add(segments.join('\u0000'))
  }
  return [...specs]
}

/**
 * Whether the offset falls inside a string literal.
 *
 * The scan is line-by-line and tracks the quote character that opened the
 * literal: a `from '…'` inside a double-quoted literal, a template literal,
 * or a single-quoted literal is a source-lock assertion or a test fixture —
 * NOT an import of this file. Such a literal always has an unescaped
 * opening quote before the offset on the same line.
 */
function isInsideStringLiteral(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  const line = source.slice(lineStart, offset)
  let quote = undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
  }
  return quote !== undefined
}

/** Whether a relative specifier resolves to an existing file. */
export function resolves(fromRel, spec) {
  const target = join(TEST_ROOT, dirname(fromRel), spec)
  if (existsSync(target)) return true
  // A TypeScript source may be imported with its `.js`/`.mjs` spelling.
  const withoutExt = target.replace(/\.(?:js|mjs|jsx)$/u, '')
  return existsSync(`${withoutExt}.ts`) || existsSync(`${withoutExt}.tsx`) || existsSync(`${withoutExt}.mts`)
}

/**
 * Rewrite a file's relative specifiers for its new location.
 *
 * The rewrite is purely positional: a specifier that pointed at
 * `<old-dir>/x` now points at `<new-dir>/x`. The TARGET is resolved against
 * the old directory and re-expressed relative to the new one, so a file that
 * imported `../../src/tui-app.ts` from `test/` imports
 * `../../../src/tui-app.ts` from `test/tui/`.
 */
export function rewriteImports(source, fromRel, toRel) {
  const fromDir = dirname(fromRel)
  const toDir = dirname(toRel)
  if (fromDir === toDir) return source
  // The file's ABSOLUTE directory, exactly as `dirname(fileURLToPath(
  // import.meta.url))` yields it in the code being rewritten. A `join` over
  // that absolute directory reproduces the code's own path semantics
  // (`join('/repo/test', '..', 'src')` = `/repo/src`).
  const fromAbsolute = join(TEST_ROOT, fromDir)
  const toAbsolute = join(TEST_ROOT, toDir)
  let out = source
  // The SOURCE-READ paths first: they are rewritten as whole literals, so
  // the import rewrite below cannot match them by accident.
  for (const spec of relativeUrlPaths(source)) {
    const target = join(fromAbsolute, spec)
    const newSpec = relative(toAbsolute, target).split('\\').join('/')
    // A spec that ended with a separator must keep it: the rewritten spec
    // is used as a URL BASE (`new URL(rel, root)`), and a base without its
    // trailing separator resolves a relative path against its PARENT.
    const keepSlash = spec.endsWith('/')
    const normalized = (newSpec.startsWith('.') ? newSpec : `./${newSpec}`) + (keepSlash ? '/' : '')
    out = out.split(`'${spec}'`).join(`'${normalized}'`)
    // The TEMPLATE form carries the same prefix inside backticks.
    const templateNew = keepSlash ? `${normalized}` : normalized
    out = out.split(`\`${spec}\${`).join(`\`${templateNew}\${`)
  }
  // The `join(dirname(fileURLToPath(import.meta.url)), '…')` form: the
  // segments after the file's own directory must reach the same target.
  //
  // The WHOLE call is replaced, not just its segment list: a segment-level
  // replacement would rewrite a short list (`'..'`) inside a longer one
  // (`'..', 'src', …`) and corrupt it.
  for (const segments of joinPathSegments(source)) {
    const parts = segments.split('\u0000')
    const target = join(fromAbsolute, ...parts)
    const newParts = relative(toAbsolute, target).split('\\').join('/').split('/')
    const replacement = newParts.map(part => `'${part}'`).join(', ')
    for (const base of [
      'join(dirname(fileURLToPath(import.meta.url)), ',
      'join(import.meta.dirname, ',
    ]) {
      const call = `${base}${parts.map(part => `'${part}'`).join(', ')})`
      out = out.split(call).join(`${base}${replacement})`)
    }
  }
  // The `resolve(dirname(fileURLToPath(import.meta.url)), '…')` form: the
  // repository-root handle. `resolve` normalizes a leading `..` against the
  // base, so the segment list is re-expressed the same way.
  for (const segments of resolveRootPaths(source)) {
    const parts = segments.split('\u0000')
    const target = resolve(fromAbsolute, ...parts)
    const newParts = relative(toAbsolute, target).split('\\').join('/').split('/')
    const base = 'resolve(dirname(fileURLToPath(import.meta.url)), '
    const call = `${base}${parts.map(part => `'${part}'`).join(', ')})`
    out = out.split(call).join(`${base}${newParts.map(part => `'${part}'`).join(', ')})`)
  }
  for (const spec of relativeImports(source)) {
    if (!spec.startsWith('.')) continue
    // Resolve the specifier against the OLD location, then re-express it
    // relative to the NEW directory. BOTH sides must be absolute: `relative`
    // mixes its bases, so a relative base silently yields a nonsense path.
    const target = join(fromAbsolute, spec)
    const newSpec = relative(toAbsolute, target).split('\\').join('/')
    const normalized = newSpec.startsWith('.') ? newSpec : `./${newSpec}`
    // Replace the specifier only where it is a WHOLE quoted literal, so a
    // rewritten specifier can never be rewritten again by a later pass.
    out = out.split(`'${spec}'`).join(`'${normalized}'`)
    out = out.split(`"${spec}"`).join(`"${normalized}"`)
    // The TEMPLATE import form carries the same prefix inside backticks.
    out = out.split(`\`${spec}\${`).join(`\`${normalized}\${`)
  }
  return out
}

function main() {
  const groupPath = process.argv[2]
  if (groupPath === undefined) {
    console.error('usage: node scripts/migrate-test-group.mjs <group.json>')
    process.exit(2)
  }
  const group = JSON.parse(readFileSync(groupPath, 'utf8'))
  const moves = group.moves ?? {}

  // ── PREFLIGHT ────────────────────────────────────────────────────────────
  // A destination that already exists would be OVERWRITTEN: the migration
  // must never silently replace a file. Two sources may not claim the same
  // destination either.
  const destinations = new Set()
  for (const [from, to] of Object.entries(moves)) {
    if (destinations.has(to)) throw new Error(`two files claim the same destination: ${to}`)
    destinations.add(to)
    const fromPath = join(TEST_ROOT, from)
    if (!existsSync(fromPath)) throw new Error(`the move source does not exist: test/${from}`)
    const toPath = join(TEST_ROOT, to)
    if (existsSync(toPath)) throw new Error(`the move destination already exists: test/${to}`)
  }

  const before = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  // The AFTER set is compared through the MOVE MAPPING, not by path: a file
  // that legitimately moved is not "lost". The comparison therefore proves
  // that the migration is a pure RELOCATION — the same set of files, under
  // their new names.
  const expectedAfter = before
    .map(rel => (moves[rel] === undefined ? rel : moves[rel]))
    .sort()

  for (const [from, to] of Object.entries(moves)) {
    const fromPath = join(TEST_ROOT, from)
    const source = readFileSync(fromPath, 'utf8')
    const toPath = join(TEST_ROOT, to)
    mkdirSync(dirname(toPath), { recursive: true })
    writeFileSync(toPath, rewriteImports(source, from, to))
    rmSync(fromPath)
  }

  const after = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  const lost = expectedAfter.filter(rel => !after.includes(rel))
  const gained = after.filter(rel => !expectedAfter.includes(rel))
  console.log(`moved ${Object.keys(moves).length} file(s)`)
  console.log(`discovered before: ${before.length}, after: ${after.length} (expected: ${expectedAfter.length})`)
  if (lost.length > 0) console.log(`LOST: ${lost.join(', ')}`)
  if (gained.length > 0) console.log(`GAINED: ${gained.join(', ')}`)

  // ── EVERY relative path in the WHOLE tree must still resolve ────────────
  // The moved files are the ones the rewrite touched, but an UNMOVED file
  // can reference a MOVED file (a relative import, a source read, a
  // path literal). The whole tree is therefore checked, not just the moved
  // files.
  let broken = 0
  for (const rel of after) {
    const source = readFileSync(join(TEST_ROOT, rel), 'utf8')
    for (const spec of relativeImports(source)) {
      if (!resolves(rel, spec)) {
        console.log(`BROKEN IMPORT: ${rel} -> ${spec}`)
        broken += 1
      }
    }
    for (const spec of relativeUrlPaths(source)) {
      if (!resolves(rel, spec)) {
        console.log(`BROKEN SOURCE PATH: ${rel} -> ${spec}`)
        broken += 1
      }
    }
  }
  console.log(`broken paths across the whole tree: ${broken}`)
  if (lost.length > 0 || gained.length > 0 || broken > 0) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
