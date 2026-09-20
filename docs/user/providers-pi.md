# Pi extensions

Pi threads load extensions from the Pi installation on the machine running the Rove server. Remote clients use that server's extensions, not extensions installed on the client device.

## Session recovery

Rove saves each Pi session's identity and absolute file location on the server. Sessions remain recoverable when a thread's working directory changes, provided the saved file remains accessible. Older sessions without a saved file location use Pi's working-directory lookup.

If history is missing, unreadable, empty, or belongs to another session, startup fails instead of silently starting an empty conversation. Restore the session file or storage access on the server, then retry the turn. To continue without that history, create a new thread. The original thread keeps its saved session reference for recovery.

New sessions are saved before the first prompt, so restarting before the first assistant response does not invalidate their session reference.

## Extension sources

Rove uses Pi's standard resource loader for these sources:

- Global extensions in `~/.pi/agent/extensions/`.
- Project extensions in `.pi/extensions/` under the thread's working directory.
- Extension paths and Pi packages configured in global or project `settings.json`.

`PI_CODING_AGENT_DIR` overrides the global Pi directory. Pi's resource filters still apply. Extension changes take effect when Rove creates the next Pi session. Existing sessions keep their loaded extensions until their next turn after a settings change, such as disabling an extension in the extensions panel.

Project resources are trusted within Rove sessions. This does not change Pi's global trust settings. Extensions execute inside the Rove server with its permissions. A faulty extension can affect other threads or the server itself.

## Models from extensions

Each Pi provider instance keeps one catalog host: a long lived runtime that loads global extensions once and publishes their models to the provider snapshot. Every picker lists them with no per thread work. No model inference runs during loading.

Extension models stay in the Pi provider. Other providers are unchanged. A project local extension that registers models stays invisible globally and keeps working inside its own threads.

Some extensions register cached models first and refresh in the background. The snapshot republishes when registrations land, and the regular provider health check backstops a missed push. If a provider needs login, its models stay hidden until authentication succeeds, and the catalog panel labels the provider Not authenticated. Use Pi on the server machine to authenticate, then use Refresh catalogue in Rove.

Refresh re-reads extension files and model catalogs from the server's Pi config, so newly installed or removed extensions appear in the panel with their models. New and reloaded sessions always read the config fresh, and an existing thread adopts changes on its next turn after a settings update, such as toggling an extension. Typing Pi's `/reload` inside a Rove thread does nothing: Rove rejects session replacement from extensions and owns reloading. Use the panel refresh and the extension switches instead.

## Extensions panel

The Extensions button beside the Pi provider selector opens the provider catalog:

- Loaded extension names, scope, source, tools, and commands.
- A per-extension switch on each row. Off removes that extension from Pi sessions.
- Model providers with authentication and model counts.
- Load warnings and catalog refresh errors.

A disabled extension stays listed in the discovered inventory so it can be turned back on. Disabling filters the extension out before its factory executes, and excludes its models from both the catalog host and thread sessions. When an extension is disabled, the change is applied after active turns settle rather than disrupting live streams. The change is saved per provider instance in settings and survives restarts. Project extensions keep their own scope: the switch removes that extension from every Pi session that loads it.

The panel needs no thread. It shows whenever a Pi provider instance is selected, on web and mobile. Loaded means initialization succeeded. It does not mean every feature works headlessly. See Limitations.

## Selecting extension models

Extension models behave like any other Pi model. Clicking one saves it to the thread. If the extension is later removed, the thread falls back to a model the runtime still lists instead of keeping a stale slug.

## Reasoning levels

The Reasoning picker offers the levels declared by each model in Pi's catalog. Models without reasoning offer only **Off**. Models can omit individual levels, including **Off**, **Extra High**, or **Max**. Rove does not offer reasoning overrides for models whose capabilities are not yet known.

The default follows the Rove provider's thinking override, then Pi's per-model preference, then Pi's global default. Pi adjusts unsupported defaults to a supported level. Switching models keeps a supported selection or falls back to the new model's default.

In provider Settings, thinking choices follow the configured model. An old unsupported override is marked unavailable. **Use Pi default** clears it.

Rove reads these capabilities from the server's loaded Pi catalog. This adds no inference requests, token charges, or network refreshes. Custom providers must declare accurate `reasoning` and `thinkingLevelMap` metadata in Pi. Rove does not send paid requests to test whether an endpoint honors that metadata.

## Supported behavior

- Extension tools run through Pi and appear as tool calls in Rove.
- Image attachments are inlined into Pi prompts, so the model sees the image itself. Models without image input reject image attachments with a clear error instead of answering without the image.
- Input, agent, tool, context, and compaction hooks run through Pi.
- Extension commands run when typed as `/command arguments` while the thread is idle.
- Session startup and shutdown hooks run when Rove creates and disposes sessions.
- Extension state can persist in Pi's session history.
- When extensions are disabled in the extensions panel, the session's system prompt lists them. Ask the thread agent about its loaded extensions and it can answer from its own session instead of Pi's settings file.

A command or input hook that handles a prompt without calling a model still completes the Rove turn. Load failures prevent the session from starting. Runtime extension errors appear as warnings.

## Limitations

Extensions run headlessly with `ctx.mode` set to `"print"` and `ctx.hasUI` set to `false`.

Dialogs are unavailable. Confirmations return `false`; selection and text-input dialogs return no value. Notifications, widgets, keyboard shortcuts, custom message renderers, and terminal components are not displayed in Rove. Extensions that require these features need a headless fallback.

Session replacement, tree navigation, and reload requested by extension commands are rejected. Rove owns thread navigation and session identity. The panel's Refresh is not Pi's `/reload`: it re-reads the server's catalog and never restarts an active thread's session.

Background text generation, including thread titles, does not load extensions. Other providers are unchanged.
