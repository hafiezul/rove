// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessPlatform } from "@rove-code/shared/hostProcess";
import { it } from "@effect/vitest";
import { afterAll, describe, expect } from "vite-plus/test";
import {
  parseProcessBudgetMiB,
  parseProcessBudgetTimeout,
  prepareBudgetedProcess,
} from "./ProcessBudget.ts";

const hasUserSystemd =
  NodeChildProcess.spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" })
    .status === 0;
const decodePid = Schema.decodeUnknownSync(Schema.Int);

it("rejects malformed and impractical budgets before launching a workload", () => {
  for (const input of ["", "NaN", "Infinity", "-1", "127", "128.5", "999999999"]) {
    expect(() => parseProcessBudgetMiB(input)).toThrow();
  }
  expect(parseProcessBudgetMiB("2048")).toBe(2048);
});

it("rejects invalid command deadlines", () => {
  for (const input of ["", "NaN", "0", "-1", "1.5", "86401"]) {
    expect(() => parseProcessBudgetTimeout(input)).toThrow();
  }
  expect(parseProcessBudgetTimeout("120")).toBe(120);
});

it.effect("fails closed on unsupported hosts", () =>
  Effect.gen(function* () {
    const error = yield* prepareBudgetedProcess("unused", [], 128).pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.flip,
    );
    expect(error.message).toContain("Linux with a systemd user manager");
  }),
);

describe.skipIf(!hasUserSystemd)("Linux process budget integration", () => {
  const pool = `rove-budget-test-${NodeCrypto.randomUUID()}.slice`;
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile("systemctl", ["--user", "stop", pool], (error) =>
        error ? reject(error) : resolve(),
      );
    });
  });

  const launch = Effect.fnUntraced(function* (source: string, timeoutSeconds?: number) {
    const budget = yield* prepareBudgetedProcess(
      process.execPath,
      ["-e", source],
      128,
      pool,
      timeoutSeconds,
    );
    const child = NodeChildProcess.spawn(budget.command, budget.args, {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    return { budget, child, exit };
  });

  it.effect("preserves PID, bidirectional IPC, bigints and byte arrays", () =>
    Effect.gen(function* () {
      const { budget, child, exit } = yield* launch(`
      process.on('message', value => {
        process.send({pid:process.pid, value}, () => process.disconnect());
      });
    `);
      try {
        const message = new Promise<unknown>((resolve) => child.once("message", resolve));
        child.send({ count: 42n, bytes: Buffer.from([1, 2, 3]) });
        expect(yield* Effect.promise(() => message)).toEqual({
          pid: child.pid,
          value: { count: 42n, bytes: Buffer.from([1, 2, 3]) },
        });
        expect(yield* Effect.promise(() => exit)).toEqual({ code: 0, signal: null });
      } finally {
        yield* Effect.promise(() => budget.cleanup());
      }
    }),
  );

  it.effect("stops a live command at its scope deadline", () =>
    Effect.gen(function* () {
      const { budget, child, exit } = yield* launch(
        `
      process.send({ready:true});
      process.on('message', () => {});
    `,
        1,
      );
      try {
        const ready = yield* Effect.promise(
          () => new Promise<unknown>((resolve) => child.once("message", resolve)),
        );
        expect(ready).toEqual({ ready: true });
        expect(yield* Effect.promise(() => exit)).toEqual({ code: null, signal: "SIGTERM" });
      } finally {
        yield* Effect.promise(() => budget.cleanup());
      }
    }),
  );

  it.effect("contains a worker OOM and still permits the next worker to complete", () =>
    Effect.gen(function* () {
      const exhausted = yield* launch(`
      const chunks=[];
      for(let i=0;i<512;i++) chunks.push(Buffer.alloc(1024*1024, 1));
      process.send({unexpected:'allocation escaped budget'});
    `);
      try {
        expect(yield* Effect.promise(() => exhausted.exit)).toEqual({
          code: null,
          signal: "SIGKILL",
        });
      } finally {
        yield* Effect.promise(() => exhausted.budget.cleanup());
      }
      const recovered = yield* launch("process.send({alive:true}, () => process.disconnect());");
      try {
        const reply = new Promise<unknown>((resolve) => recovered.child.once("message", resolve));
        expect(yield* Effect.promise(() => reply)).toEqual({ alive: true });
        expect(yield* Effect.promise(() => recovered.exit)).toEqual({ code: 0, signal: null });
      } finally {
        yield* Effect.promise(() => recovered.budget.cleanup());
      }
    }),
  );

  it.effect("shares one aggregate budget across independently launched workers", () =>
    Effect.gen(function* () {
      const source = `
      const buffer=Buffer.alloc(64*1024*1024, 1);
      process.send({ready:buffer.length});
      process.on('message', () => process.exit(buffer[0] === 1 ? 0 : 2));
    `;
      const first = yield* launch(source);
      yield* Effect.promise(
        () => new Promise<unknown>((resolve) => first.child.once("message", resolve)),
      );
      const second = yield* launch(source);
      try {
        const exited = yield* Effect.promise(() => Promise.race([first.exit, second.exit]));
        expect(exited.signal).toBe("SIGKILL");
      } finally {
        yield* Effect.promise(() => first.budget.cleanup());
        yield* Effect.promise(() => second.budget.cleanup());
      }
    }),
  );

  it.effect("removes background descendants after their owning worker exits", () =>
    Effect.gen(function* () {
      const { budget, child, exit } = yield* launch(`
      const {spawn}=require('node:child_process');
      const orphan=spawn(process.execPath, ['-e', 'process.send(process.pid); setInterval(()=>{}, 60000)'], {stdio:['ignore','ignore','ignore','ipc']});
      orphan.on('message', pid => process.send(pid));
      process.on('message', () => process.exit(0));
    `);
      const descendant = decodePid(
        yield* Effect.promise(
          () => new Promise<unknown>((resolve) => child.once("message", resolve)),
        ),
      );
      child.send("exit");
      expect(yield* Effect.promise(() => exit)).toEqual({ code: 0, signal: null });
      yield* Effect.promise(() => Promise.all([budget.cleanup(), budget.cleanup()]));
      const status = yield* Effect.promise(() =>
        NodeFSP.readFile(`/proc/${descendant}/status`, "utf8").catch(() => ""),
      );
      // A reparented zombie may await PID 1, but cannot keep executing or allocating.
      expect(status === "" || /^State:\s+Z/m.test(status)).toBe(true);
    }),
  );

  it.effect("refuses to change a pool budget while other instances rely on it", () =>
    Effect.gen(function* () {
      const error = yield* prepareBudgetedProcess(
        process.execPath,
        ["-e", "process.exit(0)"],
        256,
        pool,
      ).pipe(Effect.flip);
      expect(error.message).toContain("different memory budget");
    }),
  );
});
