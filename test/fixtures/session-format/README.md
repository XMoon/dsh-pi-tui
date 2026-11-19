# Historical Session fixture for Host/Client wiring

`released-v1-real-shapes.jsonl` is a historical released-format artifact
retained only as a **refusal input** for
`test/app/remote-session-migration-rc2.test.ts`.

The artifact was derived from the released DSH V0 sample through the official
V0-to-V1 codec. Its surface events precede the first step, so the official
DSH format catalog refuses a migration that would change chronology. The
Host/Client test checks that the resulting classification/refusal reaches
PiTui and cannot replace a live Session or its unsent draft.

**DSH owns** historical decoding, validation, migration, successor
publication and immutable-source guarantees. This repository does not
reimplement or separately qualify those persistence semantics.

See the official
[`dsh-session-persistence-jsonl` tests](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-persistence-jsonl/tests)
for storage-level format coverage.
