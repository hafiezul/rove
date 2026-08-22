# Rove

Rove is an independent, open-source fork of an upstream coding-agent control surface: a fast, remote-ready control surface for coding agents.

The project follows the upstream project closely while creating room to explore a different direction for how developers run, guide, and move between coding agents. Rove is not affiliated with or endorsed by the upstream authors.

## Current status

Rove is at the beginning of its fork. The repository identity and documentation use the Rove name. Application identifiers have been renamed to Rove, including environment variables (`ROVE_*`), URL schemes (`rove://`), bundle IDs, package names, and the `~/.rove` state directory. A few deep technical identifiers inherited from upstream (for example the `@t3tools/*` npm scope and `t3` CLI name) remain unchanged until a migration has a clear user benefit.

The inherited application supports Claude Code, Codex, Cursor, Grok Build, and OpenCode across web, desktop, and mobile clients.

## Run from source

Rove currently has no separate binary distribution. To run the fork locally, install [Vite+](https://viteplus.dev/guide/) and use Node.js 24.13.1:

```bash
vp i
vp run dev
```

The development server prints the local URL and pairing information needed to open the web client.

## Documentation

Start with the [documentation index](./docs).

Useful starting points:

- [Architecture overview](./docs/internals/overview.md)
- [Install and first run](./docs/user/install.md)
- [Remote access](./docs/user/remote-access.md)
- [Provider architecture](./docs/internals/providers.md)
- [Contributing](./CONTRIBUTING.md)

## Upstream

Rove is built from an upstream open-source project that retains its original copyright and is distributed under the [MIT License](./LICENSE).

When a change is broadly useful, contributors should consider proposing it upstream as well.
