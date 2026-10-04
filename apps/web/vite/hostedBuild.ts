const DISABLED_HOSTED_SETTINGS = [
  "VITE_HTTP_URL",
  "VITE_WS_URL",
  "VITE_DEV_SERVER_URL",
  "VITE_ROVE_RELAY_URL",
  "VITE_CLERK_PUBLISHABLE_KEY",
  "VITE_CLERK_JWT_TEMPLATE",
  "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
  "VITE_RELAY_OTLP_TRACES_URL",
  "VITE_RELAY_OTLP_TRACES_DATASET",
  "VITE_RELAY_OTLP_TRACES_TOKEN",
] as const;

export function hostedBuildDefines(appUrl: string | undefined) {
  if (!appUrl) {
    throw new Error(
      "Set VITE_HOSTED_APP_URL to the public HTTPS origin before building hosted web.",
    );
  }

  const url = new URL(appUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "VITE_HOSTED_APP_URL must be an HTTPS origin without credentials, a path, or a query.",
    );
  }

  return {
    ...Object.fromEntries(
      DISABLED_HOSTED_SETTINGS.map((name) => [`import.meta.env.${name}`, JSON.stringify("")]),
    ),
    "import.meta.env.VITE_HOSTED_APP_URL": JSON.stringify(url.origin),
    "import.meta.env.VITE_HOSTED_APP_CHANNEL": JSON.stringify("latest"),
  };
}
