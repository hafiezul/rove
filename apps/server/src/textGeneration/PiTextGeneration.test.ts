import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PiSettings } from "@t3tools/contracts";

import type { PiSessionLike } from "../provider/Layers/PiAdapter.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

/** A fake throwaway Pi session whose last assistant message is `replyText`. */
const makeSessionReplying = (replyText: string): PiSessionLike => ({
  sessionId: "pi-textgen-session",
  isStreaming: false,
  messages: [
    { role: "user", content: "prompt" },
    { role: "assistant", content: replyText },
  ],
  prompt: () => Promise.resolve(),
  steer: () => Promise.resolve(),
  followUp: () => Promise.resolve(),
  abort: () => Promise.resolve(),
  dispose: () => {},
  subscribe: () => () => {},
});

const makeTextGen = (replyText: string) =>
  makePiTextGeneration(decodePiSettings({}), {
    createSession: () => Promise.resolve(makeSessionReplying(replyText)),
  });

it.effect("generateCommitMessage decodes and sanitizes the reply", () =>
  Effect.gen(function* () {
    const textGen = yield* makeTextGen(
      'Here is the commit message:\n{"subject": "feat: add pi provider", "body": "streams pi"}',
    );

    const result = yield* textGen.generateCommitMessage({
      cwd: "/tmp/repo",
      branch: "main",
      stagedSummary: "added pi",
      stagedPatch: "+pi",
      modelSelection: { instanceId: "pi" as never, model: "" },
    });

    assert.strictEqual(result.subject, "feat: add pi provider");
    assert.strictEqual(result.body, "streams pi");
  }),
);

it.effect("generateThreadTitle returns a sanitized title", () =>
  Effect.gen(function* () {
    const textGen = yield* makeTextGen('{"title": "Pi provider integration"}');

    const result = yield* textGen.generateThreadTitle({
      cwd: "/tmp/repo",
      message: "add pi as a provider",
      modelSelection: { instanceId: "pi" as never, model: "" },
    });

    assert.strictEqual(result.title, "Pi provider integration");
  }),
);

it.effect("fails when Pi returns empty output", () =>
  Effect.gen(function* () {
    const textGen = yield* makeTextGen("   ");

    const exit = yield* Effect.exit(
      textGen.generateThreadTitle({
        cwd: "/tmp/repo",
        message: "add pi",
        modelSelection: { instanceId: "pi" as never, model: "" },
      }),
    );

    assert.isTrue(exit._tag === "Failure");
  }),
);
