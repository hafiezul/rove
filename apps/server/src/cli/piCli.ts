/**
 * Children started from a single-executable build receive the Pi CLI script as
 * their first argument; the executable's entrypoint recognizes it through this.
 */
export const PI_CLI_ENTRY_ENV = "ROVE_PI_CLI_ENTRY";

/** The Pi CLI script and its arguments when a single executable was relaunched as `pi`. */
export function piCliInvocation(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): { readonly entry: string; readonly args: ReadonlyArray<string> } | undefined {
  const entry = env[PI_CLI_ENTRY_ENV];
  return entry && argv[2] === entry ? { entry, args: argv.slice(3) } : undefined;
}
