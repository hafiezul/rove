// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const directoryAtLoad = getAgentDir();
  pi.registerCommand("probe-instance", {
    handler: async (_args, ctx) => {
      // Deliberately omit agentDir, like generic SDK-based subagent extensions.
      const services = await createAgentSessionServices({ cwd: ctx.cwd });
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(ctx.cwd),
      });
      try {
        const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
          "-e",
          "process.stdout.write(process.env.PI_CODING_AGENT_DIR)",
        ]);
        ctx.ui.notify(
          JSON.stringify({
            directoryAtLoad,
            directoryNow: getAgentDir(),
            subprocessDirectory: stdout,
            childDirectory: services.agentDir,
            childModel: session.model?.id,
            childExtensions: services.resourceLoader
              .getExtensions()
              .extensions.map((ext) => NodePath.basename(ext.path)),
            auth: JSON.parse(
              NodeFS.readFileSync(NodePath.join(getAgentDir(), "auth.json"), "utf8"),
            ),
          }),
          "info",
        );
      } finally {
        session.dispose();
      }
    },
  });
  pi.registerCommand("relaunch-pi", {
    handler: async (_args, ctx) => {
      // Pi's examples/extensions/subagent starts children exactly this way.
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          process.argv[1]!,
          "--mode",
          "json",
          "-p",
          "--no-session",
          "--model",
          "instance-fixture/fixture",
          "Task: hello",
        ],
        { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const code = await new Promise((resolve) => child.on("close", resolve));
      const final = stdout
        .split("\n")
        .filter((line) => line.trim().startsWith("{"))
        .map((line) => JSON.parse(line))
        .findLast((event) => event.type === "message_end" && event.message?.role === "assistant");
      ctx.ui.notify(
        final ? String(final.message.content[0]?.text) : `exit ${code}: ${stderr}`,
        "info",
      );
    },
  });
  pi.registerCommand("ask-instance", {
    handler: async (_args, ctx) => {
      const answer = await ctx.ui.confirm("Instance question", "Continue?");
      ctx.ui.notify(answer ? "confirmed" : "cancelled", "info");
    },
  });
  pi.registerCommand("exit-instance", {
    handler: async () => {
      process.exit(17);
    },
  });
  pi.registerCommand("hang-instance", {
    handler: async (_args, ctx) => {
      ctx.ui.notify("blocking", "info");
      while (true) {}
    },
  });
  pi.registerCommand("stall-instance", {
    handler: async (_args, ctx) => {
      ctx.ui.notify("stalled", "info");
      await new Promise(() => {});
    },
  });
  pi.registerTool({
    name: "fixture_hang",
    label: "Fixture hang",
    description: "Never finishes and ignores abort.",
    parameters: { type: "object", properties: {} },
    execute: () => new Promise<never>(() => {}),
  });
  pi.registerCommand("fail-instance", {
    handler: async () => {
      throw new Error("fixture failure");
    },
  });
  pi.registerProvider("instance-fixture", {
    baseUrl: "https://example.invalid",
    apiKey: "fixture",
    api: "openai-completions",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model, context, options) {
      const text = (entry: (typeof context.messages)[number]) =>
        typeof entry.content === "string"
          ? entry.content
          : entry.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      const stream = createAssistantMessageEventStream();
      const transcript = context.messages.map(text).join("\n");
      if (
        transcript.includes("context summarization assistant") &&
        (transcript.includes("stall-compaction") || transcript.includes("[User]: stall-stream"))
      ) {
        return stream;
      }
      const lastUser = context.messages.findLast((entry) => entry.role === "user");
      const hangTool =
        lastUser !== undefined &&
        text(lastUser) === "hang-tool" &&
        context.messages.at(-1)?.role === "user";
      const callTool =
        hangTool ||
        (getCurrentTools(context.messages).some(
          (tool) => tool.name === "mcp__rove__preview_status",
        ) &&
          !context.messages.some((message) => message.role === "toolResult"));
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        // Compaction ignores messages older than its latest boundary.
        // @effect-diagnostics-next-line globalDate:off
        timestamp: Date.now(),
        content: callTool
          ? [
              {
                type: "toolCall",
                id: "rove-call",
                name: hangTool ? "fixture_hang" : "mcp__rove__preview_status",
                arguments: {},
              },
            ]
          : [{ type: "text", text: NodePath.basename(directoryAtLoad) }],
        stopReason: callTool ? "toolUse" : "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      if (lastUser !== undefined && text(lastUser) === "stall-stream") {
        options?.signal?.addEventListener(
          "abort",
          () => {
            stream.push({
              type: "error",
              reason: "aborted",
              error: { ...message, content: [], stopReason: "aborted" },
            });
            stream.end();
          },
          { once: true },
        );
        return stream;
      }
      stream.push({ type: "done", reason: callTool ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}
