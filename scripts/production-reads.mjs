#!/usr/bin/env node
/**
 * The production-read RESOLVER: which production files does a test file
 * actually read?
 *
 * The resolver is SYNTAX-AWARE. A regex cannot tell an executable
 * `import('../src/x.ts')` from the same text inside a template literal's
 * TEXT — and a template literal's `${…}` INTERPOLATION is executable code,
 * not text. The TypeScript parser can: it reports the actual module
 * specifiers and ignores a string that merely CONTAINS an import.
 *
 * The resolution is BINDING-AWARE too: the type checker resolves an
 * identifier to the DECLARATION the use site is bound to, so a function
 * PARAMETER that shadows an outer array resolves to the parameter.
 *
 * A reference that cannot be resolved statically is REPORTED as
 * `<unresolved:name>`, never silently ignored.
 *
 * The two consumers:
 *   - `scripts/check-production-reads.mjs` — the permanent guard: every
 *     production file a test reads must EXIST, so a moved or renamed
 *     production module can never leave a test reading a DIFFERENT file
 *     without the test failing;
 *   - the migration analysis, which compares two trees' reads.
 *
 * @module @xmoon76/dsh-pi-tui/scripts/production-reads
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/**
 * The production AREAS a read may name.
 */
const PRODUCTION_AREAS = ['src', 'packages']

/**
 * The file-relative production references a test file makes.
 *
 * `fileDepth` is how many directory levels the file sits below the test
 * root (the flat root: 0; `test/tui/foo.test.ts`: 1). It is needed to
 * verify that a read's base really reaches the REPOSITORY root.
 */
export function productionReferences(source, fileDepth = 0) {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
  const refs = []
  const add = (specifier) => {
    if (typeof specifier !== 'string') return
    // A `<root>`-marked specifier is ALREADY relative to the test root (the
    // join resolver knows the base it resolved); every other specifier is
    // relative to the file and is resolved later.
    const isRootRelative = specifier.startsWith('<root>')
    if (!isRootRelative && !specifier.startsWith('../')) return
    // A specifier may carry a QUERY string (`x.mjs?process-test=1`): the
    // query is not part of the path, so it is stripped before the
    // comparison.
    refs.push(specifier.split('?')[0])
  }

  const checker = createTypeChecker(file)
  const declarationOf = (identifier) => {
    if (checker === undefined) return undefined
    const symbol = checker.getSymbolAtLocation(identifier)
    if (symbol === undefined) return undefined
    return symbol.valueDeclaration ?? symbol.declarations?.[0]
  }

  // The LOCAL READ HELPERS: a function whose body joins a base with one of
  // its OWN parameters.
  //
  //     const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
  //     read('src/app/surface/runtime.ts')
  //
  // The join's argument is a PARAMETER, so the path is only known at the
  // CALL SITE. The helper's name and its parameter positions are collected
  // here, and the call sites are resolved below.
  const readHelpers = new Map()
  const collectHelpers = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = node.initializer
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        const parameters = initializer.parameters
          .filter(parameter => ts.isIdentifier(parameter.name))
          .map(parameter => parameter.name.text)
        if (parameters.length > 0) {
          const scan = (inner) => {
            if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'join') {
              for (const [index, argument] of inner.arguments.entries()) {
                if (!ts.isIdentifier(argument)) continue
                const position = parameters.indexOf(argument.text)
                if (position === -1) continue
                const base = inner.arguments.slice(0, index)
                if (base.length === 0) continue
                readHelpers.set(node.name.text, {
                  parameters,
                  position,
                  base,
                  baseSegments: joinBaseSegments(inner, declarationOf),
                  // The base reaches the REPOSITORY root only when its `..`
                  // levels match the file's own depth below the test root.
                  // A base with one level too few resolves into the test
                  // tree, and every call site would then read a path that
                  // does not exist.
                  baseIsRepositoryRoot: isRepositoryRootBase(inner, declarationOf, fileDepth),
                })
              }
            }
            ts.forEachChild(inner, scan)
          }
          scan(initializer)
        }
      }
    }
    ts.forEachChild(node, collectHelpers)
  }
  collectHelpers(file)

  // The identifiers whose value could not be resolved statically, the ones
  // whose value is only PARTIALLY known, and the ones that name a WHOLE-TREE
  // enumeration (whose per-file reads are not comparable, but whose BASE
  // is).
  const unresolvedIdentifiers = new Set()
  const resolvedIdentifiers = new Set()
  const enumeratedTrees = new Set()

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
    // A LOCAL READ HELPER's call site: `read('src/app/…')`. The path is
    // known only here, at the call, so it is resolved from the argument
    // that fills the helper's join parameter.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = readHelpers.get(node.expression.text)
      if (helper !== undefined) {
        const argument = node.arguments[helper.position]
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          // The argument is the path under the base. The base MUST be
          // verified as the REPOSITORY root: only then does the argument
          // name a production file. An unverified base is reported as
          // unresolved — a wrong `..` level in the helper's base would
          // otherwise make every call site resolve to the SAME (wrong)
          // path, and the comparison would pass.
          const segments = helper.baseSegments
          const path = argument.text
          const area = path.split('/').find(segment => PRODUCTION_AREAS.includes(segment))
          if (helper.baseIsRepositoryRoot !== true) {
            // The base does NOT reach the repository root. If it
            // statically names a NON-production directory (the generated
            // preset patches, a fixture tree), the read is not a production
            // read at all and is EXCLUDED. The base is UNKNOWN, or it
            // could still name a production file: REPORTED.
            const baseNamesNonProductionDirectory = segments !== undefined
              && segments.length > 0
              && segments.some(segment => segment === 'generated' || segment === 'fixtures')
            const baseIsUnknown = segments === undefined
            if (!baseNamesNonProductionDirectory && (baseIsUnknown || helper.baseIsRepositoryRoot !== true)) {
              unresolvedIdentifiers.add(node.expression.text)
            }
          } else if (area === undefined) {
            // The argument does not name a production area: the base
            // decides whether the read reaches the repository's sources.
            if (segments.includes('src') || segments.includes('packages')) {
              add(`<root>${path}`)
            } else {
              unresolvedIdentifiers.add(node.expression.text)
            }
          } else {
            add(`<root>${path.split('/').slice(path.split('/').indexOf(area)).join('/')}`)
          }
        }
      }
    }
    // The PATH JOIN READ: `readFileSync(join(root, 'src', 'app', …))`.
    //
    // The path is resolved RECURSIVELY: the join's base may itself be a
    // join, or a NAMED path variable
    // (`const srcDir = join(…, 'src'); readFileSync(join(srcDir, 'index.ts'))`),
    // and the segments may name a production area other than `src`
    // (`join(ROOT, 'packages', 'pi-tui', …)`).
    //
    // Only a join that READS a production file counts: a join that WRITES
    // a fixture (`join(workspace, 'src', 'deep')`) creates a temporary
    // tree, and its paths are not the repository's production modules.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'join') {
      const resolved = resolveJoinPath(node, declarationOf)
      if (resolved !== undefined && PRODUCTION_AREAS.includes(resolved.area) && isReadOf(node)) {
        // The path is expressed relative to the PRODUCTION AREA, so a flat
        // tree and a layered tree are compared on the production file
        // rather than on the spelling of the base. The `<root>` marker
        // says the specifier is already test-root relative and must not be
        // resolved again.
        add(`<root>${resolved.segments.join('/')}`)
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
          // enumeration, whose BASE argument is the reference the
          // migration had to keep pointing at.
          const base = enumerationBase(node, declarationOf)
          if (base !== undefined) {
            add(base)
            enumeratedTrees.add(first.text)
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
  visit(file)
  for (const name of unresolvedIdentifiers) refs.push(`<unresolved:${name}>`)
  for (const name of resolvedIdentifiers) refs.push(`<partial:${name}>`)
  // The same target can be reached twice (a directory base that is also an
  // enumeration base); the comparison is over SETS, so a duplicate carries
  // no information.
  return [...new Set(refs)]
}

/**
 * The static string values a declaration initializes, when it has them.
 */
function stringValuesOf(declaration) {
  if (declaration === undefined) return undefined
  if (!ts.isVariableDeclaration(declaration)) return undefined
  // A `for…of` LOOP VARIABLE is bound to the ITERABLE, not to an
  // initializer: `for (const file of ['../src/a.ts'])`. The declaration has
  // no initializer, so the iterable is read from the enclosing `for…of`
  // statement.
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
      partial = true
    }
    return { values, partial }
  }
  return undefined
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
 * The path a `join(...)` call resolves to, RELATIVE TO THE TEST ROOT.
 */
function resolveJoinPath(node, declarationOf, depth = 0) {
  if (depth > 8) return undefined
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'join') {
    return undefined
  }
  const [first, ...rest] = node.arguments
  if (first === undefined) return undefined
  // The base is the FILE'S OWN DIRECTORY: `join(dirname(fileURLToPath(
  // import.meta.url)), '..', '..', 'src')` or `join(import.meta.dirname, …)`.
  if (ts.isCallExpression(first) && ts.isIdentifier(first.expression) && first.expression.text === 'dirname') {
    const segments = rest
      .filter(argument => ts.isStringLiteralLike(argument))
      .map(argument => argument.text)
    const area = segments.find(segment => PRODUCTION_AREAS.includes(segment))
    if (area === undefined) return undefined
    const index = segments.indexOf(area)
    return { area, segments: segments.slice(index), prefix: segments.slice(0, index), known: true }
  }
  if (ts.isPropertyAccessExpression(first) && first.expression.kind === ts.SyntaxKind.MetaProperty) {
    const segments = rest
      .filter(argument => ts.isStringLiteralLike(argument))
      .map(argument => argument.text)
    const area = segments.find(segment => PRODUCTION_AREAS.includes(segment))
    if (area === undefined) return undefined
    const index = segments.indexOf(area)
    return { area, segments: segments.slice(index), prefix: segments.slice(0, index), known: true }
  }
  // The base: a nested join, or a named path variable.
  let base
  if (ts.isCallExpression(first)) {
    base = resolveJoinPath(first, declarationOf, depth + 1)
  } else if (ts.isIdentifier(first)) {
    const declaration = declarationOf(first)
    if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const initializer = declaration.initializer
      if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'join') {
        base = resolveJoinPath(initializer, declarationOf, depth + 1)
      }
    }
    // A base that is NOT statically resolvable (a module-level constant
    // like `ROOT`) still leaves the SEGMENTS meaningful: the segments
    // after it name the production area.
  }

  const segments = rest
    .filter(argument => ts.isStringLiteralLike(argument))
    .map(argument => argument.text)
  if (base === undefined && segments.length === 0) return undefined

  const fileBase = fileDirectoryBase(node, declarationOf)
  const fileSegments = fileDirectorySegments(node, declarationOf)
  const prefix = fileBase === undefined ? (base?.prefix ?? []) : fileBase
  const own = base === undefined ? fileSegments : base.segments
  const all = [...prefix, ...own, ...segments]
  const area = all.find(segment => PRODUCTION_AREAS.includes(segment))
  if (area === undefined) return undefined
  const index = all.indexOf(area)
  return { area, segments: all.slice(index), prefix: all.slice(0, index), known: base !== undefined }
}

/**
 * The `..` levels a `join(dirname(fileURLToPath(import.meta.url)), …)` base
 * climbs out of the test root.
 */
function fileDirectoryBase(node, declarationOf) {
  for (let current = node; current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue
    if (!ts.isIdentifier(current.expression) || current.expression.text !== 'join') continue
    const [first] = current.arguments
    if (first === undefined || !ts.isIdentifier(first)) continue
    const declaration = declarationOf(first)
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) continue
    const initializer = declaration.initializer
    if (initializer === undefined || !ts.isCallExpression(initializer)) continue
    if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'join') continue
    const segments = initializer.arguments
      .slice(1)
      .filter(argument => ts.isStringLiteralLike(argument))
      .map(argument => argument.text)
    const up = segments.filter(segment => segment === '..')
    if (up.length !== segments.length) continue
    return segments.map(() => '..')
  }
  return undefined
}

/**
 * The literal segments a `join(dirname(fileURLToPath(import.meta.url)), …)`
 * base names, beyond the `..` levels.
 */
function fileDirectorySegments(node, declarationOf) {
  for (let current = node; current !== undefined; current = current.parent) {
    if (!ts.isCallExpression(current)) continue
    if (!ts.isIdentifier(current.expression) || current.expression.text !== 'join') continue
    const [first] = current.arguments
    if (first === undefined || !ts.isIdentifier(first)) continue
    const declaration = declarationOf(first)
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) continue
    const initializer = declaration.initializer
    if (initializer === undefined || !ts.isCallExpression(initializer)) continue
    if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== 'join') continue
    const segments = initializer.arguments
      .slice(1)
      .filter(argument => ts.isStringLiteralLike(argument))
      .map(argument => argument.text)
    if (segments.every(segment => segment === '..')) continue
    return segments.filter(segment => segment !== '..')
  }
  return []
}

/**
 * The segments a join's BASE resolves to, when it can be verified as the
 * REPOSITORY root.
 */
function joinBaseSegments(node, declarationOf, depth = 0) {
  if (depth > 8) return undefined
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'join') {
    return undefined
  }
  const [first, ...rest] = node.arguments
  if (first === undefined) return undefined
  // The base is the file's own directory: `dirname(fileURLToPath(
  // import.meta.url))` or `import.meta.dirname`.
  const isFileDirectory = (ts.isCallExpression(first) && ts.isIdentifier(first.expression) && first.expression.text === 'dirname')
    || (ts.isPropertyAccessExpression(first) && first.expression.kind === ts.SyntaxKind.MetaProperty)
  if (isFileDirectory) {
    return rest
      .filter(argument => ts.isStringLiteralLike(argument))
      .map(argument => argument.text)
  }
  // The base is a named handle: `ROOT`. The handle's OWN resolution decides
  // the base, so the recursion continues there.
  if (ts.isIdentifier(first)) {
    const declaration = declarationOf(first)
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined
    const initializer = declaration.initializer
    if (initializer === undefined) return undefined
    if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'join') {
      return joinBaseSegments(initializer, declarationOf, depth + 1)
    }
  }
  return undefined
}

/**
 * Whether a join's base reaches the REPOSITORY root.
 */
function isRepositoryRootBase(node, declarationOf, fileDepth, depth = 0) {
  if (depth > 8) return false
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'join') {
    return false
  }
  const [first, ...rest] = node.arguments
  if (first === undefined) return false
  const segments = rest
    .filter(argument => ts.isStringLiteralLike(argument))
    .map(argument => argument.text)
  const up = segments.filter(segment => segment === '..').length
  const down = segments.filter(segment => segment !== '..')
  const isFileDirectory = (ts.isCallExpression(first) && ts.isIdentifier(first.expression) && first.expression.text === 'dirname')
    || (ts.isPropertyAccessExpression(first) && first.expression.kind === ts.SyntaxKind.MetaProperty)
  if (isFileDirectory) {
    // The file's own directory, climbed `up` levels. The file is `fileDepth`
    // levels below the test root, and the repository root is one level above
    // the test root.
    return up === fileDepth + 1 && down.length === 0
  }
  if (ts.isIdentifier(first)) {
    const declaration = declarationOf(first)
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return false
    const initializer = declaration.initializer
    if (initializer === undefined) return false
    if (ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === 'join') {
      return isRepositoryRootBase(initializer, declarationOf, fileDepth, depth + 1)
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
 * Whether a `join(...)` call is the argument of a READ.
 *
 * A `join` that writes (`writeFileSync(join(…), …)`) or that creates a
 * directory (`mkdirSync(join(…), …)`) builds a FIXTURE, not a production
 * reference. Only a join that is READ names a production module.
 */
function isReadOf(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    // The join is an ARGUMENT of a call: `readFileSync(join(…), …)`.
    if (ts.isCallExpression(current) && current.arguments.includes(node)) {
      const callee = current.expression
      if (ts.isIdentifier(callee)) {
        return READ_FUNCTIONS.test(callee.text)
      }
    }
    // The join is the RECEIVER of a call: `join(…).toString()`.
    if (ts.isPropertyAccessExpression(current) && current.expression === node) {
      const owner = current.parent
      if (owner !== undefined && ts.isCallExpression(owner) && ts.isIdentifier(owner.expression)) {
        return READ_FUNCTIONS.test(owner.expression.text)
      }
    }
    // The join is an element of an ARRAY that is read:
    // `readFileSync([join(a), join(b)].map(…))` — the array is the argument
    // of the read.
    if (ts.isArrayLiteralExpression(current) && current.elements.includes(node)) {
      const owner = current.parent
      if (owner !== undefined && ts.isCallExpression(owner) && owner.arguments.includes(current)) {
        const callee = owner.expression
        if (ts.isIdentifier(callee) && READ_FUNCTIONS.test(callee.text)) return true
        // `readFileSync(join(…).map(…))` — the array is the RECEIVER.
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
          const inner = owner.arguments[0]
          if (inner !== undefined && ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
            return READ_FUNCTIONS.test(inner.expression.text)
          }
        }
      }
    }
  }
  return false
}

/** The functions whose argument is a path the code READS. */
const READ_FUNCTIONS = /^(readFileSync|readFile|existsSync|statSync|lstatSync|realpathSync|access|openSync)$/u

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
 * The production files a test file reads, as paths relative to the
 * REPOSITORY root, plus the references that could not be resolved.
 *
 * A file-relative specifier (`../src/x.ts`) is resolved against the
 * FILE's own directory; a `<root>`-marked one is already relative to the
 * test root.
 */
export function productionReads(source, fileDepth = 0) {
  const refs = productionReferences(source, fileDepth)
  const paths = []
  const unresolved = []
  for (const ref of refs) {
    if (ref.startsWith('<unresolved:')) {
      unresolved.push(ref.slice('<unresolved:'.length, -1))
      continue
    }
    if (ref.startsWith('<root>')) {
      paths.push(ref.slice('<root>'.length))
      continue
    }
    if (ref.startsWith('../')) {
      // The file-relative specifier: climbing out of the file's own
      // directory, then into the repository. The file sits `fileDepth`
      // levels below the test root, so the `..` segments climb past it.
      const up = ref.split('/').filter(segment => segment === '..').length
      const rest = ref.split('/').filter(segment => segment !== '..')
      const climb = up - fileDepth - 1
      if (climb < 0) continue
      paths.push([...Array(climb).fill('..'), ...rest].join('/'))
    }
  }
  return { paths: [...new Set(paths)].sort(), unresolved: [...new Set(unresolved)].sort() }
}
