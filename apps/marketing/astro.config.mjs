import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.ROVE_MARKETING_SITE_URL || undefined,
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
