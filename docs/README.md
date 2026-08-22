# Rove documentation

Rove is an independent fork of an upstream coding-agent control surface. The inherited user and internals documentation has been rebranded to **Rove**, including the `~/.rove` state directory. A few deep technical identifiers inherited from upstream (the `@t3tools/*` npm scope and `t3` CLI name) remain unchanged until a migration has a clear user benefit.

## Using the application

- [Install and first run](./user/install.md)
- [Permission modes](./user/permission-modes.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Review usage](./user/usage.md)
- [Customize a project icon](./user/project-settings.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [Background service (Linux)](./user/background-service.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on Rove

Setup lives in the [root README](../README.md), contribution guidance in [CONTRIBUTING.md](../CONTRIBUTING.md), and agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [Workspace layout](./internals/workspace-layout.md)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [CI gates](./internals/ci.md)

### Runbooks

- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
