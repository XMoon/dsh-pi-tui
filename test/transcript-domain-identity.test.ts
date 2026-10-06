/**
 * TS7 ONE-authority identity: the stable `src/transcript.ts` facade must
 * re-export the SAME constructor/function identity as the canonical
 * `src/domain/transcript/**` owners, and the repository must declare exactly
 * one production `TranscriptFolder`. A wrapper/subclass facade or a second fold
 * would still pass the ordinary behavioural suites, so this locks the contract
 * mechanically.
 * @module @xmoon76/dsh-pi-tui/transcript-domain-identity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { foldTranscript as facadeFoldTranscript, TranscriptFolder as FacadeTranscriptFolder } from '../src/transcript.ts'
import { foldTranscript as canonicalFoldTranscript, TranscriptFolder as CanonicalTranscriptFolder } from '../src/domain/transcript/folder.ts'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Every production source file under `src/`, recursively. */
function productionSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      out.push(...productionSources(path))
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

test('the facade re-exports the canonical TranscriptFolder identity', () => {
  assert.strictEqual(FacadeTranscriptFolder, CanonicalTranscriptFolder)
  assert.strictEqual(facadeFoldTranscript, canonicalFoldTranscript)
})

test('exactly one production TranscriptFolder class declaration exists', () => {
  const declaring = productionSources(SRC)
    .filter(path => /\bclass TranscriptFolder\b/.test(readFileSync(path, 'utf8')))
    .map(path => path.slice(SRC.length))
  assert.deepEqual(declaring, ['domain/transcript/folder.ts'])
})
