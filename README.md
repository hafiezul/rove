# Rove Code

Rove Code is an open-source app for running coding agents on web, desktop, and mobile. Run it on the machine where your agents live, or connect to that machine from another device.

You bring your own subscriptions. If a provider is set up on the host, Rove Code can drive it:

- Codex
- Claude Code
- Cursor
- Grok Build
- OpenCode
- Google Antigravity
- Pi (embedded through its SDK)

## Install

**Desktop:** download a build for macOS, Windows, or Linux from [Releases](https://github.com/hafiezul/rove/releases). Stable and nightly channels are available; nightlies publish daily when there are new commits. macOS builds are self-signed rather than notarized, so you will need to approve the first install. See [Install Rove Code](./docs/user/install.md).

**CLI host** (headless server for LAN, Tailscale, or SSH access):

```sh
npm install -g @rove-code/cli
rove service install
rove pair --tailscale   # or connect over LAN; see remote access docs
```

**Browser:** open [rove.hafiezulzikry.com](https://rove.hafiezulzikry.com) and pair it with a host you run. Every CLI host also serves the web client locally.

**Mobile:** not on the app stores yet. Build the dev client from source and pair it with a host. See the [mobile README](./apps/mobile/README.md).

Installed apps keep their data in `~/.rove-code`. A T3 Code install in `~/.rove` is left alone, and there is no import from it yet.

## Run from source

Install [Vite+](https://viteplus.dev/guide/) (`vp`) and use Node.js 24.13.1:

```sh
vp i
vp run dev            # server + web
vp run dev:desktop    # Electron client
```

Open the pairing URL the dev runner prints. The bare origin will not authenticate a new browser. See the [development runbook](./docs/operations/development.md) for state directories, ports, sharing over Tailscale, and desktop packaging.

## Repository layout

| Path                      | What it is                                              |
| ------------------------- | ------------------------------------------------------- |
| `apps/server`             | WebSocket server, orchestration, provider adapters, CLI |
| `apps/web`                | React/Vite client (also served by the CLI host)         |
| `apps/desktop`            | Electron shell that wraps the web client and the server |
| `apps/mobile`             | React Native client for iOS and Android                 |
| `apps/marketing`          | Landing page                                            |
| `packages/contracts`      | Wire schemas shared by every surface                    |
| `packages/client-runtime` | Client logic shared by web and mobile                   |
| `packages/shared`         | Shared runtime utilities                                |
| `infra/relay`             | Rove Connect relay (off unless cloud is configured)     |

## Documentation

Start at the [documentation index](./docs). Good entry points:

- [Install and first run](./docs/user/install.md)
- [Remote access](./docs/user/remote-access.md)
- [Architecture overview](./docs/internals/overview.md)
- [Providers](./docs/internals/providers.md)
- [Releasing](./docs/operations/release.md)
- [Contributing](./CONTRIBUTING.md)

## Origins and license

Rove Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code) with its own repository, releases, and roadmap. We still pull in upstream changes and keep T3 Tools' original copyright notice under the [MIT License](./LICENSE). Rove Code is not affiliated with or endorsed by T3 Tools or Ping Labs.

If a change would also help T3 Code users, consider proposing it upstream.
