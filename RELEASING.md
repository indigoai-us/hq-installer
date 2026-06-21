# Releasing hq-installer

Releases are **manual and tag-driven**, the same model HQ Sync uses. There is no
longer an auto-release-on-merge workflow (it used to push a version bump straight
to `main`, which is incompatible with `main` being protected/PR-only).

## How to cut a release

1. **Bump the version** in a normal PR. Update all four files so they agree:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/Cargo.lock` (the `hq-installer` package entry)
   - `src-tauri/tauri.conf.json`
2. **Merge** the version-bump PR to `main` (CI must be green).
3. **Push the matching tag** from `main`:
   ```bash
   git checkout main && git pull
   git tag v<X.Y.Z>      # must equal the version in the four files above
   git push origin v<X.Y.Z>
   ```
   `release.yml` validates that the tag equals all four version files and fails
   loudly if they disagree — so a mismatched tag can never ship a wrong version.

The tag push triggers `.github/workflows/release.yml`, which builds, signs, and
notarizes the macOS + Windows installers and publishes the GitHub Release.

## Manual / re-run

`release.yml` also accepts a `workflow_dispatch` with a `tag` input if you need
to re-run a release for an existing tag.
