// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const marker = process.env.ROVE_PI_TEST_MARKER ?? "missing";
  const child = NodeChildProcess.spawnSync(process.execPath, [
    "-e",
    'process.stdout.write(process.env.ROVE_PI_TEST_MARKER ?? "missing")',
  ]);
  NodeFS.appendFileSync(
    NodePath.join(getAgentDir(), "environment.jsonl"),
    `${JSON.stringify({ marker, childMarker: child.stdout.toString(), agentDir: getAgentDir() })}\n`,
  );
  pi.registerProvider("environment-fixture", {
    baseUrl: "https://example.invalid",
    apiKey: "fixture",
    api: "openai-completions",
    models: [
      {
        id: "fixture",
        name: marker,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000,
      },
    ],
    streamSimple(model) {
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 1,
        content: [{ type: "text", text: JSON.stringify({ title: marker }) }],
        stopReason: "stop",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
}
