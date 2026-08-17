import { RegistryContext } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandOptions,
  type AtomCommandResult,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useContext } from "react";
import * as RuntimePredicate from "effect/Predicate";

export function useAtomCommand<A, E, W>(
  command: AtomCommand<W, A, E>,
  options?: string | AtomCommandOptions,
): (value: W) => Promise<AtomCommandResult<A, E>> {
  const registry = useContext(RegistryContext);
  const label = RuntimePredicate.isString(options) ? options : (options?.label ?? command.label);
  const reportFailure = RuntimePredicate.isString(options)
    ? true
    : (options?.reportFailure ?? true);
  const reportDefect = RuntimePredicate.isString(options) ? true : (options?.reportDefect ?? true);

  return useCallback(
    (value: W) => runAtomCommand(registry, command, value, { label, reportFailure, reportDefect }),
    [command, label, registry, reportDefect, reportFailure],
  );
}
