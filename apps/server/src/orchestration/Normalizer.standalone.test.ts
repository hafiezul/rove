import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";

const layer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "rove-standalone-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const command = (id: string): Extract<ClientOrchestrationCommand, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${id}`),
  threadId: ThreadId.make(id),
  projectId: null,
  workspacePath: "/not-the-client-path",
  title: "Standalone",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("standalone thread workspaces", () => {
  it.effect("assigns separate stable directories without changing permissions", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const first = yield* normalizeDispatchCommand(command("first"));
      const second = yield* normalizeDispatchCommand(command("second"));
      const retried = yield* normalizeDispatchCommand(command("first"));
      if (
        first.type !== "thread.create" ||
        second.type !== "thread.create" ||
        retried.type !== "thread.create"
      )
        throw new Error("Unexpected command");
      expect(first.projectId).toBeNull();
      expect(first.workspacePath).not.toBe(second.workspacePath);
      expect(first.workspacePath).toBe(retried.workspacePath);
      expect(path.dirname(first.workspacePath!)).toBe(path.join(config.baseDir, "workspaces"));
      expect(yield* fs.exists(first.workspacePath!)).toBe(true);
      expect(first.runtimeMode).toBe("full-access");
      expect(resolveThreadWorkspaceCwd({ thread: first, projects: [] })).toBe(first.workspacePath);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps arbitrary thread IDs inside the managed workspace parent", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      for (const id of ["../userdata", "/tmp/outside", "C:\\secrets", "CON"]) {
        const result = yield* normalizeDispatchCommand(command(id));
        if (result.type !== "thread.create") throw new Error("Unexpected command");
        expect(path.dirname(result.workspacePath!)).toBe(path.join(config.baseDir, "workspaces"));
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("uses the same workspace assignment for first-turn bootstrap", () =>
    Effect.gen(function* () {
      const creation = command("bootstrap");
      const first = yield* normalizeDispatchCommand(creation);
      const result = yield* normalizeDispatchCommand({
        type: "thread.turn.start",
        commandId: CommandId.make("bootstrap-turn"),
        threadId: creation.threadId,
        message: {
          messageId: MessageId.make("fake-message"),
          role: "user",
          text: "fixture",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: { createThread: creation },
        createdAt: creation.createdAt,
      });
      if (result.type !== "thread.turn.start" || first.type !== "thread.create")
        throw new Error("Unexpected command");
      expect(result.bootstrap?.createThread?.workspacePath).toBe(first.workspacePath);
    }).pipe(Effect.provide(layer)),
  );
});
