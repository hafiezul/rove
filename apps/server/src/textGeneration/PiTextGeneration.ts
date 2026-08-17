/**
 * PiTextGeneration — commit / PR / branch / thread-title text generation via
 * a throwaway in-memory Pi session on the user's default model.
 *
 * Each operation spins up an ephemeral `PiSessionLike` (in-memory, never
 * persisted), prompts it with the shared text-generation prompt builders, and
 * decodes the structured JSON from the reply. The session is always disposed.
 * The factory is injected so tests drive a fake Pi instead of real LLM calls.
 *
 * @module textGeneration/PiTextGeneration
 */
import { TextGenerationError, type PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import type { PiSessionLike } from "../provider/Layers/PiAdapter.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import * as RuntimePredicate from "effect/Predicate";

type TextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

export interface PiTextGenerationOptions {
  /** Builds a throwaway in-memory session (real SDK in the driver, a fake in tests). */
  readonly createSession: (input: { cwd: string }) => Promise<PiSessionLike>;
}

export const makePiTextGeneration = (
  _piSettings: PiSettings,
  options: PiTextGenerationOptions,
): Effect.Effect<TextGeneration.TextGeneration["Service"]> =>
  Effect.suspend(() => {
    const createSession = options.createSession;

    /**
     * Run one structured generation against a throwaway session. The prompt
     * asks for a single JSON object; the reply is the session's last
     * assistant text, which we decode with the operation's schema.
     */
    const runPiJson = <S extends Schema.Top>(input: {
      operation: TextGenerationOperation;
      cwd: string;
      prompt: string;
      outputSchema: S;
    }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      // Hoisted per lint: compile the JSON decoder once per schema, not per call.
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => createSession({ cwd: input.cwd }),
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Failed to start a Pi text-generation session.",
              cause,
            }),
        }),
        (session) =>
          Effect.tryPromise({
            try: async () => {
              await session.prompt(input.prompt);
              const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
                last = session.messages.at(-1) as { role?: string; content?: unknown } | undefined;
              const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
                text = RuntimePredicate.isString(last?.content)
                  ? last.content
                  : Array.isArray(last?.content)
                    ? (last.content as Array<{ type?: string; text?: string }>)
                        .filter((part) => part.type === "text")
                        .map((part) => part.text ?? "")
                        .join("")
                    : "";
              return text.trim();
            },
            catch: (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Pi text generation failed.",
                cause,
              }),
          }).pipe(
            Effect.flatMap((trimmed) => {
              if (trimmed.length === 0) {
                return Effect.fail(
                  new TextGenerationError({
                    operation: input.operation,
                    detail: "Pi returned empty output.",
                  }),
                );
              }
              // The prompt builders rebuild the schema per call, so the
              // decoder cannot be hoisted to a stable module-level const.
              // oxlint-disable-next-line t3code/no-inline-schema-compile
              return Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
                extractJsonObject(trimmed),
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new TextGenerationError({
                      operation: input.operation,
                      detail: "Pi returned invalid structured output.",
                      cause,
                    }),
                ),
              );
            }),
          ),
        (session) => Effect.sync(() => session.dispose()),
      );

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
        const { prompt, outputSchema } = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const generated = yield* runPiJson({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt,
          outputSchema,
        });
        return {
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && RuntimePredicate.isString(generated.branch)
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : undefined),
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
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        });
        const generated = yield* runPiJson({
          operation: "generatePrContent",
          cwd: input.cwd,
          prompt,
          outputSchema,
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
          outputSchema,
        });
        return { branch: sanitizeBranchFragment(generated.branch) };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
      Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
        const { prompt, outputSchema } = buildThreadTitlePrompt({
          message: input.message,
          ...(input.previousTitle !== undefined
            ? { previousTitle: input.previousTitle }
            : undefined),
          ...(input.attachments !== undefined ? { attachments: input.attachments } : undefined),
        });
        const generated = yield* runPiJson({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt,
          outputSchema,
        });
        return { title: sanitizeThreadTitle(generated.title) };
      });

    return Effect.succeed({
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    } satisfies TextGeneration.TextGeneration["Service"]);
  });
