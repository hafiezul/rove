// Bundle the manifest without loading the SDK runtime in the server.
import packageJson from "../../node_modules/@earendil-works/pi-coding-agent/package.json" with { type: "json" };

export const PI_SDK_VERSION = packageJson.version || "0.0.0";
export const PI_CONFIG_DIR = packageJson.piConfig.configDir || ".pi";
