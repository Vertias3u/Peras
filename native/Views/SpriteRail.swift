import ImageIO
import QuartzCore
import SwiftUI

struct SpriteRail: NSViewRepresentable {
  @ObservedObject var store: FixtureStore
  var providerID = "claude"
  func makeNSView(context: Context) -> SpriteCanvas { SpriteCanvas(store: store, providerID: providerID) }
  func updateNSView(_ view: SpriteCanvas, context: Context) {
    view.updateRenderFacts()
    view.updateSprites()
  }
}
// Only facts painted into the static rail participate: no action tokens, revisions or timestamps.
private struct RailRowFacts: Equatable {
  let provider: String
  let value: String
  let freshness: String
  let used: Double?
  let fillTone: String
  let markers: [ConfiguredThreshold]
}
private struct RailRenderFacts: Equatable {
  let size: NSSize
  let rows: [RailRowFacts]
}
private struct SpriteLayerState: Equatable {
  var file: String
  var scale: CGFloat
  var bounds: CGRect
  var position: CGPoint
  var flipped: Bool
  var hidden: Bool
  var opacity: Float = 1
}
private final class ReadingBarAnimation: NSAnimation {
  let update: (Double) -> Void
  init(update: @escaping (Double) -> Void) {
    self.update = update
    super.init(duration: 0.24, animationCurve: .easeInOut)
    animationBlockingMode = .nonblocking
    frameRate = 60
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
  override var currentProgress: NSAnimation.Progress {
    get { super.currentProgress }
    set { super.currentProgress = newValue; update(Double(currentValue)) }
  }
}
final class SpriteCanvas: NSView {
  override var isFlipped: Bool { true }
  let store: FixtureStore
  let providerID: String
  private let renderID = UUID()
  private var actors: [Actor] { store.actors.filter { $0.provider == providerID } }
  private let pointsPerSourcePixel = 0.55
  private let rowHeight = 28.0
  private let spriteTop = 7.5
  private var sourceRailWidth: Double {
    max(Double(store.resources.atlas.width), Double(bounds.width) / pointsPerSourcePixel)
  }
  private var sprites = [CALayer]()
  private var cups = [CALayer]()
  private var spriteStates = [SpriteLayerState?]()
  private var cupStates = [SpriteLayerState?]()
  private var renderFacts: RailRenderFacts?
  private var barAnimation: ReadingBarAnimation?
  private var paintedFraction: Double?
  func updateRenderFacts() {
    let facts = RailRenderFacts(size: bounds.size, rows: actors.map { actor in
      let provider = store.snapshot?.providers.first { $0.id == actor.provider }
      let reading = provider?.windows.first { $0["window"].string == "five_hour" } ?? .null
      let window = WindowPresentation(reading, window: "five_hour")
      return RailRowFacts(provider: actor.provider, value: window.valueText,
        freshness: window.freshness, used: window.used, fillTone: provider.map { CompactProvider(provider: $0).fillTone } ?? "blue",
        markers: provider.map { ConfiguredThreshold.rows($0, window: "five_hour") } ?? [])
    })
    if facts != renderFacts {
      let before = renderFacts?.rows.first?.used
      let after = facts.rows.first?.used
      if before != after {
        barAnimation?.stop()
        let target = (after ?? 0) / 100
        if let before, after != nil, store.visible, !store.reduced, window?.isVisible == true,
          window?.occlusionState.contains(.visible) == true {
          let start = paintedFraction ?? before / 100
          let animation = ReadingBarAnimation { [weak self] progress in
            guard let self else { return }
            guard self.store.visible && !self.store.reduced else {
              self.barAnimation?.stop(); self.paintedFraction = target; return
            }
            self.paintedFraction = start + (target - start) * progress
            self.needsDisplay = true
          }
          barAnimation = animation; animation.start()
        } else { paintedFraction = target }
      }
      renderFacts = facts; needsDisplay = true
    }
  }
  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    needsDisplay = true
  }
  init(store: FixtureStore, providerID: String = "claude") {
    self.store = store
    self.providerID = providerID
    super.init(frame: NSRect(x: 0, y: 0, width: 288, height: 28))
    wantsLayer = true
    for _ in actors {
      let sprite = CALayer()
      let cup = CALayer()
      for l in [sprite, cup] {
        l.magnificationFilter = .nearest
        l.minificationFilter = .nearest
        l.allowsEdgeAntialiasing = false
        layer?.addSublayer(l)
      }
      sprites.append(sprite)
      cups.append(cup)
      spriteStates.append(nil)
      cupStates.append(nil)
    }
    store.renderObservers[renderID] = { [weak self] in self?.updateSprites() }
    updateRenderFacts()
    updateSprites()
  }
  deinit { barAnimation?.stop(); store.renderObservers.removeValue(forKey: renderID) }
  required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
  override func viewDidChangeBackingProperties() {
    super.viewDidChangeBackingProperties()
    updateSprites()
  }
  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    guard let provider = store.snapshot?.providers.first(where: { $0.id == providerID }) else {
      drawTrack(window: WindowPresentation(.null, window: "five_hour"), provider: nil)
      DrawObserver.shared.canvas = self
      #if !PERAS_PRODUCTION
      DrawObserver.shared.probe?.contentDrawn(self)
      #endif
      return
    }
    drawTrack(window: CompactProvider(provider: provider).window, provider: provider)
    DrawObserver.shared.canvas = self
    #if !PERAS_PRODUCTION
    DrawObserver.shared.probe?.contentDrawn(self)
    #endif
  }
  private func drawTrack(window: WindowPresentation, provider: ProviderSnapshot?) {
    let track = NSRect(x: 0, y: 23, width: bounds.width, height: 4)
    NSColor.labelColor.withAlphaComponent(0.10).setFill()
    if window.used == nil {
      for x in stride(from: 0.0, to: Double(bounds.width), by: 10) {
        NSBezierPath(roundedRect: NSRect(x: x, y: 23, width: min(6, Double(bounds.width) - x), height: 4), xRadius: 2, yRadius: 2).fill()
      }
    } else {
      NSBezierPath(roundedRect: track, xRadius: 2, yRadius: 2).fill()
      let tone = provider.map { CompactProvider(provider: $0).fillTone } ?? "grey"
      let color: NSColor = tone == "indigo" ? NSColor.secondaryLabelColor.withAlphaComponent(0.35) : provider.map { BrandPalette.nsColor($0.id) } ?? .secondaryLabelColor
      color.withAlphaComponent(color.alphaComponent * (window.freshness == "stale" ? 0.5 : 1)).setFill()
      NSBezierPath(roundedRect: NSRect(x: 0, y: 23, width: bounds.width * (paintedFraction ?? window.fraction), height: 4), xRadius: 2, yRadius: 2).fill()
    }
    guard let provider else { return }
    for marker in ConfiguredThreshold.rows(provider, window: "five_hour") {
      let width = marker.action == "pause" ? 2.0 : 1.5
      let height = marker.action == "pause" ? 10.0 : marker.action == "ask" ? 9.0 : 8.0
      let x = max(0, min(Double(bounds.width) - width, Double(bounds.width) * marker.value / 100 - width / 2))
      let color = marker.action == "warn" && marker.evaluatedState == "crossed" ? NSColor.systemOrange
        : marker.action == "pause" ? NSColor.labelColor : NSColor.secondaryLabelColor
      color.withAlphaComponent(marker.outlined ? 0.35 : marker.conditional ? 0.55 : 1).setFill()
      NSBezierPath(roundedRect: NSRect(x: x, y: 28 - height, width: width, height: height), xRadius: 0.5, yRadius: 0.5).fill()
    }
  }
  #if !PERAS_PRODUCTION
  func exportLayerProof(to directory: URL) {
    let scale = 2.0
    let width = Int(bounds.width * scale)
    let height = Int(bounds.height * scale)
    guard
      let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let layer
    else { return }
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: scale, y: -scale)
    context.interpolationQuality = .none
    layer.render(in: context)
    guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(
        directory.appendingPathComponent("layer-render-2x.png") as CFURL, "public.png" as CFString,
        1, nil)
    else { return }
    CGImageDestinationAddImage(destination, image, nil)
    CGImageDestinationFinalize(destination)
    var rows = [[String: Any]]()
    var cupRows = [[String: Any]]()
    for (i, actor) in actors.enumerated() {
      let pose = actor.pose(store.resources.atlas, store.logicalNow, store.reduced, sourceRailWidth)
      let sprite = sprites[i]
      rows.append([
        "provider": actor.provider, "rail_points": Double(bounds.width), "file": pose.file,
        "flip": pose.flip,
        "pixel_x": (sprite.position.x - sprite.bounds.width / 2) * scale,
        "pixel_y": (sprite.position.y - sprite.bounds.height / 2) * scale,
        "pixel_width": sprite.bounds.width * scale, "pixel_height": sprite.bounds.height * scale,
      ])
      let cup = cups[i]
      cupRows.append([
        "provider": actor.provider, "rail_points": Double(bounds.width),
        "file": store.resources.atlas.providers[actor.provider]!.cup,
        "flip": cupStates[i]?.flipped ?? false, "opacity": cup.opacity,
        "pixel_x": cup.frame.minX * scale, "pixel_y": cup.frame.minY * scale,
        "pixel_width": cup.bounds.width * scale, "pixel_height": cup.bounds.height * scale,
      ])
    }
    let fields: [String: Any] = [
      "sprites": rows, "cups": cupRows,
      "presentation_points_per_source_pixel": pointsPerSourcePixel,
      "window_visible": window?.isVisible ?? false,
      "window_backing_scale": window?.backingScaleFactor ?? 0,
      "method": "Own Core Animation layer-tree export; not desktop or optical capture",
    ]
    if let data = try? JSONSerialization.data(
      withJSONObject: fields, options: [.prettyPrinted, .sortedKeys])
    {
      try? data.write(
        to: directory.appendingPathComponent("layer-render-info.json"), options: .atomic)
    }
  }
  #endif
  func updateSprites() {
    if !store.visible || store.reduced {
      barAnimation?.stop()
      paintedFraction = (renderFacts?.rows.first?.used ?? 0) / 100
    }
    let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
    let enabled = store.mascotsEnabled
    func snap(_ v: Double) -> Double { (v * scale).rounded() / scale }
    var transactionStarted = false
    func set(_ changed: Bool, _ assignment: () -> Void) {
      guard changed else { return }
      if !transactionStarted {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        transactionStarted = true
      }
      assignment()
    }
    func apply(_ next: SpriteLayerState, previous: SpriteLayerState?, layer: CALayer) {
      set(previous?.file != next.file) { layer.contents = store.resources.images[next.file] }
      set(previous?.scale != next.scale) { layer.contentsScale = next.scale }
      set(previous?.bounds != next.bounds) { layer.bounds = next.bounds }
      set(previous?.position != next.position) { layer.position = next.position }
      set(previous?.flipped != next.flipped) {
        layer.setAffineTransform(CGAffineTransform(scaleX: next.flipped ? -1 : 1, y: 1))
      }
      set(previous?.hidden != next.hidden) { layer.isHidden = next.hidden }
      set(previous?.opacity != next.opacity) { layer.opacity = next.opacity }
    }
    for (i, actor) in actors.enumerated() {
      let p = actor.pose(store.resources.atlas, store.logicalNow, store.reduced, sourceRailWidth)
      let used = store.fiveHourUsed(for: actor.provider)
      let known = used != nil
      let geometry = CompactSpriteLayout.make(usage: used,
        patrol: p.x / max(1, sourceRailWidth - Double(store.resources.atlas.width)),
        dy: p.dy, stretch: p.stretch, cupLift: p.cupLift, scale: scale, width: Double(bounds.width), provider: actor.provider)
      var sprite = SpriteLayerState(file: known ? p.file : store.resources.atlas.providers[actor.provider]!.idle.file,
        scale: scale, bounds: CGRect(origin: .zero, size: geometry.sprite.size),
        position: CGPoint(x: geometry.sprite.midX, y: geometry.sprite.midY),
        flipped: known && p.flip, hidden: !enabled, opacity: known ? 1 : 0.4)
      // Hidden layers retain geometry/content until they become visible again.
      if !enabled, let previous = spriteStates[i] { sprite = previous; sprite.hidden = true }
      if sprite != spriteStates[i] {
        apply(sprite, previous: spriteStates[i], layer: sprites[i])
        spriteStates[i] = sprite
      }
      var cup = SpriteLayerState(file: store.resources.atlas.providers[actor.provider]!.cup,
        scale: scale, bounds: CGRect(origin: .zero, size: geometry.cup.size),
        position: CGPoint(x: geometry.cup.midX, y: geometry.cup.midY),
        flipped: geometry.cupFlipped, hidden: !enabled || !known || p.cup == 0, opacity: Float(p.cup))
      if cup.hidden, let previous = cupStates[i] {
        cup = previous; cup.hidden = true; cup.opacity = 0
      }
      if cup != cupStates[i] {
        apply(cup, previous: cupStates[i], layer: cups[i])
        cupStates[i] = cup
      }
    }
    if transactionStarted { CATransaction.commit() }
  }
}
