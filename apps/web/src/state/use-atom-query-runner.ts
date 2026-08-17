import { RegistryContext } from "@effect/atom-react";
import {
  executeAtomQuery,
  type AtomCommandOptions,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { useCallback, useContext } from "react";
import * as RuntimePredicate from "effect/Predicate";

export function useAtomQueryRunner<T, A, E>(
  family: (target: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  options?: string | AtomCommandOptions,
): (target: T) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const explicitLabel = RuntimePredicate.isString(options) ? options : options?.label;
  const reportFailure = RuntimePredicate.isString(options)
    ? true
    : (options?.reportFailure ?? true);
  const reportDefect = RuntimePredicate.isString(options) ? true : (options?.reportDefect ?? true);

  return useCallback(
    (target: T) => {
      const atom = family(target);
      return executeAtomQuery(registry, atom, {
        label: explicitLabel ?? atom.label?.[0] ?? "atom query",
        reportFailure,
        reportDefect,
      });
    },
    [explicitLabel, family, registry, reportDefect, reportFailure],
  );
}
