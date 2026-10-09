import type { Icon } from "@phosphor-icons/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/** The path an icon draws at its default weight, to assert which icon a component rendered. */
export function iconPath(icon: Icon): string {
  const path = /<path d="([^"]+)"/.exec(renderToStaticMarkup(createElement(icon)))?.[1];
  if (!path) throw new Error(`${icon.displayName ?? "Icon"} rendered no path`);
  return path;
}
