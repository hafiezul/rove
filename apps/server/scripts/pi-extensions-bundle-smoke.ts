// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";

import { createPiSession } from "../src/provider/Layers/PiSessionFactory.ts";

const cwd = process.argv[2];
NodeAssert.ok(cwd, "fixture project is required");
const session = await createPiSession({
  cwd,
  model: "rove-extension-test/fixture",
  thinkingLevel: undefined,
  resumeSessionFile: undefined,
});
try {
  const results: unknown[] = [];
  session.subscribe((event) => {
    if (event.type === "tool_execution_end") results.push(event.result);
  });
  await session.prompt("Call the fixture tool");
  NodeAssert.match(JSON.stringify(results), /extension tool worked/);
  await Effect.runPromise(Effect.log("bundled Pi extensions smoke test passed"));
} finally {
  await session.dispose();
}
