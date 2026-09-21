import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { PiSettings } from "@t3tools/contracts";

import type { ModelSelection } from "@t3tools/contracts";
import type { PiSessionLike } from "../provider/Layers/PiAdapter.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import { makePiTextGeneration, type PiTextGenerationOptions } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

/** A fake throwaway Pi session whose last assistant message is `lastMessage`. */
const makeSessionReplying = (lastMessage: unknown): PiSessionLike => ({
  sessionId: "pi-textgen-session",
  isStreaming: false,
  messages: [{ role: "user", content: "prompt" }, lastMessage],
  prompt: () => Promise.resolve(),
  followUp: () => Promise.resolve(),
  abort: () => Promise.resolve(),
  dispose: () => {},
  subscribe: () => () => {},
});

interface CreateSessionCall {
  cwd: string;
  model: string | undefined;
  thinkingLevel: string | undefined;
}

const makeTextGen = (
  lastMessage: unknown,
  calls: Array<CreateSessionCall> = [],
): Effect.Effect<TextGeneration.TextGeneration["Service"]> => {
  const createSession: PiTextGenerationOptions["createSession"] = (input) => {
    calls.push({ ...input });
    return Promise.resolve(makeSessionReplying(lastMessage));
  };
  return makePiTextGeneration(decodePiSettings({}), { createSession });
};

const piSelection = (overrides?: Partial<ModelSelection>): ModelSelection => ({
  instanceId: "pi" as ModelSelection["instanceId"],
  model: "openai-codex/gpt-5.3-codex-spark",
  options: [{ id: "thinkingLevel", value: "medium" }],
  ...overrides,
});

it.effect("generateCommitMessage decodes and sanitizes the reply", () =>
  Effect.gen(function* () {
    const textGen = yield* makeTextGen({
      role: "assistant",
      content:
        'Here is the commit message:\n{"subject": "feat: add pi provider", "body": "streams pi"}',
    });

    const result = yield* textGen.generateCommitMessage({
      cwd: "/tmp/repo",
      branch: "main",
      stagedSummary: "added pi",
      stagedPatch: "+pi",
      modelSelection: piSelection(),
    });

    assert.strictEqual(result.subject, "feat: add pi provider");
    assert.strictEqual(result.body, "streams pi");
  }),
);

it.effect("generateThreadTitle returns a sanitized title", () =>
  Effect.gen(function* () {
    const textGen = yield* makeTextGen({
      role: "assistant",
      content: '{"title": "Pi provider integration"}',
    });

    const result = yield* textGen.generateThreadTitle({
      cwd: "/tmp/repo",
      message: "add pi as a provider",
      modelSelection: piSelection(),
    });

    assert.strictEqual(result.title, "Pi provider integration");
  }),
);

it.effect("createSession receives the selection's model and thinking level", () =>
  Effect.gen(function* () {
    const calls: Array<CreateSessionCall> = [];
    const textGen = yield* makeTextGen({ role: "assistant", content: '{"title": "t"}' }, calls);

    yield* textGen.generateThreadTitle({
      cwd: "/tmp/repo",
      message: "add pi",
      modelSelection: piSelection(),
    });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0]!.cwd, "/tmp/repo");
    assert.strictEqual(calls[0]!.model, "openai-codex/gpt-5.3-codex-spark");
    assert.strictEqual(calls[0]!.thinkingLevel, "medium");
  }),
);

it.effect("a blank selection model defers to the user's Pi default", () =>
  Effect.gen(function* () {
    const calls: Array<CreateSessionCall> = [];
    const textGen = yield* makeTextGen({ role: "assistant", content: '{"title": "t"}' }, calls);

    yield* textGen.generateThreadTitle({
      cwd: "/tmp/repo",
      message: "add pi",
      modelSelection: piSelection({ model: "  " }),
    });

    assert.strictEqual(calls[0]!.model, undefined);
  }),
);

it.effect("fails when Pi returns empty output", () =>
  Effect.gen(function* () {
    const textGen = yield* makeTextGen("   ");

    const exit = yield* Effect.exit(
      textGen.generateThreadTitle({
        cwd: "/tmp/repo",
        message: "add pi",
        modelSelection: piSelection(),
      }),
    );

    assert.isTrue(Exit.isFailure(exit));
  }),
);

it.effect("a recorded model-call error surfaces the provider message", () =>
  Effect.gen(function* () {
    const textGen = yield* makeTextGen({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: 'OpenAI API error (403): {"type":"FreeTierError"}',
    });

    const error = yield* textGen
      .generateThreadTitle({
        cwd: "/tmp/repo",
        message: "add pi",
        modelSelection: piSelection(),
      })
      .pipe(Effect.flip);

    assert.strictEqual(error.operation, "generateThreadTitle");
    assert.strictEqual(error.detail, 'OpenAI API error (403): {"type":"FreeTierError"}');
  }),
);

it.effect("a recorded model-call error without a message is not read as empty output", () =>
  Effect.gen(function* () {
    const textGen = yield* makeTextGen({ role: "assistant", content: [], stopReason: "error" });

    const error = yield* textGen
      .generateThreadTitle({
        cwd: "/tmp/repo",
        message: "add pi",
        modelSelection: piSelection(),
      })
      .pipe(Effect.flip);

    assert.strictEqual(error.detail, "Pi assistant response failed.");
  }),
);
