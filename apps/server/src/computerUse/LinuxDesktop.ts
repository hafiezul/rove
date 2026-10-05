import * as NodeCrypto from "node:crypto";

import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { DESKTOP_FILES } from "./LinuxDesktopImage.ts";

export const CAPACITY = 4;
const OWNER_LABEL = "io.rove.cua.owner";
const SERVER_LABEL = "io.rove.cua.server";
const Identity = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  start: Schema.String.check(Schema.isPattern(/^\d+$/)),
  boot: Schema.String,
  namespace: Schema.String,
});
const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(Identity));
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Identity));
const decodeStart = Schema.decodeUnknownEffect(Identity.fields.start);
const Containers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Labels: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);
const decodeContainers = Schema.decodeUnknownEffect(Containers);
const RootlessInfo = Schema.fromJsonString(
  Schema.Struct({ host: Schema.Struct({ security: Schema.Struct({ rootless: Schema.Boolean }) }) }),
);
const Inspection = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
      State: Schema.Struct({ Running: Schema.Boolean }),
    }),
  ),
);
const decodeInfo = Schema.decodeUnknownEffect(RootlessInfo);
const decodeInspection = Schema.decodeUnknownEffect(Inspection);

export class LinuxDesktopError extends Schema.TaggedError<LinuxDesktopError>()(
  "LinuxDesktopError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type Readiness =
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ready" };

export interface Transport {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface Runtime {
  readonly preflight: Effect.Effect<void, LinuxDesktopError>;
  readonly check: (executable: string) => Effect.Effect<Readiness>;
  readonly install: (executable: string) => Effect.Effect<void, LinuxDesktopError>;
  readonly connect: <A, E, R>(
    key: string,
    executable: string,
    use: (transport: Transport) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LinuxDesktopError, R>;
  readonly close: (key: string) => Effect.Effect<void, LinuxDesktopError>;
  readonly release: Effect.Effect<void, LinuxDesktopError>;
  readonly count: () => number;
}

const isLinuxDesktopError = Schema.is(LinuxDesktopError);
const error = (detail: string) => new LinuxDesktopError({ detail });

/** The caller serializes connection creation and disposal; a desktop outlives its MCP workers. */
export const make = Effect.fn("LinuxDesktop.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const owner = NodeCrypto.randomUUID();
  const desktops = new Map<string, string>();
  const references = new Map<string, { stamp: string; image: string }>();
  const run = (args: ReadonlyArray<string>, timeout: Duration.Input = "30 seconds") =>
    runner
      .run({
        command: "podman",
        args: ["--remote=false", ...args],
        env: environment,
        timeout,
      })
      .pipe(Effect.mapError((cause) => error(cause.message)));

  const processStart = Effect.fn("LinuxDesktop.processStart")(function* (pid: number) {
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
    return yield* decodeStart(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]).pipe(
      Effect.mapError(() => error("Cannot read the Rove process identity.")),
    );
  });
  const identity = yield* Effect.cached(
    Effect.gen(function* () {
      return {
        pid: process.pid,
        start: yield* processStart(process.pid),
        boot: (yield* fs.readFileString("/proc/sys/kernel/random/boot_id")).trim(),
        namespace: yield* fs.readLink("/proc/self/ns/pid"),
      };
    }).pipe(Effect.mapError((cause) => error(cause.message))),
  );
  let reconciled = false;
  const reconcile = Effect.gen(function* () {
    if (reconciled) return;
    const current = yield* identity;
    const output = yield* run([
      "ps",
      "--all",
      "--filter",
      `label=${SERVER_LABEL}`,
      "--format",
      "json",
    ]);
    if (output.code !== 0)
      return yield* error("Cannot enumerate private desktops for crash recovery.");
    const containers = yield* decodeContainers(output.stdout).pipe(
      Effect.mapError(() => error("Podman returned unreadable desktop records.")),
    );
    for (const container of containers) {
      const serverLabel = container.Labels[SERVER_LABEL];
      const previous = decodeIdentity(serverLabel);
      if (Option.isNone(previous) || !container.Labels[OWNER_LABEL]) continue;
      const prior = previous.value;
      let dead = prior.boot !== current.boot;
      if (!dead && prior.namespace === current.namespace) {
        const start = yield* processStart(prior.pid).pipe(Effect.result);
        dead =
          start._tag === "Success"
            ? start.success !== prior.start
            : start.failure._tag === "PlatformError" && start.failure.reason._tag === "NotFound";
      }
      if (!dead) continue;
      const inspected = yield* run(["inspect", container.Id]);
      if (inspected.code !== 0) continue;
      const [record] = yield* decodeInspection(inspected.stdout).pipe(
        Effect.mapError(() => error("Cannot verify orphan desktop ownership.")),
      );
      if (
        !record ||
        record.Id !== container.Id ||
        record.Config.Labels[SERVER_LABEL] !== serverLabel ||
        record.Config.Labels[OWNER_LABEL] !== container.Labels[OWNER_LABEL]
      )
        continue;
      const removed = yield* run(["rm", "--force", record.Id]);
      if (removed.code !== 0) return yield* error("Cannot remove a dead server's private desktop.");
    }
    reconciled = true;
  });

  const requireRootless = Effect.gen(function* () {
    const output = yield* run(["info", "--format", "json"]);
    if (output.code !== 0)
      return yield* error(
        "Rootless Podman is unavailable. Install podman and uidmap, then run podman info as the user running Rove.",
      );
    const info = yield* decodeInfo(output.stdout).pipe(
      Effect.mapError(() => error("Podman returned unreadable runtime information.")),
    );
    if (!info.host.security.rootless)
      return yield* error(
        "Linux computer use requires rootless Podman. Run Rove as an unprivileged user.",
      );
    yield* reconcile;
  }).pipe(
    Effect.mapError((cause) =>
      error(`Linux headless desktop needs rootless Podman. ${cause.detail}`),
    ),
  );

  const reference = Effect.fn("LinuxDesktop.reference")(
    function* (executable: string) {
      const resolved = yield* fs.realPath(executable);
      const stat = yield* fs.stat(resolved);
      const stamp = `${stat.size}:${Option.getOrUndefined(stat.mtime)?.getTime()}`;
      const cached = references.get(resolved);
      if (cached?.stamp === stamp) return cached.image;
      const binary = yield* fs.readFile(resolved);
      const hash = NodeCrypto.createHash("sha256")
        .update(binary)
        .update(Object.values(DESKTOP_FILES).join("\n"))
        .digest("hex");
      const image = `localhost/rove-cua-desktop:${hash.slice(0, 24)}`;
      references.set(resolved, { stamp, image });
      return image;
    },
    Effect.mapError((cause) =>
      error(`Cannot read Cua Driver for the desktop image: ${cause.message}`),
    ),
  );

  const check = Effect.fn("LinuxDesktop.check")(function* (
    executable: string,
  ): Effect.fn.Return<Readiness> {
    const ready = yield* requireRootless.pipe(Effect.result);
    if (ready._tag === "Failure") return { kind: "unavailable", detail: ready.failure.detail };
    const image = yield* reference(executable).pipe(Effect.result);
    if (image._tag === "Failure") return { kind: "unavailable", detail: image.failure.detail };
    const exists = yield* run(["image", "exists", image.success]).pipe(Effect.result);
    if (exists._tag === "Failure") return { kind: "unavailable", detail: exists.failure.detail };
    if (exists.success.code === 0) return { kind: "ready" };
    if (exists.success.code === 1) return { kind: "missing" };
    return {
      kind: "unavailable",
      detail: `Cannot check the desktop image. ${exists.success.stderr.slice(-1000)}`,
    };
  });

  const install = Effect.fn("LinuxDesktop.install")(
    function* (executable: string) {
      yield* requireRootless;
      const image = yield* reference(executable);
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rove-cua-image-" });
      for (const [name, content] of Object.entries(DESKTOP_FILES)) {
        yield* fs.writeFileString(path.join(directory, name), content);
      }
      yield* fs.copyFile(executable, path.join(directory, "cua-driver"));
      const output = yield* run(
        [
          "build",
          "--memory=512m",
          "--tag",
          image,
          "--file",
          path.join(directory, "Containerfile"),
          directory,
        ],
        "10 minutes",
      );
      if (output.code !== 0)
        return yield* error(`Desktop image build failed: ${output.stderr.slice(-2000)}`);
    },
    Effect.scoped,
    Effect.mapError((cause) => (isLinuxDesktopError(cause) ? cause : error(cause.message))),
  );

  const remove = Effect.fn("LinuxDesktop.remove")(function* (name: string) {
    const output = yield* run(["inspect", name]);
    if (output.code !== 0) {
      if (/no such (container|object)/i.test(output.stderr)) return;
      return yield* error(`Cannot inspect owned desktop: ${output.stderr.slice(-1000)}`);
    }
    const [inspection] = yield* decodeInspection(output.stdout).pipe(
      Effect.mapError(() => error("Podman returned unreadable desktop ownership.")),
    );
    if (!inspection || inspection.Config.Labels[OWNER_LABEL] !== owner)
      return yield* error(
        "Desktop ownership does not match this Rove server. Nothing was removed.",
      );
    const removed = yield* run(["rm", "--force", inspection.Id]);
    if (removed.code !== 0)
      return yield* error(`Cannot remove owned desktop: ${removed.stderr.slice(-1000)}`);
  });

  const close = Effect.fn("LinuxDesktop.close")(function* (key: string) {
    const name = desktops.get(key);
    if (!name) return;
    yield* remove(name);
    desktops.delete(key);
  });

  const connect = <A, E, R>(
    key: string,
    executable: string,
    use: (transport: Transport) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const readiness = yield* check(executable);
      if (readiness.kind === "unavailable") return yield* error(readiness.detail);
      if (readiness.kind === "missing")
        return yield* error(
          "The Linux desktop image is not prepared. Select Install in Settings → Integrations → Computer use.",
        );
      const existing = desktops.get(key);
      if (existing) {
        const output = yield* run(["inspect", existing]);
        if (output.code !== 0)
          return yield* error(
            "The private desktop is no longer available. Use close_desktop to clear this thread's slot before retrying.",
          );
        const [inspection] = yield* decodeInspection(output.stdout).pipe(
          Effect.mapError(() => error("Podman returned unreadable desktop ownership.")),
        );
        if (
          !inspection ||
          inspection.Config.Labels[OWNER_LABEL] !== owner ||
          !inspection.State.Running
        )
          return yield* error(
            "The private desktop is not running with this server's ownership. No input was sent.",
          );
        return yield* use({
          command: "podman",
          args: ["--remote=false", "exec", "--interactive", existing, "/usr/local/bin/mcp.sh"],
        });
      }
      if (
        key !== "control" &&
        [...desktops.keys()].filter((entry) => entry !== "control").length >= CAPACITY
      ) {
        return yield* error(
          `All ${CAPACITY} private desktop slots are occupied. Use close_desktop in a finished thread to discard its temporary apps and files.`,
        );
      }
      const name = `rove-cua-${NodeCrypto.randomUUID()}`;
      const image = yield* reference(executable);
      const server = yield* identity;
      desktops.set(key, name);
      const result = yield* use({
        command: "podman",
        args: [
          "--remote=false",
          "run",
          "--interactive",
          "--sig-proxy=false",
          "--name",
          name,
          "--label",
          `${OWNER_LABEL}=${owner}`,
          "--label",
          `${SERVER_LABEL}=${encodeIdentity(server)}`,
          "--network=none",
          "--env-host=false",
          "--http-proxy=false",
          "--ipc=private",
          "--pid=private",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--read-only",
          "--pids-limit=128",
          "--memory=512m",
          "--cpus=1",
          "--tmpfs",
          "/tmp:rw,size=128m,mode=1777",
          image,
        ],
      }).pipe(
        Effect.onError(() =>
          close(key).pipe(Effect.catch((cause) => Effect.logWarning(cause.detail))),
        ),
      );
      return result;
    });

  const release = Effect.gen(function* () {
    const failures: Array<string> = [];
    for (const key of desktops.keys()) {
      yield* close(key).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            failures.push(cause.detail);
          }),
        ),
      );
    }
    if (failures.length > 0) return yield* error(failures.join("\n"));
  });
  return {
    preflight: requireRootless,
    check,
    install,
    connect,
    close,
    release,
    count: () => [...desktops.keys()].filter((key) => key !== "control").length,
  } satisfies Runtime;
});
