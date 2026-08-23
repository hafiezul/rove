# Rove Code documentation

Rove Code is an independent fork of an upstream coding-agent control surface. The inherited user and internals documentation has been rebranded to **Rove Code**, including the `~/.rove` state directory. A few deep technical identifiers inherited from upstream (the `@t3tools/*` npm scope and `t3` CLI name) remain unchanged until a migration has a clear user benefit.

## Using the application

- [Install Rove Code](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [SnapShots](./user/snap-shot.md)
- [Import browser sessions](./user/browser-import.md)
- [Devices](./user/devices.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Running in the background](./user/background-service.md)
- [Updating Rove Code](./user/updating.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md)

---

## Working on Rove Code

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [Rove Connect](./internals/rove-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Devices](./internals/devices.md)
- [Voice input](./internals/voice-input.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [Rove Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
