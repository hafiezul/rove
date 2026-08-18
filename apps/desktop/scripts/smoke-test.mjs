import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/main.cjs");
const preloadArtifacts = ["preload.cjs", "preview-pick-preload.cjs", "preview-pip-preload.cjs"];
const unsupportedPreloadImports = preloadArtifacts.flatMap((fileName) => {
  const source = NodeFS.readFileSync(
    NodePath.resolve(desktopDir, "dist-electron", fileName),
    "utf8",
  );
  return [...source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)]
    .map((match) => match[1])
    .filter((packageName) => packageName !== "electron")
    .map((packageName) => `${fileName}: ${packageName}`);
});

if (unsupportedPreloadImports.length > 0) {
  console.error("Sandboxed preload artifacts contain unsupported runtime imports:");
  for (const packageName of unsupportedPreloadImports) {
    console.error(` - ${packageName}`);
  }
  process.exit(1);
}

console.log("\nLaunching Electron smoke test...");

const electronCommand = resolveElectronLaunchCommand([mainJs]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const timeout = setTimeout(() => {
  child.kill();
}, 8_000);

child.on("exit", () => {
  clearTimeout(timeout);

  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
    "Unable to load preload script",
    "PrimaryEnvironmentRequestError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  process.exit(0);
});
