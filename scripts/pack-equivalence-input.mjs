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
 * What is deliberately NOT here, and what replaced an earlier exclusion:
 *
 *   - the repository's source code. A source change that alters the built
 *     output does not change the RELATION between the two pack paths: both
 *     consume whatever `dist` the build produced. The relation depends on how
 *     the package is assembled, not on what happens to be inside it.
 *   - the lockfile is INCLUDED. It was excluded at first on the argument that
 *     it only changes a consumer's dependency versions — but the ordinary
 *     pack runs `prepack`, whose build toolchain comes from the lockfile, so
 *     a lockfile change can change the payload while the proof still claimed
 *     to cover it.
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
  // The lockfile pins not only a consumer's dependency versions but the
  // build TOOLCHAIN that produces the payload. Excluding it would let a
  // toolchain bump change what is built while the proof still claimed to
  // cover it.
  { path: 'pnpm-lock.yaml', why: 'the lockfile pins the build toolchain that produces the payload' },
  // Workspace layout decides how pnpm resolves and packs.
  { path: 'pnpm-workspace.yaml', why: 'the workspace layout decides how pnpm resolves and packs', optional: true },
  // The COMPARATOR decides what "equivalent" means. A changed comparator
  // could stop noticing a difference the old one caught.
  { path: 'scripts/compare-tarballs.mjs', why: 'the comparator defines what equivalent means' },
  // The PROTOCOL is the two commands being compared. A changed command is a
  // different comparison, so the recorded proof no longer describes it.
  { path: 'scripts/pack-equivalence-protocol.json', why: 'the protocol is the pair of commands being compared' },
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
 * A pack invocation reduced to a comparable form.
 *
 * The workflow writes `--pack-destination "$GITHUB_WORKSPACE"` where the
 * protocol names `<workspace>`, and flag ORDER is not meaningful. Normalising
 * both sides to a sorted token list is what lets a test compare the PROTOCOL
 * with the command the workflow actually runs — without that comparison the
 * protocol is a comment: changing the command would leave the digest
 * untouched and the proof would keep being skipped.
 *
 * @param {string} text - a command line, or the protocol's own string.
 * @returns {string[]} the comparable tokens.
 */
export function normalizePackInvocation(text) {
  return text
    .replace(/"\$GITHUB_WORKSPACE"/gu, '<workspace>')
    .replace(/\$GITHUB_WORKSPACE/gu, '<workspace>')
    .replace(/\s+/gu, ' ')
    .trim()
    .split(' ')
    .sort()
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

/**
 * The value of a `--flag <value>` pair.
 *
 * @param {string[]} args - the command line arguments.
 * @param {string} name - the flag.
 * @returns {string|undefined} the value.
 */
function valueOf(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
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
  // A DIGEST is not a PROOF. Matching bytes say the inputs are the ones the
  // file was taken at; they say nothing about whether the comparison was ever
  // run, or whether it PASSED. A record whose proof was deleted, or whose
  // proof says `equivalent: false`, must reopen the question.
  const proof = recorded.proof
  if (proof === undefined || proof === null || proof.equivalent !== true) {
    console.log('changed: the record carries no PASSING equivalence proof')
    process.exit(1)
  }
  // The proof's SCOPE is part of the gate. An npm proof says nothing about a
  // source run, and a Node 24 proof says nothing about another runtime.
  const mode = valueOf(args, '--mode') ?? 'npm'
  const node = valueOf(args, '--node') ?? String(process.versions.node.split('.')[0])
  if (proof.mode !== mode) {
    console.log(`changed: the recorded proof is for mode '${proof.mode}', not '${mode}'`)
    process.exit(1)
  }
  if (proof.node !== node) {
    console.log(`changed: the recorded proof is for Node ${proof.node}, not ${node}`)
    process.exit(1)
  }
  // The PLATFORM is part of the scope: `pnpm pack` and the tar layout are
  // platform-dependent, so a Linux proof says nothing about a Windows run.
  const platform = valueOf(args, '--platform') ?? process.platform
  if (proof.platform !== platform) {
    console.log(`changed: the recorded proof is for platform '${proof.platform}', not '${platform}'`)
    process.exit(1)
  }
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
