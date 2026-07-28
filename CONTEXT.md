# T3 Code

T3 Code connects a single user experience to independently configured coding-agent providers.

## Language

**Pi**:
Mario Zechner's Pi coding agent, specifically the `@earendil-works/pi-coding-agent` CLI and its native agent/session behavior.
_Avoid_: piAgent, generic Pi

**Supported Pi Version**:
Pi CLI version 0.82.0 or later. The T3 Code Pi integration's contract is defined against the RPC, extension, and `get_commands` behavior available in version 0.82.0.

**Pi Provider**:
The T3 Code provider driver that starts the user-installed Pi CLI in RPC mode and translates its protocol into T3 Code provider events and operations.
_Avoid_: Pi integration, Pi wrapper

**Focused Pi Parity**:
The initial Pi capability set: normal session, streaming, attachment, interruption, model, and approval flows shared with existing providers. Pi-specific features remain deferred until the integration is stable.

**Pi Session Directory**:
The Pi-managed storage directory assigned to one T3 Code Pi provider instance. T3 Code starts threads in persistent-session mode there with their stable native session IDs; Pi materializes the session file lazily while persisting the thread's first accepted prompt turn.

**Pi Provider Configuration**:
Pi's own configuration for credentials, built-in providers, custom providers, and model definitions. Pi remains the source of truth for this configuration; T3 Code may separately configure a Pi runtime instance and presentation preferences.

**Pi Runtime Instance**:
One independently configured connection from T3 Code to Pi, with its own executable/configuration environment and isolated Pi session directory. A runtime instance uses Pi's provider and model configuration without owning it.

**Pi Config Directory**:
The Pi configuration directory selected for a Pi runtime instance. When unset, the instance uses Pi's normal user configuration; when set, T3 Code passes it to Pi as `PI_CODING_AGENT_DIR`.

**Pi Tool Policy**:
Pi's enabled and disabled tool set. In base Pi RPC mode, enabled tools run without T3 Code per-tool confirmation; supervised execution would require a Pi extension that blocks and requests confirmation through Pi's extension UI protocol.

**Trusted Pi Extension**:
A Pi extension path explicitly selected on a Pi runtime instance through T3 Code's trusted-extension setting (or the `T3CODE_PI_EXTENSION` environment escape hatch). T3 Code always starts Pi with `--no-extensions`; only trusted extension selections are passed to Pi as `--extension <path>` arguments, and raw launch arguments cannot load extensions. Slash commands a trusted extension registers surface in the composer `/` menu (parsed from Pi's `get_commands`), and its `ctx.ui.notify` feedback renders as a neutral `extension.notice` timeline row.

**Pi Skill**:
A skill Pi itself loaded, discovered from the `source: "skill"` entries of Pi's `get_commands` response during the no-session probe. Pi's probe output is the single source of truth for which skills exist; T3 Code never scans the filesystem for them. Selecting one in the composer inserts a `$name` token, which the Pi adapter rewrites into Pi's native `/skill:name` expansion on the way out.
_Avoid_: Pi command, Pi prompt template

**Pi Continuation Compatibility**:
The rule that a Pi thread may resume only through the Pi runtime instance that created it, preserving its Pi configuration directory, extensions, credentials, model catalog, and native session storage.

**Pi Entry**:
One node in a Pi session's append-only entry tree, with an ID that is stable across forks. Pi identifies a conversation position by entry, never by turn count.

**Pi Turn Anchor**:
The Pi Entry recorded for a T3 Code turn at the moment it is sent. It is the only accurate way to translate a T3 Code revert target into the entry Pi must fork from, because Pi's fork-message list spans abandoned branches and pre-compaction history and omits text-less prompts.
_Avoid_: turn index, turn count

**Pi Rollback Fork**:
The new Pi session produced when a T3 Code thread is reverted. Pi RPC cannot move a session's leaf in place, so truncating a conversation forks it; the thread keeps its identity while its native session file changes.
_Avoid_: Pi rollback, Pi truncation

**Authoritative Resume Cursor**:
The thread's durable record of which native Pi session to resume. The thread ID names the session Pi first created; once a Pi Rollback Fork has occurred, the resume cursor — not the thread ID — identifies the live session.

**Pi Text Generation Run**:
A single isolated `pi -p` print-mode process used to produce a commit message, PR content, a branch name, or a thread title. It is not a Pi session and never appears in a thread: it inherits only the runtime instance's binary, config directory, and environment, and deliberately loads no tools, extensions, skills, context files, prompt templates, or project-local resources.
_Avoid_: Pi text session, Pi one-shot session

**Pi Context Usage**:
Pi's own measurement of how much of the model's context window a session occupies, reported through its `get_session_stats` response. Pi is the sole authority on it, and it is unknown between a compaction and the next model response.

**Session Liveness**:
Whether a provider process is actually running and able to stream right now, as opposed to a persisted row that says it was. Provider processes are children of the T3 Code server, so no session is live across a server restart.
_Avoid_: session status, running session

**Boot Session Reconciliation**:
The startup sweep that reconciles persisted provider session state against Session Liveness, before any client is told the server is ready.

**Restart Interruption**:
A turn ended by Boot Session Reconciliation rather than by the user or the provider. It is presented distinctly from a user-requested interrupt because the conversation can be resumed.
_Avoid_: crash, abort
