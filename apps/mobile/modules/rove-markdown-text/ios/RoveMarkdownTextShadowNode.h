#pragma once

#include <react/renderer/components/RoveMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/RoveMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char RoveMarkdownTextComponentName[];

struct RoveMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct RoveMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
  /// Recolor the loaded image with the run's foreground color, like `sf:` symbols.
  bool tintWithForeground;
  Float chipWidth = 0;
  Float chipHeight = 0;
};

inline Float RoveMarkdownTextAttachmentSize(const RoveMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float RoveMarkdownTextAttachmentBaselineOffset(
    const RoveMarkdownTextAttachmentRange &) {
  return -2;
}

class RoveMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<RoveMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<RoveMarkdownTextAttachmentRange> attachmentRanges;
};

class RoveMarkdownTextShadowNode final : public ConcreteViewShadowNode<
RoveMarkdownTextComponentName,
RoveMarkdownTextProps,
RoveMarkdownTextEventEmitter,
RoveMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  RoveMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<RoveMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<RoveMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
