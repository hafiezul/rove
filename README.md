# Rove Code

Rove Code is an independent, open-source fork of [T3 Code](https://github.com/pingdotgg/t3code). It is a fast, remote-ready control surface for coding agents.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, Rove Code can control them.

The fork has its own roadmap for how developers run, guide, and move between coding agents. Rove Code is not affiliated with or endorsed by T3 Tools or Ping Labs.

## Current status

Rove Code is at the beginning of its fork. Its applications and documentation use the Rove Code name, but some CLI, package, and storage identifiers still come from upstream. Do not treat upstream downloads or services as Rove Code releases.

The inherited application supports Claude Code, Codex, Cursor, Grok Build, OpenCode, and Antigravity across web, desktop, and mobile clients.

## Run from source

Rove Code currently has no separate binary distribution. To run the fork locally, install [Vite+](https://viteplus.dev/guide/) and use Node.js 24.13.1:

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

## Upstream

This fork retains the upstream copyright notice under the [MIT License](./LICENSE).

When a change is broadly useful and fits Rove Code's direction, contributors should consider proposing it upstream as well.
