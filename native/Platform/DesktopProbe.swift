import AppKit

// Explicit own-app diagnostic. No screenshots, clipboard, simulated typing or global input.
enum DesktopProbe {
  static func run(delegate: AppDelegate) {
    if delegate.options.contains("--spaces") { SpacesProbe.run(delegate: delegate); return }
    if delegate.options.contains("--fullscreen") { FullScreenProbe.run(delegate: delegate); return }
    guard let desktop = delegate.desktop else { return }
    delegate.open()
    delegate.later(0.3) {
      duplicateFocus(delegate: delegate, pinned: false) { attached in
        desktop.pin()
        delegate.later(0.2) {
          duplicateFocus(delegate: delegate, pinned: true) { pinned in
            delegate.probe.write(["attached": attached, "pinned": pinned,
              "allChecksPassed": attached["ok"] as? Bool == true && pinned["ok"] as? Bool == true,
              "method": "Actual same-root executable processes post the unchanged distributed focus notification; no simulated input or bridge command."], name: "duplicate-focus-probe")
            desktop.unpin()
            runControls(delegate: delegate, duplicateChecksPassed: attached["ok"] as? Bool == true && pinned["ok"] as? Bool == true)
          }
        }
      }
    }
  }
  private static func duplicateFocus(delegate: AppDelegate, pinned: Bool, completion: @escaping ([String: Any]) -> Void) {
    guard let desktop = delegate.desktop else { completion(["ok": false, "failure": "no_desktop"]); return }
    let store = delegate.store
    let host = desktop.controller.host
    let bridge = store.bridge
    let bridgePID = delegate.bridgePID
    let count = delegate.receivedFocusCount
    let started = ProcessInfo.processInfo.systemUptime
    let child = Process()
    let output = delegate.probe.directory.appendingPathComponent(pinned ? "duplicate-pinned" : "duplicate-attached")
    child.executableURL = Bundle.main.executableURL
    child.environment = ProcessInfo.processInfo.environment
    child.arguments = ["--root", delegate.options.root, "--output", output.path]
    if let config = delegate.options.value("--bridge-config") { child.arguments! += ["--bridge-config", config] }
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    do { try child.run() }
    catch { completion(["ok": false, "failure": "duplicate_launch_failed"]); return }
    let pid = child.processIdentifier
    func poll() {
      let elapsed = ProcessInfo.processInfo.systemUptime - started
      let received = delegate.receivedFocusCount > count
      let window = desktop.activeWindow
      let surfaces = (delegate.popover.isShown ? 1 : 0) + (desktop.panel?.isVisible == true ? 1 : 0)
      let visible = window?.isVisible == true && window?.occlusionState.contains(.visible) == true
      if (!child.isRunning && received && visible) || elapsed >= 2 {
        let timedOut = child.isRunning
        if timedOut { child.terminate() }
        let receipt = output.appendingPathComponent("duplicate-\(pid).json")
        let raw = (try? Data(contentsOf: receipt)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let refusedDuplicate = raw?["acquired"] as? Bool == false
        let identity = delegate.store === store && desktop.controller.host === host
          && (bridge == nil ? store.bridge == nil : store.bridge === bridge && bridgePID != nil) && delegate.bridgePID == bridgePID
        let exited = !child.isRunning && child.terminationStatus == 0
        completion(["ok": exited && refusedDuplicate && received && visible && surfaces == 1 && desktop.pinned == pinned && identity,
          "duplicatePID": pid, "exitZero": exited, "rootLockRefusedDuplicate": refusedDuplicate,
          "receivedFocusBefore": count, "receivedFocusAfter": delegate.receivedFocusCount,
          "receivedActualNotification": received, "elapsedMs": elapsed * 1000, "timedOut": timedOut,
          "actualWindowVisibleUnoccluded": visible, "actualWindowKey": window?.isKeyWindow == true,
          "interactiveSurfaceCount": surfaces, "expectedPinned": pinned, "actualPinned": desktop.pinned,
          "ownedChildPIDObserved": bridge == nil || bridgePID != nil,
          "sharedStoreHostBridgeAndChild": identity, "bridgePIDBefore": bridgePID.map { $0 as Any } ?? NSNull(),
          "bridgePIDAfter": delegate.bridgePID.map { $0 as Any } ?? NSNull()])
        return
      }
      delegate.later(0.05, poll)
    }
    delegate.later(0.05, poll)
  }
  private static func runControls(delegate: AppDelegate, duplicateChecksPassed: Bool) {
    guard let desktop = delegate.desktop else { return }
    let store = delegate.store
    let controller = desktop.controller
    let host = controller.host
    let actors = store.actors
    let bridge = store.bridge
    store.settingsExpanded = true
    store.debugExpanded = true
    // A pending UI sentinel is observational only; no bridge command is sent.
    store.blockedProviders.insert("desktop-probe-sentinel")
    var evidence: [String: Any] = ["actualDuplicateFocusChecksPassed": duplicateChecksPassed]
    delegate.open()
    delegate.later(0.2) {
      let travel = actors.map(\.travel)
      let phase = store.logicalNow
      let focusedHostingRoot = desktop.activeWindow?.makeFirstResponder(host.view) == true
      let responder = desktop.retainedResponder()
      desktop.pin()
      evidence["sharedController"] = desktop.panel?.contentViewController === controller
      evidence["sharedHost"] = controller.host === host
      evidence["sharedBridgeIdentity"] = bridge == nil ? store.bridge == nil : store.bridge === bridge
      evidence["bridgePresent"] = bridge != nil
      evidence["sharedActors"] = zip(actors, store.actors).allSatisfy { $0 === $1 }
      evidence["phaseRetainedAtPin"] = phase == store.logicalNow && travel == actors.map(\.travel)
      evidence["oneSurfaceAtPin"] = desktop.panel?.isVisible == true && !delegate.popover.isShown
      evidence["normalPanel"] = desktop.panel?.level == .normal && desktop.panel?.isFloatingPanel == false
      evidence["noEverySpace"] = desktop.panel?.collectionBehavior.contains(.canJoinAllSpaces) == false
      evidence["pendingAndDisclosureRetained"] = store.blockedProviders.contains("desktop-probe-sentinel") && store.settingsExpanded && store.debugExpanded
      evidence["hostingRootAcceptedFocus"] = focusedHostingRoot
      evidence["responderRetainedAtPin"] = responder != nil && desktop.activeWindow?.firstResponder === responder
      desktop.focus()
      evidence["focusKeepsPanel"] = desktop.panel?.contentViewController === controller && !delegate.popover.isShown
      evidence["shortcutRegistered"] = desktop.hotKey.registered
      let contender = DesktopHotKey()
      let collision = contender.register(choice: store.shortcutChoice, enabled: store.shortcutEnabled)
      evidence["collisionReported"] = !store.shortcutEnabled || collision != noErr
      contender.unregister()
      desktop.hotKey.action?()
      evidence["shortcutCallbackKeepsOneSurface"] = desktop.pinned && !delegate.popover.isShown
      delegate.sleeping()
      let ticks = store.ticks
      let sleepPhase = store.logicalNow
      delegate.later(0.2) {
        evidence["sleepStopsInvisibleTicks"] = store.timer == nil && ticks == store.ticks
        delegate.waking()
        evidence["wakeDoesNotReplayBacklog"] = sleepPhase == store.logicalNow
        desktop.unpin()
        evidence["unpinSharedController"] = (delegate.popover.contentViewController === controller) || (desktop.pinned && desktop.panel?.contentViewController === controller)
        evidence["oneSurfaceAtUnpin"] = (delegate.popover.isShown ? 1 : 0) + (desktop.panel?.isVisible == true ? 1 : 0) == 1
        evidence["pendingAndDisclosureAfterUnpin"] = store.blockedProviders.contains("desktop-probe-sentinel") && store.settingsExpanded && store.debugExpanded
        evidence["responderRetainedAtUnpin"] = responder != nil && desktop.activeWindow?.firstResponder === responder
        desktop.pin()
        if let panel = desktop.panel { _ = desktop.windowShouldClose(panel) }
        evidence["closeReturnsMenuOnly"] = !desktop.pinned && desktop.panel?.isVisible != true && !delegate.popover.isShown && controller.view.window?.isVisible != true
        store.blockedProviders.remove("desktop-probe-sentinel")
        evidence["limitations"] = ["Actual keyboard activation and traversal, physical multi-display changes and real Spaces/fullscreen are not exercised by this callback probe."]
        evidence["allChecksPassed"] = evidence.filter { $0.key != "bridgePresent" }.values.compactMap { $0 as? Bool }.allSatisfy { $0 }
        delegate.probe.write(evidence, name: "desktop-probe")
        NSApp.terminate(nil)
      }
    }
  }
}

// --desktop-probe --spaces: Space and full-screen behaviour that can be exercised in process. A Space
// change is SIMULATED by posting activeSpaceDidChangeNotification to this process's own NSWorkspace
// notification centre (tagged in userInfo); the probe never switches Spaces, enters full screen or
// synthesizes input outside Peras. Real Space changes during the run are counted separately.
enum SpacesProbe {
  static let tag = "perasProbeSimulatedSpaceChange"
  static func run(delegate: AppDelegate) {
    guard let desktop = delegate.desktop else { return }
    let store = delegate.store
    let me = ProcessInfo.processInfo.processIdentifier
    let before = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var checks = [String: Bool](), evidence = [String: Any](), realSpaceChanges = 0, simulated = 0
    let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { note in
      if note.userInfo?[tag] as? Bool == true { simulated += 1 } else { realSpaceChanges += 1 }
    }
    func simulateSpaceChange() {
      NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.activeSpaceDidChangeNotification, object: NSWorkspace.shared, userInfo: [tag: true])
    }
    func front() -> Int32? { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    let menuOpen = { delegate.popover.isShown && desktop.activeWindow?.isKeyWindow == true }
    let handedBack = { !delegate.popover.isShown && desktop.panel?.isVisible != true && !NSApp.isActive && (before == nil || front() == before) }
    func windowState(_ window: NSWindow?) -> [String: Any] {
      guard let window else { return ["missing": true] }
      return ["visible": window.isVisible, "key": window.isKeyWindow, "onActiveSpace": window.isOnActiveSpace,
        "moveToActiveSpace": window.collectionBehavior.contains(.moveToActiveSpace), "fullScreenAuxiliary": window.collectionBehavior.contains(.fullScreenAuxiliary),
        "canJoinAllSpaces": window.collectionBehavior.contains(.canJoinAllSpaces), "level": window.level.rawValue,
        "overFullScreenAppNow": AppDelegate.overFullScreenApp(window), "activationPolicy": NSApp.activationPolicy().rawValue]
    }
    func finish() {
      checks["noRealSpaceChanges"] = realSpaceChanges == 0
      NSWorkspace.shared.notificationCenter.removeObserver(observer)
      evidence["checks"] = checks
      evidence["simulatedNotificationsPosted"] = simulated
      evidence["allChecksPassed"] = !checks.isEmpty && checks.values.allSatisfy { $0 }
      evidence["method"] = "Space changes are simulated in process (own NSWorkspace notification centre); Escape is posted to Peras's own queue. Full-screen state is only read from the current layout (overFullScreenApp), never created."
      evidence["limitations"] = ["A real Space switch, a real full-screen app and Mission Control are not exercised; they need the owner's hands."]
      delegate.probe.write(evidence, name: "spaces-probe")
      NSApp.terminate(nil)
    }
    delegate.toggle()
    OwnKeys.wait(delegate, until: menuOpen) {
      simulateSpaceChange()
      delegate.later(0.3) {
        checks["openMenuSurvivesSimulatedSpaceChange"] = delegate.popover.isShown && store.visible == desktop.visible
        _ = OwnKeys.post(desktop.activeWindow, keyCode: 53, characters: "\u{1b}")
        OwnKeys.wait(delegate, until: handedBack) {
          checks["escapeClosesAndHandsBack"] = handedBack()
          simulateSpaceChange()
          let ticks = store.ticks
          delegate.later(0.3) {
            checks["closedStaysHiddenAfterSimulatedSpaceChange"] = !store.visible && store.timer == nil && store.ticks == ticks && !delegate.popover.isShown
            delegate.toggle()
            OwnKeys.wait(delegate, until: menuOpen) {
              let window = desktop.activeWindow
              evidence["reopenedMenu"] = windowState(window)
              checks["reopenAfterSimulatedSpaceChangeTakesKeyboard"] = menuOpen() && window?.isOnActiveSpace == true && NSApp.isActive && store.visible
              desktop.pin()
              OwnKeys.wait(delegate, until: { desktop.panel?.isKeyWindow == true }) {
                simulateSpaceChange()
                delegate.later(0.3) {
                  evidence["pinnedPanel"] = windowState(desktop.panel)
                  checks["pinnedPanelSurvivesSimulatedSpaceChange"] = desktop.pinned && desktop.panel?.isVisible == true && store.visible == desktop.visible
                  checks["pinnedPanelStaysOnItsOwnSpace"] = desktop.panel?.collectionBehavior.contains(.canJoinAllSpaces) == false
                  if let panel = desktop.panel { _ = desktop.windowShouldClose(panel) }
                  OwnKeys.wait(delegate, until: handedBack) {
                    checks["pinnedCloseHandsBack"] = handedBack()
                    _ = NativeSceneRuntime.openSettings()
                    OwnKeys.wait(delegate, until: { delegate.auxiliary?.settings?.window?.isKeyWindow == true }) {
                      let settings = delegate.auxiliary?.settings?.window
                      let overFullScreen = settings.map(AppDelegate.overFullScreenApp) == true
                      evidence["settings"] = windowState(settings)
                      checks["settingsJoinsActiveAndFullScreenSpaces"] = settings?.collectionBehavior.contains(.moveToActiveSpace) == true && settings?.collectionBehavior.contains(.fullScreenAuxiliary) == true
                      checks["settingsPolicyMatchesFullScreenState"] = NSApp.activationPolicy() == (overFullScreen ? .accessory : .regular)
                      simulateSpaceChange()
                      delegate.later(0.3) {
                        checks["settingsStaysKeyAfterSimulatedSpaceChange"] = settings?.isKeyWindow == true && settings?.isVisible == true
                        settings?.performClose(nil)
                        OwnKeys.wait(delegate, until: handedBack) {
                          checks["settingsCloseReturnsToAccessory"] = handedBack() && NSApp.activationPolicy() == .accessory
                          delegate.auxiliary?.showSetup()
                          OwnKeys.wait(delegate, until: { delegate.auxiliary?.setup?.window?.isKeyWindow == true }) {
                            let setup = delegate.auxiliary?.setup?.window
                            evidence["setup"] = windowState(setup)
                            checks["setupJoinsActiveAndFullScreenSpaces"] = setup?.collectionBehavior.contains(.moveToActiveSpace) == true && setup?.collectionBehavior.contains(.fullScreenAuxiliary) == true
                            setup?.performClose(nil)
                            OwnKeys.wait(delegate, until: handedBack) {
                              checks["setupCloseReturnsToAccessory"] = handedBack() && NSApp.activationPolicy() == .accessory
                              evidence["frontmostWasPerasAtEnd"] = front() == me
                              // A pin pressed before didShow (NSPopover ignores close() then) waits for it.
                              delegate.toggle()
                              let showingAtPin = delegate.showing
                              store.onPin?()
                              OwnKeys.wait(delegate, until: { desktop.panel?.isKeyWindow == true && !delegate.popover.isShown }) {
                                let stray = NSApp.windows.filter { $0.isVisible && $0 !== desktop.panel && !$0.className.contains("StatusBar") }
                                evidence["pinDuringShow"] = ["showingAtPin": showingAtPin, "strayWindows": stray.map(\.className), "panel": windowState(desktop.panel)]
                                checks["pinDuringShowLeavesOnlyThePanel"] = showingAtPin && desktop.pinned && desktop.panel?.isKeyWindow == true && stray.isEmpty
                                if let panel = desktop.panel { _ = desktop.windowShouldClose(panel) }
                                OwnKeys.wait(delegate, until: handedBack) {
                                  checks["pinDuringShowCloseHandsBack"] = handedBack()
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
      }
    }
  }
}

// --desktop-probe --fullscreen: the global shortcut over ANOTHER app's full-screen Space. It needs a
// full-screen app already in front (the QA run opens a throwaway one); it never creates full screen,
// switches Spaces or registers the Carbon shortcut itself. Each "press" calls the exact closure the
// Carbon handler calls (desktop.hotKey.action), so activation starts from the full-screen app as it
// does for a real ⌃⌥P. Escape is posted to Peras's own queue. Evidence: every own window's AppKit and
// window-server state after each step.
enum FullScreenProbe {
  static let helperActivate = Notification.Name("eu.vertias.peras.qa.fullscreen.activate")
  static func run(delegate: AppDelegate) {
    guard let desktop = delegate.desktop else { return }
    let me = ProcessInfo.processInfo.processIdentifier
    var checks = [String: Bool](), evidence = [String: Any](), timeline = [[String: Any]]()
    var realSpaceChanges = 0, shows = 0, closes = 0
    let started = ProcessInfo.processInfo.systemUptime
    let spaces = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
      realSpaceChanges += 1
    }
    let popoverEvents = [NSPopover.didShowNotification, NSPopover.didCloseNotification].map { name in
      NotificationCenter.default.addObserver(forName: name, object: delegate.popover, queue: .main) { note in
        if note.name == NSPopover.didShowNotification { shows += 1 } else { closes += 1 }
      }
    }
    func front() -> Int32? { NSWorkspace.shared.frontmostApplication?.processIdentifier }
    let fullScreenPID: () -> Int32? = {
      guard let screen = NSScreen.main, let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
      let display = CGDisplayBounds(id)
      return list.first { info in
        guard (info[kCGWindowOwnerPID as String] as? Int32) != me, (info[kCGWindowLayer as String] as? Int) == 0,
          let bounds = info[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds) else { return false }
        return rect == display
      }?[kCGWindowOwnerPID as String] as? Int32
    }
    let helper = fullScreenPID()
    func rect(_ r: NSRect) -> [Double] { [r.minX, r.minY, r.width, r.height].map { Double($0) } }
    func behavior(_ b: NSWindow.CollectionBehavior) -> [String] {
      let names: [(NSWindow.CollectionBehavior, String)] = [(.canJoinAllSpaces, "canJoinAllSpaces"), (.moveToActiveSpace, "moveToActiveSpace"),
        (.managed, "managed"), (.transient, "transient"), (.stationary, "stationary"), (.fullScreenAuxiliary, "fullScreenAuxiliary"),
        (.fullScreenPrimary, "fullScreenPrimary"), (.fullScreenNone, "fullScreenNone"), (.ignoresCycle, "ignoresCycle")]
      return names.filter { b.contains($0.0) }.map(\.1)
    }
    // The window server's view of Peras's own windows (bounds, layer, on screen); no other app's.
    func serverWindows() -> [[String: Any]] {
      let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
      return list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == me }.map { info in
        var row: [String: Any] = ["number": info[kCGWindowNumber as String] ?? 0, "layer": info[kCGWindowLayer as String] ?? 0,
          "onScreen": info[kCGWindowIsOnscreen as String] as? Bool ?? false, "alpha": info[kCGWindowAlpha as String] ?? 0]
        if let b = info[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) { row["bounds"] = rect(r) }
        return row
      }
    }
    let menuHost = desktop.controller
    func role(_ w: NSWindow) -> String {
      if w === desktop.panel { return "pinnedPanel" }
      if w === delegate.item.button?.window { return "statusItem" }
      if w === delegate.auxiliary?.settings?.window { return "settings" }
      if w.className.contains("Popover") { return "popoverWindow" }
      return w.className
    }
    func containsMenu(_ w: NSWindow) -> Bool { menuHost.view.window === w }
    func appWindows() -> [[String: Any]] {
      NSApp.windows.map { w in
        ["role": role(w), "class": w.className, "number": w.windowNumber, "frame": rect(w.frame), "visible": w.isVisible,
          "key": w.isKeyWindow, "level": w.level.rawValue, "onActiveSpace": w.isOnActiveSpace, "behavior": behavior(w.collectionBehavior),
          "titled": w.styleMask.contains(.titled), "occlusionVisible": w.occlusionState.contains(.visible),
          "hostsMenu": containsMenu(w), "alpha": Double(w.alphaValue)] as [String: Any]
      }
    }
    // A Peras window that is visible but hosts no menu, Settings or status item: the empty blurred
    // rectangle the owner saw (a popover window whose content was moved into the panel).
    func emptySurfaces() -> [NSWindow] {
      NSApp.windows.filter { w in
        w.isVisible && !containsMenu(w) && !(w.className.contains("StatusBar"))
          && w !== delegate.auxiliary?.settings?.window && w !== delegate.auxiliary?.setup?.window
      }
    }
    func menuSurfaces() -> [NSWindow] { NSApp.windows.filter { $0.isVisible && containsMenu($0) } }
    func snapshot(_ label: String) {
      let anchor = delegate.item.button?.window
      let anchorRect = anchor.map { $0.frame } ?? .zero
      timeline.append(["label": label, "ms": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
        "popoverShown": delegate.popover.isShown, "popoverDetached": delegate.popover.isDetached, "pinned": desktop.pinned,
        "didShowCount": shows, "didCloseCount": closes, "appActive": NSApp.isActive, "appHidden": NSApp.isHidden,
        "activationPolicy": NSApp.activationPolicy().rawValue, "frontmostIsPeras": front() == me,
        "frontmostIsFullScreenApp": helper != nil && front() == helper, "fullScreenAppStillCoversScreen": fullScreenPID() != nil,
        "desktopMessage": delegate.store.desktopMessage ?? NSNull(), "storeVisible": delegate.store.visible,
        "anchor": ["frame": rect(anchorRect), "visible": anchor?.isVisible ?? false, "onActiveSpace": anchor?.isOnActiveSpace ?? false,
          "occlusionVisible": anchor?.occlusionState.contains(.visible) ?? false,
          "onAnyScreen": NSScreen.screens.contains { $0.frame.intersects(anchorRect) },
          "screens": NSScreen.screens.map { rect($0.frame) }, "mainVisibleFrame": rect(NSScreen.main?.visibleFrame ?? .zero)],
        "appWindows": appWindows(), "serverWindows": serverWindows(),
        "menuSurfaceCount": menuSurfaces().count, "emptySurfaceCount": emptySurfaces().count,
        "keyWindowRole": NSApp.keyWindow.map(role) ?? "none"])
    }
    func press(_ label: String, then next: @escaping () -> Void) {
      snapshot(label + ":before")
      desktop.hotKey.action?()
      snapshot(label + ":0ms")
      delegate.later(0.15) { snapshot(label + ":150ms")
        delegate.later(0.5) { snapshot(label + ":650ms"); next() } }
    }
    // The menu the owner gets on the desktop: one attached popover window hosting the menu, key, on
    // this Space, Peras active, not the pinned panel, and no stray empty surface.
    func normalMenu() -> Bool {
      let menu = menuSurfaces()
      return delegate.popover.isShown && !desktop.pinned && menu.count == 1 && menu[0].isKeyWindow && menu[0].isOnActiveSpace
        && menu[0].occlusionState.contains(.visible) && !menu[0].styleMask.contains(.titled) && NSApp.isActive && emptySurfaces().isEmpty
    }
    let handedBack = { !delegate.popover.isShown && desktop.panel?.isVisible != true && !NSApp.isActive && (helper == nil || front() == helper)
      && menuSurfaces().isEmpty && emptySurfaces().isEmpty }
    func finish() {
      NSWorkspace.shared.notificationCenter.removeObserver(spaces)
      popoverEvents.forEach(NotificationCenter.default.removeObserver)
      checks["noSpaceChangesAfterFullScreenSettled"] = realSpaceChanges == 0
      evidence["checks"] = checks
      evidence["timeline"] = timeline
      evidence["realSpaceChanges"] = realSpaceChanges
      evidence["allChecksPassed"] = !checks.isEmpty && checks.values.allSatisfy { $0 }
      evidence["method"] = "Presses call desktop.hotKey.action (the closure the Carbon ⌃⌥P handler calls) while a throwaway full-screen app is frontmost; the shortcut itself is not registered. Escape is an NSEvent posted to Peras's own queue. Window state comes from AppKit and CGWindowListCopyWindowInfo filtered to Peras's own pid."
      evidence["limitations"] = ["No physical key press: a Carbon hot key event's own activation side effects are not exercised.", "One display; menu-bar autohide and 'Displays have separate Spaces' as currently set."]
      delegate.probe.write(evidence, name: "fullscreen-probe")
      if delegate.popover.isShown || desktop.pinned { delegate.close(reason: "fullscreen_probe") }
      delegate.later(0.3) { NSApp.terminate(nil) }
    }
    // The owner's broken state: the menu's pin pressed over the full-screen app (Tab+Space or a click
    // on "Keep Peras open"), then the shortcut again while pinned. The pinned panel must be the one
    // key surface on this Space, with no empty popover window left behind; closing hands focus back.
    func pinOverFullScreen() {
      press("press4") {
        delegate.store.onPin?()
        delegate.later(0.4) {
          snapshot("pinnedFromMenu")
          let panel = desktop.panel
          checks["pinOverFullScreenOneKeyPanel"] = desktop.pinned && panel?.isVisible == true && panel?.isKeyWindow == true
            && panel?.isOnActiveSpace == true && NSApp.isActive && menuSurfaces().count == 1 && !delegate.popover.isShown
          checks["pinOverFullScreenNoEmptySurface"] = emptySurfaces().isEmpty
          press("press5") {
            checks["shortcutWhilePinnedKeepsKeyPanel"] = desktop.pinned && panel?.isKeyWindow == true && NSApp.isActive && emptySurfaces().isEmpty
            if let panel { _ = desktop.windowShouldClose(panel) }
            OwnKeys.wait(delegate, until: handedBack) {
              snapshot("afterPinnedClose")
              checks["pinnedCloseHandsBackToFullScreenApp"] = handedBack()
              pinDuringShow()
            }
          }
        }
      }
    }
    // The pin pressed while the menu is still showing (before didShow), when NSPopover ignores close():
    // the panel must take the menu and no empty popover window may stay behind.
    func pinDuringShow() {
      snapshot("pinDuringShow:before")
      desktop.hotKey.action?()
      let showingAtPin = delegate.showing
      delegate.store.onPin?()
      snapshot("pinDuringShow:0ms")
      evidence["pinDuringShowWhileShowing"] = showingAtPin
      OwnKeys.wait(delegate, until: { desktop.panel?.isKeyWindow == true && !delegate.popover.isShown }) {
        delegate.later(0.4) {
          snapshot("pinDuringShow:settled")
          let panel = desktop.panel
          checks["pinDuringShowOneKeyPanel"] = showingAtPin && desktop.pinned && panel?.isKeyWindow == true && panel?.isOnActiveSpace == true
            && NSApp.isActive && menuSurfaces().count == 1 && !delegate.popover.isShown
          checks["pinDuringShowNoEmptySurface"] = emptySurfaces().isEmpty
          if let panel { _ = desktop.windowShouldClose(panel) }
          OwnKeys.wait(delegate, until: handedBack) {
            snapshot("afterPinDuringShowClose")
            checks["pinDuringShowCloseHandsBack"] = handedBack()
            finish()
          }
        }
      }
    }
    // Precondition: another app's full-screen window covers the main display and that app is in front.
    if front() == me { DistributedNotificationCenter.default().postNotificationName(helperActivate, object: nil, userInfo: nil, deliverImmediately: true) }
    OwnKeys.wait(delegate, 6, until: { fullScreenPID() != nil && front() != me }) {
      evidence["fullScreenAppPID"] = helper.map { $0 as Any } ?? NSNull()
      evidence["precondition"] = ["fullScreenAppCoversMain": fullScreenPID() != nil, "fullScreenAppFrontmost": helper != nil && front() == helper,
        "perasActive": NSApp.isActive]
      guard helper != nil, fullScreenPID() != nil, front() == helper else {
        checks["preconditionFullScreenAppInFront"] = false
        finish(); return
      }
      realSpaceChanges = 0
      press("press1") {
        checks["firstPressOpensNormalMenu"] = normalMenu()
        checks["firstPressNoEmptySurface"] = emptySurfaces().isEmpty
        checks["firstPressNotPinned"] = !desktop.pinned
        press("press2") {
          checks["secondPressKeepsNormalMenu"] = normalMenu()
          let menu = desktop.activeWindow
          _ = OwnKeys.post(menu, keyCode: 53, characters: "\u{1b}")
          OwnKeys.wait(delegate, until: handedBack) {
            snapshot("afterEscape")
            checks["escapeClosesAndHandsBackToFullScreenApp"] = handedBack()
            press("press3") {
              checks["reopenOpensNormalMenu"] = normalMenu()
              // Keyboard reaches the menu: Tab moves the first responder inside the menu window.
              let window = desktop.activeWindow
              let before = window?.firstResponder
              _ = OwnKeys.post(window, keyCode: 48, characters: "\t")
              delegate.later(0.2) {
                checks["tabMovesFocusInsideMenu"] = window?.isKeyWindow == true && window?.firstResponder !== before
                  && (window?.firstResponder as? NSView)?.window === window
                delegate.close(reason: "fullscreen_probe")
                OwnKeys.wait(delegate, until: handedBack) {
                  snapshot("afterClose")
                  checks["closeHandsBackToFullScreenApp"] = handedBack()
                  _ = NativeSceneRuntime.openSettings()
                  OwnKeys.wait(delegate, until: { delegate.auxiliary?.settings?.window?.isKeyWindow == true }) {
                    snapshot("settings")
                    let settings = delegate.auxiliary?.settings?.window
                    checks["settingsComparisonKeyOnFullScreenSpace"] = settings?.isKeyWindow == true && settings?.isOnActiveSpace == true
                      && NSApp.activationPolicy() == .accessory
                    settings?.performClose(nil)
                    OwnKeys.wait(delegate, until: handedBack) {
                      snapshot("afterSettings")
                      checks["settingsCloseHandsBack"] = handedBack()
                      pinOverFullScreen()
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

