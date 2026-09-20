import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPiRoveTools, toPiRoveToolResult } from "./PiRoveTools.ts";

const config = {
  environmentId: EnvironmentId.make("pi-tools-env"),
  threadId: ThreadId.make("pi-tools-thread"),
  providerInstanceId: ProviderInstanceId.make("pi"),
  providerSessionId: "pi-tools-session",
  endpoint: "http://127.0.0.1:12345/mcp",
  authorizationHeader: "Bearer thread-scoped-secret",
};
const snapshot = {
  content: [
    { type: "text" as const, text: "page state" },
    { type: "image" as const, data: "cG5n", mimeType: "image/png" },
  ],
  structuredContent: { title: "Preview" },
};

// The bridge doesn't use Pi's extension context.
const execute = (tool: ToolDefinition, params = {}, signal?: AbortSignal) =>
  tool.execute("call-1", params, signal, undefined, {} as Parameters<ToolDefinition["execute"]>[4]);

function mockEndpoint() {
  let revoked = false;
  let failListing = false;
  const methods: string[] = [];
  const calls: unknown[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(config.endpoint);
    expect(new Headers(init?.headers).get("Authorization")).toBe(config.authorizationHeader);
    if (revoked) return new Response("Unauthorized", { status: 401 });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") {
      methods.push("DELETE");
      return new Response(null, { status: 204 });
    }
    const request = JSON.parse(String(init?.body));
    methods.push(request.method);
    if (request.id === undefined) return new Response(null, { status: 202 });
    if (request.method === "tools/list" && failListing) {
      return new Response("Unavailable", { status: 503 });
    }
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "Rove", version: "1" },
          }
        : request.method === "tools/list"
          ? {
              tools: [
                {
                  name: request.params.cursor ? "preview_snapshot" : "preview_status",
                  description: "Inspect preview",
                  inputSchema: { type: "object", properties: { tabId: { type: "string" } } },
                },
              ],
              nextCursor: request.params.cursor ? undefined : "page-2",
            }
          : snapshot;
    if (request.method === "tools/call") calls.push(request.params);
    return Response.json(
      { jsonrpc: "2.0", id: request.id, result },
      {
        headers: { "mcp-session-id": "session-1" },
      },
    );
  });
  vi.stubGlobal("fetch", fetch);
  return {
    methods,
    calls,
    revoke: () => {
      revoked = true;
    },
    failListing: () => {
      failListing = true;
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Pi's built-in Rove tools", () => {
  it("does nothing without a thread credential", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const bridge = await createPiRoveTools(undefined);
    expect(bridge.tools).toEqual([]);
    await bridge.dispose();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discovers all pages, authenticates calls, preserves screenshots, and closes once", async () => {
    const endpoint = mockEndpoint();
    const bridge = await createPiRoveTools(config);
    try {
      expect(bridge.tools.map((tool) => tool.name)).toEqual([
        "mcp__rove__preview_status",
        "mcp__rove__preview_snapshot",
      ]);
      expect(bridge.tools[1]!.parameters).toEqual({
        type: "object",
        properties: { tabId: { type: "string" } },
      });
      expect(await execute(bridge.tools[1]!, { tabId: "tab-1" })).toEqual({
        content: snapshot.content,
        details: snapshot.structuredContent,
      });
      expect(endpoint.calls).toEqual([{ name: "preview_snapshot", arguments: { tabId: "tab-1" } }]);
    } finally {
      await bridge.dispose();
      await bridge.dispose();
    }
    expect(endpoint.methods.filter((method) => method === "DELETE")).toHaveLength(1);
  });

  it("rejects calls after credential revocation without bypassing authorization", async () => {
    const endpoint = mockEndpoint();
    const bridge = await createPiRoveTools(config);
    endpoint.revoke();
    try {
      await expect(execute(bridge.tools[0]!)).rejects.toThrow();
      expect(endpoint.calls).toEqual([]);
    } finally {
      await bridge.dispose();
    }
  });

  it("honors tool cancellation", async () => {
    mockEndpoint();
    const bridge = await createPiRoveTools(config);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(execute(bridge.tools[0]!, {}, controller.signal)).rejects.toThrow();
    } finally {
      await bridge.dispose();
    }
  });

  it("terminates the connection when discovery fails", async () => {
    const endpoint = mockEndpoint();
    endpoint.failListing();
    await expect(createPiRoveTools(config)).rejects.toThrow();
    expect(endpoint.methods).toContain("DELETE");
  });

  it("turns MCP error results into Pi tool failures", () => {
    expect(() =>
      toPiRoveToolResult({
        isError: true,
        content: [{ type: "text", text: "Preview snapshot failed." }],
      }),
    ).toThrow("Preview snapshot failed.");
  });
});
