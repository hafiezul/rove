import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type {
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ColorValue } from "react-native";
import { runtimeValueKind } from "@t3tools/shared/runtimeValueKind";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

export { NativeHeaderToolbar } from "./NativeHeaderToolbar";

export {
  nativeHeaderScrollEdgeEffects,
  nativeTopScrollEdgeEffect,
  type NativeHeaderScrollEdgeEffects,
  type NativeTopScrollEdgeEffect,
} from "./scrollEdgeEffects";

export type NativeHeaderItemInput = {
  readonly type: string;
};

export type AppNativeStackNavigationOptions = Omit<
  NativeStackNavigationOptions,
  "headerTintColor" | "unstable_headerLeftItems" | "unstable_headerRightItems"
> & {
  readonly headerTintColor?: string | ColorValue;
  readonly unstable_headerCenterItems?: unknown;
  readonly unstable_headerLeftItems?: unknown;
  readonly unstable_headerRightItems?: unknown;
  readonly unstable_headerSubtitle?: unknown;
  readonly unstable_headerToolbarItems?: unknown;
  readonly unstable_navigationItemStyle?: unknown;
};

function useNativeStackNavigation(): NativeStackNavigationProp<ParamListBase> | null {
  return useNavigation<NativeStackNavigationProp<ParamListBase>>();
}

function normalizeScreenOptions(
  options: AppNativeStackNavigationOptions | undefined,
): NativeStackNavigationOptions | undefined {
  if (!options) {
    return options;
  }

  const normalized = { ...options } as NativeStackNavigationOptions & {
    unstable_navigationItemStyle?: unknown;
    unstable_headerCenterItems?: unknown;
    unstable_headerSubtitle?: unknown;
    unstable_headerToolbarItems?: unknown;
  };

  if (normalized.headerTintColor !== undefined) {
    normalized.headerTintColor = String(normalized.headerTintColor);
  }

  // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
  return normalized as NativeStackNavigationOptions;
}

function optionsSignature(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return "null";
  if (
    RuntimePredicate.isBoolean(value) ||
    RuntimePredicate.isNumber(value) ||
    RuntimePredicate.isString(value)
  ) {
    return JSON.stringify(value);
  }
  if (RuntimePredicate.isUndefined(value)) return "undefined";
  if (RuntimePredicate.isFunction(value)) {
    // Header factories are frequently recreated inline. Their source is
    // stable across equivalent renders, while a reference comparison would
    // make navigation.setOptions re-enter the navigator indefinitely.
    return `function:${Function.prototype.toString.call(value)}`;
  }
  if (RuntimePredicate.isSymbol(value)) return `symbol:${String(value)}`;
  if (RuntimePredicate.isBigInt(value)) return `bigint:${String(value)}`;
  if (RuntimePredicate.isObjectOrArray(value)) {
    const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
      object = value as object;
    if (seen.has(object)) return "[circular]";
    seen.add(object);
    if (Array.isArray(value)) {
      return `[${value.map((entry) => optionsSignature(entry, seen)).join(",")}]`;
    }
    // React refs carry mutable native instances that must not make static
    // screen options appear different after every render.
    if ("current" in object) return "[ref]";
    // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    return `{${Object.keys(value as Record<string, SchemaJson>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${optionsSignature((value as Record<string, SchemaJson>)[key], seen)}`,
      )
      .join(",")}}`;
  }
  return runtimeValueKind(value);
}

function stabilizeOptionFunctions<T>(
  value: T,
  path: string,
  latestFunctions: Map<string, (...args: unknown[]) => unknown>,
  wrappers: Map<string, (...args: unknown[]) => unknown>,
  seen = new WeakSet<object>(),
): T {
  if (RuntimePredicate.isFunction(value)) {
    // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    latestFunctions.set(path, value as (...args: unknown[]) => unknown);
    let wrapper = wrappers.get(path);
    if (!wrapper) {
      wrapper = (...args: unknown[]) => {
        return latestFunctions.get(path)?.(...args);
      };
      wrappers.set(path, wrapper);
    }
    // SAFETY: A wrapper has the same callable role as the option function it replaces.
    return wrapper as T;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    // SAFETY: Mapping only recursively replaces function values; it preserves the input array's role.
    return value.map((entry, index) =>
      stabilizeOptionFunctions(entry, `${path}[${index}]`, latestFunctions, wrappers, seen),
    ) as T;
  }
  if (RuntimePredicate.isObjectOrArray(value)) {
    if (seen.has(value) || "current" in value) return value;
    seen.add(value);
    // SAFETY: Rebuilding this option object only recursively replaces function values.
    return Object.fromEntries(
      Object.entries(value as Record<string, SchemaJson>).map(([key, entry]) => [
        key,
        stabilizeOptionFunctions(entry, `${path}.${key}`, latestFunctions, wrappers, seen),
      ]),
    ) as T;
  }
  return value;
}

export function NativeStackScreenOptions(props: {
  readonly options?: AppNativeStackNavigationOptions;
  /**
   * Causes dynamic native header factories to be reapplied when their closed-over
   * menu content changes. Factory functions are intentionally stabilized, so
   * their source alone cannot capture a menu that was initially empty while
   * asynchronous data was loading.
   */
  readonly optionsVersion?: unknown;
  readonly listeners?: Record<string, (event: never) => void>;
  readonly name?: string;
}) {
  const navigation = useNativeStackNavigation();
  const lastAppliedOptionsSignatureRef = useRef<string | undefined>(undefined);
  const latestOptionFunctionsRef = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const optionFunctionWrappersRef = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const normalizedOptions = useMemo(() => normalizeScreenOptions(props.options), [props.options]);
  const // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    stableOptions = normalizedOptions
      ? stabilizeOptionFunctions(
          normalizedOptions,
          "options",
          latestOptionFunctionsRef.current,
          optionFunctionWrappersRef.current,
        )
      : undefined;

  useLayoutEffect(() => {
    if (!navigation || !stableOptions) {
      return;
    }
    const signature = optionsSignature([stableOptions, props.optionsVersion]);
    // Avoid re-entering navigation state when semantically equal options are
    // reapplied every layout (common when callers pass unstable object literals).
    if (lastAppliedOptionsSignatureRef.current === signature) {
      return;
    }
    lastAppliedOptionsSignatureRef.current = signature;
    navigation.setOptions(stableOptions);
  }, [navigation, props.optionsVersion, stableOptions]);

  useEffect(() => {
    if (!navigation || !props.listeners) {
      return;
    }
    const // SAFETY: This branch is unreachable under the owning callback contract.
      subscriptions = Object.entries(props.listeners).map(([eventName, listener]) =>
        navigation.addListener(eventName as never, listener as never),
      );
    return () => {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
    };
  }, [navigation, props.listeners]);

  return null;
}
