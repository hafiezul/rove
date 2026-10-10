// @effect-diagnostics nodeBuiltinImport:off
import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as Net from "node:net";
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { executeProcessControl, makeManagedProcess } from "../../diagnostics/ProcessBudget.ts";
import { resolvePiWorkloadMemory } from "../../diagnostics/PiWorkloadPolicy.ts";
import { PiWorkloads } from "./PiWorkloads.ts";

const supported =
  process.platform === "linux" &&
  ChildProcess.spawnSync("systemctl", ["--user", "show-environment"]).status === 0;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const node = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;

it("does not silently enable containment on unsupported or large hosts", async () => {
  expect(
    await resolvePiWorkloadMemory("auto", "2048", {}, "darwin", 6 * 1024 ** 3),
  ).toBeUndefined();
  expect(
    await resolvePiWorkloadMemory("auto", "2048", {}, "linux", 16 * 1024 ** 3),
  ).toBeUndefined();
  expect(await resolvePiWorkloadMemory("off", "2048", {}, "linux", 6 * 1024 ** 3)).toBeUndefined();
  await expect(resolvePiWorkloadMemory("on", "2048", {}, "darwin")).rejects.toThrow(
    "requires Linux",
  );
});

describe.skipIf(!supported)("Pi command isolation on Linux", () => {
  let pool: string;
  let directory: string;
  const managers: PiWorkloads[] = [];
  const owners: Array<ReturnType<typeof makeManagedProcess>> = [];
  const sockets: Net.Socket[] = [];
  const servers: Net.Server[] = [];

  beforeEach(async () => {
    pool = `rove-workload-test-${Crypto.randomUUID()}.slice`;
    directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "rove-workload-test-"));
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
    await Promise.all(owners.splice(0).map((owner) => owner.cleanup()));
    for (const socket of sockets.splice(0)) socket.destroy();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await executeProcessControl("systemctl", ["--user", "stop", pool]);
    await FS.rm(directory, { recursive: true, force: true });
  });

  async function manager() {
    const owner = makeManagedProcess(process.execPath, [
      "-e",
      "process.send('ready'); process.on('message',()=>{})",
    ]);
    owners.push(owner);
    const child = ChildProcess.spawn(owner.command, owner.args, {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
    });
    const workloads = await PiWorkloads.create({ memoryMiB: 384, ownerUnit: owner.unit, pool });
    managers.push(workloads);
    return { workloads, child, owner };
  }

  async function gate() {
    const address = Path.join(directory, Crypto.randomUUID());
    let accept!: (socket: Net.Socket) => void;
    const ready = new Promise<Net.Socket>((resolve) => {
      accept = resolve;
    });
    const server = Net.createServer((socket) => {
      sockets.push(socket);
      socket.once("data", () => accept(socket));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(address, resolve));
    const command = node(
      `const s=require('node:net').connect(${JSON.stringify(address)});s.on('connect',()=>s.write('ready'));s.on('data',()=>s.end());`,
    );
    return { command, ready };
  }

  it("uses one foreground lease across instances, while the queued call remains cancellable", async () => {
    const first = await manager();
    const second = await manager();
    const active = await gate();
    const firstRun = first.workloads.exec(active.command, directory, { onData: () => {} });
    const connection = await active.ready;
    let queued!: () => void;
    const queuedReceipt = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const abort = new AbortController();
    let executed = false;
    const waiting = second.workloads.exec("echo should-not-run", directory, {
      signal: abort.signal,
      onData: (chunk) => {
        if (chunk.toString().includes("queued")) queued();
        if (chunk.toString().includes("should-not-run")) executed = true;
      },
    });
    const cancelled = expect(waiting).rejects.toThrow();
    await queuedReceipt;
    abort.abort();
    await cancelled;
    expect(executed).toBe(false);
    connection.write("release");
    expect(await firstRun).toEqual({ exitCode: 0 });
    expect(await second.workloads.exec("echo next", directory, { onData: () => {} })).toEqual({
      exitCode: 0,
    });
  }, 20_000);

  it("admits a queued command only after the previous instance releases its scope", async () => {
    const first = await manager();
    const second = await manager();
    const a = await gate();
    const b = await gate();
    const aRun = first.workloads.exec(a.command, directory, { onData: () => {} });
    const aConnection = await a.ready;
    let queued!: () => void;
    const queuedReceipt = new Promise<void>((resolve) => {
      queued = resolve;
    });
    let bEntered = false;
    void b.ready.then(() => {
      bEntered = true;
    });
    const bRun = second.workloads.exec(b.command, directory, { onData: () => queued() });
    await queuedReceipt;
    expect(bEntered).toBe(false);
    aConnection.write("release");
    expect(await aRun).toEqual({ exitCode: 0 });
    const bConnection = await b.ready;
    bConnection.write("release");
    expect(await bRun).toEqual({ exitCode: 0 });
  }, 20_000);

  it("contains a command OOM without terminating its owner or another instance, then admits new work", async () => {
    const first = await manager();
    const second = await manager();
    const service = await gate();
    const background = await first.workloads.start(service.command, directory, "service-thread");
    if (!("id" in background)) throw new Error("Missing background id");
    await service.ready;
    let output = "";
    expect(
      await first.workloads.exec(
        node("const b=[];for(let i=0;i<512;i++)b.push(Buffer.alloc(1024*1024,1));"),
        directory,
        {
          onData: (chunk) => {
            output += chunk;
          },
        },
      ),
    ).toEqual({ exitCode: 137 });
    expect(output).toContain("memory budget");
    expect(first.child.exitCode).toBeNull();
    expect(first.child.signalCode).toBeNull();
    expect(second.child.exitCode).toBeNull();
    expect(first.workloads.list("service-thread")[0]?.exitCode).toBeUndefined();
    expect(await second.workloads.exec("echo recovered", directory, { onData: () => {} })).toEqual({
      exitCode: 0,
    });
    await first.workloads.stop(background.id, "service-thread");
  }, 20_000);

  it("keeps a background service accounted for without occupying the foreground slot", async () => {
    const { workloads } = await manager();
    const service = await gate();
    const started = await workloads.start(service.command, directory, "thread-a");
    expect("id" in started).toBe(true);
    if (!("id" in started)) throw new Error("Missing background id");
    await service.ready;
    expect(workloads.list("thread-a")).toHaveLength(1);
    expect(workloads.list("thread-b")).toHaveLength(0);
    await expect(workloads.stop(started.id, "thread-b")).rejects.toThrow("Unknown");
    await expect(workloads.start("echo second", directory, "thread-b")).rejects.toThrow("occupied");
    expect(await workloads.exec("echo foreground", directory, { onData: () => {} })).toEqual({
      exitCode: 0,
    });
    await workloads.stop(started.id, "thread-a");
    expect("id" in (await workloads.start("echo replacement", directory, "thread-b"))).toBe(true);
  }, 20_000);

  it("cancels a managed service with its tool signal and releases its reserved slot", async () => {
    const { workloads } = await manager();
    const service = await gate();
    const abort = new AbortController();
    const started = await workloads.start(service.command, directory, "thread", abort.signal);
    if (!("id" in started)) throw new Error("Missing background id");
    const connection = await service.ready;
    const closed = new Promise<void>((resolve) => connection.once("close", () => resolve()));
    abort.abort();
    await closed;
    await workloads.stop(started.id, "thread");
    expect("id" in (await workloads.start("echo after-cancel", directory, "thread"))).toBe(true);
  }, 20_000);

  it("kills shell-backgrounded descendants before releasing the foreground lease", async () => {
    const { workloads } = await manager();
    let pid = 0;
    await workloads.exec("sleep 1000 >/dev/null 2>&1 & echo $!", directory, {
      onData: (chunk) => {
        const value = chunk.toString().trim();
        if (/^\d+$/.test(value)) pid = Number(value);
      },
    });
    expect(pid).toBeGreaterThan(0);
    const status = await FS.readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    expect(status === "" || /^State:\s+Z/m.test(status)).toBe(true);
    expect(await workloads.exec("echo free-slot", directory, { onData: () => {} })).toEqual({
      exitCode: 0,
    });
  }, 20_000);

  it("reconstructs the budget after an owner restart and stops its managed services", async () => {
    const first = await manager();
    const service = await gate();
    await first.workloads.start(service.command, directory, "thread");
    await service.ready;
    await first.owner.cleanup();
    await first.workloads.dispose();
    const second = await manager();
    expect(
      await second.workloads.exec("echo after-restart", directory, { onData: () => {} }),
    ).toEqual({ exitCode: 0 });
    expect(
      await executeProcessControl("systemctl", [
        "--user",
        "show",
        pool,
        "--property=MemoryMax",
        "--value",
      ]),
    ).toBe(String(384 * 1024 ** 2));
    const replacement = await gate();
    expect("id" in (await second.workloads.start(replacement.command, directory, "thread"))).toBe(
      true,
    );
    await replacement.ready;
  }, 20_000);

  it("enforces a command deadline without terminating Pi or leaving its slot occupied", async () => {
    const { workloads, child } = await manager();
    const active = await gate();
    const run = workloads.exec(active.command, directory, { onData: () => {}, timeout: 1 });
    await active.ready;
    expect(await run).toEqual({ exitCode: 124 });
    expect(child.signalCode).toBeNull();
    expect(await workloads.exec("echo after-timeout", directory, { onData: () => {} })).toEqual({
      exitCode: 0,
    });
  }, 20_000);

  it("honours the inherited override even when settings say off", async () => {
    expect(
      await resolvePiWorkloadMemory("off", "3072", { ROVE_PI_MEMORY_BUDGET_MIB: "2048" }),
    ).toBe(2048);
    await expect(resolvePiWorkloadMemory("on", "128", {})).rejects.toThrow("384");
  });
});
