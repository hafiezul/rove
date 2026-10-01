# Rove Code

Rove Code is an open-source app for running coding agents across web, desktop, and mobile. Use it on the computer where your agents run, or connect remotely.

It works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, Rove Code can control them.

## Current status

The applications and documentation use the Rove Code name, but some CLI, package, and storage identifiers still come from T3 Code. T3 Code downloads and services are not Rove Code releases.

## Run from source

Rove Code currently has no separate binary distribution. To run Rove Code locally, install [Vite+](https://viteplus.dev/guide/) and use Node.js 24.13.1:

```bash
vp i
vp run dev
```

The development server prints the local URL and pairing information needed to open the web client.

## Documentation

Start with the [documentation index](./docs). Some product guides still describe upstream distribution paths and commands; use the source instructions above until Rove Code publishes its own builds.

Useful starting points:

- [Architecture overview](./docs/internals/overview.md)
- [Install and first run](./docs/user/install.md)
- [Remote access](./docs/user/remote-access.md)
- [Provider architecture](./docs/internals/providers.md)
- [Contributing](./CONTRIBUTING.md)

## Origins and license

Rove Code started as a fork of [T3 Code](https://github.com/pingdotgg/t3code) and now has its own repository and roadmap. It retains T3 Tools' original copyright notice under the [MIT License](./LICENSE). Rove Code is not affiliated with or endorsed by T3 Tools or Ping Labs.

If a change would help T3 Code users too, consider proposing it upstream.
