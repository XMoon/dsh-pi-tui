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

For version `X.Y.Z` on release date `YYYY-MM-DD`:

1. Change the root `package.json` version to `X.Y.Z`.
2. In both changelogs, add `## [X.Y.Z] - YYYY-MM-DD` immediately below the
   empty `## [Unreleased]` heading, then move the accumulated entries under
   that version. Leave a fresh empty `[Unreleased]` section at the top.
3. Update both changelog reference blocks:

   ```text
   [Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/XMoon/dsh-pi-tui/compare/v<previous>...vX.Y.Z
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

```sh
node scripts/release-notes.mjs vX.Y.Z /tmp/dsh-pi-tui-release-notes-X.Y.Z.md
```

Review the generated file if the release body matters. A failure here means
the release section, date, or package version is incomplete; do not bypass it.

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
git add package.json README.md README.en.md CHANGELOG.md CHANGELOG.en.md docs/releasing.md docs/README.md AGENTS.md
git diff --cached --check
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git show --stat --oneline HEAD
git show --no-patch --format='%h %s' vX.Y.Z
```

The project uses a commit-pointing `vX.Y.Z` tag. If the tag has not been
pushed and the release commit needs correction, delete and recreate it locally
rather than force-moving a published tag:

```sh
git tag -d vX.Y.Z
```

## 6. Push only after explicit confirmation

Do not push automatically. Once the user confirms the commit and tag:

```sh
git push origin main vX.Y.Z
```

The push invokes the Husky pre-push gate for `main` and the release tag. A tag
push starts `.github/workflows/ci.yml`:

1. source checks, build/pack, compatibility and ecosystem smoke jobs, and the
   production dependency audit run in parallel;
2. release metadata extracts the bilingual changelog body and blocks on a
   version/date mismatch;
3. `publish` downloads the exact tarball produced and tested by CI, verifies
   its embedded version against the tag, and runs `npm publish` with OIDC;
4. `release` runs only after publish succeeds, then creates or updates the
   GitHub Release and uploads the tarball plus its SHA-256 file.

No `NPM_TOKEN` or local npm credential is used. If a tag workflow fails, fix
the cause and rerun the workflow when appropriate; do not force-move a tag
that has already reached the remote.

## 7. Verify the published release

After CI completes, verify the remote tag, npm version, GitHub Release, and
artifact. If a release is not meant to be published yet, stop after the local
commit and tag and leave the tag unpushed.

```sh
git ls-remote --tags origin vX.Y.Z
npm view @xmoon76/dsh-pi-tui version
gh release view vX.Y.Z --repo XMoon/dsh-pi-tui
```

For the next cycle, `[Unreleased]` is intentionally empty and its comparison
link starts at `vX.Y.Z`.
