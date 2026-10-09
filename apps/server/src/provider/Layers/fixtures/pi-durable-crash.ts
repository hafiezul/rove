// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { createModels } from "pi-durable-ai/models";
import { fauxAssistantMessage, fauxProvider } from "pi-durable-ai/providers/faux";
import { durableContext, openPiDurableSession } from "../PiDurableSession.ts";

const directory = process.argv[2];
if (!directory) throw new Error("Missing isolated fixture directory.");
const faux = fauxProvider({ models: [{ id: "test" }], tokensPerSecond: Infinity });
const models = createModels();
models.setProvider(faux.provider);
const { conversation } = await openPiDurableSession({
  file: NodePath.join(
    directory,
    `${NodeCrypto.createHash("sha256").update("durable-test").digest("hex")}.sqlite`,
  ),
  cwd: directory,
  models,
});
await conversation.configure(
  { model: { provider: faux.provider.id, modelId: "test" } },
  durableContext,
);
faux.setResponses([
  async () => {
    // This receipt is emitted only after Durable has committed the input and
    // reserved its generation. The parent kills this exact child, not a pattern.
    process.stdout.write("generation-started\n");
    await new Promise(() => undefined);
    return fauxAssistantMessage("unreachable");
  },
]);
await conversation.submit(
  { type: "input", content: "survive process death", requestId: "crash-test" },
  durableContext,
);
// Keep the fixture alive while its model response deliberately remains pending.
process.stdin.resume();
