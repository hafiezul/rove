#pragma once

#include "RoveMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using RoveMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<RoveMarkdownTextShadowNode>;

void RoveMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
