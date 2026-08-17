import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as RuntimePredicate from "effect/Predicate";

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: input.selections,
  });
}

/**
 * Labels for the option values currently in effect (select values plus
 * enabled booleans), used to summarize the thread configuration in the
 * composer trigger pill.
 */
export function providerOptionValueLabels(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<string> {
  return descriptors.flatMap((descriptor) => {
    if (descriptor.type === "boolean") {
      return descriptor.currentValue ? [descriptor.label] : [];
    }
    const label = getProviderOptionCurrentLabel(descriptor);
    return label ? [label] : [];
  });
}

/**
 * Applies one option change (by descriptor id) and returns the full selection
 * list to store on the model selection, or null when the change doesn't match
 * an advertised descriptor / choice.
 */
export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && !RuntimePredicate.isBoolean(change.value)) ||
    (descriptor.type === "select" &&
      (!RuntimePredicate.isString(change.value) ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    nextDescriptors = descriptors.map((candidate) =>
      candidate.id === descriptor.id
        ? {
            ...candidate,
            currentValue: change.value,
          }
        : candidate,
    ) as ReadonlyArray<ProviderOptionDescriptor>;

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}
