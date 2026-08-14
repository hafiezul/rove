# Rove

Rove is an independent, open-source fork of [T3 Code](https://github.com/pingdotgg/t3code): a fast, remote-ready control surface for coding agents.

The project follows T3 Code closely while creating room to explore a different direction for how developers run, guide, and move between coding agents. Rove is not affiliated with or endorsed by T3 Tools or Ping Labs.

## Current status

Rove is at the beginning of its fork. The repository identity and documentation use the Rove name, while the applications, CLI, package names, and storage identifiers still use T3 Code names for upstream compatibility. Expect those technical identifiers to remain unchanged until a migration has a clear user benefit.

The inherited application supports Claude Code, Codex, Cursor, Grok Build, and OpenCode across web, desktop, and mobile clients.

## Run from source

Rove currently has no separate binary distribution. To run the fork locally, install [Vite+](https://viteplus.dev/guide/) and use Node.js 24.13.1:

```bash
vp i
vp run dev
```

The development server prints the local URL and pairing information needed to open the web client.

## Documentation

Start with the [documentation index](./docs). Because Rove currently preserves upstream runtime behavior, much of the product documentation still refers to T3 Code and its existing commands.

Useful starting points:

- [Architecture overview](./docs/internals/overview.md)
- [Install and first run](./docs/user/install.md)
- [Remote access](./docs/user/remote-access.md)
- [Provider architecture](./docs/internals/providers.md)
- [Contributing](./CONTRIBUTING.md)

## Upstream

Rove is built from [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Upstream retains its original copyright and is distributed under the [MIT License](./LICENSE).

When a change is broadly useful and fits T3 Code's direction, contributors should consider proposing it upstream as well.
