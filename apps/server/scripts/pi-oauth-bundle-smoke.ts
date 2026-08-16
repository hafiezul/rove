import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PiDriver } from "../src/provider/Drivers/PiDriver.ts";

void PiDriver;

const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
const model = modelRuntime.getModel("openai-codex", "gpt-5.6-luna");
if (model === undefined) {
  throw new Error("openai-codex/gpt-5.6-luna is missing from the smoke-test catalog");
}
const auth = await modelRuntime.getAuth(model);
if (auth?.auth.apiKey !== "test-access-token") {
  throw new Error("Bundled Pi did not derive the stored OpenAI Codex OAuth credential");
}
process.stdout.write("bundled Pi OAuth smoke test passed\n");
