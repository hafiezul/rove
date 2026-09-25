# Install Rove Code

Rove Code currently runs from source. This fork has not published a desktop
installer, npm package, hosted web app, or store mobile app. Do not use an
upstream download or package expecting it to install this fork.

## Run from source

Install Node.js 24.13.1 and [Vite+](https://viteplus.dev/guide/). Then run:

```bash
git clone https://github.com/hafiezul/rove.git
cd rove
vp i
vp run dev
```

The development server prints the local web address and pairing information.
For a development desktop app, run `vp run dev:desktop` from the same checkout.
You need an installed, authenticated coding-agent provider before starting a
thread. You can configure providers after opening Rove Code.

This source build has no managed updater. To get changes, pull from this fork
and rebuild. Installers and an update feed will be documented here after this
project publishes and tests its own release artifacts.

Outside a development worktree, Rove Code uses `~/.rove-code` for its data.
The inherited installation's `~/.rove` is left untouched. Do not point both
applications at the same data directory. Importing an existing installation
is not yet supported.

## Mobile app (source builds only)

There are no App Store or Google Play releases from this project. To try the
mobile client, build the development client from source (see
`apps/mobile/README.md`) and pair it with a server on your LAN following
[remote access](./remote-access.md#pair-over-a-lan-or-private-network).

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                     |
| ----------- | -------------------------------------------------------------------------------------------- |
| Codex       | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity | Install and sign in with Google from Rove Code's provider settings.                          |

Provider CLIs must be on the server's `PATH`. If Rove Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when Rove Code can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Rove Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Rove Code](./updating.md): update the app and connected servers.
