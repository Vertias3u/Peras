import AppKit
import SwiftUI

// Prepared after the custom headless/root-lock preflight. This is the sole owner,
// not a second store, status item or backend client.
enum NativeSceneRuntime {
  static var owner: AppDelegate!
  @discardableResult static func openSettings() -> Bool {
    guard let auxiliary = owner.auxiliary else {
      owner.store.error = "Settings are not ready yet. Try again in a moment."
      return false
    }
    auxiliary.showSettings()
    return true
  }
}
final class SettingsLifecycleDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) { NativeSceneRuntime.owner.applicationDidFinishLaunching(notification) }
  func applicationWillTerminate(_ notification: Notification) { NativeSceneRuntime.owner.applicationWillTerminate(notification) }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    NativeSceneRuntime.owner.handleReopen()
    return false
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
struct PerasSettingsSceneApp: App {
  @NSApplicationDelegateAdaptor(SettingsLifecycleDelegate.self) private var lifecycle
  var body: some Scene {
    // Settings live in Peras's own window (AuxiliaryWindows.showSettings); ⌘, opens that one.
    Settings { EmptyView() }.commands {
      CommandGroup(replacing: .appSettings) { Button("Settings…") { NativeSceneRuntime.openSettings() }.keyboardShortcut(",") }
    }
  }
}

enum SettingsSceneEvidence { static weak var store: FixtureStore? }
