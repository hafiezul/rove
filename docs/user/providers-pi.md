# Pi extensions

Pi threads load extensions from the Pi installation on the machine running the Rove server. Remote clients use that server's extensions, not extensions installed on the client device.

To keep separate Pi configurations, set **Pi agent directory** for each instance in provider settings. Each directory has its own credentials, models, saved sessions, and global extensions. Leave it blank to use the server's default Pi directory. Instances using the same directory can continue each other's threads.

## Built-in Rove tools

Pi threads automatically receive Rove's browser-preview tools, including navigation, page inspection with screenshots, interaction, and recording. No Pi extension or MCP configuration is required. These tools use the thread's authorization and remain available when user extensions are disabled.

Tools run through the connected Rove server, including when you control a thread remotely. Browser automation still requires an automation-capable preview client. This built-in connection does not load arbitrary MCP servers from Pi settings.

## Session recovery

Rove saves each Pi session's identity and absolute file location on the server. Sessions remain recoverable when a thread's working directory changes, provided the saved file remains accessible. Older sessions without a saved file location use Pi's working-directory lookup.

Rollback positions are saved as exact session-tree boundaries, so steering messages sent while a turn runs never count as extra turns. Threads whose history predates exact boundaries cannot roll back; start a new thread instead.

If history is missing, unreadable, empty, or belongs to another session, startup fails instead of silently starting an empty conversation. Restore the session file or storage access on the server, then retry the turn. To continue without that history, create a new thread. The original thread keeps its saved session reference for recovery.

New sessions are saved before the first prompt, so restarting before the first assistant response does not invalidate their session reference.

## Progress and diagnostics

The thread activity timeline shows when Pi is retrying or compacting context,
and when that work finishes or stops. Failed compaction is labeled as a failure
with its error details. These notices do not complete the turn.
Streaming tools show short, rate-limited previews of their latest output; the
completed tool result remains the authoritative output. The same activity reaches local and
remote clients.

Provider diagnostics report the Pi version bundled with Rove, not a separately
installed Pi CLI. Session startup, catalog startup, and turn preparation waits are
limited to 60 seconds; cleanup waits are limited to 5 seconds. Waiting for your
answer to an extension question does not use the turn preparation deadline. A
startup timeout is reported as a failure, not a successful empty session. These
limits cannot protect against an extension that blocks or exits the server process.

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

The Extensions button beside the Pi provider selector opens the global provider catalog. Project-local extensions load in their project's threads but do not appear in this panel.

- Discovered global extension names, scope, source, tools, and commands.
- A per-extension switch on each row. Off removes that extension from Pi sessions.
- Model providers with authentication and model counts.
- Load warnings, catalog refresh errors, and notices when an active extension asks for Pi terminal-only controls.

A disabled extension stays listed in the discovered inventory so it can be turned back on. A compatibility notice may come from a project extension in an active thread, even when that extension is not listed in the global inventory. Disabling filters the extension out before its factory executes, and excludes its models from both the catalog host and thread sessions. When an extension is disabled, the change is applied after active turns settle rather than disrupting live streams. The change is saved per provider instance in settings and survives restarts.

The panel needs no thread. It shows whenever a Pi provider instance is selected, on web and mobile. An extension appearing here does not mean every feature works without Pi's terminal. See Limitations.

## Selecting extension models

Extension models behave like any other Pi model. Clicking one saves it to the thread. If the extension is later removed, the thread falls back to a model the runtime still lists instead of keeping a stale slug.

The composer's slash menu lists prompt templates from Pi's configuration and commands registered by loaded global extensions. Project extension commands run when typed in that project's thread, but they do not appear in the slash menu. Skills and prompt templates follow Pi's user scope; a project's own resources appear inside that project's threads.

## Model fallback

A thread always shows the model and reasoning level the session actually runs. When Pi cannot restore a session's saved model, falls back to a custom model id, or clamps a reasoning level the model does not support, the thread shows a warning describing the effective selection. A model slug that cannot be resolved at all fails thread startup with that reason instead of silently running a different model.

## Reasoning levels

The Reasoning picker offers the levels declared by each model in Pi's catalog. Models without reasoning offer only **Off**. Models can omit individual levels, including **Off**, **Extra High**, or **Max**. Rove does not offer reasoning overrides for models whose capabilities are not yet known.

The default follows the Rove provider's thinking override, then Pi's per-model preference, then Pi's global default. Pi adjusts unsupported defaults to a supported level. Switching models keeps a supported selection or falls back to the new model's default.

In provider Settings, thinking choices follow the configured model. An old unsupported override is marked unavailable. **Use Pi default** clears it.

Rove reads these capabilities from the server's loaded Pi catalog. This adds no inference requests, token charges, or network refreshes. Custom providers must declare accurate `reasoning` and `thinkingLevelMap` metadata in Pi. Rove does not send paid requests to test whether an endpoint honors that metadata.

## Supported behavior

- Extension tools run through Pi and appear as tool calls in Rove. The bundled `examples/extensions/subagent` extension also shows its single, parallel, and chain children in **Agents** on web and desktop, and in the thread work log on mobile. Child updates show identity and available usage while the tool runs; the final result settles each child. This applies to that bundled example, not arbitrary Pi subagent extensions.
- Image attachments are inlined into Pi prompts, so the model sees the image itself. Models without image input reject image attachments with a clear error instead of answering without the image.
- Other file attachments reach Pi as saved-file paths in the message text, like the other providers; open them with file tools.
- Stopping a thread discards queued steering and follow-up messages, dismisses extension questions, aborts the live response, and retires the session. Background agent work reported before Stop is marked stopped, and late events cannot revive the stopped session. The next message starts a fresh runtime from the saved history; it does not automatically replay unfinished work.
- Manual context compaction is available from the context meter while the thread is idle; failed compaction is reported as a failure.
- Input, agent, tool, context, and compaction hooks run through Pi.
- Extension commands run when typed as `/command arguments` while the thread is idle, and loaded extension commands appear in the composer's slash menu alongside prompt templates.
- Session startup hooks run before the first prompt, when the thread can receive and answer extension questions. Shutdown hooks run during disposal; a stuck hook cannot prevent the SDK's local cleanup.
- Extension state can persist in Pi's session history.
- When extensions are disabled in the extensions panel, the session's system prompt lists them. Ask the thread agent about its loaded extensions and it can answer from its own session instead of Pi's settings file.
- When the session's effective model or reasoning level differs from the request, the thread shows a warning with the effective selection.

A command or input hook that handles a prompt without calling a model still completes the Rove turn. Load failures prevent the failing extensions from loading: the session starts without them and the thread shows a warning naming each skipped extension. Runtime extension errors appear as warnings.

## Extension questions and messages

Standard extension selections, confirmations, and text questions appear in the thread on web, desktop, and mobile, including remote connections. Answer the pending question before sending another message, or use Stop to cancel it. Extension-supplied timeouts and cancellation signals dismiss questions automatically; cancelled confirmations return `false`, not approval.

Multi-line editor requests use a text question with the extension's existing text prefilled as the answer. Edit or submit that text, including an empty replacement, without replacing your normal thread draft. Editor answers preserve whitespace. Rove rejects editor prefill longer than 65,536 characters instead of truncating it. Selection dialogs support up to 256 choices.

Extension notifications and visible custom-message text appear in activity. Status text from `ctx.ui.setStatus()` appears above the composer and updates while the extension supplies a value. If the extension clears a status, it disappears. String-array widgets remain rate-limited activity snapshots. Hidden extension context stays hidden.

## Limitations

Thread extensions receive `ctx.mode === "rpc"` and `ctx.hasUI === true`. This does not provide a terminal: custom components, keyboard shortcuts, custom renderers, editor replacement, autocomplete providers, and terminal themes are not reproduced. Custom components are not executed and return no value. Raw terminal-input listeners and component widgets do not run in Rove. If an active extension requests terminal-only controls, the Pi Extensions panel shows a compatibility notice instead of adding a warning to the thread. The notice clears when the affected session ends. Extension load and runtime failures still appear in thread activity, and failed tools still show an error in their results. Extensions should guard terminal-only features with `ctx.mode === "tui"` and use standard dialogs for remote interaction.

Session replacement, tree navigation, and reload requested by extension commands are rejected. Rove owns thread navigation and session identity. The panel's Refresh is not Pi's `/reload`: it re-reads the server's catalog and never restarts an active thread's session.

Background text generation, including thread titles, does not load extensions or expose tools, and keeps no session history. Other providers are unchanged.
