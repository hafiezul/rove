// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { discoverPiCatalog } from "./PiProvider.ts";
import { makePiJsonlDecoder, makePiSessionRuntime } from "./PiSessionRuntime.ts";

describe("Pi RPC JSONL decoder", () => {
  it("uses LF as the only record delimiter", () => {
    const decoder = makePiJsonlDecoder();

    expect(decoder.push('{"message":"first\u2028still first"}\n{"message":"sec')).toEqual([
      '{"message":"first\u2028still first"}',
    ]);
    expect(decoder.push('ond"}\r\n')).toEqual(['{"message":"second"}']);
    expect(decoder.end()).toEqual([]);
  });

  it("returns one unterminated final record only when the stream ends", () => {
    const decoder = makePiJsonlDecoder();

    expect(decoder.push('{"type":"agent_settled"}')).toEqual([]);
    expect(decoder.end()).toEqual(['{"type":"agent_settled"}']);
    expect(decoder.end()).toEqual([]);
  });
});

function makeMockPiBinary(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-runtime-"));
  const agentPath = NodePath.join(directory, "agent.mjs");
  const binaryPath = NodePath.join(directory, "fake-pi.sh");
  NodeFS.writeFileSync(
    agentPath,
    `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let buffer = "";
let selected = { provider: "custom", id: "starter", name: "Starter" };
let thinkingLevel = "high";
const argumentValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sessionDirectory = argumentValue("--session-dir");
const sessionId = argumentValue("--session-id") ?? "thread-native";
const sessionFile = sessionDirectory ? join(sessionDirectory, \`\${sessionId}.jsonl\`) : "/tmp/thread-native.jsonl";

if (process.env.PI_TEST_EMIT_LAUNCH_CONTEXT === "true") {
  process.stdout.write(JSON.stringify({ type: "pi_test_launch_context", cwd: process.cwd(), piAgentDir: process.env.PI_CODING_AGENT_DIR ?? null }) + "\\n");
}

function respond(command, data) {
  process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, ...(data === undefined ? {} : { data }) }) + "\\n");
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      respond(command, { sessionId, sessionFile, model: selected, thinkingLevel, autoCompactionEnabled: false });
      return;
    case "get_session_stats":
      if (process.env.PI_TEST_EMPTY_SESSION_STATS === "true") {
        respond(command, {
          sessionFile,
          sessionId,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
          contextUsage: { tokens: 0, contextWindow: 372000, percent: 0 },
        });
        return;
      }
      respond(command, {
        sessionFile,
        sessionId,
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 2,
        tokens: { input: 55000, output: 24000, cacheRead: 2100000, cacheWrite: 121000, total: 2300000 },
        cost: 1.25,
        contextUsage: { tokens: 63000, contextWindow: 1000000, percent: 6.3 },
      });
      return;
    case "get_available_models":
      respond(command, { models: [selected, { provider: "custom", id: "team/coder", name: "Team Coder", reasoning: true, thinkingLevelMap: { minimal: null, max: "max" } }] });
      return;
    case "set_model":
      selected = { provider: command.provider, id: command.modelId, name: command.modelId };
      if (process.env.PI_TEST_SET_MODEL_LOG_DIR) {
        mkdirSync(process.env.PI_TEST_SET_MODEL_LOG_DIR, { recursive: true });
        writeFileSync(join(process.env.PI_TEST_SET_MODEL_LOG_DIR, "set-model-calls.log"), selected.provider + "/" + selected.id + "\\n", { flag: "a" });
      }
      respond(command, selected);
      return;
    case "get_available_thinking_levels":
      respond(command, { levels: ["off", "high", "max"] });
      return;
    case "get_commands":
      respond(command, {
        commands: [
          { name: "llama", description: "Manage llama.cpp router models", source: "extension", sourceInfo: { path: "<inline:llama.cpp>", source: "inline", scope: "temporary" } },
          { name: "skill:code-review", description: "Review the changes since a fixed point.", source: "skill", sourceInfo: { path: "/Users/example/.agents/skills/code-review/SKILL.md", source: "auto", scope: "user", origin: "top-level" } },
          { name: "skill:probe", source: "skill", sourceInfo: { path: "/workspace/project/.agents/skills/probe/SKILL.md", source: "auto", scope: "project" } },
          { name: "fix-tests", description: "Fix failing tests", source: "prompt", sourceInfo: { path: "/workspace/project/.pi/prompts/fix-tests.md", source: "auto", scope: "project" } },
        ],
      });
      return;
    case "set_thinking_level":
      thinkingLevel = command.level;
      respond(command);
      return;
    case "prompt":
      if (process.env.PI_TEST_EXIT_ON_PROMPT === "true") {
        process.stderr.write("simulated Pi process loss\\n");
        process.exit(23);
      }
      if (sessionDirectory) {
        mkdirSync(sessionDirectory, { recursive: true });
        writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId, message: command.message }) + "\\n");
      }
      respond(command);
      return;
    case "abort":
      respond(command);
      return;
    case "extension_ui_response":
      process.stdout.write(JSON.stringify({ type: "extension_ui_response_received", response: command }) + "\\n");
      return;
    default:
      process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: false, error: "Unknown command" }) + "\\n");
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
`,
    "utf8",
  );
  NodeFS.writeFileSync(
    binaryPath,
    `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(agentPath)} "$@"\n`,
    "utf8",
  );
  NodeFS.chmodSync(binaryPath, 0o755);
  return binaryPath;
}

it.effect("starts Pi persistent mode with a stable native ID and drives model RPC", () =>
  Effect.gen(function* () {
    const binaryPath = makeMockPiBinary();
    const sessionDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-pi-native-session-"),
    );
    const siblingInstanceDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-pi-native-session-sibling-"),
    );
    const runtime = yield* makePiSessionRuntime({
      binaryPath,
      configDirectory: "/tmp/pi-config",
      launchArgs: "",
      trustedExtensions: [],
      cwd: process.cwd(),
      sessionDirectory,
      sessionId: "thread-native",
    });

    const started = yield* runtime.start();
    expect(started).toMatchObject({
      sessionId: "thread-native",
      sessionFile: NodePath.join(sessionDirectory, "thread-native.jsonl"),
      model: { provider: "custom", id: "starter" },
    });

    expect(yield* runtime.getAvailableModels()).toContainEqual({
      provider: "custom",
      id: "team/coder",
      name: "Team Coder",
      reasoning: true,
      thinkingLevelMap: { minimal: null, max: "max" },
    });
    yield* runtime.setModel({ provider: "custom", modelId: "team/coder" });
    expect(yield* runtime.getAvailableThinkingLevels()).toEqual(["off", "high", "max"]);
    expect(yield* runtime.getCommands()).toEqual({
      skills: [
        {
          name: "code-review",
          description: "Review the changes since a fixed point.",
          scope: "user",
          path: "/Users/example/.agents/skills/code-review/SKILL.md",
        },
        {
          name: "probe",
          scope: "project",
          path: "/workspace/project/.agents/skills/probe/SKILL.md",
        },
      ],
      extensionCommands: [
        {
          name: "llama",
          description: "Manage llama.cpp router models",
          path: "<inline:llama.cpp>",
        },
      ],
    });
    yield* runtime.setThinkingLevel("max");
    yield* runtime.prompt({ message: "Persist the first native Pi turn" });
    const sessionFile = NodePath.join(sessionDirectory, "thread-native.jsonl");
    expect(NodeFS.existsSync(sessionFile)).toBe(true);
    expect(NodeFS.readFileSync(sessionFile, "utf8")).toContain("thread-native");
    expect(NodeFS.existsSync(NodePath.join(siblingInstanceDirectory, "thread-native.jsonl"))).toBe(
      false,
    );
    expect(yield* runtime.getState()).toMatchObject({
      model: { provider: "custom", id: "team/coder" },
      thinkingLevel: "max",
      autoCompactionEnabled: false,
    });
    expect(yield* runtime.getSessionStats()).toEqual({
      totalTokens: 2_300_000,
      contextTokens: 63_000,
      contextWindow: 1_000_000,
    });

    NodeFS.rmSync(NodePath.dirname(binaryPath), { recursive: true, force: true });
    NodeFS.rmSync(sessionDirectory, { recursive: true, force: true });
    NodeFS.rmSync(siblingInstanceDirectory, { recursive: true, force: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("sends extension UI responses without waiting for a Pi RPC response", () =>
  Effect.gen(function* () {
    const binaryPath = makeMockPiBinary();
    const runtime = yield* makePiSessionRuntime({
      binaryPath,
      configDirectory: "",
      launchArgs: "",
      trustedExtensions: [],
      cwd: process.cwd(),
    });
    yield* runtime.start();
    const eventFiber = yield* Stream.take(runtime.events, 1).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    yield* runtime.respondToExtensionUI({
      id: "extension-dialog",
      value: "Continue",
    });

    expect(Array.from(yield* Fiber.join(eventFiber).pipe(Effect.timeout("1 second")))).toEqual([
      {
        type: "extension_ui_response_received",
        response: {
          type: "extension_ui_response",
          id: "extension-dialog",
          value: "Continue",
        },
      },
    ]);

    NodeFS.rmSync(NodePath.dirname(binaryPath), { recursive: true, force: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("starts Pi in the configured project and extension configuration context", () =>
  Effect.gen(function* () {
    const binaryPath = makeMockPiBinary();
    const projectDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-project-"));
    const configDirectory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-config-"));
    const runtime = yield* makePiSessionRuntime({
      binaryPath,
      configDirectory,
      launchArgs: "",
      trustedExtensions: [],
      cwd: projectDirectory,
      environment: { PI_TEST_EMIT_LAUNCH_CONTEXT: "true" },
    });
    const eventFiber = yield* Stream.take(runtime.events, 1).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );

    yield* runtime.start();

    expect(Array.from(yield* Fiber.join(eventFiber).pipe(Effect.timeout("1 second")))).toEqual([
      {
        type: "pi_test_launch_context",
        cwd: NodeFS.realpathSync(projectDirectory),
        piAgentDir: configDirectory,
      },
    ]);

    NodeFS.rmSync(NodePath.dirname(binaryPath), { recursive: true, force: true });
    NodeFS.rmSync(projectDirectory, { recursive: true, force: true });
    NodeFS.rmSync(configDirectory, { recursive: true, force: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a diagnosable transport failure when Pi exits during an accepted prompt", () =>
  Effect.gen(function* () {
    const binaryPath = makeMockPiBinary();
    const runtime = yield* makePiSessionRuntime({
      binaryPath,
      configDirectory: "",
      launchArgs: "",
      trustedExtensions: [],
      cwd: process.cwd(),
      environment: { PI_TEST_EXIT_ON_PROMPT: "true" },
    });
    yield* runtime.start();
    const eventFiber = yield* Stream.take(runtime.events, 1).pipe(
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    const promptFailure = yield* runtime
      .prompt({ message: "Persist this prompt before the transport fails." })
      .pipe(Effect.flip);
    const events = Array.from(yield* Fiber.join(eventFiber).pipe(Effect.timeout("1 second")));

    expect(["read-stdout", "process-exit"]).toContain(promptFailure.operation);
    expect(events).toEqual([
      expect.objectContaining({
        type: "pi_rpc_transport_failure",
        operation: expect.stringMatching(/read-stdout|process-exit/),
        detail: expect.stringContaining("Pi RPC"),
      }),
    ]);
    // Pi's own stderr is the only description of why it died, so it must reach
    // the failure detail instead of being drained and discarded.
    expect(events[0]).toEqual(
      expect.objectContaining({
        detail: expect.stringContaining("simulated Pi process loss"),
      }),
    );

    NodeFS.rmSync(NodePath.dirname(binaryPath), { recursive: true, force: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reads a fresh Pi session's stats without treating them as invalid", () =>
  Effect.gen(function* () {
    const binaryPath = makeMockPiBinary();
    const runtime = yield* makePiSessionRuntime({
      binaryPath,
      configDirectory: "",
      launchArgs: "",
      trustedExtensions: [],
      cwd: process.cwd(),
      environment: { PI_TEST_EMPTY_SESSION_STATS: "true" },
    });
    yield* runtime.start();

    // A session that has not yet spent tokens is a normal state, not a
    // malformed response. The context size is simply not worth reporting.
    expect(yield* runtime.getSessionStats()).toEqual({
      totalTokens: 0,
      contextWindow: 372_000,
    });

    NodeFS.rmSync(NodePath.dirname(binaryPath), { recursive: true, force: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("discovers the Pi catalog without selecting any model", () =>
  Effect.gen(function* () {
    const binaryPath = makeMockPiBinary();
    const sessionDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-pi-catalog-probe-"),
    );

    const catalog = yield* discoverPiCatalog({
      binaryPath,
      configDirectory: "",
      launchArgs: "",
      trustedExtensions: [],
      cwd: process.cwd(),
      environment: { PI_TEST_SET_MODEL_LOG_DIR: sessionDirectory },
    });

    // Pi's `set_model` writes `defaultProvider`/`defaultModel` into the user's
    // Pi settings, so a catalog probe must never issue it. Thinking levels are
    // derived from each model instead.
    expect(NodeFS.existsSync(NodePath.join(sessionDirectory, "set-model-calls.log"))).toBe(false);
    expect(catalog.models).toEqual([
      {
        model: { provider: "custom", id: "starter", name: "Starter" },
        thinkingLevels: ["off"],
        currentThinkingLevel: "high",
        isDefault: true,
      },
      {
        model: {
          provider: "custom",
          id: "team/coder",
          name: "Team Coder",
          reasoning: true,
          thinkingLevelMap: { minimal: null, max: "max" },
        },
        thinkingLevels: ["off", "low", "medium", "high", "max"],
      },
    ]);

    NodeFS.rmSync(NodePath.dirname(binaryPath), { recursive: true, force: true });
    NodeFS.rmSync(sessionDirectory, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);
