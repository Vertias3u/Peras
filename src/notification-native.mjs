// A native app owns the notification identity, icon and action callbacks.
export const notificationSource = String.raw`
#import <Cocoa/Cocoa.h>
#import <UserNotifications/UserNotifications.h>
@interface PerasSender : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate>
@property NSString *resultPath;
@property NSDictionary *request;
@end
@implementation PerasSender
- (void)finish:(NSDictionary *)result {
  if(self.resultPath){NSData *data=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];[data writeToFile:self.resultPath atomically:YES];}
  dispatch_async(dispatch_get_main_queue(),^{[NSApp terminate:nil];});
}
- (void)applicationDidFinishLaunching:(NSNotification *)note {
  UNUserNotificationCenter *center=UNUserNotificationCenter.currentNotificationCenter;
  center.delegate=self;
  UNNotificationAction *status=[UNNotificationAction actionWithIdentifier:@"PERAS_STATUS" title:@"Open Status" options:UNNotificationActionOptionForeground];
  UNNotificationAction *resume=[UNNotificationAction actionWithIdentifier:@"PERAS_RESUME" title:@"Resume for 1 hour" options:UNNotificationActionOptionForeground];
  UNNotificationAction *snooze=[UNNotificationAction actionWithIdentifier:@"PERAS_SNOOZE" title:@"Remind me in 1 hour" options:UNNotificationActionOptionForeground];
  NSSet *declaredCategories=[NSSet setWithArray:@[
    [UNNotificationCategory categoryWithIdentifier:@"PERAS_STATUS" actions:@[status] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone],
    [UNNotificationCategory categoryWithIdentifier:@"PERAS_PAUSE" actions:@[status,resume] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone],
    [UNNotificationCategory categoryWithIdentifier:@"PERAS_REMINDER" actions:@[status,snooze] intentIdentifiers:@[] options:UNNotificationCategoryOptionNone]]];
  [center setNotificationCategories:declaredCategories];
  NSMutableDictionary *declared=[NSMutableDictionary new];
  for(UNNotificationCategory *category in declaredCategories){NSMutableArray *ids=[NSMutableArray new];for(UNNotificationAction *action in category.actions)[ids addObject:action.identifier];declared[category.identifier]=ids;}
  NSArray *args=NSProcessInfo.processInfo.arguments;
  if(args.count<2){dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_main_queue(),^{[NSApp terminate:nil];});return;}
  NSString *file=args.lastObject;
  // Notification relaunches may retain argv after its one-shot request is gone.
  if(![NSFileManager.defaultManager fileExistsAtPath:file]){dispatch_after(dispatch_time(DISPATCH_TIME_NOW,10*NSEC_PER_SEC),dispatch_get_main_queue(),^{[NSApp terminate:nil];});return;}
  self.resultPath=[file stringByAppendingString:@".result"];
  NSData *data=[NSData dataWithContentsOfFile:file];self.request=data?[NSJSONSerialization JSONObjectWithData:data options:0 error:nil]:nil;
  if(!self.request){[self finish:@{@"error":@"Could not read notification request."}];return;}
  if([self.request[@"mode"] isEqual:@"inspect"]){
    [center getNotificationCategoriesWithCompletionHandler:^(NSSet<UNNotificationCategory *> *categories){
      NSMutableDictionary *actions=[NSMutableDictionary new];
      for(UNNotificationCategory *category in categories){NSMutableArray *ids=[NSMutableArray new];for(UNNotificationAction *action in category.actions)[ids addObject:action.identifier];actions[category.identifier]=ids;}
      [self finish:@{@"bundleIdentifier":NSBundle.mainBundle.bundleIdentifier?:@"",@"icon":[NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleIconFile"]?:@"",@"executable":NSBundle.mainBundle.executablePath?:@"",@"categories":actions,@"declaredCategories":declared}];
    }];return;
  }
  if([self.request[@"mode"] isEqual:@"action"]){[self performTicket:self.request[@"ticket"] action:self.request[@"action"] completion:^(BOOL ok){[self finish:@{@"actionHandled":@(ok)}];}];return;}
  [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL granted,NSError *error){
    if(!granted||error){[self finish:@{@"error":error.localizedDescription?:@"Allow Peras in System Settings > Notifications."}];return;}
    UNMutableNotificationContent *content=[UNMutableNotificationContent new];content.title=self.request[@"title"]?:@"Peras";content.body=self.request[@"body"]?:@"";
    NSString *category=self.request[@"category"];
    content.categoryIdentifier=[category isEqual:@"pause"]?@"PERAS_PAUSE":[category isEqual:@"reminder"]?@"PERAS_REMINDER":@"PERAS_STATUS";
    content.userInfo=@{@"ticket":self.request[@"ticket"]?:@""};
    UNNotificationRequest *request=[UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString content:content trigger:nil];
    [center addNotificationRequest:request withCompletionHandler:^(NSError *deliveryError){
      if(deliveryError){[self finish:@{@"error":deliveryError.localizedDescription}];return;}
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW,NSEC_PER_SEC),dispatch_get_main_queue(),^{[self finish:@{@"scheduled":@YES,@"bundleIdentifier":NSBundle.mainBundle.bundleIdentifier}];});
    }];
  }];
}
- (void)performTicket:(NSString *)ticket action:(NSString *)action completion:(void (^)(BOOL))completion {
  NSRegularExpression *uuid=[NSRegularExpression regularExpressionWithPattern:@"^[0-9a-fA-F-]{36}$" options:0 error:nil];
  NSSet *allowed=[NSSet setWithArray:@[@"PERAS_STATUS",@"PERAS_RESUME",@"PERAS_SNOOZE",UNNotificationDefaultActionIdentifier]];
  if(![ticket isKindOfClass:NSString.class]||[uuid numberOfMatchesInString:ticket options:0 range:NSMakeRange(0,ticket.length)]!=1||![allowed containsObject:action]){completion(NO);return;}
  NSURL *root=[NSBundle.mainBundle.bundleURL URLByDeletingLastPathComponent];
  NSString *file=[[[root URLByAppendingPathComponent:@"actions"] URLByAppendingPathComponent:[ticket stringByAppendingString:@".json"]] path];
  NSTask *task=[NSTask new];task.executableURL=[NSURL fileURLWithPath:[NSBundle.mainBundle objectForInfoDictionaryKey:@"PerasNodeExecutable"]];
  task.arguments=@[[NSBundle.mainBundle objectForInfoDictionaryKey:@"PerasActionScript"],file,action];
  task.terminationHandler=^(NSTask *finished){completion(finished.terminationStatus==0);};
  NSError *error=nil;if(![task launchAndReturnError:&error])completion(NO);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completionHandler {
  [self performTicket:response.notification.request.content.userInfo[@"ticket"] action:response.actionIdentifier completion:^(BOOL ok){completionHandler();dispatch_async(dispatch_get_main_queue(),^{[NSApp terminate:nil];});}];
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {completionHandler(UNNotificationPresentationOptionAlert);}
@end
int main(int argc,const char *argv[]){@autoreleasepool{NSApplication *app=NSApplication.sharedApplication;[app setActivationPolicy:NSApplicationActivationPolicyAccessory];PerasSender *sender=[PerasSender new];app.delegate=sender;UNUserNotificationCenter.currentNotificationCenter.delegate=sender;[app run];}return 0;}
`;
