import { useNavigation, type ParamListBase } from "@react-navigation/native";
import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemMenu,
  NativeStackNavigationOptions,
  NativeStackNavigationProp,
} from "@react-navigation/native-stack";
import {
  Children,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ColorValue } from "react-native";
import { runtimeValueKind } from "@t3tools/shared/runtimeValueKind";
import * as RuntimePredicate from "effect/Predicate";
import type { Json as SchemaJson } from "effect/Schema";

export {
  nativeHeaderScrollEdgeEffects,
  nativeTopScrollEdgeEffect,
  type NativeHeaderScrollEdgeEffects,
  type NativeTopScrollEdgeEffect,
} from "./scrollEdgeEffects";

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

function stabilizeOptionFunctions(
  value: unknown,
  path: string,
  latestFunctions: Map<string, (...args: unknown[]) => unknown>,
  wrappers: Map<string, (...args: unknown[]) => unknown>,
  seen = new WeakSet<object>(),
) {
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
    return wrapper;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((entry, index) =>
      stabilizeOptionFunctions(entry, `${path}[${index}]`, latestFunctions, wrappers, seen),
    );
  }
  if (RuntimePredicate.isObjectOrArray(value)) {
    if (seen.has(value) || "current" in value) return value;
    seen.add(value);
    // SAFETY: The surrounding adapter has established this JSON-object view before field access.
    return Object.fromEntries(
      Object.entries(value as Record<string, SchemaJson>).map(([key, entry]) => [
        key,
        stabilizeOptionFunctions(entry, `${path}.${key}`, latestFunctions, wrappers, seen),
      ]),
    );
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
      ? (stabilizeOptionFunctions(
          normalizedOptions,
          "options",
          latestOptionFunctionsRef.current,
          optionFunctionWrappersRef.current,
        ) as NativeStackNavigationOptions)
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

function labelFromChildren(children: ReactNode): string {
  const parts: string[] = [];
  Children.forEach(children, (child) => {
    if (RuntimePredicate.isString(child) || RuntimePredicate.isNumber(child)) {
      parts.push(String(child));
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      parts.push(labelFromChildren(child.props.children));
    }
  });
  return parts.join("");
}

type NativeStackHeaderIcon = NonNullable<
  Extract<NativeStackHeaderItem, { type: "button" }>["icon"]
>;
type NativeStackOptionsWithToolbar = NativeStackNavigationOptions & {
  unstable_headerToolbarItems?: () => NativeStackHeaderItem[];
};

function iconFromProp(icon: unknown): NativeStackHeaderIcon | undefined {
  if (!RuntimePredicate.isString(icon)) {
    return undefined;
  }
  // SAFETY: This branch is unreachable under the owning callback contract.
  return { type: "sfSymbol", name: icon as never };
}

type ToolbarElementProps = Record<string, SchemaJson> & { readonly children?: ReactNode };

function elementTypeName(element: ReactElement): string | undefined {
  const type = element.type;
  if (RuntimePredicate.isFunction(type)) {
    // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    return (type as { displayName?: string; name?: string }).displayName ?? type.name;
  }
  return undefined;
}

function convertMenuAction(
  element: ReactElement<ToolbarElementProps>,
): NativeStackHeaderItemMenu["menu"]["items"][number] | null {
  const typeName = elementTypeName(element);
  if (typeName === "NativeHeaderToolbarMenuAction") {
    const label = labelFromChildren(element.props.children);
    // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    return {
      type: "action",
      label,
      description: RuntimePredicate.isString(element.props.subtitle)
        ? element.props.subtitle
        : undefined,
      disabled: Boolean(element.props.disabled),
      icon: iconFromProp(element.props.icon),
      onPress: RuntimePredicate.isFunction(element.props.onPress)
        ? (element.props.onPress as () => void)
        : () => undefined,
      state: element.props.isOn === true ? "on" : undefined,
      destructive: Boolean(element.props.destructive),
      discoverabilityLabel: RuntimePredicate.isString(element.props.discoverabilityLabel)
        ? element.props.discoverabilityLabel
        : undefined,
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    return {
      type: "submenu",
      label: RuntimePredicate.isString(element.props.title)
        ? element.props.title
        : labelFromChildren(element.props.children),
      icon: iconFromProp(element.props.icon),
      inline: Boolean(element.props.inline),
      items: collectMenuItems(element.props.children),
    };
  }

  return null;
}

function collectMenuItems(children: ReactNode): NativeStackHeaderItemMenu["menu"]["items"] {
  const items: NativeStackHeaderItemMenu["menu"]["items"] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ToolbarElementProps>(child)) {
      return;
    }
    const item = convertMenuAction(child);
    if (item) {
      items.push(item);
      return;
    }
    items.push(...collectMenuItems(child.props.children));
  });
  return items;
}

function convertToolbarChild(child: ReactNode): NativeStackHeaderItem | null {
  if (!isValidElement<ToolbarElementProps>(child)) {
    return null;
  }

  const typeName = elementTypeName(child);
  if (typeName === "NativeHeaderToolbarButton") {
    // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    return {
      type: "button",
      label: RuntimePredicate.isString(child.props.label) ? child.props.label : "",
      accessibilityLabel: RuntimePredicate.isString(child.props.accessibilityLabel)
        ? child.props.accessibilityLabel
        : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      onPress: RuntimePredicate.isFunction(child.props.onPress)
        ? (child.props.onPress as () => void)
        : () => undefined,
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant: "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarMenu") {
    // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
    return {
      type: "menu",
      label: RuntimePredicate.isString(child.props.title) ? child.props.title : "",
      accessibilityLabel: RuntimePredicate.isString(child.props.accessibilityLabel)
        ? child.props.accessibilityLabel
        : undefined,
      disabled: Boolean(child.props.disabled),
      icon: iconFromProp(child.props.icon),
      menu: {
        title: RuntimePredicate.isString(child.props.title) ? child.props.title : undefined,
        items: collectMenuItems(child.props.children),
      },
      sharesBackground: !child.props.separateBackground,
      tintColor: child.props.tintColor as ColorValue | undefined,
      variant: "plain",
    };
  }

  if (typeName === "NativeHeaderToolbarSpacer") {
    return {
      type: "spacing",
      spacing: RuntimePredicate.isNumber(child.props.width) ? child.props.width : 8,
      flexible: Boolean(child.props.flexible),
    } as NativeStackHeaderItem;
  }

  return null;
}

function collectToolbarItems(children: ReactNode): NativeStackHeaderItem[] {
  const items: NativeStackHeaderItem[] = [];
  Children.forEach(children, (child) => {
    const item = convertToolbarChild(child);
    if (item) {
      if (item.type === "spacing") {
        // Native inserts spacing items at `index`, treating a missing index
        // as 0 — which would move the spacer in front of earlier siblings.
        // SAFETY: The surrounding adapter boundary establishes the asserted runtime contract.
        (item as { index?: number }).index = items.length;
      }
      items.push(item);
    }
  });
  return items;
}

function NativeHeaderToolbarRoot(props: {
  readonly placement?: "left" | "right" | "bottom";
  readonly children?: ReactNode;
}) {
  const navigation = useNativeStackNavigation();
  const items = useMemo(() => collectToolbarItems(props.children), [props.children]);

  // Swap toolbar owners before paint so split and compact headers cannot clear each other.
  useLayoutEffect(() => {
    if (!navigation) {
      return;
    }
    if (props.placement === "bottom") {
      navigation.setOptions({
        unstable_headerToolbarItems: () => items,
      } as NativeStackOptionsWithToolbar);
      return () => {
        navigation.setOptions({
          unstable_headerToolbarItems: () => [],
        } as NativeStackOptionsWithToolbar);
      };
    }
    if (props.placement === "left") {
      navigation.setOptions({ unstable_headerLeftItems: () => items });
      return () => {
        navigation.setOptions({ unstable_headerLeftItems: () => [] });
      };
    }
    navigation.setOptions({ unstable_headerRightItems: () => items });
    return () => {
      navigation.setOptions({ unstable_headerRightItems: () => [] });
    };
  }, [items, navigation, props.placement]);

  return null;
}

function NativeHeaderToolbarButton(_props: {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly label?: string;
  readonly onPress?: () => void;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
}) {
  return null;
}
NativeHeaderToolbarButton.displayName = "NativeHeaderToolbarButton";

function NativeHeaderToolbarMenu(_props: {
  readonly accessibilityLabel?: string;
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly inline?: boolean;
  readonly separateBackground?: boolean;
  readonly tintColor?: ColorValue;
  readonly title?: string;
}) {
  return null;
}
NativeHeaderToolbarMenu.displayName = "NativeHeaderToolbarMenu";

function NativeHeaderToolbarMenuAction(_props: {
  readonly children?: ReactNode;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly discoverabilityLabel?: string;
  readonly icon?: string;
  readonly isOn?: boolean;
  readonly onPress?: () => void;
  readonly subtitle?: string;
}) {
  return null;
}
NativeHeaderToolbarMenuAction.displayName = "NativeHeaderToolbarMenuAction";

function NativeHeaderToolbarLabel(_props: { readonly children?: ReactNode }) {
  return null;
}
NativeHeaderToolbarLabel.displayName = "NativeHeaderToolbarLabel";

function NativeHeaderToolbarSpacer(_props: {
  readonly flexible?: boolean;
  readonly sharesBackground?: boolean;
  readonly width?: number;
}) {
  return null;
}
NativeHeaderToolbarSpacer.displayName = "NativeHeaderToolbarSpacer";

function NativeHeaderToolbarSearchBarSlot() {
  return null;
}
NativeHeaderToolbarSearchBarSlot.displayName = "NativeHeaderToolbarSearchBarSlot";

export const NativeHeaderToolbar = Object.assign(NativeHeaderToolbarRoot, {
  Button: NativeHeaderToolbarButton,
  Label: NativeHeaderToolbarLabel,
  Menu: Object.assign(NativeHeaderToolbarMenu, {
    Action: NativeHeaderToolbarMenuAction,
  }),
  MenuAction: NativeHeaderToolbarMenuAction,
  SearchBarSlot: NativeHeaderToolbarSearchBarSlot,
  Spacer: NativeHeaderToolbarSpacer,
});
