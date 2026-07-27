import { PiSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

const PiTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const modelSelection = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "vibeproxy/claude-sonnet-5",
};

/**
 * Fake `pi` binary. Records each invocation's argv and stdin into the run
 * directory so tests can assert the launch profile, and replies with the
 * outputs listed in `T3_FAKE_PI_OUTPUTS` (one per attempt, `\x1e`-separated)
 * so the retry path can return something different from the first attempt.
 */
function makeFakePiBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const piPath = path.join(binDir, "pi");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      piPath,
      [
        "#!/bin/sh",
        'run_dir="$T3_FAKE_PI_RUN_DIR"',
        'attempt="$(cat "$run_dir/attempts" 2>/dev/null || printf 0)"',
        "attempt=$((attempt + 1))",
        'printf "%s" "$attempt" > "$run_dir/attempts"',
        'printf "%s" "$*" > "$run_dir/args.$attempt"',
        'cat > "$run_dir/stdin.$attempt"',
        'printf "%s" "$PI_CODING_AGENT_DIR" > "$run_dir/config_dir.$attempt"',
        // Pi always writes warnings to stderr; stdout must stay clean.
        'printf "%s\\n" "Warning: No models match pattern" >&2',
        'if [ -n "$T3_FAKE_PI_EXIT_CODE" ] && [ "$T3_FAKE_PI_EXIT_CODE" != "0" ]; then',
        '  printf "%s\\n" "$T3_FAKE_PI_STDERR" >&2',
        '  exit "$T3_FAKE_PI_EXIT_CODE"',
        "fi",
        'printf "%s" "$T3_FAKE_PI_OUTPUTS" | awk -v n="$attempt" \'',
        '  BEGIN { RS = "\\036"; }',
        '  NR == n { printf "%s", $0; found = 1 }',
        '  END { if (!found) printf "%s", last }',
        "  { last = $0 }",
        "'",
        "",
      ].join("\n"),
    );
    yield* fs.chmod(piPath, 0o755);
    return binDir;
  });
}

interface FakePiRun {
  readonly attempts: number;
  readonly argsFor: (attempt: number) => string;
  readonly stdinFor: (attempt: number) => string;
  readonly configDirFor: (attempt: number) => string;
}

function withFakePi<A, E, R>(
  input: {
    /** One entry per attempt. The last entry repeats for further attempts. */
    readonly outputs: ReadonlyArray<string>;
    readonly exitCode?: number;
    readonly stderr?: string;
    readonly piConfig?: Partial<PiSettings>;
  },
  effectFn: (
    textGeneration: TextGeneration.TextGeneration["Service"],
    run: () => Effect.Effect<FakePiRun>,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-pi-text-" });
    const binDir = yield* makeFakePiBinary(tempDir);
    const runDir = path.join(tempDir, "run");
    yield* fs.makeDirectory(runDir, { recursive: true });

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      T3_FAKE_PI_RUN_DIR: runDir,
      T3_FAKE_PI_OUTPUTS: input.outputs.join("\u001e"),
      ...(input.exitCode === undefined ? {} : { T3_FAKE_PI_EXIT_CODE: String(input.exitCode) }),
      ...(input.stderr === undefined ? {} : { T3_FAKE_PI_STDERR: input.stderr }),
    };

    const readRun = () =>
      Effect.gen(function* () {
        const readOr = (name: string) =>
          fs.readFileString(path.join(runDir, name)).pipe(Effect.orElseSucceed(() => ""));
        const attemptsRaw = yield* readOr("attempts");
        const attempts = attemptsRaw ? Number(attemptsRaw) : 0;
        const args: Array<string> = [];
        const stdins: Array<string> = [];
        const configDirs: Array<string> = [];
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          args.push(yield* readOr(`args.${String(attempt)}`));
          stdins.push(yield* readOr(`stdin.${String(attempt)}`));
          configDirs.push(yield* readOr(`config_dir.${String(attempt)}`));
        }
        return {
          attempts,
          argsFor: (attempt: number) => args[attempt - 1] ?? "",
          stdinFor: (attempt: number) => stdins[attempt - 1] ?? "",
          configDirFor: (attempt: number) => configDirs[attempt - 1] ?? "",
        } satisfies FakePiRun;
      });

    const config = decodePiSettings(input.piConfig ?? {});
    const textGeneration = yield* makePiTextGeneration(config, environment);
    return yield* effectFn(textGeneration, readRun);
  }).pipe(Effect.scoped);
}

it.layer(PiTextGenerationTestLayer)("PiTextGeneration", (it) => {
  it.effect("recovers the commit message from Pi's prose-wrapped, fenced JSON", () =>
    withFakePi(
      {
        outputs: [
          [
            "I need to see the actual diff to write an accurate commit message.",
            "",
            "```json",
            '{"subject": "Add README with project overview", "body": "- Add title"}',
            "```",
          ].join("\n"),
        ],
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "main",
            stagedSummary: "A README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection,
          });

          expect(generated.subject).toBe("Add README with project overview");
          expect(generated.body).toBe("- Add title");
        }),
    ),
  );

  it.effect("runs Pi isolated from tools, resources, and project trust", () =>
    withFakePi({ outputs: [`{"title": "Fix reconnect handling"}`] }, (textGeneration, run) =>
      Effect.gen(function* () {
        yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Investigate reconnect failures after restarting the session.",
          modelSelection,
        });

        const { argsFor, stdinFor } = yield* run();
        const args = argsFor(1);
        for (const flag of [
          "-p",
          "--no-session",
          "--no-approve",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-prompt-templates",
          "--thinking off",
          "--provider vibeproxy",
          "--model claude-sonnet-5",
        ]) {
          expect(args).toContain(flag);
        }
        expect(stdinFor(1)).toContain("You write concise thread titles for coding conversations.");
      }),
    ),
  );

  it.effect("ignores launch arguments and trusted extensions for text generation", () =>
    withFakePi(
      {
        outputs: [`{"title": "Use isolated run"}`],
        piConfig: {
          launchArgs: "--verbose --approve",
          trustedExtensions: ["/tmp/guard.ts"],
        },
      },
      (textGeneration, run) =>
        Effect.gen(function* () {
          yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection,
          });

          const args = (yield* run()).argsFor(1);
          expect(args).not.toContain("--verbose");
          expect(args).not.toContain("--extension");
          expect(args).not.toContain("/tmp/guard.ts");
          // `--no-approve` must survive; only the bare `--approve` is dropped.
          expect(args).not.toMatch(/(?:^|\s)--approve(?:\s|$)/);
        }),
    ),
  );

  it.effect("passes the configured Pi config directory as PI_CODING_AGENT_DIR", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const configDirectory = path.join(process.cwd(), ".pi-work-test");
      return yield* withFakePi(
        { outputs: [`{"title": "Use Pi config dir"}`], piConfig: { configDirectory } },
        (textGeneration, run) =>
          Effect.gen(function* () {
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread.",
              modelSelection,
            });

            expect((yield* run()).configDirFor(1)).toBe(configDirectory);
          }),
      );
    }),
  );

  it.effect("retries once when Pi returns no usable JSON object", () =>
    withFakePi(
      {
        outputs: [
          "I need to see the actual diff before I can answer that.",
          `{"branch": "add-readme"}`,
        ],
      },
      (textGeneration, run) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Add a README.",
            modelSelection,
          });

          expect(generated.branch).toBe("add-readme");
          const { attempts, stdinFor } = yield* run();
          expect(attempts).toBe(2);
          expect(stdinFor(2)).toContain("Your previous reply was not valid JSON");
        }),
    ),
  );

  it.effect("fails when Pi never returns a usable JSON object", () =>
    withFakePi({ outputs: ["Still no JSON here."] }, (textGeneration, run) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection,
          }),
        );

        expect(error.operation).toBe("generateThreadTitle");
        expect((yield* run()).attempts).toBe(2);
      }),
    ),
  );

  it.effect("surfaces a failing Pi process without retrying", () =>
    withFakePi(
      { outputs: [""], exitCode: 1, stderr: "401 Proxy error: not authenticated." },
      (textGeneration, run) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Name this thread.",
              modelSelection,
            }),
          );

          expect(error.detail).toContain("401 Proxy error: not authenticated.");
          expect((yield* run()).attempts).toBe(1);
        }),
    ),
  );

  it.effect("rejects a model selection that is not a Pi provider/model slug", () =>
    withFakePi({ outputs: [`{"title": "unused"}`] }, (textGeneration, run) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "bare-model-id" },
          }),
        );

        expect(error.detail).toContain("bare-model-id");
        expect((yield* run()).attempts).toBe(0);
      }),
    ),
  );
});
