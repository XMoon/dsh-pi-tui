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

  // The BINDING-AWARE resolution.
  //
  // A `new URL(<identifier>, import.meta.url)` resolves through the
  // identifier's DECLARATION — and the declaration that matters is the one
  // the USE SITE is bound to, not the one with the same NAME somewhere
  // else. The TypeScript checker resolves that exactly: it follows the
  // scope chain, so a function PARAMETER that shadows an outer array is
  // resolved to the parameter.
  const checker = createTypeChecker(file)
  const declarationOf = (identifier) => {
    if (checker === undefined) return undefined
    const symbol = checker.getSymbolAtLocation(identifier)
    if (symbol === undefined) return undefined
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0]
    return declaration
  }

  /**
   * The directory URL a `new URL(<rel>, <root>)` call's second argument
   * names — the shape of a whole-tree enumeration.
   */
  const enumerationBaseArgument = (node) => {
    if (node.arguments.length < 2) return undefined
    const [, second] = node.arguments
    if (second === undefined || !ts.isIdentifier(second)) return undefined
    return urlValueOf(declarationOf(second))
  }

  /** The static string values a declaration initializes, when it has them. */
  const stringValuesOf = (declaration) => {
    if (declaration === undefined) return undefined
    if (!ts.isVariableDeclaration(declaration)) return undefined
    // A `for…of` LOOP VARIABLE is bound to the ITERABLE, not to an
    // initializer: `for (const file of ['../src/a.ts'])`. The declaration
    // has no initializer, so the iterable is read from the enclosing
    // `for…of` statement.
    if (declaration.initializer === undefined) {
      const owner = declaration.parent?.parent
      if (owner !== undefined && ts.isForOfStatement(owner) && owner.initializer === declaration.parent) {
        const expression = owner.expression
        if (ts.isArrayLiteralExpression(expression)) {
          const values = []
          let partial = false
          for (const element of expression.elements) {
            if (ts.isStringLiteralLike(element)) {
              values.push(element.text)
              continue
            }
            partial = true
          }
          return { values, partial }
        }
        if (ts.isIdentifier(expression)) {
          // The iterable is a NAMED array declared in the enclosing scope.
          const named = declarationOf(expression)
          const resolved = named === undefined ? undefined : stringValuesOf(named)
          if (resolved !== undefined) return resolved
        }
        return undefined
      }
      return undefined
    }
    const initializer = declaration.initializer
    if (ts.isArrayLiteralExpression(initializer)) {
      // A SPREAD or a computed element makes the array's value only
      // PARTIALLY known: the static subset is reported AND the array is
      // marked unresolved, so the caller never claims full coverage.
      const values = []
      let partial = false
      for (const element of initializer.elements) {
        if (ts.isStringLiteralLike(element)) {
          values.push(element.text)
          continue
        }
        if (ts.isSpreadElement(element)) {
          partial = true
          continue
        }
        partial = true
      }
      return partial ? { values, partial } : { values, partial: false }
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
    // The PATH JOIN READ: `readFileSync(join(root, 'src', 'app', …))`.
    // The segments are literal, so the path is known — but only a JOIN that
    // READS a production file counts: a join that WRITES a fixture
    // (`join(workspace, 'src', 'deep')`) creates a temporary tree, and its
    // paths are not the repository's production modules.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'join') {
      const segments = node.arguments
        .filter(argument => ts.isStringLiteralLike(argument))
        .map(argument => argument.text)
      if (segments.length > 0 && segments[0] === 'src' && isReadOf(node)) {
        // The path is relative to the join's BASE, which the test
        // computes for itself: `join(dirname(fileURLToPath(import.meta.url)),
        // '..', '..')` is the REPOSITORY root from a test in a
        // subdirectory, and the test root from the flat root. The base is
        // resolved so the two trees are compared on the TARGET, not on the
        // spelling of the base.
        const base = joinBaseOf(node, declarationOf)
        const relative = base === undefined
          ? `../${segments.join('/')}`
          : `${base}/${segments.join('/')}`
        add(relative)
      }
    }
    // The source read: `new URL('…', import.meta.url)`.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const [first] = node.arguments
      if (first !== undefined && ts.isStringLiteralLike(first)) add(first.text)
      // The TEMPLATE source read: `new URL(\`../src/${name}\`, …)`. The
      // literal prefix before the interpolation is the part that resolves.
      if (first !== undefined && ts.isTemplateExpression(first)) add(first.head.text)
      // The IDENTIFIER-valued source read: `new URL(file, …)` where `file`
      // names an array of paths. The binding is the one the USE SITE is
      // bound to.
      if (first !== undefined && ts.isIdentifier(first)) {
        const resolved = stringValuesOf(declarationOf(first))
        if (resolved !== undefined) {
          for (const value of resolved.values) add(value)
          // A PARTIAL resolution (a spread or a computed element) means
          // the array's full value is unknown: the static subset is
          // reported AND the reference is marked unresolved, so the caller
          // never claims full coverage.
          if (resolved.partial) unresolvedIdentifiers.add(first.text)
        } else {
          // The binding is not a static array. It may still be a WHOLE-TREE
          // enumeration, whose BASE argument is the reference the migration
          // had to keep pointing at. The base is resolved FIRST: when it
          // exists, the per-file reads are covered by the directory they
          // are walked from, and the identifier is not unresolved.
          // The read has a directory BASE: it is either part of a
          // whole-tree enumeration (the directory is walked) or a runtime
          // per-file read under that directory. In BOTH cases the
          // directory is the reference the migration had to keep pointing
          // at.
          const enumerationBaseValue = enumerationBase(node, declarationOf)
          const base = enumerationBaseValue ?? enumerationBaseArgument(node)
          if (enumerationBaseValue !== undefined) {
            // The read is PART of a whole-tree enumeration: the directory
            // it walks is the reference, and the per-file reads are covered
            // by it.
            add(base)
            enumeratedTrees.add(first.text)
          } else if (base !== undefined) {
            // The read has a directory BASE but is not part of an
            // enumeration: the base is the reference, and the per-file
            // value is runtime — REPORTED, never silently ignored.
            add(base)
            unresolvedIdentifiers.add(first.text)
          } else if (enumerationBaseArgument(node) !== undefined) {
            // The read has a directory BASE but is not part of an
            // enumeration: the base is the reference, and the per-file
            // value is runtime — REPORTED, never silently ignored.
            const baseValue = enumerationBaseArgument(node)
            if (baseValue !== undefined) add(baseValue)
            unresolvedIdentifiers.add(first.text)
          } else {
            unresolvedIdentifiers.add(first.text)
          }
        }
      }
      // The WHOLE-TREE enumeration's BASE: `new URL(<rel>, <root>)` where
      // `<root>` is a directory URL. The individual reads have no static
      // target, but the directory does.
      if (node.arguments.length > 1) {
        const [, second] = node.arguments
        if (second !== undefined && ts.isIdentifier(second)) {
          const base = urlValueOf(declarationOf(second))
          if (base !== undefined) {
            add(base)
            enumeratedTrees.add(second.text)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  // The identifiers whose value could not be resolved statically, the ones
  // whose value is only PARTIALLY known, and the ones that name a WHOLE-TREE
  // enumeration (whose per-file reads are not comparable, but whose BASE
  // is).
  const unresolvedIdentifiers = new Set()
  const resolvedIdentifiers = new Set()
  const enumeratedTrees = new Set()
  visit(file)
  for (const name of unresolvedIdentifiers) refs.push(`<unresolved:${name}>`)
  for (const name of resolvedIdentifiers) refs.push(`<partial:${name}>`)
  // The same target can be reached twice (a directory base that is also an
  // enumeration base); the comparison is over SETS, so a duplicate carries
  // no information.
  return [...new Set(refs)]
}

/** The URL a declaration holds, when it holds one. */
function urlValueOf(declaration) {
  if (declaration === undefined) return undefined
  const initializer = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined
  if (initializer === undefined) return undefined
  if (!ts.isNewExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'URL') {
    return undefined
  }
  const [first] = initializer.arguments
  if (first !== undefined && ts.isStringLiteralLike(first)) return first.text
  if (first !== undefined && ts.isTemplateExpression(first)) return first.head.text
  return undefined
}

/**
 * The path a `join(base, …)` resolves to, RELATIVE to the test root.
 *
 * The base is a `join(dirname(fileURLToPath(import.meta.url)), '..', '..')`
 * — a path relative to the FILE. The result is expressed relative to the
 * test root, so the flat base tree and the layered current tree resolve the
 * SAME production file and the comparison is about the target.
 */
function joinBaseOf(node, declarationOf) {
  for (let current = node; current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue
    if (!ts.isIdentifier(current.expression) || current.expression.text !== 'join') continue
    const [first] = current.arguments
    if (first === undefined || !ts.isIdentifier(first)) continue
    // The base argument must be a `dirname(fileURLToPath(import.meta.url))`
    // handle — the file's own directory.
    const declaration = declarationOf(first)
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) continue
    const initializer = declaration.initializer
    if (initializer === undefined) continue
    if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'join') {
      continue
    }
    const [directory] = initializer.arguments
    if (directory === undefined) continue
    const up = initializer.arguments
      .slice(1)
      .filter(argument => ts.isStringLiteralLike(argument))
      .map(argument => argument.text)
    if (!up.every(segment => segment === '..')) continue
    // `up` levels above the file's own directory.
    return up.map(() => '..').join('/')
  }
  return undefined
}

/**
 * Whether a `join(...)` call is the argument of a READ.
 *
 * A `join` that writes (`writeFileSync(join(…), …)`) or that creates a
 * directory (`mkdirSync(join(…), …)`) builds a FIXTURE, not a production
 * reference. Only a join that is READ names a production module.
 */
function isReadOf(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression
      if (ts.isIdentifier(callee)) {
        return /^(readFileSync|readFile|existsSync|statSync|lstatSync|realpathSync|access|openSync)$/u.test(callee.text)
      }
    }
    // A join that is the RECEIVER of a write call is a fixture path too.
    if (ts.isPropertyAccessExpression(current) && current.expression === node) {
      const owner = current.parent
      if (owner !== undefined && ts.isCallExpression(owner) && ts.isIdentifier(owner.expression)) {
        return /^(readFileSync|readFile|existsSync|statSync|lstatSync|realpathSync|access|openSync)$/u.test(owner.expression.text)
      }
    }
  }
  return false
}

/**
 * The BASE of a whole-tree enumeration that reads `new URL(<rel>, <root>)`
 * where `<root>` is a directory URL.
 */
function enumerationBase(node, declarationOf) {
  for (let current = node; current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue
    // The enumeration's own call: `srcTsFiles(root)`. In a CHAIN
    // (`srcTsFiles(root).filter(…)`) it is the RECEIVER of the property
    // access, not an argument of the outer call.
    const callee = current.expression
    const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : undefined
    const candidates = receiver === undefined
      ? current.arguments
      : (ts.isCallExpression(receiver) ? receiver.arguments : [])
    for (const candidate of candidates) {
      if (!ts.isIdentifier(candidate)) continue
      const base = urlValueOf(declarationOf(candidate))
      if (base !== undefined) return base
    }
    // The enumeration call may be the RECEIVER of a CALL chain:
    // `srcTsFiles(root).filter(…).filter(…)`. The receiver of the OUTER
    // call is then another call, whose arguments carry the base.
    if (receiver !== undefined && ts.isCallExpression(receiver)) {
      const inner = receiver.expression
      const innerReceiver = ts.isPropertyAccessExpression(inner) ? inner.expression : undefined
      const innerCandidates = innerReceiver === undefined
        ? receiver.arguments
        : (ts.isCallExpression(innerReceiver) ? innerReceiver.arguments : [])
      for (const candidate of innerCandidates) {
        if (!ts.isIdentifier(candidate)) continue
        const base = urlValueOf(declarationOf(candidate))
        if (base !== undefined) return base
      }
    }
  }
  return undefined
}

/**
 * A type checker over one synthetic file.
 *
 * The checker is what makes the resolution BINDING-AWARE: it follows the
 * scope chain, so a shadowing declaration is resolved to the right one.
 */
function createTypeChecker(file) {
  try {
    const host = {
      getSourceFile: (name) => (name === file.fileName ? file : undefined),
      writeFile: () => {},
      getDefaultLibFileName: () => 'lib.d.ts',
      useCaseSensitiveFileNames: () => true,
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => '',
      getNewLine: () => '\n',
      fileExists: (name) => name === file.fileName,
      readFile: (name) => (name === file.fileName ? file.text : undefined),
      getDirectories: () => [],
    }
    const program = ts.createProgram([file.fileName], { noResolve: true, noLib: true }, host)
    return program.getTypeChecker()
  } catch {
    return undefined
  }
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
