import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export function previewWorkerName(prNumber) {
  NodeAssert.match(String(prNumber), /^[1-9][0-9]*$/);
  return `rove-web-pr-${prNumber}`;
}

export function previewDeployment(prNumber, subdomain, baseConfig, assetsDirectory) {
  NodeAssert.match(subdomain, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  const name = previewWorkerName(prNumber);
  return {
    origin: `https://${name}.${subdomain}.workers.dev`,
    config: {
      name,
      compatibility_date: baseConfig.compatibility_date,
      workers_dev: true,
      preview_urls: false,
      assets: {
        directory: NodePath.resolve(assetsDirectory),
        not_found_handling: "single-page-application",
      },
    },
  };
}

export async function cloudflarePreviewRequest(path, method = "GET") {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Cloudflare account ID and API token are required.");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (method === "DELETE" && response.status === 404) return;
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(
      `Cloudflare preview ${method} failed with HTTP ${response.status}: ${JSON.stringify(body.errors)}`,
    );
  }
  return body.result;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const [command, prNumber, configPath, subdomain] = process.argv.slice(2);
  const name = previewWorkerName(prNumber);
  switch (command) {
    case "resolve": {
      const result = await cloudflarePreviewRequest("workers/subdomain");
      if (!result.subdomain)
        throw new Error(
          "Register a free workers.dev subdomain in Cloudflare before enabling web previews.",
        );
      const deployment = previewDeployment(prNumber, result.subdomain, {}, ".");
      NodeFS.appendFileSync(
        process.env.GITHUB_OUTPUT,
        `origin=${deployment.origin}\nsubdomain=${result.subdomain}\n`,
      );
      break;
    }
    case "config": {
      const base = JSON.parse(NodeFS.readFileSync("apps/web/wrangler.json", "utf8"));
      const deployment = previewDeployment(prNumber, subdomain, base, "apps/web/dist");
      NodeFS.writeFileSync(configPath, `${JSON.stringify(deployment.config, null, 2)}\n`);
      break;
    }
    case "delete":
      await cloudflarePreviewRequest(`workers/scripts/${name}`, "DELETE");
      console.log(`Removed preview ${name}.`);
      break;
    default:
      throw new Error("Expected resolve, config, or delete.");
  }
}
