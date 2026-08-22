# Rove

Rove is an independent, open-source fork of [Rove](https://github.com/rovedev/rove): a fast, remote-ready control surface for coding agents.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, Rove can control them.

The project follows Rove closely while creating room to explore a different direction for how developers run, guide, and move between coding agents. Rove is not affiliated with or endorsed by T3 Tools or Ping Labs.

## Current status

Rove is at the beginning of its fork. The repository identity and documentation use the Rove name, while the applications, CLI, package names, and storage identifiers still use Rove names for upstream compatibility. Expect those technical identifiers to remain unchanged until a migration has a clear user benefit.

The inherited application supports Claude Code, Codex, Cursor, Grok Build, OpenCode, and Antigravity across web, desktop, and mobile clients.

## Run from source

Rove currently has no separate binary distribution. To run the fork locally, install [Vite+](https://viteplus.dev/guide/) and use Node.js 24.13.1:

```bash
vp i
vp run dev
```

The development server prints the local URL and pairing information needed to open the web client.

## Documentation

Start with the [documentation index](./docs). Because Rove currently preserves upstream runtime behavior, much of the product documentation still refers to Rove and its existing commands.

Useful starting points:

- [Architecture overview](./docs/internals/overview.md)
- [Install and first run](./docs/user/install.md)
- [Remote access](./docs/user/remote-access.md)
- [Provider architecture](./docs/internals/providers.md)
- [Contributing](./CONTRIBUTING.md)

## Upstream

Rove is built from [rovedev/rove](https://github.com/rovedev/rove). Upstream retains its original copyright and is distributed under the [MIT License](./LICENSE).

When a change is broadly useful and fits Rove's direction, contributors should consider proposing it upstream as well.
