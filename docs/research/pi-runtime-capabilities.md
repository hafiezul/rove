# Pi runtime capabilities and Rove integration constraints

**Scope.** This is a research-only assessment of the installed `@earendil-works/pi-coding-agent` **0.84.2** package at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`, plus the provider SPI in this Rove worktree. Claims below are based on the installed documentation, declarations, and runtime JavaScript; upstream links are included as primary-source mirrors. No provider implementation is included in this document.

## Decision summary

Pi is capable of being a first-class Rove provider. The best-fit boundary is the same-process SDK (`ModelRuntime` + `createAgentSession`/`AgentSession` + `SessionManager`): it exposes typed streaming events, model changes, interruption, extension hooks, and session-tree operations without adding a wire parser. `pi --mode rpc` is a viable isolation fallback, but requires a strict JSONL adapter and host-side compensation for missing login, model-refresh, tool-discovery, and request-scoped cancellation. `--mode json`/`-p` are one-shot modes and are not suitable for a live Rove session. Pi's experimental CBOR remote protocol should not be the first Rove boundary.

The non-negotiable integration issue is authorization. Pi intentionally has no built-in per-tool approval or sandbox policy. Rove must enforce its `ProviderApprovalPolicy`, `ProviderSandboxMode`, and runtime modes with a controlled tool/extension boundary; Pi's project-trust `--approve` flag is not a substitute for per-tool authorization. [P1] [P6] [P8] [R8]

## Capability matrix

| Capability | Verified Pi 0.84.2 behavior | Rove consequence |
|---|---|---|
| **Embedded runtime** | `createAgentSession`, `AgentSession`, `AgentSessionRuntime`, `ModelRuntime`, and `SessionManager` are exported. `AgentSession.prompt()` is asynchronous; `subscribe()` receives typed events; `abort()` and `dispose()` are available. Session replacement changes the active session and requires re-subscribing. [P1] [P2] | Prefer one SDK runtime per Rove provider instance and one session per `threadId`. The adapter must rebind listeners after any Pi session replacement and dispose every session when the driver scope closes. [R2] [R3] |
| **Subprocess integration** | `pi --mode rpc` is bidirectional stdin/stdout JSONL. Records are LF-delimited only; responses correlate optional command IDs, while streamed events generally do not carry those IDs. A prompt response means accepted/queued, not completed; `agent_settled` is the final idle signal after retries, compaction, and queued work. [P2] [P7] | RPC is viable when process isolation is worth the cost. Implement a strict LF parser, generate Rove event/turn IDs, and complete a turn only at settled/error/abort—not at the prompt acknowledgement or low-level `agent_end`. |
| **Print/JSON modes** | `-p` prints a final response and exits. `--mode json` emits one-shot JSON event output; it does not accept live commands on stdin. JSON `message_update` records are deltas, and `message_end` is authoritative. [P3] [P7] | Do not use print/JSON as the live adapter. They can be auxiliary one-shot jobs only; they cannot provide Rove's interrupt, approval, user-input, or model-switch lifecycle. |
| **Streaming and lifecycle** | Events include agent/turn/message lifecycle, text and thinking deltas, tool execution start/update/end, queue changes, compaction, retry, and extension errors. Tool progress is correlated by `toolCallId`; deltas must be assembled by content index. [P1] [P2] | Translate Pi events into `ProviderRuntimeEvent`: text/thinking to `content.delta`, tools to item lifecycle/progress, `agent_settled` to `turn.completed`, abort to `turn.aborted`, and failures to `runtime.error`. Preserve the native event in `raw` and native IDs in `providerRefs`. [R8] [R10] |
| **Model selection and thinking** | Pi models are provider/id pairs; SDK and RPC support model changes and thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, subject to model support). SDK `ModelRuntime.refresh()` supports explicit network refresh; RPC has `get_available_models` but no refresh command. [P1] [P2] [P5] | Advertise Pi models in the provider snapshot and map `provider/id` to Rove's `ModelSelection.model`. Expose thinking as a Rove provider option (or a documented selection convention). Declare `sessionModelSwitch: "in-session"`; the Pi API supports it. [R3] [R8] |
| **Auth and catalogs** | Auth resolves from runtime overrides, Pi credential storage, environment, and custom model/provider configuration. SDK has `checkAuth`, `login`, `logout`, runtime-key, and refresh APIs. CLI has `/login` and `pi update --models`; RPC has no login, key mutation, catalog refresh, or tool-list command. [P1] [P5] [P6] [P7] | A first-class Rove settings flow must own auth callbacks or use configured environment/API keys. Do not promise RPC login or fresh catalogs without restarting/replacing the runtime. Keep `auth.json`, `models.json`, and session roots per Rove instance rather than silently sharing the user's default `~/.pi/agent`. [R2] [R9] |
| **Built-in/custom tools** | Built-ins are `read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls`; defaults are the first four. SDK/CLI support allowlists and exclusions. Extensions can register, replace, wrap, and inspect tools. RPC `get_commands` reports extension/prompt/skill commands, not built-in tools; there is no `get_tools` command. [P1] [P2] [P6] [P7] | The driver must choose an explicit tool set and resource loader. A Rove UI cannot reliably discover the effective RPC tool set; use SDK metadata or driver-owned configuration. Tool names and results need a canonical mapping to Rove item types. |
| **Extensions and skills** | Extensions can intercept tool calls, mutate inputs, block calls, emit events, register commands/tools, and request UI dialogs. Skills/context are discovered from global/project paths and affect the prompt. Pi packages/extensions execute with full system access; skills can instruct arbitrary actions. [P1] [P6] [P8] | Treat project/global resources as an authorization boundary. Use a controlled `ResourceLoader`/agent directory and explicit trust policy; do not equate skills or extension allowlists with a sandbox. Rove should decide whether project extensions/skills are loaded for each runtime mode. |
| **Approvals and sandboxing** | Pi philosophy says there are no permission popups. `--approve`/`--no-approve` controls trust of project-local resources, not per-tool authorization. Extensions can implement a `tool_call` gate or `ctx.ui.confirm`, but no built-in approval-policy schema or RPC approval command exists. [P6] [P8] | **High constraint:** `ProviderApprovalPolicy` and `ProviderSandboxMode` cannot be delegated to Pi defaults. Build a host-controlled gate/extension or restrict the available tools; otherwise expose Pi only as an explicitly full-access mode and report that limitation. [R8] |
| **Structured user input** | Extension `select`/`confirm`/`input`/`editor` dialogs have an RPC request/response subprotocol. Pi has no native model `ask_user`/`user_input` command; arbitrary custom UI is degraded or unavailable in RPC. [P2] [P6] [P7] | Extension dialogs can be adapted to Rove `user-input.requested`/`respondToUserInput`, but this is an adapter convention, not native model interaction. Unsupported custom/editor dialogs must fail or degrade explicitly. |
| **Interruption/cancellation** | SDK exposes `abort()`; RPC exposes `abort`, `abort_bash`, and `abort_retry`. Signals are cooperative. There is no `cancel(requestId)`; RPC command IDs correlate acceptance responses, not cancellation. `RpcClient.stop()` terminates the child after a grace period. [P1] [P2] [P7] | Map `interruptTurn(threadId, turnId?)` to the active session's abort. Enforce at most one active Pi operation per session (or maintain a clear queue), and do not claim arbitrary request cancellation. [R3] |
| **Durable sessions** | Sessions are append-only JSONL trees (current format v3) with `id`/`parentId`, model/thinking changes, compaction, labels, and branch/fork operations. SDK has `SessionManager` create/open/continue/in-memory APIs; RPC supports tree/entries/fork/switch/clone, but resume-by-ID is selected at process startup. [P1] [P4] [P5] [P7] | Keep Pi's JSONL as the provider-native conversation state and store its controlled path/leaf cursor in Rove's `ProviderRuntimeBinding.resumeCursor` or payload. Do not use in-memory sessions if Rove must resume tool state. Map Rove rollback to Pi tree navigation/branching and define behavior after compaction. [R5] [R6] |
| **Remote protocol** | `@earendil-works/pi-client`/`pi-protocol` use an experimental four-byte length-prefixed definite CBOR protocol. The client is transport-neutral, does not reconnect automatically, and the protocol package supplies no transport; the protocol explicitly has no compatibility guarantees. [P10] [P11] | This is separate from stdio RPC and should not be exposed through Rove's existing WebSocket layer. Rove clients should continue to consume canonical Rove events while Pi remains server-side. |
| **Packaging/runtime** | Package 0.84.2 is ESM, exports SDK/RPC/client entry points, and requires Node `>=22.19.0`. The current Rove root declares Node `^24.13.1`, so the engine floor is compatible. Pi's package depends on `@earendil-works/pi-ai` but does not export a standalone text-generation service from its main index. [P0] [P9] [R11] | Pin the aligned Pi package family (at least coding-agent, agent-core, ai, client, and protocol) and import only public exports. Rove's required `ProviderInstance.textGeneration` closure needs a direct `@earendil-works/pi-ai` bridge or another explicit implementation; do not rely on a transitive dependency. [R2] [R10] |

## Mapping to Rove's provider SPI

1. **Driver and instance registration.** Implementing a first-party driver means a `ProviderDriver` with a typed `configSchema`, `defaultConfig`, and scoped `create`; its result must include a snapshot, adapter, and text-generation closure. Add the driver to `BUILT_IN_DRIVERS`. The registry decodes opaque settings once, keys instances by `ProviderInstanceId`, and tears down the child scope on reload. Pi's SDK can support multiple instances only if each gets isolated session/model/auth roots; sharing the default Pi directory would undermine instance isolation. [R2] [R4] [R5]

2. **Session lifecycle.** `startSession` should resolve the Rove thread's cwd, model selection, runtime mode, and resume cursor into a Pi `AgentSession`/`SessionManager`; subscribe before sending work; and return a Rove `ProviderSession`. `sendTurn` should allocate a Rove `TurnId`, invoke `prompt` (or steering/follow-up when explicitly supported), and let the event stream do ingestion. The adapter must stop/abort and dispose the session in `stopSession`/`stopAll`. [P1] [R3] [R5]

3. **Canonical event translation.** Pi has no Rove turn/item/request IDs, so the adapter must generate them and retain native `toolCallId`/session/entry IDs in `providerRefs` or `raw`. Use `message_end` rather than a final delta as the authoritative assistant message. Use `agent_settled` (not merely `agent_end`) for the final turn boundary because Pi may retry, compact, or drain queued messages afterward. Rove's ingestion worker is queue-backed and expects typed canonical events, not provider-native JSON. [P2] [P7] [R1] [R8] [R10]

4. **Requests and runtime modes.** Rove's adapter contract requires `respondToRequest` and `respondToUserInput` even when a provider has no native approval request. Pi extension gates can supply a request map, but the implementation must never fabricate approval support by treating project trust as authorization. If a requested Rove mode cannot be enforced, reject it or advertise a constrained capability; do not silently run with full host access. [P6] [P8] [R3] [R8]

5. **Snapshots and model options.** The driver snapshot must report installation/version/auth/status, models, and maintenance changes through `getSnapshot`, `refresh`, and `streamChanges`. Convert Pi's model catalog (provider, id, capabilities, thinking support) to Rove model slugs and option descriptors. A Pi SDK refresh can drive Rove's refresh operation; an RPC-only implementation cannot refresh catalogs without process replacement. [P1] [P5] [P7] [R9]

6. **Persistence and rollback.** Rove's `ProviderSessionDirectory` routes by thread and stores an opaque `resumeCursor`; Pi's JSONL tree is a second persistence system, not a replacement for Rove's event/checkpoint store. Use a controlled Pi session directory and define a stable cursor containing the native session path plus leaf/branch information. Rove checkpoint reverts (workspace state) and Pi branch/rollback (conversation state) are different operations and must not be conflated. [P4] [P5] [R5] [R6] [R7]

7. **Text generation.** `ProviderInstance` requires a text-generation service, while the coding-agent package's public index is centered on agent sessions. The installed `@earendil-works/pi-ai` dependency exposes lower-level provider streams and `streamSimple`; a Pi driver should either declare that package directly and wrap it behind Rove's four text-generation operations or explicitly scope Pi out of those operations. [P0] [P9] [P12] [R2] [R10]

8. **Transport choice.** Use the SDK first for the canonical implementation. Choose RPC only when process isolation is a requirement and budget a protocol adapter for strict framing, asynchronous event correlation, startup-only session selection, missing auth/refresh/tool APIs, and process shutdown. Do not use one-shot JSON/print or experimental CBOR remote sessions as substitutes for Rove's provider adapter. [P1] [P2] [P3] [P10] [P11]

## Severity-labelled constraints and residual risks

- **High — authorization boundary:** Pi supplies no built-in per-tool approval or sandbox. Rove must own path/command policy, tool gating, extension trust, and runtime-mode enforcement. [P6] [P8] [R8]
- **High — persistence boundary:** Pi's JSONL files contain the native conversation/tool history while Rove persists orchestration events and checkpoints. A design that stores only a Rove transcript cannot necessarily resume Pi's tool/session state; a design that uses Pi's default directory can mix instances/projects. [P4] [P5] [R5] [R6]
- **High — auth UX:** RPC cannot perform login, runtime-key changes, or model-catalog refresh. Implement SDK callbacks/host settings or require environment/API-key configuration. [P1] [P2] [P5] [P7]
- **Medium — cancellation:** RPC and SDK abort the active operation, not an arbitrary request ID. Serialize operations per session and make abort/stop idempotent. [P1] [P2] [P7] [R3]
- **Medium — event semantics:** low-level `agent_end`, delta events, retries, compaction, and queued work do not map one-to-one to Rove turns. The adapter needs explicit state and deduplication. [P1] [P2] [P7] [R1]
- **Medium — model and tool discovery:** RPC exposes available models and commands but not a complete effective tool catalog or refresh operation. SDK is the safer choice for snapshots and settings. [P1] [P2] [P6] [P7]
- **Medium — package compatibility:** 0.84.2 is an ESM/Node 22.19+ snapshot and the remote protocol has no compatibility guarantees. Pin versions and keep integration tests against the installed family. [P0] [P10] [P11]
- **Medium — text-generation seam:** the coding-agent package does not export Rove's required standalone text-generation shape; `pi-ai` must be a deliberate direct dependency/bridge. [P9] [P12] [R2] [R10]
- **Low/unknown — live behavior:** this assessment did not execute a provider request, OAuth flow, subprocess, extension dialog, cancellation, or concurrent multi-session workload. These need focused integration tests before production support.

## Remaining unknowns

- Provider-specific authentication, OAuth callback behavior, catalog contents, and rate-limit/error events were not live-tested.
- The cost and resource profile of many same-process Pi sessions versus one RPC child per session is unmeasured.
- Exact file-locking/concurrent-write behavior for multiple runtimes sharing any Pi directory is not established; isolation should be the default until tested.
- The precise mapping from Rove's `rollbackConversation(numTurns)` to Pi entry IDs after compaction/branching needs an explicit policy and tests.
- Extension UI behavior in a server-only SDK host, especially editor/custom dialogs, needs a small harness; RPC's documented editor timeout discrepancy remains a version-specific caveat. [P2] [P6] [P7]

## Primary sources

**Pi 0.84.2 installed sources**

- **[P0] Package metadata** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json`; [official mirror](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json). Version, ESM exports, dependency family, and Node engine.
- **[P1] SDK** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`; [official SDK docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md). Embedding, sessions, events, models, auth, tools, and extensions.
- **[P2] RPC** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`; [official RPC docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md). Framing, commands, responses, events, abort, and UI requests.
- **[P3] JSON/print** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/json.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.js`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js`; [official JSON docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md). One-shot output and delta semantics.
- **[P4] Sessions** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/sessions.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`; [official sessions docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sessions.md). Session discovery and tree operations.
- **[P5] Session format** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/session-format.md`; [official format docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md). JSONL v3/tree persistence and compaction.
- **[P6] Models/providers/settings** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/environment-variables.md`; [official models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), [providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md). Catalogs, auth/configuration, thinking levels, and environment roots.
- **[P7] Installed runtime contracts** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session-runtime.d.ts`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.d.ts`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.d.ts`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js`. Exact installed APIs and behavior where docs/types need runtime confirmation.
- **[P8] Extensions/tools** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.d.ts`; [official extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md). Tool interception, UI dialogs, trust, and extension security.
- **[P9] CLI/README and public exports** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/README.md`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`; [official README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md). Modes, philosophy, CLI flags, and exported surface.
- **[P10] Experimental protocol** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-protocol/README.md`; package metadata; [official protocol README](https://github.com/earendil-works/pi/blob/main/packages/protocol/README.md). Framed CBOR and compatibility/transport limits.
- **[P11] Remote client** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-client/README.md`; package metadata; [official client README](https://github.com/earendil-works/pi/blob/main/packages/client/README.md). Transport-neutral remote sessions, leases, and reconnect behavior.
- **[P12] Pi AI dependency** — `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.d.ts`; `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts`; [official package](https://github.com/earendil-works/pi/tree/main/packages/ai). Lower-level model streams and `streamSimple` used for a possible text-generation bridge.

**Rove worktree primary sources**

- **[R1] Provider architecture** — `docs/internals/providers.md`; [official repository mirror](https://github.com/hafiezul/rove/blob/main/docs/internals/providers.md). Driver/adapter/registry/routing and queue-backed ingestion.
- **[R2] Driver SPI** — `apps/server/src/provider/ProviderDriver.ts`; [source](https://github.com/hafiezul/rove/blob/main/apps/server/src/provider/ProviderDriver.ts). Typed config, scoped instance resources, snapshot/adapter/text-generation bundle.
- **[R3] Adapter SPI** — `apps/server/src/provider/Services/ProviderAdapter.ts`; [source](https://github.com/hafiezul/rove/blob/main/apps/server/src/provider/Services/ProviderAdapter.ts). Session, turn, interrupt, request response, rollback, and canonical event stream methods.
- **[R4] Registration** — `apps/server/src/provider/builtInDrivers.ts`; [source](https://github.com/hafiezul/rove/blob/main/apps/server/src/provider/builtInDrivers.ts). Built-in driver list and environment aggregation.
- **[R5] Registries/service** — `apps/server/src/provider/Services/ProviderInstanceRegistry.ts`; `apps/server/src/provider/Services/ProviderAdapterRegistry.ts`; `apps/server/src/provider/Services/ProviderService.ts`; [registry](https://github.com/hafiezul/rove/blob/main/apps/server/src/provider/Services/ProviderInstanceRegistry.ts), [service](https://github.com/hafiezul/rove/blob/main/apps/server/src/provider/Services/ProviderService.ts). Instance routing, lifecycle, and cross-provider facade.
- **[R6] Session directory** — `apps/server/src/provider/Services/ProviderSessionDirectory.ts`; [source](https://github.com/hafiezul/rove/blob/main/apps/server/src/provider/Services/ProviderSessionDirectory.ts). Durable thread/provider bindings and opaque resume cursor.
- **[R7] Snapshot helpers** — `apps/server/src/provider/providerSnapshot.ts`; `apps/server/src/provider/Services/ServerProvider.ts`; [source](https://github.com/hafiezul/rove/blob/main/apps/server/src/provider/providerSnapshot.ts). Installed/version/auth/model snapshot and refresh shape.
- **[R8] Contracts** — `packages/contracts/src/provider.ts`; `packages/contracts/src/orchestration.ts`; `packages/contracts/src/model.ts`; `packages/contracts/src/providerInstance.ts`; [provider](https://github.com/hafiezul/rove/blob/main/packages/contracts/src/provider.ts), [orchestration](https://github.com/hafiezul/rove/blob/main/packages/contracts/src/orchestration.ts), [model](https://github.com/hafiezul/rove/blob/main/packages/contracts/src/model.ts). Runtime modes, approval/user-input requests, model options, and instance IDs.
- **[R9] Settings** — `packages/contracts/src/settings.ts`; [source](https://github.com/hafiezul/rove/blob/main/packages/contracts/src/settings.ts). Provider-instance configuration and settings forms.
- **[R10] Runtime event contract/ingestion** — `packages/contracts/src/providerRuntime.ts`; `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`; [contract](https://github.com/hafiezul/rove/blob/main/packages/contracts/src/providerRuntime.ts), [ingestion](https://github.com/hafiezul/rove/blob/main/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts). Canonical event vocabulary and worker boundary.
- **[R11] Rove runtime** — root `package.json`; [source](https://github.com/hafiezul/rove/blob/main/package.json). Current Node engine (`^24.13.1`).

## Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "pi-runtime-capabilities",
      "status": "satisfied",
      "evidence": "This document assesses installed @earendil-works/pi-coding-agent 0.84.2 from local docs/declarations/runtime files, maps every relevant capability to Rove driver/adapter/registry/session/event contracts, and cites primary sources with local paths and official mirrors."
    },
    {
      "id": "integration-constraints",
      "status": "satisfied",
      "evidence": "The capability matrix and SPI mapping identify the recommended SDK boundary, RPC fallback costs, authorization/sandbox gap, auth/catalog gap, cancellation semantics, persistence boundary, event translation, model options, remote protocol limits, and text-generation seam."
    },
    {
      "id": "research-only",
      "status": "satisfied",
      "evidence": "Only docs/research/pi-runtime-capabilities.md is a repository change; no provider code, contract code, or client code was implemented."
    }
  ],
  "changedFiles": [
    "docs/research/pi-runtime-capabilities.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [],
  "validationOutput": [
    "Static review of installed Pi 0.84.2 documentation, declarations, runtime JavaScript, package metadata, and nested pi-ai/client/protocol packages.",
    "Static review of Rove provider architecture, SPI, contracts, registries, session directory, snapshot helpers, runtime events, and text-generation seam.",
    "No live provider, OAuth, RPC subprocess, extension UI, cancellation, or concurrent-session execution was performed."
  ],
  "residualRisks": [
    "high: Pi has no built-in per-tool approval or sandbox policy; Rove must provide the authorization boundary.",
    "high: Pi JSONL session state and Rove event/checkpoint state need an explicit persistence and rollback policy.",
    "high: RPC has no login, runtime-key mutation, or model-catalog refresh command.",
    "medium: no request-scoped cancellation ID and event/turn boundaries require explicit translation.",
    "medium: coding-agent does not export Rove's standalone text-generation shape; a direct pi-ai bridge is needed.",
    "medium: experimental CBOR remote protocol has no compatibility guarantees.",
    "medium: live provider-specific and multi-session behavior remains unverified."
  ],
  "noStagedFiles": true,
  "diffSummary": "Research-only capability and integration-constraint document; no provider implementation.",
  "reviewFindings": [
    "high: README philosophy/extensions sources confirm that trust and extension gates are not a built-in per-tool sandbox.",
    "high: Rove ProviderAdapter and ProviderDriver contracts require approval/user-input methods, scoped lifecycle cleanup, canonical events, and text generation beyond Pi's default live boundary.",
    "medium: installed RPC type union/runtime confirms no login, catalog-refresh, tool-discovery, or request-cancel command.",
    "medium: Pi's agent_settled and delta/message_end semantics must be respected by Rove ingestion.",
    "none: no implementation blockers for a research conclusion; the identified constraints are design/test requirements."
  ],
  "manualNotes": "Recommended first implementation boundary is same-process SDK with per-instance Pi roots and host-controlled tool policy. Use RPC only for deliberate process isolation; do not use one-shot JSON/print or experimental CBOR remote protocol as the canonical Rove provider boundary."
}
```
