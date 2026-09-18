// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { createPiSession } from "../src/provider/Layers/PiSessionFactory.ts";

const cwd = process.argv[2];
NodeAssert.ok(cwd, "fixture project is required");
const session = await createPiSession({
  cwd,
  model: "rove-extension-test/fixture",
  thinkingLevel: undefined,
  resumeSessionId: undefined,
});
try {
  const results: unknown[] = [];
  const errors: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") results.push(event.result);
    if (event.type === "extension_error") errors.push(event.error);
  });
  await session.prompt("/probe-child-runtime");
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
