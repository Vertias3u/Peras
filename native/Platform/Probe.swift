import AppKit
import QuartzCore

final class Probe {
  let directory: URL
  var openStarted: Double?
  var firstDrawMs: Double?
  var drawCount = 0
  var hiddenDraws = 0
  var openSequence = 0
  init(directory: URL) throws {
    self.directory = directory
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }
  func write(_ fields: [String: Any], name: String) {
    if let data = try? JSONSerialization.data(
      withJSONObject: fields, options: [.prettyPrinted, .sortedKeys])
    {
      try? data.write(to: directory.appendingPathComponent(name + ".json"), options: .atomic)
    }
  }
  func beginOpen() -> Double {
    openSequence += 1
    let now = CACurrentMediaTime()
    openStarted = now
    return now
  }
  func contentDrawn(_ view: NSView) {
    if firstDrawMs == nil && (view.window?.isVisible != true) { hiddenDraws += 1 }
    guard let start = openStarted, let window = view.window,
      window.isVisible, window.occlusionState.contains(.visible)
    else { return }
    drawCount += 1
    let elapsed = (CACurrentMediaTime() - start) * 1000
    openStarted = nil
    if firstDrawMs == nil { firstDrawMs = elapsed }
    write(
      [
        "visibleContentDrawMs": elapsed, "openSequence": openSequence,
        "firstVisibleContentDrawMs": firstDrawMs ?? elapsed, "windowVisible": window.isVisible,
        "windowUnoccluded": window.occlusionState.contains(.visible),
        "backingScale": window.backingScaleFactor,
        "method":
          "Sprite rail NSView.draw completion while real popover visible; not optical presentation latency",
        "hiddenDrawsBeforeVisibleContent": hiddenDraws,
        "startupViewLayoutPrepared": true,
        "snapshotReadyAtDraw": (view as? SpriteCanvas)?.store.snapshot != nil,
      ], name: openSequence == 1 ? "first-draw" : "warm-draw-\(openSequence)")
    // Capture after the drawing transaction, outside any steady-state measurement interval.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self, weak view] in
      guard let view, let root = view.window?.contentView,
        let bitmap = root.bitmapImageRepForCachingDisplay(in: root.bounds)
      else { return }
      root.cacheDisplay(in: root.bounds, to: bitmap)
      if let data = bitmap.representation(using: .png, properties: [:]) {
        try? data.write(
          to: self?.directory.appendingPathComponent("popover-content.png")
            ?? URL(fileURLWithPath: "/dev/null"))
      }
    }
  }
}
func cpuSeconds() -> Double {
  var usage = rusage()
  getrusage(RUSAGE_SELF, &usage)
  return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) + Double(
    usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
}
