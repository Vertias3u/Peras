import AppKit

// Explicit deterministic owned-layer diagnosis. The first two exports do NOT force
// drawing; the third deliberately does, to distinguish invalidation from compositing.
enum RailRepaintProbe {
  static func run(delegate: AppDelegate) {
    do {
      let data = try Data(contentsOf: delegate.options.fixtureDirectory.appendingPathComponent("manual-pause.json"))
      let paused = try Snapshot.decode(data)
      var providers = paused.providers.map(\.payload)
      providers[0] = PresentationChecks.replacing(providers[0], "verdict", .object(["action": .string("none")]))
      providers[0] = PresentationChecks.replacing(providers[0], "reasons", .array([]))
      let resumed = try Snapshot.decode(JSONEncoder().encode(PresentationChecks.replacing(paused.raw, "providers", .array(providers))))
      var readingProviders = resumed.providers.map(\.payload)
      let readingWindows = readingProviders[0]["windows"].array.map { row in
        row["window"].string == "five_hour" ? PresentationChecks.replacing(row, "used", .number(72)) : row
      }
      readingProviders[0] = PresentationChecks.replacing(readingProviders[0], "windows", .array(readingWindows))
      let changedReading = try Snapshot.decode(JSONEncoder().encode(PresentationChecks.replacing(resumed.raw, "providers", .array(readingProviders))))
      delegate.store.reducedOverride = true
      delegate.store.apply(paused)
      delegate.open()
      var phases = [[String: Any]]()
      func canvases(_ root: NSView) -> [SpriteCanvas] {
        if let canvas = root as? SpriteCanvas { return [canvas] }
        return root.subviews.flatMap(canvases)
      }
      @discardableResult func capture(_ name: String, force: Bool) -> [[String: Any]] {
        guard let desktop = delegate.desktop else { return [] }
        var rows = [[String: Any]]()
        for canvas in canvases(desktop.controller.view) {
          if force { canvas.needsDisplay = true; canvas.displayIfNeeded() }
          let directory = delegate.probe.directory.appendingPathComponent(name + "-" + canvas.providerID)
          try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
          canvas.exportLayerProof(to: directory)
          let data = try? Data(contentsOf: directory.appendingPathComponent("layer-render-2x.png"))
          let bitmap = data.flatMap(NSBitmapImageRep.init(data:))
          let color = bitmap?.colorAt(x: 6, y: 50)?.usingColorSpace(.sRGB)
          let farColor = bitmap?.colorAt(x: 200, y: 50)?.usingColorSpace(.sRGB)
          let farRGBA = farColor.map { [$0.redComponent, $0.greenComponent, $0.blueComponent, $0.alphaComponent].map { Int(($0 * 255).rounded()) } } ?? []
          let rgba = color.map { [$0.redComponent, $0.greenComponent, $0.blueComponent, $0.alphaComponent].map { Int(($0 * 255).rounded()) } } ?? []
          let provider = delegate.store.snapshot?.providers.first { $0.id == canvas.providerID }
          rows.append(["provider": canvas.providerID, "actualSampleRGBA": rgba,
            "samplePixel": [6, 50], "farSamplePixel": [200, 50], "actualFarSampleRGBA": farRGBA,
            "canvasWidth": canvas.bounds.width, "canvasHeight": canvas.bounds.height,
            "reportedUsage": provider.flatMap { CompactProvider(provider: $0).window.used }.map { $0 as Any } ?? NSNull(), "modelTone": provider.map { CompactProvider(provider: $0).fillTone } ?? "missing",
            "verdict": provider?.payload["verdict"]["action"].string ?? "missing",
            "ownedWindowVisible": canvas.window?.isVisible == true,
            "ownedWindowUnoccluded": canvas.window?.occlusionState.contains(.visible) == true])
        }
        phases.append(["phase": name, "forcedDraw": force, "rows": rows])
        delegate.probe.write(["complete": false, "phases": phases], name: "rail-repaint-probe")
        return rows
      }
      delegate.later(0.5) {
        let before = capture("paused-natural", force: false)
        delegate.store.apply(resumed)
        delegate.later(0.5) {
          let after = capture("resumed-natural", force: false)
          let forced = capture("resumed-forced-redraw", force: true)
          delegate.store.apply(changedReading)
          delegate.later(0.5) {
            let reading = capture("reading72-natural", force: false)
            let forcedReading = capture("reading72-forced-redraw", force: true)
            func color(_ rows: [[String: Any]], far: Bool = false, provider: String = "claude") -> [Int]? {
              rows.first { $0["provider"] as? String == provider }?[far ? "actualFarSampleRGBA" : "actualSampleRGBA"] as? [Int]
            }
            let checks: [String: Bool] = [
              "pauseToResumeColorChangedNaturally": color(before) != color(after),
              "resumeNaturalEqualsForcedReference": color(after) == color(forced),
              "readingWidthChangedNaturally": color(after, far: true) != color(reading, far: true),
              "newFillReachesExpectedSample": color(reading, far: true) == color(reading),
              "readingNaturalEqualsForcedReference": color(reading, far: true) == color(forcedReading, far: true),
              "unchangedCodexRetainsColor": color(before, provider: "codex") == color(reading, provider: "codex"),
              "ownedViewsActuallyVisible": phases.allSatisfy { phase in
                guard let rows = phase["rows"] as? [[String: Any]], rows.count == 2 else { return false }
                return rows.allSatisfy { $0["ownedWindowVisible"] as? Bool == true && $0["ownedWindowUnoccluded"] as? Bool == true }
              },
              "sameCanvasGeometry": phases.allSatisfy { phase in
                (phase["rows"] as? [[String: Any]])?.allSatisfy { $0["canvasWidth"] as? CGFloat == 288 && $0["canvasHeight"] as? CGFloat == 28 } == true
              },
            ]
            delegate.probe.write(["complete": true, "ok": checks.values.allSatisfy { $0 }, "checks": checks, "phases": phases,
              "source": "Clearly native-derived read-only fixture: pause→resume at unchanged32%, then same-layout32→72 reading. No backend command.",
              "method": "Own cached layers; natural phases never invalidate/display. Explicit forced phases are reference-only, never cold/probe timing."], name: "rail-repaint-probe")
            NSApp.terminate(nil)
          }
        }
      }
    } catch {
      delegate.probe.write(["complete": false, "failure": "rail_probe_fixture_decode"], name: "rail-repaint-probe")
      NSApp.terminate(nil)
    }
  }
}
