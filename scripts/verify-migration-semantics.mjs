#!/usr/bin/env node
/**
 * The migration's SEMANTIC check: every production path a test reads must
 * still point at the SAME file it pointed at before the move.
 *
 * A path rewrite that resolves to a DIFFERENT production file is a silent
 * semantic change: the test would keep passing while proving a different
 * contract.
 *
 * The reference extraction is SYNTAX-AWARE. A regex cannot tell an
 * executable `import('../src/x.ts')` from the same text inside a template
 * literal's TEXT — and a template literal's `${…}` INTERPOLATION is
 * executable code, not text. The TypeScript parser can: it reports the
 * actual module specifiers and ignores a string that merely CONTAINS an
 * import.
 *
 * Usage: node scripts/verify-migration-semantics.mjs <base-sha>
 * @module @xmoon76/dsh-pi-tui/scripts/verify-migration-semantics
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { discoverTestFiles } from './test-discovery.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = resolve(ROOT, 'test')

/**
 * The file-relative production references a test file makes.
 *
 * The TypeScript parser reports the ACTUAL module specifiers — the import
 * clauses, the dynamic imports and the `new URL(…, import.meta.url)` source
 * reads — and ignores text that merely contains an import. A specifier
 * inside a template literal's TEXT is therefore not a reference; a
 * specifier inside a template literal's `${…}` INTERPOLATION is, because
 * the parser sees it as executable code.
 */
export function productionReferences(source) {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const refs = []
  const add = (specifier) => {
    if (typeof specifier !== 'string') return
    if (!specifier.startsWith('../')) return
    // A specifier may carry a QUERY string (`x.mjs?process-test=1`): the
    // query is not part of the path, so it is stripped before the
    // comparison.
    refs.push(specifier.split('?')[0])
  }

  // A `new URL(<identifier>, import.meta.url)` resolves through the
  // identifier's binding AT THAT USE SITE — not through a file-global map.
  // The tree reads production files from an array of paths:
  //
  //     for (const file of ['../src/a.ts', '../src/b.ts']) {
  //       readFileSync(new URL(file, import.meta.url), 'utf8')
  //     }
  //
  // The binding is SCOPED: two loops may reuse the same name for different
  // arrays, and a file-global map would resolve both to the LAST one — a
  // false reference for one loop and a missing one for the other. The
  // resolution therefore walks the AST from the USE SITE outwards and
  // takes the NEAREST enclosing binding of that name.
  const resolveIdentifierAt = (useNode, name) => {
    // The nearest enclosing `for…of` whose loop variable IS the name, and
    // whose iterable is an array literal of strings.
    for (let node = useNode; node !== undefined; node = node.parent) {
      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        const names = node.initializer.declarations
          .filter(declaration => ts.isIdentifier(declaration.name))
          .map(declaration => declaration.name.text)
        if (!names.includes(name)) continue
        // The iterable is an INLINE array literal.
        if (ts.isArrayLiteralExpression(node.expression)) {
          return node.expression.elements
            .filter(element => ts.isStringLiteralLike(element))
            .map(element => element.text)
        }
        // The iterable is a NAMED array declared in the enclosing scope:
        // `const files = ['…']; for (const file of files) { … }`.
        if (ts.isIdentifier(node.expression)) {
          const initializer = resolveDeclarationInitializer(node, node.expression.text)
          if (initializer !== undefined && ts.isArrayLiteralExpression(initializer)) {
            return initializer.elements
              .filter(element => ts.isStringLiteralLike(element))
              .map(element => element.text)
          }
          // The iterable is not a static array: the reference cannot be
          // resolved, and that is REPORTED.
          return undefined
        }
        return undefined
      }
      // The nearest enclosing BLOCK that declares the name as an array.
      if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isFunctionDeclaration(node)) {
        for (const statement of node.statements ?? []) {
          if (!ts.isVariableStatement(statement)) continue
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
            if (declaration.initializer !== undefined && ts.isArrayLiteralExpression(declaration.initializer)) {
              return declaration.initializer.elements
                .filter(element => ts.isStringLiteralLike(element))
                .map(element => element.text)
            }
            // The binding exists but is NOT a static array: the reference
            // cannot be resolved. That is reported, never ignored.
            return undefined
          }
        }
      }
    }
    return undefined
  }

  /**
   * The initializer of the declaration that binds `name` in the enclosing
   * scope of `from`.
   */
  const resolveDeclarationInitializer = (from, name) => {
    for (let node = from; node !== undefined; node = node.parent) {
      if (!ts.isBlock(node) && !ts.isSourceFile(node)) continue
      for (const statement of node.statements ?? []) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
          return declaration.initializer
        }
      }
    }
    return undefined
  }

  /**
   * The BASE of a whole-tree enumeration, when the identifier names a
   * directory-URL that is walked.
   *
   * `const root = new URL('../../src/', import.meta.url)` followed by
   * `srcTsFiles(root)` enumerates EVERY `.ts` file under that directory.
   * The individual reads have no static target, but the directory does — and
   * the directory is what the migration had to keep pointing at.
   */
  const resolveEnumerationBase = (useNode, name) => {
    // The identifier may be the CALLBACK PARAMETER of a chain that walks an
    // enumerated tree: `srcTsFiles(root).filter(rel => new URL(rel, root))`.
    // The base is the `root` ARGUMENT of that call.
    for (let node = useNode; node !== undefined; node = node.parent) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const [first] = node.arguments
        if (first !== undefined && ts.isIdentifier(first)) {
          const base = resolveUrlDeclaration(node, first.text)
          if (base !== undefined) return base
        }
      }
      if (!ts.isBlock(node) && !ts.isSourceFile(node)) continue
      for (const statement of node.statements ?? []) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue
          return resolveUrlDeclaration(declaration, name)
        }
      }
    }
    return undefined
  }

  /** The URL a declaration holds, when it holds one. */
  const resolveUrlDeclaration = (declaration, name) => {
    const initializer = ts.isVariableDeclaration(declaration)
      ? declaration.initializer
      : resolveDeclarationInitializer(declaration, name)
    if (initializer === undefined) return undefined
    if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'URL') {
      const [first] = initializer.arguments
      if (first !== undefined && ts.isStringLiteralLike(first)) return first.text
      if (first !== undefined && ts.isTemplateExpression(first)) return first.head.text
    }
    // A declaration that is not a URL: look for one further up the scope.
    for (let node = declaration.parent; node !== undefined; node = node.parent) {
      if (!ts.isBlock(node) && !ts.isSourceFile(node)) continue
      for (const statement of node.statements ?? []) {
        if (!ts.isVariableStatement(statement)) continue
        for (const candidate of statement.declarationList.declarations) {
          if (!ts.isIdentifier(candidate.name) || candidate.name.text !== name) continue
          const inner = candidate.initializer
          if (inner === undefined) return undefined
          if (ts.isNewExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'URL') {
            const [first] = inner.arguments
            if (first !== undefined && ts.isStringLiteralLike(first)) return first.text
            if (first !== undefined && ts.isTemplateExpression(first)) return first.head.text
          }
          return undefined
        }
      }
    }
    return undefined
  }

  const visit = (node) => {
    // The import clause: `import { x } from '…'`, and the side-effect form.
    if (ts.isImportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier.text)
    }
    // The dynamic import: `import('…')` — including one inside a template
    // literal's interpolation, which the parser sees as executable.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteralLike(argument)) add(argument.text)
      // The TEMPLATE dynamic import: `import(\`../src/app/${name}\`)`. The
      // literal prefix before the interpolation is the part that resolves.
      if (argument !== undefined && ts.isTemplateExpression(argument)) add(argument.head.text)
    }
    // The import TYPE query: `import('…').Type` — a distinct AST form
    // from the dynamic import, and a real reference.
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const literal = node.argument.literal
      if (ts.isStringLiteralLike(literal)) add(literal.text)
    }
    // The CommonJS require: `require('…')`.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const [argument] = node.arguments
      if (argument !== undefined && ts.isStringLiteralLike(argument)) add(argument.text)
    }
    // The source read: `new URL('…', import.meta.url)`.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const [first] = node.arguments
      if (first !== undefined && ts.isStringLiteralLike(first)) add(first.text)
      // The TEMPLATE source read: `new URL(\`../src/${name}\`, …)`. The
      // literal prefix before the interpolation is the part that resolves.
      if (first !== undefined && ts.isTemplateExpression(first)) add(first.head.text)
      // The IDENTIFIER-valued source read: `new URL(file, …)` where `file`
      // names an array of paths. The binding is resolved at THIS use site.
      //
      // A binding that is not a static array may still be a WHOLE-TREE
      // enumeration (`srcTsFiles(root)` returns every `.ts` path under a
      // directory). Such a read has no per-file target to compare, but its
      // BASE is a real reference: the directory it enumerates. The base is
      // resolved here, and the enumeration itself is reported so the caller
      // can state that the per-file comparison does not cover it.
      if (first !== undefined && ts.isIdentifier(first)) {
        const values = resolveIdentifierAt(node, first.text)
        if (values === undefined) {
          // The identifier is not a static array. It may still be a
          // WHOLE-TREE enumeration, whose BASE is the reference the
          // migration had to keep pointing at.
          const base = resolveEnumerationBase(node, first.text)
          if (base !== undefined) {
            add(base)
            enumeratedTrees.add(first.text)
          } else {
            // The BASE argument of the same `new URL` may still name the
            // directory the tree is walked from; it is resolved below. The
            // identifier is only reported as unresolved when no base
            // exists either.
            const baseArgument = node.arguments.length > 1 ? node.arguments[1] : undefined
            const baseName = baseArgument !== undefined && ts.isIdentifier(baseArgument)
              ? baseArgument.text
              : undefined
            if (baseName === undefined) unresolvedIdentifiers.add(first.text)
          }
        } else {
          for (const value of values) add(value)
        }
      }
      // The WHOLE-TREE enumeration: `new URL(<rel>, <root>)` where `<rel>`
      // is a per-file path RELATIVE to a directory URL. The BASE argument is
      // the directory the tree is walked from, and it is the reference the
      // migration had to keep pointing at.
      if (node.arguments.length > 1) {
        const [, second] = node.arguments
        if (second !== undefined && ts.isIdentifier(second)) {
          const base = resolveDeclarationInitializer(node, second.text)
          if (base !== undefined && ts.isNewExpression(base) && ts.isIdentifier(base.expression) && base.expression.text === 'URL') {
            const [baseFirst] = base.arguments
            if (baseFirst !== undefined && ts.isStringLiteralLike(baseFirst)) {
              add(baseFirst.text)
              enumeratedTrees.add(second.text)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  // The identifiers whose value could not be resolved statically, and the
  // ones that name a WHOLE-TREE enumeration (whose per-file reads are not
  // comparable, but whose BASE is).
  const unresolvedIdentifiers = new Set()
  const enumeratedTrees = new Set()
  visit(file)
  for (const name of unresolvedIdentifiers) refs.push(`<unresolved:${name}>`)
  // The same target can be reached twice (a directory base that is also an
  // enumeration base); the comparison is over SETS, so a duplicate carries
  // no information.
  return [...new Set(refs)]
}

/**
 * How many production references the source mentions, counted WITHOUT
 * knowing the forms.
 *
 * The comparison with {@link productionReferences} is the coverage proof: a
 * form the extractor does not recognise makes the two counts differ, and
 * the caller reports it instead of reporting a false assurance.
 */
export function productionReferenceCount(source) {
  let count = 0
  for (const match of source.matchAll(/(?:new URL\(\s*|^\s*import\s+|\bfrom\s+|\bimport\s*\(\s*)['"`](\.\.\/[^'"`$]*)/gmu)) {
    count += 1
    void match
  }
  return count
}

/**
 * The references the TEXT scan finds that the parser does not.
 *
 * Every one of them must be a reference inside a plain string literal (a
 * source-lock assertion or a test fixture) — the parser ignores those on
 * purpose, and the text scan cannot tell them apart from a real reference.
 * A difference that is NOT inside a string literal is a form the extractor
 * missed, and the caller reports it.
 */
export function unexplainedTextReferences(source) {
  const parsed = productionReferences(source)
  const text = []
  for (const match of source.matchAll(/(?:new URL\(\s*|^\s*import\s+|\bfrom\s+|\bimport\s*\(\s*)['"`](\.\.\/[^'"`$]*)/gmu)) {
    if (isInsideStringLiteral(source, match.index)) continue
    // The comparison strips the QUERY string, exactly as the extractor does.
    const specifier = match[1].split('?')[0]
    if (!parsed.includes(specifier)) text.push(specifier)
  }
  return text
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

/**
 * The base tree's version of a file, or `undefined`.
 *
 * The base tree's file may be at the FLAT root (`test/<name>.test.ts`) or
 * already in a subdirectory, so the base lookup tries the current path
 * first and then the flat basename.
 */
function baseSource(rel) {
  const base = process.argv[2]
  const candidates = [rel, rel.split('/').pop()]
  for (const candidate of candidates) {
    try {
      return execFileSync('git', ['show', `${base}:test/${candidate}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

function main() {
  const base = process.argv[2]
  if (base === undefined) {
    console.error('usage: node scripts/verify-migration-semantics.mjs <base-sha>')
    process.exit(2)
  }
  const files = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  let compared = 0
  let changed = 0
  const problems = []
  // The COVERAGE proof: a reference form the extractor does not recognise
  // would make the check report a false assurance. The extractor's count is
  // compared against an independent, form-agnostic count; a difference is
  // REPORTED, not silently accepted.
  const uncovered = []

  for (const rel of files) {
    const source = readFileSync(resolve(TEST_ROOT, rel), 'utf8')
    const before = baseSource(rel)
    if (before === undefined) continue
    const beforeRefs = productionReferences(before)
    const afterRefs = productionReferences(source)
    // The coverage check runs BEFORE the zero-reference skip: a file whose
    // ONLY reference uses an unrecognised form must still be reported.
    const unexplained = unexplainedTextReferences(source)
    if (unexplained.length > 0) {
      uncovered.push(`${rel}: ${unexplained.length} reference(s) the extractor did not recognise: ${unexplained.join(', ')}`)
    }
    // A reference whose BINDING could not be resolved statically (the path
    // is built at runtime) cannot be compared. It is REPORTED, never
    // silently ignored: the check must not claim to cover it.
    const unresolved = afterRefs.filter(ref => ref.startsWith('<unresolved:'))
    if (unresolved.length > 0) {
      uncovered.push(`${rel}: ${unresolved.length} reference(s) could not be resolved statically: ${unresolved.join(', ')}`)
    }
    if (beforeRefs.length === 0) continue
    compared += 1

    // The RESOLVED target of every reference, as a path relative to the
    // repository root. The base and the current tree must resolve to the
    // SAME production file.
    //
    // The BASE file lives at the FLAT root, so its references resolve
    // against `test/`, while the current file resolves against its own
    // directory. Each side is resolved against ITS OWN location — that is
    // exactly what the migration had to preserve.
    const baseRel = rel.split('/').pop()
    const resolveAll = (text, fileRel) => productionReferences(text)
      .map(spec => relative(ROOT, resolve(dirname(resolve(TEST_ROOT, fileRel)), spec)))
      .filter(path => path.startsWith('src/') || path.startsWith('packages/'))
      .sort()
    const beforeTargets = resolveAll(before, baseRel)
    const afterTargets = resolveAll(source, rel)
    if (JSON.stringify(beforeTargets) === JSON.stringify(afterTargets)) continue
    changed += 1
    const removed = beforeTargets.filter(target => !afterTargets.includes(target))
    const added = afterTargets.filter(target => !beforeTargets.includes(target))
    if (removed.length === 0 && added.length === 0) continue
    problems.push({ rel, removed, added })
  }

  console.log(`test files with production references compared: ${compared}`)
  console.log(`files whose resolved production targets CHANGED: ${changed}`)
  console.log(`files with a reference form the extractor did NOT recognise: ${uncovered.length}`)
  for (const entry of uncovered) console.log(`  ${entry}`)
  if (problems.length === 0) {
    console.log('\nno test now reads a DIFFERENT production file than before the move')
  } else {
    console.log('')
    for (const problem of problems) {
      console.log(`${problem.rel}`)
      for (const target of problem.removed) console.log(`  - ${target}`)
      for (const target of problem.added) console.log(`  + ${target}`)
    }
  }
  if (problems.length > 0 || uncovered.length > 0) process.exitCode = 1
}

// The module is importable: the extractor is proved by
// `test/tooling/migration-semantics.test.mjs`, which imports it directly.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
