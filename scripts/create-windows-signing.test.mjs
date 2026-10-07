import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, it } from "vite-plus/test";
import { HostProcessPlatform } from "@rove-code/shared/hostProcess";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "creates a password-protected code-signing identity without replacing it on retry",
  () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "rove-windows-certificate-"),
    );
    directories.push(directory);
    const env = { ...process.env, ROVE_CERTIFICATE_PASSWORD: "certificate-test-password" };
    const script = NodePath.join(import.meta.dirname, "create-windows-signing.sh");
    NodeChildProcess.execFileSync("bash", [script, directory], { env, stdio: "pipe" });
    const pfx = NodePath.join(directory, "rove-windows-signing.pfx");
    const cert = new NodeCrypto.X509Certificate(
      NodeFS.readFileSync(NodePath.join(directory, "rove-windows-signing.cer")),
    );
    NodeAssert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.3"]);
    NodeAssert.equal(cert.ca, false);
    NodeAssert.equal(cert.subject, cert.issuer);
    NodeAssert.equal(cert.verify(cert.publicKey), true);
    const before = NodeFS.readFileSync(pfx);
    NodeChildProcess.execFileSync(
      "openssl",
      ["pkcs12", "-in", pfx, "-noout", "-passin", "env:ROVE_CERTIFICATE_PASSWORD"],
      { env, stdio: "pipe" },
    );
    NodeAssert.throws(() =>
      NodeChildProcess.execFileSync(
        "openssl",
        ["pkcs12", "-in", pfx, "-noout", "-passin", "pass:wrong"],
        { stdio: "pipe" },
      ),
    );
    NodeAssert.throws(
      () => NodeChildProcess.execFileSync("bash", [script, directory], { env, stdio: "pipe" }),
      /Refusing to replace/,
    );
    NodeAssert.deepEqual(NodeFS.readFileSync(pfx), before);
  },
  20_000,
);
