# Release checklist

This is the canonical checklist for releasing `@xmoon76/dsh-pi-tui`. The
repository root is the published bundle; `packages/pi-tui` is a private
vendored build dependency and must never be published separately.

## Release invariants

- The version is changed in the root `package.json`. A version-only bump does
  not require a `pnpm-lock.yaml` change; investigate any lockfile diff.
- `CHANGELOG.md` and `CHANGELOG.en.md` are released together. Their version
  headings, dates, categories, and entries must stay synchronized.
- `README.md` and `README.en.md` are released together when user-facing
  behavior, commands, keybindings, or installation instructions change.
- The only published package is `@xmoon76/dsh-pi-tui`. Do not run `npm publish`
  from a development machine; GitHub CI publishes the tested tarball through
  npm Trusted Publishing.
- Never create or push a release tag until the local verification below is
  green. Never push without the user's explicit confirmation.

## 1. Inspect the release range

Start from a clean working tree and confirm the previous tag and the intended
scope:

```sh
git status --short --branch
git fetch --tags origin
git tag --sort=-version:refname | head
git log v<previous>..HEAD --oneline
git diff --stat v<previous>..HEAD
```

Remove or move generated files and review probes out of the repository. Do not
silently discard untracked user work.

Read the `[Unreleased]` entries and the user-visible commits since the previous
tag. Merge repeated review fixes into the final user-facing outcome instead of
copying commit subjects into the changelog. Keep known limitations explicit;
for example, the production backend is still Direct and remote attach is not
supported while M2–M8 remain unfinished.

## 2. Update release metadata and documentation

Choose exactly one release channel before editing metadata:

- **Stable:** branch `main`, tag `vX.Y.Z`, npm dist-tag `latest`, and a stable
  SemVer package version.
- **Prerelease:** branch `next`, tag `next-vX.Y.Z-alpha.N` (or another
  prerelease identifier), npm dist-tag `next`, and the same prerelease version
  in `package.json`.

The tag's commit must already be an ancestor of its required branch. A
`next-v...` tag on `main`, or a stable `v...` tag on `next`, is a release error;
the CI `release-context` and ancestry gates enforce these rules again.

For the selected package version `X.Y.Z` (including any prerelease suffix) on
release date `YYYY-MM-DD`:

1. Change the root `package.json` version to `X.Y.Z`.
2. In both changelogs, add `## [X.Y.Z] - YYYY-MM-DD` immediately below the
   empty `## [Unreleased]` heading, then move the accumulated entries under
   that version. Leave a fresh empty `[Unreleased]` section at the top.
3. Update both changelog reference blocks. Use the matching channel prefix for
   both links:

   ```text
   # stable
   [Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/XMoon/dsh-pi-tui/compare/v<previous>...vX.Y.Z

   # prerelease
   [Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/next-vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/XMoon/dsh-pi-tui/compare/next-v<previous>...next-vX.Y.Z
   ```

4. Keep the Chinese and English changelog sections in the same order and make
   sure behavior changes, migration notes, and security fixes are represented
   in both languages.
5. Mirror every README change in the other language. In particular, check
   command names, save/submit keys, default-versus-effective keybinding
   wording, and package installation commands.
6. Check the resulting diff:

   ```sh
   git diff --check
   git diff -- package.json pnpm-lock.yaml README.md README.en.md \
     CHANGELOG.md CHANGELOG.en.md
   ```

## 3. Validate the release notes before tagging

The release metadata script must pass before a release commit is made. It
checks the tag format, package version, both changelog sections, matching
version/date headings, and non-empty release content:

Stable:

```sh
node scripts/release-notes.mjs vX.Y.Z /tmp/dsh-pi-tui-release-notes-X.Y.Z.md
```

Prerelease:

```sh
node scripts/release-notes.mjs next-vX.Y.Z-alpha.N /tmp/dsh-pi-tui-release-notes-X.Y.Z-alpha.N.md
```

The script compares the parsed tag version (without the `next-` channel
marker) with `package.json` and verifies both dated bilingual sections. Review
the generated file if the release body matters. For the 0.4 migration line,
the dated sections must also include the DSH/TUI pairing and copy-paste
installation commands: that extracted file is the GitHub Release body, not an
optional summary. A failure here means the release channel, section, date,
package version, or installation guidance is incomplete; do not bypass it.

## 4. Run the appropriate verification gate

The gate selection depends on whether the release range changed the vendored
fork:

| Release range | Command |
|---|---|
| No change under `packages/pi-tui/` | `pnpm run verify:prepush:nofork` |
| Any change under `packages/pi-tui/` | `pnpm run verify:prepush` |

Both commands run the documentation test, naming gate, client-boundary gate,
keybinding gate, production dependency audit, and `pack:release`. The full
variant additionally runs the fork typecheck and fork tests. `pack:release`
executes the package lifecycle: clean, build, bundle typecheck/tests, tarball
smoke, public extension fixture smokes, plugin smokes, and declaration-leak
checks. Do not treat source tests alone as sufficient.

The CI tag workflow also runs its own source checks, fork tests, exact-tarball
checks, compatibility matrix, `pi2dsh` TTY smoke, and security audit. The local
nofork shortcut only avoids repeating the fork suite locally; it does not
remove those CI checks.

For CI-equivalent dependency resolution, especially after dependency changes,
run the frozen install before the verification gate:

```sh
pnpm install --frozen-lockfile
```

After the gate, verify that the package and lockfile are correct:

```sh
node -e "const p=require('./package.json'); console.log(p.name, p.version)"
git diff --quiet -- pnpm-lock.yaml
git status --short --branch
```

## 5. Commit and create the tag locally

Only after all metadata and verification checks pass:

```sh
git add package.json pnpm-lock.yaml README.md README.en.md CHANGELOG.md CHANGELOG.en.md docs/releasing.md docs/README.md
git diff --cached --check
git commit -m "chore: release <channel>-<version>"
```

Create the tag that matches the selected channel, without pushing it:

```sh
# stable channel
git tag vX.Y.Z

# prerelease channel
git tag next-vX.Y.Z-alpha.N
```

The project uses commit-pointing tags. If an unpushed tag needs correction,
delete and recreate it locally rather than force-moving a published tag:

```sh
git tag -d vX.Y.Z                 # or next-vX.Y.Z-alpha.N
```

## 6. Push only after explicit confirmation

Do not push automatically. Once the user confirms the commit and tag, push the
matching branch and tag:

```sh
# stable channel
git push origin main vX.Y.Z

# prerelease channel
git push origin next next-vX.Y.Z-alpha.N
```

The push invokes the Husky pre-push gate for the branch and tag. The tag starts
`.github/workflows/ci.yml`:

1. the parser selects `latest`/`main` for `v...`, or `next`/`next` for
   `next-v...`, and the ancestry gate checks the tag's required branch;
2. source checks, build/pack, compatibility and ecosystem smoke jobs, the old
   runtime boundary, and the production dependency audit run in parallel;
3. release metadata extracts the bilingual changelog body and checks parsed
   tag version/date parity;
4. `publish` downloads the exact tested tarball, verifies its embedded version
   against the parsed release version, and runs `npm publish` with the selected
   npm dist-tag via OIDC;
5. `release` runs only after publish succeeds, then creates or updates the
   GitHub Release with the correct prerelease state and uploads the tarball plus
   its SHA-256 file.

No `NPM_TOKEN` or local npm credential is used. If a tag workflow fails, fix
the cause and rerun the workflow when appropriate; do not force-move a tag
that has already reached the remote.

## 7. Verify the published release

After CI completes, verify the remote tag, package version, npm channel, GitHub
Release, and artifact. If a release is not meant to be published yet, stop after
the local commit and tag and leave the tag unpushed.

```sh
# stable channel
git ls-remote --tags origin vX.Y.Z
npm view @xmoon76/dsh-pi-tui@latest version
gh release view vX.Y.Z --repo XMoon/dsh-pi-tui

# prerelease channel
git ls-remote --tags origin next-vX.Y.Z-alpha.N
npm view @xmoon76/dsh-pi-tui@next version
gh release view next-vX.Y.Z-alpha.N --repo XMoon/dsh-pi-tui
```

Inspect the visible Release body as well. For the 0.4 line it must show the
matching `@deepseek-ai/dsh` command, the matching TUI channel, and the legacy
0.3 fallback note; these are sourced from the bilingual dated changelog section
and must not be replaced by a manually edited summary.

For the next cycle, `[Unreleased]` is intentionally empty. Its comparison link
should use the tag prefix of the channel being continued (`v...` or `next-v...`).
