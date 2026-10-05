import type { APIRoute } from "astro";

import { buildRoveProjectFileJsonSchema } from "@rove-code/shared/roveProjectFile";

// Rendered at build time and served at /schema/t3.json so t3.json files can
// reference it via "$schema" for editor/LSP support.
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildRoveProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
