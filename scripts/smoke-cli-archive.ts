#!/usr/bin/env node
/**
 * Unpacks a CLI archive into a scratch directory and runs the executable the
 * way an installer would: no repo, no node_modules, no Node on PATH. Catches
 * the failures that only show inside the single-executable, such as an
 * external package reached through `import` or a native addon the hardened
 * runtime refuses to load.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { windowsSystemTar } from "./build-cli-archive.ts";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

const descriptorSchema = Schema.Struct({
  environmentId: Schema.String,
  serverVersion: Schema.String,
  capabilities: Schema.Struct({ serverSelfUpdate: Schema.optionalKey(Schema.String) }),
});
const credentialJson = Schema.fromJsonString(Schema.Struct({ credential: Schema.String }));
const decodeCredential = Schema.decodeUnknownEffect(credentialJson);
const accessTokenSchema = Schema.Struct({ access_token: Schema.String });
const sessionSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  sessionMethod: Schema.optionalKey(Schema.String),
});
const EXPECTED_LAUNCHER_PROTOCOL = 3;
const encodeServiceState = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      protocol: Schema.Literal(EXPECTED_LAUNCHER_PROTOCOL),
      activeVersion: Schema.String,
    }),
  ),
);
const encodeLaunchConfig = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      host: Schema.String,
      port: Schema.Int,
      tailscaleServeEnabled: Schema.Boolean,
      tailscaleServePort: Schema.Int,
    }),
  ),
);

export class CliArchiveSmokeError extends Schema.TaggedError<CliArchiveSmokeError>()(
  "CliArchiveSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `CLI archive smoke test failed while ${this.step}: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runExecutable = Effect.fn("runExecutable")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd,
      // Empty PATH: the archive must not reach a system node, and the
      // launcher context must not leak in from a developer shell.
      env: { PATH: "", HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, TEMP: cwd },
      extendEnv: false,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

const smokeCliArchive = Effect.fn("smokeCliArchive")(function* (input: {
  readonly archive: string;
  readonly expectVersion: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // On Windows the launcher's SIGTERM only terminates the launcher; the runtime
  // host exits moments later when its IPC channel closes, and keeps its
  // executable locked until then. Cleanup waits that out instead of failing.
  const scratch = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "t3-cli-smoke-" }),
    (directory) =>
      fs.remove(directory, { recursive: true }).pipe(
        Effect.retry({ schedule: Schedule.spaced(Duration.millis(500)), times: 20 }),
        Effect.catch((error) =>
          Effect.logWarning(`[cli-smoke] could not remove ${directory}: ${error.message}`),
        ),
      ),
  );

  // On Windows the archive is a zip and the Git Bash `tar` on PATH is GNU
  // tar; use the bsdtar Windows ships, which reads both formats.
  const tar = platform === "win32" ? windowsSystemTar() : "tar";
  const extract = yield* spawner
    .spawn(ChildProcess.make(tar, ["-xf", input.archive, "-C", scratch]))
    .pipe(Effect.flatMap((child) => child.exitCode));
  if (Number(extract) !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: `tar exited with ${String(extract)}`,
    });
  }
  const [root] = yield* fs.readDirectory(scratch);
  if (root === undefined) {
    return yield* new CliArchiveSmokeError({
      step: "extracting the archive",
      detail: "the archive was empty",
    });
  }
  const contentDir = path.join(scratch, root);
  const executable = path.join(contentDir, platform === "win32" ? "rove.exe" : "rove");
  for (const required of [executable, path.join(contentDir, "client/index.html")]) {
    if (!(yield* fs.exists(required))) {
      return yield* new CliArchiveSmokeError({
        step: "checking the archive layout",
        detail: `missing ${path.relative(contentDir, required)}`,
      });
    }
  }

  const version = yield* runExecutable(executable, ["--version"], contentDir);
  if (version.exitCode !== 0 || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: `exit ${String(version.exitCode)}\n${version.stdout}${version.stderr}`,
    });
  }

  yield* Effect.log(`[cli-smoke] ${root}: executable version matched.`);
  const net = yield* NetService.NetService;
  const port = yield* net.findAvailablePort(47700);
  const home = path.join(scratch, "home");
  yield* fs.makeDirectory(path.join(home, "runtime"), { recursive: true });
  yield* fs.writeFileString(
    path.join(home, "runtime", "service-config.json"),
    yield* encodeLaunchConfig({
      host: "127.0.0.1",
      port,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }),
  );
  const runtimeDir = path.join(home, "runtime", "versions", input.expectVersion);
  yield* fs.copy(contentDir, runtimeDir);
  yield* fs.writeFileString(path.join(runtimeDir, ".install-complete"), `${input.expectVersion}\n`);
  yield* fs.writeFileString(
    path.join(home, "runtime", "service-state.json"),
    yield* encodeServiceState({
      protocol: EXPECTED_LAUNCHER_PROTOCOL,
      activeVersion: input.expectVersion,
    }),
  );
  const startServer = spawner.spawn(
    ChildProcess.make(executable, ["__service-launcher"], {
      cwd: contentDir,
      env: {
        PATH: "",
        HOME: home,
        USERPROFILE: home,
        TMPDIR: scratch,
        TEMP: scratch,
        ROVE_HOME: home,
      },
      extendEnv: false,
    }),
  );
  const server = yield* startServer;
  const output = yield* Effect.forkScoped(
    Effect.all([collect(server.stdout), collect(server.stderr)]),
  );
  const httpClient = yield* HttpClient.HttpClient;
  // A request that connects while the server is still initializing can hang,
  // so each probe gets its own deadline, like the SSH readiness probe.
  const probe = httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`)).pipe(
    Effect.flatMap((response) => response.arrayBuffer.pipe(Effect.as(response.status === 200))),
    Effect.timeout(Duration.seconds(2)),
    Effect.orElseSucceed(() => false),
  );
  const pollUntilReady = Effect.gen(function* () {
    while (!(yield* probe)) {
      yield* Effect.sleep(Duration.millis(250));
    }
    return true;
  });
  const ready = yield* pollUntilReady.pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.orElseSucceed(() => false),
  );
  if (!ready) {
    yield* server.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
    yield* server.exitCode.pipe(Effect.timeout(Duration.seconds(30)));
    const [stdout, stderr] = yield* Fiber.join(output);
    return yield* new CliArchiveSmokeError({
      step: "starting the persistent host",
      detail: `the saved connection route did not become reachable\n${stdout}${stderr}`,
    });
  }
  const origin = `http://127.0.0.1:${port}`;
  const readDescriptor = httpClient
    .execute(HttpClientRequest.get(`${origin}/.well-known/t3/environment`))
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(descriptorSchema)),
      Effect.timeout(Duration.seconds(10)),
    );
  const before = yield* readDescriptor;
  yield* Effect.log(`[cli-smoke] ${root}: launcher-managed host answered on its saved port.`);
  const pairing = yield* runExecutable(
    executable,
    ["auth", "pairing", "create", "--base-dir", home, "--json"],
    contentDir,
  ).pipe(Effect.timeout(Duration.seconds(30)));
  if (pairing.exitCode !== 0) {
    return yield* new CliArchiveSmokeError({
      step: "pairing the host",
      detail: `CLI exited with ${pairing.exitCode}`,
    });
  }
  const credential = yield* decodeCredential(pairing.stdout);
  const tokenRequest = HttpClientRequest.post(`${origin}/oauth/token`).pipe(
    HttpClientRequest.bodyUrlParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential.credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  );
  const token = yield* httpClient
    .execute(tokenRequest)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(accessTokenSchema)),
      Effect.timeout(Duration.seconds(10)),
    );
  yield* Effect.log(`[cli-smoke] ${root}: paired-client authorization issued.`);
  yield* server.kill({ killSignal: "SIGTERM" });
  yield* server.exitCode.pipe(Effect.timeout(Duration.seconds(30)));
  yield* Fiber.join(output);
  yield* Effect.log(`[cli-smoke] ${root}: original host process stopped.`);
  const restarted = yield* startServer;
  yield* Effect.forkScoped(Effect.all([collect(restarted.stdout), collect(restarted.stderr)]));
  const resumed = yield* pollUntilReady.pipe(
    Effect.timeout(Duration.seconds(30)),
    Effect.orElseSucceed(() => false),
  );
  if (!resumed) {
    return yield* new CliArchiveSmokeError({
      step: "restarting the host",
      detail: "the saved route did not return",
    });
  }
  const after = yield* readDescriptor;
  const session = yield* httpClient
    .execute(
      HttpClientRequest.get(`${origin}/api/auth/session`).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${token.access_token}`),
      ),
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(sessionSchema)),
      Effect.timeout(Duration.seconds(10)),
    );
  if (
    before.environmentId !== after.environmentId ||
    after.capabilities.serverSelfUpdate !== "boot-service" ||
    after.serverVersion !== input.expectVersion ||
    !session.authenticated ||
    session.sessionMethod !== "bearer-access-token"
  ) {
    return yield* new CliArchiveSmokeError({
      step: "retaining the paired environment",
      detail: "identity, version, or authentication changed after restart",
    });
  }
  yield* restarted.kill({ killSignal: "SIGTERM" });
  yield* restarted.exitCode.pipe(Effect.timeout(Duration.seconds(30)));
  yield* Effect.log(
    `[cli-smoke] ${root}: saved route, identity, and client authorization survived restart.`,
  );
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive"),
    expectVersion: Flag.String("expect-version"),
  },
  (input) => smokeCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Extract a CLI archive and run its executable."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
