import AppKit
import SwiftUI

// A fixed AppKit root keeps popover sizing independent of SwiftUI's changing
// ideal size and avoids a synchronous hosting-controller fitting pass on open.
final class PopoverController: NSViewController {
  let host: NSHostingController<ContentView>
  var hosting: NSView { host.view }
  init(store: FixtureStore) {
    host = NSHostingController(rootView: ContentView(store: store))
    super.init(nibName: nil, bundle: nil)
    let container = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 350))
    host.sizingOptions = []
    addChild(host)
    hosting.frame = container.bounds
    hosting.autoresizingMask = [.width, .height]
    container.addSubview(hosting)
    view = container
    hosting.layoutSubtreeIfNeeded()
  }
  func prepareLayout() {
    view.layoutSubtreeIfNeeded()
    hosting.layoutSubtreeIfNeeded()
  }
  // The first draw has not registered DrawObserver.canvas yet. Locate the already
  // constructed canvas and draw only after AppKit confirms a genuinely visible window.
  func displayVisibleCanvas() {
    guard let window = view.window, window.isVisible,
      window.occlusionState.contains(.visible), !view.isHiddenOrHasHiddenAncestor else { return }
    func findCanvas(_ candidate: NSView) -> SpriteCanvas? {
      if let canvas = candidate as? SpriteCanvas { return canvas }
      for child in candidate.subviews {
        if let canvas = findCanvas(child) { return canvas }
      }
      return nil
    }
    guard let canvas = findCanvas(view), canvas.window === window,
      !canvas.isHiddenOrHasHiddenAncestor, !canvas.visibleRect.isEmpty else { return }
    canvas.needsDisplay = true
    canvas.displayIfNeeded()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
}
