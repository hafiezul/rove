import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import {
  backgroundRefusal,
  instructionsFor,
  isolatedRefusal,
  isAllowedTool,
} from "../../../computerUse/BackgroundPolicy.ts";
import * as CuaDriver from "../../../computerUse/CuaDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ComputerDescribeInput = Schema.Struct({
  tool: Schema.optional(
    Schema.String.annotate({
      description:
        "Operation name. Omit to list supported operations and target-specific workflow guidance.",
    }),
  ),
});

const ComputerCallInput = Schema.Struct({
  tool: Schema.String.annotate({ description: "Operation name from computer_describe." }),
  arguments: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "Arguments matching the operation's input schema.",
    }),
  ),
});

/**
 * Cua exposes ~60 operations whose schemas total ~150 KB. Mirroring them would
 * put that into every provider session, so agents discover them on demand.
 */
const ComputerDescribeTool = Tool.make("computer_describe", {
  description:
    "Control apps through Cua Driver. macOS uses background-only host-window operations. Linux uses a private, offline desktop per thread with guest-only apps, focus, clipboard and temporary files. It cannot access host apps, profiles or project files. Call with no arguments for target-specific workflow guidance and operations, or with `tool` for its schema. Follow that guidance before acting. For web pages in Rove's browser panel, use preview_* instead.",
  parameters: Schema.toCodecJson(ComputerDescribeInput),
})
  .annotate(Tool.Title, "Describe computer use")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ComputerCallTool = Tool.make("computer_call", {
  description:
    "Run one Cua Driver operation on the server-owned target for this thread. Read target-specific guidance and the operation schema with computer_describe first. Host macOS input stays background-only. Linux input is confined to the private desktop. Do not pass session labels or change driver configuration. close_desktop discards the calling thread's Linux desktop. Refused actions execute nothing.",
  parameters: Schema.toCodecJson(ComputerCallInput),
})
  .annotate(Tool.Title, "Use computer")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const textResult = (text: string, isError = false) =>
  new McpSchema.CallToolResult({ isError, content: [{ type: "text", text }] });

const MAX_STRUCTURED_TEXT_CHARS = 24_000;

/**
 * Cua returns window ids, snapshot ids, and element lists only in
 * `structuredContent`, with a one-line summary as text. Pi and other clients
 * show the model only the text, so repeat the structured data there, bounded
 * below Claude Code's result limit.
 */
const withStructuredText = (result: McpSchema.CallToolResult) => {
  const structured = result.structuredContent;
  if (
    structured === undefined ||
    structured === null ||
    (typeof structured === "object" && Object.keys(structured).length === 0)
  ) {
    return result;
  }
  const json = encodeJsonText(structured);
  const text =
    json.length > MAX_STRUCTURED_TEXT_CHARS
      ? `${json.slice(0, MAX_STRUCTURED_TEXT_CHARS)}…\nStructured result cut at ${MAX_STRUCTURED_TEXT_CHARS} characters. Narrow the call, for example with pid, window_id, query, or max_elements.`
      : json;
  return new McpSchema.CallToolResult({
    ...result,
    content: [...result.content, { type: "text", text: `Structured result:\n${text}` }],
  });
};

const summary = (description: string) => {
  const firstLine = description.split("\n", 1)[0] ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(firstLine)?.[0] ?? firstLine;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
};

const backgroundInputSchema = (schema: CuaDriver.CuaTool["inputSchema"]) => {
  const normalized = { ...schema };
  if (schema.properties) {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).filter(([name]) => name !== "session"),
    );
  }
  if (schema.required) normalized.required = schema.required.filter((name) => name !== "session");
  return normalized;
};

const policyRefusalResult = (reason: string, policy: CuaDriver.CuaCatalog["policy"]) =>
  new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      code: policy === "background-only" ? "background_only" : "isolated_desktop_policy",
      effect: "refused",
      executed: false,
      reason,
    },
    content: [
      {
        type: "text",
        text:
          policy === "background-only"
            ? `${reason} No action was executed. Retry with a background window action or use an app API. For web pages, use preview_*. If no safe route exists, continue other work and report the GUI step as blocked. Do not retry through foreground input or shell automation.`
            : `${reason} No action was executed. Use an allowed private-desktop operation. Rove owns sessions and target selection. Do not retry against the host desktop.`,
      },
    ],
  });

const toMcpTool = (tool: typeof ComputerDescribeTool | typeof ComputerCallTool) =>
  new McpSchema.Tool({
    name: tool.name,
    description: Tool.getDescription(tool),
    inputSchema: Tool.getJsonSchema(tool),
    annotations: {
      ...Context.getOption(tool.annotations, Tool.Title).pipe(
        Option.map((title) => ({ title })),
        Option.getOrUndefined,
      ),
      readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
      destructiveHint: Context.get(tool.annotations, Tool.Destructive),
      idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
      openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
    },
  });

const decodeDescribeInput = Schema.decodeUnknownEffect(Schema.toCodecJson(ComputerDescribeInput));
const decodeCallInput = Schema.decodeUnknownEffect(Schema.toCodecJson(ComputerCallInput));
const invalidParams = (error: Schema.SchemaError) =>
  new McpSchema.InvalidParams({ message: error.message });

const registerComputerUseTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const driver = yield* CuaDriver.CuaDriver;
  const settings = yield* ServerSettings.ServerSettingsService;

  /** Read on every call so turning the setting off stops agents mid-session. */
  const whenEnabled = <E>(
    effect: Effect.Effect<McpSchema.CallToolResult, E>,
  ): Effect.Effect<McpSchema.CallToolResult, E> =>
    settings.getSettings.pipe(
      Effect.map((current) => current.enableAgentComputerUse),
      Effect.orElseSucceed(() => false),
      Effect.flatMap((enabled) =>
        enabled
          ? effect
          : Effect.succeed(
              textResult(
                "Computer use is off for this environment. Ask the user to turn on Agent computer use in Settings → Integrations.",
                true,
              ),
            ),
      ),
    );

  const unavailable = (error: CuaDriver.CuaDriverUnavailableError) =>
    Effect.succeed(textResult(error.detail, true));

  yield* server.addTool({
    tool: toMcpTool(ComputerDescribeTool),
    annotations: ComputerDescribeTool.annotations,
    handle: (payload) =>
      decodeDescribeInput(payload ?? {}).pipe(
        Effect.mapError(invalidParams),
        Effect.flatMap((input) =>
          whenEnabled(
            driver.catalog.pipe(
              Effect.map((catalog) => {
                const instructions = instructionsFor(catalog.policy);
                if (input.tool === undefined) {
                  const operations = catalog.tools
                    .filter((tool) => isAllowedTool(tool, catalog.policy))
                    .map((tool) => `- ${tool.name}: ${summary(tool.description)}`)
                    .join("\n");
                  return textResult(
                    `${instructions}\n\n${catalog.instructions ?? ""}\n\nOperations (run with computer_call):\n${operations}`.trim(),
                  );
                }
                const tool = catalog.tools.find((candidate) => candidate.name === input.tool);
                if (!tool)
                  return textResult(
                    `Cua Driver has no operation named ${input.tool}. Call computer_describe without arguments to list them.`,
                    true,
                  );
                if (!isAllowedTool(tool, catalog.policy))
                  return policyRefusalResult(
                    `${tool.name} is not an allowed ${catalog.policy} operation.`,
                    catalog.policy,
                  );
                return textResult(
                  encodeJsonText({
                    name: tool.name,
                    description: `${instructions}\n\n${tool.description}`,
                    inputSchema: backgroundInputSchema(tool.inputSchema),
                  }),
                );
              }),
              Effect.catchTag("CuaDriverUnavailableError", unavailable),
            ),
          ),
        ),
      ),
  });

  yield* server.addTool({
    tool: toMcpTool(ComputerCallTool),
    annotations: ComputerCallTool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return decodeCallInput(payload ?? {}).pipe(
          Effect.mapError(invalidParams),
          Effect.flatMap((input) =>
            whenEnabled(
              driver.catalog.pipe(
                Effect.flatMap((catalog) => {
                  const tool = catalog.tools.find((candidate) => candidate.name === input.tool);
                  if (!tool) {
                    return Effect.succeed(
                      textResult(
                        `Cua Driver has no operation named ${input.tool}. Call computer_describe without arguments to list them.`,
                        true,
                      ),
                    );
                  }
                  const args = input.arguments ?? {};
                  const refusal =
                    catalog.policy === "isolated-desktop"
                      ? isolatedRefusal(tool, args)
                      : backgroundRefusal(tool, args);
                  if (refusal) return Effect.succeed(policyRefusalResult(refusal, catalog.policy));
                  return driver
                    .call(tool.name, args, invocation.threadId)
                    .pipe(Effect.map(withStructuredText));
                }),
                Effect.catchTag("CuaDriverUnavailableError", unavailable),
              ),
            ),
          ),
        );
      }),
  });
});

export const ComputerUseToolsRegistrationLive = Layer.effectDiscard(registerComputerUseTools);
