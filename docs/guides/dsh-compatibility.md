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
| Project DSH CLI executable and version | `mise.toml` template + `mise.lock`; the exact version comes from the `@deepseek-ai/dsh-agent` devDependency |
| Pinned source target for Source Mode | `test/compat/dsh-source.json` (repository + exact 40-character commit) |
| Published pi2dsh bridge probe input | the live public npm registry (`pi2dsh@latest` and the `@deepseek-ai/dsh` version list); there is no checked-in pairing file |
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

1. Enter the checkout and run `mise run setup` for the npm-mode workspace; for
   Source Mode use `mise run source:doctor` / `mise run source:bootstrap` (the
   interactive source runbook is owned by
   [development.md](./development.md#source-mode)). The project DSH CLI version
   is the exact `@deepseek-ai/dsh-agent` devDependency selected by `mise`.
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

## Published pi2dsh ecosystem probe

The pi2dsh bridge is an EXTERNAL published consumer; it is not a version target
of this repository and has no checked-in pairing file. Every probe run:

1. resolves `pi2dsh@latest` from the public npm registry and freezes that exact
   published version for the whole run (the bridge is installed by that exact
   spec, never by `latest`);
2. reads the published `@deepseek-ai/dsh` version list and selects the HIGHEST
   published version that satisfies every DSH peer the bridge actually declares,
   every DSH peer the candidate tarball declares, and the candidate's
   `engines.dsh` (with the official `includePrerelease` semantics). npm's
   default prerelease rule governs peer ranges;
3. installs that exact pair and runs the real tmux PTY smoke.

A valid but lagging `@xmoon76/dsh-pi-tui` peer on the bridge is
`METADATA_DRIFT`: it is reported but does not reject a runnable DSH; the real
ordinary plugin install and PTY decide. A missing/invalid bridge TUI peer,
invalid metadata, no installable intersection, registry failure, install
failure or runtime failure is a real failure — never a SKIP, never a forced
install. A PASS proves only the exact pair resolved for that run; it does not
claim the whole semver range was runtime-verified.

`pnpm smoke:pi2dsh -- <candidate.tgz>` is the local entry. It always validates
the published npm ecosystem and requires online registry access; `--distribution`
(Source Mode) is refused with a non-zero error. `--force-peers` is an
INVESTIGATIVE manual run that ignores only the bridge's DSH peers; it is never
used in CI and never produces a published compatibility claim.

The checks are optional external-ecosystem signals: the `ecosystem-compat` job
uses Job-level `continue-on-error`, is not a dependency of the release
qualification graph, and its own job/log/debug artifact is the only authority
for its result. The official preset, runtime-boundary and Source Mode lanes
remain the hard gates for this repository's own qualification.

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
- A shared physical format version is not by itself a forward-read guarantee:
  the reader's known event types and payload generations decide readability.
  For example a newer `team/mode` record or a newer subagent-catalog payload is
  refused by an older reader even though the Session format number is unchanged;
  such a file must be opened by the runtime that wrote it.
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
registry-backed npm mode with a frozen lockfile. The pi2dsh ecosystem probe is
independent of that mode split: every run evaluates the PUBLISHED ecosystem
(`pi2dsh@latest` and published `@deepseek-ai/dsh`) and never uses a source pack.
A source pack cannot validate the published ecosystem, so the probe refuses
that combination with a non-zero error; the job is optional in both modes and a
skipped job is not a pass.

A passing ecosystem check proves the candidate against the PUBLISHED DSH
family only. In Source Mode it says nothing about the unpublished DSH source
family, and the published pi2dsh release is paired with a published DSH
version, so a later source-baseline move must not read this check as evidence
that the new Host is compatible. The Source Mode lanes (official presets, the
old-DSH boundary, the source distribution checks) own that qualification.

For local validation use the isolated driver rather than workspace symlinks:

```sh
mise exec -- pnpm compat:dsh:source -- --dsh-dir "/path/to/deepseek-harness"
mise exec -- pnpm compat:dsh:npm
```

The interactive Source Mode flow (source doctor/bootstrap, source CLI, isolated
profile) is a separate reusable procedure; see
[development.md](./development.md#source-mode) and
[development.md](./development.md#running-the-source-built-dsh-interactively).

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
- The optional `ecosystem-compat` job resolves the current published
  `pi2dsh@latest` / DSH intersection and runs the real PTY smoke; it is visible
  but not part of release qualification.
- `test/tooling/dsh-peer-window.test.mjs`, `test/tooling/release-notes.test.mjs` and
  `scripts/installation-doc-gate.mjs` prove the manifest/matrix-derived install
  facts and the two root READMEs; a stale matrix fails the release-notes gate
  instead of publishing a mixed install.
- A local TUI-only change does not need the full Source compatibility run. Run
  it when the DSH source/distribution boundary changes or when explicitly
  requested; GitHub CI is authoritative for routine PR compatibility.
