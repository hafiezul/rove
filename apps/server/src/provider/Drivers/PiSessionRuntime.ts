import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { PiRpcModel } from "./PiModels.ts";
import { buildPiLaunchPlan, buildPiModelProbeLaunchPlan } from "./PiRuntime.ts";
import {
  parsePiExtensionCommandsResponse,
  parsePiGetCommandsResponse,
  type PiRpcExtensionCommand,
  type PiRpcSkillCommand,
} from "./PiSkills.ts";

const PI_RPC_REQUEST_TIMEOUT = "15 seconds" as const;
const PI_RPC_START_TIMEOUT = "30 seconds" as const;
const PI_RPC_FORCE_KILL_AFTER = "2 seconds" as const;
/** Upper bound on retained Pi stderr so a chatty process cannot grow memory. */
const PI_STDERR_DIAGNOSTIC_LIMIT = 4096;
/** Grace period for stderr to flush after the transport dies, before reporting. */
const PI_STDERR_FLUSH_TIMEOUT = "250 millis" as const;
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeUnknownJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

export class PiSessionRuntimeError extends Schema.TaggedErrorClass<PiSessionRuntimeError>()(
  "PiSessionRuntimeError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

const isPiSessionRuntimeError = Schema.is(PiSessionRuntimeError);

/** Synthetic raw event emitted when Pi's process or RPC transport becomes unusable. */
export const PI_RPC_TRANSPORT_FAILURE_EVENT_TYPE = "pi_rpc_transport_failure";

export interface PiRpcTransportFailureEvent {
  readonly type: typeof PI_RPC_TRANSPORT_FAILURE_EVENT_TYPE;
  readonly operation: string;
  readonly detail: string;
}

export function isPiSessionRuntimeTransportError(error: PiSessionRuntimeError): boolean {
  return (
    error.operation === "read-stdout" ||
    error.operation === "process-exit" ||
    error.operation === "write-stdin"
  );
}

export interface PiSessionRuntimeOptions {
  readonly binaryPath: string;
  readonly configDirectory: string;
  readonly launchArgs: string;
  readonly trustedExtensions: ReadonlyArray<string>;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  /** Both fields are set for a persisted native session and omitted for a model probe. */
  readonly sessionDirectory?: string | undefined;
  readonly sessionId?: string | undefined;
  /** Set only for a thread resuming a rollback fork, which is opened by path. */
  readonly sessionFile?: string | undefined;
}

export interface PiSessionRuntimeState {
  readonly sessionId: string;
  readonly sessionFile?: string | undefined;
  readonly model?: PiRpcModel | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly autoCompactionEnabled?: boolean | undefined;
}

/**
 * Pi's own accounting of the session's token usage. `contextTokens` and
 * `contextWindow` are absent whenever Pi cannot state the context size, which
 * includes the window between a compaction and the next model response.
 */
export interface PiSessionStats {
  readonly totalTokens: number;
  readonly contextTokens?: number | undefined;
  readonly contextWindow?: number | undefined;
}

/**
 * The Pi entry a T3 turn settled at, used as the fork target for a later
 * revert. `userEntryId` is the user message that opened the turn; forking
 * from it discards that turn and everything after it.
 */
export interface PiTurnAnchor {
  readonly userEntryId: string;
  readonly leafId: string;
}

export interface PiPromptImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/**
 * Outcome of a Pi `fork`. Pi reports `cancelled` when an extension's
 * `session_before_fork` handler vetoed it, in which case the session is
 * untouched.
 */
export interface PiForkResult {
  readonly cancelled: boolean;
  readonly state: PiSessionRuntimeState;
}

export interface PiPromptInput {
  readonly message: string;
  readonly images?: ReadonlyArray<PiPromptImage> | undefined;
  readonly streamingBehavior?: "steer" | "followUp" | undefined;
}

export type PiExtensionUiResponse =
  | { readonly id: string; readonly value: string }
  | { readonly id: string; readonly confirmed: boolean }
  | { readonly id: string; readonly cancelled: true };

export interface PiSessionRuntimeShape {
  readonly start: () => Effect.Effect<PiSessionRuntimeState, PiSessionRuntimeError>;
  readonly getState: () => Effect.Effect<PiSessionRuntimeState, PiSessionRuntimeError>;
  readonly getSessionStats: () => Effect.Effect<PiSessionStats, PiSessionRuntimeError>;
  /**
   * Read where the current turn landed in Pi's entry tree. Pi's streamed
   * messages carry no entry id, so this probe is the only way to learn it.
   *
   * `since` is the previous turn's leaf id, which scopes the read to entries
   * appended after it. Without it the anchor could not tell the turn's own
   * first user message apart from the thread's very first one.
   */
  readonly getTurnAnchor: (
    since?: string | undefined,
  ) => Effect.Effect<PiTurnAnchor | undefined, PiSessionRuntimeError>;
  /**
   * Fork the session before `entryId`, discarding that user message and
   * everything after it. Pi has no in-place branch command over RPC, so this
   * replaces the live session with a new file (see ADR 0017).
   */
  readonly fork: (entryId: string) => Effect.Effect<PiForkResult, PiSessionRuntimeError>;
  readonly getAvailableModels: () => Effect.Effect<
    ReadonlyArray<PiRpcModel>,
    PiSessionRuntimeError
  >;
  readonly setModel: (input: {
    readonly provider: string;
    readonly modelId: string;
  }) => Effect.Effect<void, PiSessionRuntimeError>;
  readonly getAvailableThinkingLevels: () => Effect.Effect<
    ReadonlyArray<string>,
    PiSessionRuntimeError
  >;
  readonly setThinkingLevel: (level: string) => Effect.Effect<void, PiSessionRuntimeError>;
  /**
   * List the commands Pi actually loaded via RPC `get_commands`: skills
   * (`source: "skill"`) and trusted-extension slash commands
   * (`source: "extension"`). Both come from one response so a single probe
   * reflects exactly what the configured binary loaded.
   */
  readonly getCommands: () => Effect.Effect<
    {
      readonly skills: ReadonlyArray<PiRpcSkillCommand>;
      readonly extensionCommands: ReadonlyArray<PiRpcExtensionCommand>;
    },
    PiSessionRuntimeError
  >;
  /** Accept a normal Pi RPC prompt; lifecycle events continue asynchronously. */
  readonly prompt: (input: PiPromptInput) => Effect.Effect<void, PiSessionRuntimeError>;
  /** Invoke Pi's native abort command for the active operation. */
  readonly abort: () => Effect.Effect<void, PiSessionRuntimeError>;
  /** Respond to a pending Pi extension UI dialog without awaiting an RPC response. */
  readonly respondToExtensionUI: (
    response: PiExtensionUiResponse,
  ) => Effect.Effect<void, PiSessionRuntimeError>;
  /** Raw Pi protocol events retained for later lifecycle/diagnostic mapping. */
  readonly events: Stream.Stream<unknown>;
  readonly close: Effect.Effect<void>;
}

interface PendingRequest {
  readonly command: string;
  readonly deferred: Deferred.Deferred<unknown, PiSessionRuntimeError>;
}

interface PiRpcResponse {
  readonly id: string;
  readonly command?: string | undefined;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string | undefined;
}

/**
 * Strict LF-delimited JSONL decoder for Pi RPC stdout.
 *
 * Pi permits Unicode line separators inside JSON payloads, so this must not
 * use `readline`, `Stream.splitLines`, or any other generic line reader.
 */
export interface PiJsonlDecoder {
  readonly push: (chunk: string) => ReadonlyArray<string>;
  readonly end: () => ReadonlyArray<string>;
}

export function makePiJsonlDecoder(): PiJsonlDecoder {
  let buffer = "";

  const normalize = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line);

  return {
    push(chunk) {
      buffer += chunk;
      const records: string[] = [];
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          return records;
        }
        records.push(normalize(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    },
    end() {
      if (buffer.length === 0) {
        return [];
      }
      const record = normalize(buffer);
      buffer = "";
      return [record];
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isPiRpcTransportFailureEvent(value: unknown): value is PiRpcTransportFailureEvent {
  return (
    isRecord(value) &&
    value.type === PI_RPC_TRANSPORT_FAILURE_EVENT_TYPE &&
    stringValue(value.operation) !== undefined &&
    stringValue(value.detail) !== undefined
  );
}

/**
 * Pi's thinking overrides map a level to a provider-specific value, or to
 * `null` to disable it. Anything else is not a usable override.
 */
function parseThinkingLevelMap(value: unknown): Record<string, string | null> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries: Record<string, string | null> = {};
  for (const [level, mapped] of Object.entries(value)) {
    if (mapped === null || typeof mapped === "string") {
      entries[level] = mapped;
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function parseModel(value: unknown): PiRpcModel | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = stringValue(value.provider);
  const id = stringValue(value.id);
  if (!provider || !id) {
    return undefined;
  }
  // `reasoning` and `thinkingLevelMap` are what the catalog probe derives
  // thinking levels from, so they must survive parsing.
  const thinkingLevelMap = parseThinkingLevelMap(value.thinkingLevelMap);
  return {
    provider,
    id,
    name: stringValue(value.name) ?? id,
    ...(typeof value.reasoning === "boolean" ? { reasoning: value.reasoning } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

function parseState(value: unknown): PiSessionRuntimeState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const sessionId = stringValue(value.sessionId);
  if (!sessionId) {
    return undefined;
  }
  const model = parseModel(value.model);
  const sessionFile = stringValue(value.sessionFile);
  const thinkingLevel = stringValue(value.thinkingLevel);
  return {
    sessionId,
    ...(sessionFile ? { sessionFile } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(typeof value.autoCompactionEnabled === "boolean"
      ? { autoCompactionEnabled: value.autoCompactionEnabled }
      : {}),
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function parseSessionStats(value: unknown): PiSessionStats | undefined {
  if (!isRecord(value) || !isRecord(value.tokens)) {
    return undefined;
  }
  const totalTokens = tokenCount(value.tokens.total);
  if (totalTokens === undefined) {
    return undefined;
  }
  const contextUsage = isRecord(value.contextUsage) ? value.contextUsage : undefined;
  // Pi reports a null context size between a compaction and the next model
  // response, and zero before the session has spent anything. Neither is worth
  // reporting as a context measurement.
  const rawContextTokens = tokenCount(contextUsage?.tokens);
  const contextTokens = rawContextTokens === 0 ? undefined : rawContextTokens;
  const rawContextWindow = tokenCount(contextUsage?.contextWindow);
  const contextWindow = rawContextWindow === 0 ? undefined : rawContextWindow;
  return {
    totalTokens,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/**
 * Pi's entry tree spans abandoned branches and pre-compaction history, so the
 * anchor is read from a `since`-scoped window rather than by counting
 * positions. Within that window the anchor is the *first* user message: a T3
 * turn absorbs follow-ups sent while it runs, and each one appends its own Pi
 * user entry, so forking at the first discards the whole turn (ADR 0018).
 */
function parseTurnAnchor(value: unknown): PiTurnAnchor | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return undefined;
  }
  const leafId = stringValue(value.leafId);
  if (!leafId) {
    return undefined;
  }
  for (const entry of value.entries) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) {
      continue;
    }
    if (entry.message.role !== "user") {
      continue;
    }
    const userEntryId = stringValue(entry.id);
    if (userEntryId) {
      return { userEntryId, leafId };
    }
  }
  return undefined;
}

function parseResponse(value: unknown): PiRpcResponse | undefined {
  if (!isRecord(value) || value.type !== "response") {
    return undefined;
  }
  const id = stringValue(value.id);
  if (!id || typeof value.success !== "boolean") {
    return undefined;
  }
  const command = stringValue(value.command);
  const error = stringValue(value.error);
  return {
    id,
    success: value.success,
    ...(command ? { command } : {}),
    ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
    ...(error ? { error } : {}),
  };
}

function resolveLaunchPlan(input: PiSessionRuntimeOptions) {
  const hasSessionDirectory = input.sessionDirectory !== undefined;
  const hasSessionId = input.sessionId !== undefined;
  if (hasSessionDirectory !== hasSessionId) {
    return {
      _tag: "Failure" as const,
      message: "Pi session directory and session ID must be configured together.",
    };
  }
  if (input.sessionDirectory !== undefined && input.sessionId !== undefined) {
    return buildPiLaunchPlan({
      configDirectory: input.configDirectory,
      launchArgs: input.launchArgs,
      trustedExtensions: input.trustedExtensions,
      sessionDirectory: input.sessionDirectory,
      sessionId: input.sessionId,
      ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
    });
  }
  return buildPiModelProbeLaunchPlan({
    configDirectory: input.configDirectory,
    launchArgs: input.launchArgs,
    trustedExtensions: input.trustedExtensions,
    ...(input.environment ? { environment: input.environment } : {}),
  });
}

export const makePiSessionRuntime = (
  options: PiSessionRuntimeOptions,
): Effect.Effect<
  PiSessionRuntimeShape,
  PiSessionRuntimeError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const launchPlan = resolveLaunchPlan(options);
    if (launchPlan._tag === "Failure") {
      return yield* new PiSessionRuntimeError({
        operation: "build-launch-plan",
        detail: launchPlan.message,
      });
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const environment = {
      ...options.environment,
      ...launchPlan.environment,
    };
    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, launchPlan.args, {
      env: environment,
      extendEnv: true,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          env: environment,
          extendEnv: true,
          forceKillAfter: PI_RPC_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
          stdin: { stream: "pipe", endOnDone: false },
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new PiSessionRuntimeError({
              operation: "spawn",
              detail: `Could not start '${options.binaryPath}' in RPC mode.`,
              cause,
            }),
        ),
      );

    const pendingRequests = yield* Ref.make(new Map<string, PendingRequest>());
    const requestNumber = yield* Ref.make(0);
    const writeLock = yield* Semaphore.make(1);
    const rawEvents = yield* Queue.unbounded<unknown, Cause.Done>();
    const closed = yield* Ref.make(false);
    const decoder = makePiJsonlDecoder();

    // Pi describes fatal startup/runtime problems (bad flags, unloadable
    // extensions, crashes) only on stderr. Retain the tail so transport
    // failures can report a cause instead of an opaque "stream failed".
    const stderrBuffer = yield* Ref.make("");
    const appendStderr = (chunk: string) =>
      Ref.update(stderrBuffer, (current) => {
        const combined = current + chunk;
        return combined.length > PI_STDERR_DIAGNOSTIC_LIMIT
          ? combined.slice(combined.length - PI_STDERR_DIAGNOSTIC_LIMIT)
          : combined;
      });

    // Drain stderr even before lifecycle mapping/diagnostics is enabled. An
    // unread stderr pipe can otherwise block an otherwise healthy Pi process.
    const stderrFiber = yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach(appendStderr),
      Effect.ignore,
      Effect.forkIn(runtimeScope),
    );

    const failPendingRequests = (error: PiSessionRuntimeError) =>
      Ref.getAndSet(pendingRequests, new Map<string, PendingRequest>()).pipe(
        Effect.flatMap((pending) =>
          Effect.forEach(
            Array.from(pending.values()),
            (request) => Deferred.fail(request.deferred, error).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const finishUnexpectedTransportFailure = Effect.fn(
      "PiSessionRuntime.finishUnexpectedTransportFailure",
    )(function* (error: PiSessionRuntimeError) {
      if (yield* Ref.getAndSet(closed, true)) {
        return;
      }

      // Kill first so stderr reaches end-of-stream: the transport is already
      // unusable, and a still-running Pi would never close the pipe.
      yield* child.kill({ forceKillAfter: PI_RPC_FORCE_KILL_AFTER }).pipe(Effect.ignore);
      // stdout can close before the dying process' stderr has been drained, so
      // wait for that fibre before reading the diagnostic, capped so a wedged
      // pipe cannot block the failure report.
      yield* Fiber.await(stderrFiber).pipe(Effect.timeout(PI_STDERR_FLUSH_TIMEOUT), Effect.ignore);
      const stderrTail = (yield* Ref.get(stderrBuffer)).trim();
      const detail =
        stderrTail.length > 0 ? `${error.detail} Pi stderr: ${stderrTail}` : error.detail;

      yield* Queue.offer(rawEvents, {
        type: PI_RPC_TRANSPORT_FAILURE_EVENT_TYPE,
        operation: error.operation,
        detail,
      } satisfies PiRpcTransportFailureEvent);
      yield* failPendingRequests(error);
      // `end` drains the failure event before completing the event stream.
      // `shutdown` would interrupt the adapter before it could mark an active
      // T3 turn interrupted and retain the diagnostic payload.
      yield* Queue.end(rawEvents);
    });

    const removePendingRequest = (id: string) =>
      Ref.update(pendingRequests, (pending) => {
        if (!pending.has(id)) {
          return pending;
        }
        const next = new Map(pending);
        next.delete(id);
        return next;
      });

    const handleResponse = (response: PiRpcResponse) =>
      Ref.modify(pendingRequests, (pending) => {
        const request = pending.get(response.id);
        if (!request) {
          return [undefined, pending] as const;
        }
        const next = new Map(pending);
        next.delete(response.id);
        return [request, next] as const;
      }).pipe(
        Effect.flatMap((request) => {
          if (!request) {
            return Effect.void;
          }
          if (response.success) {
            return Deferred.succeed(request.deferred, response.data).pipe(Effect.asVoid);
          }
          return Deferred.fail(
            request.deferred,
            new PiSessionRuntimeError({
              operation: request.command,
              detail: response.error ?? "Pi rejected the RPC command.",
            }),
          ).pipe(Effect.asVoid);
        }),
      );

    const handleRecord = (record: string) => {
      if (record.length === 0) {
        return Effect.void;
      }
      return decodeUnknownJson(record).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Queue.offer(rawEvents, {
              type: "pi_rpc_invalid_json",
              raw: record,
            }).pipe(Effect.asVoid),
          onSuccess: (value) => {
            const response = parseResponse(value);
            return response
              ? handleResponse(response)
              : Queue.offer(rawEvents, value).pipe(Effect.asVoid);
          },
        }),
      );
    };

    const flushDecoder = () =>
      Effect.forEach(decoder.end(), handleRecord, { discard: true }).pipe(Effect.asVoid);

    const outputFiber = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.forEach(decoder.push(chunk), handleRecord, { discard: true }).pipe(Effect.asVoid),
      ),
      Effect.ensuring(flushDecoder()),
      Effect.exit,
      Effect.flatMap((exit) =>
        finishUnexpectedTransportFailure(
          Exit.isSuccess(exit)
            ? new PiSessionRuntimeError({
                operation: "read-stdout",
                detail: "Pi RPC stdout closed unexpectedly.",
              })
            : new PiSessionRuntimeError({
                operation: "read-stdout",
                detail: "Pi RPC stdout connection failed.",
                cause: exit.cause,
              }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          finishUnexpectedTransportFailure(
            new PiSessionRuntimeError({
              operation: "process-exit",
              detail: "Could not read Pi process exit status.",
              cause,
            }),
          ),
        onSuccess: (code) =>
          finishUnexpectedTransportFailure(
            new PiSessionRuntimeError({
              operation: "process-exit",
              detail:
                code === 0
                  ? "Pi RPC process exited."
                  : `Pi RPC process exited with code ${String(code)}.`,
            }),
          ),
      }),
      Effect.forkIn(runtimeScope),
    );

    const writeCommand = (record: Record<string, unknown>) =>
      encodeUnknownJson(record).pipe(
        Effect.mapError(
          (cause) =>
            new PiSessionRuntimeError({
              operation: "encode-command",
              detail: "Could not encode Pi RPC command.",
              cause,
            }),
        ),
        Effect.flatMap((encoded) =>
          writeLock.withPermit(
            Stream.run(Stream.encodeText(Stream.make(`${encoded}\n`)), child.stdin),
          ),
        ),
        Effect.mapError((cause) =>
          isPiSessionRuntimeError(cause)
            ? cause
            : new PiSessionRuntimeError({
                operation: "write-stdin",
                detail: "Could not write Pi RPC command.",
                cause,
              }),
        ),
        Effect.tapError((error) =>
          error.operation === "write-stdin" ? finishUnexpectedTransportFailure(error) : Effect.void,
        ),
      );

    const request = Effect.fn("PiSessionRuntime.request")(function* (
      command: Record<string, unknown>,
      timeout = PI_RPC_REQUEST_TIMEOUT,
    ) {
      const closedNow = yield* Ref.get(closed);
      if (closedNow) {
        return yield* new PiSessionRuntimeError({
          operation: String(command.type ?? "command"),
          detail: "Pi RPC session is closed.",
        });
      }

      const sequence = yield* Ref.modify(requestNumber, (current) => [current + 1, current + 1]);
      const id = `t3-pi-${sequence}`;
      const deferred = yield* Deferred.make<unknown, PiSessionRuntimeError>();
      const commandName = String(command.type ?? "command");
      yield* Ref.update(pendingRequests, (pending) => {
        const next = new Map(pending);
        next.set(id, { command: commandName, deferred });
        return next;
      });

      yield* writeCommand({ ...command, id }).pipe(Effect.onError(() => removePendingRequest(id)));

      const response = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(timeout),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              removePendingRequest(id).pipe(
                Effect.andThen(
                  new PiSessionRuntimeError({
                    operation: commandName,
                    detail: `Timed out waiting for Pi RPC response after ${timeout}.`,
                  }),
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      return response;
    });

    const getState = (
      timeout: typeof PI_RPC_REQUEST_TIMEOUT | typeof PI_RPC_START_TIMEOUT = PI_RPC_REQUEST_TIMEOUT,
    ) =>
      request({ type: "get_state" }, timeout).pipe(
        Effect.flatMap((response) => {
          const state = parseState(response);
          return state
            ? Effect.succeed(state)
            : Effect.fail(
                new PiSessionRuntimeError({
                  operation: "get_state",
                  detail: "Pi returned an invalid session state response.",
                }),
              );
        }),
      );

    const start = () =>
      getState(PI_RPC_START_TIMEOUT).pipe(
        Effect.flatMap((state) => {
          // A resumed fork's native id is a Pi-generated UUID, not the thread
          // id, so the identity assertion only applies to `--session-id`.
          if (
            options.sessionFile === undefined &&
            options.sessionId !== undefined &&
            state.sessionId !== options.sessionId
          ) {
            return Effect.fail(
              new PiSessionRuntimeError({
                operation: "get_state",
                detail: `Pi started session '${state.sessionId}' instead of required session '${options.sessionId}'.`,
              }),
            );
          }
          return Effect.succeed(state);
        }),
      );

    const getSessionStats = () =>
      request({ type: "get_session_stats" }).pipe(
        Effect.flatMap((response) => {
          const stats = parseSessionStats(response);
          return stats
            ? Effect.succeed(stats)
            : Effect.fail(
                new PiSessionRuntimeError({
                  operation: "get_session_stats",
                  detail: "Pi returned an invalid session stats response.",
                }),
              );
        }),
      );

    const getTurnAnchor = (since?: string | undefined) => {
      if (since === undefined) {
        return request({ type: "get_entries" }).pipe(Effect.map(parseTurnAnchor));
      }
      // Pi rejects a cursor it cannot find (e.g. the entry was compacted away).
      // Re-read the whole tree so the turn still gets an anchor.
      return request({ type: "get_entries", since }).pipe(
        Effect.catchTag("PiSessionRuntimeError", () => request({ type: "get_entries" })),
        Effect.map(parseTurnAnchor),
      );
    };

    const fork = (entryId: string) =>
      request({ type: "fork", entryId }).pipe(
        Effect.flatMap((response) => {
          const cancelled = isRecord(response) && response.cancelled === true;
          // Pi swaps the runtime onto a new session file, so the post-fork
          // identity has to be re-read rather than assumed.
          return getState().pipe(Effect.map((state) => ({ cancelled, state })));
        }),
      );

    const getAvailableModels = () =>
      request({ type: "get_available_models" }).pipe(
        Effect.flatMap((response) => {
          if (!isRecord(response) || !Array.isArray(response.models)) {
            return Effect.fail(
              new PiSessionRuntimeError({
                operation: "get_available_models",
                detail: "Pi returned an invalid model catalog response.",
              }),
            );
          }
          return Effect.succeed(
            response.models.flatMap((model) => {
              const parsed = parseModel(model);
              return parsed ? [parsed] : [];
            }),
          );
        }),
      );

    const setModel = (input: { readonly provider: string; readonly modelId: string }) =>
      request({
        type: "set_model",
        provider: input.provider,
        modelId: input.modelId,
      }).pipe(Effect.asVoid);

    const getAvailableThinkingLevels = () =>
      request({ type: "get_available_thinking_levels" }).pipe(
        Effect.flatMap((response) => {
          if (!isRecord(response) || !Array.isArray(response.levels)) {
            return Effect.fail(
              new PiSessionRuntimeError({
                operation: "get_available_thinking_levels",
                detail: "Pi returned an invalid thinking-level response.",
              }),
            );
          }
          const seen = new Set<string>();
          const levels: string[] = [];
          for (const value of response.levels) {
            const level = stringValue(value);
            if (!level || seen.has(level)) {
              continue;
            }
            seen.add(level);
            levels.push(level);
          }
          return Effect.succeed(levels);
        }),
      );

    const setThinkingLevel = (level: string) =>
      request({ type: "set_thinking_level", level }).pipe(Effect.asVoid);

    const getCommands = () =>
      request({ type: "get_commands" }).pipe(
        Effect.map((response) => ({
          skills: parsePiGetCommandsResponse(response),
          extensionCommands: parsePiExtensionCommandsResponse(response),
        })),
      );

    const prompt = (input: PiPromptInput) =>
      request({
        type: "prompt",
        message: input.message,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        ...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
      }).pipe(Effect.asVoid);

    const abort = () => request({ type: "abort" }).pipe(Effect.asVoid);

    const respondToExtensionUI = Effect.fn("PiSessionRuntime.respondToExtensionUI")(function* (
      response: PiExtensionUiResponse,
    ) {
      const closedNow = yield* Ref.get(closed);
      if (closedNow) {
        return yield* new PiSessionRuntimeError({
          operation: "extension_ui_response",
          detail: "Pi RPC session is closed.",
        });
      }
      yield* writeCommand({ type: "extension_ui_response", ...response });
    });

    const close = Ref.getAndSet(closed, true).pipe(
      Effect.flatMap((wasClosed) => {
        if (wasClosed) {
          return Effect.void;
        }
        return child.kill({ forceKillAfter: PI_RPC_FORCE_KILL_AFTER }).pipe(
          Effect.ignore,
          Effect.andThen(
            failPendingRequests(
              new PiSessionRuntimeError({
                operation: "close",
                detail: "Pi RPC session was closed.",
              }),
            ),
          ),
          Effect.andThen(Queue.shutdown(rawEvents)),
        );
      }),
    );

    yield* Effect.addFinalizer(() => close);

    // Keep the stdout fibre reachable through the runtime scope. The binding
    // is intentionally retained to make the ownership explicit.
    void outputFiber;

    return {
      start,
      getState,
      getSessionStats,
      getTurnAnchor,
      fork,
      getAvailableModels,
      setModel,
      getAvailableThinkingLevels,
      setThinkingLevel,
      getCommands,
      prompt,
      abort,
      respondToExtensionUI,
      events: Stream.fromQueue(rawEvents),
      close,
    } satisfies PiSessionRuntimeShape;
  });
