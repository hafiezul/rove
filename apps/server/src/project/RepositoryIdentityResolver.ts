import {
  DEFAULT_REPOSITORY_REMOTE_PREFERENCE,
  type RepositoryIdentity,
  type RepositoryRemotePreference,
  type SourceControlProviderError,
} from "@rove-code/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@rove-code/shared/git";
import { isSshRemoteUrl } from "@rove-code/shared/sourceControl";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
// Background sweeps resolve every project each minute. A long TTL keeps them
// from spawning git each time. Clone, publish, and PR discovery (after a turn
// and before it saves links) resolve with `refresh: true`.
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
// Short, so a folder that gains a repository or a remote shows up quickly.
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: {
        readonly refresh?: boolean;
        /** The remote that wins when a checkout has both; defaults to `origin`. */
        readonly preferredRemote?: RepositoryRemotePreference;
      },
    ) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("@rove-code/server/project/RepositoryIdentityResolver") {}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

const REMOTE_PREFERENCE_ORDER: Record<
  RepositoryRemotePreference,
  readonly RepositoryRemotePreference[]
> = {
  origin: ["origin", "upstream"],
  upstream: ["upstream", "origin"],
};

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
  preference: RepositoryRemotePreference = DEFAULT_REPOSITORY_REMOTE_PREFERENCE,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of REMOTE_PREFERENCE_ORDER[preference]) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
  /** The real host behind an `~/.ssh/config` alias, when the remote uses one. */
  readonly sshHostname?: string | null;
}): RepositoryIdentity {
  const remoteKey = normalizeGitRemoteUrl(input.remoteUrl);
  const repositoryPath = remoteKey.split("/").slice(1).join("/");
  // The alias only means something to ssh. Everything keyed by the identity
  // (hosts, accounts, `gh --repo`) needs the forge's real host instead.
  const canonicalKey =
    input.sshHostname && repositoryPath ? `${input.sshHostname}/${repositoryPath}` : remoteKey;
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(
    input.sshHostname ? `ssh://${input.sshHostname}/${repositoryPath}` : input.remoteUrl,
  );
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : undefined),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : undefined),
    ...(owner ? { owner } : undefined),
    ...(repositoryName ? { name: repositoryName } : undefined),
  };
}

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
      return null;
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

const SCP_SSH_HOST_PATTERN = /^[^@/\s]+@([^:/]+):/;
const SSH_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function sshRemoteAlias(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!isSshRemoteUrl(trimmed)) return null;
  // Known forge hosts are never aliases; only unrecognized hosts are worth asking ssh about.
  if (detectSourceControlProviderFromGitRemoteUrl(trimmed)?.kind !== "unknown") return null;
  let host = SCP_SSH_HOST_PATTERN.exec(trimmed)?.[1];
  if (host === undefined) {
    try {
      host = new URL(trimmed).hostname;
    } catch {
      return null;
    }
  }
  return host && SSH_ALIAS_PATTERN.test(host) ? host : null;
}

/**
 * Multi-account setups point remotes at `~/.ssh/config` aliases such as
 * `git@github-work:org/repo.git`. `ssh -G` prints the alias's effective
 * hostname without connecting. Null when the host is not an alias.
 */
const resolveSshHostname = Effect.fn("RepositoryIdentityResolver.resolveSshHostname")(function* (
  remoteUrl: string,
  cwd: string,
): Effect.fn.Return<string | null, never, ProcessRunner.ProcessRunner> {
  const alias = sshRemoteAlias(remoteUrl);
  if (alias === null) return null;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: "ssh",
      args: ["-G", alias],
      cwd,
      timeout: Duration.seconds(5),
      maxOutputBytes: 16_000,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (result._tag === "None" || result.value.code !== 0) return null;
  const hostname = /^hostname\s+(\S+)\s*$/im.exec(result.value.stdout)?.[1]?.toLowerCase();
  return hostname === undefined || hostname === alias.toLowerCase() ? null : hostname;
});

interface IdentityCacheKey {
  readonly rootPath: string;
  readonly preferredRemote: RepositoryRemotePreference;
}

const identityCacheKey = (key: IdentityCacheKey) => `${key.preferredRemote}\u0000${key.rootPath}`;

function parseIdentityCacheKey(key: string): IdentityCacheKey {
  const separator = key.indexOf("\u0000");
  return {
    preferredRemote: key.slice(0, separator) as RepositoryRemotePreference,
    rootPath: key.slice(separator + 1),
  };
}

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* ({
  rootPath,
  preferredRemote,
}: IdentityCacheKey): Effect.fn.Return<
  RepositoryIdentity | null,
  never,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const remoteResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", rootPath, "remote", "-v"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remote = pickPrimaryRemote(
    parseRemoteFetchUrls(remoteResult.value.stdout),
    preferredRemote,
  );
  if (remote === null) return null;
  const sshHostname = yield* resolveSshHostname(remote.remoteUrl, rootPath);
  return buildRepositoryIdentity({ ...remote, rootPath, sshHostname });
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  // Git errors and timeouts resolve to null, so they use the negative TTL like
  // "no repository" or "no remote". Only interrupts and defects skip the cache.
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === null
          ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
          : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
      onFailure: () => Duration.zero,
    });

  const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  // Keyed by root and remote preference, so projects sharing a checkout can
  // prefer different remotes without evicting each other.
  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(parseIdentityCacheKey(cacheKey)).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.filterOrElse(
          (identity): identity is null => identity === null,
          (identity) => refine(identity).pipe(Effect.orElseSucceed(() => identity)),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  // Untraced because almost every call is a cache hit. The lookups that spawn
  // git keep their own spans.
  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
      if (cacheKey === null) return null;
      if (options?.refresh) {
        for (const preferredRemote of ["origin", "upstream"] as const) {
          yield* Cache.invalidate(
            repositoryIdentityCache,
            identityCacheKey({ rootPath: cacheKey, preferredRemote }),
          );
        }
      }
      return yield* Cache.get(
        repositoryIdentityCache,
        identityCacheKey({
          rootPath: cacheKey,
          preferredRemote: options?.preferredRemote ?? DEFAULT_REPOSITORY_REMOTE_PREFERENCE,
        }),
      );
    },
  );

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
