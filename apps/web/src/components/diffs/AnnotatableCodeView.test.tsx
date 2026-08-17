import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Json as SchemaJson } from "effect/Schema";

const testState = vi.hoisted(() => ({
  codeViewOptions: null as Record<string, SchemaJson> | null,
}));

vi.mock("@pierre/diffs/react", () => ({
  CodeView: (props: { options: Record<string, SchemaJson> }) => {
    testState.codeViewOptions = props.options;
    return null;
  },
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: Record<string, SchemaJson>) => unknown) =>
    selector({
      addReviewComment: vi.fn(),
      removeReviewComment: vi.fn(),
      getComposerDraft: () => undefined,
    }),
}));

vi.mock("./DiffCommentAnnotation", () => ({
  DiffCommentAnnotation: () => null,
}));

vi.mock("../files/fileCommentAnnotations", () => ({
  nextFileCommentId: () => "comment-test",
}));

import { AnnotatableCodeView } from "./AnnotatableCodeView";

describe("AnnotatableCodeView", () => {
  beforeEach(() => {
    testState.codeViewOptions = null;
  });

  it("opens comments from Pierre's gutter action without ending line selection", () => {
    renderToStaticMarkup(
      <AnnotatableCodeView
        codeViewKey="test-view"
        files={[]}
        sectionId="working-tree"
        sectionTitle="Working tree"
        composerDraftTarget={"draft-test" as never}
        options={{}}
        renderHeaderPrefix={() => null}
      />,
    );

    expect(testState.codeViewOptions).toMatchObject({
      enableGutterUtility: true,
      enableLineSelection: true,
      onGutterUtilityClick: expect.any(Function),
    });
    expect(testState.codeViewOptions).not.toHaveProperty("onLineSelectionEnd");
  });
});
