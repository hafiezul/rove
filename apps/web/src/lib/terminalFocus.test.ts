import { testDouble } from "~/testDouble";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { getTerminalFocusOwner, isTerminalFocused } from "./terminalFocus";

interface MockTerminalDataset {
  terminalOwner?: string;
}

class MockHTMLElement {
  isConnected = false;
  className = "";
  terminalOwner: string | null = null;
  readonly dataset: MockTerminalDataset = {};

  readonly classList = {
    contains: (value: string) => this.className.split(/\s+/).includes(value),
  };

  closest(selector: string): MockHTMLElement | null {
    if (!this.isConnected) {
      return null;
    }
    if (selector === "[data-terminal-owner]" && this.terminalOwner !== null) {
      return this;
    }
    return null;
  }
}

const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;

afterEach(() => {
  if (originalDocument === undefined) {
    // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }

  if (originalHTMLElement === undefined) {
    // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  } else {
    globalThis.HTMLElement = originalHTMLElement;
  }
});

describe("isTerminalFocused", () => {
  it("returns false for detached xterm helper textareas", () => {
    const detached = new MockHTMLElement();
    detached.className = "xterm-helper-textarea";

    // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    globalThis.HTMLElement = testDouble<typeof HTMLElement>(MockHTMLElement);
    globalThis.document = testDouble<Document>({ activeElement: detached });

    expect(isTerminalFocused()).toBe(false);
  });

  it("returns the drawer owner for connected xterm helper textareas", () => {
    const attached = new MockHTMLElement();
    attached.className = "xterm-helper-textarea";
    attached.isConnected = true;
    attached.terminalOwner = "drawer";
    attached.dataset.terminalOwner = "drawer";

    // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    globalThis.HTMLElement = testDouble<typeof HTMLElement>(MockHTMLElement);
    globalThis.document = testDouble<Document>({ activeElement: attached });

    expect(getTerminalFocusOwner()).toBe("drawer");
    expect(isTerminalFocused()).toBe(true);
  });

  it("returns the right panel owner for focus inside its terminal UI", () => {
    const sidebarButton = new MockHTMLElement();
    sidebarButton.className = "terminal-sidebar-button";
    sidebarButton.isConnected = true;
    sidebarButton.terminalOwner = "right-panel";
    sidebarButton.dataset.terminalOwner = "right-panel";

    // SAFETY: This fixture intentionally supplies the asserted collaborator contract.
    globalThis.HTMLElement = testDouble<typeof HTMLElement>(MockHTMLElement);
    globalThis.document = testDouble<Document>({ activeElement: sidebarButton });

    expect(getTerminalFocusOwner()).toBe("right-panel");
    expect(isTerminalFocused()).toBe(true);
  });
});
