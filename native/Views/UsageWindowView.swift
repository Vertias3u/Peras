import SwiftUI

struct UsageWindowView: View {
  let window: WindowPresentation
  let markers: [ConfiguredThreshold]
  private var freshnessLabel: String {
    guard let reset = window.reset else { return window.freshnessText }
    return window.freshnessText + " · resets " + reset
  }
  private var accessibilitySummary: String {
    let values = [window.title, window.valueText, window.freshnessText]
    return values.joined(separator: ", ") + ". " + markers.map { $0.label }.joined(separator: ". ")
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      header
      UsageTrack(window: window, markers: markers)
      Text(freshnessLabel).font(.caption).foregroundStyle(.secondary)
      ConfiguredLegend(markers: markers)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilitySummary)
  }
  private var header: some View {
    HStack {
      Text(window.title).font(.subheadline).fontWeight(.semibold)
      Spacer()
      Text(window.valueText).font(.subheadline).monospacedDigit().fontWeight(.semibold)
    }
  }

}
private struct UsageTrack: View {
  let window: WindowPresentation
  let markers: [ConfiguredThreshold]
  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        Capsule().fill(Color.primary.opacity(0.08)).frame(height: 7)
        if window.used != nil {
          Capsule().fill(Color.accentColor.opacity(window.freshness == "stale" ? 0.4 : 0.85))
            .frame(width: geometry.size.width * window.fraction, height: 7)
        }
        ForEach(markers) { marker in
          Image(systemName: marker.symbol).font(.system(size: 8, weight: .bold))
            .foregroundStyle(Color.primary).opacity(marker.opacity)
            .offset(x: position(marker, width: geometry.size.width))
        }
      }.frame(height: 12)
    }.frame(height: 12).accessibilityHidden(true)
  }
  private func position(_ marker: ConfiguredThreshold, width: CGFloat) -> CGFloat {
    max(0, min(width - 8, width * CGFloat(marker.value) / 100 - 4))
  }
}
struct ConfiguredLegend: View {
  let markers: [ConfiguredThreshold]
  var body: some View {
    if !markers.isEmpty {
      VStack(alignment: .leading, spacing: 3) {
        Text("Configured lines").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
        ForEach(markers) { marker in
          Label(marker.label, systemImage: marker.symbol).font(.caption2).foregroundStyle(
            .secondary)
        }
      }
    }
  }
}
