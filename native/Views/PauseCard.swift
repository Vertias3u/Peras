import SwiftUI

struct PauseCard: View {
  let presentation: ProviderPresentation
  @ObservedObject var store: FixtureStore
  var body: some View {
    if !presentation.reasons.isEmpty {
      VStack(alignment: .leading, spacing: 9) {
        Label(
          presentation.status,
          systemImage: presentation.verdict == "ask"
            ? "hand.raised"
            : presentation.verdict == "warn" ? "exclamationmark.circle" : "pause.circle"
        )
        .font(.subheadline.weight(.semibold))
        if presentation.projectOnly {
          Text("Applies to the observed project, not a provider-wide pause.").font(.caption)
            .foregroundStyle(.secondary)
        }
        ForEach(presentation.reasons) { reason in
          VStack(alignment: .leading, spacing: 2) {
            Text(reason.title + (reason.stopping ? "" : " · warning")).font(
              .caption.weight(.semibold))
            Text(reason.scope).font(.caption)
            if let values = reason.values { Text(values).font(.caption.monospacedDigit()) }
            Text(reason.expiry).font(.caption).foregroundStyle(.secondary)
          }.accessibilityElement(children: .combine)
        }
      }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
    }
  }
}
struct OfferedActionView: View {
  let offer: BridgeOffer
  let impact: [String]
  var title: String? = nil
  @ObservedObject var store: FixtureStore
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Button(title ?? PresentationText.action(offer)) { store.send(offer) }
        .perasKeyboardButton()
        .disabled(
          store.fixtureMode || !offer.eligible || store.blockedProviders.contains(offer.key)
        )
        .help(
          store.fixtureMode
            ? "Read-only fixture; no backend command will run"
            : PresentationText.disabled(offer.disabledReason) ?? "Apply only this reviewed offer")
      if let reason = PresentationText.disabled(offer.disabledReason) {
        Text(reason).font(.caption).foregroundStyle(.secondary)
      }
      ForEach(Array(impact.enumerated()), id: \.offset) { _, text in
        Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(
          horizontal: false, vertical: true)
      }
    }.controlSize(.small)
  }
}
