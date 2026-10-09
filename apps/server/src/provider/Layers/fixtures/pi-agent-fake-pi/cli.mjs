// Stands in for the Pi CLI: loads the `-e` extension the agent hook added and
// replays a short run through the public extension events.
import * as NodeModule from "node:module";

const require = NodeModule.createRequire(import.meta.url);
const flag = process.argv.indexOf("-e");
if (flag < 0) {
  console.error("the agent hook did not add itself as an extension");
  process.exit(3);
}
const loaded = require(process.argv[flag + 1]);
const handlers = new Map();
const pi = { on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
(loaded.default ?? loaded)(pi);
const fire = (name, event, ctx) => {
  for (const handler of handlers.get(name) ?? []) handler({ type: name, ...event }, ctx);
};
const task = process.env.FAKE_PI_TASK ?? "Inspect the repo\nand report back";
fire(
  "session_start",
  { reason: "startup" },
  {
    model: { provider: "test", id: "fake-model" },
    sessionManager: { getSessionFile: () => undefined, getSessionName: () => undefined },
  },
);
fire("agent_start", {});
fire("message_end", { message: { role: "user", content: [{ type: "text", text: task }] } });
fire("tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "src/a.ts" } });
fire("tool_execution_end", {
  toolCallId: "c1",
  toolName: "read",
  isError: false,
  result: { content: [{ type: "text", text: "file body" }] },
});
fire("message_end", {
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Done: found 3 files" }],
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    stopReason: "stop",
    provider: "test",
    model: "fake-model",
  },
});
fire("agent_end", {});
