# Rove

Rove is a minimal GUI for coding agents: a WebSocket server wraps provider runtimes and serves web, desktop, and mobile clients. This glossary covers terms that are specific to Rove's provider-integration domain.

## Language

**Provider**:
The agent runtime that does the actual work behind a thread (Codex, Claude, Cursor, Grok, OpenCode, Pi). The orchestration layer does not know which provider is behind a thread.

**Thread memory**:
The provider's own conversation history for a thread (e.g. Pi's session tree). Distinct from the checkpoint: reverting files never implicitly reverts thread memory.
_Avoid_: conversation state, context

**Checkpoint**:
A hidden git ref captured at each turn boundary. Reverting a checkpoint resets workspace files only; it never touches thread memory.
_Avoid_: snapshot, savepoint

**Sterile Pi**:
A Pi session running with the user's global Pi configuration (auth, model catalog, skills, prompt templates) but with extensions disabled. The default shape of Pi sessions in Rove until extension UI dialogs are wired.
_Avoid_: clean Pi, sandboxed Pi

**Fork-as-rollback**:
Rove's thread rollback realized as a Pi session-tree fork: the session is forked N turns back and the fork becomes the thread's live session. User-facing copy says "Fork Pi session", not "Rollback", because the semantics differ from other providers' rollback.
_Avoid_: Pi rollback

**Driver**:
The per-provider integration unit registered in `BUILT_IN_DRIVERS` (config schema + factory producing snapshot, adapter, and text-generation closures).
_Avoid_: plugin, integration
