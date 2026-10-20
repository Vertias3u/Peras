import SwiftUI

// No app/snapshot/environment access: every rendered value crosses ShareModel first.
struct ShareCard: View {
  let model: ShareModel
  var body: some View {
    VStack(alignment: .leading, spacing: 25) {
      HStack {
        PerasPearMark().frame(width: 32, height: 32)
        Text("PERAS").font(.system(size: 17, weight: .bold, design: .rounded)).tracking(3)
        Spacer()
        Text(model.mode == .privateCard ? "PRIVATE CARD" : "READINGS INCLUDED")
          .font(.system(size: 10, weight: .semibold)).tracking(1)
      }
      Text(ShareModel.motto).font(.system(size: 43, weight: .bold, design: .rounded))
        .fixedSize(horizontal: false, vertical: true).frame(maxWidth: 490, alignment: .leading)
      if model.mode == .privateCard {
        VStack(alignment: .leading, spacing: 14) {
          Text("A little room for the rest of your week.").font(.system(size: 17))
          decorativeBar(0.38)
          decorativeBar(0.61)
          Text("Private by default · readings hidden").font(.system(size: 12))
        }
      } else {
        VStack(alignment: .leading, spacing: 9) {
          ForEach(Array(model.readings.enumerated()), id: \.offset) { _, reading in
            HStack {
              Text(reading.provider.title + " · " + reading.window.title)
              Spacer()
              Text(reading.used.map { PresentationText.number($0) + "%" } ?? "Not reported")
                .monospacedDigit()
              Text(reading.freshness.rawValue).foregroundStyle(.secondary)
            }.font(.system(size: 13, weight: .medium))
          }
        }
      }
      Spacer(minLength: 8)
      Text(ShareModel.canonicalURL).font(.system(size: 14, weight: .semibold))
    }.padding(42).frame(width: 600, height: 540, alignment: .topLeading)
      .foregroundStyle(Color(red: 0.13, green: 0.16, blue: 0.11))
      .background(Color(red: 0.96, green: 0.96, blue: 0.92))
      .environment(\.colorScheme, .light)
  }
  private func decorativeBar(_ fraction: Double) -> some View {
    ZStack(alignment: .leading) {
      Capsule().fill(Color.black.opacity(0.07))
      Capsule().fill(Color(red: 0.44, green: 0.60, blue: 0.28)).frame(width: 440 * fraction)
    }.frame(width: 440, height: 8)
  }
}

// Exact rectangles/palette from site/logo-light.svg (viewBox 0 -1 16 16).
struct PerasPearMark: View {
  var body: some View {
    Canvas { context, size in
      let scale = min(size.width, size.height) / 16
      let body = Color(red: 127 / 255, green: 169 / 255, blue: 51 / 255)
      let shine = Color(red: 183 / 255, green: 243 / 255, blue: 74 / 255)
      let stem = Color(red: 29 / 255, green: 35 / 255, blue: 30 / 255)
      let leaf = Color(red: 78 / 255, green: 107 / 255, blue: 18 / 255)
      let groups: [(Color, [[Double]])] = [
        (
          body,
          [
            [7, 3, 3, 1], [6, 4, 5, 2], [5, 6, 7, 1], [4, 7, 9, 1], [3, 8, 11, 4], [4, 12, 9, 1],
            [5, 13, 7, 1],
          ]
        ),
        (shine, [[5, 8, 1, 2]]), (stem, [[8, 1, 1, 2]]), (leaf, [[9, 1, 2, 1], [10, 0, 2, 1]]),
      ]
      for (color, rectangles) in groups {
        for rect in rectangles {
          context.fill(
            Path(
              CGRect(
                x: rect[0] * scale, y: (rect[1] + 1) * scale,
                width: rect[2] * scale, height: rect[3] * scale)), with: .color(color))
        }
      }
    }.accessibilityHidden(true)
  }
}
