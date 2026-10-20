#!/usr/bin/env node
/**
 * The migration DRIVER: move test files into their production ownership
 * directory, fix the paths, and PROVE that the migration is a pure
 * RELOCATION.
 *
 * The driver verifies, for every group:
 *
 *   1. the discovered file set is IDENTICAL before and after the move
 *      (compared through the move mapping, so a file that legitimately
 *      moved is not reported as "lost");
 *   2. every relative path in the WHOLE tree still resolves — the moved
 *      files AND the files that reference them;
 *   3. no destination is overwritten and no two sources claim one.
 *
 * The path forms it rewrites:
 *
 *   - the `from '…'` / `from "…"` import clauses, the side-effect
 *     `import '…'`, and the `import('…')` calls (single, double and
 *     template);
 *   - the `new URL('…', import.meta.url)` source reads (single and
 *     template), keeping a trailing separator for a URL BASE;
 *   - the `join(dirname(fileURLToPath(import.meta.url)), '…')`,
 *     `join(import.meta.dirname, '…')` and
 *     `resolve(dirname(fileURLToPath(import.meta.url)), '…')` handles.
 *
 * It ALSO rewrites the files that REFERENCE a moved file: a moved helper
 * leaves its importers' relative specifiers pointing at a path that no
 * longer exists.
 *
 * Usage: node scripts/migrate-test-group.mjs <group.json>
 *
 * The group file is JSON: { "moves": { "from": "to", … } } with both sides
 * relative to the test root.
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
 * Only the REAL import forms count: a `from '…'` clause, a side-effect
 * `import '…'`, and a dynamic `import('…')` call. A relative path inside
 * a plain string literal (many source locks assert on the exact text of a
 * production import) is NOT an import of THIS file and must not be
 * rewritten.
 */
export function relativeImports(source) {
  const specs = new Set()
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)'(\.[^']*)'/gu)) {
    if (!isInsideStringLiteral(source, match.index)) specs.add(match[1])
  }
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)"(\.[^"]*)"/gu)) {
    if (!isInsideStringLiteral(source, match.index)) specs.add(match[1])
  }
  for (const match of source.matchAll(/^\s*import\s+'(\.[^']*)'/gmu)) specs.add(match[1])
  for (const match of source.matchAll(/^\s*import\s+"(\.[^"]*)"/gmu)) specs.add(match[1])
  // The TEMPLATE import form: `import(\`../scripts/x.mjs?query=\`)`.
  for (const match of source.matchAll(/\bimport\(\s*`(\.[^`$]*)\$\{/gu)) specs.add(match[1])
  return [...specs]
}

/**
 * Every relative path a test file resolves against its OWN location.
 */
export function relativeUrlPaths(source) {
  const specs = new Set()
  for (const match of source.matchAll(/\bnew URL\(\s*'(\.[^']*)'\s*,\s*import\.meta\.url\s*\)/gu)) {
    specs.add(match[1])
  }
  for (const match of source.matchAll(/\bnew URL\(\s*`(\.[^`$]*)\$\{/gu)) {
    specs.add(match[1])
  }
  return [...specs]
}

/**
 * The `join(dirname(fileURLToPath(import.meta.url)), '…')` and
 * `join(import.meta.dirname, '…')` handles.
 */
export function joinPathSegments(source) {
  const specs = new Set()
  for (const match of source.matchAll(
    /join\(\s*dirname\(\s*fileURLToPath\(import\.meta\.url\)\s*\)\s*,\s*((?:'[^'\n]*'\s*,?\s*)+)\)/gu,
  )) {
    const segments = [...match[1].matchAll(/'([^']*)'/gu)].map(part => part[1])
    if (segments.length > 0) specs.add(segments.join('\u0000'))
  }
  for (const match of source.matchAll(
    /join\(\s*import\.meta\.dirname\s*,\s*((?:'[^'\n]*'\s*,?\s*)+)\)/gu,
  )) {
    const segments = [...match[1].matchAll(/'([^']*)'/gu)].map(part => part[1])
    if (segments.length > 0) specs.add(segments.join('\u0000'))
  }
  return [...specs]
}

/**
 * The `resolve(dirname(fileURLToPath(import.meta.url)), '…')` handle: the
 * repository-root handle a test computes from its own location.
 */
export function resolveRootPaths(source) {
  const specs = new Set()
  for (const match of source.matchAll(
    /resolve\(\s*dirname\(\s*fileURLToPath\(import\.meta\.url\)\s*\)\s*,\s*((?:'[^'\n]*'\s*,?\s*)+)\)/gu,
  )) {
    const segments = [...match[1].matchAll(/'([^']*)'/gu)].map(part => part[1])
    if (segments.length > 0) specs.add(segments.join('\u0000'))
  }
  return [...specs]
}

/** Whether the offset falls inside a string literal. */
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
 * the old directory and re-expressed relative to the new one, so a file
 * that imported `../../src/tui-app.ts` from `test/` imports
 * `../../../src/tui-app.ts` from `test/tui/`.
 */
export function rewriteImports(source, fromRel, toRel) {
  const fromDir = dirname(fromRel)
  const toDir = dirname(toRel)
  if (fromDir === toDir) return source
  // The file's ABSOLUTE directory, exactly as `dirname(fileURLToPath(
  // import.meta.url))` yields it in the code being rewritten. A `join` over
  // that absolute directory reproduces the code's own path semantics.
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
    out = out.split(`"${spec}"`).join(`"${normalized}"`)
    out = out.split(`\`${spec}\${`).join(`\`${normalized}\${`)
  }
  // The `join(...)` / `resolve(...)` handles: the segments after the file's
  // own directory must reach the same target. The WHOLE call is replaced,
  // not just its segment list: a segment-level replacement would rewrite a
  // short list (`'..'`) inside a longer one (`'..', 'src', …`).
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

/**
 * Rewrite the specifiers of a file that IMPORTS a moved file.
 *
 * A moved file leaves its importers' relative specifiers pointing at a path
 * that no longer exists. The importer is NOT moved, so only the specifier
 * that named the moved file changes.
 */
export function rewriteImporter(source, importerRel, movedFrom, movedTo) {
  const importerAbsolute = join(TEST_ROOT, dirname(importerRel))
  const movedAbsolute = join(TEST_ROOT, movedFrom)
  const movedTarget = join(TEST_ROOT, movedTo)
  let out = source
  for (const spec of relativeImports(source)) {
    if (!spec.startsWith('.')) continue
    const resolved = join(importerAbsolute, spec)
    if (resolved !== movedAbsolute) continue
    const newSpec = relative(importerAbsolute, movedTarget).split('\\').join('/')
    const normalized = newSpec.startsWith('.') ? newSpec : `./${newSpec}`
    out = out.split(`'${spec}'`).join(`'${normalized}'`)
    out = out.split(`"${spec}"`).join(`"${normalized}"`)
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
  const destinations = new Set()
  for (const [from, to] of Object.entries(moves)) {
    if (destinations.has(to)) throw new Error(`two files claim the same destination: ${to}`)
    destinations.add(to)
    if (group.retargetOnly === true) continue
    if (!existsSync(join(TEST_ROOT, from))) throw new Error(`the move source does not exist: test/${from}`)
    if (existsSync(join(TEST_ROOT, to))) throw new Error(`the move destination already exists: test/${to}`)
  }

  const before = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  const expectedAfter = before
    .map(rel => (moves[rel] === undefined ? rel : moves[rel]))
    .sort()

  if (group.retargetOnly !== true) {
    for (const [from, to] of Object.entries(moves)) {
      const source = readFileSync(join(TEST_ROOT, from), 'utf8')
      const toPath = join(TEST_ROOT, to)
      mkdirSync(dirname(toPath), { recursive: true })
      writeFileSync(toPath, rewriteImports(source, from, to))
      rmSync(join(TEST_ROOT, from))
    }
  }

  // ── The IMPORTERS of a moved file ────────────────────────────────────────
  // A moved file leaves its importers' relative specifiers pointing at a
  // path that no longer exists. The importer is not moved, so only the
  // specifier that named the moved file changes.
  const after = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  let retargeted = 0
  for (const [from, to] of Object.entries(moves)) {
    for (const rel of after) {
      if (rel === to) continue
      const path = join(TEST_ROOT, rel)
      const source = readFileSync(path, 'utf8')
      const rewritten = rewriteImporter(source, rel, from, to)
      if (rewritten !== source) {
        writeFileSync(path, rewritten)
        retargeted += 1
      }
    }
  }
  if (retargeted > 0) console.log(`retargeted ${retargeted} importer(s) of a moved file`)

  const finalSet = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  const lost = expectedAfter.filter(rel => !finalSet.includes(rel))
  const gained = finalSet.filter(rel => !expectedAfter.includes(rel))
  console.log(`moved ${Object.keys(moves).length} file(s)`)
  console.log(`discovered before: ${before.length}, after: ${finalSet.length} (expected: ${expectedAfter.length})`)
  if (lost.length > 0) console.log(`LOST: ${lost.join(', ')}`)
  if (gained.length > 0) console.log(`GAINED: ${gained.join(', ')}`)

  // ── EVERY relative path in the WHOLE tree must still resolve ────────────
  // The moved files are the ones the rewrite touched, but an UNMOVED file
  // can reference a MOVED file (a relative import, a source read, a
  // path literal). The whole tree is therefore checked, not just the moved
  // files.
  //
  // The migration driver's OWN suite is excluded: it deliberately contains
  // synthetic, non-resolving paths (they are the fixtures the rewrite rules
  // are proved against).
  const SYNTHETIC_PATH_OWNER = 'tooling/migration-driver.test.mjs'
  let broken = 0
  for (const rel of finalSet) {
    if (rel === SYNTHETIC_PATH_OWNER) continue
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
