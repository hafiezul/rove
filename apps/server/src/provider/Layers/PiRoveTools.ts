import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import type { McpProviderSessionConfig } from "../../mcp/McpProviderSession.ts";

/** Keep MCP failures as failed Pi tool executions, not successful text results. */
export function toPiRoveToolResult(result: CallToolResult) {
  if (result.isError) {
    throw new Error(
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") || "Rove tool failed.",
    );
  }
  return {
    content: result.content.map((part) => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      if (part.type === "image") {
        return { type: "image" as const, data: part.data, mimeType: part.mimeType };
      }
      return { type: "text" as const, text: JSON.stringify(part) };
    }),
    details: result.structuredContent ?? {},
  };
}

/** Only connects to the Rove-owned endpoint supplied by the provider session registry. */
export async function createPiRoveTools(config: McpProviderSessionConfig | undefined) {
  if (!config) return { tools: [], dispose: async () => {} };

  const client = new Client({ name: "rove-pi", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(config.endpoint), {
    requestInit: { headers: { Authorization: config.authorizationHeader } },
  });
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      try {
        await transport.terminateSession();
      } catch {
        // A revoked credential or disconnected server must not prevent local cleanup.
      } finally {
        await client.close();
      }
    })());
  try {
    // SAFETY: SDK transport declares sessionId as string | undefined rather than optional.
    await client.connect(transport as Parameters<Client["connect"]>[0], { timeout: 10_000 });
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 10_000 });
      for (const tool of page.tools) {
        tools.push({
          name: `mcp__rove__${tool.name}`,
          label: tool.annotations?.title ?? tool.title ?? tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema,
          execute: async (_id, params, signal) => {
            const result = await client.callTool(
              CallToolRequestSchema.parse({
                method: "tools/call",
                params: { name: tool.name, arguments: params },
              }).params,
              CallToolResultSchema,
              signal ? { signal } : undefined,
            );
            return toPiRoveToolResult(CallToolResultSchema.parse(result));
          },
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return { tools, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
