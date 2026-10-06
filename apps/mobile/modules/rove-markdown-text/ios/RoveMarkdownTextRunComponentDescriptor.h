#pragma once

#include "RoveMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using RoveMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<RoveMarkdownTextRunShadowNode>;

void RoveMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
