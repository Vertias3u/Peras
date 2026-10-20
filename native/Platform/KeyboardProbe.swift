import AppKit
import ApplicationServices

// Explicit own-app diagnostic for first-open keyboard focus. Escape is posted into Peras's own
// event queue (NSApp.postEvent), so it passes the same monitors and responders a key press does
// but can never reach another app. No system-wide events, typed text or screenshots.
// The first Escape lands while the cold open is still finishing (before didShow), the second
// after it; a key pressed before macOS has activated Peras goes to the app in front, by design.
enum KeyboardProbe {
  static func run(delegate: AppDelegate) {
    // Sub-modes share this file's own-queue rules: --race-only (first cold open, one early Escape) and
    // --ax-export (in-process accessibility tree, Tab walk and allowlisted VoiceOver presses).
    if delegate.options.contains("--race-only") { KeyboardRace.run(delegate: delegate); return }
    if delegate.options.contains("--ax-export") { AccessibilityAudit(delegate: delegate).start(); return }
    guard let desktop = delegate.desktop else { return }
    let me = ProcessInfo.processInfo.processIdentifier
    let before = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let started = ProcessInfo.processInfo.systemUptime
    var evidence: [String: Any] = ["otherAppFrontmostBefore": before != nil && before != me]
    var timeline = [[String: Any]](), passed = [String: Bool](), spaceChanges = 0
    var shows = 0, showsAtKey = [Int]()
    func front() -> Int32? { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    func mark(_ event: String, _ fields: [String: Any] = [:]) {
      var row = fields
      row["event"] = event; row["ms"] = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
      row["shown"] = delegate.popover.isShown; row["active"] = NSApp.isActive
      row["keyIsMenu"] = NSApp.keyWindow != nil && NSApp.keyWindow === desktop.activeWindow
      timeline.append(row)
    }
    let spaces = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in spaceChanges += 1 }
    // Seen only when it runs before the menu's own monitor, which consumes Escape.
    let keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
      mark("keyDown", ["escape": event.keyCode == 53, "toMenu": event.window != nil && event.window === desktop.activeWindow])
      return event
    }
    // Monitors run in no guaranteed order, so the menu's own Escape handler is where a press is counted.
    let close = desktop.onCloseAttached
    desktop.onCloseAttached = { showsAtKey.append(shows); mark("escapeHandled", ["didShowsSoFar": shows]); close?() }
    let popoverEvents = [NSPopover.didShowNotification, NSPopover.didCloseNotification].map { name in
      NotificationCenter.default.addObserver(forName: name, object: delegate.popover, queue: .main) { note in
        if note.name == NSPopover.didShowNotification { shows += 1 }
        mark(note.name.rawValue)
      }
    }
    func escape(_ window: NSWindow?) {
      guard let window, let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) else { return }
      mark("postEscape", ["toMenu": window === desktop.activeWindow])
      NSApp.postEvent(event, atStart: false)
    }
    // Polls until `condition` holds (or `seconds` pass), then lets queued work settle.
    func wait(_ seconds: Double = 2, until condition: @escaping () -> Bool, then next: @escaping () -> Void) {
      let end = ProcessInfo.processInfo.systemUptime + seconds
      func poll() { condition() || ProcessInfo.processInfo.systemUptime >= end ? delegate.later(0.15, next) : delegate.later(0.02, poll) }
      poll()
    }
    let menuOpen = { delegate.popover.isShown && desktop.activeWindow?.isKeyWindow == true }
    let handedBack = { !delegate.popover.isShown && desktop.panel?.isVisible != true && !NSApp.isActive && (before == nil || front() == before) }
    func openState(_ name: String) -> Bool {
      let window = desktop.activeWindow
      let state: [String: Any] = ["shown": delegate.popover.isShown, "appActive": NSApp.isActive, "windowKey": window?.isKeyWindow == true,
        "firstResponderInMenu": window != nil && (window?.firstResponder === window || (window?.firstResponder as? NSView)?.window === window),
        "frontmostIsPeras": front() == me, "onActiveSpace": window?.isOnActiveSpace == true]
      evidence[name] = state; mark(name)
      return state.values.allSatisfy { $0 as? Bool == true }
    }
    func closedState(_ name: String) -> Bool {
      let state: [String: Any] = ["closed": !delegate.popover.isShown && desktop.panel?.isVisible != true, "appInactive": !NSApp.isActive,
        "focusReturned": before == nil || front() == before]
      evidence[name] = state; mark(name)
      return state.values.allSatisfy { $0 as? Bool == true }
    }
    func finish() {
      passed["noSpaceChanges"] = spaceChanges == 0
      NSWorkspace.shared.notificationCenter.removeObserver(spaces)
      if let keys { NSEvent.removeMonitor(keys) }
      desktop.onCloseAttached = close
      popoverEvents.forEach(NotificationCenter.default.removeObserver)
      evidence["checks"] = passed
      evidence["timeline"] = timeline
      evidence["allChecksPassed"] = !passed.isEmpty && passed.values.allSatisfy { $0 }
      evidence["method"] = "Opened through the status item's toggle(); Escape is an NSEvent posted to Peras's own queue with NSApp.postEvent, reaching the same local monitor and responder chain as a key press. Not a physical keyboard: no system-wide event is synthesized."
      delegate.probe.write(evidence, name: "keyboard-probe")
      NSApp.terminate(nil)
    }
    delegate.toggle()
    wait(until: menuOpen) {
      passed["firstOpenTakesKeyboard"] = openState("firstOpen")
      escape(desktop.activeWindow)
      wait(until: handedBack) {
        passed["firstEscapeClosesAndHandsBack"] = closedState("afterFirstEscape")
        passed["firstEscapeArrivedBeforeDidShow"] = showsAtKey.first == 0
        delegate.toggle()
        wait(until: { menuOpen() && shows == 2 }) {
          passed["reopenTakesKeyboard"] = openState("reopen")
          let responder = desktop.activeWindow?.firstResponder
          evidence["reopenFirstResponder"] = responder.map { String(describing: type(of: $0)) } ?? "nil"
          passed["noControlFocusedOnOpen"] = responder === desktop.activeWindow
          escape(desktop.activeWindow)
          wait(until: handedBack) {
            passed["secondEscapeClosesAndHandsBack"] = closedState("afterSecondEscape")
            passed["secondEscapeArrivedAfterDidShow"] = showsAtKey.count == 2 && showsAtKey[1] == 2
            delegate.toggle()
            wait(until: menuOpen) {
              delegate.toggle()
              wait(until: handedBack) {
                passed["pearClickClosesAndHandsBack"] = closedState("afterPearClick")
                delegate.toggle()
                wait(until: menuOpen) {
                  desktop.pin()
                  wait(until: { desktop.panel?.isKeyWindow == true }) {
                    let panel = desktop.panel
                    passed["pinnedPanelTakesKeyboard"] = panel?.isVisible == true && panel?.isKeyWindow == true && NSApp.isActive && !delegate.popover.isShown
                    // A pinned panel closes on Escape like its close button: unpinned, focus handed back.
                    escape(panel)
                    wait(until: handedBack) {
                      passed["pinnedEscapeClosesAndHandsBack"] = closedState("afterPinnedEscape") && !desktop.pinned
                      _ = NativeSceneRuntime.openSettings()
                      wait(until: { delegate.auxiliary?.settings?.window?.isKeyWindow == true }) {
                        let settings = delegate.auxiliary?.settings?.window
                        let overFullScreen = settings.map(AppDelegate.overFullScreenApp) == true
                        evidence["settingsOverFullScreenApp"] = overFullScreen
                        passed["settingsKeyOnThisSpace"] = settings?.isKeyWindow == true && settings?.isOnActiveSpace == true && NSApp.isActive
                          && NSApp.activationPolicy() == (overFullScreen ? .accessory : .regular)
                        settings?.performClose(nil)
                        wait(until: handedBack) {
                          passed["settingsCloseHandsBack"] = closedState("afterSettingsClose") && NSApp.activationPolicy() == .accessory
                          finish()
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}

// Shared own-queue helpers for the keyboard sub-modes. Every key is an NSEvent posted to Peras's own
// queue for one of Peras's own windows; nothing is synthesized system-wide.
enum OwnKeys {
  static func post(_ window: NSWindow?, keyCode: UInt16, characters: String, modifiers: NSEvent.ModifierFlags = []) -> Bool {
    guard let window, let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
      characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode) else { return false }
    NSApp.postEvent(event, atStart: false)
    return true
  }
  // Polls until `condition` holds (or `seconds` pass), then lets queued work settle.
  static func wait(_ delegate: AppDelegate, _ seconds: Double = 2, step: Double = 0.02, settle: Double = 0.15,
    until condition: @escaping () -> Bool, then next: @escaping () -> Void) {
    let end = ProcessInfo.processInfo.systemUptime + seconds
    func poll() { condition() || ProcessInfo.processInfo.systemUptime >= end ? delegate.later(settle, next) : delegate.later(step, poll) }
    poll()
  }
}

// First cold open only: Escape is posted the moment the menu window is key (or at --escape-offset-ms
// after the toggle), then the probe waits for didShow and records whether the menu is still shown
// 1.5 s later. One fresh process per run; used to compare builds with and without the
// close-during-show fix.
enum KeyboardRace {
  static func run(delegate: AppDelegate) {
    guard let desktop = delegate.desktop else { return }
    let started = ProcessInfo.processInfo.systemUptime
    func ms() -> Double { ((ProcessInfo.processInfo.systemUptime - started) * 1000 * 10).rounded() / 10 }
    var timeline = [[String: Any]](), shows = 0, didShowMs: Double?, handledMs: Double?, postedMs: Double?, handledShows: Int?
    func mark(_ event: String) { timeline.append(["event": event, "ms": ms(), "shown": delegate.popover.isShown, "active": NSApp.isActive]) }
    let close = desktop.onCloseAttached
    desktop.onCloseAttached = { handledMs = ms(); handledShows = shows; mark("escapeHandled"); close?() }
    let observers = [NSPopover.didShowNotification, NSPopover.didCloseNotification].map { name in
      NotificationCenter.default.addObserver(forName: name, object: delegate.popover, queue: .main) { note in
        if note.name == NSPopover.didShowNotification { shows += 1; if didShowMs == nil { didShowMs = ms() } }
        mark(note.name.rawValue)
      }
    }
    let offset = delegate.options.value("--escape-offset-ms").flatMap(Double.init)
    func postEscape() {
      postedMs = ms(); mark("postEscape")
      if !OwnKeys.post(desktop.activeWindow, keyCode: 53, characters: "\u{1b}") { mark("postFailedNoWindow") }
    }
    mark("toggle")
    delegate.toggle()
    if let offset { delegate.later(offset / 1000, postEscape) }
    else { OwnKeys.wait(delegate, 3, step: 0.002, settle: 0, until: { delegate.popover.isShown && desktop.activeWindow?.isKeyWindow == true }, then: postEscape) }
    OwnKeys.wait(delegate, 4, settle: 1.5, until: { didShowMs != nil && postedMs != nil }) {
      mark("verdict")
      var row: [String: Any] = ["escapeOffsetMs": offset.map { $0 as Any } ?? NSNull(), "timeline": timeline,
        "postedMs": postedMs.map { $0 as Any } ?? NSNull(), "escapeHandledMs": handledMs.map { $0 as Any } ?? NSNull(),
        "didShowMs": didShowMs.map { $0 as Any } ?? NSNull(), "escapeHandledBeforeDidShow": handledShows == 0,
        "stillShown1500msAfterDidShow": delegate.popover.isShown, "appStillActive": NSApp.isActive,
        "method": "Fresh process, first cold open via toggle(); Escape posted to Peras's own queue with NSApp.postEvent. Not a physical keyboard."]
      if let handledMs, let didShowMs { row["handledMinusDidShowMs"] = handledMs - didShowMs }
      observers.forEach(NotificationCenter.default.removeObserver)
      desktop.onCloseAttached = close
      delegate.probe.write(row, name: "race-probe")
      NSApp.terminate(nil)
    }
  }
}

// --ax-export: Peras's accessibility tree as VoiceOver reads it. SwiftUI vends its elements only to an
// accessibility client, never to an in-process NSAccessibility walk, so the probe reads ITS OWN pid
// through the AX client API. Same-process AX calls are answered in process on the calling thread, so
// every read and press runs on the main thread (SwiftUI actions assert MainActor).
// Every read and press targets getpid() only; it runs only if this process is already trusted
// (AXIsProcessTrusted() without the prompt option, so it can never ask), i.e. when launched directly
// by a trusted shell (launch-built.mjs --direct). No system-wide events, no setting changes.
final class AccessibilityAudit {
  static let controls: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider",
    "AXTextField", "AXLink", "AXComboBox", "AXDisclosureTriangle", "AXSwitch", "AXRadioGroup", "AXIncrementor"]
  static let windowWidgets: Set<String> = ["AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton"]
  static let fixtureScenarios = ["normal-usage", "manual-pause", "missing-setup", "scoped-stop", "suggestion-pause", "daily-exhausted", "pacing-text", "weekly-recap"]
  // Exact names that may be pressed: the pin, unpin and Settings toolbar tabs. Nothing that sends a
  // backend command, opens a browser or a share sheet, or quits.
  static let pressable: Set<String> = ["Keep Peras open", "Unpin Peras", "General", "Notifications", "More"]
  let delegate: AppDelegate
  let desktop: DesktopCoordinator?
  let app = AXUIElementCreateApplication(getpid())
  var surfaces = [[String: Any]](), checks = [String: Bool](), notes = [String: Any]()
  init(delegate: AppDelegate) { self.delegate = delegate; desktop = delegate.desktop; AXUIElementSetMessagingTimeout(app, 2) }
  var store: FixtureStore { delegate.store }
  // MARK: AX client reads (main thread)
  static func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success ? value : nil
  }
  static func text(_ value: AnyObject?) -> String? {
    switch value {
    case let string as String: return string.isEmpty ? nil : string
    case let attributed as NSAttributedString: return attributed.string.isEmpty ? nil : attributed.string
    case let number as NSNumber: return number.stringValue
    default: return nil
    }
  }
  static func frame(_ e: AXUIElement) -> [Int] {
    var point = CGPoint.zero, size = CGSize.zero
    if let p = attr(e, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID() { AXValueGetValue(p as! AXValue, .cgPoint, &point) }
    if let s = attr(e, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() { AXValueGetValue(s as! AXValue, .cgSize, &size) }
    return [point.x, point.y, size.width, size.height].map { Int($0.rounded()) }
  }
  static func glyphOnly(_ string: String) -> Bool { !string.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) } }
  static func name(_ e: AXUIElement) -> String? { text(attr(e, kAXDescriptionAttribute)) ?? text(attr(e, kAXTitleAttribute)) }
  static func children(_ e: AXUIElement) -> [AXUIElement] { attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
  static func brief(_ e: AXUIElement?) -> [String: Any] {
    guard let e else { return ["none": true] }
    var row: [String: Any] = ["role": text(attr(e, kAXRoleAttribute)) ?? "", "frame": frame(e)]
    if let name = name(e) { row["name"] = name }
    if let value = text(attr(e, kAXValueAttribute)) { row["value"] = value }
    return row
  }
  // Depth-first over AXChildren: the order VoiceOver's VO-arrow navigation follows.
  static func tree(_ root: AXUIElement, surface: String) -> [String: Any] {
    var flat = [[String: Any]](), flags = [[String: Any]]()
    // The app's main menu bar is skipped: its Apple menu lists the user's Recent Items, which must
    // never land in evidence. Peras's own menu-bar item is the separate AXExtrasMenuBar.
    let mainMenu = attr(root, kAXMenuBarAttribute).map { $0 as! AXUIElement }
    func walk(_ e: AXUIElement, _ depth: Int, _ path: String) -> [String: Any] {
      let role = text(attr(e, kAXRoleAttribute)) ?? "", subrole = text(attr(e, kAXSubroleAttribute))
      let label = text(attr(e, kAXDescriptionAttribute)), title = text(attr(e, kAXTitleAttribute))
      let value = text(attr(e, kAXValueAttribute)), help = text(attr(e, kAXHelpAttribute))
      let enabled = (attr(e, kAXEnabledAttribute) as? Bool) ?? true
      var actionNames: CFArray?
      let actions = AXUIElementCopyActionNames(e, &actionNames) == .success ? (actionNames as? [String] ?? []) : []
      var node: [String: Any] = ["role": role, "path": path, "enabled": enabled, "frame": frame(e)]
      if let subrole { node["subrole"] = subrole }
      if let label { node["label"] = label }
      if let title { node["title"] = title }
      if let value { node["value"] = value }
      if let help { node["help"] = help }
      if let identifier = text(attr(e, kAXIdentifierAttribute)) { node["identifier"] = identifier }
      if let description = text(attr(e, kAXRoleDescriptionAttribute)) { node["roleDescription"] = description }
      if !actions.isEmpty { node["actions"] = actions }
      if (attr(e, kAXFocusedAttribute) as? Bool) == true { node["focused"] = true }
      let name = label ?? title ?? (role == "AXStaticText" ? value : nil)
      func flag(_ kind: String, _ extra: [String: Any] = [:]) {
        var row = extra; row["kind"] = kind; row["surface"] = surface; row["path"] = path; row["role"] = role
        if let name { row["name"] = name }
        if let help { row["help"] = help }
        flags.append(row)
      }
      let control = controls.contains(role) && !windowWidgets.contains(subrole ?? "")
      if role == "AXUnknown" { flag("unknown_role") }
      if control && label == nil && title == nil { flag(value == nil ? "unlabeled_control" : "control_named_only_by_value", value.map { ["value": $0] } ?? [:]) }
      if role == "AXImage" && label == nil && title == nil { flag("image_without_name_not_hidden") }
      if let name, glyphOnly(name) { flag("glyph_only_name") }
      if control && !enabled { flag("disabled_control") }
      if control, let help, help.count > 60 { flag("long_help_only_in_tooltip") }
      if role != "AXWindow", actions.contains(where: { $0.hasPrefix("AXShowMenu") }) && !actions.contains(where: { $0.hasPrefix("Name:") }) { flag("context_menu_only_actions") }
      if control || ["AXStaticText", "AXImage", "AXGroup", "AXTabGroup", "AXToolbar", "AXPopover", "AXWindow", "AXScrollArea"].contains(role) {
        var row: [String: Any] = ["order": flat.count, "role": role, "enabled": enabled, "depth": depth]
        if let subrole { row["subrole"] = subrole }
        if let name { row["name"] = name }
        if let value, value != name { row["value"] = value }
        if let help { row["help"] = help }
        let custom = actions.filter { $0.hasPrefix("Name:") }
        if !custom.isEmpty { row["customActions"] = custom }
        flat.append(row)
      }
      let kids = children(e).filter { child in mainMenu.map { !CFEqual($0, child) } ?? true }
      let built = depth < 40 ? kids.enumerated().map { walk($1, depth + 1, path + "/" + String($0)) } : []
      if !built.isEmpty { node["children"] = built }
      // A labelled container whose children stay exposed is read twice: once as the group, then each child.
      if ["AXGroup", "AXCell"].contains(role), let label, !built.isEmpty {
        let childNames = built.compactMap { ($0["label"] ?? $0["title"] ?? $0["value"]) as? String }
        if childNames.contains(where: { $0.count > 3 && label.contains($0) }) { flag("labelled_group_repeats_exposed_children", ["childNames": childNames]) }
      }
      return node
    }
    let built = walk(root, 0, surface)
    return ["surface": surface, "tree": built, "voiceOverOrder": flat, "flags": flags]
  }
  static func find(_ root: AXUIElement, name wanted: String, roles: Set<String>) -> AXUIElement? {
    func search(_ e: AXUIElement, _ depth: Int) -> AXUIElement? {
      if roles.contains(text(attr(e, kAXRoleAttribute)) ?? ""), name(e) == wanted { return e }
      guard depth < 40 else { return nil }
      for child in children(e) { if let hit = search(child, depth + 1) { return hit } }
      return nil
    }
    return search(root, 0)
  }
  // The windows Peras shows right now (menu popover, panel, Settings or Setup), as the client sees them.
  func visibleWindows() -> [AXUIElement] { Self.attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] }
  func onMain<T>(_ work: @escaping () -> T, then: @escaping (T) -> Void) {
    DispatchQueue.main.async { then(work()) }
  }
  // MARK: Surfaces
  // SwiftUI fills in a window's elements a moment after the first client request, so a surface whose
  // tree has no control yet is re-read (at most 6 times, 0.5 s apart); the attempt count is recorded.
  func capture(_ name: String, window: NSWindow?, attempt: Int = 1, completion: @escaping () -> Void) {
    onMain({ () -> [String: Any] in
      let windows = self.visibleWindows()
      var surface = Self.tree(self.app, surface: name)
      surface["axWindowCount"] = windows.count
      surface["readAttempts"] = attempt
      return surface
    }) { surface in
      let hasControl = (surface["voiceOverOrder"] as? [[String: Any]])?.contains { Self.controls.contains($0["role"] as? String ?? "") && $0["subrole"] == nil } == true
      if !hasControl && attempt < 6 { self.delegate.later(0.5) { self.capture(name, window: window, attempt: attempt + 1, completion: completion) }; return }
      var surface = surface
      if let window { surface["appKitWindow"] = ["title": window.title, "key": window.isKeyWindow, "onActiveSpace": window.isOnActiveSpace] }
      self.tabWalk(window, shift: false) { forward in
        self.tabWalk(window, shift: true) { backward in
          surface["tab"] = forward; surface["shiftTab"] = backward
          self.surfaces.append(surface)
          completion()
        }
      }
    }
  }
  // Tab / Shift-Tab posted to the window; after each, the app's AXFocusedUIElement is read.
  func tabWalk(_ window: NSWindow?, shift: Bool, completion: @escaping ([String: Any]) -> Void) {
    guard let window else { completion(["skipped": "no_window"]); return }
    var steps = [[String: Any]](), signatures = [String](), unchanged = 0
    func signature(_ row: [String: Any]) -> String { "\(row["role"] ?? "")|\(row["name"] ?? "")|\(row["frame"] ?? "")" }
    func focused(_ done: @escaping ([String: Any]) -> Void) {
      onMain({ Self.brief(Self.attr(self.app, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement }) }, then: done)
    }
    window.makeKeyAndOrderFront(nil)
    focused { start in
      func step() {
        guard steps.count < 30, unchanged < 4 else {
          let stops = Set(signatures + [signature(start)]).count
          completion(["shift": shift, "start": start, "steps": steps, "distinctFocusStops": stops,
            "wrapped": signatures.count > 1 && signatures.dropLast().contains(signatures.last!),
            "stoppedBecause": unchanged >= 4 ? "focus_unchanged_4_steps" : "step_cap"])
          return
        }
        _ = OwnKeys.post(window, keyCode: 48, characters: "\t", modifiers: shift ? [.shift] : [])
        self.delegate.later(0.08) {
          focused { row in
            let sig = signature(row)
            unchanged = sig == (signatures.last ?? signature(start)) ? unchanged + 1 : 0
            signatures.append(sig); steps.append(row)
            step()
          }
        }
      }
      step()
    }
  }
  func press(_ wanted: String, roles: Set<String> = ["AXButton", "AXRadioButton", "AXCheckBox"], attempt: Int = 1, completion: @escaping (Bool) -> Void) {
    guard Self.pressable.contains(wanted) else { completion(false); return }
    onMain({ () -> Bool? in
      guard let target = Self.find(self.app, name: wanted, roles: roles) else { return nil }
      var pid: pid_t = 0
      guard AXUIElementGetPid(target, &pid) == .success, pid == getpid() else { return false }
      return AXUIElementPerformAction(target, kAXPressAction as CFString) == .success
    }) { result in
      if result == nil && attempt < 6 { self.delegate.later(0.5) { self.press(wanted, roles: roles, attempt: attempt + 1, completion: completion) }; return }
      self.notes["press_" + wanted] = ["attempts": attempt, "found": result != nil, "accepted": result == true]
      completion(result == true)
    }
  }
  var menuOpen: Bool { delegate.popover.isShown && desktop?.activeWindow?.isKeyWindow == true }
  var closed: Bool { !delegate.popover.isShown && desktop?.panel?.isVisible != true }
  func start() {
    let trusted = AXIsProcessTrusted()
    notes["environment"] = ["fullKeyboardAccessEnabled": NSApp.isFullKeyboardAccessEnabled, "voiceOverEnabled": NSWorkspace.shared.isVoiceOverEnabled,
      "reduceMotion": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "increaseContrast": NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast,
      "switchControlEnabled": NSWorkspace.shared.isSwitchControlEnabled, "fixtureMode": store.fixtureMode, "axClientTrusted": trusted,
      "note": "Read only. Tab reaches SwiftUI buttons, toggles and pickers only when the system Keyboard navigation setting is on; this probe never changes it."]
    guard trusted else {
      notes["allChecksPassed"] = false
      notes["failure"] = "ax_client_untrusted"
      notes["hint"] = "Launch with launch-built.mjs --direct from an already trusted shell; this probe never requests trust."
      delegate.probe.write(notes, name: "ax-audit"); NSApp.terminate(nil); return
    }
    var pid: pid_t = 0
    checks["axClientTargetsOwnPid"] = AXUIElementGetPid(app, &pid) == .success && pid == getpid()
    onMain({ () -> [String: Any]? in
      (Self.attr(self.app, "AXExtrasMenuBar")).map { Self.tree($0 as! AXUIElement, surface: "status-item") }
    }) { item in
      self.surfaces.append(item ?? ["surface": "status-item", "missing": true])
      // Warm-up: one full read, then a second for SwiftUI to start vending its elements.
      _ = Self.tree(self.app, surface: "warm-up")
      self.delegate.later(1) { self.scenario(0) }
    }
  }
  func scenario(_ index: Int) {
    let names = store.fixtureMode ? Self.fixtureScenarios : ["live"]
    guard index < names.count else { activation(); return }
    if store.fixtureMode {
      do { store.apply(try Snapshot.decode(Data(contentsOf: delegate.options.fixtureDirectory.appendingPathComponent(names[index] + ".json")))) }
      catch { surfaces.append(["surface": "menu-" + names[index], "missing": true, "reason": "fixture_decode_failed"]); scenario(index + 1); return }
    }
    delegate.open()
    OwnKeys.wait(delegate, until: { self.menuOpen }) {
      self.delegate.later(0.4) {
        self.capture("menu-" + names[index], window: self.desktop?.activeWindow) {
          self.delegate.close(reason: "ax_audit")
          OwnKeys.wait(self.delegate, until: { self.closed }) { self.scenario(index + 1) }
        }
      }
    }
  }
  // VoiceOver's VO-Space is an accessibility press; only the allowlisted names above are pressed.
  func activation() {
    if store.fixtureMode, let url = store.fixtures.first(where: { $0.deletingPathExtension().lastPathComponent == "normal-usage" }) { store.load(url) }
    delegate.open()
    OwnKeys.wait(delegate, until: { self.menuOpen }) {
      self.press("Keep Peras open") { pressed in
        self.checks["axPressKeepOpenAccepted"] = pressed
        OwnKeys.wait(self.delegate, until: { self.desktop?.panel?.isKeyWindow == true }) {
          let pinned = self.desktop?.pinned == true && self.desktop?.panel?.isVisible == true
          self.checks["axPressKeepOpenPinsPanel"] = pinned
          self.capture("pinned-panel", window: pinned ? self.desktop?.panel : nil) {
            guard pinned else { self.checks["axPressUnpinReturnsToMenu"] = false; self.notes["unpinSkipped"] = "panel was never pinned"; self.commandComma(); return }
            self.press("Unpin Peras") { pressed in
              OwnKeys.wait(self.delegate, until: { self.menuOpen }) {
                self.checks["axPressUnpinReturnsToMenu"] = pressed && self.desktop?.pinned == false && self.delegate.popover.isShown
                self.commandComma()
              }
            }
          }
        }
      }
    }
  }
  func commandComma() {
    let open = { self.menuOpen }
    OwnKeys.wait(delegate, until: open) {
      let posted = OwnKeys.post(self.desktop?.activeWindow, keyCode: 43, characters: ",", modifiers: [.command])
      OwnKeys.wait(self.delegate, until: { self.delegate.auxiliary?.settings?.window?.isKeyWindow == true }) {
        self.checks["commandCommaInMenuOpensSettings"] = posted && self.delegate.auxiliary?.settings?.window?.isKeyWindow == true
        if self.delegate.auxiliary?.settings == nil { _ = NativeSceneRuntime.openSettings() }
        self.settingsPages(["general", "notifications", "more"]) { self.setup() }
      }
    }
  }
  func settingsPages(_ pages: [String], completion: @escaping () -> Void) {
    guard let page = pages.first else { completion(); return }
    let window = delegate.auxiliary?.settings?.window
    let label = SettingsTabs.tabs.first { $0.0 == page }?.1 ?? page
    // Starting on General: pressing General is a no-op, so its selection is checked, not caused.
    press(label) { pressed in
      OwnKeys.wait(self.delegate, until: { self.store.settingsSelectedTab == page }) {
        self.checks["axPressSettingsTab_\(page)"] = pressed && self.store.settingsSelectedTab == page
        self.delegate.later(0.3) {
          self.capture("settings-" + page, window: window) { self.settingsPages(Array(pages.dropFirst()), completion: completion) }
        }
      }
    }
  }
  func setup() {
    delegate.auxiliary?.settings?.window?.performClose(nil)
    delegate.auxiliary?.showSetup()
    OwnKeys.wait(delegate, until: { self.delegate.auxiliary?.setup?.window?.isKeyWindow == true }) {
      self.delegate.later(0.3) {
        self.capture("setup", window: self.delegate.auxiliary?.setup?.window) {
          self.delegate.auxiliary?.setup?.window?.performClose(nil)
          self.delegate.later(0.3) { self.finish() }
        }
      }
    }
  }
  func finish() {
    let flags = surfaces.flatMap { $0["flags"] as? [[String: Any]] ?? [] }
    var counts = [String: Int]()
    for flag in flags { counts[flag["kind"] as? String ?? "?", default: 0] += 1 }
    let controlsSeen = surfaces.reduce(0) { $0 + (($1["voiceOverOrder"] as? [[String: Any]])?.filter { Self.controls.contains($0["role"] as? String ?? "") }.count ?? 0) }
    checks["swiftUIControlsVended"] = controlsSeen > 10
    notes["checks"] = checks
    notes["allChecksPassed"] = !checks.isEmpty && checks.values.allSatisfy { $0 }
    notes["flagCounts"] = counts
    notes["controlsSeen"] = controlsSeen
    notes["surfaces"] = surfaces
    notes["method"] = "AX client API on Peras's own pid only (AXUIElementCreateApplication(getpid())), answered in process on the main thread: the tree VoiceOver reads. Tab/Shift-Tab and ⌘, are NSEvents posted to Peras's own windows with NSApp.postEvent; presses are kAXPress on exact allowlisted names (pin, unpin, Settings tabs) after a pid check. Requires the trust the owner already granted the launching shell; never prompts."
    notes["limitations"] = ["Not VoiceOver speech: VoiceOver may merge, reorder or reword elements.", "Tab results depend on the system Keyboard navigation setting recorded under environment.", "Fixture mode disables backend actions, so their enabled state reads false there."]
    delegate.probe.write(notes, name: "ax-audit")
    NSApp.terminate(nil)
  }
}
