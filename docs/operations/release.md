# Releasing Rove Code

> Maintainer procedure. Public installation instructions live in [the user guide](../user/install.md).

## Current status

**Do not publish yet.** This fork has not shipped its own installers or npm packages. The GitHub Release, relay deployment, and mobile production workflows are disabled. `.github/workflows/release.yml` accepts manual dispatch only and its first job requires `ROVE_RELEASE_READY=true`; do not set that variable as a shortcut around the gates below.

The first release is **self-hosted desktop and CLI, with local or LAN pairing**. Hosted web, Rove Connect relay, mobile stores, AUR, automatic updates, and marketing-site downloads are separate releases. The inherited unified workflow still requires production relay/Clerk configuration, so it is **not** a usable self-hosted-only publisher. Hosted web and marketing jobs have separate opt-in variables and hosted domains no longer fall back to upstream, but the remaining relay dependency must be removed or isolated before a self-hosted release. Do not enable an inherited publisher to try a build.

## Before enabling publication

1. Confirm that the repository, domains, npm scope, signing accounts, vulnerability reporting, and legal/support contacts belong to this project. Preserve upstream MIT attribution. In particular, verify ownership of the `@rove` npm scope and configure trusted publishing for `@rove/cli` and every `@rove/cli-<platform>` package; a package-name lookup alone does not prove control.
2. Run `node scripts/check-release-identity.mjs` and triage each finding. Some `t3` identifiers are persisted data or wire contracts and must not be bulk-replaced; package names, public URLs, downloads, and legal claims must point to Rove-owned resources or be removed.
3. Keep the source server workspace package (`apps/server/package.json`, `name: t3`) private. Its name is used by Effect's deterministic service keys; it is **not** the published CLI. `scripts/build-npm-platform-packages.ts` produces the separate `@rove/cli` launcher, its `rove` command, and the platform packages. The source package must never be published as `t3`.
4. Verify the installer, archive, npm launcher, SSH runtime, WSL payload, desktop identity, and background service resolve to the **same** Rove artifact and isolated state paths. The fork defaults to `~/.rove-code`, not inherited `~/.rove`. An import from inherited data is not yet available; never point a release at the live inherited directory to simulate one.
5. Separate the relay dependency from the self-hosted artifact jobs in `.github/workflows/release.yml`. Keep hosted web (`ROVE_HOSTED_RELEASE_READY`) and marketing (`ROVE_MARKETING_RELEASE_READY`) off, and keep cloud and store-mobile workflows disabled until they have independent infrastructure and their own review.
6. Check repository CI and focused tests under the supported Node version (`package.json`). Build the platform matrix on its supported hardware, verify signatures/notarization as applicable, and inspect every archive and npm tarball for package identity, executable name, URL, and checksum. Verify release notes and update metadata refer only to this repository.
7. **Download the Rove-built artifacts** from a staging release and test them on clean machines: macOS arm64/x64, Linux x64/arm64, Windows x64/arm64, plus CLI archive and npm launcher for each supported target. Exercise installation, first run, local/LAN pairing, service install/restart/uninstall, WSL on Windows, and upgrade/rollback. Confirm that inherited T3 state is untouched. Source-tree tests alone do not clear this gate.
8. Review the result with a maintainer before enabling the release variable, tag/schedule triggers, or any publisher. Publish only the paths that passed staging. Keep disabled channels disabled.

No credentials or production databases should be copied into a worktree for verification. Use isolated development state. Do not publish to npm or create a GitHub Release while investigating failures.
