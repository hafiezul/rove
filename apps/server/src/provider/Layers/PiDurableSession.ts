// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "pi-durable-ai/models";
import {
  createRegistry,
  defineExtension,
  Harness,
  section,
  type Registry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";

export const durableContext = BACKGROUND_CONTEXT;

/** No coding-agent extension loading: Durable has its own extension protocol. */
export function createPiDurableRegistry() {
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(
    defineExtension({
      name: "rove",
      sections: [
        section(
          "preamble",
          () => "You are a coding assistant. Use the tools to inspect and change the project.",
          { tag: false },
        ),
        section("runtime", () => buildRuntimeInstructions({ harness: "Pi Durable" }), {
          tag: false,
        }),
        section("cwd", ({ agent }) => agent.cwd),
        section("project_instructions", async ({ agent }) => {
          if (!agent.cwd) return undefined;
          try {
            return (await NodeFSP.readFile(NodePath.join(agent.cwd, "AGENTS.md"), "utf8")).slice(
              0,
              64_000,
            );
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return undefined;
            throw error;
          }
        }),
      ],
    }),
  );
  return registry;
}

/** Opens paused. Only a routed turn may start model work, never a status probe. */
export async function openPiDurableSession(input: {
  file: string;
  cwd: string;
  models: Models;
  environment?: NodeJS.ProcessEnv | undefined;
  registry?: Registry | undefined;
}) {
  await NodeFSP.mkdir(NodePath.dirname(input.file), { recursive: true });
  const storage = await openNodeSqliteStorage(input.file);
  try {
    const harness = await Harness.open(
      storage,
      {
        models: input.models,
        registry: input.registry ?? createPiDurableRegistry(),
        env: ({ cwd }) =>
          new NodeExecutionEnv({
            cwd: cwd ?? input.cwd,
            shellEnv: input.environment ?? process.env,
          }),
        settings: {
          toolExecution: "sequential",
          progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
        },
      },
      durableContext,
    );
    try {
      const conversation = await harness.root(durableContext, { agent: { cwd: input.cwd } });
      // Root options only initialize new storage; Rove owns the current checkout on resume.
      await conversation.configure({ cwd: input.cwd }, durableContext);
      return { harness, conversation };
    } catch (error) {
      await harness.close(durableContext);
      throw error;
    }
  } catch (error) {
    await storage.close(durableContext);
    throw error;
  }
}
