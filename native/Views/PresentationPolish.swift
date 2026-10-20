import AppKit
import SwiftUI

// Presentation-only near band: five percentage points below an authoritative clear warn line.
// This never changes eligibility, schedules, stop evaluation or the underlying reading.
enum PearPalette {
  static let light = (0.28, 0.43, 0.10)
  static let dark = (0.57, 0.75, 0.31)
  static let highLight = (0.20, 0.33, 0.06)
  static let highDark = (0.72, 0.89, 0.48)
  // Native segmented controls own their white selected labels. This distinct
  // tint exceeds4.5:1 against white and3:1 against both reference panel schemes.
  static let segmented = (0.31, 0.46, 0.12)
  static var segmentedColor: Color { Color(red: segmented.0, green: segmented.1, blue: segmented.2) }
  static func components(dark: Bool, contrast: Bool) -> (Double, Double, Double) {
    contrast ? (dark ? highDark : highLight) : (dark ? Self.dark : light)
  }
  static let nsColor = NSColor(name: nil) { appearance in
    let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    let high = appearance.name == .accessibilityHighContrastAqua || appearance.name == .accessibilityHighContrastDarkAqua
    let c = components(dark: dark, contrast: high)
    return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
  }
  static var color: Color { Color(nsColor: nsColor) }
  // The main button: a ripe pear with a dark label in both schemes (the label is ≥ 7:1 on it).
  static let buttonFill = (0.66, 0.83, 0.36)
  static let buttonFillHigh = (0.55, 0.74, 0.24)
  static let buttonLabel = (0.09, 0.13, 0.03)
  static var buttonLabelColor: Color { Color(red: buttonLabel.0, green: buttonLabel.1, blue: buttonLabel.2) }
  static func buttonFillColor(high: Bool) -> Color {
    let c = high ? buttonFillHigh : buttonFill
    return Color(red: c.0, green: c.1, blue: c.2)
  }
  static func luminance(_ rgb: (Double, Double, Double)) -> Double {
    func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(rgb.0) + 0.7152 * linear(rgb.1) + 0.0722 * linear(rgb.2)
  }
  static func contrast(_ a: (Double, Double, Double), _ b: (Double, Double, Double)) -> Double {
    let x = luminance(a), y = luminance(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)
  }
  static func contrast(_ rgb: (Double, Double, Double), background: Double) -> Double {
    func linear(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
    let l = 0.2126 * linear(rgb.0) + 0.7152 * linear(rgb.1) + 0.0722 * linear(rgb.2)
    let b = linear(background)
    return (max(l, b) + 0.05) / (min(l, b) + 0.05)
  }
}
// Each agent's own colour (the same as 0.3's menu bar and the mascots) fills its five-hour bar.
// Colour says who; the % number, the warning tick and a grey bar when paused say what.
enum BrandPalette {
  static let claude = (light: (0.85, 0.47, 0.34), high: (0.70, 0.33, 0.20), highDark: (0.94, 0.60, 0.48))
  static let codex = (light: (0.43, 0.60, 0.98), high: (0.22, 0.42, 0.85), highDark: (0.62, 0.75, 1.0))
  static func components(_ provider: String, dark: Bool, contrast: Bool) -> (Double, Double, Double) {
    let palette = provider == "codex" ? codex : claude
    return contrast ? (dark ? palette.highDark : palette.high) : palette.light
  }
  static func nsColor(_ provider: String) -> NSColor {
    NSColor(name: nil) { appearance in
      let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      let high = appearance.name == .accessibilityHighContrastAqua || appearance.name == .accessibilityHighContrastDarkAqua
      let c = components(provider, dark: dark, contrast: high)
      return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
    }
  }
}
struct PearButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) var enabled
  @Environment(\.colorSchemeContrast) var contrast
  @Environment(\.menuHighContrastOverride) var simulatedContrast
  func makeBody(configuration: Configuration) -> some View {
    let high = contrast == .increased || simulatedContrast
    configuration.label.font(.system(size: 11, weight: .semibold)).foregroundStyle(PearPalette.buttonLabelColor)
      .padding(.horizontal, 10).frame(height: 22)
      .background(RoundedRectangle(cornerRadius: 6).fill(PearPalette.buttonFillColor(high: high)).brightness(configuration.isPressed ? -0.08 : 0))
      .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.black.opacity(high ? 0.45 : 0.12), lineWidth: 0.5))
      .opacity(enabled ? 1 : 0.5).contentShape(Rectangle())
  }
}
struct UsageNumber: View {
  let text: String
  let value: Double?
  let animated: Bool
  var body: some View {
    Text(text).font(.system(size: 15, weight: .semibold, design: .rounded)).monospacedDigit()
      .contentTransition(animated ? .numericText() : .identity)
      .animation(animated ? .easeInOut(duration: 0.24) : nil, value: value)
  }
}
struct FiniteSymbol: View {
  let name: String
  let value: Bool
  let animate: Bool
  var bounces = true
  var body: some View {
    if #available(macOS 14.0, *), animate {
      if bounces {
        Image(systemName: name).symbolEffect(.bounce, options: .nonRepeating, value: value)
      } else {
        Image(systemName: name).contentTransition(.symbolEffect(.replace))
          .animation(.easeInOut(duration: 0.2), value: value)
      }
    } else { Image(systemName: name) }
  }
}
struct SetupProgress: View {
  let steps: [SetupStep]
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("\(steps.filter(\.complete).count) of \(steps.count) done").font(.system(size: 12, weight: .semibold))
      HStack(spacing: 4) {
        ForEach(steps) { step in
          Circle().fill(step.complete ? PearPalette.color : Color.clear).frame(width: 7, height: 7)
            .overlay(Circle().stroke(step.complete ? Color.clear : Color.secondary.opacity(0.6), lineWidth: 1))
        }
      }.padding(.vertical, 1).accessibilityHidden(true)
    }.accessibilityLabel("Setup: \(steps.filter(\.complete).count) of \(steps.count) steps complete")
  }
}

// Narrow own-window observation keeps finite setup symbol effects off hidden content.
struct OwnedWindowVisibility: NSViewRepresentable {
  let changed: (Bool) -> Void
  func makeNSView(context: Context) -> OwnVisibilityView { OwnVisibilityView(changed: changed) }
  func updateNSView(_ view: OwnVisibilityView, context: Context) { view.changed = changed }
}
final class OwnVisibilityView: NSView {
  var changed: (Bool) -> Void
  private var observers = [NSObjectProtocol]()
  init(changed: @escaping (Bool) -> Void) { self.changed = changed; super.init(frame: .zero) }
  required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    observers.forEach(NotificationCenter.default.removeObserver); observers.removeAll()
    if let window {
      for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification, NSWindow.willCloseNotification] {
        observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] note in
          self?.publish(closing: note.name == NSWindow.willCloseNotification)
        })
      }
    }
    publish()
  }
  private func publish(closing: Bool = false) {
    let visible = !closing && window?.isVisible == true && window?.occlusionState.contains(.visible) == true
    DispatchQueue.main.async { [weak self] in self?.changed(visible) }
  }
  deinit { observers.forEach(NotificationCenter.default.removeObserver) }
}
