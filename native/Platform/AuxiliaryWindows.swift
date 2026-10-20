import AppKit
import Combine
import SwiftUI

// Peras's windows open where you are: on the current Space, and over a full-screen app rather than
// sending you to the desktop Space (macOS keeps ordinary windows off full-screen Spaces).
enum PerasWindow {
  static let behavior: NSWindow.CollectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
}

final class AuxiliaryWindows {
  let store: FixtureStore
  private(set) var setup: NSWindowController?
  #if !PERAS_PRODUCTION
  private(set) var diagnostics: NSWindowController?
  #endif
  private(set) var settings: NSWindowController?
  init(store: FixtureStore) { self.store = store }
  // Peras's own Settings window: SwiftUI's Settings scene resets its window's Space options on every
  // open, so opening it over a full-screen app sent you to the desktop Space.
  func showSettings() {
    if settings == nil {
      let window = NSWindow(contentViewController: SettingsTabs(store: store))
      window.styleMask = [.titled, .closable, .miniaturizable]
      window.toolbarStyle = .preference
      window.collectionBehavior = PerasWindow.behavior
      window.isReleasedWhenClosed = false
      window.center()
      settings = NSWindowController(window: window)
    }
    focus(settings)
  }
  func showSetup() {
    if setup == nil { setup = makeWindow(title: "Set up Peras", root: SetupView(store: store)) }
    focus(setup)
  }
  #if !PERAS_PRODUCTION
  func showDiagnostics() {
    if diagnostics == nil {
      store.debugExpanded = true
      diagnostics = makeWindow(title: "Peras · Preview & diagnostics", root: DebugDisclosure(store: store).padding(20).frame(width: 520, height: 350))
    }
    focus(diagnostics)
  }
  #endif
  private func makeWindow<Root: View>(title: String, root: Root) -> NSWindowController {
    let host = NSHostingController(rootView: root)
    let window = NSWindow(contentViewController: host)
    window.title = title
    window.styleMask = [.titled, .closable, .miniaturizable]
    window.level = .normal
    window.collectionBehavior = PerasWindow.behavior
    window.isReleasedWhenClosed = false
    window.center()
    return NSWindowController(window: window)
  }
  private func focus(_ controller: NSWindowController?) { NSApp.activate(ignoringOtherApps: true); controller?.showWindow(nil); controller?.window?.makeKeyAndOrderFront(nil) }
}

// Settings' three tabs as a toolbar, the look of a SwiftUI Settings window. The selected tab follows
// store.settingsSelectedTab both ways.
final class SettingsTabs: NSTabViewController {
  static let tabs = [("general", "General", "gearshape"), ("notifications", "Notifications", "bell"), ("more", "More", "sparkles")]
  let store: FixtureStore
  private var selection: AnyCancellable?
  init(store: FixtureStore) {
    self.store = store
    super.init(nibName: nil, bundle: nil)
    tabStyle = .toolbar
    for (id, label, symbol) in Self.tabs {
      let page = NSHostingController(rootView: NativeSettingsView(store: store, tab: id))
      page.preferredContentSize = NativeSettingsView.size
      page.title = label
      let item = NSTabViewItem(viewController: page)
      item.identifier = id; item.label = label
      item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
      addTabViewItem(item)
    }
    selection = store.$settingsSelectedTab.removeDuplicates().sink { [weak self] id in
      guard let self, let index = Self.tabs.firstIndex(where: { $0.0 == id }), self.selectedTabViewItemIndex != index else { return }
      self.selectedTabViewItemIndex = index
    }
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
  override func tabView(_ tabView: NSTabView, didSelect item: NSTabViewItem?) {
    super.tabView(tabView, didSelect: item)
    if let id = item?.identifier as? String, store.settingsSelectedTab != id { store.settingsSelectedTab = id }
  }
}
