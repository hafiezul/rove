// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, vi } from "vite-plus/test";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeSdkDiscoveryClient, PiDriver } from "./PiDriver.ts";
import { parsePiResumeCursor } from "../Layers/PiAdapter.ts";

const decodeEnvironmentRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ marker: Schema.String, childMarker: Schema.String, agentDir: Schema.String }),
  ),
);

const encodeExtensionSettings = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ extensions: Schema.Array(Schema.String) })),
);

function installEnvironmentFixture(agentDir: string) {
  const extension = NodePath.join(agentDir, "environment.ts");
  NodeFS.copyFileSync(
    new URL("../Layers/fixtures/pi-environment-extension.ts", import.meta.url),
    extension,
  );
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "settings.json"),
    encodeExtensionSettings({ extensions: [extension] }),
  );
}

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "rove-pi-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
);

describe("Pi SDK discovery client", () => {
  let root: string;
  let agentDir: string;

  beforeEach(() => {
    root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-pi-discovery-")),
    );
    agentDir = NodePath.join(root, "agent");
    NodeFS.mkdirSync(NodePath.join(agentDir, "skills", "fixture-skill"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: A fixture skill\n---\n\nBody\n",
    );
    NodeFS.mkdirSync(NodePath.join(agentDir, "prompts"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "prompts", "greet.md"),
      "---\ndescription: Greet someone\nargument-hint: name\n---\n\nHello {{args}}\n",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("PI_OFFLINE", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("lists user-scope skills and prompt templates plus loaded extension commands", async () => {
    const client = makeSdkDiscoveryClient(() => [
      { name: "subagents", description: "Run a subagent" },
      // Collides with the greet template; the extension command wins.
      { name: "greet", description: "Extension command wins" },
    ]);
    const discovered = await client.discover({ cwd: undefined });

    assert.deepEqual(discovered.slashCommands, [
      { name: "subagents", description: "Run a subagent" },
      { name: "greet", description: "Extension command wins" },
    ]);
    const skill = discovered.skills.find((candidate) => candidate.name === "fixture-skill");
    assert.isDefined(skill);
    assert.strictEqual(skill?.scope, "user");
    assert.strictEqual(skill?.enabled, true);
  });

  it("describes neither the server cwd nor a random project when no cwd is given", async () => {
    // A project directory with its own resources exists, but the instance
    // snapshot is global: without an explicit cwd only user scope loads.
    const project = NodePath.join(root, "project");
    NodeFS.mkdirSync(NodePath.join(project, ".pi", "prompts"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(project, ".pi", "prompts", "local.md"),
      "---\ndescription: Project local\n---\n\nLocal\n",
    );
    const client = makeSdkDiscoveryClient();
    const discovered = await client.discover({ cwd: undefined });
    assert.isFalse(discovered.slashCommands.some((command) => command.name === "local"));

    // Thread-scoped discovery shares the session's trust without changing
    // the user's persisted Pi settings.
    const scoped = await client.discover({ cwd: project });
    const local = scoped.slashCommands.find((command) => command.name === "local");
    assert.isDefined(local);
    assert.strictEqual(local?.description, "Project local");
    assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "settings.json")));
  });

  it.effect("groups default and explicit agent directories by their resolved location", () =>
    Effect.gen(function* () {
      const create = (id: string, directory: string) =>
        PiDriver.create({
          instanceId: ProviderInstanceId.make(id),
          displayName: undefined,
          enabled: false,
          environment: [],
          config: { ...PiDriver.defaultConfig(), agentDir: directory },
        });
      const implicit = yield* create("pi-default", "");
      const explicit = yield* create("pi-explicit", NodePath.join(agentDir, "."));
      const isolated = yield* create("pi-other", NodePath.join(root, "other-agent"));
      assert.deepStrictEqual(implicit.continuationIdentity, explicit.continuationIdentity);
      assert.notDeepEqual(implicit.continuationIdentity, isolated.continuationIdentity);
      assert.strictEqual(
        (yield* implicit.snapshot.getSnapshot).continuation?.groupKey,
        explicit.continuationIdentity.continuationKey,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "keeps instance environments isolated in catalogs, threads, helpers, and child processes",
    () =>
      Effect.gen(function* () {
        installEnvironmentFixture(agentDir);
        vi.stubEnv("ROVE_PI_TEST_MARKER", "server");
        const instances = yield* Effect.forEach(
          ["first", "second"],
          (marker) =>
            PiDriver.create({
              instanceId: ProviderInstanceId.make(`pi-${marker}`),
              displayName: undefined,
              enabled: true,
              environment: [
                { name: "ROVE_PI_TEST_MARKER", value: marker, sensitive: false },
                {
                  name: "PI_CODING_AGENT_DIR",
                  value: NodePath.join(root, "unused"),
                  sensitive: false,
                },
              ],
              config: { ...PiDriver.defaultConfig(), agentDir },
            }),
          { concurrency: "unbounded" },
        );
        for (const [index, instance] of instances.entries()) {
          const marker = ["first", "second"][index]!;
          const snapshot = yield* instance.snapshot.refresh;
          assert.strictEqual(
            snapshot.models.find((model) => model.slug === "environment-fixture/fixture")?.name,
            marker,
          );
          yield* instance.adapter.startSession({
            threadId: ThreadId.make(`pi-${marker}-thread`),
            cwd: root,
            runtimeMode: "full-access",
            modelSelection: {
              instanceId: instance.instanceId,
              model: "environment-fixture/fixture",
            },
          });
          const title = yield* instance.textGeneration.generateThreadTitle({
            cwd: root,
            message: "Name this thread",
            modelSelection: {
              instanceId: instance.instanceId,
              model: "environment-fixture/fixture",
            },
          });
          assert.strictEqual(title.title, marker);
        }
        const records = NodeFS.readFileSync(NodePath.join(agentDir, "environment.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => decodeEnvironmentRecord(line));
        for (const marker of ["first", "second"]) {
          assert.strictEqual(records.filter((record) => record.marker === marker).length, 2);
        }
        assert.isTrue(
          records.every(
            (record) => record.childMarker === record.marker && record.agentDir === agentDir,
          ),
        );
        assert.strictEqual(process.env.ROVE_PI_TEST_MARKER, "server");
        assert.strictEqual(process.env.PI_CODING_AGENT_DIR, agentDir);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "uses the instance agent-directory environment override for sessions and discovery",
    () =>
      Effect.gen(function* () {
        const instanceAgentDir = NodePath.join(root, "environment-agent");
        NodeFS.mkdirSync(instanceAgentDir);
        installEnvironmentFixture(instanceAgentDir);
        NodeFS.mkdirSync(NodePath.join(instanceAgentDir, "prompts"));
        NodeFS.writeFileSync(
          NodePath.join(instanceAgentDir, "prompts", "instance.md"),
          "Instance prompt",
        );
        const instance = yield* PiDriver.create({
          instanceId: ProviderInstanceId.make("pi-environment-directory"),
          displayName: undefined,
          enabled: true,
          environment: [{ name: "PI_CODING_AGENT_DIR", value: instanceAgentDir, sensitive: false }],
          config: PiDriver.defaultConfig(),
        });
        const snapshot = yield* instance.snapshot.refresh;
        assert.strictEqual(snapshot.continuation?.groupKey, `pi:agent:${instanceAgentDir}`);
        assert.isTrue(snapshot.slashCommands.some((command) => command.name === "instance"));
        assert.isFalse(snapshot.slashCommands.some((command) => command.name === "greet"));
        const session = yield* instance.adapter.startSession({
          threadId: ThreadId.make("pi-environment-directory-thread"),
          cwd: root,
          runtimeMode: "full-access",
          modelSelection: { instanceId: instance.instanceId, model: "environment-fixture/fixture" },
        });
        assert.isTrue(
          parsePiResumeCursor(session.resumeCursor)?.sessionFile?.startsWith(instanceAgentDir),
        );
        assert.strictEqual(process.env.PI_CODING_AGENT_DIR, agentDir);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not load extensions or admit work when the instance is disabled", () =>
    Effect.gen(function* () {
      installEnvironmentFixture(agentDir);
      const instance = yield* PiDriver.create({
        instanceId: ProviderInstanceId.make("pi-disabled"),
        displayName: undefined,
        enabled: false,
        environment: [],
        config: { ...PiDriver.defaultConfig(), agentDir },
      });
      assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "environment.jsonl")));
      const snapshot = yield* instance.snapshot.refresh;
      assert.isFalse(snapshot.enabled);
      assert.isFalse(snapshot.installed);
      for (const operation of [
        instance.piCatalog!.getCatalog(),
        instance.piCatalog!.refreshCatalog(),
      ]) {
        const error = yield* Effect.flip(operation);
        assert.include(error.message, "disabled");
      }
      const sessionError = yield* instance.adapter
        .startSession({
          threadId: ThreadId.make("pi-disabled-thread"),
          cwd: root,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);
      assert.include(sessionError.message, "disabled");
      const titleError = yield* instance.textGeneration
        .generateThreadTitle({
          cwd: root,
          message: "Name this thread",
          modelSelection: { instanceId: instance.instanceId, model: "environment-fixture/fixture" },
        })
        .pipe(Effect.flip);
      assert.include(titleError.detail, "disabled");
      assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "environment.jsonl")));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it("reads user resources from an explicit per-instance agent directory", async () => {
    const instanceAgentDir = NodePath.join(root, "agent-personal");
    NodeFS.mkdirSync(NodePath.join(instanceAgentDir, "skills", "personal-skill"), {
      recursive: true,
    });
    NodeFS.writeFileSync(
      NodePath.join(instanceAgentDir, "skills", "personal-skill", "SKILL.md"),
      "---\nname: personal-skill\ndescription: Personal skill\n---\n\nBody\n",
    );
    const client = makeSdkDiscoveryClient(undefined, instanceAgentDir);
    const discovered = await client.discover({ cwd: undefined });
    assert.isTrue(discovered.skills.some((skill) => skill.name === "personal-skill"));
    assert.isFalse(discovered.skills.some((skill) => skill.name === "fixture-skill"));
  });
});
