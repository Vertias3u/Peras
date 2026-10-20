import AppKit
import Carbon

struct DesktopPreferences: Codable {
  var shortcutEnabled = true
  var shortcutChoice = 0
  var frame: [Double]?
  // nil until Peras first applies its default; then the person's choice, never reapplied.
  var openAtLogin: Bool?
}

enum DesktopGeometry {
  static func clamp(_ proposed: NSRect, screens: [NSRect]) -> NSRect {
    guard !screens.isEmpty else { return proposed }
    let screen = screens.max { a, b in
      a.intersection(proposed).area < b.intersection(proposed).area
    }!
    let width = min(max(240, proposed.width), screen.width)
    let height = min(max(200, proposed.height), screen.height)
    return NSRect(x: min(max(proposed.minX, screen.minX), screen.maxX - width),
      y: min(max(proposed.minY, screen.minY), screen.maxY - height), width: width, height: height)
  }
}
private extension NSRect {
  var area: CGFloat { isNull ? 0 : max(0, width) * max(0, height) }
}

// Carbon receives only the registered shortcut, without Accessibility or a typing monitor.
final class DesktopHotKey {
  var action: (() -> Void)?
  private var hotKey: EventHotKeyRef?
  private var handler: EventHandlerRef?
  func register(choice: Int, enabled: Bool) -> OSStatus {
    unregister()
    guard enabled else { return noErr }
    var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    let install = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
      guard let context, let event else { return OSStatus(eventNotHandledErr) }
      var identifier = EventHotKeyID()
      guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
        nil, MemoryLayout<EventHotKeyID>.size, nil, &identifier) == noErr,
        identifier.signature == 0x50524153, identifier.id == 1 else { return OSStatus(eventNotHandledErr) }
      Unmanaged<DesktopHotKey>.fromOpaque(context).takeUnretainedValue().action?()
      return noErr
    }, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &handler)
    guard install == noErr else { return install }
    let modifiers = UInt32(controlKey | optionKey | (choice == 1 ? shiftKey : 0))
    let status = RegisterEventHotKey(UInt32(kVK_ANSI_P), modifiers,
      EventHotKeyID(signature: 0x50524153, id: 1), GetApplicationEventTarget(), 0, &hotKey)
    if status != noErr { unregister() }
    return status
  }
  var registered: Bool { hotKey != nil }
  func unregister() {
    if let hotKey { UnregisterEventHotKey(hotKey) }
    if let handler { RemoveEventHandler(handler) }
    hotKey = nil
    handler = nil
  }
  deinit { unregister() }
}

// When the attached menu asks for activation and the keyboard. On the desktop: before it shows, so a
// cold first open's early Escape reaches a key menu. Over another app's full-screen Space: only after
// didShow, because macOS revokes an activation that arrives while the popover is still showing there
// and the transient popover then closes on resign (each ⌃⌥P flashed the menu and lost it).
enum MenuActivation: Equatable {
  case beforeShow, afterDidShow
  static func timing(overFullScreen: Bool) -> MenuActivation { overFullScreen ? .afterDidShow : .beforeShow }
}

// One retained controller/view tree moves between the popover and a normal-level panel.
// The store, pending commands, disclosures and sprite actors never move or get recreated.
final class DesktopCoordinator: NSObject, NSWindowDelegate {
  let popover: NSPopover
  let controller: PopoverController
  let store: FixtureStore
  let hotKey = DesktopHotKey()
  private(set) var panel: NSPanel?
  private(set) var pinned = false
  var onOpenAttached: (() -> Void)?
  var onVisibility: (() -> Void)?
  var onCloseAttached: (() -> Void)?
  // True between popover.show and didShow; NSPopover ignores close() in that window.
  var popoverShowing: () -> Bool = { false }
  private(set) var pinWhenShown = false
  private let settingsURL: URL
  private var preferences: DesktopPreferences
  private var writeTask: DispatchWorkItem?
  private var keyMonitor: Any?
  private var transferring = false
  init(popover: NSPopover, controller: PopoverController, store: FixtureStore, root: URL) {
    self.popover = popover
    self.controller = controller
    self.store = store
    settingsURL = root.appendingPathComponent("native/desktop.json")
    preferences = (try? Data(contentsOf: settingsURL)).flatMap { try? JSONDecoder().decode(DesktopPreferences.self, from: $0) } ?? DesktopPreferences()
    super.init()
    store.shortcutEnabled = preferences.shortcutEnabled
    store.shortcutChoice = preferences.shortcutChoice == 1 ? 1 : 0
    store.onPin = { [weak self] in self?.togglePin() }
    store.onShortcutChange = { [weak self] in self?.configureShortcut() }
    store.onOpenAtLoginChange = { [weak self] on in self?.setOpenAtLogin(on) }
    store.onRefreshLoginItem = { [weak self] in self?.refreshLoginItem() }
    refreshLoginItem()
    hotKey.action = { [weak self] in self?.focus() }
    configureShortcut(persist: false)
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
      guard let self, event.window === self.activeWindow else { return event }
      if event.keyCode == 53 && !self.pinned { self.onCloseAttached?(); return nil }
      if event.keyCode == 48 && event.modifierFlags.intersection([.command, .control, .option]).isEmpty {
        if event.modifierFlags.contains(.shift) { event.window?.selectPreviousKeyView(nil) }
        else { event.window?.selectNextKeyView(nil) }
        return nil
      }
      return event
    }
    NotificationCenter.default.addObserver(self, selector: #selector(screensChanged), name: NSApplication.didChangeScreenParametersNotification, object: nil)
  }
  var activeWindow: NSWindow? { pinned ? panel : controller.view.window }
  var visible: Bool {
    (pinned ? panel?.isVisible == true : popover.isShown) && activeWindow?.isVisible == true
      && activeWindow?.occlusionState.contains(.visible) == true
  }
  func configureShortcut(persist: Bool = true) {
    let status = hotKey.register(choice: store.shortcutChoice, enabled: store.shortcutEnabled)
    store.shortcutMessage = !store.shortcutEnabled ? "Shortcut disabled."
      : status == noErr ? "Shortcut registered · opens or focuses Peras."
      : "Shortcut unavailable or already in use. Choose the other shortcut or disable it."
    preferences.shortcutEnabled = store.shortcutEnabled
    preferences.shortcutChoice = store.shortcutChoice
    if persist { scheduleWrite() }
  }
  func refreshLoginItem() {
    let state = LoginItem.state
    store.openAtLogin = state == .on || state == .needsApproval
    store.loginItemNote = state == .needsApproval ? "Allow Peras in System Settings › General › Login Items."
      : state == .unavailable ? "Development builds never change your login items." : nil
  }
  private func setOpenAtLogin(_ on: Bool) {
    let changed = LoginItem.set(on)
    preferences.openAtLogin = on
    scheduleWrite()
    refreshLoginItem()
    if !changed && LoginItem.state != .unavailable { store.loginItemNote = "Peras couldn’t change this. Try System Settings › General › Login Items." }
  }
  /// On by default, once, after the installation checks out; a choice the person made is kept.
  func applyLoginDefault() {
    guard preferences.openAtLogin == nil, LoginItem.state != .unavailable else { return }
    if LoginItem.state == .on || LoginItem.set(true) { preferences.openAtLogin = true; scheduleWrite() }
    refreshLoginItem()
  }
  func focus() {
    if pinned {
      NSApp.activate(ignoringOtherApps: true)
      panel?.makeKeyAndOrderFront(nil)
      onVisibility?()
    } else { onOpenAttached?() }
  }
  func togglePin() {
    if pinned { unpin() } else { pin() }
  }
  func pin(anchorUnavailable: Bool = false) {
    guard !pinned else { focus(); return }
    // A pin pressed while the popover is still showing waits for didShow. Over a full-screen app the
    // panel's activation would be revoked then (a titled panel that never takes focus), and NSPopover
    // ignores close() mid-show, which can leave its window up with nothing but the material.
    if popoverShowing() { pinWhenShown = true; return }
    pinWhenShown = false
    store.desktopMessage = anchorUnavailable
      ? "Menu-bar anchor is unavailable. Peras is open in a panel; Unpin will reattach when the anchor is available." : nil
    transferring = true
    let responder = retainedResponder()
    // A host transfer must finish closing its old interactive surface synchronously.
    popover.animates = false
    popover.close()
    popover.contentViewController = nil
    let panel = self.panel ?? makePanel()
    self.panel = panel
    panel.contentViewController = controller
    pinned = true
    store.desktopPinned = true
    panel.setFrame(clampedFrame(), display: false)
    NSApp.activate(ignoringOtherApps: true)
    panel.makeKeyAndOrderFront(nil)
    if let responder { panel.makeFirstResponder(responder) }
    transferring = false
    fitMenu(height: store.menuContentHeight)
    onVisibility?()
  }
  // Called from popoverDidShow; true when a deferred pin took over.
  func popoverDidShow() -> Bool {
    guard pinWhenShown else { return false }
    pinWhenShown = false
    pin()
    return true
  }
  func cancelPinWhenShown() { pinWhenShown = false }
  func unpin() {
    guard pinned else { return }
    transferring = true
    popover.animates = false
    let responder = retainedResponder()
    rememberFrame()
    panel?.orderOut(nil)
    panel?.contentViewController = nil
    popover.contentViewController = controller
    pinned = false
    store.desktopPinned = false
    store.desktopMessage = nil
    // Keep presentation synchronous until the shared host has reattached.
    // onOpenAttached handles hidden/absent anchors by restoring the one panel.
    onOpenAttached?()
    transferring = false
    popover.animates = !store.reduced
    if let responder { activeWindow?.makeFirstResponder(responder) }
    onVisibility?()
  }
  func retainedResponder() -> NSView? {
    guard let responder = activeWindow?.firstResponder as? NSView,
      responder === controller.view || responder.isDescendant(of: controller.view) else { return nil }
    return responder
  }
  private func makePanel() -> NSPanel {
    let panel = NSPanel(contentRect: NSRect(x: 100, y: 100, width: 320, height: 350),
      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    panel.title = "Peras"
    panel.level = .normal
    panel.collectionBehavior = []
    panel.isFloatingPanel = false
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.delegate = self
    panel.minSize = NSSize(width: 320, height: 180)
    panel.maxSize = NSSize(width: 320, height: CGFloat.greatestFiniteMagnitude)
    return panel
  }
  private func clampedFrame() -> NSRect {
    let saved = preferences.frame
    let rect: NSRect
    if let saved, saved.count == 4, saved.allSatisfy({ $0.isFinite }) {
      rect = NSRect(x: saved[0], y: saved[1], width: 320, height: store.menuContentHeight + 28)
    } else {
      let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 800, height: 600)
      rect = NSRect(x: screen.midX - 160, y: screen.midY - 175, width: 320, height: 350)
    }
    return DesktopGeometry.clamp(rect, screens: NSScreen.screens.map(\.visibleFrame))
  }
  func fitMenu(height: CGFloat, screen: NSScreen? = nil) {
    let available = screen ?? (pinned ? panel?.screen : controller.view.window?.screen) ?? NSScreen.main
    let limit = max(1, (available?.visibleFrame.height ?? 700) - 28)
    let viewport = min(height, limit)
    if abs(store.menuViewportHeight - viewport) > 0.5 { store.menuViewportHeight = viewport }
    let size = NSSize(width: 320, height: viewport)
    controller.view.setFrameSize(size)
    popover.contentSize = size
    popover.animates = !store.reduced && !transferring
    if pinned, let panel {
      let dimensions = panel.frameRect(forContentRect: NSRect(origin: .zero, size: size))
      let frame = NSRect(x: panel.frame.minX, y: panel.frame.maxY - dimensions.height, width: dimensions.width, height: dimensions.height)
      let clamped = DesktopGeometry.clamp(frame, screens: NSScreen.screens.map(\.visibleFrame))
      if panel.isVisible && !store.reduced {
        NSAnimationContext.runAnimationGroup { context in context.duration = 0.18; panel.animator().setFrame(clamped, display: true) }
      } else { panel.setFrame(clamped, display: true) }
    }
  }
  @objc func screensChanged() {
    guard pinned, let panel else { return }
    panel.setFrame(DesktopGeometry.clamp(panel.frame, screens: NSScreen.screens.map(\.visibleFrame)), display: true)
    rememberFrame()
    onVisibility?()
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    guard sender === panel else { return true }
    rememberFrame()
    transferring = true
    panel?.orderOut(nil)
    panel?.contentViewController = nil
    popover.contentViewController = controller
    pinned = false
    store.desktopPinned = false
    transferring = false
    onVisibility?()
    // The panel only orders out, so no close notification reaches the menu-bar policy.
    DispatchQueue.main.async { AppDelegate.yieldIfIdle() }
    return false
  }
  func windowDidMove(_ notification: Notification) { if !transferring { rememberFrame() } }
  func windowDidResize(_ notification: Notification) {
    if !transferring {
      if pinned, let height = panel?.contentView?.bounds.height, abs(store.menuViewportHeight - height) > 0.5 { store.menuViewportHeight = height }
      rememberFrame()
    }
  }
  private func rememberFrame() {
    guard let panel else { return }
    preferences.frame = [panel.frame.minX, panel.frame.minY, panel.frame.width, panel.frame.height].map(Double.init)
    scheduleWrite()
  }
  private func scheduleWrite() {
    writeTask?.cancel()
    let task = DispatchWorkItem { [weak self] in self?.writePreferences() }
    writeTask = task
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: task)
  }
  private func writePreferences() {
    do {
      try FileManager.default.createDirectory(at: settingsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(preferences).write(to: settingsURL, options: .atomic)
    } catch { store.shortcutMessage = "Desktop settings could not be saved." }
  }
  func shutdown() {
    writeTask?.cancel()
    if writeTask != nil { writePreferences() }
    hotKey.unregister()
    if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
    keyMonitor = nil
  }
  deinit { NotificationCenter.default.removeObserver(self) }
}
