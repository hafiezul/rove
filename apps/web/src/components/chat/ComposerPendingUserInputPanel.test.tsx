import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const USER_INPUT_REQUEST = ApprovalRequestId.make("dialog-select");
const APPROVAL_REQUEST = ApprovalRequestId.make("approval-1");

const pendingUserInput = {
  requestId: USER_INPUT_REQUEST,
  createdAt: "2026-07-18T00:00:00.000Z",
  questions: [
    {
      id: "dialog-select",
      header: "Choose environment",
      question: "Choose environment",
      options: [
        { label: "Staging", description: "Staging" },
        { label: "Production", description: "Production" },
      ],
      multiSelect: false,
    },
  ],
};

function renderPanel(respondingRequestIds: ApprovalRequestId[]) {
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={respondingRequestIds}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => {}}
      onAdvance={() => {}}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("keeps options selectable while no response is in flight", () => {
    const markup = renderPanel([]);

    expect(markup).toContain("Staging");
    expect(markup).toContain("Production");
    expect(markup).not.toContain("disabled");
  });

  it("disables options only while this request is being answered", () => {
    expect(renderPanel([USER_INPUT_REQUEST])).toContain("disabled");
  });

  it("keeps options selectable while an unrelated approval is in flight", () => {
    // Approvals and user input carry separate in-flight sets. Feeding the
    // approval set in here disabled every option of a question nobody had
    // answered yet, leaving the dialog unclickable.
    expect(renderPanel([APPROVAL_REQUEST])).not.toContain("disabled");
  });
});
