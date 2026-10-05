import { routes, type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @rove-code/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@rove-code/scripts...' --filter '@rove-code/web...'",
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
