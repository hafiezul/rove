/**
 * Pi text generation — commit/PR/branch/title generation via a one-shot
 * `pi -p` print-mode process.
 *
 * See ADR 0016. Unlike the Claude and Codex paths, Pi's CLI has no
 * `--json-schema` / `--output-schema` equivalent, so the JSON object is
 * recovered from a possibly prose-wrapped, fenced reply and one corrective
 * retry is attempted before failing.
 *
 * @module textGeneration/PiTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type ModelSelection, type PiSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { parsePiModelSlug } from "../provider/Drivers/PiModels.ts";
import { buildPiTextGenerationLaunchPlan } from "../provider/Drivers/PiRuntime.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;

const RETRY_INSTRUCTION =
  "Your previous reply was not valid JSON. Reply with ONLY the JSON object, with no prose and no markdown code fences.";

type PiTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

/**
 * Build a Pi text-generation closure bound to a specific `PiSettings` payload.
 * See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

  const readStreamAsString = <E>(
    operation: PiTextGenerationOperation,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("pi", operation, cause, "Failed to collect process output"),
      ),
    );

  /**
   * Run one `pi -p` attempt and return its stdout. Pi writes warnings to
   * stderr, so only stdout carries the reply.
   */
  const runPiPrint = Effect.fn("runPiPrint")(function* (input: {
    readonly operation: PiTextGenerationOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly model: { readonly provider: string; readonly modelId: string };
  }) {
    const plan = buildPiTextGenerationLaunchPlan({
      configDirectory: piSettings.configDirectory,
      model: input.model,
    });
    const piEnvironment = { ...resolvedEnvironment, ...plan.environment };

    const runPiCommand = Effect.fn("runPiPrint.runPiCommand")(function* () {
      const spawnCommand = yield* resolveSpawnCommand(piSettings.binaryPath || "pi", plan.args, {
        env: piEnvironment,
      });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: piEnvironment,
        cwd: input.cwd,
        shell: spawnCommand.shell,
        stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("pi", input.operation, cause, "Failed to spawn Pi CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(input.operation, child.stdout),
          readStreamAsString(input.operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("pi", input.operation, cause, "Failed to read Pi CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: detail
            ? `Pi CLI command failed: ${detail}`
            : `Pi CLI command failed with code ${String(exitCode)}.`,
        });
      }

      return stdout;
    });

    return yield* runPiCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(PI_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi CLI request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
  });

  const runPiJson = Effect.fn("runPiJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation: PiTextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const model = parsePiModelSlug(modelSelection.model);
    if (!model) {
      return yield* new TextGenerationError({
        operation,
        detail: `Model '${modelSelection.model}' is not a valid Pi provider/model selection.`,
      });
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
    // Pi cannot enforce a response schema, so the first reply often carries
    // prose and markdown fences around the object. Extraction handles that;
    // the retry handles a reply with no usable object at all.
    const attempt = (attemptPrompt: string) =>
      runPiPrint({ operation, cwd, prompt: attemptPrompt, model }).pipe(
        Effect.flatMap((stdout) => decodeOutput(extractJsonObject(stdout))),
      );

    return yield* attempt(prompt).pipe(
      Effect.catchTag("SchemaError", () => attempt(`${prompt}\n\n${RETRY_INSTRUCTION}`)),
      Effect.catchTag(
        "SchemaError",
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Pi returned invalid structured output.",
            cause,
          }),
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // TextGeneration service methods
  // ---------------------------------------------------------------------------

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return { branch: sanitizeBranchFragment(generated.branch) };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return { title: sanitizeThreadTitle(generated.title) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
