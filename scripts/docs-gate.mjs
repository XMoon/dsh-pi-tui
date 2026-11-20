#!/usr/bin/env node
/**
 * Guard the one owning documentation index and repository-local Markdown paths.
 *
 * This checks discoverability and basic link existence, not product semantics,
 * external URLs, GitHub heading slugs or one-off source-path claims. Those
 * still require an author/reviewer to inspect the actual owning contract.
 * @module docs-gate
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function markdownFiles(root) {
  const docs = join(root, 'docs')
  const found = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(relative(docs, file).replaceAll(sep, '/'))
    }
  }
  visit(docs)
  return found.sort()
}

/** Ignore balanced, same-length Markdown backtick spans on a link-scanned line. */
function withoutInlineCode(line) {
  const runs = [...line.matchAll(/`+/gu)]
  let visible = ''
  let from = 0
  for (let i = 0; i < runs.length; i++) {
    const opener = runs[i]
    const closer = runs.findIndex((run, j) => j > i && run[0].length === opener[0].length)
    if (closer < 0) continue
    visible += line.slice(from, opener.index)
    from = runs[closer].index + runs[closer][0].length
    i = closer
  }
  return visible + line.slice(from)
}

/** Check exactly one index row per document and existing repository-local links. */
export function checkDocsTree(root = ROOT) {
  const failures = []
  const files = markdownFiles(root)
  const index = readFileSync(join(root, 'docs/README.md'), 'utf8')
  const tick = String.fromCharCode(96)
  const rows = new RegExp('^\\|\\s*' + tick + '([^' + tick + ']+\\.md)' + tick + '\\s*\\|', 'gm')
  const listed = [...index.matchAll(rows)].map(match => match[1]).sort()
  const all = new Set(files)
  const seen = new Set()
  for (const name of listed) {
    if (seen.has(name)) failures.push('docs/README.md: duplicate document index row: ' + name)
    seen.add(name)
    if (!all.has(name)) failures.push('docs/README.md: indexed document does not exist: ' + name)
  }
  for (const name of files) {
    if (!seen.has(name)) failures.push('docs/README.md: missing document index row: ' + name)
  }

  for (const name of files) {
    const source = join(root, 'docs', name)
    let fenced = null
    const lines = readFileSync(source, 'utf8').split(/\r?\n/u)
    for (const [index, line] of lines.entries()) {
      const fence = new RegExp('^\\s*([' + tick + '~]{3,})', 'u').exec(line)
      if (fence !== null) {
        if (fenced === null) fenced = fence[1][0]
        else if (fenced === fence[1][0]) fenced = null
        continue
      }
      if (fenced !== null) continue
      for (const match of withoutInlineCode(line).matchAll(/\]\(([^)]+)\)/gu)) {
        const raw = match[1].trim().replace(/^<|>$/gu, '').split(/\s+["']/u)[0]
        if (raw === '' || raw.startsWith('#') || raw.startsWith('/')
          || /^[a-z][a-z\d+.-]*:/iu.test(raw)) continue
        const link = raw.split(/[?#]/u, 1)[0]
        if (!link) continue
        const destination = resolve(dirname(source), decodeURIComponent(link))
        const inside = relative(root, destination)
        if (inside === '..' || inside.startsWith('..' + sep)) {
          failures.push('docs/' + name + ':' + (index + 1) + ': link escapes repository: ' + raw)
        } else if (!existsSync(destination)) {
          failures.push('docs/' + name + ':' + (index + 1) + ': missing local link: ' + raw)
        }
      }
    }
  }
  return failures
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = checkDocsTree()
  if (failures.length > 0) {
    for (const failure of failures) console.error('docs-gate: ' + failure)
    process.exitCode = 1
  } else {
    console.log('docs-gate: complete indexed docset; all detected local Markdown targets exist')
  }
}
