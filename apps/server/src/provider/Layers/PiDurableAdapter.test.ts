// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { createModels } from "pi-durable-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "pi-durable-ai/providers/faux";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "pi-durable-ai";
import {
  PiDurableSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { makePiDurableAdapter } from "./PiDurableAdapter.ts";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const decodeSettings = Schema.decodeSync(PiDurableSettings);
const decodeJson = Schema.decodeUnknownSync(Schema.Json);
const threadId = ThreadId.make("durable-test");
const instanceId = ProviderInstanceId.make("durable-test");
const fixture = Effect.fn(function* (
  directory?: string,
  registry?: ReturnType<typeof createRegistry>,
) {
  const root =
    directory ??
    (yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "rove-pi-durable-")),
    ));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
  );
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
  const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
  const models = createModels();
  models.setProvider(faux.provider);
  const slug = `${faux.provider.id}/test`;
  const adapter = yield* makePiDurableAdapter({
    instanceId,
    directory: root,
    models,
    enabled: true,
    config: decodeSettings({ enabled: true, model: slug }),
    registry,
  }).pipe(Effect.provideService(Scope.Scope, scope));
  const pull = yield* Stream.toPull(adapter.streamEvents).pipe(
    Effect.provideService(Scope.Scope, scope),
  );
  const collected: ProviderRuntimeEvent[] = [];
  let nextBatch = yield* Effect.forkIn(pull, scope);
  const completed = Effect.gen(function* () {
    for (;;) {
      const batch = yield* Fiber.join(nextBatch);
      nextBatch = yield* Effect.forkIn(pull, scope);
      for (const event of batch) decodeJson(event);
      collected.push(...batch);
      const event = batch.find((event) => event.type === "turn.completed");
      if (event?.type === "turn.completed") return event;
    }
  });
  const start = () => adapter.startSession({ threadId, runtimeMode: "full-access", cwd: root });
  return { adapter, models, faux, slug, scope, directory: root, collected, completed, start };
});

describe("Pi Durable with an offline model", () => {
  it.effect(
    "streams an answer and coding tools, then reopens history without making a request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.start();
          f.faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall(
                "write",
                { path: "proof.txt", content: "durable" },
                { id: "write-proof" },
              ),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("Saved the file."),
          ]);
          yield* f.adapter.sendTurn({ threadId, input: "offline test" });
          expect((yield* f.completed).payload.state).toBe("completed");
          expect(
            yield* Effect.promise(() =>
              NodeFSP.readFile(NodePath.join(f.directory, "proof.txt"), "utf8"),
            ),
          ).toBe("durable");
          expect(
            f.collected
              .flatMap((event) =>
                event.type === "content.delta" && event.payload.streamKind === "assistant_text"
                  ? [event.payload.delta]
                  : [],
              )
              .join(""),
          ).toBe("Saved the file.");
          const writeStarted = f.collected.find(
            (event) => event.type === "item.started" && event.payload.title === "write",
          );
          expect(writeStarted).toBeDefined();
          expect(
            f.collected.some(
              (event) =>
                event.type === "item.completed" &&
                event.itemId === writeStarted?.itemId &&
                event.payload.status === "completed",
            ),
          ).toBe(true);
          yield* Scope.close(f.scope, Exit.void);
          const reopened = yield* fixture(f.directory);
          const newCwd = NodePath.join(f.directory, "new-checkout");
          yield* Effect.promise(() => NodeFSP.mkdir(newCwd));
          yield* reopened.adapter.startSession({
            threadId,
            runtimeMode: "full-access",
            cwd: newCwd,
          });
          expect(reopened.faux.state.callCount).toBe(0);
          expect((yield* reopened.adapter.readThread(threadId)).turns).toHaveLength(1);
          reopened.faux.setResponses([
            fauxAssistantMessage(
              fauxToolCall("write", { path: "new.txt", content: "new checkout" }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("Updated the new checkout."),
          ]);
          yield* reopened.adapter.sendTurn({ threadId, input: "use the new checkout" });
          expect((yield* reopened.completed).payload.state).toBe("completed");
          expect(
            yield* Effect.promise(() => NodeFSP.readFile(NodePath.join(newCwd, "new.txt"), "utf8")),
          ).toBe("new checkout");
        }),
      ),
  );

  it.effect("recovers committed work after the owning process is killed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const child = NodeChildProcess.spawn(
          process.execPath,
          [
            "--experimental-strip-types",
            NodePath.join(import.meta.dirname, "fixtures/pi-durable-crash.ts"),
            f.directory,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await exited;
          }),
        );
        const started = new Promise<void>((resolve, reject) => {
          let output = "";
          let errors = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("generation-started")) resolve();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
          });
          child.once("error", reject);
          child.once("exit", () =>
            reject(new Error(`Fixture exited before its receipt: ${errors}`)),
          );
        });
        yield* Effect.promise(() => started);
        child.kill("SIGKILL");
        yield* Effect.promise(() => exited);
        yield* f.start();
        f.faux.setResponses([fauxAssistantMessage("Recovered after process death.")]);
        yield* f.adapter.sendTurn({ threadId, continuation: true });
        expect((yield* f.completed).payload.state).toBe("completed");
        expect((yield* f.adapter.readThread(threadId)).turns).toHaveLength(1);
        expect(f.faux.state.callCount).toBe(1);
      }),
    ),
  );

  it.effect("resumes pending work before processing a new message without duplicating input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.start();
        const started = deferred();
        f.faux.setResponses([
          async (_context, options) => {
            started.resolve();
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
            return fauxAssistantMessage("", { stopReason: "aborted" });
          },
        ]);
        yield* f.adapter.sendTurn({ threadId, input: "only submit once" });
        yield* Effect.promise(() => started.promise);
        yield* f.adapter.stopAll();
        yield* Scope.close(f.scope, Exit.void);
        const reopened = yield* fixture(f.directory);
        yield* reopened.start();
        reopened.faux.setResponses([
          fauxAssistantMessage("Recovered."),
          fauxAssistantMessage("Handled the follow-up."),
        ]);
        yield* reopened.adapter.sendTurn({ threadId, input: "follow-up message" });
        expect((yield* reopened.completed).payload.state).toBe("completed");
        expect((yield* reopened.adapter.readThread(threadId)).turns).toHaveLength(2);
        expect(reopened.faux.state.callCount).toBe(2);
        expect(
          reopened.collected
            .flatMap((event) =>
              event.type === "content.delta" && event.payload.streamKind === "assistant_text"
                ? [event.payload.delta]
                : [],
            )
            .join(""),
        ).toBe("Recovered.Handled the follow-up.");
      }),
    ),
  );

  it.effect("does not replay an unsafe side-effecting tool after interruption", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = createRegistry();
        const started = deferred();
        let executions = 0;
        registry.install(
          defineExtension({
            name: "unsafe-test",
            tools: [
              defineTool({
                name: "side_effect",
                parameters: Type.Object({}),
                description: "Test side effect",
                replay: "unsafe",
                execute: async (_args, _api, context) => {
                  executions++;
                  started.resolve();
                  await new Promise<void>((resolve) =>
                    context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
                  );
                  return { content: [{ type: "text", text: "side effect happened" }] };
                },
              }),
            ],
          }),
        );
        const f = yield* fixture(undefined, registry);
        yield* f.start();
        f.faux.setResponses([
          fauxAssistantMessage(fauxToolCall("side_effect", {}), { stopReason: "toolUse" }),
        ]);
        yield* f.adapter.sendTurn({ threadId, input: "side effect" });
        yield* Effect.promise(() => started.promise);
        yield* Scope.close(f.scope, Exit.void);
        const reopened = yield* fixture(f.directory, registry);
        yield* reopened.start();
        reopened.faux.setResponses([
          (context) => {
            const result = context.messages.find((message) => message.role === "toolResult");
            expect(result?.role === "toolResult" && result.isError).toBe(true);
            return fauxAssistantMessage("Interrupted tool was not replayed.");
          },
        ]);
        yield* reopened.adapter.sendTurn({ threadId, continuation: true });
        expect((yield* reopened.completed).payload.state).toBe("completed");
        expect(executions).toBe(1);
      }),
    ),
  );

  it.effect("Stop cancels persisted work rather than suspending it for a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.start();
        const started = deferred();
        f.faux.setResponses([
          async (_context, options) => {
            started.resolve();
            await new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
            return fauxAssistantMessage("", { stopReason: "aborted" });
          },
        ]);
        const turn = yield* f.adapter.sendTurn({ threadId, input: "cancel this" });
        yield* Effect.promise(() => started.promise);
        yield* f.adapter.interruptTurn(threadId, turn.turnId);
        expect((yield* f.completed).payload.state).toBe("interrupted");
        yield* f.adapter.stopSession(threadId);
        const reopened = yield* fixture(f.directory);
        yield* reopened.start();
        const result = yield* reopened.adapter
          .sendTurn({ threadId, continuation: true })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(reopened.faux.state.callCount).toBe(0);
      }),
    ),
  );

  it.effect("rejects unsupported requests before invoking the model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.start();
        const plan = yield* f.adapter
          .sendTurn({ threadId, input: "plan", interactionMode: "plan" })
          .pipe(Effect.result);
        const model = yield* f.adapter
          .sendTurn({
            threadId,
            input: "wrong model",
            modelSelection: { instanceId, model: "missing/model" },
          })
          .pipe(Effect.result);
        expect(plan._tag).toBe("Failure");
        expect(model._tag).toBe("Failure");
        expect(f.faux.state.callCount).toBe(0);
      }),
    ),
  );
});
