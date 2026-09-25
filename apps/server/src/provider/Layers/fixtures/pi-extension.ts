// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  if (getAgentDir() !== process.env.PI_CODING_AGENT_DIR)
    throw new Error("Wrong extension SDK runtime");
  let count = 0;
  pi.on("session_start", (_event, ctx) => {
    NodeFS.appendFileSync(
      NodePath.join(ctx.cwd, "extension.log"),
      `start:${ctx.hasUI}:${ctx.mode}\n`,
    );
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    await Promise.resolve();
    NodeFS.appendFileSync(NodePath.join(ctx.cwd, "extension.log"), "shutdown\n");
  });
  pi.on("input", (event, ctx) => {
    if (event.text === "handled") {
      NodeFS.appendFileSync(NodePath.join(ctx.cwd, "extension.log"), `input:${event.source}\n`);
      return { action: "handled" };
    }
  });
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\nFixture hook active.`,
  }));
  pi.registerCommand("count", {
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Confirm", "Not available headlessly");
      NodeFS.appendFileSync(
        NodePath.join(ctx.cwd, "extension.log"),
        `command:${++count}:${confirmed}\n`,
      );
    },
  });
  pi.registerCommand("replace-session", {
    handler: async (_args, ctx) => {
      await ctx.newSession();
    },
  });
  pi.registerCommand("broken", {
    handler: async () => {
      throw new Error("fixture command failed");
    },
  });
  pi.registerTool({
    name: "fixture_tool",
    label: "Fixture tool",
    description: "Returns a test result",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "extension tool worked" }], details: {} };
    },
  });
  pi.registerProvider("rove-extension-test", {
    baseUrl: "https://example.invalid",
    apiKey: "test-key",
    api: "openai-completions",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context) {
      // Pi 0.87 normalizes each request into a transcript where the prompt and
      // tool declarations ride on system messages instead of dedicated fields.
      const systemPrompt = context.messages
        .filter((message) => message.role === "system")
        .map((message) =>
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Mirrors pi-ai's declared `content: string | TextContent[]` union; extensions can inject either shape.
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n"),
        )
        .join("\n");
      const tools = context.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []) : [],
      );
      if (!systemPrompt.includes("Fixture hook active.")) throw new Error("Missing extension hook");
      if (!tools.some((tool) => tool.name === "fixture_tool"))
        throw new Error("Missing extension tool");
      const hasResult = context.messages.some((message) => message.role === "toolResult");
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: hasResult
          ? [{ type: "text", text: "done" }]
          : [{ type: "toolCall", id: "fixture-call", name: "fixture_tool", arguments: {} }],
        stopReason: hasResult ? "stop" : "toolUse",
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: hasResult ? "stop" : "toolUse", message });
      stream.end();
      return stream;
    },
  });
}
