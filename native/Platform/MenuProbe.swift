import AppKit
import SwiftUI

// Explicit owned-view export. It never captures the desktop, synthesizes input,
// opens a website, touches the clipboard or changes global accessibility settings.
@MainActor enum MenuProbe {
  static func run(delegate: AppDelegate) {
    guard delegate.store.fixtureMode else {
      delegate.probe.write(["ok": false, "reason": "menu_probe_requires_read_only_fixture_mode"], name: "menu-probe")
      NSApp.terminate(nil); return
    }
    if delegate.options.contains("--rail-repaint-probe") { RailRepaintProbe.run(delegate: delegate); return }
    let runner = Runner(delegate: delegate)
    runner.start()
  }
  @MainActor private final class Runner {
    let delegate: AppDelegate
    let store: FixtureStore
    var rows = [[String: Any]]()
    var caseIndex = 0
    var imageReports = [[String: Any]]()
    var exportFailures = [String]()
    var recapLifecycle = [String: Any]()
    func checkpoint(_ stage: String, failure: String? = nil) {
      var report: [String: Any] = ["complete": false, "stage": stage, "cases": rows, "images": imageReports]
      if let failure { report["failure"] = failure; exportFailures.append(stage + ": " + failure) }
      report["exportFailures"] = exportFailures
      delegate.probe.write(report, name: "menu-probe")
    }
    // --site-image: only the site's picture, the demo week's menu in dark mode (scripts/demo-week.mjs site-menu).
    var siteImage: Bool { delegate.options.contains("--site-image") }
    lazy var cases: [(String, String, String, NSAppearance.Name, Bool, Bool)] = siteImage ? [("site-menu", "demo-week", "bar", .darkAqua, false, false)] : [
      ("normal-bar", "normal-usage", "bar", .aqua, false, false),
      ("normal-text", "normal-usage", "text", .aqua, false, false),
      ("normal-off", "normal-usage", "off", .aqua, false, false),
      ("one-pause", "manual-pause", "bar", .aqua, false, false),
      ("missing-setup", "missing-setup", "bar", .aqua, false, false),
      ("pacing-text", "pacing-text", "text", .aqua, false, false),
      ("scoped-stop", "scoped-stop", "bar", .aqua, false, false),
      ("daily-exhausted", "daily-exhausted", "bar", .aqua, false, false),
      ("suggestion-pause", "suggestion-pause", "bar", .aqua, false, false),
      ("dark", "normal-usage", "bar", .darkAqua, false, false),
      ("normal-after-pause", "normal-usage", "bar", .aqua, false, false),
      ("high-contrast-simulated", "normal-usage", "bar", .accessibilityHighContrastAqua, true, false),
      ("reduce-transparency-simulated", "normal-usage", "bar", .aqua, false, true),
      ("weekly-recap", "weekly-recap", "bar", .aqua, false, false),
    ]
    init(delegate: AppDelegate) { self.delegate = delegate; store = delegate.store }
    func start() {
      checkpoint("startup")
      if siteImage { store.previewLabelHidden = true }
      delegate.probe.write(["startupTitledWindowCount": NSApp.windows.filter { $0.isVisible && $0.styleMask.contains(.titled) }.count], name: "menu-startup")
      next()
    }
    func next() {
      guard caseIndex < cases.count else { siteImage ? finishSite() : finishWindows(); return }
      let (name, fixture, style, appearance, contrast, transparency) = cases[caseIndex]
      checkpoint("prepare-" + name)
      do {
        let raw = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: delegate.options.fixtureDirectory.appendingPathComponent(fixture + ".json")))
        let settings = PresentationChecks.replacing(raw["settings"], "weeklyStyle", .string(style))
        let scenario = PresentationChecks.replacing(raw, "settings", settings)
        store.apply(try Snapshot.decode(JSONEncoder().encode(scenario)))
        store.previewHighContrast = contrast
        store.previewReduceTransparency = transparency
        delegate.desktop?.activeWindow?.appearance = NSAppearance(named: appearance)
        delegate.open()
        delegate.later(0.4) { self.capture(name: name, fixture: fixture, style: style, appearance: appearance.rawValue) }
      } catch {
        rows.append(["case": name, "ok": false, "reason": "scenario_decode_failed"])
        caseIndex += 1; delegate.later(0.1) { self.next() }
      }
    }
    func canvases(_ root: NSView) -> [SpriteCanvas] {
      if let canvas = root as? SpriteCanvas { return [canvas] }
      return root.subviews.flatMap(canvases)
    }
    func captionViews(_ root: NSView) -> [VisibleCaptionView] {
      if let view = root as? VisibleCaptionView { return [view] }
      return root.subviews.flatMap(captionViews)
    }
    func renderRail(_ canvas: SpriteCanvas, scale: CGFloat) -> CGImage? {
      guard let window = canvas.window, window.isVisible, window.occlusionState.contains(.visible),
        !canvas.isHiddenOrHasHiddenAncestor, !canvas.visibleRect.isEmpty else { return nil }
      canvas.needsDisplay = true; canvas.displayIfNeeded()
      let size = canvas.bounds.size
      guard let context = CGContext(data: nil, width: Int(size.width * scale), height: Int(size.height * scale), bitsPerComponent: 8,
        bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
      context.translateBy(x: 0, y: size.height * scale); context.scaleBy(x: scale, y: -scale); context.interpolationQuality = .none
      canvas.layer?.render(in: context)
      return context.makeImage()
    }
    func saveValidated(_ image: CGImage, name: String, method: String) -> Bool {
      let width = image.width, height = image.height
      var bytes = [UInt8](repeating: 0, count: width * height * 4)
      let inspected = bytes.withUnsafeMutableBytes { memory -> Bool in
        guard let context = CGContext(data: memory.baseAddress, width: width, height: height,
          bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height)); return true
      }
      var nontransparent = 0, varied = 0, yellow = 0, red = 0
      if inspected {
        let reference = Array(bytes.prefix(3))
        for i in stride(from: 0, to: bytes.count, by: 4) {
          if bytes[i + 3] > 0 { nontransparent += 1 }
          if bytes[i] > 220 && bytes[i + 1] > 185 && bytes[i + 2] < 80 { yellow += 1 }
          if bytes[i] > 180 && bytes[i + 1] < 110 && bytes[i + 2] < 110 { red += 1 }
          if bytes[i + 3] > 0 && (0..<3).contains(where: { abs(Int(bytes[i + $0]) - Int(reference[$0])) > 12 }) { varied += 1 }
        }
      }
      let unsupportedGraphic = yellow > 500 && red > 100
      let valid = inspected && nontransparent > 500 && varied > 100 && !unsupportedGraphic
      imageReports.append(["name": name, "width": width, "height": height, "nontransparentPixels": nontransparent,
        "pixelsDifferentFromCorner": varied, "unsupportedGraphicSuspected": unsupportedGraphic, "nonblank": valid, "method": method,
        "validationLimit": "Rejects transparent/uniform exports; readable text and visual fidelity still require visual review."])
      guard let bitmap = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { checkpoint("image-" + name, failure: "PNG encoding failed"); return false }
      do { try bitmap.write(to: delegate.probe.directory.appendingPathComponent(name + ".png")) }
      catch { checkpoint("image-" + name, failure: "PNG write failed"); return false }
      checkpoint("image-" + name, failure: valid ? nil : "transparent_uniform_or_unsupported_export")
      return valid
    }
    func writeImage<Content: View>(_ content: Content, size: CGSize, name: String, dark: Bool) -> Bool {
      checkpoint("render-shared-content-" + name)
      let renderer = ImageRenderer(content: content.frame(width: size.width, height: size.height)
        .background(dark ? Color(white: 0.12) : Color(nsColor: .windowBackgroundColor)).environment(\.displayScale, 2)
        .environment(\.colorScheme, dark ? .dark : .light)
        .preferredColorScheme(dark ? .dark : .light))
      renderer.scale = 2
      guard let image = renderer.cgImage else { checkpoint("render-shared-content-" + name, failure: "ImageRenderer returned no image"); return false }
      return saveValidated(image, name: name, method: "Shared menu content without ScrollView; actual visible rail layers injected into export-only SwiftUI copy")
    }
    func writeOwnedView(_ view: NSView?, name: String) -> Bool {
      checkpoint("print-owned-view-" + name)
      guard let view, let window = view.window, window.isVisible, window.occlusionState.contains(.visible) else {
        checkpoint("print-owned-view-" + name, failure: "owned_window_not_visible_unoccluded"); return false
      }
      view.layoutSubtreeIfNeeded()
      view.needsDisplay = true; view.displayIfNeeded()
      if let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
        view.cacheDisplay(in: view.bounds, to: bitmap)
        if let image = bitmap.cgImage, saveValidated(image, name: name + "-cache", method: "Actual visible owned NSView.cacheDisplay; no desktop or CGWindow capture") {
          if name == "setup" {
            imageReports[imageReports.count - 1]["readableTextVerified"] = false
            imageReports[imageReports.count - 1]["visualFailure"] = "Owned-view cache omits checklist text; requires direct-app visual review"
            checkpoint("image-" + name, failure: "incomplete_cached_text")
            return false
          }
          return true
        }
      }
      let data = view.dataWithPDF(inside: view.bounds)
      do { try data.write(to: delegate.probe.directory.appendingPathComponent(name + ".pdf")) }
      catch { checkpoint("print-owned-view-" + name, failure: "owned PDF write failed"); return false }
      guard let provider = CGDataProvider(data: data as CFData), let document = CGPDFDocument(provider), let page = document.page(at: 1) else {
        checkpoint("print-owned-view-" + name, failure: "owned PDF did not contain a page"); return false
      }
      let rect = page.getBoxRect(.mediaBox)
      guard rect.width > 0, rect.height > 0,
        let context = CGContext(data: nil, width: Int(rect.width * 2), height: Int(rect.height * 2), bitsPerComponent: 8, bytesPerRow: 0,
          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
      context.setFillColor(NSColor.windowBackgroundColor.cgColor); context.fill(CGRect(x: 0, y: 0, width: rect.width * 2, height: rect.height * 2))
      context.scaleBy(x: 2, y: 2); context.translateBy(x: -rect.minX, y: -rect.minY); context.drawPDFPage(page)
      guard let image = context.makeImage() else { return false }
      return saveValidated(image, name: name, method: "Actual visible owned NSView.dataWithPDF content rasterized at2x; no desktop or CGWindow capture")
    }
    func capture(name: String, fixture: String, style: String, appearance: String) {
      guard let desktop = delegate.desktop, let window = desktop.activeWindow else { rows.append(["case": name, "ok": false, "reason": "no_owned_window"]); caseIndex += 1; delegate.later(0.1) { self.next() }; return }
      let canvasViews = canvases(desktop.controller.view)
      var images = [String: CGImage]()
      var layerMetadata = [[String: Any]]()
      for canvas in canvasViews {
        if let image = renderRail(canvas, scale: 2) { images[canvas.providerID] = image }
        let directory = delegate.probe.directory.appendingPathComponent(name + "-" + canvas.providerID)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        canvas.exportLayerProof(to: directory)
        layerMetadata.append(["provider": canvas.providerID, "actualBackingScale": canvas.window?.backingScaleFactor ?? 0,
          "trackWidth": canvas.bounds.width, "trackHeight": canvas.bounds.height])
      }
      if name == "weekly-recap", let snapshot = store.snapshot, let provider = snapshot.providers.first,
        let recap = WeeklyRecap(provider, generatedAtMs: snapshot.generatedAtMs, nowMs: snapshot.generatedAtMs) {
        let visible = captionViews(desktop.controller.view).contains { $0.actuallyVisible }
        let seen = store.recapCoordinator.hasSeen(recap)
        let file = delegate.instance.root.appendingPathComponent("native/recap-seen-preview.json")
        let persisted = (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(Set<String>.self, from: $0) }?.contains(recap.ledgerKey) == true
        recapLifecycle["actualCaptionVisible"] = visible
        recapLifecycle["visibleCaptionConsumed"] = seen
        recapLifecycle["previewSeenPersisted"] = persisted
        store.apply(snapshot)
        recapLifecycle["repeatedSnapshotKeepsCurrentCaption"] = store.recap(provider) != nil
        recapLifecycle["recapNeverTriggersGreeting"] = store.actors.allSatisfy { $0.reaction?.kind != "greet" }
      }
      let measuredHeight = store.menuContentHeight
      let exported = writeImage(ContentView(store: store, railImages: images, measuresLayout: false).menu.tint(PearPalette.color).environment(\.menuHighContrastOverride, store.previewHighContrast),
        size: CGSize(width: 320, height: measuredHeight), name: name, dark: appearance == NSAppearance.Name.darkAqua.rawValue)
      let count = store.snapshot?.providers.count ?? 0
      rows.append(["case": name, "sourceFixture": fixture, "derivedWeeklyStyle": style,
        "ok": exported && images.count == count && window.isVisible && window.occlusionState.contains(.visible),
        "measuredNaturalHeight": measuredHeight, "actualContentWidth": desktop.controller.view.bounds.width,
        "actualContentHeight": desktop.controller.view.bounds.height, "scrollFallback": store.menuViewportHeight < measuredHeight - 1,
        "windowVisible": window.isVisible, "windowUnoccluded": window.occlusionState.contains(.visible),
        "rails": layerMetadata, "appearance": appearance, "capturedRailCount": images.count,
        "accessibilityLabels": (store.snapshot?.providers ?? []).map { CompactProvider(provider: $0).fullDetails },
        "method": "Same SwiftUI ContentView rendered with its actual visible owned CALayer rail images injected into an export-only copy; actual window geometry measured separately. Not a desktop/window screenshot or cold-latency measurement."])
      checkpoint("captured-" + name)
      caseIndex += 1; delegate.later(0.1) { self.next() }
    }
    // The menu bar title as the app draws it in Pear + usage, in dark mode, at 2x.
    func finishSite() {
      var written = false
      if let snapshot = store.snapshot {
        let title = StatusItemAppearance.usageTitle(snapshot), pear = StatusItemAppearance.pear
        let size = CGSize(width: pear.size.width + 4 + ceil(title.size().width), height: 22)
        let image = NSImage(size: size, flipped: false) { _ in
          NSAppearance(named: .darkAqua)!.performAsCurrentDrawingAppearance {
            pear.draw(in: CGRect(x: 0, y: (size.height - pear.size.height) / 2, width: pear.size.width, height: pear.size.height))
            title.draw(at: CGPoint(x: pear.size.width + 4, y: (size.height - title.size().height) / 2))
          }
          return true
        }
        if let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * 2), pixelsHigh: Int(size.height * 2), bitsPerSample: 8,
          samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) {
          rep.size = size
          NSGraphicsContext.saveGraphicsState()
          NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
          image.draw(in: CGRect(origin: .zero, size: size))
          NSGraphicsContext.restoreGraphicsState()
          if let data = rep.representation(using: .png, properties: [:]) {
            written = (try? data.write(to: delegate.probe.directory.appendingPathComponent("site-title.png"))) != nil
          }
        }
      }
      delegate.probe.write(["complete": true, "siteImage": true, "titleWritten": written, "cases": rows, "images": imageReports, "exportFailures": exportFailures], name: "menu-probe")
      NSApp.terminate(nil)
    }
    func finishWindows() {
      checkpoint("transfer-and-hidden-checks")
      guard let desktop = delegate.desktop else { return }
      let host = desktop.controller.host
      let travel = store.actors.map(\.travel)
      let phase = store.logicalNow
      desktop.pin()
      let retainedPin = travel == store.actors.map(\.travel) && phase == store.logicalNow
      desktop.unpin()
      let retainedUnpin = travel == store.actors.map(\.travel) && phase == store.logicalNow
      delegate.close(reason: "menu_probe_hidden_check")
      delegate.later(0.4) {
        let ticks = self.store.ticks
        let hidden = !self.store.visible && desktop.activeWindow?.isVisible != true
        self.delegate.later(0.2) {
          let hiddenStopped = hidden && !self.store.visible && self.store.timer == nil && ticks == self.store.ticks
          self.verifyRecapLifecycle {
            self.openSettingsAndExport(host: host, retainedPin: retainedPin, retainedUnpin: retainedUnpin, hiddenStopped: hiddenStopped)
          }
        }
      }
    }
    func verifyRecapLifecycle(completion: @escaping () -> Void) {
      guard let snapshot = store.snapshot, let provider = snapshot.providers.first else { completion(); return }
      recapLifecycle["closeClearsCaption"] = store.recap(provider) == nil
      delegate.open()
      delegate.later(0.3) {
        self.recapLifecycle["reopenCannotReplaySeenID"] = self.store.recap(provider) == nil && self.captionViews(self.delegate.desktop!.controller.view).isEmpty
        self.store.refreshAtTimeBoundary()
        self.recapLifecycle["wakeCannotReplaySeenID"] = self.store.recap(provider) == nil
        var providers = snapshot.providers.map(\.payload)
        providers[0] = PresentationChecks.replacing(providers[0], "accountContextId", .string("ctx_MENU_PROBE_SECOND_ACCOUNT"))
        let raw = PresentationChecks.replacing(snapshot.raw, "providers", .array(providers))
        do { self.store.apply(try Snapshot.decode(JSONEncoder().encode(raw))) }
        catch { self.recapLifecycle["newAccountAccepted"] = false }
        self.delegate.later(0.3) {
          let other = self.store.snapshot?.providers.first
          let candidate = other.flatMap { WeeklyRecap($0, generatedAtMs: snapshot.generatedAtMs, nowMs: snapshot.generatedAtMs) }
          self.recapLifecycle["newAccountSameIDHasOwnVisibleCaption"] = candidate.map { self.store.recapCoordinator.hasSeen($0) } == true && self.captionViews(self.delegate.desktop!.controller.view).contains { $0.actuallyVisible }
          self.store.apply(snapshot)
          self.delegate.later(0.2) {
            self.recapLifecycle["returnToOldAccountCannotReplay"] = self.store.recap(provider) == nil
            self.delegate.close(reason: "recap_probe_finished")
            self.delegate.later(0.4) {
              self.recapLifecycle["allChecksPassed"] = self.recapLifecycle.values.compactMap { $0 as? Bool }.allSatisfy { $0 }
              self.delegate.probe.write(self.recapLifecycle, name: "recap-lifecycle")
              completion()
            }
          }
        }
      }
    }
    func openSettingsAndExport(host: NSHostingController<ContentView>, retainedPin: Bool, retainedUnpin: Bool, hiddenStopped: Bool) {
      let storeIdentity = ObjectIdentifier(store)
      let bridge = store.bridge
      store.settingsSelectedTab = "general"
      checkpoint("open-settings-route")
      let settingsSent = NativeSceneRuntime.openSettings()
      delegate.later(0.5) {
        let titled = NSApp.windows.filter { $0.isVisible && $0.styleMask.contains(.titled) }
        let settings = titled.first
        settings?.makeKeyAndOrderFront(nil)
        let settingsExport = self.writeOwnedView(settings?.contentView, name: "settings-general")
        let sceneShared = SettingsSceneEvidence.store === self.store
        let actualSettingsSize = settings?.contentView?.bounds.size ?? .zero
        settings?.makeKeyAndOrderFront(nil)
        self.store.settingsSelectedTab = "notifications"
        self.delegate.later(0.2) {
          let noticesExport = self.writeOwnedView(settings?.contentView, name: "settings-notifications")
          self.store.settingsSelectedTab = "more"
          self.delegate.later(0.2) {
            let moreExport = self.writeOwnedView(settings?.contentView, name: "settings-more")
            settings?.performClose(nil)
            self.delegate.auxiliary?.showSetup()
            self.delegate.later(0.3) {
              let setup = self.delegate.auxiliary?.setup?.window
              let setupExport = self.writeOwnedView(setup?.contentView, name: "setup")
              self.delegate.auxiliary?.showDiagnostics()
              self.delegate.later(0.2) {
                let diagnostics = self.delegate.auxiliary?.diagnostics?.window
                self.delegate.probe.write([
                  "complete": true, "ok": self.rows.allSatisfy { $0["ok"] as? Bool == true } && settingsExport && noticesExport && moreExport && setupExport && hiddenStopped,
                  "stage": "finished", "recapLifecycle": self.recapLifecycle, "images": self.imageReports, "exportFailures": self.exportFailures,
                  "cases": self.rows,
                  "normalHeightWithin360": (self.rows.first { $0["case"] as? String == "normal-bar" }?["measuredNaturalHeight"] as? CGFloat ?? 999) <= 360,
                  "settingsActionSent": settingsSent, "settingsWindowVisible": settings != nil,
                  "settingsSceneObservedSameStore": sceneShared, "oneSettingsWindow": titled.count == 1,
                  "settingsActualWidth": actualSettingsSize.width, "settingsActualHeight": actualSettingsSize.height,
                  "settingsImageExported": settingsExport, "notificationsImageExported": noticesExport, "moreImageExported": moreExport,
                  "setupImageExported": setupExport,
                  "setupActualWidth": setup?.contentView?.bounds.width ?? 0, "setupActualHeight": setup?.contentView?.bounds.height ?? 0,
                  "setupSeparateWindow": setup != nil && setup !== settings,
                  "diagnosticsSeparateWindow": diagnostics != nil && diagnostics !== setup && diagnostics !== settings,
                  "sameOwnerStore": ObjectIdentifier(self.delegate.store) == storeIdentity,
                  "sameHostAcrossTransfer": self.delegate.desktop?.controller.host === host,
                  "phaseRetainedAtPin": retainedPin, "phaseRetainedAtUnpin": retainedUnpin,
                  "hiddenTicksStopped": hiddenStopped,
                  "sameBridgeObject": bridge == nil ? self.store.bridge == nil : self.store.bridge === bridge,
                  "bridgePresent": bridge != nil,
                  "accessibilitySimulation": "High contrast uses a local view override/App appearance; Reduce Transparency uses a local opaque background. Global OS preferences were not modified.",
                  "limitations": ["Physical keyboard, VoiceOver speech, multi-display/Spaces and real OS accessibility toggles remain manual QA."]
                ], name: "menu-probe")
                setup?.close(); diagnostics?.close(); NSApp.terminate(nil)
              }
            }
          }
        }
      }
    }
  }
}
