# Releasing Rove Code

> Maintainer procedure. Public installation instructions live in [the user guide](../user/install.md).

## Current status

`.github/workflows/release.yml` schedules nightlies daily at 00:00 UTC from the default branch. Scheduled runs skip building and publishing when there are no commits ahead of the latest published nightly or that nightly was published less than six hours ago. Publication requires `ROVE_RELEASE_READY=true`; do not enable it as a shortcut around the gates below.

Manual runs support stable, nightly, and preview, and default to `build_only=true`: checked produces downloadable Actions artifacts without publishing to npm or creating a GitHub Release. Uncheck it to publish; npm uses `latest` for stable, `nightly` for nightly, and `preview` for preview. Manual nightly and preview runs build the selected ref without the scheduled no-change check. Publishing stable builds the latest published nightly's commit, with its base version unless a version override is supplied. The override changes the version, not the commit. Stable build-only runs instead build the selected ref and require an explicit version; nightly and preview generate their own versions.

The first release is **self-hosted desktop and persistent CLI hosts, with local, LAN, Tailscale, and desktop SSH connections**. Leave `ROVE_CLOUD_READY` unset: relay deployment and configuration are skipped, and desktop/CLI builds omit Rove Connect. Apple and Azure signing credentials may be omitted for unsigned builds. Signed macOS previews require `ROVE_MACOS_SIGNING_READY=true`; mobile production requires `ROVE_MOBILE_STORES_READY=true` because store distribution needs paid developer accounts. Hosted web, AUR, and marketing retain separate readiness controls; those controls indicate release readiness, not necessarily a paid service.

The static browser app deploys to Cloudflare. See the [Cloudflare deployment procedure](./cloudflare-web.md). When `ROVE_CLOUDFLARE_WEB_READY=true`, stable releases deploy to `rove.hafiezulzikry.com` and nightlies deploy to the separate `rove-nightly.hafiezulzikry.com` origin. Preview releases deploy neither. Marketing deploys only on stable releases when `ROVE_MARKETING_RELEASE_READY=true`. These deployments do not require the relay gate.

For the identity migration, stage protocol version 2 clients and servers together. If Connect is enabled,
stage the matching relay before connecting those clients. Native module names changed, so mobile requires
new iOS and Android binaries, not a JavaScript-only update. Test an upgrade with existing preferences,
attachments, notification history, credentials, and checkpoint refs. Android widgets may need to be
added again after their receiver class changes.

Before publishing new project-file schema links, deploy the web or marketing build and verify that
`https://rove.hafiezulzikry.com/schema/rove.json` returns the generated JSON Schema rather than the
app's HTML fallback. Source-tree generation does not clear this deployment gate.

## Before enabling publication

1. Confirm that the repository, domains, npm scope, signing accounts, vulnerability reporting, and legal/support contacts belong to this project. Preserve upstream MIT attribution. In particular, verify ownership of the `@rove-code` npm scope and configure trusted publishing for `@rove-code/cli` and every `@rove-code/cli-<platform>` package; a package-name lookup alone does not prove control.
2. Run `node scripts/check-release-identity.mjs` and triage each finding. The check scans public marketing, hosted-web, and mobile-store identity; it reports gated channels but blocks a channel only when its release-readiness variable is enabled. Saved-data and protocol identifiers require explicit migrations, not bulk replacements; package names, public URLs, downloads, and legal claims must point to Rove-owned resources or be removed.
3. Keep the source server workspace package (`apps/server/package.json`, `name: @rove-code/server`) private. Its name is used by Effect's deterministic service keys; it is **not** the published CLI. `scripts/build-npm-platform-packages.ts` produces the separate `@rove-code/cli` launcher, its `rove` command, and the platform packages. The source package must never be published.
4. Verify the installer, archive, npm launcher, SSH runtime, WSL payload, desktop identity, and background service resolve to the **same** Rove artifact and isolated state paths. The fork defaults to `~/.rove-code`, not inherited `~/.rove`. An import from inherited data is not yet available; never point a release at the live inherited directory to simulate one.
5. Keep `ROVE_CLOUD_READY`, `ROVE_MOBILE_STORES_READY`, and `ROVE_MACOS_SIGNING_READY` off until their paid infrastructure or credentials are available. Keep hosted web (`ROVE_CLOUDFLARE_WEB_READY`) and marketing (`ROVE_MARKETING_RELEASE_READY`) off until their independent deployment review is complete. The source-only marketing page uses this repository's free GitHub build guides; set `ROVE_MARKETING_SITE_URL` to a verified deployed origin before publishing for canonical and social URLs. Without it those tags are omitted. Review and replace the inherited legal pages and desktop screenshot before enabling marketing; the text check cannot inspect image assets.
6. Check repository CI and focused tests under the supported Node version (`package.json`). Build the platform matrix on its supported hardware, verify signatures/notarization as applicable, and inspect every archive and npm tarball for package identity, executable name, URL, and checksum. Verify release notes and update metadata refer only to this repository.
7. **Download the Rove-built artifacts** from a staging release and test them on clean machines: macOS arm64/x64, Linux x64/arm64, Windows x64/arm64, plus CLI archive and npm launcher for each supported target. Exercise installation, first run, local and LAN pairing, Tailscale HTTPS, service install/restart/uninstall, systemd-enabled WSL, and upgrade/rollback. Verify that the address, port, provider PATH, environment ID, paired-client authorization, and threads survive an update. Verify that disconnecting desktop SSH leaves its host service running. Connect deployments must also retain cloud links and recover their managed tunnel after updates. Native Windows service installation must fail with its supported-platform explanation, not fall back to a disposable process. Confirm that state outside the selected Rove home is untouched. Source-tree tests alone do not clear this gate.
8. Review the result with a maintainer before enabling the release variable, tag/schedule triggers, or any publisher. Publish only the paths that passed staging. Keep disabled channels disabled.

No credentials or production databases should be copied into a worktree for verification. Use isolated development state. Do not publish to npm or create a GitHub Release while investigating failures.

## Build self-signed macOS artifacts without Apple membership

This mode signs desktop and CLI artifacts with your own certificate. It does not provide Apple notarization or Apple-provisioned native passkeys. Users must approve the initial unnotarized installation. Do not enable `ROVE_MACOS_SIGNING_READY` for this mode. That variable controls the separate Apple-signed PR preview workflow.

1. Create a self-signed Code Signing identity in Keychain Access. Export the certificate and private key as a password-protected `.p12`. Keep an encrypted backup of the identity and its password. Use the same identity for every release.
2. Add the Base64-encoded `.p12` as the repository Actions secret `CSC_LINK`. Add its export password as `CSC_KEY_PASSWORD`. Do not put either value in source control or logs.
3. Add the repository Actions variable `MACOS_SIGNING_MODE` with value `self-signed`. The default certificate name is `Rove Code Release Signing`. If you chose another name, set `MACOS_SIGNING_IDENTITY` to that exact name.
4. Push the workflow and signing scripts to the ref you want to build. Dispatch `release.yml` with `channel=preview` and `build_only=true`. Keep publication disabled during verification.
5. Check the macOS job for successful identity import and packaged-app signature verification. Download its desktop and CLI artifacts. Follow the job summary's first-install guidance only for artifacts you trust.
6. Test installation and a two-version auto-update on a Mac that does not have your certificate installed. Use an update feed configured before signing the test builds. Confirm that a same-certificate update installs and relaunches, and that a different-certificate update fails. Do not treat CI signature verification as proof that auto-update works.

Unsigned or differently signed installations may require a one-time manual reinstall before they can follow the new signing identity. Losing or replacing the certificate can break update continuity.

## Build self-signed Windows artifacts without Azure

Windows self-signing is free. It does not provide public certificate trust or remove SmartScreen warnings. Users must trust the public certificate before signature-checked updates can install. Keep update signature verification enabled.

1. On macOS or Linux with OpenSSL 3, create the identity outside the repository:

   ```sh
   printf 'Certificate password: '
   read -r -s ROVE_CERTIFICATE_PASSWORD
   printf '\n'
   export ROVE_CERTIFICATE_PASSWORD
   bash scripts/create-windows-signing.sh "$HOME/.config/rove-release-signing/windows"
   ```

2. Back up the `.pfx` and its password securely. Reuse this identity for every release. Replacing it requires users to trust the new certificate.
3. Set separate Windows Actions secrets and enable the mode:

   ```sh
   base64 < "$HOME/.config/rove-release-signing/windows/rove-windows-signing.pfx" | gh secret set WIN_CSC_LINK
   printf '%s' "$ROVE_CERTIFICATE_PASSWORD" | gh secret set WIN_CSC_KEY_PASSWORD
   gh variable set WINDOWS_SIGNING_MODE --body self-signed
   unset ROVE_CERTIFICATE_PASSWORD
   ```

4. Run a build-only preview. Check both Windows jobs for successful signing and signature verification. The public `rove-windows-signing.cer` is included with the installers and CLI archives. The private `.pfx` is never published.
5. Test installation and a two-version update on Windows with the certificate trusted. Confirm that a changed payload or different signing certificate fails verification.

CI runs native signing tests and updater, schema, and preview checks on Windows x64 and arm64. The broader Windows suite remains manual. These checks do not replace an installed-app upgrade test. Leave `WINDOWS_SIGNING_MODE` unset to retain the existing Azure signing path.

## First npm publication (free)

The `@rove-code` organization must own the launcher and all five platform packages. npm trusted publishers are configured per package, after its initial publication; creating the organization alone does not enable OIDC publishing.

1. Merge the workflow to `main`, then dispatch a non-publishing preview build:

   ```sh
   gh workflow run release.yml --ref main -f channel=preview -F build_only=true
   ```

2. After quality checks and all platform builds pass, download the `npm-packages` artifact from that run. It contains `cli.tgz` and five `cli-<platform>.tgz` tarballs. Inspect their manifests and test the accompanying desktop and CLI artifacts before publishing. Do not bootstrap from placeholder packages or a stable-version build: use the generated preview version so `0.0.1` remains available.
3. As a maintainer, log in with `npm login` (with account 2FA enabled), then publish the inspected platform tarballs first and launcher last from the extracted artifact directory:

   ```sh
   for package in cli-*.tgz; do
     npm publish "$package" --access public --tag preview || exit 1
   done
   npm publish cli.tgz --access public --tag preview
   ```

   This is a real public publication, not a validation step. No npm token belongs in GitHub secrets. A local initial publication does not use GitHub OIDC provenance.

4. In each package's npm settings, add a GitHub Actions trusted publisher: owner `hafiezul`, repository `rove`, workflow `release.yml`, environment blank. Configure all six packages: `@rove-code/cli`, `@rove-code/cli-darwin-arm64`, `@rove-code/cli-linux-x64`, `@rove-code/cli-linux-arm64`, `@rove-code/cli-win32-x64`, and `@rove-code/cli-win32-arm64`.
5. After staging approval, enable `ROVE_RELEASE_READY` and explicitly dispatch `channel=nightly`, `build_only=false`. A fresh run generates a new prerelease version instead of attempting to overwrite the bootstrap version. Verify that release before dispatching stable with `version=0.0.1`, `build_only=false`. Stable builds the latest published nightly commit, not the current branch, even with a version override.

Finalization uses a GitHub App installed on this repository with Contents write permission. Store its App ID and PEM key as `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`; branch rules must permit its version-bump commit. npm publishing and finalization have no extra readiness switches.
