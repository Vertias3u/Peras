import AppKit
import QuartzCore
import SwiftUI

@main
struct PerasNativeApp {
  static func main() {
    do {
      let options = Options()
      #if PERAS_PRODUCTION
      guard options.args.dropFirst().isEmpty else {
        fputs("This Peras app does not accept development arguments. Open it without additional options.\n", stderr)
        exit(2)
      }
      #else
      if let root = options.value("--root"), !LaunchRecord.absolute(root) { throw LaunchFailure.install }
      #endif
      let resources = try SpriteResources(directory: Bundle.main.resourceURL!)
      #if !PERAS_PRODUCTION
      if options.contains("--headless") {
        try NativeChecks.run(
          resources: resources, fixtures: options.fixtureDirectory, output: options.output)
        try BridgeChecks.run(options: options)
        try PresentationChecks.run(options: options)
        try DesktopChecks.run(options: options, resources: resources)
        try MenuChecks.run(options: options, resources: resources)
        try RecapChecks.run(options: options, resources: resources)
        try LaunchChecks.run(options: options)
        return
      }
      #endif
      let lock = try InstanceLock(path: options.root)
      guard try lock.acquire() else {
        #if !PERAS_PRODUCTION
        if options.contains("--stop") {
          DistributedNotificationCenter.default().postNotificationName(
            Notification.Name("eu.vertias.peras.fixture.\(lock.key).stop"), object: nil,
            userInfo: nil, deliverImmediately: true)
          for _ in 0..<200 {
            usleep(10_000)
            if try lock.acquire() { return }
          }
          throw SnapshotError.invalid("Target preview did not stop; build was not replaced")
        }
        #endif
        DistributedNotificationCenter.default().postNotificationName(
          Notification.Name("eu.vertias.peras.fixture.\(lock.key)"), object: nil)
#if !PERAS_PRODUCTION
        try Probe(directory: options.output).write(
          ["acquired": false, "rootKey": lock.key], name: "duplicate-\(getpid())")
#endif
        return
      }
#if !PERAS_PRODUCTION
      if options.contains("--stop") { return }
#endif
      let delegate = try AppDelegate(options: options, resources: resources, instance: lock)
      NativeSceneRuntime.owner = delegate
      withExtendedLifetime(delegate) { PerasSettingsSceneApp.main() }
    } catch {
      #if PERAS_PRODUCTION
      let message = LaunchFailure.install.message
      #else
      let options = Options()
      let message = options.value("--bridge-config") != nil || options.fixtureMode || options.contains("--headless")
        ? "Peras native development launch failed: \(error)" : LaunchFailure.install.message
      #endif
      fputs(message + "\n", stderr)
      exit(1)
    }
  }
}
struct Options {
  let args = ProcessInfo.processInfo.arguments
  #if PERAS_PRODUCTION
  var fixtureMode: Bool { false }
  var developmentMode: Bool { false }
  var root: String {
    LaunchRoot.resolve(bundle: Bundle.main.bundleURL, explicit: nil,
      environment: ProcessInfo.processInfo.environment, development: false)
  }
  var fixtureDirectory: URL { Bundle.main.resourceURL! }
  #else
  func contains(_ flag: String) -> Bool { args.contains(flag) }
  func value(_ flag: String) -> String? {
    guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
    return args[i + 1]
  }
  var developmentMode: Bool { value("--bridge-config") != nil }
  var fixtureMode: Bool { contains("--fixture") || contains("--fixtures-only") }
  func bridgeConfiguration() throws -> BridgeConfiguration {
    guard let path = value("--bridge-config") else { throw BridgeError.unavailable }
    return try JSONDecoder().decode(
      BridgeConfiguration.self, from: Data(contentsOf: URL(fileURLWithPath: path))
    ).validated()
  }
  var root: String {
    LaunchRoot.resolve(bundle: Bundle.main.bundleURL, explicit: value("--root"),
      environment: ProcessInfo.processInfo.environment, development: value("--bridge-config") != nil || fixtureMode)
  }
  var output: URL { URL(fileURLWithPath: value("--output") ?? root + "/probe", isDirectory: true) }
  var fixtureDirectory: URL {
    URL(
      fileURLWithPath: value("--fixtures")
        ?? Bundle.main.resourceURL!.appendingPathComponent("fixtures").path, isDirectory: true)
  }
  #endif
}
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
  let options: Options
  let store: FixtureStore
  let instance: InstanceLock
#if !PERAS_PRODUCTION
  let probe: Probe
#endif
  let popover = NSPopover()
  var item: NSStatusItem!
  var desktop: DesktopCoordinator?
  var auxiliary: AuxiliaryWindows?
  var asleep = false
#if !PERAS_PRODUCTION
  var benchmarkSegments = [[String: Any]]()
#endif
#if !PERAS_PRODUCTION
  var preparedLayoutMs = 0.0
#endif
  var authoritativeLayoutPrepared = false
#if !PERAS_PRODUCTION
  var bridgePID: Int32?
#endif
#if !PERAS_PRODUCTION
  private(set) var receivedFocusCount = 0
#endif
#if !PERAS_PRODUCTION
  var expectedClose = false
#endif
#if !PERAS_PRODUCTION
  var eventMonitor: Any?
#endif
#if !PERAS_PRODUCTION
  var lifecycleEvents = [[String: Any]]()
#endif
  init(options: Options, resources: SpriteResources, instance: InstanceLock) throws {
    self.options = options
    self.instance = instance
    store = FixtureStore(
      resources: resources, fixtureDirectory: options.fixtureDirectory,
      fixtureMode: options.fixtureMode, developmentMode: options.developmentMode, presentationRoot: instance.root)
#if !PERAS_PRODUCTION
    probe = try Probe(directory: options.output)
#endif
    super.init()
    #if !PERAS_PRODUCTION
    let selected = options.value("--fixture") ?? "normal-usage"
    if options.fixtureMode,
      let url = store.fixtures.first(where: {
        $0.deletingPathExtension().lastPathComponent == selected
      })
    {
      store.load(url)
    }
    #endif
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    #if !PERAS_PRODUCTION
    if options.contains("--share-probe") {
      Task { @MainActor in
        do { try ShareProbe.run(options: self.options) } catch {
          let failure = error as? ShareProbeFailure
          self.probe.write(
            [
              "ok": false, "phase": failure?.phase ?? "render-or-export",
              "code": failure?.code ?? "share_probe_failed",
            ], name: "share-probe")
        }
        NSApp.terminate(nil)
      }
      return
    }
    #endif
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    StatusItemAppearance.apply(item.button, snapshot: store.snapshot, fixture: options.fixtureMode, development: store.developmentMode)
    item.button?.target = self
    item.button?.action = #selector(toggle)
    #if !PERAS_PRODUCTION
    DrawObserver.shared.probe = diagnosticsEnabled ? probe : nil
    #endif
#if !PERAS_PRODUCTION
    let preparationStarted = CACurrentMediaTime()
#endif
    let controller = PopoverController(store: store)
    controller.view.frame = NSRect(x: 0, y: 0, width: 320, height: 350)
    controller.view.layoutSubtreeIfNeeded()
#if !PERAS_PRODUCTION
    preparedLayoutMs = (CACurrentMediaTime() - preparationStarted) * 1000
#endif
    store.onStateInvalidated = { [weak self] in
      guard let self else { return }
      StatusItemAppearance.apply(self.item.button, snapshot: nil, fixture: self.options.fixtureMode, development: self.store.developmentMode)
      self.item.button?.toolTip = "Peras · Current readings unavailable"
      self.item.button?.setAccessibilityLabel("Peras, current readings unavailable")
    }
    store.onAppliedSnapshot = { [weak self, weak controller] snapshot in
      guard let self else { return }
      StatusItemAppearance.apply(self.item.button, snapshot: snapshot, fixture: self.options.fixtureMode, development: self.store.developmentMode)
      guard !self.authoritativeLayoutPrepared else { return }
      DispatchQueue.main.async { [weak self, weak controller] in
        guard let self, let controller, !self.popover.isShown else { return }
#if !PERAS_PRODUCTION
        let start = CACurrentMediaTime()
#endif
        controller.prepareLayout()
        self.authoritativeLayoutPrepared = true
        #if !PERAS_PRODUCTION
        if self.diagnosticsEnabled {
          self.probe.write(
            [
              "layoutMs": (CACurrentMediaTime() - start) * 1000,
              "revision": snapshot.revision, "hiddenDraws": self.probe.hiddenDraws,
              "method": "First authoritative snapshot layout only; no display/cache/orderFront",
            ], name: "snapshot-layout")
        }
        #endif
      }
    }
    if let snapshot = store.snapshot {
      StatusItemAppearance.apply(item.button, snapshot: snapshot, fixture: options.fixtureMode, development: store.developmentMode)
    }
    popover.contentViewController = controller
    popover.contentSize = NSSize(width: 320, height: 350)
    popover.animates = false
    #if PERAS_PRODUCTION
    popover.behavior = .transient
    #else
    popover.behavior = options.contains("--benchmark") ? .applicationDefined : .transient
    #endif
    popover.delegate = self
    desktop = DesktopCoordinator(popover: popover, controller: controller, store: store, root: instance.root)
    desktop?.popoverShowing = { [weak self] in self?.showing == true }
    auxiliary = AuxiliaryWindows(store: store)
    store.onOpenSettings = { _ = NativeSceneRuntime.openSettings() }
    store.onOpenSetup = { [weak self] in self?.auxiliary?.showSetup() }
#if !PERAS_PRODUCTION
    store.onOpenDiagnostics = { [weak self] in self?.auxiliary?.showDiagnostics() }
#endif
    store.onMenuHeight = { [weak self] height in self?.desktop?.fitMenu(height: height) }
    desktop?.fitMenu(height: store.menuContentHeight)
    desktop?.onOpenAttached = { [weak self] in self?.open() }
    desktop?.onCloseAttached = { [weak self] in self?.close(reason: "escape") }
    desktop?.onVisibility = { [weak self] in self?.syncVisibility() }

    // An accessory app owns no menu bar, so macOS hides the whole bar while one of its windows is
    // key. Peras becomes a regular app while Settings, Setup or another titled window is open.
    for name in [NSWindow.didBecomeKeyNotification, NSWindow.willCloseNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(windowPolicyChanged(_:)), name: name, object: nil)
    }
    // Construct views/assets early, but never display or cache hidden content before measuring cold open.
    NotificationCenter.default.addObserver(
      self, selector: #selector(visibilityChanged(_:)),
      name: NSWindow.didChangeOcclusionStateNotification, object: nil)
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(spaceChanged), name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
    for name in [Notification.Name.NSSystemClockDidChange, Notification.Name.NSSystemTimeZoneDidChange] {
      NotificationCenter.default.addObserver(self, selector: #selector(timeBoundaryChanged), name: name, object: nil)
    }
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(sleeping), name: NSWorkspace.willSleepNotification, object: nil)
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(waking), name: NSWorkspace.didWakeNotification, object: nil)
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(focus),
      name: Notification.Name("eu.vertias.peras.fixture.\(instance.key)"), object: nil)
    #if !PERAS_PRODUCTION
    DistributedNotificationCenter.default().addObserver(
      self, selector: #selector(stopPreview),
      name: Notification.Name("eu.vertias.peras.fixture.\(instance.key).stop"), object: nil)
    #if !PERAS_PRODUCTION
    DrawObserver.shared.probe = diagnosticsEnabled ? probe : nil
    #endif
    probe.write(
      [
        "acquired": true, "rootKey": instance.key, "pid": getpid(),
        "resolvedRoot": instance.root.path, "cocoaHome": NSHomeDirectory(),
        "configuredHome": ProcessInfo.processInfo.environment["HOME"] ?? "",
        "preparedLayoutMs": preparedLayoutMs,
        "fixtureDirectory": options.fixtureDirectory.path, "fixture": store.fixtureName,
      ], name: "instance")
    if diagnosticsEnabled { installEventInstrumentation() }
    #endif
    installTerminationSignal()
    #if PERAS_PRODUCTION
    resolveProductionBridge()
    #else
    if !options.fixtureMode {
      if options.value("--bridge-config") != nil {
        do { try connectBridge(options.bridgeConfiguration()) }
        catch { store.error = "Local bridge configuration is unavailable. Rebuild from the safe run script." }
      } else {
        resolveProductionBridge()
      }
    }
    #endif
    #if !PERAS_PRODUCTION
    if options.contains("--menu-probe") {
      later(0.5) { MenuProbe.run(delegate: self) }
    } else if options.contains("--desktop-probe") {
      later(0.8) { DesktopProbe.run(delegate: self) }
    } else if options.contains("--keyboard-probe") {
      later(0.8) { KeyboardProbe.run(delegate: self) }
    } else if options.contains("--benchmark") {
      later(0.5) {
        self.measure("closed", seconds: self.duration) {
          if self.store.fixtureMode {
            self.store.actors.forEach {
              $0.trigger("resume", self.store.logicalNow, self.store.reduced)
            }
          }
          if self.options.contains("--pinned") {
            _ = self.probe.beginOpen()
            self.desktop?.pin()
          } else { self.open() }
          self.later(1) {
            self.measure("visible-animation", seconds: self.duration) {
              if !self.store.fixtureMode {
                self.finishBenchmark()
                return
              }
              self.store.actors.forEach {
                $0.trigger("pause", self.store.logicalNow, self.store.reduced)
              }
              self.store.refresh()
              self.later(0.5) {
                self.measure("visible-static", seconds: self.duration) {
                  self.store.reducedOverride = true
                  self.store.actors.forEach { $0.trigger("resume", self.store.logicalNow, true) }
                  self.store.accessibilityChanged()
                  self.measure("reduced-motion", seconds: self.duration) {
                    self.finishBenchmark()
                  }
                }
              }
            }
          }
        }
      }
    } else if options.contains("--probe") {
      later(Double(options.value("--open-delay") ?? "0.5") ?? 0.5) {
        self.open()
        self.later(1) {
          DrawObserver.shared.canvas?.exportLayerProof(to: self.probe.directory)
          self.probe.write(
            ["timerActive": self.store.timer != nil, "ticks": self.store.ticks], name: "open-state")
          self.close(reason: "probe_or_benchmark_schedule")
          self.afterSettledHidden { settledHidden in
          let ticks = self.store.ticks
          let travel = self.store.actors.map(\.travel)
          self.later(1) {
            self.probe.write(
              [
                "closedSampleValid": settledHidden && !self.store.visible && self.desktop?.activeWindow?.isVisible != true,
                "timerActive": self.store.timer != nil, "hiddenTickDelta": self.store.ticks - ticks,
                "travelBeforeHide": travel, "travelAfterHide": self.store.actors.map(\.travel),
              ], name: "closed-state")
            let beforeReopen = self.store.actors.map(\.travel)
            self.open()
            self.probe.write(
              [
                "travelBeforeReopen": beforeReopen,
                "travelAfterReopen": self.store.actors.map(\.travel),
                "phaseRetainedAtReopen": beforeReopen == self.store.actors.map(\.travel),
                "firstVisibleContentDrawMs": self.probe.firstDrawMs.map { $0 as Any } ?? NSNull(),
              ], name: "reopen-state")
            self.later(0.5) {
              self.close(reason: "probe_or_benchmark_schedule")
              NSApp.terminate(nil)
            }
          }
          }
        }
      }
    }
    #endif
  }
  // A repaired external launch record takes effect on deliberate reopen. An existing
  // client owns its reconnects; reopening must never replace it or replay a command.
  private var resolvingProductionBridge = false
  private func resolveProductionBridge() {
    guard !terminating, store.bridge == nil, !resolvingProductionBridge else { return }
    #if !PERAS_PRODUCTION
    guard !options.fixtureMode, options.value("--bridge-config") == nil else { return }
    #endif
    resolvingProductionBridge = true
    store.error = nil
    store.connection = "Checking Node.js…"
    let root = instance.root.path
    let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
    let runtime = Bundle.main.object(forInfoDictionaryKey: "PerasRuntimeVersion") as? String
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let result = Result { try LaunchRecord.load(root: root).configuration(root: root, home: home, expectedRuntime: runtime) }
      let installed = (try? LaunchRecord.load(root: root)).flatMap { LoginItem.installedRuntime(cli: $0.cli) }
      DispatchQueue.main.async {
        guard let self, !self.terminating else { return }
        self.resolvingProductionBridge = false
        do {
          try self.connectBridge(result.get())
          self.store.error = nil
          #if PERAS_PRODUCTION
          // Only the installed copy becomes the login item, never a Peras.app left in Downloads.
          let resolved = { (url: URL) in url.resolvingSymlinksInPath().standardizedFileURL.path }
          if resolved(Bundle.main.bundleURL) == resolved(URL(fileURLWithPath: root).appendingPathComponent("native/Peras.app")) {
            self.desktop?.applyLoginDefault()
          }
          #endif
        } catch {
          #if PERAS_PRODUCTION
          // Rolled back to an older Peras: it draws its own menu, so this app leaves login items and quits.
          if let installed, let runtime, LoginItem.runtimeIsOlder(installed, than: runtime) {
            LoginItem.set(false)
            NSApp.terminate(nil)
            return
          }
          #endif
          self.store.connection = "Connection unavailable"
          self.store.error = (error as? LaunchFailure)?.message ?? LaunchFailure.install.message
        }
      }
    }
  }
  func handleReopen() {
    store.retryConnection()
    resolveProductionBridge()
    focus()
  }
  private var terminationSignal: DispatchSourceSignal?
  private var terminating = false
  private func installTerminationSignal() {
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler { NSApp.terminate(nil) }
    terminationSignal = source
    source.resume()
  }
  private func connectBridge(_ configuration: BridgeConfiguration) throws {
    guard try InstanceLock(path: configuration.environment["PERAS_HOME"]!).key == instance.key
    else { throw BridgeError.unavailable }
    let client = try BridgeClient(configuration: configuration)
    #if !PERAS_PRODUCTION
    if diagnosticsEnabled || options.contains("--desktop-probe") {
      client.onDiagnostic = { [weak self] event, fields in
        self?.bridgePID = event == "child_started" ? fields["pid"] as? Int32 : nil
        self?.recordEvent("bridge_" + event, fields)
      }
    }
    #endif
    store.connect(client)
  }
  #if !PERAS_PRODUCTION
  var diagnosticsEnabled: Bool { options.contains("--probe") || options.contains("--benchmark") }
  var duration: Double { max(1, Double(options.value("--seconds") ?? "15") ?? 15) }
  func later(_ seconds: Double, _ action: @escaping () -> Void) {
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: action)
  }
  // Closing animation is still visible work. Start hidden sampling only after the
  // actual owned surface and store visibility have both settled, without changing open timing.
  func afterSettledHidden(_ completion: @escaping (Bool) -> Void) {
    let deadline = CACurrentMediaTime() + 2
    func poll() {
      let hidden = !store.visible && desktop?.activeWindow?.isVisible != true && !popover.isShown && desktop?.panel?.isVisible != true
      if hidden || CACurrentMediaTime() >= deadline { completion(hidden); return }
      later(0.05, poll)
    }
    poll()
  }
  func finishBenchmark() {
    close(reason: "benchmark_finished")
    probe.write(
      [
        "mode": store.fixtureMode ? "fixture-renderer" : "live-engine",
        "segments": benchmarkSegments,
        "firstVisibleContentDrawMs": probe.firstDrawMs.map { $0 as Any } ?? NSNull(),
      ], name: "benchmark")
    NSApp.terminate(nil)
  }
  func measure(_ name: String, seconds: Double, completion: @escaping () -> Void) {
    let wall = CACurrentMediaTime()
    let cpu = cpuSeconds()
    let ticks = store.ticks
    let visibleAtStart = store.visible
    let transitionsAtStart = store.visibilityTransitions
    let activityAtStart = store.activityTransitions
    let pausedAtStart = store.actors.map(\.paused)
    probe.write(
      [
        "phase": name, "boundary": "start", "monotonic": wall,
        "bridgePID": bridgePID.map { $0 as Any } ?? NSNull(),
      ], name: "current-phase")
    later(seconds) {
      let end = CACurrentMediaTime()
      let cpuEnd = cpuSeconds()
      let elapsed = end - wall
      let tickDelta = self.store.ticks - ticks
      let visibilityUnchanged = self.store.visibilityTransitions == transitionsAtStart
      let activityUnchanged = self.store.activityTransitions == activityAtStart
      let visibleValid = visibleAtStart && self.store.visible && visibilityUnchanged
      let timer = self.store.timer != nil
      let paused = self.store.actors.map(\.paused)
      let motionValid: Bool
      switch name {
      case "closed": motionValid = tickDelta == 0 && !timer
      case "visible-animation":
        motionValid =
          !self.store.reduced && tickDelta > 0 && timer && paused == pausedAtStart
          && paused.contains(false) && activityUnchanged
      case "visible-static":
        motionValid = tickDelta == 0 && !timer && !paused.contains(false) && activityUnchanged
      case "reduced-motion":
        motionValid = tickDelta == 0 && !timer && self.store.reduced && activityUnchanged
      default: motionValid = false
      }
      self.probe.write(
        [
          "phase": name, "boundary": "end", "monotonic": end,
          "bridgePID": self.bridgePID.map { $0 as Any } ?? NSNull(),
        ], name: "current-phase")
      self.benchmarkSegments.append([
        "state": name, "wallSeconds": elapsed,
        "bridgePID": self.bridgePID.map { $0 as Any } ?? NSNull(),
        "phaseStartMonotonic": wall, "phaseEndMonotonic": end,
        "visibleAtStart": visibleAtStart, "visibleAtEnd": self.store.visible,
        "visibilityTransitionDelta": self.store.visibilityTransitions - transitionsAtStart,
        "activityTransitionDelta": self.store.activityTransitions - activityAtStart,
        "motionStateValid": motionValid,
        "phaseValid": motionValid
          && (name == "closed"
            ? !visibleAtStart && !self.store.visible && visibilityUnchanged : visibleValid),
        "cpuPercentOneCore": 100 * (cpuEnd - cpu) / elapsed,
        "fixture": self.store.fixtureName,
        "mode": self.store.fixtureMode ? "fixture-renderer" : "live-engine",
        "activeActorCount": paused.filter { !$0 }.count, "tickDelta": tickDelta,
        "timerActive": timer, "reducedMotion": self.store.reduced, "actorPaused": paused,
        "actorTravel": self.store.actors.map(\.travel), "popoverShown": self.popover.isShown,
        "surface": self.desktop?.pinned == true ? "panel" : "popover",
        "windowVisible": self.desktop?.activeWindow?.isVisible ?? false,
        "unoccluded": self.desktop?.activeWindow?.occlusionState.contains(.visible) ?? false,
      ])
      completion()
    }
  }
  #endif
  @objc func toggle() {
#if !PERAS_PRODUCTION
    recordEvent("status_toggle")
#endif
    if desktop?.pinned == true { desktop?.focus(); return }
    if popover.isShown {
      #if PERAS_PRODUCTION
      close(reason: "status_toggle")
      #else
      if !options.contains("--benchmark") { close(reason: "status_toggle") }
      #endif
    } else {
      open()
    }
  }
  @objc func focus() {
#if !PERAS_PRODUCTION
    if options.contains("--desktop-probe") { receivedFocusCount += 1 }
#endif
    desktop?.focus()
  }
#if !PERAS_PRODUCTION
  @objc func stopPreview() { NSApp.terminate(nil) }
#endif
  // A minimized window still owns the Dock icon; dropping to .accessory would strand it there.
  static func ownsMenuBar(_ window: NSWindow) -> Bool { (window.isVisible || window.isMiniaturized) && window.styleMask.contains(.titled) && !(window is NSPanel) }
  @objc func windowPolicyChanged(_ note: Notification) {
    let closing = note.name == NSWindow.willCloseNotification ? note.object as? NSWindow : nil
    let open = NSApp.windows.contains { $0 !== closing && Self.ownsMenuBar($0) }
    let overFullScreen = closing == nil && (note.object as? NSWindow).map(Self.overFullScreenApp) == true
    let policy: NSApplication.ActivationPolicy = open && !overFullScreen ? .regular : .accessory
    let changed = NSApp.activationPolicy() != policy
    if changed {
      NSApp.setActivationPolicy(policy)
      if open { NSApp.activate(ignoringOtherApps: true) }
    }
    // Also when the last window closes over a full-screen app, where the policy stays .accessory.
    if !open && (changed || closing != nil) && !popover.isShown { DispatchQueue.main.async { Self.yieldIfIdle() } }
  }
  // Over another app's full-screen Space the menu bar is hidden anyway, and macOS pulls a .regular
  // app's window back to the desktop Space, so Peras stays .accessory there. A full-screen window
  // covers its whole display, menu-bar strip included; a merely zoomed one stops below the bar.
  static func overFullScreenApp(_ window: NSWindow) -> Bool {
    guard let screen = window.screen ?? NSScreen.main,
      let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID,
      let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return false }
    return coversDisplay(list, display: CGDisplayBounds(id), mine: ProcessInfo.processInfo.processIdentifier)
  }
  static func coversDisplay(_ list: [[String: Any]], display: CGRect, mine: Int32) -> Bool {
    list.contains { info in
      guard (info[kCGWindowOwnerPID as String] as? Int32) != mine, (info[kCGWindowLayer as String] as? Int) == 0,
        let bounds = info[kCGWindowBounds as String] as? NSDictionary, let rect = CGRect(dictionaryRepresentation: bounds) else { return false }
      return rect == display
    }
  }
  // Peras has no menu bar of its own: left active with no window, macOS shows a blank bar until
  // another app activates. Hiding hands activation back to the app the user came from.
  static func yieldIfIdle() {
    guard NSApp.isActive, !NSApp.windows.contains(where: { $0.isVisible && ($0.styleMask.contains(.titled) || $0.className.contains("Popover")) }) else { return }
    NSApp.hide(nil)
  }
  func open() {
    // After yieldIfIdle hid it. unhide(nil) would also activate Peras, and a menu-only Peras that is
    // active blanks the menu bar when the menu closes; windows that need focus activate themselves.
    if NSApp.isHidden { NSApp.unhideWithoutActivation() }
    if desktop?.pinned == true { desktop?.focus(); return }
    if popover.isShown {
      // Over a full-screen app the activation is already queued for didShow; asking now would be revoked.
      if showing && activateWhenShown { return }
      NSApp.activate(ignoringOtherApps: true)
      desktop?.activeWindow?.makeKeyAndOrderFront(nil)
      return
    }
    guard let button = item.button, let anchorWindow = button.window,
      anchorWindow.isVisible, button.bounds.width > 0 else { desktop?.pin(anchorUnavailable: true); return }
    let anchor = button.convert(button.bounds, to: nil)
    guard NSScreen.screens.contains(where: { $0.frame.intersects(anchorWindow.convertToScreen(anchor)) })
    else { desktop?.pin(anchorUnavailable: true); return }

    store.desktopMessage = nil
    let anchorScreen = NSScreen.screens.first { $0.frame.intersects(anchorWindow.convertToScreen(anchor)) }
    desktop?.fitMenu(height: store.menuContentHeight, screen: anchorScreen)
#if !PERAS_PRODUCTION
    let started = diagnosticsEnabled ? probe.beginOpen() : CACurrentMediaTime()
    expectedClose = false
    recordEvent("open_requested")
#endif
    // On the desktop the menu takes the keyboard before it finishes showing, so an early Escape
    // reaches it. Over another app's full-screen Space macOS revokes an activation that arrives while
    // the popover is still showing, and the transient popover then closes: wait for didShow there.
    let timing = MenuActivation.timing(overFullScreen: Self.overFullScreenApp(anchorWindow))
    if timing == .beforeShow { NSApp.activate(ignoringOtherApps: true) }
    showing = true
    activateWhenShown = timing == .afterDidShow
    popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
#if !PERAS_PRODUCTION
    let showReturned = CACurrentMediaTime()
    recordEvent("open_activation", ["afterDidShow": timing == .afterDidShow])
#endif
    if timing == .beforeShow { desktop?.activeWindow?.makeKeyAndOrderFront(nil) }
    popover.contentViewController?.view.needsDisplay = true
    DrawObserver.shared.canvas?.needsDisplay = true
    syncVisibility()
    #if !PERAS_PRODUCTION
    if diagnosticsEnabled {
      probe.write(
        [
          "showCallMs": (showReturned - started) * 1000,
          "openReturnMs": (CACurrentMediaTime() - started) * 1000,
          "preparedLayoutMs": preparedLayoutMs,
          "method": "No display/cache forced during preparation; only view creation and layout",
        ], name: "open-stages-\(probe.openSequence)")
    }
    #endif
  }
  @objc func visibilityChanged(_ note: Notification) {
    guard note.object as? NSWindow === desktop?.activeWindow else { return }
#if !PERAS_PRODUCTION
    recordEvent("occlusion_changed")
#endif
    syncVisibility()
  }
  @objc func spaceChanged() { syncVisibility() }
  @objc func sleeping() {
    asleep = true
    syncVisibility()
  }
  @objc func waking() {
    asleep = false
    refreshTimeBoundary()
  }
  @objc func timeBoundaryChanged() { refreshTimeBoundary() }
  func refreshTimeBoundary() {
    desktop?.screensChanged()
    store.refreshAtTimeBoundary()
    syncVisibility()
  }
  func syncVisibility() {
    let wasVisible = store.visible
    store.setVisible(
      !asleep && desktop?.visible == true)
    if store.visible && !wasVisible {
      desktop?.controller.displayVisibleCanvas()
    }
  }
  // NSPopover ignores a close until it has finished showing, and a cold first open blocks long
  // enough for an Escape or click to arrive in between: that close waits for didShow.
  private(set) var showing = false
  private var closeWhenShown = false, activateWhenShown = false
  func popoverDidShow(_ notification: Notification) {
#if !PERAS_PRODUCTION
    recordEvent("popover_did_show")
#endif
    showing = false
    let activate = activateWhenShown
    activateWhenShown = false
    syncVisibility()
    if closeWhenShown { closeWhenShown = false; desktop?.cancelPinWhenShown(); popover.performClose(nil); return }
    // A pin pressed mid-show moves the menu into the panel now; the panel activates itself.
    if desktop?.popoverDidShow() == true { return }
    if activate {
      NSApp.activate(ignoringOtherApps: true)
      desktop?.activeWindow?.makeKeyAndOrderFront(nil)
    }
    // Like macOS's own menus, nothing is focused until Tab; with Keyboard navigation on, AppKit would ring the pin on every open.
    desktop?.activeWindow?.makeFirstResponder(nil)
  }
  func popoverShouldClose(_ popover: NSPopover) -> Bool {
    #if PERAS_PRODUCTION
    return true
    #else
    let allowed = !options.contains("--benchmark") || expectedClose
    recordEvent(allowed ? "popover_should_close_allowed" : "popover_should_close_vetoed")
    return allowed
    #endif
  }
#if !PERAS_PRODUCTION
  func popoverWillClose(_ notification: Notification) { recordEvent("popover_will_close") }
#endif
  func popoverDidClose(_ notification: Notification) {
#if !PERAS_PRODUCTION
    recordEvent("popover_did_close")
#endif
    showing = false
    closeWhenShown = false
    activateWhenShown = false
    desktop?.cancelPinWhenShown()
    syncVisibility()
    // open() activated Peras so the menu takes the keyboard; Escape or a click on the pear
    // closes it with Peras still active and no window, which blanks the menu bar.
    if desktop?.pinned != true { DispatchQueue.main.async { Self.yieldIfIdle() } }
  }
  func close(reason: String) {
#if !PERAS_PRODUCTION
    expectedClose = true
    recordEvent("explicit_close", ["reason": reason])
#endif
    if desktop?.pinned == true, let panel = desktop?.panel { _ = desktop?.windowShouldClose(panel) }
    else if showing { closeWhenShown = true }
    else { popover.performClose(nil) }
  }
  func applicationWillTerminate(_ notification: Notification) {
    terminating = true
    terminationSignal?.cancel()
    NodeVersionProbe.cancelAll()
#if !PERAS_PRODUCTION
    recordEvent("application_will_terminate")
#endif
    desktop?.shutdown()
    store.bridge?.stopAndWait()
#if !PERAS_PRODUCTION
    if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
#endif
  }
  #if !PERAS_PRODUCTION
  func recordEvent(_ name: String, _ fields: [String: Any] = [:]) {
    guard diagnosticsEnabled else { return }
    var record = fields
    let window = desktop?.activeWindow
    record["event"] = name
    record["time"] = CACurrentMediaTime()
    record["shown"] = desktop?.pinned == true ? desktop?.panel?.isVisible == true : popover.isShown
    record["surface"] = desktop?.pinned == true ? "panel" : "popover"
    record["windowVisible"] = window?.isVisible ?? false
    record["unoccluded"] = window?.occlusionState.contains(.visible) ?? false
    record["appActive"] = NSApp.isActive
    record["expectedClose"] = expectedClose
    if let event = NSApp.currentEvent { record["currentEventType"] = event.type.rawValue }
    lifecycleEvents.append(record)
    if lifecycleEvents.count > 256 { lifecycleEvents.removeFirst() }
    probe.write(["events": lifecycleEvents], name: "lifecycle")
  }
  func installEventInstrumentation() {
    for name in [
      NSApplication.didResignActiveNotification, NSApplication.didBecomeActiveNotification,
      NSWindow.didResignKeyNotification, NSWindow.didBecomeKeyNotification,
      NSWindow.willCloseNotification, NSWindow.didMiniaturizeNotification,
    ] {
      NotificationCenter.default.addObserver(
        self, selector: #selector(platformEvent(_:)), name: name, object: nil)
    }
    NSWorkspace.shared.notificationCenter.addObserver(
      self, selector: #selector(platformEvent(_:)),
      name: NSWorkspace.activeSpaceDidChangeNotification, object: nil)
    eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [
      .keyDown, .leftMouseDown, .rightMouseDown, .appKitDefined,
    ]) { [weak self] event in
      // Record only event classes (and Escape), never typed text, positions or private input.
      self?.recordEvent(
        "local_event",
        ["type": event.type.rawValue, "escape": event.type == .keyDown && event.keyCode == 53])
      return event
    }
  }
  @objc func platformEvent(_ notification: Notification) {
    if let window = notification.object as? NSWindow,
      window !== desktop?.activeWindow
    {
      return
    }
    recordEvent(notification.name.rawValue)
    syncVisibility()
  }
  #endif
}
final class DrawObserver {
  static let shared = DrawObserver()
#if !PERAS_PRODUCTION
  weak var probe: Probe?
#endif
  weak var canvas: SpriteCanvas?
}
