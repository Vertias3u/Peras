import SwiftUI

struct PlanningStrip: View {
  let meters: [PlanningPresentation]
  var body: some View {
    if !meters.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        Text("Your plan").font(.subheadline.weight(.semibold))
        ForEach(meters) { meter in
          VStack(alignment: .leading, spacing: 3) {
            Text(meter.title).font(.caption.weight(.semibold))
            Text(meter.summary).font(.caption.monospacedDigit())
            Text(
              "Base " + meter.number("baseLimit") + " · extra " + meter.number("extra") + " points"
            )
            .font(.caption).foregroundStyle(.secondary)
            if meter.raw["extra"].number.map({ $0 > 0 }) == true {
              Text("Extra ends " + PresentationText.expiry(meter.raw["extraExpiresAtMs"]))
                .font(.caption).foregroundStyle(.secondary)
            }
            if meter.raw["estimated"].bool == true {
              Text("Estimated from available readings").font(.caption).foregroundStyle(.secondary)
            }
            if meter.raw["waitingForReading"].bool == true {
              Text("Waiting for a fresh reading").font(.caption).foregroundStyle(.secondary)
            }
            if meter.raw["kind"].string == "pacing" {
              Text(
                meter.number("workdaysLeft") + " workdays left · reserve target "
                  + meter.number("reserve") + "%"
              )
              .font(.caption).foregroundStyle(.secondary)
            }
          }.accessibilityElement(children: .combine)
        }
      }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
    }
  }
}
