import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool } from "effect/unstable/ai";

import * as CuaDriver from "../../../computerUse/CuaDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ComputerDescribeInput = Schema.Struct({
  tool: Schema.optional(
    Schema.String.annotate({
      description: "Operation name. Omit to list every operation with Cua's workflow guidance.",
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
    "Control native apps on this environment's macOS host through Cua Driver: list apps and windows, read accessibility snapshots, click, type, scroll, and capture screenshots, usually without taking over the user's cursor. Call with no arguments for Cua's workflow guidance and every operation, or with `tool` for one operation's full description and input schema, then run it with computer_call. For web pages in Rove's browser panel, use the preview_* tools instead.",
  parameters: Schema.toCodecJson(ComputerDescribeInput),
})
  .annotate(Tool.Title, "Describe computer use")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ComputerCallTool = Tool.make("computer_call", {
  description:
    "Run one Cua Driver operation on this environment's macOS host. Read its schema with computer_describe first. When the operation takes a `session` and you omit it, each Rove thread gets its own Cua session.",
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

const hasSessionArgument = ({ properties }: CuaDriver.CuaTool["inputSchema"]) =>
  typeof properties === "object" && properties !== null && "session" in properties;

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
                if (input.tool === undefined) {
                  const operations = catalog.tools
                    .map((tool) => `- ${tool.name}: ${summary(tool.description)}`)
                    .join("\n");
                  return textResult(
                    `${catalog.instructions ?? ""}\n\nOperations (run with computer_call):\n${operations}`.trim(),
                  );
                }
                const tool = catalog.tools.find((candidate) => candidate.name === input.tool);
                return tool
                  ? textResult(
                      encodeJsonText({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                      }),
                    )
                  : textResult(
                      `Cua Driver has no operation named ${input.tool}. Call computer_describe without arguments to list them.`,
                      true,
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
                  return driver
                    .call(
                      tool.name,
                      hasSessionArgument(tool.inputSchema) && args.session === undefined
                        ? { ...args, session: `rove-${invocation.threadId}` }
                        : args,
                    )
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
