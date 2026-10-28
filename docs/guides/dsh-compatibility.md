# DeepSeek Harness compatibility

This guide owns the reusable compatibility method: how the DSH/TUI version
window is evaluated, where the live pairing facts live, and how persistent
Session data is treated across generations. It deliberately contains no current
release pairing table and no upgrade recommendation for a particular version —
those are live facts owned by manifests, the compatibility matrix, the root
READMEs and release notes.

## Sources of truth

| Fact | Owner |
|---|---|
| Published TUI identity, runtime peer ranges, `engines.dsh` floor | `package.json` (the packed manifest carries the same values) |
| Current DSH target and recommended upgrade command, the historical/compatible DSH rows | `src/dsh-compat-matrix.json` (`current`, `matrix`, `floor`) |
| Tracked development mode for a branch | `test/compat/dsh-mode.json` |
| Pinned source target for Source Mode | `test/compat/dsh-source.json` (repository + exact 40-character commit) |
| Published pairing summary and installation commands | `README.md` / `README.en.md` |
| Release-by-release history | `CHANGELOG.md` / `CHANGELOG.en.md` and GitHub Releases |

Runtime checks consume those files directly. Documentation must not become a
second copy of the matrix: when a version changes, update the manifest/matrix
and the tests that derive their expectations from them.

## Semver window matching

DSH/TUI pairing is evaluated with npm/node-semver rules plus the official
`engines.dsh` semantics:

- A prerelease whose major/minor/patch tuple differs from the comparator's
  prerelease tuple is excluded. For example, `>=0.1.2-rc.1` does not include
  `0.1.3-alpha.1`, and `^0.1.1-rc.1` does not include `0.1.2-alpha.1`.
- `engines.dsh` is preferred by DSH over peer ranges and is evaluated with
  prereleases included, so it can accept a later prerelease of a different
  release tuple that npm's peer rule excludes. Range equality with the floor
  does not by itself qualify every such prerelease.
- Never widen a pairing from a package peer lower bound alone. A matrix row
  without a `tui` value means no released TUI supports that DSH range.
- The floor and the recommended target are deliberately distinct values. A
  floor move belongs in the matrix row, the peer ranges and `engines.dsh`
  together; the peer-window tooling test rejects a partial move. The
  recommended upgrade command is a separate matrix field and must carry the
  converged native-script allow list.

## Diagnosing a compatibility question

1. Enter the checkout and run `pnpm dev:doctor`; repair with
   `pnpm dev:bootstrap` only when it is not `READY`.
2. Read `test/compat/dsh-mode.json` to learn whether this checkout is `npm` or
   `source` mode. npm Mode uses the exact DSH version declared by `package.json`
   and resolved by the frozen lockfile. Source Mode uses the pinned commit and
   expected version in `test/compat/dsh-source.json`.
3. Read `src/dsh-compat-matrix.json` `current` for the shipped TUI identity,
   supported DSH target, recommended upgrade family and guidance text. Read the
   `matrix` rows for older DSH lines and their paired TUI line.
4. Compare the installed runtime with `package.json` `engines.dsh` and the
   whole `@deepseek-ai/dsh-*` peer set. A mixed family (rc.1/rc.2 or
   published/unpublished) is not a supported pairing.
5. Use the root README for the published installation/upgrade commands. The
   startup notice is best-effort because Loader rows mount concurrently; the
   matrix remains the authority for the recommended target.

An unsupported published consumer declaration (for example one whose peers do
not cover the DSH version the manifest declares) is an
`ECOSYSTEM_CONTRACT_BLOCKER`, not a reason to force-install or to rewrite the
consumer manifest. The blocking gate validates the pairing that
`test/compat/pi2dsh.json` declares, so that pin answers one question: does the
current code keep the published consumer working on a DSH version both sides
support? It names an external consumer pairing and is NOT a CI target-version
source, so it may trail the matrix's current DSH target while the published
consumer still declares the older family. The declared version must remain a
pairing this TUI line actually supports, and a declaration the gate cannot
satisfy stays blocking until a compatible consumer release exists.

## Session and preset data compatibility

Runtime compatibility and data compatibility are separate concerns. A runtime
must satisfy the declared DSH floor, while an older Session file remains
readable through the official persistence contract.

- The official DSH reader/writer is the only authority for the physical Session
  format. The TUI displays what the official reader returns and never parses or
  rewrites the on-disk format itself.
- An older DSH runtime line persisted **Session V2**; later lines persist
  **Session V3** and own the V2-to-V3 migration when an older Session is opened. The released-v3 reader contract refuses newer event types
  it cannot represent.
- Opening an older generation through the official migration performs no write;
  only an explicit write open publishes the successor. A newer unsupported
  format is refused with the official diagnostic instead of being read as an
  empty Session. A generation the current runtime cannot represent keeps its
  bytes; open it with the runtime that wrote it.
- Back up a Session file before downgrading. Never hand-edit JSONL: an
  unsupported or malformed artifact must fail through the official reader.
- Preset state is read through the official `agentPreset` Session projection:
  the creation header initializes the state and the newest
  `agent-preset/selected` event wins. An omitted legacy settings default is an
  invalid preference, not an alias; new command/config writes are validated
  against the current roster before they are saved.
- The shipped preset ids are official facts. `dsh-pi-tui` does not define them;
  the generated `generated/dsh-presets/` mirror is a byte-exact parity-gated
  copy of the official exported assets. Remove the mirror only when DSH ships a
  shared preset bundle or cross-package patch references.

## Source Mode validation

Source Mode is a CI/local-validation adapter for an unpublished DSH checkout. It
is not a published package-install mode, never changes the package contract and
never vendors DSH into this repository.

The pin lives in `test/compat/dsh-source.json` and contains the full commit SHA
and expected version. The source lane checks out that exact SHA, runs the
official install/build/pack commands, validates the embedded metadata for the
complete DSH tarball family required by this TUI, and installs those tarballs
through temporary pnpm overrides before running the ordinary TUI, preset and
old-runtime checks. The temporary consumer install must not consult the tracked
registry lockfile for unpublished DSH metadata.

CI policy is explicit: pushes to `next` and pull requests whose base is `next`
follow the tracked `test/compat/dsh-mode.json`; `main` and every release tag use
registry-backed npm mode with a frozen lockfile. The pi2dsh ecosystem check
runs in BOTH modes and always against the PUBLISHED ecosystem: it installs the
published DSH and the published pi2dsh release from the registry, so it never
validates a source pack. A source pack cannot validate the published ecosystem
— the smoke refuses that combination and reports it as a SKIP, which is not a
pass. The gate is blocking in both modes.

A passing ecosystem check proves the candidate against the PUBLISHED DSH
family only. In Source Mode it says nothing about the unpublished DSH source
family, and the published pi2dsh release is pinned to a published DSH version,
so a later source-baseline move must not read this gate as evidence that the
new Host is compatible. The Source Mode lanes (official presets, the old-DSH
boundary, the source distribution checks) own that qualification.

For local validation use the isolated driver rather than workspace symlinks:

```sh
pnpm compat:dsh:source -- --dsh-dir "/path/to/deepseek-harness"
pnpm compat:dsh:npm
```

A dirty local DSH tree is allowed only with a visible reproducibility warning;
CI requires a clean checkout. Source-only overrides and generated manifests are
removed with the temporary validation workspace and must never be committed to
`package.json`, the lockfile or a release tarball.

## Validation gates

- The runtime-boundary smoke proves an unsupported old runtime fails loudly
  while friendly startup guidance is asserted when emitted.
- The official-preset gate installs only the exact target DSH and candidate
  artifact, then runs real `standard`/`ptc`/`minimal`/`cordis` Agent/Session
  creation, durable-header, degradation and `/goal` isolation checks.
- `test/tooling/dsh-peer-window.test.mjs`, `test/tooling/release-notes.test.mjs` and
  `scripts/installation-doc-gate.mjs` prove the manifest/matrix-derived install
  facts and the two root READMEs; a stale matrix fails the release-notes gate
  instead of publishing a mixed install.
- A local TUI-only change does not need the full Source compatibility run. Run
  it when the DSH source/distribution boundary changes or when explicitly
  requested; GitHub CI is authoritative for routine PR compatibility.
