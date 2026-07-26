import { describe, expect, it } from "@effect/vitest";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ProcessRunner } from "../../processRunner.ts";
import { checkPiProviderStatus } from "./PiProvider.ts";

const settings = (overrides: Partial<PiSettings> = {}): PiSettings => ({
  enabled: true,
  binaryPath: "pi",
  configDirectory: "",
  launchArgs: "",
  trustedExtensions: [],
  ...overrides,
});

const withProcessResult = (result: ReturnType<ProcessRunner["Service"]["run"]>) =>
  checkPiProviderStatus(settings(), process.env).pipe(
    Effect.provideService(ProcessRunner, ProcessRunner.of({ run: () => result })),
  );

describe("checkPiProviderStatus", () => {
  it.effect("reports a usable supported Pi binary", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "pi 0.82.0\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("ready");
          expect(snapshot.version).toBe("0.82.0");
          expect(snapshot.showRuntimeModeSelector).toBe(false);
          expect(snapshot.toolAccessDescription).toContain("Pi manages enabled tool access");
        }),
      ),
    ),
  );

  it.effect("discovers Pi provider/model groups and their valid thinking levels", () =>
    checkPiProviderStatus(settings(), process.env, () =>
      Effect.succeed({
        models: [
          {
            model: {
              provider: "custom-gateway",
              id: "team/coder",
              name: "Team Coder",
            },
            thinkingLevels: ["off", "high", "max"],
            currentThinkingLevel: "high",
          },
        ],
        skills: [],
        extensionCommands: [],
      }),
    ).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({
          run: () =>
            Effect.succeed({
              stdout: "pi 0.82.0\\n",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.models).toEqual([
            expect.objectContaining({
              slug: "custom-gateway/team%2Fcoder",
              name: "Team Coder",
              subProvider: "custom-gateway",
            }),
          ]);
          expect(snapshot.models[0]?.capabilities?.optionDescriptors).toEqual([
            expect.objectContaining({
              id: "reasoningEffort",
              currentValue: "high",
              options: [
                { id: "off", label: "Off" },
                { id: "high", label: "High", isDefault: true },
                { id: "max", label: "Max" },
              ],
            }),
          ]);
        }),
      ),
    ),
  );

  it.effect("populates the snapshot skills from the catalog probe", () =>
    checkPiProviderStatus(settings(), process.env, () =>
      Effect.succeed({
        models: [],
        skills: [
          {
            name: "code-review",
            description: "Review the changes since a fixed point.",
            scope: "user",
            path: "/Users/example/.agents/skills/code-review/SKILL.md",
          },
          { name: "bare", path: "/x/bare/SKILL.md" },
        ],
        extensionCommands: [],
      }),
    ).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({
          run: () =>
            Effect.succeed({
              stdout: "pi 0.82.0\n",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.skills).toEqual([
            {
              name: "code-review",
              description: "Review the changes since a fixed point.",
              scope: "user",
              path: "/Users/example/.agents/skills/code-review/SKILL.md",
              enabled: true,
            },
            { name: "bare", path: "/x/bare/SKILL.md", enabled: true },
          ]);
        }),
      ),
    ),
  );

  it.effect(
    "populates snapshot slash commands from trusted extension commands, deduped by name",
    () =>
      checkPiProviderStatus(settings(), process.env, () =>
        Effect.succeed({
          models: [],
          skills: [],
          extensionCommands: [
            {
              name: "fast",
              description: "Toggle fast mode: /fast on|off|status",
              path: "/Users/example/pi-extensions/pi-fast-mode.ts",
            },
            { name: "llama", path: "<inline:llama.cpp>" },
            { name: "fast", description: "duplicate registration", path: "/other/fast.ts" },
          ],
        }),
      ).pipe(
        Effect.provideService(
          ProcessRunner,
          ProcessRunner.of({
            run: () =>
              Effect.succeed({
                stdout: "pi 0.82.0\n",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          }),
        ),
        Effect.tap((snapshot) =>
          Effect.sync(() => {
            expect(snapshot.slashCommands).toEqual([
              { name: "fast", description: "Toggle fast mode: /fast on|off|status" },
              { name: "llama" },
            ]);
          }),
        ),
      ),
  );

  it.effect("passes the selected Pi config directory to the status probe", () => {
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    return checkPiProviderStatus(settings({ configDirectory: "/Users/example/.pi-work" }), {
      EXAMPLE: "value",
    }).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({
          run: (input) => {
            receivedEnvironment = input.env;
            return Effect.succeed({
              stdout: "pi 0.82.0\n",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            });
          },
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(receivedEnvironment).toMatchObject({
            EXAMPLE: "value",
            PI_CODING_AGENT_DIR: "/Users/example/.pi-work",
          });
        }),
      ),
    );
  });

  it.effect("passes the trusted extension selection to the catalog probe", () =>
    checkPiProviderStatus(
      settings({ trustedExtensions: ["/tmp/t3-pi-extension.ts"] }),
      process.env,
      (input) =>
        Effect.sync(() => {
          expect(input.trustedExtensions).toEqual(["/tmp/t3-pi-extension.ts"]);
          return { models: [], skills: [], extensionCommands: [] };
        }),
    ).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({
          run: () =>
            Effect.succeed({
              stdout: "pi 0.82.0\n",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("ready");
        }),
      ),
    ),
  );

  it.effect("rejects protected launch arguments before probing Pi", () =>
    checkPiProviderStatus(settings({ launchArgs: "--mode json" }), process.env).pipe(
      Effect.provideService(
        ProcessRunner,
        ProcessRunner.of({ run: () => Effect.die("must not run") }),
      ),
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("managed by T3 Code");
        }),
      ),
    ),
  );

  it.effect("reports an upgrade requirement for an old Pi binary", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "pi 0.81.0\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("Upgrade to v0.82.0");
        }),
      ),
    ),
  );

  it.effect("reports a missing or invalid Pi binary", () =>
    withProcessResult(Effect.fail({ _tag: "ProcessSpawnError" } as never)).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(false);
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("could not be started");
        }),
      ),
    ),
  );

  it.effect("reports output from a non-Pi executable as invalid", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "not a Pi version\n",
        stderr: "",
        code: ChildProcessSpawner.ExitCode(0),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.installed).toBe(true);
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("Could not determine");
        }),
      ),
    ),
  );

  it.effect("does not treat a failed version command as usable", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "pi 0.82.0\n",
        stderr: "fatal error",
        code: ChildProcessSpawner.ExitCode(1),
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("version check failed");
        }),
      ),
    ),
  );

  it.effect("does not treat a timed-out version command as usable", () =>
    withProcessResult(
      Effect.succeed({
        stdout: "",
        stderr: "",
        code: null,
        timedOut: true,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    ).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("error");
          expect(snapshot.message).toContain("timed out");
        }),
      ),
    ),
  );
});
