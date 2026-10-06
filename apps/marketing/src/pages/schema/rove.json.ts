import type { APIRoute } from "astro";

import { buildRoveProjectFileJsonSchema } from "@rove-code/shared/roveProjectFile";

// Rendered at build time and served at /schema/rove.json so rove.json files can
// reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildRoveProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
