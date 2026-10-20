import AppKit
import SwiftUI

struct RecapCaption: View {
  let recap: WeeklyRecap
  @ObservedObject var store: FixtureStore
  var observesVisibility = true
  @State private var share: ShareController?
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(recap.caption).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      Button("Share Image…") {
        share?.close(); share = ShareController(recaps: [recap]); share?.show()
      }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(PearPalette.color).perasKeyboardButton()
    }.help(recap.privateHelp).accessibilityElement(children: .contain)
      .background { if observesVisibility { VisibleCaption { store.markRecapVisible(recap) } } }
      .id(recap.ledgerKey)
  }
}
// onAppear is insufficient inside a non-lazy ScrollView. Inspect the owned view's
// clipped visibleRect only after layout and on actual window/scroll notifications.
struct VisibleCaption: NSViewRepresentable {
  let visible: () -> Void
  func makeNSView(context: Context) -> VisibleCaptionView { VisibleCaptionView(visible: visible) }
  func updateNSView(_ view: VisibleCaptionView, context: Context) { view.callback = visible; view.scheduleCheck() }
}
final class VisibleCaptionView: NSView {
  var callback: () -> Void
  private var observers = [NSObjectProtocol]()
  init(visible: @escaping () -> Void) { callback = visible; super.init(frame: .zero) }
  required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    observers.forEach(NotificationCenter.default.removeObserver); observers.removeAll()
    if let window {
      observers.append(NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self] _ in self?.scheduleCheck() })
    }
    var ancestor = superview
    while let view = ancestor {
      if let clip = view as? NSClipView {
        clip.postsBoundsChangedNotifications = true
        observers.append(NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: clip, queue: .main) { [weak self] _ in self?.scheduleCheck() })
      }
      ancestor = view.superview
    }
    scheduleCheck()
  }
  override func layout() { super.layout(); scheduleCheck() }
  var actuallyVisible: Bool {
    window?.isVisible == true && window?.occlusionState.contains(.visible) == true
      && !isHiddenOrHasHiddenAncestor && bounds.width > 0 && bounds.height > 0
      && visibleRect.contains(bounds)
  }
  func scheduleCheck() { DispatchQueue.main.async { [weak self] in guard let self, self.actuallyVisible else { return }; self.callback() } }
  deinit { observers.forEach(NotificationCenter.default.removeObserver) }
}
