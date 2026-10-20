import AppKit

enum StatusItemAppearance {
  // 0.3's pixel pear (src/menubar-image.mjs, from site/logo.svg): one point per pear pixel, so
  // each is 2×2 on Retina. Lime on a dark bar, the darker greens of site/logo-light.svg on a light one.
  static let pearPixels: [(part: String, rects: [(Int, Int, Int, Int)])] = [
    ("body", [(7, 3, 3, 1), (6, 4, 5, 2), (5, 6, 7, 1), (4, 7, 9, 1), (3, 8, 11, 4), (4, 12, 9, 1), (5, 13, 7, 1)]),
    ("shine", [(5, 8, 1, 2)]),
    ("stem", [(8, 1, 1, 2)]),
    ("leaf", [(9, 1, 2, 1), (10, 0, 2, 1)]),
  ]
  static let pearColors: [Bool: [String: (Int, Int, Int)]] = [
    true: ["body": (183, 243, 74), "shine": (228, 251, 184), "stem": (237, 241, 233), "leaf": (127, 169, 51)],
    false: ["body": (127, 169, 51), "shine": (183, 243, 74), "stem": (29, 35, 30), "leaf": (78, 107, 18)],
  ]
  // The body spans pixel rows 3–13; a filling pear colours its bottom rows and leaves the rest faint.
  static func filledRows(_ step: Int) -> Int { Int((11 * Double(step) / 8).rounded()) }
  static let frames: [NSImage] = (0...8).map { makeFrame($0, tone: nil) }
  static let pear = makeFrame(nil, tone: nil)
  private static var toned = [String: NSImage]()
  static func frame(_ step: Int, tone: String?) -> NSImage {
    guard let tone, tone == "indigo" || tone == "orange" else { return frames[step] }
    let key = tone + String(step)
    if let image = toned[key] { return image }
    let image = makeFrame(step, tone: tone); toned[key] = image
    return image
  }
  private static func makeFrame(_ step: Int?, tone: String?) -> NSImage {
    // Drawing-handler images redraw when the menu bar switches between light and dark.
    NSImage(size: NSSize(width: 11, height: 14), flipped: true) { _ in
      let dark = NSAppearance.currentDrawing().bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      let colors = pearColors[dark]!
      let firstFilled = 14 - filledRows(step ?? 8)
      for (part, rects) in pearPixels {
        let c = colors[part]!
        let base = NSColor(srgbRed: Double(c.0) / 255, green: Double(c.1) / 255, blue: Double(c.2) / 255, alpha: 1)
        for (x, y, w, h) in rects {
          for row in y..<(y + h) {
            var color = base
            if part == "body" || part == "shine", step != nil {
              if row < firstFilled { if part == "shine" { continue }; color = NSColor.labelColor.withAlphaComponent(0.25) }
              else if tone == "indigo" { color = .systemIndigo }
              else if tone == "orange" { color = .systemOrange }
            }
            color.setFill()
            NSRect(x: x - 3, y: row, width: w, height: 1).fill()
          }
        }
      }
      return true
    }
  }
  // Claude's mark keeps its orange, as in 0.3; the OpenAI mark is drawn in the menu bar's text colour.
  static let logos: [String: NSImage] = Dictionary(uniqueKeysWithValues: ["claude", "codex"].compactMap { id in
    guard let url = Bundle.main.resourceURL?.appendingPathComponent(id + "-logo.png"), let source = NSImage(contentsOf: url) else { return nil }
    // 32 px glyphs at 16 pt are 1:1 on Retina, so the marks stay as crisp as 0.3's.
    let size = NSSize(width: 16, height: 16)
    if id == "claude" { source.size = size; return (id, source) }
    let tinted = NSImage(size: size, flipped: false) { rect in
      source.draw(in: rect)
      NSColor.labelColor.set(); rect.fill(using: .sourceAtop)
      return true
    }
    return (id, tinted)
  })
  static func usageTitle(_ snapshot: Snapshot) -> NSAttributedString {
    let font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
    let title = NSMutableAttributedString()
    for (index, part) in SettingsPresentation.statusParts(snapshot).enumerated() {
      if index > 0 { title.append(NSAttributedString(string: "  ", attributes: [.font: font])) }
      if let logo = logos[part.provider] {
        let attachment = NSTextAttachment(); attachment.image = logo
        attachment.bounds = NSRect(x: 0, y: (font.capHeight - 16) / 2, width: 16, height: 16)
        title.append(NSAttributedString(attachment: attachment))
        title.append(NSAttributedString(string: " ", attributes: [.font: font]))
      } else {
        title.append(NSAttributedString(string: (part.provider == "claude" ? "C" : "X") + " ", attributes: [.font: font, .foregroundColor: NSColor.labelColor]))
      }
      title.append(NSAttributedString(string: part.value, attributes: [.font: font, .foregroundColor: NSColor.labelColor]))
    }
    return title
  }
  static func apply(_ button: NSStatusBarButton?, snapshot: Snapshot?, fixture: Bool, development: Bool = false) {
    guard let button else { return }
    let style = DisplayPresentation(raw: snapshot?.raw["settings"] ?? .null).style
    let fill = FillingPear(snapshot)
    let image = style == .fill ? frame(fill.step ?? 0, tone: fill.tone) : pear
    if button.image !== image { button.image = image }
    if button.contentTintColor != nil { button.contentTintColor = nil }
    button.imagePosition = .imageLeading
    let title = style == .usage ? snapshot.map(SettingsPresentation.statusTitle) ?? "" : ""
    let attributed = style == .usage ? snapshot.map(usageTitle) ?? NSAttributedString() : NSAttributedString()
    if !button.attributedTitle.isEqual(to: attributed) { button.attributedTitle = attributed }
    let label = LaunchPresentation.label(fixture: fixture, development: development)
    let mode = fixture ? "read-only fixture preview" : development ? "isolated demo with synthetic readings" : ""
    let detail = style == .fill ? ". " + fill.label : ""
    let tooltip = "Peras" + (mode.isEmpty ? "" : " · " + mode) + detail
    if button.toolTip != tooltip { button.toolTip = tooltip }
    button.setAccessibilityLabel("Peras" + (title.isEmpty ? "" : ", " + title) + detail + (label.map { ", " + $0 } ?? ""))
  }
}
