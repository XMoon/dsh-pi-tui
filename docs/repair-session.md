# Session log repair (`scripts/repair-session.mjs`)

## When to use

A session no longer loads, the guard reports an unreadable committed prefix,
or the web surface's session list breaks. The script is standalone and
resolves `decodeStorageRecord` from the dsh install — it does not need the
bundle.

## Usage

```sh
node repair-session.mjs <session-id> [--yes] [--duplicate-reference first|last|segment] [--dsh-dir <path>] [--dsh-home <path>]
node repair-session.mjs --scan [--dsh-dir <path>] [--dsh-home <path>]
```

- `--scan` — read-only: scans every persisted session and lists damaged ids.
- default (no `--yes`) — dry run: reports what would change, writes nothing.
- `--yes` — applies, with a **mandatory fsynced backup first** and a
  post-write full verify.

## Damage classes and their repairs

Diagnosis replays the event-log invariants (`seq` strictly increasing;
turn/step nesting) over the EXPANDED records (`decodeStorageRecord` — see
"Rows vs events" below) to pinpoint the first unreadable event instead of
guessing at a byte offset.

| Damage | Repair |
|---|---|
| duplicate `seq` | renumber from the first collision, with an old→new reference remap |
| gap / unparsable | truncate |
| wrong frame layout | re-frame |
| torn tail | truncate at the last COMPLETE frame boundary, with byte accounting |
| damage at byte 0 | REFUSE — no salvageable prefix, nothing to repair |

When a torn tail loses events whose count cannot be enumerated, the report
says `unknown` for the loss — never pretend it is 0.

### References to duplicated seqs — never guess

A reference to a `seq` that occurs MORE THAN ONCE is ambiguous: the repair
REFUSES by default and requires `--duplicate-reference=first|last|segment`.
Silently guessing is how corruption spreads.

## The zstd frame layout (the big trap)

dsh appends **ONE zstd frame per flush**, and `node:zlib`'s
`zstdDecompressSync` only decodes the FIRST frame of a concatenated set — so
frame-slicing is mandatory. `scanZstdFrames` (`repair-core.mjs`, adapted from
`dsh-session-persistence-jsonl`) walks frames; verified against the
11079-frame `ab79200b` log. The walker never throws on a bad tail: it reports
`tornStart`/`garbageStart`, so a torn log is NEVER reported healthy.

### NEVER compress a repaired log as one whole-log frame

It decompresses fine, but every dsh reader (`session.list`, `load`,
`readFrom`) rejects it with
`corrupt Zstandard session log: first frame is not exactly one header line`.
This exact bug broke the web's session list when the 2026-08-15 repair
rewrote three logs as single frames. The correct layout:

- the first frame decodes to EXACTLY the header line;
- each frame holds complete JSONL records.

`compressLog` writes the header line alone in frame one, then the remaining
lines in ~16 KiB plaintext chunks (checksummed like the harness writer).
The chunk size is a deliberate middle ground: one frame per LINE would also
be valid for the readers, but the per-frame zstd overhead balloons a
repaired log ~10x (a 12 MB log became 118 MB that way once).
`scanZstdLayout` is the layout gate used by both `--scan` and the post-write
verify.

### Validate against the consumer's layout rules, not a self round-trip

A `compressLog` test that asserted "round-trips as one frame" passed while
every real dsh reader rejected the output — the round-trip only proves
self-consistency. Any serializer test must assert the consumer's own
invariants (first frame = exactly the header line; frames end on JSONL
record boundaries), i.e. run the same layout gate the readers run.

## File mode (trap)

Repaired files are written `0600`, same as the harness: `writeFileSync` must
pass `{ mode: 0o600 }`, not the umask default.

## Rows vs events (trap)

File rows are the storage format; packed `*-chunks` rows (`seq0` + `dt`)
expand via `decodeStorageRecord` into individual events with real `seq`.
Counting "events in the file" requires expanding rows first — naive
line-counting does not — which matters when judging how much of a log is
intact (see also `concurrency.md`).
