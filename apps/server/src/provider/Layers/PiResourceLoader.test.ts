// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vite-plus/test";
import { PiResourceLoader } from "./PiSessionFactory.ts";

it("fails loudly when an SDK bump renames the loader internals it filters through", () => {
  const cwd = NodeOS.tmpdir();
  expect(() => new PiResourceLoader({ cwd, agentDir: cwd }, [])).not.toThrow();
  const prototype = Object.getOwnPropertyDescriptors(DefaultResourceLoader.prototype);
  Reflect.set(DefaultResourceLoader.prototype, "loadFinalExtensionSet", undefined);
  try {
    expect(() => new PiResourceLoader({ cwd, agentDir: cwd }, [])).toThrow(
      /internals changed \(loadFinalExtensionSet\)/,
    );
  } finally {
    Object.defineProperty(
      DefaultResourceLoader.prototype,
      "loadFinalExtensionSet",
      prototype.loadFinalExtensionSet!,
    );
  }
});
