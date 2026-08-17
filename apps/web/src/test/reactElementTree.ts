import { isValidElement, type ReactElement } from "react";
import type { Json as SchemaJson } from "effect/Schema";

/**
 * Depth-first search over a React element tree produced by calling a component
 * as a plain function (see `reactHookHarness`). Descends through props so
 * render-prop and slot-style children are reachable. Returns the first element
 * the visitor accepts, or null.
 */
export function visitElements(
  node: unknown,
  visitor: (element: ReactElement<Record<string, SchemaJson>>) => boolean,
): ReactElement<Record<string, SchemaJson>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = visitElements(child, visitor);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<Record<string, SchemaJson>>(node)) return null;
  if (visitor(node)) return node;
  for (const value of Object.values(node.props)) {
    const found = visitElements(value, visitor);
    if (found) return found;
  }
  return null;
}
