// Stands in for a background runner that runs an agent through Pi's SDK in its own process.
import { Agent } from "./pi-agent-core/dist/agent.js";

const agent = new Agent();
await agent.runWithLifecycle(async () => {
  agent.emit({ type: "agent_start" });
  agent.emit({ type: "message_end", message: { role: "user", content: "Audit the runner" } });
  agent.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Runner audited" }],
      usage: { input: 6, output: 3 },
      stopReason: "stop",
    },
  });
  agent.emit({ type: "agent_end" });
});
