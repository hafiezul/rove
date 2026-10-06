import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment } from "@rove-code/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as LinuxDesktop from "./LinuxDesktop.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProcessIdentity = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      pid: Schema.Int,
      start: Schema.String,
      boot: Schema.String,
      namespace: Schema.String,
    }),
  ),
);
const output = (stdout = "", code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const withRuntime = <A, E>(
  body: (harness: {
    runtime: LinuxDesktop.Runtime;
    executable: string;
    runs: Array<ReadonlyArray<string>>;
    containers: Map<
      string,
      { Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean } }
    >;
    launch: (transport: LinuxDesktop.Transport) => Effect.Effect<string>;
    setRootless: (enabled: boolean) => void;
    setImage: (enabled: boolean) => void;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "rove-desktop-test-" });
    const executable = `${directory}/cua-driver`;
    yield* fs.writeFileString(executable, "fake executable");
    const runs: Array<ReadonlyArray<string>> = [];
    const containers = new Map<
      string,
      { Id: string; Config: { Labels: Record<string, string> }; State: { Running: boolean } }
    >();
    let rootless = true;
    let image = true;
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ args }) =>
        Effect.sync(() => {
          runs.push(args);
          expect(args[0]).toBe("--remote=false");
          switch (args[1]) {
            case "info":
              return output(encodeJson({ host: { security: { rootless } } }));
            case "ps":
              return output("[]");
            case "image":
              return output("", image ? 0 : 1);
            case "build":
              image = true;
              return output();
            case "inspect": {
              const record = containers.get(args[2] ?? "");
              return record ? output(encodeJson([record])) : output("", 1, "no such container");
            }
            case "rm":
              containers.delete(args[3] ?? "");
              return output();
            default:
              throw new Error(`Unexpected command ${args.join(" ")}`);
          }
        }),
    });
    const runtime = yield* LinuxDesktop.make().pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    const launch = (transport: LinuxDesktop.Transport) =>
      Effect.sync(() => {
        expect(transport.command).toBe("podman");
        const args = transport.args;
        if (args[1] === "exec") return args[3] ?? "";
        expect(args[1]).toBe("run");
        const name = args[args.indexOf("--name") + 1] ?? "";
        const labels: Record<string, string> = {};
        args.forEach((arg, index) => {
          if (arg !== "--label") return;
          const label = args[index + 1] ?? "";
          const split = label.indexOf("=");
          labels[label.slice(0, split)] = label.slice(split + 1);
        });
        containers.set(name, { Id: name, Config: { Labels: labels }, State: { Running: true } });
        return name;
      });
    return yield* body({
      runtime,
      executable,
      runs,
      containers,
      launch,
      setRootless: (enabled) => {
        rootless = enabled;
      },
      setImage: (enabled) => {
        image = enabled;
      },
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcessEnvironment, {}),
  );

it.effect("requires rootless local Podman and a prepared image without host fallback", () =>
  withRuntime(({ runtime, executable, setRootless, setImage }) =>
    Effect.gen(function* () {
      setRootless(false);
      expect((yield* runtime.check(executable)).kind).toBe("unavailable");
      setRootless(true);
      setImage(false);
      expect(yield* runtime.check(executable)).toEqual({ kind: "missing" });
      const refused = yield* runtime
        .connect("thread:a", executable, () => Effect.die("must not launch"))
        .pipe(Effect.flip);
      expect(refused.detail).toContain("not prepared");
      yield* runtime.install(executable);
      expect(yield* runtime.check(executable)).toEqual({ kind: "ready" });
    }),
  ),
);

it.effect(
  "keeps thread desktops across transport retirement and releases slots only explicitly",
  () =>
    withRuntime(({ runtime, executable, launch, containers }) =>
      Effect.gen(function* () {
        const first = yield* runtime.connect("thread:0", executable, launch);
        expect(yield* runtime.connect("thread:0", executable, launch)).toBe(first);
        for (let index = 1; index < LinuxDesktop.CAPACITY; index++)
          yield* runtime.connect(`thread:${index}`, executable, launch);
        expect(runtime.count()).toBe(4);
        const refused = yield* runtime.connect("thread:5", executable, launch).pipe(Effect.flip);
        expect(refused.detail).toContain("slots are occupied");
        expect(containers.size).toBe(4);
        yield* runtime.close("thread:0");
        yield* runtime.close("thread:0");
        expect(runtime.count()).toBe(3);
        const fresh = yield* runtime.connect("thread:0", executable, launch);
        expect(fresh).not.toBe(first);
        yield* runtime.release;
        yield* runtime.release;
        expect(containers.size).toBe(0);
        expect(runtime.count()).toBe(0);
      }),
    ),
);

it.effect("cleans partial creation but refuses to delete a desktop with different ownership", () =>
  withRuntime(({ runtime, executable, launch, containers }) =>
    Effect.gen(function* () {
      yield* runtime
        .connect("thread:a", executable, (transport) =>
          launch(transport).pipe(Effect.andThen(Effect.fail("failed handshake"))),
        )
        .pipe(Effect.flip);
      expect(containers.size).toBe(0);
      expect(runtime.count()).toBe(0);
      const name = yield* runtime.connect("thread:a", executable, launch);
      const record = containers.get(name);
      expect(record).toBeDefined();
      if (!record) return;
      record.Config.Labels["io.rove.cua.owner"] = "another-server";
      expect((yield* runtime.close("thread:a").pipe(Effect.flip)).detail).toContain("ownership");
      expect(containers.size).toBe(1);
      expect(
        (yield* runtime.connect("thread:a", executable, launch).pipe(Effect.flip)).detail,
      ).toContain("ownership");
    }),
  ),
);

it.effect("reconciles dead boot owners but preserves live servers and unknown ownership", () =>
  withRuntime(({ runtime, executable, launch, containers, runs }) =>
    Effect.gen(function* () {
      const live = yield* runtime.connect("thread:a", executable, launch);
      const record = containers.get(live);
      if (!record) return;
      const deadLabels = {
        ...record.Config.Labels,
        "io.rove.cua.server": encodeJson({
          pid: 1,
          start: "1",
          boot: "previous-boot",
          namespace: "old",
        }),
      };
      containers.set("dead", {
        Id: "dead",
        Config: { Labels: deadLabels },
        State: { Running: true },
      });
      containers.set("unknown", {
        Id: "unknown",
        Config: { Labels: { "io.rove.cua.server": "not json" } },
        State: { Running: true },
      });
      const identity = decodeProcessIdentity(record.Config.Labels["io.rove.cua.server"]);
      for (const [id, override] of [
        ["reused-pid", { start: "0" }],
        ["missing-pid", { pid: 2147483647 }],
        ["foreign-namespace", { namespace: "not-visible", start: "0" }],
      ] as const) {
        containers.set(id, {
          Id: id,
          Config: {
            Labels: {
              ...record.Config.Labels,
              "io.rove.cua.server": encodeJson({ ...identity, ...override }),
            },
          },
          State: { Running: true },
        });
      }
      const runner = ProcessRunner.ProcessRunner.of({
        run: ({ args }) =>
          Effect.sync(() => {
            runs.push(args);
            if (args[1] === "info")
              return output(encodeJson({ host: { security: { rootless: true } } }));
            if (args[1] === "ps")
              return output(
                encodeJson(
                  [...containers.values()].map((entry) => ({
                    Id: entry.Id,
                    Labels: entry.Config.Labels,
                  })),
                ),
              );
            if (args[1] === "inspect") return output(encodeJson([containers.get(args[2] ?? "")]));
            if (args[1] === "rm") {
              containers.delete(args[3] ?? "");
              return output();
            }
            if (args[1] === "image") return output();
            throw new Error("unexpected recovery command");
          }),
      });
      const restarted = yield* LinuxDesktop.make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
      );
      yield* restarted.preflight;
      yield* restarted.preflight;
      expect(containers.has("dead")).toBe(false);
      expect(containers.has(live)).toBe(true);
      expect(containers.has("unknown")).toBe(true);
      expect(containers.has("reused-pid")).toBe(false);
      expect(containers.has("missing-pid")).toBe(false);
      expect(containers.has("foreign-namespace")).toBe(true);
      expect(runs.filter((args) => args[1] === "rm" && args[3] === "dead")).toHaveLength(1);
    }),
  ),
);
