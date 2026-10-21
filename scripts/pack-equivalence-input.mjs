#!/usr/bin/env node
/**
 * WHEN the pack-equivalence proof must run again.
 *
 * A lifecycle-free `pnpm pack` is only acceptable because its CONTENT equals
 * an ordinary `pnpm pack`'s. That equality is not a permanent property of the
 * repository: it depends on the packaging inputs. A change to the manifest's
 * `files`/`exports`, the pnpm version, the preset generator or the build
 * configuration can break it without breaking any test.
 *
 * The Owner's ruling is that the comparison is a GATED PROPERTY with a
 * re-qualification trigger — not a per-run cost. This script is that trigger:
 * it digests exactly the inputs the equality depends on, and a difference
 * means the proof is STALE and must be re-run.
 *
 * What is deliberately NOT here:
 *
 *   - the repository's source code. A source change that alters the built
 *     output does not change the RELATION between the two pack paths: both
 *     consume whatever `dist` the build produced. The relation depends on how
 *     the package is assembled, not on what happens to be inside it.
 *   - the lockfile. It changes which dependency versions a consumer gets, not
 *     which files the tarball contains.
 *
 * Usage:
 *   node scripts/pack-equivalence-input.mjs --write <file>
 *   node scripts/pack-equivalence-input.mjs --check <file>
 * @module @xmoon76/dsh-pi-tui/scripts/pack-equivalence-input
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The packaging inputs the equality depends on.
 *
 * Each entry says WHY it belongs: a file that could change which files end up
 * in the tarball, or how the manifest is rewritten.
 */
const INPUTS = [
  // `files`, `exports`, `types`, `bin`, dependencies, the lifecycle scripts
  // and the pinned package manager all decide the package's shape.
  { path: 'package.json', why: 'the manifest decides what is packed and how it is rewritten' },
  // The bundle build decides `dist/**`, which IS the package's payload.
  { path: 'tsdown.config.ts', why: 'the bundle build decides the payload files' },
  // The generated presets are part of the payload.
  { path: 'scripts/generate-dsh-presets.mjs', why: 'the generated presets are part of the payload' },
  // An ignore file changes which files the packer includes, if present.
  { path: '.npmignore', why: 'an ignore file changes which files are packed', optional: true },
]

/**
 * The digest of the current packaging inputs.
 *
 * @returns {{digest: string, inputs: Array<{path: string, present: boolean, sha256: string|null}>}} the identity.
 */
export function packagingInputDigest() {
  const hash = createHash('sha256')
  const inputs = []
  for (const input of INPUTS) {
    const absolute = join(ROOT, input.path)
    const present = existsSync(absolute)
    if (!present) {
      // An ABSENT optional input is part of the identity too: adding or
      // removing it changes how the packer behaves, so the digest must change
      // with its presence, not only with its bytes.
      hash.update(`${input.path}\u0000absent\n`)
      inputs.push({ path: input.path, present: false, sha256: null })
      continue
    }
    const sha256 = createHash('sha256').update(readFileSync(absolute)).digest('hex')
    hash.update(`${input.path}\u0000${sha256}\n`)
    inputs.push({ path: input.path, present, sha256 })
  }
  return { digest: hash.digest('hex'), inputs }
}

/**
 * The recorded proof: the digest, and per input BOTH its bytes' digest and
 * why it matters.
 *
 * Keeping the per-file digests is what makes a later mismatch diagnosable —
 * "the inputs differ" without saying which one is a report that cannot be
 * acted on.
 */
function describe() {
  const { digest, inputs } = packagingInputDigest()
  return {
    digest,
    inputs: inputs.map(entry => ({
      ...entry,
      why: INPUTS.find(input => input.path === entry.path)?.why ?? null,
    })),
  }
}

function main() {
  const args = process.argv.slice(2)
  const writeIndex = args.indexOf('--write')
  const checkIndex = args.indexOf('--check')
  if (writeIndex === -1 && checkIndex === -1) {
    console.error('usage: node scripts/pack-equivalence-input.mjs --write <file> | --check <file>')
    process.exit(2)
  }
  const current = packagingInputDigest()
  if (writeIndex !== -1) {
    writeFileSync(args[writeIndex + 1], `${JSON.stringify(describe(), null, 2)}\n`)
    console.log(`packaging inputs digest ${current.digest}`)
    return
  }
  const path = args[checkIndex + 1]
  if (!existsSync(path)) {
    // NO RECORDED PROOF is not "unchanged": it means the equality has never
    // been shown for these inputs, so the caller must run it.
    console.log('changed: no recorded equivalence proof exists')
    process.exit(1)
  }
  const recorded = JSON.parse(readFileSync(path, 'utf8'))
  if (recorded.digest !== current.digest) {
    const changed = (recorded.inputs ?? [])
      .filter(input => {
        const now = current.inputs.find(entry => entry.path === input.path)
        return now === undefined || now.sha256 !== (input.sha256 ?? null)
      })
      .map(input => input.path)
    console.log(`changed: the packaging inputs differ${changed.length > 0 ? ` (${changed.join(', ')})` : ''}`)
    process.exit(1)
  }
  console.log('unchanged: the recorded equivalence proof still covers these inputs')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
