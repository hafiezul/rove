import { useEffect, useState } from "react";

import { usePanelNavigationSuppression } from "~/panelAnimations";

/**
 * Tells which ids arrived after a scope (a thread) opened. Ids present while the
 * scope's first frames paint are restored state and should render in place; later
 * arrivals may animate in.
 */
export function useArrivedAfterOpen(
  ids: ReadonlyArray<string>,
  scopeKey: string,
): (id: string) => boolean {
  const suppressed = usePanelNavigationSuppression(scopeKey);
  const [restored, setRestored] = useState(() => ({ scopeKey, ids: new Set(ids) }));
  const idsKey = ids.join("\n");

  useEffect(() => {
    if (!suppressed) return;
    const nextIds = idsKey === "" ? [] : idsKey.split("\n");
    setRestored((current) => {
      const sameScope = current.scopeKey === scopeKey;
      if (sameScope && nextIds.every((id) => current.ids.has(id))) return current;
      return { scopeKey, ids: new Set([...(sameScope ? current.ids : []), ...nextIds]) };
    });
  }, [idsKey, scopeKey, suppressed]);

  return (id) => !suppressed && restored.scopeKey === scopeKey && !restored.ids.has(id);
}
