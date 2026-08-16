import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";

/** Register Pi OAuth implementations that must be embedded in the server bundle. */
export function registerPiBundledOAuthFlows(): void {
  // Pi's lazy OAuth imports deliberately evade browser bundlers. The server is
  // also bundled, so register the package's static loaders before ModelRuntime
  // creation; despite its name, this helper is runtime-agnostic.
  registerBunOAuthFlows();
}
