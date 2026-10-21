#!/usr/bin/env node
/**
 * The BUILD IDENTITY: one digest over the artifacts a test run consumes.
 *
 * Splitting a lane across runners is only sound if every shard tested the
 * SAME build. The shards download a build artifact produced by one job, so
 * "the same build" has to be something a shard can PROVE, not something the
 * pipeline intends:
 *
 *   - a shard that received a truncated or partially restored tree must fail
 *     rather than test a build nobody produced;
 *   - the pack must consume the build the tests ran against, not a rebuild;
 *   - a candidate tarball must be identifiable as the one this build
 *     produced.
 *
 * The digest covers the build OUTPUTS the tests and the pack depend on:
 * the root bundle (`dist`), the vendored fork's build (`packages/pi-tui/dist`)
 * and the generated presets (`generated`). Source files are not included:
 * they are identified by the commit, and a dirty tree is a different problem.
 *
 * The digest is over SORTED relative paths and each file's own sha256, so it
 * does not depend on directory order, mtime or inode.
 *
 * Usage:
 *   node scripts/build-digest.mjs --write build-digest.json
 *   node scripts/build-digest.mjs --verify build-digest.json
 * @module @xmoon76/dsh-pi-tui/scripts/build-digest
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The build outputs a test run and a pack consume.
 *
 * `packages/pi-tui/dist` is a BUILD INPUT to the root bundle and to the
 * tests (the repository consumes the fork through its built entry), so a
 * shard that has the root `dist` but a stale fork build is testing a
 * different thing.
 */
const BUILD_DIRECTORIES = ['dist', 'packages/pi-tui/dist', 'generated']

/** Every file under `directory`, as sorted POSIX paths relative to ROOT. */
function filesUnder(directory) {
  const absolute = join(ROOT, directory)
  if (!existsSync(absolute)) {
    throw new Error(`the build output ${directory} is missing: the build did not run, or it ran somewhere else`)
  }
  const found = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      found.push(path.slice(ROOT.length + 1).split('\\').join('/'))
    }
  }
  walk(absolute)
  if (found.length === 0) {
    throw new Error(`the build output ${directory} is empty: a build that produced nothing cannot identify a run`)
  }
  return found.sort()
}

/**
 * The digest of the current build outputs.
 *
 * @returns {{digest: string, fileCount: number, files: string[]}} the identity.
 */
export function buildDigest() {
  const files = BUILD_DIRECTORIES.flatMap(filesUnder).sort()
  const hash = createHash('sha256')
  for (const file of files) {
    // The path is hashed WITH the content, so a file moved into another
    // output directory changes the digest even if its bytes do not.
    hash.update(`${file}\u0000`)
    hash.update(createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex'))
    hash.update('\n')
  }
  return { digest: hash.digest('hex'), fileCount: files.length, files }
}

/** The identity, plus what it was taken from. */
function describe() {
  const identity = buildDigest()
  return {
    ...identity,
    directories: BUILD_DIRECTORIES,
    // `files` is the whole list: it is what makes a mismatch diagnosable.
    // It is small (the build outputs are tens of files), and an identity
    // that cannot say WHICH file differs only tells a reader that the run
    // is invalid, not why.
  }
}

function main() {
  const args = process.argv.slice(2)
  const writeIndex = args.indexOf('--write')
  const verifyIndex = args.indexOf('--verify')
  if (writeIndex === -1 && verifyIndex === -1) {
    console.error('usage: node scripts/build-digest.mjs --write <file> | --verify <file>')
    process.exit(2)
  }
  if (writeIndex !== -1) {
    const identity = describe()
    writeFileSync(args[writeIndex + 1], `${JSON.stringify(identity, null, 2)}\n`)
    console.log(`build digest ${identity.digest} over ${identity.fileCount} file(s)`)
    return
  }
  const expected = JSON.parse(readFileSync(args[verifyIndex + 1], 'utf8'))
  const actual = describe()
  if (actual.digest !== expected.digest) {
    // The difference is named, not merely reported: a shard that received a
    // different build must say WHICH file makes it different.
    const expectedFiles = new Set(expected.files ?? [])
    const actualFiles = new Set(actual.files)
    const missing = [...expectedFiles].filter(file => !actualFiles.has(file))
    const unexpected = [...actualFiles].filter(file => !expectedFiles.has(file))
    console.error(`the build digest is ${actual.digest}, not the expected ${expected.digest}`)
    if (missing.length > 0) console.error(`  missing: ${missing.slice(0, 10).join(', ')}`)
    if (unexpected.length > 0) console.error(`  unexpected: ${unexpected.slice(0, 10).join(', ')}`)
    if (missing.length === 0 && unexpected.length === 0) {
      console.error('  the file set matches: a file CONTENT differs between this build and the identified one')
    }
    process.exit(1)
  }
  console.log(`build digest ${actual.digest} matches over ${actual.fileCount} file(s)`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
