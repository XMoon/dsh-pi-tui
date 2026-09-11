# Session-format historical-generation fixtures

Real released-v0 / released-v1 session artifacts used by the historical
migration E2E (`scripts/e2e-historical-migration.sh`). Both files are official
DSH products — never TUI raw-parser output.

## `released-v0-real-shapes.jsonl`

Copied verbatim from the official deepseek-harness repository:

- Source: `packages/session/session-persistence-jsonl/tests/fixtures/released-v0-real-shapes.jsonl`
- Ref: `deepseek-ai/deepseek-harness` @ `d347e703908d0406b7a7ef80e3a0e594d86b2215`
  (the master 0.1.3-alpha.1 source pack; see `test/compat/dsh-source.json`)
- Shape: one complete released-v0 session (header `version: 0`, id
  `released-v0-real-shapes`, cwd `/work`) covering retry, repeated compaction
  with provenance ranges, a late user message, and a late title request.

## `released-v1-real-shapes.jsonl`

Generated from the v0 fixture through the OFFICIAL v0→v1 migration package
`@deepseek-ai/dsh-session-format-v0-to-v1` (master 0.1.3-alpha.1), then encoded
as the released-v1 PHYSICAL artifact (what the official persistence reads from
disk). Generation command (run with the master environment's node_modules
resolvable, e.g. from a directory whose `node_modules` links the master env):

```sh
node gen-v1.mjs \
  test/fixtures/session-format/released-v0-real-shapes.jsonl \
  test/fixtures/session-format/released-v1-real-shapes.jsonl
```

with `gen-v1.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs'
import {
  releasedV0SessionFormatCodec,
  releasedV1SessionFormatCodec,
  sessionFormatV0ToV1,
} from '@deepseek-ai/dsh-session-format-v0-to-v1'

const [v0Path, outPath] = process.argv.slice(2)
const text = readFileSync(v0Path, 'utf8').trimEnd()
const lines = text.split('\n')
const header = JSON.parse(lines[0])
const rows = lines.slice(1).map((line) => JSON.parse(line))
const decoded = releasedV0SessionFormatCodec.decodeArtifact(header, rows)
const migrated = sessionFormatV0ToV1.migrate(decoded)
const physical = releasedV1SessionFormatCodec.encodeArtifact(migrated, { packChunks: true })
writeFileSync(outPath, [physical.header, ...physical.rows]
  .map((r) => JSON.stringify(r)).join('\n') + '\n')
```

The v1→v2 edge (`@deepseek-ai/dsh-session-format-v1-to-v2`) then migrates this
artifact to the current v2 format; the E2E exercises that whole chain from disk.

## On-disk placement

The E2E places each fixture as the official physical artifact under an
isolated DSH_HOME: `sessions/<projectKey>/<encodedId>/session.jsonl.zstd`
(v0) or `session.v1.jsonl.zstd` (v1), zstd-encoded as two frames — the header
line frame followed by the body frame — exactly the encoding the official
JSONL persistence writes (`encodePhysicalJsonl`). The source generation file is
never modified; the official migration publishes `session.v2.jsonl.zstd`
beside it.
