#!/usr/bin/env node
/**
 * The test DISCOVERY rule: which test files belong to which verification
 * lane.
 *
 * The repository's test tree is organised by PRODUCTION OWNERSHIP
 * (`test/<owner>/…`), so discovery must be RECURSIVE: a flat `test/*.test.ts`
 * glob would silently stop finding a test the moment it moved into a
 * subdirectory. This module is the single place that decides that membership.
 *
 * The rules it enforces:
 *
 *   - RECURSIVE discovery: a lane's pattern reaches every depth below
 *     `test/`, and the ROOT level as well;
 *   - NO double discovery: the same file is never handed to a lane twice
 *     (two overlapping patterns must not produce two entries);
 *   - `test/support/**` and `test/fixtures/**` are INFRASTRUCTURE, not test
 *     files — they are excluded by EXPLICIT DIRECTORY, not by filename, so a
 *     future `support/foo.test.ts` cannot slip into a lane;
 *   - FAIL CLOSED: an empty lane is an error, never a silently green run;
 *   - DETERMINISTIC ORDER: the file list is sorted, so a lane's execution
 *     order does not depend on the filesystem;
 *   - PATH-STYLE STABILITY: the returned paths use POSIX separators, so the
 *     same membership is compared identically on Windows and POSIX.
 *
 * The selection is a pure function over a directory: it takes a root
 * directory and returns the matching files. Nothing here spawns a process or
 * touches the network — the caller owns the execution.
 * @module @xmoon76/dsh-pi-tui/scripts/test-discovery
 */

import { globSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The directories under `test/` that hold INFRASTRUCTURE, not test files.
 * Their contents are shared harness code and test input data; a test file
 * placed inside one would be a placement mistake, so the discovery rule
 * excludes them by DIRECTORY rather than by filename.
 */
export const TEST_INFRASTRUCTURE_DIRECTORIES = ['support', 'fixtures']

/** The test-file suffixes the discovery rule recognizes. */
export const TEST_FILE_SUFFIXES = ['.test.ts', '.test.mjs']

/** A POSIX-style path, so a membership comparison is platform-independent. */
function posix(path) {
  return path.split(sep).join('/')
}

/** Whether `rel` (a POSIX path relative to the test root) is infrastructure. */
export function isInfrastructurePath(rel) {
  const segments = rel.split('/')
  return segments.slice(0, -1).some(segment => TEST_INFRASTRUCTURE_DIRECTORIES.includes(segment))
}

/**
 * Every test file under `testRoot`, recursively, as POSIX paths relative to
 * `testRoot`, sorted.
 *
 * The exclusion is applied AFTER the glob, on the relative path: a file
 * inside `support/` or `fixtures/` is infrastructure even if its NAME looks
 * like a test.
 */
export function discoverTestFiles(testRoot, suffixes = TEST_FILE_SUFFIXES) {
  const patterns = suffixes.map(suffix => join(testRoot, '**', `*${suffix}`))
  const found = new Set()
  for (const pattern of patterns) {
    for (const absolute of globSync(pattern, { nodir: true })) {
      const rel = posix(relative(testRoot, absolute))
      if (isInfrastructurePath(rel)) continue
      found.add(rel)
    }
  }
  return [...found].sort()
}

/**
 * Resolve one lane's file list.
 *
 * `patterns` are glob patterns relative to `testRoot`. A lane fails CLOSED:
 * a pattern that matches nothing, or a lane that ends up with no files at
 * all, is an error — a lane that silently discovers nothing would report
 * green while proving nothing.
 */
export function resolveLane(
  testRoot,
  patterns,
  suffixes = TEST_FILE_SUFFIXES,
) {
  const all = discoverTestFiles(testRoot, suffixes)
  const selected = new Set()
  for (const pattern of patterns) {
    const matches = all.filter(rel => matchesPattern(rel, pattern))
    if (matches.length === 0) {
      throw new Error(`the test lane pattern ${pattern} matched no test file under ${testRoot}`)
    }
    for (const match of matches) selected.add(match)
  }
  if (selected.size === 0) {
    throw new Error(`the test lane discovered no test file under ${testRoot}`)
  }
  return [...selected].sort()
}

/**
 * Whether a discovered relative path belongs to a lane pattern.
 *
 * The pattern language is deliberately small: `*` matches within one path
 * segment, `**` matches across segments, and a pattern without a wildcard
 * matches exactly. A pattern is matched against the WHOLE relative path, so
 * `tooling/*.test.mjs` selects the tooling lane and `**\/*.test.ts` selects
 * every TypeScript test at any depth.
 */
export function matchesPattern(rel, pattern) {
  const normalized = posix(pattern)
  const expression = patternToExpression(normalized)
  return new RegExp(`^${expression}$`, 'u').test(rel)
}

/** Translate one lane pattern into a regular expression source. */
function patternToExpression(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` spans zero or more segments; a trailing `**` spans the rest.
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  return source
}
