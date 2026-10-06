#pragma once

#include <react/renderer/components/RoveMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/RoveMarkdownTextSpec/Props.h>
#include <react/renderer/components/RoveMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char RoveMarkdownTextRunComponentName[];

using RoveMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    RoveMarkdownTextRunComponentName,
    RoveMarkdownTextRunProps,
    RoveMarkdownTextRunEventEmitter,
    RoveMarkdownTextRunState>;
}
