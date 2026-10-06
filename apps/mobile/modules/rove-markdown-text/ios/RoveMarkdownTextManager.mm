#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface RoveMarkdownTextManager : RCTViewManager
@end

@implementation RoveMarkdownTextManager

RCT_EXPORT_MODULE(RoveMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface RoveMarkdownTextRunManager : RCTViewManager
@end

@implementation RoveMarkdownTextRunManager

RCT_EXPORT_MODULE(RoveMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
