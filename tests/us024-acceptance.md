# US-024 Acceptance Criteria: Code Signing + Notarization + Release Workflow

## Overview

Verifies that the GitHub Actions release workflow correctly builds, signs, notarizes, and publishes the macOS universal binary for the hq-installer Tauri app.

---

## AC-1: Workflow triggers on version tags `v*.*.*`

**Check:** The `release.yml` workflow `on:` block includes a `push.tags` filter matching `v*.*.*`.

**Verification:**
1. Open `.github/workflows/release.yml`
2. Confirm the trigger block contains:
   ```yaml
   on:
     push:
       tags:
         - 'v*.*.*'
   ```
3. Push a tag (e.g. `v0.1.0-test`) to the repo and confirm the workflow appears in the Actions tab on GitHub.

**Pass condition:** Workflow run is triggered for version tags and NOT triggered for untagged commits or non-version tags.

---

## AC-2: Workflow runs on `macos-latest` and builds universal binary

**Check:** The build job specifies `runs-on: macos-latest` and invokes `tauri build --target universal-apple-darwin`.

**Verification:**
1. Open `.github/workflows/release.yml`
2. Confirm the build job has `runs-on: macos-latest`
3. Confirm the build step contains the command `tauri build --target universal-apple-darwin` (or equivalent via `tauri-action` with `args: --target universal-apple-darwin`)
4. Review a completed workflow run log and confirm the build step succeeded on a macOS runner

**Pass condition:** The Actions log shows a macOS runner executing the universal build target with no architecture errors.

---

## AC-3: Signs with Apple Developer ID cert from GitHub Actions secrets

**Check:** The workflow imports the certificate from secrets before running `tauri build`, and does not hardcode credential values.

**Verification:**
1. Open `.github/workflows/release.yml`
2. Confirm the following secrets are referenced (not hardcoded):
   - `${{ secrets.APPLE_CERTIFICATE }}` — base64-encoded .p12 certificate
   - `${{ secrets.APPLE_CERTIFICATE_PASSWORD }}` — password for the .p12
3. Confirm a keychain import step exists (e.g. using `security import` or Tauri's built-in signing env vars `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`)
4. Confirm no certificate file or password value appears in plaintext anywhere in the workflow YAML

**Required secrets (must be set in GitHub repo Settings > Secrets and variables > Actions):**

| Secret Name | Description | Source |
|---|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded Apple Developer ID Application .p12 cert | `companies/indigo/settings/` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the .p12 certificate | `companies/indigo/settings/` |
| `APPLE_ID` | Apple ID email used for notarization | `companies/indigo/settings/` |
| `APPLE_ID_PASSWORD` | App-specific password for notarization | `companies/indigo/settings/` |
| `APPLE_TEAM_ID` | Apple Developer Team ID | `companies/indigo/settings/` |

**Pass condition:** All five secrets are present in GitHub repo settings. Workflow log shows a signed binary (no "code object is not signed at all" errors) and signing identity is a Developer ID Application cert.

---

## AC-4: Notarizes via `xcrun notarytool submit --wait`

**Check:** The workflow runs Apple notarization after signing and waits for Apple's servers to return a result before proceeding.

**Verification:**
1. Open `.github/workflows/release.yml`
2. Confirm a notarization step exists, either:
   - Explicit `xcrun notarytool submit <artifact> --apple-id ... --password ... --team-id ... --wait`, OR
   - Tauri's built-in notarization via `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID` env vars (which internally calls notarytool)
3. Review a completed workflow run log and confirm a line matching `Submission ID:` and `status: Accepted` (or equivalent) appears
4. Confirm the workflow does NOT proceed to upload if notarization fails (non-zero exit code halts the job)

**Pass condition:** Workflow log shows notarization submission and an `Accepted` status from Apple before the upload step runs.

---

## AC-5: Uploads signed .zip (zipped .app) as a GitHub release asset

**Check:** The workflow creates a GitHub Release for the tag and attaches the signed, notarized `.app` — archived into `hq-installer_universal.zip` via `ditto` — as a release asset.

**Verification:**
1. Open `.github/workflows/release.yml`
2. Confirm a release upload step exists using one of:
   - `actions/upload-release-asset`
   - `softprops/action-gh-release`
   - Tauri's `tauri-action` with `tagName` / `releaseName` configured
3. Confirm the versionless-alias step uses `ditto -c -k --keepParent --sequesterRsrc` to archive the `.app` (plain `zip -r` strips the stapled notarization ticket)
4. Navigate to the GitHub repo Releases page after a tag push and confirm:
   - A release named after the tag (e.g. `v0.1.0`) is present
   - `hq-installer_universal.zip` is attached as a downloadable asset
   - The extracted `.app` passes Gatekeeper on a clean macOS machine: `spctl --assess --type exec --context context:primary-signature path/to/hq-installer.app`

**Pass condition:** Release page shows a `.zip` asset. Extracted `.app` passes Gatekeeper with no quarantine warning on first launch.

---

## AC-6: README documents the release process and required secrets

**Check:** The project README includes a section covering how to cut a release and which GitHub secrets must be configured.

**Verification:**
1. Open `README.md` in the repo root
2. Confirm a "Release" or "Publishing" section exists containing:
   - Instructions to push a version tag to trigger the workflow
   - The list of five required GitHub secrets (matching AC-3 table above)
   - Where to source the credentials (`companies/indigo/settings/`)
3. Confirm the section is accurate and complete enough for a new contributor to set up the pipeline without additional guidance

**Pass condition:** README section is present, lists all five secrets, and describes the tag-push release trigger.

---

## Summary Checklist

| # | Criterion | How to verify |
|---|---|---|
| AC-1 | Workflow triggers on `v*.*.*` tags | Inspect `release.yml` trigger block; push a test tag |
| AC-2 | Runs on `macos-latest`, universal build | Inspect `runs-on` and build command; review Actions log |
| AC-3 | Signs using secrets (no hardcoded creds) | Inspect YAML for secret refs; verify 5 secrets set in GitHub |
| AC-4 | Notarizes with `--wait` and checks result | Inspect notarization step; confirm `Accepted` in Actions log |
| AC-5 | Uploads signed .zip (zipped .app) as release asset | Check Releases page for asset; run Gatekeeper check on extracted .app |
| AC-6 | README documents release process + secrets | Read README release section for completeness |
