// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { PiRuntimeProcess } from "../src/provider/Layers/PiRuntimeProcess.ts";

const cwd = process.argv[2];
NodeAssert.ok(cwd, "fixture project is required");
const agentDir = process.env.PI_CODING_AGENT_DIR;
NodeAssert.ok(agentDir, "fixture agent directory is required");
const runtime = await PiRuntimeProcess.create({ agentDir });
try {
  const session = await runtime.createSession({
    cwd,
    agentDir,
    interactive: true,
    model: "rove-extension-test/fixture",
    thinkingLevel: undefined,
    resumeSessionId: undefined,
  });
  try {
    const results: unknown[] = [];
    const errors: unknown[] = [];
    const notifications: unknown[] = [];
    const inputReplies: Promise<boolean | undefined>[] = [];
    session.subscribe((event) => {
      if (event.type === "tool_execution_end") results.push(event.result);
      if (event.type === "extension_error") errors.push(event.error);
      if (event.type === "rove_ui_notify") notifications.push(event.message);
      if (event.type === "rove_ui_request") {
        inputReplies.push(
          Promise.resolve(session.respondToUserInput?.(String(event.requestId), { answer: "0" })),
        );
      }
    });
    await session.prompt("/count");
    NodeAssert.deepEqual(await Promise.all(inputReplies), [true]);
    NodeAssert.match(
      NodeFS.readFileSync(NodePath.join(cwd, "extension.log"), "utf8"),
      /start:true:rpc\ncommand:1:true/,
    );
    await session.prompt("/probe-child-runtime");
    await session.prompt("/probe-host-sdk");
    NodeAssert.ok(notifications.includes("host SDK loaded in Rove and detached child"));
    NodeAssert.deepEqual(errors, [], "child runtime bootstrap must not fail in an extension");
    NodeAssert.match(
      NodeFS.readFileSync(NodePath.join(cwd, "runtime-probe.txt"), "utf8"),
      /background Pi runtime bootstrap passed/,
    );
    await session.prompt("Call the fixture tool");
    NodeAssert.match(JSON.stringify(results), /extension tool worked/);
    await Effect.runPromise(Effect.log("bundled Pi extensions smoke test passed"));
  } finally {
    await session.dispose();
  }
} finally {
  await runtime.dispose();
}
